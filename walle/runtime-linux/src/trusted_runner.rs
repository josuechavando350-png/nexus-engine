use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use walle_core::certification::{
    CertificationEvidence, CertificationEvidenceKind, EvidenceAssessment,
};
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::evidence::EvidenceReceipt;
use crate::guest_image::{
    load_and_bind_guest_image_manifest, AdmittedGuestImageIdentity, GuestAgentRootfsBinding,
    GuestImageError, GuestImageManifestSource,
};
use crate::guest_rootfs::{
    verify_guest_agent_in_rootfs, GuestAgentRootfsProvenance, GuestRootfsError,
    GuestRootfsInspectorSource,
};
use crate::guest_workload_rootfs::{
    verify_and_persist_guest_workload_rootfs_provenance, GuestWorkloadRootfsError,
    GuestWorkloadRootfsEvidence,
};
use crate::host::LinuxMicroVmHostConfig;
use crate::runner::{
    execute_linux_supervisor_with_admitted_guest_image, LinuxEvidencedRunError,
    LinuxSupervisorEvidenceBundle,
};
use crate::supervisor_evidence::EvidencedSupervisorResult;
use crate::trusted_guest_evidence::{
    persist_trusted_guest_proof_evidence, TrustedGuestEvidenceError, TrustedGuestProofEvidence,
};
use crate::workload_bound_guest_evidence::{
    persist_workload_bound_guest_proof_evidence, WorkloadBoundGuestEvidenceError,
    WorkloadBoundGuestProofEvidence,
};

#[derive(Debug)]
pub enum TrustedGuestRunError {
    GuestImage(GuestImageError),
    GuestRootfs(GuestRootfsError),
    GuestWorkloadRootfs(GuestWorkloadRootfsError),
    Runner(LinuxEvidencedRunError),
    TrustedEvidence(TrustedGuestEvidenceError),
    WorkloadBoundEvidence(WorkloadBoundGuestEvidenceError),
}

impl Display for TrustedGuestRunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::GuestImage(error) => Display::fmt(error, formatter),
            Self::GuestRootfs(error) => Display::fmt(error, formatter),
            Self::GuestWorkloadRootfs(error) => Display::fmt(error, formatter),
            Self::Runner(error) => Display::fmt(error, formatter),
            Self::TrustedEvidence(error) => Display::fmt(error, formatter),
            Self::WorkloadBoundEvidence(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for TrustedGuestRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::GuestImage(error) => Some(error),
            Self::GuestRootfs(error) => Some(error),
            Self::GuestWorkloadRootfs(error) => Some(error),
            Self::Runner(error) => Some(error),
            Self::TrustedEvidence(error) => Some(error),
            Self::WorkloadBoundEvidence(error) => Some(error),
        }
    }
}

impl From<GuestImageError> for TrustedGuestRunError {
    fn from(value: GuestImageError) -> Self {
        Self::GuestImage(value)
    }
}

impl From<GuestRootfsError> for TrustedGuestRunError {
    fn from(value: GuestRootfsError) -> Self {
        Self::GuestRootfs(value)
    }
}

impl From<GuestWorkloadRootfsError> for TrustedGuestRunError {
    fn from(value: GuestWorkloadRootfsError) -> Self {
        Self::GuestWorkloadRootfs(value)
    }
}

impl From<LinuxEvidencedRunError> for TrustedGuestRunError {
    fn from(value: LinuxEvidencedRunError) -> Self {
        Self::Runner(value)
    }
}

impl From<TrustedGuestEvidenceError> for TrustedGuestRunError {
    fn from(value: TrustedGuestEvidenceError) -> Self {
        Self::TrustedEvidence(value)
    }
}

impl From<WorkloadBoundGuestEvidenceError> for TrustedGuestRunError {
    fn from(value: WorkloadBoundGuestEvidenceError) -> Self {
        Self::WorkloadBoundEvidence(value)
    }
}

