use std::fmt::{Display, Formatter};
use std::path::{Component, Path};

use crate::capsule::{ExecutionCapsule, FilesystemCapability};
use crate::is_valid_sha256;
use crate::microvm::{MicroVmLaunchPlan, FIRECRACKER_BACKEND_ID};

pub const SUPERVISOR_PLAN_SCHEMA_VERSION: u32 = 2;
pub const CGROUP_CPU_PERIOD_US: u64 = 100_000;
pub const GUEST_KERNEL_PATH: &str = "/walle/kernel";
pub const GUEST_ROOTFS_PATH: &str = "/walle/rootfs";
pub const GUEST_CONFIG_PATH: &str = "/walle/firecracker-config.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorRuntimePaths<'a> {
    pub firecracker_exec: &'a str,
    pub jailer_exec: &'a str,
    pub run_root: &'a str,
    pub kernel_source: &'a str,
    pub rootfs_source: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorRuntimeIdentity<'a> {
    pub firecracker_sha256: &'a str,
    pub jailer_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct JailIdentity {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CgroupV2Plan {
    pub cpu_quota_us: u64,
    pub cpu_period_us: u64,
    pub memory_max_bytes: u64,
    pub pids_max: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MicroVmSupervisorPlan<'a> {
    pub run_id: &'a str,
    pub workload_id: &'a str,
    pub source_sha256: &'a str,
    pub backend_id: &'static str,
    pub firecracker_exec: &'a str,
    pub firecracker_sha256: &'a str,
    pub jailer_exec: &'a str,
    pub jailer_sha256: &'a str,
    pub run_root: &'a str,
    pub kernel_source: &'a str,
    pub rootfs_source: &'a str,
    pub kernel_sha256: &'a str,
    pub rootfs_sha256: &'a str,
    pub jail_uid: u32,
    pub jail_gid: u32,
    pub cgroup: CgroupV2Plan,
    pub vcpu_count: u16,
    pub memory_mib: u64,
    pub scratch_disk_mib: u64,
    pub filesystem_mode: &'static str,
    pub timeout_ms: u64,
    pub cancellation_grace_ms: u64,
    pub rootfs_read_only: bool,
    pub network_interfaces: u8,
    pub guest_seccomp_required: bool,
    pub guest_kernel_path: &'static str,
    pub guest_rootfs_path: &'static str,
    pub guest_config_path: &'static str,
    pub image_digest_verification_required: bool,
    pub atomic_runtime_materialization_required: bool,
    pub kill_on_timeout_required: bool,
    pub kill_on_cancel_required: bool,
    pub cgroup_cleanup_required: bool,
}

impl MicroVmSupervisorPlan<'_> {
    pub fn canonical_json(self) -> String {
        let mut output = String::with_capacity(1_768);
        output.push('{');
        push_key_bool(
            &mut output,
            "atomic_runtime_materialization_required",
            self.atomic_runtime_materialization_required,
        );
        output.push(',');
        push_key_str(&mut output, "backend_id", self.backend_id);
        output.push(',');
        output.push_str("\"cgroup_v2\":{");
        push_key_u64(&mut output, "cpu_period_us", self.cgroup.cpu_period_us);
        output.push(',');
        push_key_u64(&mut output, "cpu_quota_us", self.cgroup.cpu_quota_us);
        output.push(',');
        push_key_u64(
            &mut output,
            "memory_max_bytes",
            self.cgroup.memory_max_bytes,
        );
        output.push(',');
        push_key_u64(&mut output, "pids_max", u64::from(self.cgroup.pids_max));
        output.push('}');
        output.push(',');
        push_key_bool(
            &mut output,
            "cgroup_cleanup_required",
            self.cgroup_cleanup_required,
        );
        output.push(',');
        push_key_u64(
            &mut output,
            "cancellation_grace_ms",
            self.cancellation_grace_ms,
        );
        output.push(',');
        push_key_str(&mut output, "filesystem_mode", self.filesystem_mode);
        output.push(',');
        push_key_str(&mut output, "firecracker_exec", self.firecracker_exec);
        output.push(',');
        push_key_str(&mut output, "firecracker_sha256", self.firecracker_sha256);
        output.push(',');
        push_key_str(&mut output, "guest_config_path", self.guest_config_path);
        output.push(',');
        push_key_str(&mut output, "guest_kernel_path", self.guest_kernel_path);
        output.push(',');
        push_key_str(&mut output, "guest_rootfs_path", self.guest_rootfs_path);
        output.push(',');
        push_key_bool(
            &mut output,
            "guest_seccomp_required",
            self.guest_seccomp_required,
        );
        output.push(',');
        push_key_bool(
            &mut output,
            "image_digest_verification_required",
            self.image_digest_verification_required,
        );
        output.push(',');
        push_key_u64(&mut output, "jail_gid", u64::from(self.jail_gid));
        output.push(',');
        push_key_u64(&mut output, "jail_uid", u64::from(self.jail_uid));
        output.push(',');
        push_key_str(&mut output, "jailer_exec", self.jailer_exec);
        output.push(',');
        push_key_str(&mut output, "jailer_sha256", self.jailer_sha256);
        output.push(',');
        push_key_str(&mut output, "kernel_sha256", self.kernel_sha256);
        output.push(',');
        push_key_str(&mut output, "kernel_source", self.kernel_source);
        output.push(',');
        push_key_bool(
            &mut output,
            "kill_on_cancel_required",
            self.kill_on_cancel_required,
        );
        output.push(',');
        push_key_bool(
            &mut output,
            "kill_on_timeout_required",
            self.kill_on_timeout_required,
        );
        output.push(',');
        push_key_u64(&mut output, "memory_mib", self.memory_mib);
        output.push(',');
        push_key_u64(
            &mut output,
            "network_interfaces",
            u64::from(self.network_interfaces),
        );
        output.push(',');
        push_key_bool(&mut output, "rootfs_read_only", self.rootfs_read_only);
        output.push(',');
        push_key_str(&mut output, "rootfs_sha256", self.rootfs_sha256);
        output.push(',');
        push_key_str(&mut output, "rootfs_source", self.rootfs_source);
        output.push(',');
        push_key_str(&mut output, "run_id", self.run_id);
        output.push(',');
        push_key_str(&mut output, "run_root", self.run_root);
        output.push(',');
        push_key_u64(
            &mut output,
            "schema_version",
            u64::from(SUPERVISOR_PLAN_SCHEMA_VERSION),
        );
        output.push(',');
        push_key_u64(&mut output, "scratch_disk_mib", self.scratch_disk_mib);
        output.push(',');
        push_key_str(&mut output, "source_sha256", self.source_sha256);
        output.push(',');
        push_key_u64(&mut output, "timeout_ms", self.timeout_ms);
        output.push(',');
        push_key_u64(&mut output, "vcpu_count", u64::from(self.vcpu_count));
        output.push(',');
        push_key_str(&mut output, "workload_id", self.workload_id);
        output.push('}');
        output
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorPlanError {
    InvalidCapsule,
    LaunchPlanMismatch,
    UnsafeRuntimePath,
    InvalidRuntimeBinaryIdentity,
    InvalidJailIdentity,
    ResourceOverflow,
}

impl Display for SupervisorPlanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCapsule => "execution capsule is invalid",
            Self::LaunchPlanMismatch => {
                "microVM launch plan does not exactly match the execution capsule"
            }
            Self::UnsafeRuntimePath => {
                "supervisor runtime path is not a normalized absolute host path"
            }
            Self::InvalidRuntimeBinaryIdentity => {
                "Firecracker and jailer identities must be canonical lowercase sha256 values"
            }
            Self::InvalidJailIdentity => "microVM jail uid/gid must both be non-zero",
            Self::ResourceOverflow => "supervisor resource limit conversion overflowed",
        })
    }
}

