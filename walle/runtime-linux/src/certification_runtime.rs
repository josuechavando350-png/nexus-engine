use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use walle_core::capsule::{
    CapsuleError, ChildProcessCapability, ExecutionCapsule, FilesystemCapability,
};
use walle_core::certification::{
    evaluate_and_apply_final_certification, CertificationInput, FinalCertificationDecision,
};
use walle_core::supervisor::{MicroVmSupervisorPlan, CGROUP_CPU_PERIOD_US};
use walle_core::{CertificationProfile, NetworkPolicy, RunMachine, TransitionError};

use crate::artifact::SystemSha256;
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::guest_image::GuestImageManifestSource;
use crate::guest_rootfs::GuestRootfsInspectorSource;
use crate::host::LinuxMicroVmHostConfig;
use crate::safe_fs::{SecureDirectory, SecureFsError};
use crate::trusted_runner::{
    execute_linux_supervisor_with_trusted_guest_image, TrustedGuestEvidenceBundle,
    TrustedGuestRunError,
};

pub const CERTIFICATION_CONTEXT_DIRECTORY: &str = "certification-context";
pub const CERTIFICATION_PROFILE_EVIDENCE_KIND: &str = "certification-profile";

#[derive(Debug)]
pub enum CertificationRuntimeError {
    Capsule(CapsuleError),
    CertificationProfileRequired,
    PlanBindingMismatch,
    ContextBindingMismatch,
    Evidence(EvidenceError),
    SecureFs(SecureFsError),
    TrustedRun(TrustedGuestRunError),
    Transition(TransitionError),
}

impl Display for CertificationRuntimeError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Capsule(error) => Display::fmt(error, formatter),
            Self::CertificationProfileRequired => formatter.write_str(
                "physical certification execution requires a CERTIFICATION execution capsule",
            ),
            Self::PlanBindingMismatch => formatter.write_str(
                "supervisor plan is not exactly bound to the certification execution capsule",
            ),
            Self::ContextBindingMismatch => formatter.write_str(
                "durable certification context is not bound to the physical trusted guest run",
            ),
            Self::Evidence(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
            Self::TrustedRun(error) => Display::fmt(error, formatter),
            Self::Transition(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for CertificationRuntimeError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Evidence(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::TrustedRun(error) => Some(error),
            Self::Transition(error) => Some(error),
            Self::Capsule(_)
            | Self::CertificationProfileRequired
            | Self::PlanBindingMismatch
            | Self::ContextBindingMismatch => None,
        }
    }
}

impl From<CapsuleError> for CertificationRuntimeError {
    fn from(value: CapsuleError) -> Self {
        Self::Capsule(value)
    }
}

impl From<EvidenceError> for CertificationRuntimeError {
    fn from(value: EvidenceError) -> Self {
        Self::Evidence(value)
    }
}

impl From<SecureFsError> for CertificationRuntimeError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

impl From<TrustedGuestRunError> for CertificationRuntimeError {
    fn from(value: TrustedGuestRunError) -> Self {
        Self::TrustedRun(value)
    }
}

impl From<TransitionError> for CertificationRuntimeError {
    fn from(value: TransitionError) -> Self {
        Self::Transition(value)
    }
}

#[derive(Debug)]
struct DurableCertificationContext {
    run_directory: PathBuf,
    sha256_program: PathBuf,
    receipt: EvidenceReceipt,
    seal: EvidenceSeal,
}

impl DurableCertificationContext {
    fn verify(&self) -> Result<(), CertificationRuntimeError> {
        let hasher = SystemSha256::new(self.sha256_program.clone()).map_err(EvidenceError::from)?;
        verify_evidence_chain(
            &self.run_directory,
            std::slice::from_ref(&self.receipt),
            &self.seal,
            &hasher,
        )?;
        Ok(())
    }
}

