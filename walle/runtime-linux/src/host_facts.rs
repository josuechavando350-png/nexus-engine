use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{File, OpenOptions};
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::FileTypeExt;
use std::path::{Path, PathBuf};

const KVM_GET_API_VERSION: u64 = 0xAE00;
const EXPECTED_KVM_API_VERSION: i32 = 12;
const KERNEL_RELEASE_MAX_BYTES: usize = 4 * 1024;
const MOUNTINFO_MAX_BYTES: usize = 2 * 1024 * 1024;
const DEFAULT_KVM_PATH: &str = "/dev/kvm";
const DEFAULT_KERNEL_RELEASE_PATH: &str = "/proc/sys/kernel/osrelease";
const DEFAULT_MOUNTINFO_PATH: &str = "/proc/self/mountinfo";

extern "C" {
    fn ioctl(fd: i32, request: u64, ...) -> i32;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostPreflightVerdict {
    Ready,
    Blocked,
}

impl HostPreflightVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "READY",
            Self::Blocked => "BLOCKED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KvmObservation {
    Usable { api_version: i32 },
    Missing,
    NotCharacterDevice,
    OpenDenied { errno: Option<i32> },
    OpenFailed { errno: Option<i32> },
    IoctlFailed { errno: Option<i32> },
    UnexpectedApiVersion { api_version: i32 },
}

impl KvmObservation {
    pub fn is_usable(&self) -> bool {
        matches!(
            self,
            Self::Usable { api_version } if *api_version == EXPECTED_KVM_API_VERSION
        )
    }

    fn canonical_json(&self) -> String {
        match self {
            Self::Usable { api_version } => format!(
                "{{\"api_version\":{api_version},\"status\":\"USABLE\"}}"
            ),
            Self::Missing => "{\"status\":\"MISSING\"}".to_owned(),
            Self::NotCharacterDevice => {
                "{\"status\":\"NOT_CHARACTER_DEVICE\"}".to_owned()
            }
            Self::OpenDenied { errno } => canonical_errno("OPEN_DENIED", *errno),
            Self::OpenFailed { errno } => canonical_errno("OPEN_FAILED", *errno),
            Self::IoctlFailed { errno } => canonical_errno("IOCTL_FAILED", *errno),
            Self::UnexpectedApiVersion { api_version } => format!(
                "{{\"api_version\":{api_version},\"status\":\"UNEXPECTED_API_VERSION\"}}"
            ),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct MountObservation {
    pub mount_point: String,
    pub fs_type: String,
    pub source: String,
}

impl MountObservation {
    fn canonical_json(&self) -> String {
        format!(
            "{{\"fs_type\":\"{}\",\"mount_point\":\"{}\",\"source\":\"{}\"}}",
            json_escape(&self.fs_type),
            json_escape(&self.mount_point),
            json_escape(&self.source),
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxHostFacts {
    pub kernel_release: String,
    pub kvm: KvmObservation,
    pub root_mount: Option<MountObservation>,
    pub proc_mount: Option<MountObservation>,
    pub cgroup_v2_mounts: Vec<MountObservation>,
}

impl LinuxHostFacts {
    /// This is an operational admission verdict only. `READY` means the host
    /// exposed the minimum Linux/KVM/cgroup surfaces WALLE needs before a real
    /// MicroVM attempt. It is not `HOST_ISOLATION`, `MICROVM_BOOT`, or final
    /// WALLE certification evidence.
    pub fn preflight_verdict(&self) -> HostPreflightVerdict {
        if self.kvm.is_usable()
            && self.root_mount.is_some()
            && self.proc_mount.is_some()
            && !self.cgroup_v2_mounts.is_empty()
        {
            HostPreflightVerdict::Ready
        } else {
            HostPreflightVerdict::Blocked
        }
    }

    pub fn canonical_json(&self) -> String {
        let root_mount = self
            .root_mount
            .as_ref()
            .map_or_else(|| "null".to_owned(), MountObservation::canonical_json);
        let proc_mount = self
            .proc_mount
            .as_ref()
            .map_or_else(|| "null".to_owned(), MountObservation::canonical_json);
        let cgroup_v2_mounts = self
            .cgroup_v2_mounts
            .iter()
            .map(MountObservation::canonical_json)
            .collect::<Vec<_>>()
            .join(",");

        format!(
            concat!(
                "{{",
                "\"cgroup_v2_mounts\":[{}],",
                "\"kernel_release\":\"{}\",",
                "\"kvm\":{},",
                "\"preflight\":\"{}\",",
                "\"proc_mount\":{},",
                "\"root_mount\":{}",
                "}}"
            ),
            cgroup_v2_mounts,
            json_escape(&self.kernel_release),
            self.kvm.canonical_json(),
            self.preflight_verdict().as_str(),
            proc_mount,
            root_mount,
        )
    }
}

#[derive(Debug)]
pub enum HostFactsError {
    Io {
        operation: &'static str,
        path: PathBuf,
        source: io::Error,
    },
    FileTooLarge {
        path: PathBuf,
        limit: usize,
    },
    InvalidUtf8 {
        path: PathBuf,
    },
    EmptyKernelRelease,
    MalformedMountInfo {
        line: usize,
    },
}

impl Display for HostFactsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io {
                operation,
                path,
                source,
            } => write!(formatter, "{operation} {} failed: {source}", path.display()),
            Self::FileTooLarge { path, limit } => write!(
                formatter,
                "host fact file {} exceeded {limit} bytes",
                path.display()
            ),
            Self::InvalidUtf8 { path } => {
                write!(formatter, "host fact file {} is not UTF-8", path.display())
            }
            Self::EmptyKernelRelease => formatter.write_str("Linux kernel release is empty"),
            Self::MalformedMountInfo { line } => {
                write!(formatter, "malformed /proc mountinfo at line {line}")
            }
        }
    }
}

impl Error for HostFactsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

/// Collects observable Linux host facts from the current process namespace.
///
/// The KVM check opens `/dev/kvm` read/write and executes
/// `KVM_GET_API_VERSION`; merely finding a path named `/dev/kvm` is not enough.
/// Missing or unusable KVM is recorded as a blocked observation instead of
/// being promoted to success. No simulator, emulation, or target substitution
/// occurs in this function.
pub fn collect_linux_host_facts() -> Result<LinuxHostFacts, HostFactsError> {
    collect_linux_host_facts_from(
        Path::new(DEFAULT_KVM_PATH),
        Path::new(DEFAULT_KERNEL_RELEASE_PATH),
        Path::new(DEFAULT_MOUNTINFO_PATH),
    )
}

fn collect_linux_host_facts_from(
    kvm_path: &Path,
    kernel_release_path: &Path,
    mountinfo_path: &Path,
) -> Result<LinuxHostFacts, HostFactsError> {
    let kernel_release = read_bounded_utf8(kernel_release_path, KERNEL_RELEASE_MAX_BYTES)?
        .trim()
        .to_owned();
    if kernel_release.is_empty() {
        return Err(HostFactsError::EmptyKernelRelease);
    }

    let mountinfo = read_bounded_utf8(mountinfo_path, MOUNTINFO_MAX_BYTES)?;
    let mounts = parse_mountinfo(&mountinfo)?;
    let root_mount = mounts
        .iter()
        .find(|mount| mount.mount_point == "/")
        .cloned();
    let proc_mount = mounts
        .iter()
        .find(|mount| mount.mount_point == "/proc" && mount.fs_type == "proc")
        .cloned();
    let mut cgroup_v2_mounts = mounts
        .into_iter()
        .filter(|mount| mount.fs_type == "cgroup2")
        .collect::<Vec<_>>();
    cgroup_v2_mounts.sort();

    Ok(LinuxHostFacts {
        kernel_release,
        kvm: observe_kvm(kvm_path),
        root_mount,
        proc_mount,
        cgroup_v2_mounts,
    })
}

fn observe_kvm(path: &Path) -> KvmObservation {
    let file = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return KvmObservation::Missing,
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {
            return KvmObservation::OpenDenied {
                errno: error.raw_os_error(),
            }
        }
        Err(error) => {
            return KvmObservation::OpenFailed {
                errno: error.raw_os_error(),
            }
        }
    };

    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            return KvmObservation::OpenFailed {
                errno: error.raw_os_error(),
            }
        }
    };
    if !metadata.file_type().is_char_device() {
        return KvmObservation::NotCharacterDevice;
    }