pub fn build_supervisor_plan<'a>(
    capsule: ExecutionCapsule<'a>,
    launch: MicroVmLaunchPlan<'a>,
    paths: SupervisorRuntimePaths<'a>,
    runtime_identity: SupervisorRuntimeIdentity<'a>,
    jail: JailIdentity,
) -> Result<MicroVmSupervisorPlan<'a>, SupervisorPlanError> {
    capsule
        .validate()
        .map_err(|_| SupervisorPlanError::InvalidCapsule)?;
    validate_launch_binding(capsule, launch)?;
    validate_paths(paths)?;
    if !is_valid_sha256(runtime_identity.firecracker_sha256)
        || !is_valid_sha256(runtime_identity.jailer_sha256)
    {
        return Err(SupervisorPlanError::InvalidRuntimeBinaryIdentity);
    }
    if jail.uid == 0 || jail.gid == 0 {
        return Err(SupervisorPlanError::InvalidJailIdentity);
    }

    let cpu_quota_us = u64::from(launch.vcpu_count)
        .checked_mul(CGROUP_CPU_PERIOD_US)
        .ok_or(SupervisorPlanError::ResourceOverflow)?;
    let memory_max_bytes = launch
        .memory_mib
        .checked_mul(1024 * 1024)
        .ok_or(SupervisorPlanError::ResourceOverflow)?;

    Ok(MicroVmSupervisorPlan {
        run_id: launch.run_id,
        workload_id: launch.workload_id,
        source_sha256: launch.source_sha256,
        backend_id: FIRECRACKER_BACKEND_ID,
        firecracker_exec: paths.firecracker_exec,
        firecracker_sha256: runtime_identity.firecracker_sha256,
        jailer_exec: paths.jailer_exec,
        jailer_sha256: runtime_identity.jailer_sha256,
        run_root: paths.run_root,
        kernel_source: paths.kernel_source,
        rootfs_source: paths.rootfs_source,
        kernel_sha256: launch.kernel_sha256,
        rootfs_sha256: launch.rootfs_sha256,
        jail_uid: jail.uid,
        jail_gid: jail.gid,
        cgroup: CgroupV2Plan {
            cpu_quota_us,
            cpu_period_us: CGROUP_CPU_PERIOD_US,
            memory_max_bytes,
            pids_max: launch.host_pid_limit,
        },
        vcpu_count: launch.vcpu_count,
        memory_mib: launch.memory_mib,
        scratch_disk_mib: launch.scratch_disk_mib,
        filesystem_mode: launch.filesystem_mode,
        timeout_ms: capsule.timeout_ms,
        cancellation_grace_ms: capsule.cancellation.grace_ms,
        rootfs_read_only: launch.rootfs_read_only,
        network_interfaces: launch.network_interfaces,
        guest_seccomp_required: launch.guest_seccomp_required,
        guest_kernel_path: GUEST_KERNEL_PATH,
        guest_rootfs_path: GUEST_ROOTFS_PATH,
        guest_config_path: GUEST_CONFIG_PATH,
        image_digest_verification_required: true,
        atomic_runtime_materialization_required: true,
        kill_on_timeout_required: true,
        kill_on_cancel_required: true,
        cgroup_cleanup_required: true,
    })
}