/// One physical trusted-guest execution whose exact CERTIFICATION execution
/// capsule was validated against the supervisor plan and durably sealed before
/// any microVM lifecycle effect.
#[derive(Debug)]
pub struct LinuxCertificationRun {
    context: DurableCertificationContext,
    execution: TrustedGuestEvidenceBundle,
}

impl LinuxCertificationRun {
    pub fn execution(&self) -> &TrustedGuestEvidenceBundle {
        &self.execution
    }

    pub fn certification_profile_receipt(&self) -> &EvidenceReceipt {
        &self.context.receipt
    }

    pub fn certification_profile_seal(&self) -> &EvidenceSeal {
        &self.context.seal
    }

    /// Re-verifies the durable pre-execution certification context, binds it to
    /// the exact physical supervisor run, projects only already-verified trusted
    /// guest evidence, and delegates the only CERTIFIED transition to the core
    /// fail-closed certification gate.
    pub fn apply_final_certification(
        &self,
        machine: &mut RunMachine,
    ) -> Result<FinalCertificationDecision, CertificationRuntimeError> {
        self.context.verify()?;

        let supervisor_seal = &self.execution.supervisor().seal;
        if self.context.seal.run_id != supervisor_seal.run_id
            || self.context.seal.source_sha256 != supervisor_seal.source_sha256
        {
            return Err(CertificationRuntimeError::ContextBindingMismatch);
        }

        let evidence = self.execution.certification_evidence();
        let decision = evaluate_and_apply_final_certification(
            machine,
            CertificationInput {
                run_id: &supervisor_seal.run_id,
                source_sha256: &supervisor_seal.source_sha256,
                profile: CertificationProfile::Certification,
                run_state: machine.state(),
                evidence: &evidence,
            },
        )?;
        Ok(decision)
    }
}

/// Enters WALLE's physical certification execution path.
///
/// The caller must provide the original canonical execution capsule. This
/// function rejects FAST/HARDENED capsules and rejects any supervisor plan that
/// is not exactly derived from that capsule's run/source/workload, resources,
/// filesystem policy, output bounds, timeout and cancellation policy. The full
/// canonical CERTIFICATION capsule is then persisted in a dedicated sealed
/// evidence chain before the trusted Firecracker runner is invoked.
pub fn execute_linux_certification_with_trusted_guest_image(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    capsule: ExecutionCapsule<'_>,
    plan: &MicroVmSupervisorPlan<'_>,
    guest_image_manifest: &GuestImageManifestSource,
    guest_rootfs_inspector: &GuestRootfsInspectorSource,
) -> Result<LinuxCertificationRun, CertificationRuntimeError> {
    validate_certification_plan_binding(capsule, plan)?;
    let evidence_root = evidence_root.into();
    let canonical_capsule = capsule.canonical_json()?;
    let context = persist_certification_context(
        &evidence_root,
        host_config.sha256_program.clone(),
        plan,
        canonical_capsule.as_bytes(),
    )?;

    let execution = execute_linux_supervisor_with_trusted_guest_image(
        host_config,
        evidence_root,
        plan,
        guest_image_manifest,
        guest_rootfs_inspector,
    )?;

    if context.seal.run_id != execution.supervisor().seal.run_id
        || context.seal.source_sha256 != execution.supervisor().seal.source_sha256
    {
        return Err(CertificationRuntimeError::ContextBindingMismatch);
    }

    Ok(LinuxCertificationRun { context, execution })
}

