use std::error::Error;
use std::fmt::{Display, Formatter};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

use walle_core::supervisor::CgroupV2Plan;

const REQUIRED_CONTROLLERS: [&str; 3] = ["cpu", "memory", "pids"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CgroupLayout {
    mount: PathBuf,
    parent_relative: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppliedCgroup {
    pub path: PathBuf,
    pub relative_path: PathBuf,
}

#[derive(Debug)]
pub enum CgroupError {
    UnsafeMountPath(PathBuf),
    UnsafeParentPath(PathBuf),
    InvalidRunId,
    ParentNotDirectory(PathBuf),
    MissingController(&'static str),
    ControllerNotDelegated(&'static str),
    RunAlreadyExists(PathBuf),
    ControlFileMissing(PathBuf),
    ControlReadbackMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    ProcessesStillAttached(String),
    Io { operation: &'static str, source: io::Error },
}

impl Display for CgroupError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafeMountPath(path) => write!(formatter, "unsafe cgroup mount path: {}", path.display()),
            Self::UnsafeParentPath(path) => write!(formatter, "unsafe cgroup parent path: {}", path.display()),
            Self::InvalidRunId => formatter.write_str("run id is not valid for a jailer/cgroup leaf"),
            Self::ParentNotDirectory(path) => write!(formatter, "cgroup parent is not a directory: {}", path.display()),
            Self::MissingController(controller) => write!(formatter, "required cgroup controller is unavailable: {controller}"),
            Self::ControllerNotDelegated(controller) => write!(formatter, "required cgroup controller is not enabled in subtree_control: {controller}"),
            Self::RunAlreadyExists(path) => write!(formatter, "run cgroup already exists: {}", path.display()),
            Self::ControlFileMissing(path) => write!(formatter, "required cgroup control file is missing: {}", path.display()),
            Self::ControlReadbackMismatch { path, expected, actual } => write!(formatter, "cgroup control readback mismatch for {}: expected {expected}, got {actual}", path.display()),
            Self::ProcessesStillAttached(value) => write!(formatter, "cgroup still contains processes: {value}"),
            Self::Io { operation, source } => write!(formatter, "{operation} failed: {source}"),
        }
    }
}

impl Error for CgroupError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl CgroupLayout {
    pub fn new(
        mount: impl Into<PathBuf>,
        parent_relative: impl Into<PathBuf>,
    ) -> Result<Self, CgroupError> {
        let mount = mount.into();
        let parent_relative = parent_relative.into();
        validate_mount(&mount)?;
        validate_relative_parent(&parent_relative)?;
        Ok(Self {
            mount,
            parent_relative,
        })
    }

    pub fn mount(&self) -> &Path {
        &self.mount
    }

    pub fn parent_relative(&self) -> &Path {
        &self.parent_relative
    }

    pub fn parent_path(&self) -> PathBuf {
        self.mount.join(&self.parent_relative)
    }

    pub fn run_relative_path(&self, run_id: &str) -> Result<PathBuf, CgroupError> {
        validate_run_id(run_id)?;
        Ok(self.parent_relative.join(run_id))
    }

    pub fn run_path(&self, run_id: &str) -> Result<PathBuf, CgroupError> {
        Ok(self.mount.join(self.run_relative_path(run_id)?))
    }

    /// The WALLE cgroup parent is an operator-provisioned delegation boundary.
    /// This function refuses to enable controllers itself; doing so on an
    /// arbitrary production host can move or invalidate unrelated workloads.
    pub fn verify_parent_delegation(&self) -> Result<(), CgroupError> {
        let parent = self.parent_path();
        let metadata = fs::symlink_metadata(&parent).map_err(|source| CgroupError::Io {
            operation: "stat cgroup parent",
            source,
        })?;
        if !metadata.file_type().is_dir() {
            return Err(CgroupError::ParentNotDirectory(parent));
        }
        let available = read_tokens(&parent.join("cgroup.controllers"))?;
        let delegated = read_tokens(&parent.join("cgroup.subtree_control"))?;
        for controller in REQUIRED_CONTROLLERS {
            if !available.iter().any(|value| value == controller) {
                return Err(CgroupError::MissingController(controller));
            }
            if !delegated.iter().any(|value| value == controller) {
                return Err(CgroupError::ControllerNotDelegated(controller));
            }
        }
        Ok(())
    }

    pub fn create_and_apply(
        &self,
        run_id: &str,
        plan: CgroupV2Plan,
    ) -> Result<AppliedCgroup, CgroupError> {
        self.verify_parent_delegation()?;
        let relative_path = self.run_relative_path(run_id)?;
        let path = self.mount.join(&relative_path);
        match fs::create_dir(&path) {
            Ok(()) => {}
            Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {
                return Err(CgroupError::RunAlreadyExists(path));
            }
            Err(source) => {
                return Err(CgroupError::Io {
                    operation: "create run cgroup",
                    source,
                });
            }
        }

        if let Err(error) = write_and_verify_limits(&path, plan) {
            let _ = fs::remove_dir(&path);
            return Err(error);
        }

        Ok(AppliedCgroup {
            path,
            relative_path,
        })
    }

    pub fn cleanup_empty(&self, run_id: &str) -> Result<(), CgroupError> {
        let path = self.run_path(run_id)?;
        let procs_path = path.join("cgroup.procs");
        let procs = fs::read_to_string(&procs_path).map_err(|source| CgroupError::Io {
            operation: "read cgroup.procs before cleanup",
            source,
        })?;
        if !procs.trim().is_empty() {
            return Err(CgroupError::ProcessesStillAttached(procs.trim().to_owned()));
        }
        fs::remove_dir(&path).map_err(|source| CgroupError::Io {
            operation: "remove run cgroup",
            source,
        })
    }
}

pub fn write_and_verify_limits(
    cgroup_path: &Path,
    plan: CgroupV2Plan,
) -> Result<(), CgroupError> {
    let cpu_value = format!("{} {}", plan.cpu_quota_us, plan.cpu_period_us);
    let memory_value = plan.memory_max_bytes.to_string();
    let pids_value = plan.pids_max.to_string();

    write_control(cgroup_path, "cpu.max", &cpu_value)?;
    write_control(cgroup_path, "memory.max", &memory_value)?;
    write_control(cgroup_path, "pids.max", &pids_value)?;

    verify_control(cgroup_path, "cpu.max", &cpu_value)?;
    verify_control(cgroup_path, "memory.max", &memory_value)?;
    verify_control(cgroup_path, "pids.max", &pids_value)?;
    Ok(())
}

fn write_control(cgroup_path: &Path, name: &str, value: &str) -> Result<(), CgroupError> {
    let path = cgroup_path.join(name);
    if !path.is_file() {
        return Err(CgroupError::ControlFileMissing(path));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .open(&path)
        .map_err(|source| CgroupError::Io {
            operation: "open cgroup control for write",
            source,
        })?;
    file.write_all(value.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .map_err(|source| CgroupError::Io {
            operation: "write cgroup control",
            source,
        })
}

fn verify_control(cgroup_path: &Path, name: &str, expected: &str) -> Result<(), CgroupError> {
    let path = cgroup_path.join(name);
    let actual = fs::read_to_string(&path).map_err(|source| CgroupError::Io {
        operation: "read cgroup control",
        source,
    })?;
    let actual = actual.trim().to_owned();
    if actual != expected {
        return Err(CgroupError::ControlReadbackMismatch {
            path,
            expected: expected.to_owned(),
            actual,
        });
    }
    Ok(())
}

fn read_tokens(path: &Path) -> Result<Vec<String>, CgroupError> {
    let value = fs::read_to_string(path).map_err(|source| CgroupError::Io {
        operation: "read cgroup controller set",
        source,
    })?;
    Ok(value
        .split_ascii_whitespace()
        .map(str::to_owned)
        .collect())
}

fn validate_mount(path: &Path) -> Result<(), CgroupError> {
    if !path.is_absolute()
        || path.as_os_str().is_empty()
        || path
            .components()
            .any(|component| matches!(component, Component::CurDir | Component::ParentDir | Component::Prefix(_)))
    {
        return Err(CgroupError::UnsafeMountPath(path.to_path_buf()));
    }
    Ok(())
}

fn validate_relative_parent(path: &Path) -> Result<(), CgroupError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(CgroupError::UnsafeParentPath(path.to_path_buf()));
    }
    Ok(())
}

fn validate_run_id(value: &str) -> Result<(), CgroupError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CgroupError::InvalidRunId);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ID: AtomicU64 = AtomicU64::new(1);

    fn test_dir(label: &str) -> PathBuf {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "walle-cgroup-{label}-{}-{id}",
            std::process::id()
        ));
        fs::create_dir(&path).expect("create test directory");
        path
    }

    fn plan() -> CgroupV2Plan {
        CgroupV2Plan {
            cpu_quota_us: 200_000,
            cpu_period_us: 100_000,
            memory_max_bytes: 1_073_741_824,
            pids_max: 64,
        }
    }

    #[test]
    fn exact_limits_are_written_and_read_back() {
        let root = test_dir("limits");
        for name in ["cpu.max", "memory.max", "pids.max"] {
            fs::write(root.join(name), b"").expect("control file");
        }
        write_and_verify_limits(&root, plan()).expect("limits");
        assert_eq!(fs::read_to_string(root.join("cpu.max")).unwrap().trim(), "200000 100000");
        assert_eq!(fs::read_to_string(root.join("memory.max")).unwrap().trim(), "1073741824");
        assert_eq!(fs::read_to_string(root.join("pids.max")).unwrap().trim(), "64");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn delegation_requires_all_critical_controllers() {
        let mount = test_dir("delegation");
        let parent = mount.join("walle");
        fs::create_dir(&parent).expect("parent");
        fs::write(parent.join("cgroup.controllers"), "cpu memory pids io\n").unwrap();
        fs::write(parent.join("cgroup.subtree_control"), "cpu memory\n").unwrap();
        let layout = CgroupLayout::new(&mount, "walle").expect("layout");
        assert!(matches!(
            layout.verify_parent_delegation(),
            Err(CgroupError::ControllerNotDelegated("pids"))
        ));
        fs::remove_dir_all(mount).expect("cleanup");
    }

    #[test]
    fn cleanup_refuses_to_remove_live_cgroup() {
        let mount = test_dir("cleanup-live");
        let parent = mount.join("walle");
        let run = parent.join("run-abc123");
        fs::create_dir_all(&run).expect("run cgroup");
        fs::write(run.join("cgroup.procs"), "4242\n").unwrap();
        let layout = CgroupLayout::new(&mount, "walle").expect("layout");
        assert!(matches!(
            layout.cleanup_empty("run-abc123"),
            Err(CgroupError::ProcessesStillAttached(_))
        ));
        fs::remove_dir_all(mount).expect("cleanup");
    }

    #[test]
    fn relative_parent_cannot_escape_mount() {
        let mount = PathBuf::from("/sys/fs/cgroup");
        assert!(matches!(
            CgroupLayout::new(&mount, "../escape"),
            Err(CgroupError::UnsafeParentPath(_))
        ));
    }

    #[test]
    fn jailer_run_id_rejects_shell_or_path_characters() {
        let layout = CgroupLayout::new("/sys/fs/cgroup", "walle").expect("layout");
        assert!(layout.run_path("run-0123abcd").is_ok());
        assert!(matches!(layout.run_path("run/escape"), Err(CgroupError::InvalidRunId)));
        assert!(matches!(layout.run_path("run_underscore"), Err(CgroupError::InvalidRunId)));
    }
}
