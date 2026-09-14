use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::File;
use std::io::{self, Read};
use std::os::fd::AsRawFd;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};

use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::artifact::{open_regular_no_symlinks, ArtifactError, SystemSha256};
use crate::guest_image::{AdmittedGuestImageIdentity, GUEST_AGENT_PATH};

const F_GETFD: i32 = 1;
const F_SETFD: i32 = 2;
const FD_CLOEXEC: i32 = 1;
pub const MAX_GUEST_AGENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DEBUGFS_STAT_BYTES: u64 = 16 * 1024;

extern "C" {
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestRootfsInspectorSource {
    pub debugfs_program: PathBuf,
    pub debugfs_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestAgentRootfsProvenance {
    pub debugfs_sha256: String,
    pub guest_agent_bytes: u64,
    pub guest_agent_path: String,
    pub guest_agent_sha256: String,
    pub rootfs_sha256: String,
}

impl GuestAgentRootfsProvenance {
    pub fn canonical_json(&self) -> String {
        format!(
            concat!(
                "{{",
                "\"debugfs_sha256\":\"{}\",",
                "\"guest_agent_bytes\":{},",
                "\"guest_agent_path\":\"{}\",",
                "\"guest_agent_sha256\":\"{}\",",
                "\"rootfs_sha256\":\"{}\",",
                "\"verification\":\"READ_ONLY_EXT4_AGENT_BYTES_HASHED_FROM_EXACT_ROOTFS_FD\"",
                "}}"
            ),
            self.debugfs_sha256,
            self.guest_agent_bytes,
            self.guest_agent_path,
            self.guest_agent_sha256,
            self.rootfs_sha256,
        )
    }
}

#[derive(Debug)]
pub enum GuestRootfsError {
    InvalidDebugfsSha256,
    UnsafeDebugfsProgram(PathBuf),
    DebugfsDigestMismatch { expected: String, actual: String },
    GuestImageBindingMismatch,
    RootfsDigestMismatch { expected: String, actual: String },
    DebugfsRequestFailed { request: &'static str, code: Option<i32> },
    DebugfsOutputTooLarge { request: &'static str, limit: u64 },
    MalformedAgentStat,
    GuestAgentNotRegular,
    GuestAgentNotExecutable,
    GuestAgentDigestMismatch { expected: String, actual: String },
    Artifact(ArtifactError),
    Io { operation: &'static str, source: io::Error },
}

impl Display for GuestRootfsError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidDebugfsSha256 => formatter
                .write_str("debugfs identity is not a canonical lowercase sha256"),
            Self::UnsafeDebugfsProgram(path) => write!(
                formatter,
                "debugfs program must be root-owned and not group/world writable: {}",
                path.display()
            ),
            Self::DebugfsDigestMismatch { expected, actual } => write!(
                formatter,
                "debugfs digest mismatch: expected {expected}, got {actual}"
            ),
            Self::GuestImageBindingMismatch => formatter.write_str(
                "guest-agent/rootfs provenance does not match the admitted guest image and supervisor plan",
            ),
            Self::RootfsDigestMismatch { expected, actual } => write!(
                formatter,
                "rootfs digest changed during guest-agent inspection: expected {expected}, got {actual}"
            ),
            Self::DebugfsRequestFailed { request, code } => {
                write!(formatter, "debugfs {request} request failed with exit code {code:?}")
            }
            Self::DebugfsOutputTooLarge { request, limit } => write!(
                formatter,
                "debugfs {request} output exceeded the declared limit of {limit} bytes"
            ),
            Self::MalformedAgentStat => {
                formatter.write_str("debugfs returned malformed guest-agent inode metadata")
            }
            Self::GuestAgentNotRegular => {
                formatter.write_str("guest-agent path inside rootfs is not a regular file")
            }
            Self::GuestAgentNotExecutable => {
                formatter.write_str("guest-agent path inside rootfs is not executable")
            }
            Self::GuestAgentDigestMismatch { expected, actual } => write!(
                formatter,
                "guest-agent bytes inside rootfs do not match admitted identity: expected {expected}, got {actual}"
            ),
            Self::Artifact(error) => Display::fmt(error, formatter),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for GuestRootfsError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Artifact(error) => Some(error),
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl From<ArtifactError> for GuestRootfsError {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

/// Proves that the exact manifest-declared guest-agent bytes exist at the
/// mandatory init path inside the exact admitted ext4 rootfs.
///
/// The inspector binary is itself pinned by SHA-256, resolved without symlinks,
/// root-owned and non-writable by group/world. The rootfs is opened once through
/// WALLE's no-symlink path and that exact fd is inherited by read-only `debugfs`.
/// `debugfs` is invoked without `-w`; its `stat` result must identify a regular
/// executable inode, then `cat` is bounded and hashed. The rootfs fd is hashed
/// both before and after inspection to fail closed on any mutation.
pub fn verify_guest_agent_in_rootfs(
    inspector: &GuestRootfsInspectorSource,
    sha256_program: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    identity: &AdmittedGuestImageIdentity,
) -> Result<GuestAgentRootfsProvenance, GuestRootfsError> {
    if !is_valid_sha256(&inspector.debugfs_sha256) {
        return Err(GuestRootfsError::InvalidDebugfsSha256);
    }
    if identity.rootfs_sha256 != plan.rootfs_sha256
        || identity.guest_agent_path != GUEST_AGENT_PATH
        || !is_valid_sha256(&identity.guest_agent_sha256)
    {
        return Err(GuestRootfsError::GuestImageBindingMismatch);
    }

    let hasher = SystemSha256::new(sha256_program)?;
    let debugfs = open_regular_no_symlinks(&inspector.debugfs_program)?;
    let debugfs_metadata = debugfs.metadata().map_err(|source| GuestRootfsError::Io {
        operation: "inspect debugfs program",
        source,
    })?;
    if debugfs_metadata.uid() != 0 || debugfs_metadata.mode() & 0o022 != 0 {
        return Err(GuestRootfsError::UnsafeDebugfsProgram(
            inspector.debugfs_program.clone(),
        ));
    }
    let debugfs_actual = hasher.hash_file(&debugfs)?;
    if debugfs_actual != inspector.debugfs_sha256 {
        return Err(GuestRootfsError::DebugfsDigestMismatch {
            expected: inspector.debugfs_sha256.clone(),
            actual: debugfs_actual,
        });
    }

    let rootfs = open_regular_no_symlinks(Path::new(plan.rootfs_source))?;
    let rootfs_before = hasher.hash_file(&rootfs)?;
    if rootfs_before != plan.rootfs_sha256 {
        return Err(GuestRootfsError::RootfsDigestMismatch {
            expected: plan.rootfs_sha256.to_owned(),
            actual: rootfs_before,
        });
    }

    let stat = run_debugfs_request(
        &inspector.debugfs_program,
        &rootfs,
        "stat /usr/libexec/walle/walle-guest-agent",
        "stat guest agent",
        MAX_DEBUGFS_STAT_BYTES,
    )?;
    validate_agent_stat(&stat)?;
    let agent_bytes = run_debugfs_request(
        &inspector.debugfs_program,
        &rootfs,
        "cat /usr/libexec/walle/walle-guest-agent",
        "read guest agent",
        MAX_GUEST_AGENT_BYTES,
    )?;
    let agent_sha256 = hasher.hash_bytes(&agent_bytes)?;
    if agent_sha256 != identity.guest_agent_sha256 {
        return Err(GuestRootfsError::GuestAgentDigestMismatch {
            expected: identity.guest_agent_sha256.clone(),
            actual: agent_sha256,
        });
    }

    let rootfs_after = hasher.hash_file(&rootfs)?;
    if rootfs_after != plan.rootfs_sha256 {
        return Err(GuestRootfsError::RootfsDigestMismatch {
            expected: plan.rootfs_sha256.to_owned(),
            actual: rootfs_after,
        });
    }

    Ok(GuestAgentRootfsProvenance {
        debugfs_sha256: inspector.debugfs_sha256.clone(),
        guest_agent_bytes: u64::try_from(agent_bytes.len()).unwrap_or(u64::MAX),
        guest_agent_path: GUEST_AGENT_PATH.to_owned(),
        guest_agent_sha256: identity.guest_agent_sha256.clone(),
        rootfs_sha256: identity.rootfs_sha256.clone(),
    })
}

fn run_debugfs_request(
    program: &Path,
    rootfs: &File,
    request: &str,
    request_label: &'static str,
    output_limit: u64,
) -> Result<Vec<u8>, GuestRootfsError> {
    let inherited = rootfs.try_clone().map_err(|source| GuestRootfsError::Io {
        operation: "clone rootfs fd for debugfs",
        source,
    })?;
    make_inheritable(&inherited)?;
    let device = format!("/proc/self/fd/{}", inherited.as_raw_fd());
    let mut child = Command::new(program)
        .args(["-R", request, device.as_str()])
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|source| GuestRootfsError::Io {
            operation: "spawn read-only debugfs",
            source,
        })?;
    let stdout = child.stdout.take().ok_or_else(|| GuestRootfsError::Io {
        operation: "open debugfs stdout pipe",
        source: io::Error::new(io::ErrorKind::BrokenPipe, "debugfs stdout pipe missing"),
    })?;
    let mut bytes = Vec::new();
    let read_result = stdout
        .take(output_limit.saturating_add(1))
        .read_to_end(&mut bytes);
    if let Err(source) = read_result {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GuestRootfsError::Io {
            operation: "read bounded debugfs output",
            source,
        });
    }
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > output_limit {
        let _ = child.kill();
        let _ = child.wait();
        return Err(GuestRootfsError::DebugfsOutputTooLarge {
            request: request_label,
            limit: output_limit,
        });
    }
    let status = child.wait().map_err(|source| GuestRootfsError::Io {
        operation: "wait for read-only debugfs",
        source,
    })?;
    ensure_debugfs_success(status, request_label)?;
    Ok(bytes)
}

fn make_inheritable(file: &File) -> Result<(), GuestRootfsError> {
    let fd = file.as_raw_fd();
    // SAFETY: fcntl is called with a valid owned fd and integer-only commands.
    let flags = unsafe { fcntl(fd, F_GETFD) };
    if flags < 0 {
        return Err(GuestRootfsError::Io {
            operation: "read rootfs fd flags",
            source: io::Error::last_os_error(),
        });
    }
    // SAFETY: this only clears FD_CLOEXEC on the private clone passed to the
    // debugfs child. The descriptor remains owned by `file` in the parent.
    if unsafe { fcntl(fd, F_SETFD, flags & !FD_CLOEXEC) } != 0 {
        return Err(GuestRootfsError::Io {
            operation: "make rootfs fd inheritable for debugfs",
            source: io::Error::last_os_error(),
        });
    }
    Ok(())
}

fn ensure_debugfs_success(
    status: ExitStatus,
    request: &'static str,
) -> Result<(), GuestRootfsError> {
    if status.success() {
        Ok(())
    } else {
        Err(GuestRootfsError::DebugfsRequestFailed {
            request,
            code: status.code(),
        })
    }
}

fn validate_agent_stat(bytes: &[u8]) -> Result<(), GuestRootfsError> {
    let text = std::str::from_utf8(bytes).map_err(|_| GuestRootfsError::MalformedAgentStat)?;
    let mut inode_metadata = None;
    for line in text.lines() {
        let fields: Vec<&str> = line.split_ascii_whitespace().collect();
        if fields.first().copied() != Some("Inode:") {
            continue;
        }
        if inode_metadata.is_some() {
            return Err(GuestRootfsError::MalformedAgentStat);
        }
        let type_index = fields
            .iter()
            .position(|field| *field == "Type:")
            .ok_or(GuestRootfsError::MalformedAgentStat)?;
        let mode_index = fields
            .iter()
            .position(|field| *field == "Mode:")
            .ok_or(GuestRootfsError::MalformedAgentStat)?;
        let file_type = *fields
            .get(type_index + 1)
            .ok_or(GuestRootfsError::MalformedAgentStat)?;
        let mode_text = *fields
            .get(mode_index + 1)
            .ok_or(GuestRootfsError::MalformedAgentStat)?;
        let mode = u32::from_str_radix(mode_text.trim_start_matches('0'), 8)
            .map_err(|_| GuestRootfsError::MalformedAgentStat)?;
        inode_metadata = Some((file_type, mode));
    }
    let (file_type, mode) = inode_metadata.ok_or(GuestRootfsError::MalformedAgentStat)?;
    if file_type != "regular" {
        return Err(GuestRootfsError::GuestAgentNotRegular);
    }
    if mode & 0o111 == 0 {
        return Err(GuestRootfsError::GuestAgentNotExecutable);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debugfs_stat_requires_one_regular_executable_inode() {
        let valid = b"Inode: 42 Type: regular Mode: 0755 Flags: 0x80000\nSize: 1234\n";
        assert!(validate_agent_stat(valid).is_ok());

        let symlink = b"Inode: 42 Type: symlink Mode: 0777 Flags: 0x0\n";
        assert!(matches!(
            validate_agent_stat(symlink),
            Err(GuestRootfsError::GuestAgentNotRegular)
        ));

        let non_executable = b"Inode: 42 Type: regular Mode: 0644 Flags: 0x0\n";
        assert!(matches!(
            validate_agent_stat(non_executable),
            Err(GuestRootfsError::GuestAgentNotExecutable)
        ));
    }

    #[test]
    fn debugfs_stat_rejects_missing_or_duplicate_inode_metadata() {
        assert!(matches!(
            validate_agent_stat(b"Size: 1\n"),
            Err(GuestRootfsError::MalformedAgentStat)
        ));
        assert!(matches!(
            validate_agent_stat(
                b"Inode: 1 Type: regular Mode: 0755\nInode: 2 Type: regular Mode: 0755\n"
            ),
            Err(GuestRootfsError::MalformedAgentStat)
        ));
    }

    #[test]
    fn provenance_payload_is_canonical_and_explicit() {
        let proof = GuestAgentRootfsProvenance {
            debugfs_sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                    .to_owned(),
            guest_agent_bytes: 4096,
            guest_agent_path: GUEST_AGENT_PATH.to_owned(),
            guest_agent_sha256:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
                    .to_owned(),
            rootfs_sha256:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
                    .to_owned(),
        };
        let json = proof.canonical_json();
        assert!(json.contains("READ_ONLY_EXT4_AGENT_BYTES_HASHED_FROM_EXACT_ROOTFS_FD"));
        assert!(json.contains(GUEST_AGENT_PATH));
        assert!(json.contains("\"guest_agent_bytes\":4096"));
        assert!(!json.contains('\n'));
    }
}
