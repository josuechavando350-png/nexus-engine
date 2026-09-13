use std::error::Error;
use std::ffi::OsString;
use std::fmt::{Display, Formatter};
use std::path::{Component, Path, PathBuf};

use walle_core::supervisor::{
    MicroVmSupervisorPlan, GUEST_CONFIG_PATH, GUEST_KERNEL_PATH, GUEST_ROOTFS_PATH,
};

pub const DEFAULT_BOOT_ARGS: &str = "console=ttyS0 reboot=k panic=1 pci=off";
pub const SCRATCH_GUEST_PATH: &str = "/walle/scratch.ext4";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirecrackerConfigOptions<'a> {
    pub boot_args: &'a str,
    /// A writable, pre-created filesystem image staged inside the jail. This
    /// must be present iff the supervisor plan allocates writable scratch.
    pub scratch_guest_path: Option<&'a str>,
}

impl Default for FirecrackerConfigOptions<'static> {
    fn default() -> Self {
        Self {
            boot_args: DEFAULT_BOOT_ARGS,
            scratch_guest_path: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FirecrackerConfig {
    json: String,
}

impl FirecrackerConfig {
    pub fn as_str(&self) -> &str {
        &self.json
    }

    pub fn into_string(self) -> String {
        self.json
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JailerCommandPlan {
    /// Host-side jailer program. The caller must execute it without a shell.
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Root that the jailer will pivot into for this exact run.
    pub chroot_root: PathBuf,
    /// Exact preconfigured cgroup-v2 leaf supplied through --parent-cgroup.
    pub parent_cgroup_relative: PathBuf,
    /// True because WALLE passes --no-api after the jailer argument separator.
    pub api_disabled: bool,
    /// Deliberately false in this slice. The current lifecycle owns and reaps
    /// the direct jailer/Firecracker process. A PID-namespace implementation
    /// needs explicit child-PID/pidfd/subreaper ownership before it is safe.
    pub new_pid_namespace: bool,
}

#[derive(Debug)]
pub enum FirecrackerPlanError {
    UnsafePlan,
    UnsupportedVcpuCount(u16),
    InvalidBootArgs,
    ScratchImageRequired,
    UnexpectedScratchImage,
    UnsafeGuestPath(String),
    UnsafeHostPath(PathBuf),
    UnsafeCgroupPath(PathBuf),
    MissingFirecrackerFileName,
}

impl Display for FirecrackerPlanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafePlan => formatter
                .write_str("supervisor plan is incompatible with deny-all Firecracker execution"),
            Self::UnsupportedVcpuCount(value) => {
                write!(formatter, "Firecracker vCPU count is unsupported: {value}")
            }
            Self::InvalidBootArgs => formatter.write_str(
                "kernel boot arguments are empty, too long, or contain unsupported control bytes",
            ),
            Self::ScratchImageRequired => formatter.write_str(
                "writable scratch is required by the plan but no staged scratch image was supplied",
            ),
            Self::UnexpectedScratchImage => formatter.write_str(
                "a scratch image was supplied even though the plan does not allocate scratch",
            ),
            Self::UnsafeGuestPath(path) => write!(formatter, "unsafe guest path: {path}"),
            Self::UnsafeHostPath(path) => {
                write!(formatter, "unsafe host path: {}", path.display())
            }
            Self::UnsafeCgroupPath(path) => {
                write!(formatter, "unsafe cgroup relative path: {}", path.display())
            }
            Self::MissingFirecrackerFileName => {
                formatter.write_str("staged Firecracker executable has no file name")
            }
        }
    }
}

impl Error for FirecrackerPlanError {}

/// Produces a Firecracker full-VM configuration using the current upstream
/// schema names (`boot-source`, `drives`, `machine-config`,
/// `network-interfaces`). No network interface is emitted.
///
/// This function is configuration construction only. In particular it does not
/// prove guest PID/seccomp enforcement; the real host backend must keep final
/// certification blocked until those guest controls are evidenced.
pub fn build_firecracker_config(
    plan: &MicroVmSupervisorPlan<'_>,
    options: FirecrackerConfigOptions<'_>,
) -> Result<FirecrackerConfig, FirecrackerPlanError> {
    validate_supervisor_plan(plan)?;
    validate_guest_path(GUEST_KERNEL_PATH)?;
    validate_guest_path(GUEST_ROOTFS_PATH)?;
    validate_guest_path(GUEST_CONFIG_PATH)?;
    validate_boot_args(options.boot_args)?;

    match (plan.scratch_disk_mib, options.scratch_guest_path) {
        (0, None) => {}
        (0, Some(_)) => return Err(FirecrackerPlanError::UnexpectedScratchImage),
        (_, None) => return Err(FirecrackerPlanError::ScratchImageRequired),
        (_, Some(path)) => validate_guest_path(path)?,
    }

    let mut json = String::with_capacity(1_024);
    json.push_str("{\"boot-source\":{");
    json.push_str("\"kernel_image_path\":");
    push_json_string(&mut json, GUEST_KERNEL_PATH);
    json.push_str(",\"boot_args\":");
    push_json_string(&mut json, options.boot_args);
    json.push_str("},\"drives\":[{");
    json.push_str(
        "\"drive_id\":\"rootfs\",\"is_root_device\":true,\"is_read_only\":true,\"path_on_host\":",
    );
    push_json_string(&mut json, GUEST_ROOTFS_PATH);
    json.push('}');

    if let Some(scratch_path) = options.scratch_guest_path {
        json.push_str(",{");
        json.push_str("\"drive_id\":\"scratch\",\"is_root_device\":false,\"is_read_only\":false,\"path_on_host\":");
        push_json_string(&mut json, scratch_path);
        json.push('}');
    }

    json.push_str("],\"machine-config\":{");
    json.push_str("\"vcpu_count\":");
    json.push_str(&plan.vcpu_count.to_string());
    json.push_str(",\"mem_size_mib\":");
    json.push_str(&plan.memory_mib.to_string());
    json.push_str(",\"smt\":false");
    json.push_str("},\"network-interfaces\":[]}");

    Ok(FirecrackerConfig { json })
}

/// Builds the exact jailer argv. No shell interpolation is involved. The cgroup
/// leaf must already exist and be verified by the runtime before this command
/// is spawned. Firecracker's API is disabled so the zero-NIC configuration
/// cannot be mutated through its API during the run.
pub fn build_jailer_command(
    plan: &MicroVmSupervisorPlan<'_>,
    staged_jailer: &Path,
    staged_firecracker: &Path,
    chroot_base: &Path,
    parent_cgroup_relative: &Path,
) -> Result<JailerCommandPlan, FirecrackerPlanError> {
    validate_supervisor_plan(plan)?;
    validate_host_absolute(staged_jailer)?;
    validate_host_absolute(staged_firecracker)?;
    validate_host_absolute(chroot_base)?;
    validate_cgroup_relative(parent_cgroup_relative)?;
    validate_jailer_id(plan.run_id)?;

    let firecracker_name = staged_firecracker
        .file_name()
        .ok_or(FirecrackerPlanError::MissingFirecrackerFileName)?;
    let chroot_root = chroot_base
        .join(firecracker_name)
        .join(plan.run_id)
        .join("root");

    let args = vec![
        OsString::from("--id"),
        OsString::from(plan.run_id),
        OsString::from("--exec-file"),
        staged_firecracker.as_os_str().to_owned(),
        OsString::from("--uid"),
        OsString::from(plan.jail_uid.to_string()),
        OsString::from("--gid"),
        OsString::from(plan.jail_gid.to_string()),
        OsString::from("--chroot-base-dir"),
        chroot_base.as_os_str().to_owned(),
        OsString::from("--cgroup-version"),
        OsString::from("2"),
        OsString::from("--parent-cgroup"),
        parent_cgroup_relative.as_os_str().to_owned(),
        OsString::from("--"),
        OsString::from("--config-file"),
        OsString::from(GUEST_CONFIG_PATH),
        OsString::from("--no-api"),
    ];

    Ok(JailerCommandPlan {
        program: staged_jailer.to_path_buf(),
        args,
        chroot_root,
        parent_cgroup_relative: parent_cgroup_relative.to_path_buf(),
        api_disabled: true,
        new_pid_namespace: false,
    })
}

fn validate_supervisor_plan(plan: &MicroVmSupervisorPlan<'_>) -> Result<(), FirecrackerPlanError> {
    if !plan.rootfs_read_only
        || plan.network_interfaces != 0
        || !plan.guest_seccomp_required
        || !plan.image_digest_verification_required
        || !plan.atomic_runtime_materialization_required
        || !plan.kill_on_timeout_required
        || !plan.kill_on_cancel_required
        || !plan.cgroup_cleanup_required
        || plan.memory_mib == 0
        || plan.jail_uid == 0
        || plan.jail_gid == 0
    {
        return Err(FirecrackerPlanError::UnsafePlan);
    }
    if plan.vcpu_count == 0
        || plan.vcpu_count > 32
        || (plan.vcpu_count != 1 && plan.vcpu_count % 2 != 0)
    {
        return Err(FirecrackerPlanError::UnsupportedVcpuCount(plan.vcpu_count));
    }
    Ok(())
}

fn validate_boot_args(value: &str) -> Result<(), FirecrackerPlanError> {
    if value.is_empty()
        || value.len() > 4096
        || !value.is_ascii()
        || value
            .bytes()
            .any(|byte| byte == 0 || (byte < 0x20 && byte != b' '))
    {
        return Err(FirecrackerPlanError::InvalidBootArgs);
    }
    Ok(())
}

fn validate_guest_path(value: &str) -> Result<(), FirecrackerPlanError> {
    let path = Path::new(value);
    if value.is_empty()
        || value.len() > 4096
        || value.contains('\0')
        || value.contains("//")
        || !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
    {
        return Err(FirecrackerPlanError::UnsafeGuestPath(value.to_owned()));
    }
    Ok(())
}

fn validate_host_absolute(path: &Path) -> Result<(), FirecrackerPlanError> {
    if path.as_os_str().is_empty()
        || !path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::CurDir | Component::ParentDir | Component::Prefix(_)
            )
        })
    {
        return Err(FirecrackerPlanError::UnsafeHostPath(path.to_path_buf()));
    }
    Ok(())
}

