use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::{Path, PathBuf};

use walle_core::is_valid_sha256;
use walle_core::supervisor::MicroVmSupervisorPlan;

use crate::artifact::SystemSha256;
use crate::evidence::{
    verify_evidence_chain, EvidenceError, EvidenceReceipt, EvidenceRun, EvidenceSeal,
};
use crate::firecracker::GUEST_WORKLOAD_DIRECTORY;
use crate::guest_workload_rootfs::{GuestWorkloadRootfsError, GuestWorkloadRootfsEvidence};
use crate::safe_fs::{SecureDirectory, SecureFsError};
use crate::trusted_guest_evidence::{
    TrustedGuestProofEvidence, GUEST_COMPLETION_ACK_EVIDENCE_KIND, GUEST_SECCOMP_EVIDENCE_KIND,
    NETWORK_ISOLATION_EVIDENCE_KIND, TRUSTED_GUEST_EVIDENCE_DIRECTORY,
};

pub const WORKLOAD_BOUND_GUEST_EVIDENCE_DIRECTORY: &str = "workload-bound-guest-proofs";
const WORKLOAD_BOUND_VERIFICATION: &str =
    "VERIFIED_GUEST_PROOF_BOUND_TO_PREEXECUTION_ROOTFS_WORKLOAD_IDENTITY";

#[derive(Debug, Default)]
pub struct WorkloadBoundGuestProofEvidence {
    network_isolation_receipt: Option<EvidenceReceipt>,
    guest_seccomp_receipt: Option<EvidenceReceipt>,
    guest_completion_ack_receipt: Option<EvidenceReceipt>,
    seal: Option<EvidenceSeal>,
}

impl WorkloadBoundGuestProofEvidence {
    pub fn network_isolation_receipt(&self) -> Option<&EvidenceReceipt> {
        self.network_isolation_receipt.as_ref()
    }

    pub fn guest_seccomp_receipt(&self) -> Option<&EvidenceReceipt> {
        self.guest_seccomp_receipt.as_ref()
    }

    pub fn guest_completion_ack_receipt(&self) -> Option<&EvidenceReceipt> {
        self.guest_completion_ack_receipt.as_ref()
    }

    pub fn seal(&self) -> Option<&EvidenceSeal> {
        self.seal.as_ref()
    }

    pub fn is_empty(&self) -> bool {
        self.network_isolation_receipt.is_none()
            && self.guest_seccomp_receipt.is_none()
            && self.guest_completion_ack_receipt.is_none()
    }
}

#[derive(Debug)]
pub enum WorkloadBoundGuestEvidenceError {
    WorkloadProvenance(GuestWorkloadRootfsError),
    WorkloadBindingMismatch,
    BaseProofSealMissing,
    BaseProofBindingMismatch,
    BaseProofKindMismatch,
    Evidence(EvidenceError),
    SecureFs(SecureFsError),
}

impl Display for WorkloadBoundGuestEvidenceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WorkloadProvenance(error) => Display::fmt(error, formatter),
            Self::WorkloadBindingMismatch => formatter.write_str(
                "durable guest-workload provenance is not bound to the supervisor run/rootfs/workload",
            ),
            Self::BaseProofSealMissing => formatter.write_str(
                "trusted guest proofs contain receipts without a sealed evidence chain",
            ),
            Self::BaseProofBindingMismatch => formatter.write_str(
                "trusted guest proof chain is not bound to the same run/source as workload provenance",
            ),
            Self::BaseProofKindMismatch => formatter.write_str(
                "trusted guest proof receipt kind does not match its projected certification category",
            ),
            Self::Evidence(error) => Display::fmt(error, formatter),
            Self::SecureFs(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for WorkloadBoundGuestEvidenceError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::WorkloadProvenance(error) => Some(error),
            Self::Evidence(error) => Some(error),
            Self::SecureFs(error) => Some(error),
            Self::WorkloadBindingMismatch
            | Self::BaseProofSealMissing
            | Self::BaseProofBindingMismatch
            | Self::BaseProofKindMismatch => None,
        }
    }
}

impl From<GuestWorkloadRootfsError> for WorkloadBoundGuestEvidenceError {
    fn from(value: GuestWorkloadRootfsError) -> Self {
        Self::WorkloadProvenance(value)
    }
}

impl From<EvidenceError> for WorkloadBoundGuestEvidenceError {
    fn from(value: EvidenceError) -> Self {
        Self::Evidence(value)
    }
}

