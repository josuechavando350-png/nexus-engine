use std::fmt::{Display, Formatter};

use crate::capsule::{ChildProcessCapability, ExecutionCapsule, FilesystemCapability};
use crate::isolation::{assess_isolation_host, IsolationHostFacts, IsolationHostVerdict};
use walle_core::{is_valid_sha256, NetworkPolicy};

pub const MICROVM_PLAN_SCHEMA_VERSION: u32 = 1;
pub const FIRECRACKER_BACKEND_ID: &str = "firecracker-microvm-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MicroVmImageSet<'a> {
    pub kernel_sha256: &'a str,
    pub rootfs_sha256: &'a str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MicroVmLaunchPlan<'a> {
    pub run_id: &'a str,
    pub workload_id: &'a str,
    pub source_sha256: &'a str,
    pub kernel_sha256: &'a str,
    pub rootfs_sha256: &'a str,
    pub vcpu_count: u16,
    pub memory_mib: u64,
    pub host_pid_limit: u32,
    pub guest_pid_limit: u32,
    pub scratch_disk_mib: u64,
    pub rootfs_read_only: bool,
    pub network_interfaces: u8,
    pub guest_seccomp_required: bool,
    pub device_passthrough: bool,
    pub secrets_mounted: bool,
    pub filesystem_mode: &'static str,
}

impl MicroVmLaunchPlan<'_> {
    pub fn canonical_json(self) -> String {
        format!(
            concat!(
                "{{",
                "\"backend_id\":\"{}\",",
                "\"device_passthrough\":{},",
                "\"filesystem_mode\":\"{}\",",
                "\"guest_pid_limit\":{},",
                "\"guest_seccomp_required\":{},",
                "\"host_pid_limit\":{},",
                "\"kernel_sha256\":\"{}\",",
                "\"memory_mib\":{},",
                "\"network_interfaces\":{},",
                "\"rootfs_read_only\":{},",
                "\"rootfs_sha256\":\"{}\",",
                "\"run_id\":\"{}\",",
                "\"schema_version\":{},",
                "\"scratch_disk_mib\":{},",
                "\"secrets_mounted\":{},",
                "\"source_sha256\":\"{}\",",
                "\"vcpu_count\":{},",
                "\"workload_id\":\"{}\"",
                "}}"
            ),
            FIRECRACKER_BACKEND_ID,
            self.device_passthrough,
            self.filesystem_mode,
            self.guest_pid_limit,
            self.guest_seccomp_required,
            self.host_pid_limit,
            self.kernel_sha256,
            self.memory_mib,
            self.network_interfaces,
            self.rootfs_read_only,
            self.rootfs_sha256,
            self.run_id,
            MICROVM_PLAN_SCHEMA_VERSION,
            self.scratch_disk_mib,
            self.secrets_mounted,
            self.source_sha256,
            self.vcpu_count,
            self.workload_id,
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MicroVmPlanError {
    InvalidCapsule,
    HostNotReady,
    InvalidKernelSha256,
    InvalidRootfsSha256,
    NetworkPolicyNotSupported,
    SecretsNotSupported,
    DevicesNotSupported,
    ChildProcessPolicyNotSupported,
}

impl Display for MicroVmPlanError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidCapsule => "execution capsule is invalid",
            Self::HostNotReady => "microVM host prerequisites are not ready",
            Self::InvalidKernelSha256 => "kernel image identity is not a valid lowercase sha256",
            Self::InvalidRootfsSha256 => "rootfs image identity is not a valid lowercase sha256",
            Self::NetworkPolicyNotSupported => {
                "firecracker microVM v1 currently supports DENY_ALL networking only"
            }
            Self::SecretsNotSupported => {
                "firecracker microVM v1 does not support secret injection"
            }
            Self::DevicesNotSupported => {
                "firecracker microVM v1 does not support device passthrough"
            }
            Self::ChildProcessPolicyNotSupported => {
                "firecracker microVM v1 requires bounded child-process policy"
            }
        })
    }
}