/// Result of a concrete Linux/Firecracker run whose kernel/rootfs identities
/// were first bound to a host-controlled guest image manifest, whose exact
/// guest-agent bytes were verified at the mandatory init path, and whose exact
/// workload executable was measured from the same admitted rootfs before the
/// microVM lifecycle began.
///
/// The workload measurement is independently sealed before execution and binds
/// the run/source, rootfs digest, workload id/path, exact workload SHA-256 and
/// pinned read-only inspector identity. After physical guest proofs are derived,
/// WALLE re-verifies both chains and emits a third chain whose only certifying
/// guest-proof receipts cryptographically reference that pre-execution workload
/// provenance. Raw guest proofs remain inspectable but are never projected into
/// final certification without this workload binding.
#[derive(Debug)]
pub struct TrustedGuestEvidenceBundle {
    guest_image_identity: AdmittedGuestImageIdentity,
    guest_agent_rootfs_provenance: GuestAgentRootfsProvenance,
    guest_workload_rootfs_evidence: GuestWorkloadRootfsEvidence,
    execution: LinuxSupervisorEvidenceBundle,
    trusted_guest_proofs: TrustedGuestProofEvidence,
    workload_bound_guest_proofs: WorkloadBoundGuestProofEvidence,
}

impl TrustedGuestEvidenceBundle {
    pub fn guest_image_identity(&self) -> &AdmittedGuestImageIdentity {
        &self.guest_image_identity
    }

    pub fn guest_agent_rootfs_provenance(&self) -> &GuestAgentRootfsProvenance {
        &self.guest_agent_rootfs_provenance
    }

    pub fn guest_workload_rootfs_evidence(&self) -> &GuestWorkloadRootfsEvidence {
        &self.guest_workload_rootfs_evidence
    }

    pub fn guest_image_identity_receipt(&self) -> Option<&EvidenceReceipt> {
        self.execution
            .supervisor()
            .guest_image_identity_receipt
            .as_ref()
    }

    pub fn trusted_guest_proofs(&self) -> &TrustedGuestProofEvidence {
        &self.trusted_guest_proofs
    }

    pub fn workload_bound_guest_proofs(&self) -> &WorkloadBoundGuestProofEvidence {
        &self.workload_bound_guest_proofs
    }

    pub fn supervisor(&self) -> &EvidencedSupervisorResult {
        self.execution.supervisor()
    }

    pub fn certification_evidence(&self) -> Vec<CertificationEvidence<'_>> {
        let mut projected = self.execution.certification_evidence();
        let seal = &self.execution.supervisor().seal;

        if let Some(receipt) = self.workload_bound_guest_proofs.network_isolation_receipt() {
            projected.push(CertificationEvidence {
                kind: CertificationEvidenceKind::NetworkIsolation,
                run_id: &seal.run_id,
                source_sha256: &seal.source_sha256,
                receipt_sha256: &receipt.receipt_sha256,
                assessment: EvidenceAssessment::Proven,
            });
        }
        if let Some(receipt) = self.workload_bound_guest_proofs.guest_seccomp_receipt() {
            projected.push(CertificationEvidence {
                kind: CertificationEvidenceKind::GuestSeccomp,
                run_id: &seal.run_id,
                source_sha256: &seal.source_sha256,
                receipt_sha256: &receipt.receipt_sha256,
                assessment: EvidenceAssessment::Proven,
            });
        }
        if let Some(receipt) = self
            .workload_bound_guest_proofs
            .guest_completion_ack_receipt()
        {
            projected.push(CertificationEvidence {
                kind: CertificationEvidenceKind::GuestCompletionAck,
                run_id: &seal.run_id,
                source_sha256: &seal.source_sha256,
                receipt_sha256: &receipt.receipt_sha256,
                assessment: EvidenceAssessment::Proven,
            });
        }

        projected
    }
}