impl From<SecureFsError> for WorkloadBoundGuestEvidenceError {
    fn from(value: SecureFsError) -> Self {
        Self::SecureFs(value)
    }
}

/// Re-verifies both durable chains and creates the only guest-proof receipts
/// that the final certification projection may consume. Every projected guest
/// category is now cryptographically linked to the pre-execution measurement
/// of the exact executable selected by `/usr/libexec/walle/workloads/<id>`.
pub fn persist_workload_bound_guest_proof_evidence(
    evidence_root: &Path,
    sha256_program: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
    workload_evidence: &GuestWorkloadRootfsEvidence,
    base_proofs: &TrustedGuestProofEvidence,
) -> Result<WorkloadBoundGuestProofEvidence, WorkloadBoundGuestEvidenceError> {
    workload_evidence.verify()?;
    validate_workload_binding(plan, workload_evidence)?;

    if base_proofs.is_empty() {
        if base_proofs.seal().is_some() {
            return Err(WorkloadBoundGuestEvidenceError::BaseProofBindingMismatch);
        }
        return Ok(WorkloadBoundGuestProofEvidence::default());
    }

    let base_seal = base_proofs
        .seal()
        .ok_or(WorkloadBoundGuestEvidenceError::BaseProofSealMissing)?;
    if base_seal.run_id != plan.run_id || base_seal.source_sha256 != plan.source_sha256 {
        return Err(WorkloadBoundGuestEvidenceError::BaseProofBindingMismatch);
    }

    let mut base_receipts = Vec::with_capacity(3);
    if let Some(receipt) = base_proofs.network_isolation_receipt() {
        validate_kind(receipt, NETWORK_ISOLATION_EVIDENCE_KIND)?;
        base_receipts.push(receipt.clone());
    }
    if let Some(receipt) = base_proofs.guest_seccomp_receipt() {
        validate_kind(receipt, GUEST_SECCOMP_EVIDENCE_KIND)?;
        base_receipts.push(receipt.clone());
    }
    if let Some(receipt) = base_proofs.guest_completion_ack_receipt() {
        validate_kind(receipt, GUEST_COMPLETION_ACK_EVIDENCE_KIND)?;
        base_receipts.push(receipt.clone());
    }

    let sha256_program = sha256_program.into();
    let hasher = SystemSha256::new(sha256_program.clone()).map_err(EvidenceError::from)?;
    let base_run_directory = evidence_root
        .join(TRUSTED_GUEST_EVIDENCE_DIRECTORY)
        .join(plan.run_id);
    verify_evidence_chain(&base_run_directory, &base_receipts, base_seal, &hasher)?;

    let root = SecureDirectory::open(evidence_root.to_path_buf())?;
    root.validate_trusted()?;
    let bound_root =
        root.create_child_directory(WORKLOAD_BOUND_GUEST_EVIDENCE_DIRECTORY, 0o700, true)?;
    bound_root.validate_trusted()?;

    let mut run = EvidenceRun::begin(
        bound_root.path().to_path_buf(),
        sha256_program.clone(),
        plan.run_id,
        plan.source_sha256,
    )?;
    let mut bound_receipts = Vec::with_capacity(3);

    let network_isolation_receipt = match base_proofs.network_isolation_receipt() {
        Some(base) => {
            let payload = binding_payload(plan, workload_evidence, base_seal, base);
            let receipt = run.append(NETWORK_ISOLATION_EVIDENCE_KIND, payload.as_bytes())?;
            bound_receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };
    let guest_seccomp_receipt = match base_proofs.guest_seccomp_receipt() {
        Some(base) => {
            let payload = binding_payload(plan, workload_evidence, base_seal, base);
            let receipt = run.append(GUEST_SECCOMP_EVIDENCE_KIND, payload.as_bytes())?;
            bound_receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };
    let guest_completion_ack_receipt = match base_proofs.guest_completion_ack_receipt() {
        Some(base) => {
            let payload = binding_payload(plan, workload_evidence, base_seal, base);
            let receipt = run.append(GUEST_COMPLETION_ACK_EVIDENCE_KIND, payload.as_bytes())?;
            bound_receipts.push(receipt.clone());
            Some(receipt)
        }
        None => None,
    };

    let seal = run.seal()?;
    let hasher = SystemSha256::new(sha256_program).map_err(EvidenceError::from)?;
    verify_evidence_chain(run.path(), &bound_receipts, &seal, &hasher)?;

    Ok(WorkloadBoundGuestProofEvidence {
        network_isolation_receipt,
        guest_seccomp_receipt,
        guest_completion_ack_receipt,
        seal: Some(seal),
    })
}

fn validate_workload_binding(
    plan: &MicroVmSupervisorPlan<'_>,
    workload_evidence: &GuestWorkloadRootfsEvidence,
) -> Result<(), WorkloadBoundGuestEvidenceError> {
    let provenance = workload_evidence.provenance();
    let expected_path = format!("{GUEST_WORKLOAD_DIRECTORY}/{}", plan.workload_id);
    let seal = workload_evidence.seal();
    let receipt = workload_evidence.receipt();
    let matches = provenance.run_id() == plan.run_id
        && provenance.source_sha256() == plan.source_sha256
        && provenance.rootfs_sha256() == plan.rootfs_sha256
        && provenance.workload_id() == plan.workload_id
        && provenance.workload_path() == expected_path
        && provenance.workload_bytes() > 0
        && is_valid_sha256(provenance.debugfs_sha256())
        && is_valid_sha256(provenance.workload_sha256())
        && seal.run_id == plan.run_id
        && seal.source_sha256 == plan.source_sha256
        && receipt.kind == crate::guest_workload_rootfs::GUEST_WORKLOAD_ROOTFS_EVIDENCE_KIND;
    if matches {
        Ok(())
    } else {
        Err(WorkloadBoundGuestEvidenceError::WorkloadBindingMismatch)
    }
}

fn validate_kind(
    receipt: &EvidenceReceipt,
    expected: &str,
) -> Result<(), WorkloadBoundGuestEvidenceError> {
    if receipt.kind == expected {
        Ok(())
    } else {
        Err(WorkloadBoundGuestEvidenceError::BaseProofKindMismatch)
    }
}

fn binding_payload(
    plan: &MicroVmSupervisorPlan<'_>,
    workload_evidence: &GuestWorkloadRootfsEvidence,
    base_seal: &EvidenceSeal,
    base_receipt: &EvidenceReceipt,
) -> String {
    let provenance = workload_evidence.provenance();
    format!(
        concat!(
            "{{",
            "\"base_evidence_kind\":\"{}\",",
            "\"base_proof_receipt_sha256\":\"{}\",",
            "\"base_proof_seal_sha256\":\"{}\",",
            "\"debugfs_sha256\":\"{}\",",
            "\"rootfs_sha256\":\"{}\",",
            "\"run_id\":\"{}\",",
            "\"source_sha256\":\"{}\",",
            "\"verification\":\"{}\",",
            "\"workload_bytes\":{},",
            "\"workload_id\":\"{}\",",
            "\"workload_path\":\"{}\",",
            "\"workload_provenance_receipt_sha256\":\"{}\",",
            "\"workload_provenance_seal_sha256\":\"{}\",",
            "\"workload_sha256\":\"{}\"",
            "}}"
        ),
        base_receipt.kind,
        base_receipt.receipt_sha256,
        base_seal.seal_sha256,
        provenance.debugfs_sha256(),
        provenance.rootfs_sha256(),
        plan.run_id,
        plan.source_sha256,
        WORKLOAD_BOUND_VERIFICATION,
        provenance.workload_bytes(),
        provenance.workload_id(),
        provenance.workload_path(),
        workload_evidence.receipt().receipt_sha256,
        workload_evidence.seal().seal_sha256,
        provenance.workload_sha256(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_base_proofs_are_not_promoted() {
        let base = TrustedGuestProofEvidence::default();
        assert!(base.is_empty());
        assert!(base.seal().is_none());
    }

    #[test]
    fn mismatched_kind_is_rejected_before_projection() {
        let receipt = EvidenceReceipt {
            sequence: 1,
            kind: "guest-seccomp".to_owned(),
            payload_file: "000001.payload".to_owned(),
            payload_sha256:
                "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
            payload_bytes: 128,
            previous_receipt_sha256: None,
            receipt_file: "000001.receipt.json".to_owned(),
            receipt_sha256:
                "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_owned(),
        };
        assert!(matches!(
            validate_kind(&receipt, NETWORK_ISOLATION_EVIDENCE_KIND),
            Err(WorkloadBoundGuestEvidenceError::BaseProofKindMismatch)
        ));
    }
}