fn validate_certification_plan_binding(
    capsule: ExecutionCapsule<'_>,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<(), CertificationRuntimeError> {
    capsule.validate()?;
    if capsule.profile != CertificationProfile::Certification {
        return Err(CertificationRuntimeError::CertificationProfileRequired);
    }

    let expected_filesystem_mode = match capsule.capabilities.filesystem {
        FilesystemCapability::None => "NONE",
        FilesystemCapability::ReadOnlyInputs => "READ_ONLY_INPUTS",
        FilesystemCapability::ScratchAndDeclaredOutput => "SCRATCH_AND_DECLARED_OUTPUT",
    };
    let expected_scratch = match capsule.capabilities.filesystem {
        FilesystemCapability::ScratchAndDeclaredOutput => capsule.resources.scratch_disk_mib,
        FilesystemCapability::None | FilesystemCapability::ReadOnlyInputs => 0,
    };
    let expected_cpu_quota = u64::from(capsule.resources.cpu_cores)
        .checked_mul(CGROUP_CPU_PERIOD_US)
        .ok_or(CertificationRuntimeError::PlanBindingMismatch)?;
    let expected_memory_bytes = capsule
        .resources
        .memory_mib
        .checked_mul(1024 * 1024)
        .ok_or(CertificationRuntimeError::PlanBindingMismatch)?;

    let matches = capsule.capabilities.network == NetworkPolicy::DenyAll
        && capsule.capabilities.network_allowlist.is_empty()
        && capsule.capabilities.secret_names.is_empty()
        && capsule.capabilities.device_names.is_empty()
        && capsule.capabilities.child_processes == ChildProcessCapability::Bounded
        && plan.run_id == capsule.run_id
        && plan.workload_id == capsule.workload_id
        && plan.source_sha256 == capsule.source_sha256
        && plan.vcpu_count == capsule.resources.cpu_cores
        && plan.memory_mib == capsule.resources.memory_mib
        && plan.cgroup.cpu_period_us == CGROUP_CPU_PERIOD_US
        && plan.cgroup.cpu_quota_us == expected_cpu_quota
        && plan.cgroup.memory_max_bytes == expected_memory_bytes
        && plan.cgroup.pids_max == capsule.resources.pid_limit
        && plan.scratch_disk_mib == expected_scratch
        && plan.filesystem_mode == expected_filesystem_mode
        && plan.max_stdout_bytes == capsule.max_stdout_bytes
        && plan.max_stderr_bytes == capsule.max_stderr_bytes
        && plan.timeout_ms == capsule.timeout_ms
        && plan.cancellation_grace_ms == capsule.cancellation.grace_ms
        && plan.rootfs_read_only
        && plan.network_interfaces == 0
        && plan.guest_seccomp_required
        && plan.image_digest_verification_required
        && plan.atomic_runtime_materialization_required
        && plan.kill_on_timeout_required
        && plan.kill_on_cancel_required
        && plan.cgroup_cleanup_required;

    if matches {
        Ok(())
    } else {
        Err(CertificationRuntimeError::PlanBindingMismatch)
    }
}