fn validate_launch_binding(
    capsule: ExecutionCapsule<'_>,
    launch: MicroVmLaunchPlan<'_>,
) -> Result<(), SupervisorPlanError> {
    let expected_filesystem_mode = match capsule.capabilities.filesystem {
        FilesystemCapability::None => "NONE",
        FilesystemCapability::ReadOnlyInputs => "READ_ONLY_INPUTS",
        FilesystemCapability::ScratchAndDeclaredOutput => "SCRATCH_AND_DECLARED_OUTPUT",
    };
    let expected_scratch = match capsule.capabilities.filesystem {
        FilesystemCapability::ScratchAndDeclaredOutput => capsule.resources.scratch_disk_mib,
        FilesystemCapability::None | FilesystemCapability::ReadOnlyInputs => 0,
    };

    let matches = launch.run_id == capsule.run_id
        && launch.workload_id == capsule.workload_id
        && launch.source_sha256 == capsule.source_sha256
        && launch.vcpu_count == capsule.resources.cpu_cores
        && launch.memory_mib == capsule.resources.memory_mib
        && launch.host_pid_limit == capsule.resources.pid_limit
        && launch.guest_pid_limit == capsule.resources.pid_limit
        && launch.scratch_disk_mib == expected_scratch
        && launch.filesystem_mode == expected_filesystem_mode
        && launch.rootfs_read_only
        && launch.network_interfaces == 0
        && launch.guest_seccomp_required
        && !launch.device_passthrough
        && !launch.secrets_mounted;

    if matches {
        Ok(())
    } else {
        Err(SupervisorPlanError::LaunchPlanMismatch)
    }
}

fn validate_paths(paths: SupervisorRuntimePaths<'_>) -> Result<(), SupervisorPlanError> {
    for value in [
        paths.firecracker_exec,
        paths.jailer_exec,
        paths.run_root,
        paths.kernel_source,
        paths.rootfs_source,
    ] {
        if !is_normalized_absolute_path(value) {
            return Err(SupervisorPlanError::UnsafeRuntimePath);
        }
    }
    if paths.run_root == "/"
        || paths.firecracker_exec == paths.jailer_exec
        || paths.kernel_source == paths.rootfs_source
    {
        return Err(SupervisorPlanError::UnsafeRuntimePath);
    }
    Ok(())
}

