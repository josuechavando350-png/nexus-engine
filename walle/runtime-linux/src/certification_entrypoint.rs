use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use walle_core::capsule::{
    CancellationOwner, CancellationPolicy, CapabilityRequest, ChildProcessCapability,
    ExecutionCapsule, FilesystemCapability,
};
use walle_core::certification::FinalCertificationDecision;
use walle_core::isolation::{collect_isolation_host_facts, IsolationHostFacts};
use walle_core::microvm::{build_microvm_plan, MicroVmImageSet, MicroVmPlanError};
use walle_core::supervisor::{
    build_supervisor_plan, JailIdentity, MicroVmSupervisorPlan, SupervisorPlanError,
    SupervisorRuntimeIdentity, SupervisorRuntimePaths,
};
use walle_core::{
    CertificationProfile, NetworkPolicy, ResourcePlan, RunMachine, RunState, TransitionError,
};

use crate::certification_runtime::{
    execute_linux_certification_with_trusted_guest_image, CertificationRuntimeError,
};
use crate::firecracker::DEFAULT_BOOT_ARGS;
use crate::guest_image::GuestImageManifestSource;
use crate::guest_rootfs::GuestRootfsInspectorSource;
use crate::host::LinuxMicroVmHostConfig;

const CERTIFICATION_ADAPTER_ID: &str = "walle-certification-runner";
const CERTIFICATION_ADAPTER_VERSION: &str = "1.0.0";
const CERTIFICATION_ATTEMPT: u32 = 1;

/// Complete host-side input for one physical WALLE certification attempt.
///
/// Deliberately absent from this structure: caller-selectable certification
/// profile, network mode, network allowlist, secrets, devices, child-process
/// policy, or kernel boot arguments. The operational entrypoint fixes those
/// security-sensitive choices below and delegates the physical proof path to
/// `certification_runtime`.
#[derive(Debug, Clone)]
pub struct CertificationEntrypointConfig {
    pub run_id: String,
    pub workload_id: String,
    pub source_sha256: String,
    pub resources: ResourcePlan,
    pub filesystem: FilesystemCapability,
    pub timeout_ms: u64,
    pub max_stdout_bytes: u64,
    pub max_stderr_bytes: u64,
    pub cancellation_grace_ms: u64,

    pub firecracker_exec: PathBuf,
    pub firecracker_sha256: String,
    pub jailer_exec: PathBuf,
    pub jailer_sha256: String,
    pub run_root: PathBuf,
    pub kernel_source: PathBuf,
    pub kernel_sha256: String,
    pub rootfs_source: PathBuf,
    pub rootfs_sha256: String,
    pub jail_uid: u32,
    pub jail_gid: u32,

    pub evidence_root: PathBuf,
    pub sha256_program: PathBuf,
    pub cgroup_mount: PathBuf,
    pub cgroup_parent_relative: PathBuf,
    pub chroot_base: PathBuf,
    pub mkfs_ext4_program: Option<PathBuf>,