fn persist_certification_context(
    evidence_root: &Path,
    sha256_program: PathBuf,
    plan: &MicroVmSupervisorPlan<'_>,
    canonical_capsule: &[u8],
) -> Result<DurableCertificationContext, CertificationRuntimeError> {
    let root = SecureDirectory::open(evidence_root.to_path_buf())?;
    root.validate_trusted()?;
    let context_root = root.create_child_directory(CERTIFICATION_CONTEXT_DIRECTORY, 0o700, true)?;
    context_root.validate_trusted()?;

    let mut run = EvidenceRun::begin(
        context_root.path().to_path_buf(),
        sha256_program.clone(),
        plan.run_id,
        plan.source_sha256,
    )?;
    let receipt = run.append(CERTIFICATION_PROFILE_EVIDENCE_KIND, canonical_capsule)?;
    let seal = run.seal()?;
    let run_directory = run.path().to_path_buf();
    let hasher = SystemSha256::new(sha256_program.clone()).map_err(EvidenceError::from)?;
    verify_evidence_chain(
        &run_directory,
        std::slice::from_ref(&receipt),
        &seal,
        &hasher,
    )?;

    Ok(DurableCertificationContext {
        run_directory,
        sha256_program,
        receipt,
        seal,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use walle_core::capsule::{
        CancellationOwner, CancellationPolicy, CapabilityRequest, ChildProcessCapability,
    };
    use walle_core::supervisor::CgroupV2Plan;
    use walle_core::ResourcePlan;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn capsule(profile: CertificationProfile) -> ExecutionCapsule<'static> {
        ExecutionCapsule {
            run_id: RUN_ID,
            attempt: 1,
            adapter_id: "generic-command-v1",
            adapter_version: "1.0.0",
            workload_id: "seo-avengers-2500",
            source_sha256: SOURCE_SHA,
            profile,
            resources: ResourcePlan::baseline(profile),
            capabilities: CapabilityRequest {
                filesystem: FilesystemCapability::ReadOnlyInputs,
                network: NetworkPolicy::DenyAll,
                network_allowlist: &[],
                child_processes: ChildProcessCapability::Bounded,
                secret_names: &[],
                device_names: &[],
            },
            timeout_ms: 600_000,
            max_stdout_bytes: 64 * 1024 * 1024,
            max_stderr_bytes: 64 * 1024,
            cancellation: CancellationPolicy {
                owner: CancellationOwner::WalleControlPlane,
                grace_ms: 5_000,
            },
        }
    }

    fn plan() -> MicroVmSupervisorPlan<'static> {
        let request = capsule(CertificationProfile::Certification);
        MicroVmSupervisorPlan {
            run_id: RUN_ID,
            workload_id: request.workload_id,
            source_sha256: SOURCE_SHA,
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
                cpu_quota_us: u64::from(request.resources.cpu_cores) * CGROUP_CPU_PERIOD_US,
                cpu_period_us: CGROUP_CPU_PERIOD_US,
                memory_max_bytes: request.resources.memory_mib * 1024 * 1024,
                pids_max: request.resources.pid_limit,
            },
            vcpu_count: request.resources.cpu_cores,
            memory_mib: request.resources.memory_mib,
            scratch_disk_mib: 0,
            filesystem_mode: "READ_ONLY_INPUTS",
            max_stdout_bytes: request.max_stdout_bytes,
            max_stderr_bytes: request.max_stderr_bytes,
            timeout_ms: request.timeout_ms,
            cancellation_grace_ms: request.cancellation.grace_ms,
            rootfs_read_only: true,
            network_interfaces: 0,
            guest_seccomp_required: true,
            guest_kernel_path: "/walle/kernel",
            guest_rootfs_path: "/walle/rootfs",
            guest_config_path: "/walle/firecracker-config.json",
            image_digest_verification_required: true,
            atomic_runtime_materialization_required: true,
            kill_on_timeout_required: true,
            kill_on_cancel_required: true,
            cgroup_cleanup_required: true,
        }
    }

    #[test]
    fn certification_capsule_binds_exactly_to_physical_supervisor_plan() {
        assert!(validate_certification_plan_binding(
            capsule(CertificationProfile::Certification),
            &plan()
        )
        .is_ok());
    }

    #[test]
    fn fast_or_hardened_capsule_cannot_enter_certification_runtime() {
        for profile in [CertificationProfile::Fast, CertificationProfile::Hardened] {
            assert!(matches!(
                validate_certification_plan_binding(capsule(profile), &plan()),
                Err(CertificationRuntimeError::CertificationProfileRequired)
            ));
        }
    }

    #[test]
    fn drifted_supervisor_plan_is_rejected_before_physical_execution() {
        let mut drifted = plan();
        drifted.memory_mib += 1;
        assert!(matches!(
            validate_certification_plan_binding(
                capsule(CertificationProfile::Certification),
                &drifted
            ),
            Err(CertificationRuntimeError::PlanBindingMismatch)
        ));
    }

    #[test]
    fn canonical_certification_capsule_carries_profile_and_identity() {
        let canonical = capsule(CertificationProfile::Certification)
            .canonical_json()
            .expect("canonical capsule");
        assert!(canonical.contains("\"profile\":\"CERTIFICATION\""));
        assert!(canonical.contains(&format!("\"run_id\":\"{RUN_ID}\"")));
        assert!(canonical.contains(&format!("\"source_sha256\":\"{SOURCE_SHA}\"")));
    }
}
