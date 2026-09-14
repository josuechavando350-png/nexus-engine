use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::Path;

#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;
#[cfg(unix)]
use std::os::unix::fs::FileTypeExt;

pub const REQUIRED_CGROUP_CONTROLLERS: [&str; 4] = ["cpu", "io", "memory", "pids"];
const KVM_API_VERSION: i32 = 12;
#[cfg(target_os = "linux")]
const KVM_GET_API_VERSION: usize = 0xAE00;

#[cfg(target_os = "linux")]
extern "C" {
    fn ioctl(fd: i32, request: usize, ...) -> i32;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationHostFacts {
    pub os: String,
    pub architecture: String,
    pub effective_uid: Option<u32>,
    pub kvm_exists: bool,
    pub kvm_is_character_device: bool,
    pub kvm_open_read_write: bool,
    pub kvm_api_version: Option<i32>,
    pub kvm_api_compatible: bool,
    pub cgroup_v2: bool,
    pub cgroup_controllers: Vec<String>,
    pub seccomp_actions: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolationHostVerdict {
    Ready,
    Unavailable,
    Blocked,
}

impl IsolationHostVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "READY",
            Self::Unavailable => "UNAVAILABLE",
            Self::Blocked => "BLOCKED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationHostAssessment {
    pub facts: IsolationHostFacts,
    pub linux_verified: bool,
    pub x86_64_verified: bool,
    pub privileged_supervisor_verified: bool,
    pub kvm_verified: bool,
    pub cgroup_v2_verified: bool,
    pub cgroup_controllers_verified: bool,
    pub seccomp_verified: bool,
    pub verdict: IsolationHostVerdict,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct KvmProbe {
    exists: bool,
    is_character_device: bool,
    open_read_write: bool,
    api_version: Option<i32>,
}

impl KvmProbe {
    const fn api_compatible(self) -> bool {
        matches!(self.api_version, Some(KVM_API_VERSION))
    }
}

pub fn collect_isolation_host_facts() -> IsolationHostFacts {
    let kvm = probe_kvm(Path::new("/dev/kvm"));

    IsolationHostFacts {
        os: std::env::consts::OS.to_owned(),
        architecture: std::env::consts::ARCH.to_owned(),
        effective_uid: read_effective_uid(),
        kvm_exists: kvm.exists,
        kvm_is_character_device: kvm.is_character_device,
        kvm_open_read_write: kvm.open_read_write,
        kvm_api_version: kvm.api_version,
        kvm_api_compatible: kvm.api_compatible(),
        cgroup_v2: Path::new("/sys/fs/cgroup/cgroup.controllers").is_file(),
        cgroup_controllers: read_words("/sys/fs/cgroup/cgroup.controllers"),
        seccomp_actions: read_words("/proc/sys/kernel/seccomp/actions_avail"),
    }
}

pub fn assess_isolation_host(facts: IsolationHostFacts) -> IsolationHostAssessment {
    let linux_verified = facts.os == "linux";
    let x86_64_verified = facts.architecture == "x86_64";
    let privileged_supervisor_verified = facts.effective_uid == Some(0);
    let kvm_verified = facts.kvm_exists
        && facts.kvm_is_character_device
        && facts.kvm_open_read_write
        && facts.kvm_api_compatible;
    let cgroup_v2_verified = facts.cgroup_v2;
    let cgroup_controllers_verified = REQUIRED_CGROUP_CONTROLLERS.iter().all(|required| {
        facts
            .cgroup_controllers
            .iter()
            .any(|actual| actual == required)
    });
    let seccomp_verified = facts
        .seccomp_actions
        .iter()
        .any(|action| action == "kill_process")
        && facts.seccomp_actions.iter().any(|action| action == "errno");

    let (verdict, reason) = if !linux_verified || !x86_64_verified {
        (
            IsolationHostVerdict::Blocked,
            "UNSUPPORTED_HOST_OPERATING_SYSTEM_OR_ARCHITECTURE",
        )
    } else if !kvm_verified {
        (IsolationHostVerdict::Unavailable, "KVM_NOT_USABLE")
    } else if !privileged_supervisor_verified {
        (
            IsolationHostVerdict::Unavailable,
            "PRIVILEGED_SUPERVISOR_NOT_AVAILABLE",
        )
    } else if !cgroup_v2_verified || !cgroup_controllers_verified {
        (
            IsolationHostVerdict::Unavailable,
            "CGROUP_V2_RESOURCE_CONTROLS_NOT_AVAILABLE",
        )
    } else if !seccomp_verified {
        (
            IsolationHostVerdict::Unavailable,
            "SECCOMP_FILTERING_NOT_AVAILABLE",
        )
    } else {
        (
            IsolationHostVerdict::Ready,
            "MICROVM_HOST_PREREQUISITES_READY",
        )
    };

    IsolationHostAssessment {
        facts,
        linux_verified,
        x86_64_verified,
        privileged_supervisor_verified,
        kvm_verified,
        cgroup_v2_verified,
        cgroup_controllers_verified,
        seccomp_verified,
        verdict,
        reason,
    }
}

fn probe_kvm(path: &Path) -> KvmProbe {
    let metadata = fs::symlink_metadata(path).ok();
    let exists = metadata.is_some();
    let is_character_device = metadata
        .as_ref()
        .is_some_and(|metadata| metadata.file_type().is_char_device());
    if !is_character_device {
        return KvmProbe {
            exists,
            is_character_device,
            open_read_write: false,
            api_version: None,
        };
    }

    let file = match open_kvm_read_write(path) {
        Ok(file) => file,
        Err(_) => {
            return KvmProbe {
                exists,
                is_character_device,
                open_read_write: false,
                api_version: None,
            }
        }
    };

    KvmProbe {
        exists,
        is_character_device,
        open_read_write: true,
        api_version: read_kvm_api_version(&file),
    }
}

#[cfg(target_os = "linux")]
fn read_kvm_api_version(file: &File) -> Option<i32> {
    let version = unsafe { ioctl(file.as_raw_fd(), KVM_GET_API_VERSION) };
    (version >= 0).then_some(version)
}

#[cfg(not(target_os = "linux"))]
fn read_kvm_api_version(_file: &File) -> Option<i32> {
    None
}

fn open_kvm_read_write(path: &Path) -> io::Result<File> {
    OpenOptions::new().read(true).write(true).open(path)
}

fn read_words(path: &str) -> Vec<String> {
    let mut values = fs::read_to_string(path)
        .ok()
        .map(|value| {
            value
                .split_whitespace()
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    values.sort_unstable();
    values.dedup();
    values
}

fn read_effective_uid() -> Option<u32> {
    let status = fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("Uid:"))?;
    let mut fields = line.split_whitespace();
    if fields.next()? != "Uid:" {
        return None;
    }
    let _real_uid = fields.next()?;
    fields.next()?.parse::<u32>().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_facts() -> IsolationHostFacts {
        IsolationHostFacts {
            os: "linux".to_owned(),
            architecture: "x86_64".to_owned(),
            effective_uid: Some(0),
            kvm_exists: true,
            kvm_is_character_device: true,
            kvm_open_read_write: true,
            kvm_api_version: Some(KVM_API_VERSION),
            kvm_api_compatible: true,
            cgroup_v2: true,
            cgroup_controllers: vec![
                "cpu".to_owned(),
                "io".to_owned(),
                "memory".to_owned(),
                "pids".to_owned(),
            ],
            seccomp_actions: vec!["errno".to_owned(), "kill_process".to_owned()],
        }
    }

    #[test]
    fn complete_linux_microvm_prerequisites_are_ready() {
        let assessment = assess_isolation_host(ready_facts());
        assert_eq!(assessment.verdict, IsolationHostVerdict::Ready);
        assert_eq!(assessment.reason, "MICROVM_HOST_PREREQUISITES_READY");
        assert!(assessment.kvm_verified);
        assert!(assessment.cgroup_controllers_verified);
        assert!(assessment.seccomp_verified);
    }

    #[test]
    fn kvm_requires_exact_api_version_not_just_open_access() {
        let mut facts = ready_facts();
        facts.kvm_api_version = Some(KVM_API_VERSION - 1);
        facts.kvm_api_compatible = false;
        let assessment = assess_isolation_host(facts);
        assert_eq!(assessment.verdict, IsolationHostVerdict::Unavailable);
        assert_eq!(assessment.reason, "KVM_NOT_USABLE");
        assert!(!assessment.kvm_verified);
    }

    #[test]
    fn missing_kvm_is_unavailable_not_ready() {
        let mut facts = ready_facts();
        facts.kvm_open_read_write = false;
        facts.kvm_api_version = None;
        facts.kvm_api_compatible = false;
        let assessment = assess_isolation_host(facts);
        assert_eq!(assessment.verdict, IsolationHostVerdict::Unavailable);
        assert_eq!(assessment.reason, "KVM_NOT_USABLE");
    }

    #[test]
    fn missing_privileged_supervisor_is_unavailable() {
        let mut facts = ready_facts();
        facts.effective_uid = Some(1000);
        let assessment = assess_isolation_host(facts);
        assert_eq!(assessment.verdict, IsolationHostVerdict::Unavailable);
        assert_eq!(assessment.reason, "PRIVILEGED_SUPERVISOR_NOT_AVAILABLE");
    }

    #[test]
    fn missing_required_cgroup_controller_is_unavailable() {
        let mut facts = ready_facts();
        facts
            .cgroup_controllers
            .retain(|controller| controller != "pids");
        let assessment = assess_isolation_host(facts);
        assert_eq!(assessment.verdict, IsolationHostVerdict::Unavailable);
        assert_eq!(
            assessment.reason,
            "CGROUP_V2_RESOURCE_CONTROLS_NOT_AVAILABLE"
        );
    }

    #[test]
    fn unsupported_architecture_blocks() {
        let mut facts = ready_facts();
        facts.architecture = "aarch64".to_owned();
        let assessment = assess_isolation_host(facts);
        assert_eq!(assessment.verdict, IsolationHostVerdict::Blocked);
        assert_eq!(
            assessment.reason,
            "UNSUPPORTED_HOST_OPERATING_SYSTEM_OR_ARCHITECTURE"
        );
    }

    #[test]
    fn effective_uid_parser_uses_effective_field() {
        let status = "Name:\ttest\nUid:\t1000\t0\t1000\t1000\n";
        let line = status
            .lines()
            .find(|line| line.starts_with("Uid:"))
            .unwrap();
        let mut fields = line.split_whitespace();
        assert_eq!(fields.next(), Some("Uid:"));
        let _real_uid = fields.next().unwrap();
        assert_eq!(
            fields.next().and_then(|value| value.parse::<u32>().ok()),
            Some(0)
        );
    }
}