    pub guest_manifest_path: PathBuf,
    pub guest_manifest_sha256: String,
    pub debugfs_program: PathBuf,
    pub debugfs_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertificationEntrypointOutcome {
    pub decision: FinalCertificationDecision,
    pub final_state: RunState,
}

#[derive(Debug)]
pub enum CertificationEntrypointError {
    InvalidUtf8Path(&'static str),
    MicroVmPlan(MicroVmPlanError),
    SupervisorPlan(SupervisorPlanError),
    Runtime(CertificationRuntimeError),
    Transition(TransitionError),
}

impl Display for CertificationEntrypointError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUtf8Path(label) => {
                write!(formatter, "{label} path is not valid UTF-8")
            }
            Self::MicroVmPlan(error) => Display::fmt(error, formatter),
            Self::SupervisorPlan(error) => Display::fmt(error, formatter),
            Self::Runtime(error) => Display::fmt(error, formatter),
            Self::Transition(error) => Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for CertificationEntrypointError {}

impl From<MicroVmPlanError> for CertificationEntrypointError {
    fn from(value: MicroVmPlanError) -> Self {
        Self::MicroVmPlan(value)
    }
}

impl From<SupervisorPlanError> for CertificationEntrypointError {
    fn from(value: SupervisorPlanError) -> Self {
        Self::SupervisorPlan(value)
    }
}

impl From<CertificationRuntimeError> for CertificationEntrypointError {
    fn from(value: CertificationRuntimeError) -> Self {
        Self::Runtime(value)
    }
}

impl From<TransitionError> for CertificationEntrypointError {
    fn from(value: TransitionError) -> Self {
        Self::Transition(value)
    }
}

impl CertificationEntrypointConfig {
    fn execution_capsule(&self) -> ExecutionCapsule<'_> {
        ExecutionCapsule {
            run_id: &self.run_id,
            attempt: CERTIFICATION_ATTEMPT,
            adapter_id: CERTIFICATION_ADAPTER_ID,
            adapter_version: CERTIFICATION_ADAPTER_VERSION,
            workload_id: &self.workload_id,
            source_sha256: &self.source_sha256,
            profile: CertificationProfile::Certification,
            resources: self.resources,
            capabilities: CapabilityRequest {
                filesystem: self.filesystem,
                network: NetworkPolicy::DenyAll,
                network_allowlist: &[],
                child_processes: ChildProcessCapability::Bounded,
                secret_names: &[],
                device_names: &[],
            },
            timeout_ms: self.timeout_ms,
            max_stdout_bytes: self.max_stdout_bytes,
            max_stderr_bytes: self.max_stderr_bytes,
            cancellation: CancellationPolicy {
                owner: CancellationOwner::WalleControlPlane,
                grace_ms: self.cancellation_grace_ms,
            },
        }
    }
}

/// Executes exactly one physical WALLE certification path.
///
/// The function performs live host admission, derives the microVM and
/// supervisor plans from the fixed CERTIFICATION capsule, enters the sealed
/// pre-execution certification runtime, advances the run state to CERTIFYING,
/// and lets the central fail-closed gate make the only terminal certification
/// decision. No evidence category is synthesized here.
pub fn execute_certification_entrypoint(
    config: &CertificationEntrypointConfig,
) -> Result<CertificationEntrypointOutcome, CertificationEntrypointError> {
    let mut machine = RunMachine::new();
    machine.transition(RunState::Preparing)?;

    let host_facts = collect_isolation_host_facts();
    let plan = build_certification_plan(config, host_facts)?;
    machine.transition(RunState::Isolated)?;
    machine.transition(RunState::Executing)?;

    let host_config = LinuxMicroVmHostConfig {
        sha256_program: config.sha256_program.clone(),
        firecracker_sha256: config.firecracker_sha256.clone(),
        jailer_sha256: config.jailer_sha256.clone(),
        cgroup_mount: config.cgroup_mount.clone(),
        cgroup_parent_relative: config.cgroup_parent_relative.clone(),
        chroot_base: config.chroot_base.clone(),
        mkfs_ext4_program: config.mkfs_ext4_program.clone(),
        boot_args: DEFAULT_BOOT_ARGS.to_owned(),
    };
    let guest_image_manifest = GuestImageManifestSource {
        path: config.guest_manifest_path.clone(),
        sha256: config.guest_manifest_sha256.clone(),
    };
    let guest_rootfs_inspector = GuestRootfsInspectorSource {
        debugfs_program: config.debugfs_program.clone(),
        debugfs_sha256: config.debugfs_sha256.clone(),
    };

    let run = execute_linux_certification_with_trusted_guest_image(
        host_config,
        config.evidence_root.clone(),
        config.execution_capsule(),
        &plan,
        &guest_image_manifest,
        &guest_rootfs_inspector,
    )?;

    machine.transition(RunState::Verifying)?;
    machine.transition(RunState::Certifying)?;
    let decision = run.apply_final_certification(&mut machine)?;

    Ok(CertificationEntrypointOutcome {
        decision,
        final_state: machine.state(),
    })
}

fn build_certification_plan<'a>(
    config: &'a CertificationEntrypointConfig,
    host_facts: IsolationHostFacts,
) -> Result<MicroVmSupervisorPlan<'a>, CertificationEntrypointError> {
    let capsule = config.execution_capsule();
    let launch = build_microvm_plan(
        capsule,
        host_facts,
        MicroVmImageSet {
            kernel_sha256: &config.kernel_sha256,
            rootfs_sha256: &config.rootfs_sha256,
        },
    )?;

    let paths = SupervisorRuntimePaths {
        firecracker_exec: path_str("firecracker", &config.firecracker_exec)?,
        jailer_exec: path_str("jailer", &config.jailer_exec)?,
        run_root: path_str("run root", &config.run_root)?,
        kernel_source: path_str("kernel", &config.kernel_source)?,
        rootfs_source: path_str("rootfs", &config.rootfs_source)?,
    };
    let runtime_identity = SupervisorRuntimeIdentity {
        firecracker_sha256: &config.firecracker_sha256,
        jailer_sha256: &config.jailer_sha256,
    };
    let jail = JailIdentity {
        uid: config.jail_uid,
        gid: config.jail_gid,
    };

    Ok(build_supervisor_plan(
        capsule,
        launch,
        paths,
        runtime_identity,
        jail,
    )?)
}