fn is_normalized_absolute_path(value: &str) -> bool {
    if value.is_empty() || value.len() > 4096 || value.contains('\0') {
        return false;
    }
    let path = Path::new(value);
    if !path.is_absolute() {
        return false;
    }
    path.components().all(|component| {
        !matches!(
            component,
            Component::CurDir | Component::ParentDir | Component::Prefix(_)
        )
    })
}

fn push_key_bool(output: &mut String, key: &str, value: bool) {
    push_json_string(output, key);
    output.push(':');
    output.push_str(if value { "true" } else { "false" });
}

fn push_key_str(output: &mut String, key: &str, value: &str) {
    push_json_string(output, key);
    output.push(':');
    push_json_string(output, value);
}

fn push_key_u64(output: &mut String, key: &str, value: u64) {
    push_json_string(output, key);
    output.push(':');
    output.push_str(&value.to_string());
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
            character if character.is_control() => {
                use std::fmt::Write;
                let _ = write!(output, "\\u{:04x}", u32::from(character));
            }
            character => output.push(character),
        }
    }
    output.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capsule::{
        CancellationOwner, CancellationPolicy, CapabilityRequest, ChildProcessCapability,
    };
    use crate::isolation::IsolationHostFacts;
    use crate::microvm::{build_microvm_plan, MicroVmImageSet};
    use crate::{CertificationProfile, NetworkPolicy, ResourcePlan};

    const SHA_A: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA_B: &str = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const SHA_C: &str = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const SHA_D: &str = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const SHA_E: &str = "sha256:3333333333333333333333333333333333333333333333333333333333333333";

    fn ready_host() -> IsolationHostFacts {
        IsolationHostFacts {
            os: "linux".to_owned(),
            architecture: "x86_64".to_owned(),
            effective_uid: Some(0),
            kvm_exists: true,
            kvm_is_character_device: true,
            kvm_open_read_write: true,
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

    fn capsule() -> ExecutionCapsule<'static> {
        let profile = CertificationProfile::Certification;
        ExecutionCapsule {
            run_id: "run-0123456789abcdef0123456789abcdef",
            attempt: 1,
            adapter_id: "seo-avengers-2500",
            adapter_version: "1.0.0",
            workload_id: "seo-avengers-2500",
            source_sha256: SHA_A,
            profile,
            resources: ResourcePlan::baseline(profile),
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapability::ScratchAndDeclaredOutput,
                network: NetworkPolicy::DenyAll,
                network_allowlist: &[],
                child_processes: ChildProcessCapability::Bounded,
                secret_names: &[],
                device_names: &[],
            },
            timeout_ms: 1_200_000,
            max_stdout_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
            cancellation: CancellationPolicy {
                owner: CancellationOwner::WalleControlPlane,
                grace_ms: 5_000,
            },
        }
    }

    fn launch(request: ExecutionCapsule<'static>) -> MicroVmLaunchPlan<'static> {
        build_microvm_plan(
            request,
            ready_host(),
            MicroVmImageSet {
                kernel_sha256: SHA_B,
                rootfs_sha256: SHA_C,
            },
        )
        .expect("launch plan")
    }

    fn paths() -> SupervisorRuntimePaths<'static> {
        SupervisorRuntimePaths {
            firecracker_exec: "/opt/walle/bin/firecracker",
            jailer_exec: "/opt/walle/bin/jailer",
            run_root: "/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef",
            kernel_source: "/var/lib/walle/images/kernel-v1.bin",
            rootfs_source: "/var/lib/walle/images/rootfs-v1.ext4",
        }
    }

    fn runtime_identity() -> SupervisorRuntimeIdentity<'static> {
        SupervisorRuntimeIdentity {
            firecracker_sha256: SHA_D,
            jailer_sha256: SHA_E,
        }
    }

    #[test]
    fn exact_launch_binding_produces_deterministic_fail_closed_supervisor_contract() {
        let request = capsule();
        let plan = build_supervisor_plan(
            request,
            launch(request),
            paths(),
            runtime_identity(),
            JailIdentity {
                uid: 65_534,
                gid: 65_534,
            },
        )
        .expect("supervisor plan");
        let json = plan.canonical_json();
        assert_eq!(json, plan.canonical_json());
        assert_eq!(plan.cgroup.cpu_period_us, CGROUP_CPU_PERIOD_US);
        assert_eq!(
            plan.cgroup.cpu_quota_us,
            u64::from(request.resources.cpu_cores) * CGROUP_CPU_PERIOD_US
        );
        assert_eq!(
            plan.cgroup.memory_max_bytes,
            request.resources.memory_mib * 1024 * 1024
        );
        assert_eq!(plan.cgroup.pids_max, request.resources.pid_limit);
        assert!(plan.rootfs_read_only);
        assert_eq!(plan.network_interfaces, 0);
        assert!(plan.guest_seccomp_required);
        assert!(plan.image_digest_verification_required);
        assert!(plan.atomic_runtime_materialization_required);
        assert!(plan.kill_on_timeout_required);
        assert!(plan.kill_on_cancel_required);
        assert!(plan.cgroup_cleanup_required);
        assert!(json.contains("\"backend_id\":\"firecracker-microvm-v1\""));
        assert!(json.contains("\"schema_version\":2"));
        assert!(json.contains(&format!("\"firecracker_sha256\":\"{SHA_D}\"")));
        assert!(json.contains(&format!("\"jailer_sha256\":\"{SHA_E}\"")));
        assert!(json.contains("\"guest_config_path\":\"/walle/firecracker-config.json\""));
    }

    #[test]
    fn invalid_runtime_binary_identity_fails_closed() {
        let request = capsule();
        assert_eq!(
            build_supervisor_plan(
                request,
                launch(request),
                paths(),
                SupervisorRuntimeIdentity {
                    firecracker_sha256: "sha256:ABC",
                    jailer_sha256: SHA_E,
                },
                JailIdentity {
                    uid: 65_534,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::InvalidRuntimeBinaryIdentity)
        );
    }

    #[test]
    fn stale_or_tampered_launch_plan_is_rejected() {
        let request = capsule();
        let mut stale = launch(request);
        stale.memory_mib += 1;
        assert_eq!(
            build_supervisor_plan(
                request,
                stale,
                paths(),
                runtime_identity(),
                JailIdentity {
                    uid: 65_534,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::LaunchPlanMismatch)
        );
    }

    #[test]
    fn relative_parent_and_root_runtime_paths_are_rejected() {
        let request = capsule();
        let mut unsafe_paths = paths();
        unsafe_paths.firecracker_exec = "../firecracker";
        assert_eq!(
            build_supervisor_plan(
                request,
                launch(request),
                unsafe_paths,
                runtime_identity(),
                JailIdentity {
                    uid: 65_534,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::UnsafeRuntimePath)
        );

        let mut root_paths = paths();
        root_paths.run_root = "/";
        assert_eq!(
            build_supervisor_plan(
                request,
                launch(request),
                root_paths,
                runtime_identity(),
                JailIdentity {
                    uid: 65_534,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::UnsafeRuntimePath)
        );
    }

    #[test]
    fn jail_identity_must_drop_root_inside_the_jail() {
        let request = capsule();
        assert_eq!(
            build_supervisor_plan(
                request,
                launch(request),
                paths(),
                runtime_identity(),
                JailIdentity {
                    uid: 0,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::InvalidJailIdentity)
        );
    }

    #[test]
    fn read_only_input_capsule_cannot_regain_scratch_in_supervisor_plan() {
        let mut request = capsule();
        request.capabilities.filesystem = FilesystemCapability::ReadOnlyInputs;
        let plan = build_supervisor_plan(
            request,
            launch(request),
            paths(),
            runtime_identity(),
            JailIdentity {
                uid: 65_534,
                gid: 65_534,
            },
        )
        .expect("supervisor plan");
        assert_eq!(plan.filesystem_mode, "READ_ONLY_INPUTS");
        assert_eq!(plan.scratch_disk_mib, 0);
    }

    #[test]
    fn resource_conversion_overflow_fails_closed() {
        let mut request = capsule();
        request.resources.memory_mib = u64::MAX;
        let launch = launch(request);
        assert_eq!(
            build_supervisor_plan(
                request,
                launch,
                paths(),
                runtime_identity(),
                JailIdentity {
                    uid: 65_534,
                    gid: 65_534,
                },
            ),
            Err(SupervisorPlanError::ResourceOverflow)
        );
    }
}