    // SAFETY: `file` owns a valid descriptor for the opened device and
    // KVM_GET_API_VERSION takes no pointer argument. This crate is compiled only
    // for Linux x86_64, where this request value and ioctl ABI are defined.
    let api_version = unsafe { ioctl(file.as_raw_fd(), KVM_GET_API_VERSION) };
    if api_version < 0 {
        return KvmObservation::IoctlFailed {
            errno: io::Error::last_os_error().raw_os_error(),
        };
    }
    if api_version != EXPECTED_KVM_API_VERSION {
        return KvmObservation::UnexpectedApiVersion { api_version };
    }
    KvmObservation::Usable { api_version }
}

fn read_bounded_utf8(path: &Path, limit: usize) -> Result<String, HostFactsError> {
    let file = File::open(path).map_err(|source| HostFactsError::Io {
        operation: "open host fact",
        path: path.to_path_buf(),
        source,
    })?;
    let read_limit = u64::try_from(limit)
        .unwrap_or(u64::MAX - 1)
        .saturating_add(1);
    let mut reader = file.take(read_limit);
    let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
    reader
        .read_to_end(&mut bytes)
        .map_err(|source| HostFactsError::Io {
            operation: "read host fact",
            path: path.to_path_buf(),
            source,
        })?;
    if bytes.len() > limit {
        return Err(HostFactsError::FileTooLarge {
            path: path.to_path_buf(),
            limit,
        });
    }
    String::from_utf8(bytes).map_err(|_| HostFactsError::InvalidUtf8 {
        path: path.to_path_buf(),
    })
}