fn path_str<'a>(
    label: &'static str,
    path: &'a Path,
) -> Result<&'a str, CertificationEntrypointError> {
    path.to_str()
        .ok_or(CertificationEntrypointError::InvalidUtf8Path(label))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const KERNEL_SHA: &str =
        "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    const ROOTFS_SHA: &str =
        "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    const FIRECRACKER_SHA: &str =
        "sha256:3333333333333333333333333333333333333333333333333333333333333333";
    const JAILER_SHA: &str =
        "sha256:4444444444444444444444444444444444444444444444444444444444444444";

    fn config() -> CertificationEntrypointConfig {
        let resources = ResourcePlan::baseline(CertificationProfile::Certification);
        CertificationEntrypointConfig {
            run_id: "run-0123456789abcdef0123456789abcdef".to_owned(),
            workload_id: "seo-avengers-2500".to_owned(),
            source_sha256: SOURCE_SHA.to_owned(),
            resources,
            filesystem: FilesystemCapability::ScratchAndDeclaredOutput,
            timeout_ms: 1_200_000,
            max_stdout_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
            cancellation_grace_ms: 5_000,
            firecracker_exec: PathBuf::from("/opt/walle/firecracker"),
            firecracker_sha256: FIRECRACKER_SHA.to_owned(),
            jailer_exec: PathBuf::from("/opt/walle/jailer"),
            jailer_sha256: JAILER_SHA.to_owned(),
            run_root: PathBuf::from("/var/lib/walle/runs/run-0123456789abcdef0123456789abcdef"),
            kernel_source: PathBuf::from("/opt/walle/images/vmlinux"),
            kernel_sha256: KERNEL_SHA.to_owned(),
            rootfs_source: PathBuf::from("/opt/walle/images/rootfs.ext4"),
            rootfs_sha256: ROOTFS_SHA.to_owned(),
            jail_uid: 10001,
            jail_gid: 10001,
            evidence_root: PathBuf::from("/var/lib/walle/evidence"),
            sha256_program: PathBuf::from("/usr/bin/sha256sum"),
            cgroup_mount: PathBuf::from("/sys/fs/cgroup"),
            cgroup_parent_relative: PathBuf::from("walle"),
            chroot_base: PathBuf::from("/srv/walle/jailer"),
            mkfs_ext4_program: Some(PathBuf::from("/usr/sbin/mkfs.ext4")),
            guest_manifest_path: PathBuf::from("/opt/walle/images/guest-manifest.json"),
            guest_manifest_sha256: KERNEL_SHA.to_owned(),
            debugfs_program: PathBuf::from("/usr/sbin/debugfs"),
            debugfs_sha256: ROOTFS_SHA.to_owned(),
        }
    }

    fn ready_host() -> IsolationHostFacts {
        IsolationHostFacts {
            os: "linux".to_owned(),
            architecture: "x86_64".to_owned(),
            effective_uid: Some(0),
            kvm_exists: true,
            kvm_is_character_device: true,
            kvm_open_read_write: true,
            kvm_api_version: Some(12),
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
    fn operational_capsule_is_always_certification_and_deny_all() {
        let config = config();
        let capsule = config.execution_capsule();
        assert_eq!(capsule.profile, CertificationProfile::Certification);
        assert_eq!(capsule.capabilities.network, NetworkPolicy::DenyAll);
        assert!(capsule.capabilities.network_allowlist.is_empty());
        assert!(capsule.capabilities.secret_names.is_empty());
        assert!(capsule.capabilities.device_names.is_empty());
        assert_eq!(
            capsule.capabilities.child_processes,
            ChildProcessCapability::Bounded
        );
    }

    #[test]
    fn operational_plan_is_derived_from_locked_certification_capsule() {
        let config = config();
        let plan = build_certification_plan(&config, ready_host()).expect("locked plan");
        assert_eq!(plan.run_id, config.run_id);
        assert_eq!(plan.source_sha256, config.source_sha256);
        assert_eq!(plan.network_interfaces, 0);
        assert!(plan.rootfs_read_only);
        assert!(plan.guest_seccomp_required);
        assert!(plan.image_digest_verification_required);
        assert!(plan.atomic_runtime_materialization_required);
        assert!(plan.kill_on_timeout_required);
        assert!(plan.kill_on_cancel_required);
        assert!(plan.cgroup_cleanup_required);
    }

    #[test]
    fn host_without_usable_kvm_cannot_build_operational_plan() {
        let config = config();
        let mut host = ready_host();
        host.kvm_open_read_write = false;
        host.kvm_api_version = None;
        host.kvm_api_compatible = false;
        let error = build_certification_plan(&config, host).expect_err("must fail closed");
        assert!(matches!(
            error,
            CertificationEntrypointError::MicroVmPlan(MicroVmPlanError::HostNotReady)
        ));
    }
}