/// Admits a trusted guest image, proves the mandatory guest agent and selected
/// workload executable from the exact admitted rootfs, durably seals the
/// workload measurement, and only then starts the concrete Linux supervisor.
///
/// The configured manifest SHA and debugfs SHA are host/operator inputs. Both
/// the agent and workload inspections resolve the rootfs without symlinks, use
/// a pinned root-owned read-only inspector and hash the exact rootfs before and
/// after inspection. The workload path is derived only from the validated plan
/// workload id, matching the path injected into the kernel init argv by the
/// Firecracker configuration builder.
///
/// After execution, the primary supervisor chain and raw trusted guest proof
/// chain are re-verified. A final workload-bound proof chain references both the
/// raw proof receipt/seal and the pre-execution workload provenance receipt/seal.
/// Only receipts from this final bound chain are projected as network isolation,
/// guest seccomp or completion evidence. Missing physical serial evidence still
/// projects no guest proof at all.
pub fn execute_linux_supervisor_with_trusted_guest_image(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    guest_image_manifest: &GuestImageManifestSource,
    guest_rootfs_inspector: &GuestRootfsInspectorSource,
) -> Result<TrustedGuestEvidenceBundle, TrustedGuestRunError> {
    let evidence_root = evidence_root.into();
    let proof_sha256_program = host_config.sha256_program.clone();
    let mut guest_image_identity = load_and_bind_guest_image_manifest(
        guest_image_manifest,
        host_config.sha256_program.clone(),
        plan,
    )?;
    let guest_agent_rootfs_provenance = verify_guest_agent_in_rootfs(
        guest_rootfs_inspector,
        host_config.sha256_program.clone(),
        plan,
        &guest_image_identity,
    )?;
    guest_image_identity.bind_guest_agent_rootfs_provenance(GuestAgentRootfsBinding {
        debugfs_sha256: guest_agent_rootfs_provenance.debugfs_sha256.clone(),
        guest_agent_bytes: guest_agent_rootfs_provenance.guest_agent_bytes,
        guest_agent_path: guest_agent_rootfs_provenance.guest_agent_path.clone(),
        guest_agent_sha256: guest_agent_rootfs_provenance.guest_agent_sha256.clone(),
        rootfs_sha256: guest_agent_rootfs_provenance.rootfs_sha256.clone(),
    })?;

    let guest_workload_rootfs_evidence = verify_and_persist_guest_workload_rootfs_provenance(
        &evidence_root,
        host_config.sha256_program.clone(),
        guest_rootfs_inspector,
        plan,
        &guest_image_identity,
    )?;

    let execution = execute_linux_supervisor_with_admitted_guest_image(
        host_config,
        evidence_root.clone(),
        plan,
        &guest_image_identity,
    )?;
    let trusted_guest_proofs = persist_trusted_guest_proof_evidence(
        &evidence_root,
        proof_sha256_program.clone(),
        plan,
        &guest_image_identity,
        &execution.supervisor().seal,
    )?;
    let workload_bound_guest_proofs = persist_workload_bound_guest_proof_evidence(
        &evidence_root,
        proof_sha256_program,
        plan,
        &guest_workload_rootfs_evidence,
        &trusted_guest_proofs,
    )?;

    Ok(TrustedGuestEvidenceBundle {
        guest_image_identity,
        guest_agent_rootfs_provenance,
        guest_workload_rootfs_evidence,
        execution,
        trusted_guest_proofs,
        workload_bound_guest_proofs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trusted_guest_error_preserves_guest_image_source() {
        let error = TrustedGuestRunError::GuestImage(GuestImageError::PlanImageMismatch);
        assert_eq!(
            error.to_string(),
            "supervisor kernel/rootfs identities do not match the admitted guest image"
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn trusted_guest_error_preserves_rootfs_provenance_source() {
        let error = TrustedGuestRunError::GuestRootfs(GuestRootfsError::GuestAgentNotExecutable);
        assert_eq!(
            error.to_string(),
            "guest-agent path inside rootfs is not executable"
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn trusted_guest_error_preserves_workload_rootfs_source() {
        let error = TrustedGuestRunError::GuestWorkloadRootfs(
            GuestWorkloadRootfsError::WorkloadNotExecutable,
        );
        assert_eq!(
            error.to_string(),
            "guest workload path inside rootfs is not executable"
        );
        assert!(error.source().is_some());
    }

    #[test]
    fn trusted_guest_binding_error_is_explicit_without_a_nested_source() {
        let error = TrustedGuestRunError::TrustedEvidence(
            TrustedGuestEvidenceError::PrimaryEvidenceBindingMismatch,
        );
        assert_eq!(
            error.to_string(),
            "primary supervisor evidence seal is not bound to the trusted guest run"
        );
        assert!(error.source().is_some());
        assert!(error
            .source()
            .expect("trusted evidence error")
            .source()
            .is_none());
    }
}