fn parse_mountinfo(input: &str) -> Result<Vec<MountObservation>, HostFactsError> {
    let mut mounts = Vec::new();
    for (index, line) in input.lines().enumerate() {
        if line.is_empty() {
            continue;
        }
        let (before_separator, after_separator) = line
            .split_once(" - ")
            .ok_or(HostFactsError::MalformedMountInfo { line: index + 1 })?;
        let before = before_separator.split_ascii_whitespace().collect::<Vec<_>>();
        let after = after_separator.split_ascii_whitespace().collect::<Vec<_>>();
        if before.len() < 6 || after.len() < 3 {
            return Err(HostFactsError::MalformedMountInfo { line: index + 1 });
        }
        mounts.push(MountObservation {
            mount_point: before[4].to_owned(),
            fs_type: after[0].to_owned(),
            source: after[1].to_owned(),
        });
    }
    Ok(mounts)
}

fn canonical_errno(status: &str, errno: Option<i32>) -> String {
    match errno {
        Some(errno) => format!("{{\"errno\":{errno},\"status\":\"{status}\"}}"),
        None => format!("{{\"errno\":null,\"status\":\"{status}\"}}"),
    }
}

fn json_escape(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\u{08}' => escaped.push_str("\\b"),
            '\u{0c}' => escaped.push_str("\\f"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character <= '\u{1f}' => {
                use std::fmt::Write as _;
                let _ = write!(escaped, "\\u{:04x}", character as u32);
            }
            character => escaped.push(character),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn mount(mount_point: &str, fs_type: &str, source: &str) -> MountObservation {
        MountObservation {
            mount_point: mount_point.to_owned(),
            fs_type: fs_type.to_owned(),
            source: source.to_owned(),
        }
    }

    fn ready_facts() -> LinuxHostFacts {
        LinuxHostFacts {
            kernel_release: "6.8.0-test".to_owned(),
            kvm: KvmObservation::Usable {
                api_version: EXPECTED_KVM_API_VERSION,
            },
            root_mount: Some(mount("/", "ext4", "/dev/vda1")),
            proc_mount: Some(mount("/proc", "proc", "proc")),
            cgroup_v2_mounts: vec![mount("/sys/fs/cgroup", "cgroup2", "cgroup")],
        }
    }

    #[test]
    fn parses_root_proc_and_cgroup_v2_mounts() {
        let input = concat!(
            "36 25 0:32 / / rw,relatime - ext4 /dev/vda1 rw\n",
            "37 36 0:5 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw\n",
            "38 36 0:28 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n",
        );
        let mounts = parse_mountinfo(input).expect("valid mountinfo");
        assert_eq!(mounts.len(), 3);
        assert_eq!(mounts[0], mount("/", "ext4", "/dev/vda1"));
        assert_eq!(mounts[1], mount("/proc", "proc", "proc"));
        assert_eq!(
            mounts[2],
            mount("/sys/fs/cgroup", "cgroup2", "cgroup")
        );
    }

    #[test]
    fn malformed_mountinfo_fails_closed() {
        let error = parse_mountinfo("36 25 0:32 / / rw,relatime\n").expect_err("must reject");
        assert!(matches!(
            error,
            HostFactsError::MalformedMountInfo { line: 1 }
        ));
    }

    #[test]
    fn preflight_requires_real_kvm_proc_root_and_cgroup_v2() {
        let facts = ready_facts();
        assert_eq!(facts.preflight_verdict(), HostPreflightVerdict::Ready);

        let mut missing_kvm = facts.clone();
        missing_kvm.kvm = KvmObservation::Missing;
        assert_eq!(
            missing_kvm.preflight_verdict(),
            HostPreflightVerdict::Blocked
        );

        let mut wrong_api = facts.clone();
        wrong_api.kvm = KvmObservation::UnexpectedApiVersion { api_version: 11 };
        assert_eq!(
            wrong_api.preflight_verdict(),
            HostPreflightVerdict::Blocked
        );

        let mut no_cgroup_v2 = facts;
        no_cgroup_v2.cgroup_v2_mounts.clear();
        assert_eq!(
            no_cgroup_v2.preflight_verdict(),
            HostPreflightVerdict::Blocked
        );
    }

    #[test]
    fn canonical_json_is_deterministic_and_escapes_strings() {
        let mut facts = ready_facts();
        facts.kernel_release = "kernel\\\"x\nnext".to_owned();
        let first = facts.canonical_json();
        let second = facts.canonical_json();
        assert_eq!(first, second);
        assert!(first.contains("kernel\\\\\\\"x\\nnext"));
        assert!(first.contains("\"preflight\":\"READY\""));
        assert!(first.contains("\"status\":\"USABLE\""));
    }

    #[test]
    fn bounded_reader_rejects_oversized_files() {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "walle-host-facts-oversized-{}-{id}",
            std::process::id()
        ));
        fs::write(&path, b"12345").expect("write fixture");
        let error = read_bounded_utf8(&path, 4).expect_err("must reject oversized file");
        assert!(matches!(error, HostFactsError::FileTooLarge { limit: 4, .. }));
        fs::remove_file(path).expect("cleanup fixture");
    }
}