fn validate_cgroup_relative(path: &Path) -> Result<(), FirecrackerPlanError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(FirecrackerPlanError::UnsafeCgroupPath(path.to_path_buf()));
    }
    Ok(())
}

fn validate_jailer_id(value: &str) -> Result<(), FirecrackerPlanError> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(FirecrackerPlanError::UnsafePlan);
    }
    Ok(())
}

fn push_json_string(output: &mut String, value: &str) {
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\t' => output.push_str("\\t"),
            value if value.is_control() => {
                use std::fmt::Write as _;
                let _ = write!(output, "\\u{:04x}", value as u32);
            }
            value => output.push(value),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::supervisor::{CgroupV2Plan, MicroVmSupervisorPlan};

    fn plan(scratch_disk_mib: u64) -> MicroVmSupervisorPlan<'static> {
        MicroVmSupervisorPlan {
            run_id: "run-0123456789abcdef0123456789abcdef",
            workload_id: "seo-avengers-2500",
            source_sha256:
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            backend_id: "firecracker-microvm-v1",
            firecracker_exec: "/opt/walle/firecracker",
            firecracker_sha256:
                "sha256:3333333333333333333333333333333333333333333333333333333333333333",
            jailer_exec: "/opt/walle/jailer",
            jailer_sha256:
                "sha256:4444444444444444444444444444444444444444444444444444444444444444",
            run_root: "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            kernel_source: "/opt/walle/images/vmlinux",
            rootfs_source: "/opt/walle/images/rootfs.ext4",
            kernel_sha256:
                "sha256:1111111111111111111111111111111111111111111111111111111111111111",
            rootfs_sha256:
                "sha256:2222222222222222222222222222222222222222222222222222222222222222",
            jail_uid: 10001,
            jail_gid: 10001,
            cgroup: CgroupV2Plan {
                cpu_quota_us: 200_000,
                cpu_period_us: 100_000,
                memory_max_bytes: 1_073_741_824,
                pids_max: 128,
            },
            vcpu_count: 2,
            memory_mib: 1024,
            scratch_disk_mib,
            filesystem_mode: if scratch_disk_mib == 0 {
                "READ_ONLY_INPUTS"
            } else {
                "SCRATCH_AND_DECLARED_OUTPUT"
            },
            timeout_ms: 60_000,
            cancellation_grace_ms: 2_000,
            rootfs_read_only: true,
            network_interfaces: 0,
            guest_seccomp_required: true,
            guest_kernel_path: GUEST_KERNEL_PATH,
            guest_rootfs_path: GUEST_ROOTFS_PATH,
            guest_config_path: GUEST_CONFIG_PATH,
            image_digest_verification_required: true,
            atomic_runtime_materialization_required: true,
            kill_on_timeout_required: true,
            kill_on_cancel_required: true,
            cgroup_cleanup_required: true,
        }
    }

    #[test]
    fn deny_all_config_uses_current_schema_and_zero_nics() {
        let config = build_firecracker_config(&plan(0), FirecrackerConfigOptions::default())
            .expect("config");
        let value = config.as_str();
        assert!(value.contains("\"boot-source\""));
        assert!(value.contains("\"kernel_image_path\":\"/walle/kernel\""));
        assert!(value.contains("\"is_read_only\":true"));
        assert!(value.contains("\"machine-config\""));
        assert!(value.contains("\"smt\":false"));
        assert!(value.contains("\"network-interfaces\":[]"));
        assert!(!value.contains("ht_enabled"));
    }

    #[test]
    fn writable_scratch_is_never_silently_omitted() {
        assert!(matches!(
            build_firecracker_config(&plan(64), FirecrackerConfigOptions::default()),
            Err(FirecrackerPlanError::ScratchImageRequired)
        ));
        let config = build_firecracker_config(
            &plan(64),
            FirecrackerConfigOptions {
                boot_args: DEFAULT_BOOT_ARGS,
                scratch_guest_path: Some(SCRATCH_GUEST_PATH),
            },
        )
        .expect("scratch config");
        assert!(config.as_str().contains("\"drive_id\":\"scratch\""));
        assert!(config.as_str().contains("\"is_read_only\":false"));
    }

    #[test]
    fn jailer_argv_is_explicit_shell_free_and_api_disabled() {
        let command = build_jailer_command(
            &plan(0),
            Path::new("/opt/walle/staged/jailer"),
            Path::new("/opt/walle/staged/firecracker"),
            Path::new("/var/lib/walle/jailer"),
            Path::new("walle/run-0123456789abcdef0123456789abcdef"),
        )
        .expect("command");
        let args: Vec<String> = command
            .args
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect();
        assert_eq!(command.program, PathBuf::from("/opt/walle/staged/jailer"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--cgroup-version", "2"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--config-file", GUEST_CONFIG_PATH]));
        assert!(args.iter().any(|value| value == "--no-api"));
        assert!(!args.iter().any(|value| value == "--daemonize"));
        assert!(!args.iter().any(|value| value == "--new-pid-ns"));
        assert!(!args.iter().any(|value| value == "--netns"));
        assert!(command.api_disabled);
        assert!(!command.new_pid_namespace);
    }

    #[test]
    fn odd_vcpu_count_is_rejected_except_one() {
        let mut invalid = plan(0);
        invalid.vcpu_count = 3;
        assert!(matches!(
            build_firecracker_config(&invalid, FirecrackerConfigOptions::default()),
            Err(FirecrackerPlanError::UnsupportedVcpuCount(3))
        ));
    }

    #[test]
    fn cgroup_parent_cannot_escape() {
        assert!(matches!(
            build_jailer_command(
                &plan(0),
                Path::new("/opt/walle/staged/jailer"),
                Path::new("/opt/walle/staged/firecracker"),
                Path::new("/var/lib/walle/jailer"),
                Path::new("../escape"),
            ),
            Err(FirecrackerPlanError::UnsafeCgroupPath(_))
        ));
    }
}