pub fn build_microvm_plan<'a>(
    capsule: ExecutionCapsule<'a>,
    host_facts: IsolationHostFacts,
    images: MicroVmImageSet<'a>,
) -> Result<MicroVmLaunchPlan<'a>, MicroVmPlanError> {
    capsule
        .validate()
        .map_err(|_| MicroVmPlanError::InvalidCapsule)?;

    if assess_isolation_host(host_facts).verdict != IsolationHostVerdict::Ready {
        return Err(MicroVmPlanError::HostNotReady);
    }
    if !is_valid_sha256(images.kernel_sha256) {
        return Err(MicroVmPlanError::InvalidKernelSha256);
    }
    if !is_valid_sha256(images.rootfs_sha256) {
        return Err(MicroVmPlanError::InvalidRootfsSha256);
    }
    if capsule.capabilities.network != NetworkPolicy::DenyAll {
        return Err(MicroVmPlanError::NetworkPolicyNotSupported);
    }
    if !capsule.capabilities.secret_names.is_empty() {
        return Err(MicroVmPlanError::SecretsNotSupported);
    }
    if !capsule.capabilities.device_names.is_empty() {
        return Err(MicroVmPlanError::DevicesNotSupported);
    }
    if capsule.capabilities.child_processes != ChildProcessCapability::Bounded {
        return Err(MicroVmPlanError::ChildProcessPolicyNotSupported);
    }

    let (filesystem_mode, scratch_disk_mib) = match capsule.capabilities.filesystem {
        FilesystemCapability::None => ("NONE", 0),
        FilesystemCapability::ReadOnlyInputs => ("READ_ONLY_INPUTS", 0),
        FilesystemCapability::ScratchAndDeclaredOutput => (
            "SCRATCH_AND_DECLARED_OUTPUT",
            capsule.resources.scratch_disk_mib,
        ),
    };

    Ok(MicroVmLaunchPlan {
        run_id: capsule.run_id,
        workload_id: capsule.workload_id,
        source_sha256: capsule.source_sha256,
        kernel_sha256: images.kernel_sha256,
        rootfs_sha256: images.rootfs_sha256,
        vcpu_count: capsule.resources.cpu_cores,
        memory_mib: capsule.resources.memory_mib,
        host_pid_limit: capsule.resources.pid_limit,
        guest_pid_limit: capsule.resources.pid_limit,
        scratch_disk_mib,
        rootfs_read_only: true,
        network_interfaces: 0,
        guest_seccomp_required: true,
        device_passthrough: false,
        secrets_mounted: false,
        filesystem_mode,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capsule::{
        CancellationOwner, CancellationPolicy, CapabilityRequest, ExecutionCapsule,
    };
    use walle_core::{CertificationProfile, ResourcePlan};

    const SHA_A: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const SHA_B: &str =
        "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
    const SHA_C: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";

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

    fn images() -> MicroVmImageSet<'static> {
        MicroVmImageSet {
            kernel_sha256: SHA_B,
            rootfs_sha256: SHA_C,
        }
    }

    #[test]
    fn ready_host_and_deny_all_capsule_produce_locked_plan() {
        let plan = build_microvm_plan(capsule(), ready_host(), images()).expect("plan");
        assert_eq!(plan.network_interfaces, 0);
        assert!(plan.rootfs_read_only);
        assert!(plan.guest_seccomp_required);
        assert!(!plan.device_passthrough);
        assert!(!plan.secrets_mounted);
        assert_eq!(plan.guest_pid_limit, plan.host_pid_limit);
        assert_eq!(
            plan.scratch_disk_mib,
            ResourcePlan::baseline(CertificationProfile::Certification).scratch_disk_mib
        );
    }

    #[test]
    fn launch_plan_json_is_byte_stable_and_has_no_network_interface() {
        let first = build_microvm_plan(capsule(), ready_host(), images())
            .expect("plan")
            .canonical_json();
        let second = build_microvm_plan(capsule(), ready_host(), images())
            .expect("plan")
            .canonical_json();
        assert_eq!(first, second);
        assert!(first.contains("\"backend_id\":\"firecracker-microvm-v1\""));
        assert!(first.contains("\"network_interfaces\":0"));
        assert!(first.contains("\"rootfs_read_only\":true"));
        assert!(first.contains("\"guest_seccomp_required\":true"));
        assert!(first.contains("\"secrets_mounted\":false"));
        assert!(first.contains("\"device_passthrough\":false"));
    }

    #[test]
    fn missing_kvm_blocks_plan() {
        let mut host = ready_host();
        host.kvm_open_read_write = false;
        assert_eq!(
            build_microvm_plan(capsule(), host, images()),
            Err(MicroVmPlanError::HostNotReady)
        );
    }

    #[test]
    fn allowlisted_network_is_not_silently_weakened_to_deny_all() {
        let mut request = capsule();
        request.capabilities.network = NetworkPolicy::ExplicitAllowlist;
        request.capabilities.network_allowlist = &["example.com:443"];
        assert_eq!(
            build_microvm_plan(request, ready_host(), images()),
            Err(MicroVmPlanError::NetworkPolicyNotSupported)
        );
    }

    #[test]
    fn secrets_and_devices_are_fail_closed() {
        let mut with_secret = capsule();
        with_secret.capabilities.secret_names = &["build_token"];
        assert_eq!(
            build_microvm_plan(with_secret, ready_host(), images()),
            Err(MicroVmPlanError::SecretsNotSupported)
        );

        let mut with_device = capsule();
        with_device.capabilities.device_names = &["kvm"];
        assert_eq!(
            build_microvm_plan(with_device, ready_host(), images()),
            Err(MicroVmPlanError::DevicesNotSupported)
        );
    }

    #[test]
    fn invalid_image_identity_is_rejected() {
        let invalid = MicroVmImageSet {
            kernel_sha256: "sha256:deadbeef",
            rootfs_sha256: SHA_C,
        };
        assert_eq!(
            build_microvm_plan(capsule(), ready_host(), invalid),
            Err(MicroVmPlanError::InvalidKernelSha256)
        );
    }

    #[test]
    fn read_only_input_mode_does_not_allocate_writable_scratch() {
        let mut request = capsule();
        request.capabilities.filesystem = FilesystemCapability::ReadOnlyInputs;
        let plan = build_microvm_plan(request, ready_host(), images()).expect("plan");
        assert_eq!(plan.filesystem_mode, "READ_ONLY_INPUTS");
        assert_eq!(plan.scratch_disk_mib, 0);
    }
}
