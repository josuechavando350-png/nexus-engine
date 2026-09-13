use std::error::Error;
use std::fmt::{Display, Formatter};
use std::path::PathBuf;

use walle_core::certification::{
    CertificationEvidence, CertificationEvidenceKind, EvidenceAssessment,
};
use walle_core::supervisor::MicroVmSupervisorPlan;
use walle_core::supervisor_lifecycle::{SupervisorLifecycleReason, SupervisorTerminalStatus};

use crate::host::{LinuxHostError, LinuxMicroVmHost, LinuxMicroVmHostConfig};
use crate::supervisor_evidence::{
    EvidencedSupervisorResult, SupervisorEvidenceError, SupervisorEvidenceRun,
};

#[derive(Debug)]
pub enum LinuxEvidencedRunError {
    Host(LinuxHostError),
    Evidence(SupervisorEvidenceError),
}

impl Display for LinuxEvidencedRunError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Host(error) => Display::fmt(error, formatter),
            Self::Evidence(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for LinuxEvidencedRunError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Host(error) => Some(error),
            Self::Evidence(error) => Some(error),
        }
    }
}

impl From<LinuxHostError> for LinuxEvidencedRunError {
    fn from(value: LinuxHostError) -> Self {
        Self::Host(value)
    }
}

impl From<SupervisorEvidenceError> for LinuxEvidencedRunError {
    fn from(value: SupervisorEvidenceError) -> Self {
        Self::Evidence(value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnedCertificationEvidence {
    kind: CertificationEvidenceKind,
    run_id: String,
    source_sha256: String,
    receipt_sha256: String,
    assessment: EvidenceAssessment,
}

impl OwnedCertificationEvidence {
    pub fn as_borrowed(&self) -> CertificationEvidence<'_> {
        CertificationEvidence {
            kind: self.kind,
            run_id: &self.run_id,
            source_sha256: &self.source_sha256,
            receipt_sha256: &self.receipt_sha256,
            assessment: self.assessment,
        }
    }
}

/// A concrete Linux supervisor execution plus only the certification evidence
/// this layer can actually prove from that execution.
///
/// `RUNTIME_BINARY_IDENTITY` and `IMAGE_INTEGRITY` are emitted only when the
/// evidence chain contains the distinct receipts created after the concrete
/// Linux host successfully completed its staged SHA-256 materialization step.
/// `LIFECYCLE` and `DURABLE_EVIDENCE_CHAIN` retain their existing independent
/// semantics. This layer still does not manufacture source identity,
/// host-isolation, microVM-boot, resource-control, network, guest-seccomp,
/// guest-ACK or output-bound proof.
#[derive(Debug)]
pub struct LinuxSupervisorEvidenceBundle {
    supervisor: EvidencedSupervisorResult,
    certification_evidence: Vec<OwnedCertificationEvidence>,
}

impl LinuxSupervisorEvidenceBundle {
    pub fn supervisor(&self) -> &EvidencedSupervisorResult {
        &self.supervisor
    }

    pub fn certification_evidence(&self) -> Vec<CertificationEvidence<'_>> {
        self.certification_evidence
            .iter()
            .map(OwnedCertificationEvidence::as_borrowed)
            .collect()
    }
}

/// Executes one exact supervisor plan through the concrete Linux host while
/// binding the run to the durable supervisor evidence chain.
///
/// The Linux host is constructed first so an invalid trusted-runtime
/// configuration cannot create an evidence directory that looks like an
/// attempted workload run. Once construction succeeds, `SupervisorEvidenceRun`
/// persists the canonical plan before any workload-side lifecycle effect,
/// executes the existing fail-closed supervisor, persists only identity proof
/// that the concrete host actually established, persists the terminal result,
/// seals the chain, and verifies the durable bytes before this function can
/// return success.
///
/// This function does not promote a successful lifecycle into WALLE
/// certification. KVM/Firecracker boot, guest completion, resource-control and
/// other required certification evidence remain separate proof obligations.
pub fn execute_linux_supervisor_with_evidence(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<EvidencedSupervisorResult, LinuxEvidencedRunError> {
    let evidence_hasher = host_config.sha256_program.clone();
    let mut host = LinuxMicroVmHost::new(host_config)?;
    let mut evidence = SupervisorEvidenceRun::begin(evidence_root, evidence_hasher, plan)?;
    evidence.execute(&mut host, plan).map_err(Into::into)
}

/// Executes the same verified Linux supervisor path and projects only proof
/// categories backed by distinct verified receipts from that run.
///
/// Runtime/image identity is never inferred from the supervisor plan alone: the
/// corresponding evidence is absent unless concrete Linux materialization
/// succeeded and its receipts survived sealing and chain verification. The
/// durable-chain assessment is `PROVEN` only because the wrapped execution
/// cannot return until `SupervisorEvidenceRun` has re-read and verified the
/// sealed receipt chain.
pub fn execute_linux_supervisor_with_certification_evidence(
    host_config: LinuxMicroVmHostConfig,
    evidence_root: impl Into<PathBuf>,
    plan: &MicroVmSupervisorPlan<'_>,
) -> Result<LinuxSupervisorEvidenceBundle, LinuxEvidencedRunError> {
    let supervisor = execute_linux_supervisor_with_evidence(host_config, evidence_root, plan)?;
    let certification_evidence = project_certification_evidence(&supervisor);
    Ok(LinuxSupervisorEvidenceBundle {
        supervisor,
        certification_evidence,
    })
}

fn project_certification_evidence(
    result: &EvidencedSupervisorResult,
) -> Vec<OwnedCertificationEvidence> {
    let mut projected = Vec::with_capacity(4);

    if let Some(receipt) = result.runtime_binary_identity_receipt.as_ref() {
        projected.push(OwnedCertificationEvidence {
            kind: CertificationEvidenceKind::RuntimeBinaryIdentity,
            run_id: result.seal.run_id.clone(),
            source_sha256: result.seal.source_sha256.clone(),
            receipt_sha256: receipt.receipt_sha256.clone(),
            assessment: EvidenceAssessment::Proven,
        });
    }

    if let Some(receipt) = result.image_integrity_receipt.as_ref() {
        projected.push(OwnedCertificationEvidence {
            kind: CertificationEvidenceKind::ImageIntegrity,
            run_id: result.seal.run_id.clone(),
            source_sha256: result.seal.source_sha256.clone(),
            receipt_sha256: receipt.receipt_sha256.clone(),
            assessment: EvidenceAssessment::Proven,
        });
    }

    let lifecycle_assessment = if result.lifecycle.status == SupervisorTerminalStatus::Exited
        && result.lifecycle.reason == SupervisorLifecycleReason::ProcessExited
        && result.lifecycle.exit_code == Some(0)
    {
        EvidenceAssessment::Proven
    } else {
        EvidenceAssessment::Blocked
    };

    projected.push(OwnedCertificationEvidence {
        kind: CertificationEvidenceKind::Lifecycle,
        run_id: result.seal.run_id.clone(),
        source_sha256: result.seal.source_sha256.clone(),
        receipt_sha256: result.lifecycle_receipt.receipt_sha256.clone(),
        assessment: lifecycle_assessment,
    });
    projected.push(OwnedCertificationEvidence {
        kind: CertificationEvidenceKind::DurableEvidenceChain,
        run_id: result.seal.run_id.clone(),
        source_sha256: result.seal.source_sha256.clone(),
        receipt_sha256: result.plan_receipt.receipt_sha256.clone(),
        assessment: EvidenceAssessment::Proven,
    });

    projected
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::{EvidenceReceipt, EvidenceSeal};
    use walle_core::supervisor_lifecycle::{ContainmentMode, SupervisorLifecycleResult};

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const PLAN_RECEIPT_SHA: &str =
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const RUNTIME_RECEIPT_SHA: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const IMAGE_RECEIPT_SHA: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const LIFECYCLE_RECEIPT_SHA: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

    fn receipt(sequence: u64, kind: &str, sha256: &str) -> EvidenceReceipt {
        EvidenceReceipt {
            sequence,
            kind: kind.to_owned(),
            payload_file: format!("{sequence:06}.payload"),
            payload_sha256: format!(
                "sha256:{}",
                char::from_digit(u32::try_from((sequence % 15) + 1).expect("nibble"), 16)
                    .expect("hex nibble")
                    .to_string()
                    .repeat(64)
            ),
            payload_bytes: 128,
            previous_receipt_sha256: if sequence == 1 {
                None
            } else {
                Some(PLAN_RECEIPT_SHA.to_owned())
            },
            receipt_file: format!("{sequence:06}.receipt.json"),
            receipt_sha256: sha256.to_owned(),
        }
    }

    fn result_with_identity(lifecycle: SupervisorLifecycleResult) -> EvidencedSupervisorResult {
        EvidencedSupervisorResult {
            lifecycle,
            plan_receipt: receipt(1, "supervisor-plan", PLAN_RECEIPT_SHA),
            runtime_binary_identity_receipt: Some(receipt(
                2,
                "runtime-binary-identity",
                RUNTIME_RECEIPT_SHA,
            )),
            image_integrity_receipt: Some(receipt(3, "image-integrity", IMAGE_RECEIPT_SHA)),
            lifecycle_receipt: receipt(4, "supervisor-lifecycle-result", LIFECYCLE_RECEIPT_SHA),
            seal: EvidenceSeal {
                run_id: RUN_ID.to_owned(),
                source_sha256: SOURCE_SHA.to_owned(),
                entry_count: 4,
                head_receipt_sha256: LIFECYCLE_RECEIPT_SHA.to_owned(),
                seal_file: "seal.json".to_owned(),
                seal_sha256:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_owned(),
            },
        }
    }

    fn result_without_identity(lifecycle: SupervisorLifecycleResult) -> EvidencedSupervisorResult {
        EvidencedSupervisorResult {
            lifecycle,
            plan_receipt: receipt(1, "supervisor-plan", PLAN_RECEIPT_SHA),
            runtime_binary_identity_receipt: None,
            image_integrity_receipt: None,
            lifecycle_receipt: receipt(2, "supervisor-lifecycle-result", LIFECYCLE_RECEIPT_SHA),
            seal: EvidenceSeal {
                run_id: RUN_ID.to_owned(),
                source_sha256: SOURCE_SHA.to_owned(),
                entry_count: 2,
                head_receipt_sha256: LIFECYCLE_RECEIPT_SHA.to_owned(),
                seal_file: "seal.json".to_owned(),
                seal_sha256:
                    "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
                        .to_owned(),
            },
        }
    }

    fn clean_exit() -> SupervisorLifecycleResult {
        SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(0),
            containment: None,
        }
    }

    #[test]
    fn successful_materialized_supervisor_projects_four_distinct_verified_categories() {
        let result = result_with_identity(clean_exit());
        let projected = project_certification_evidence(&result);

        assert_eq!(projected.len(), 4);
        assert_eq!(
            projected[0].kind,
            CertificationEvidenceKind::RuntimeBinaryIdentity
        );
        assert_eq!(projected[0].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[0].receipt_sha256, RUNTIME_RECEIPT_SHA);
        assert_eq!(projected[1].kind, CertificationEvidenceKind::ImageIntegrity);
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[1].receipt_sha256, IMAGE_RECEIPT_SHA);
        assert_eq!(projected[2].kind, CertificationEvidenceKind::Lifecycle);
        assert_eq!(projected[2].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[2].receipt_sha256, LIFECYCLE_RECEIPT_SHA);
        assert_eq!(
            projected[3].kind,
            CertificationEvidenceKind::DurableEvidenceChain
        );
        assert_eq!(projected[3].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[3].receipt_sha256, PLAN_RECEIPT_SHA);
        for (index, evidence) in projected.iter().enumerate() {
            assert!(projected[..index]
                .iter()
                .all(|earlier| earlier.receipt_sha256 != evidence.receipt_sha256));
        }
        assert!(projected.iter().all(|item| item.run_id == RUN_ID));
        assert!(projected
            .iter()
            .all(|item| item.source_sha256 == SOURCE_SHA));
    }

    #[test]
    fn missing_materialization_receipts_cannot_be_inferred_from_plan() {
        let result = result_without_identity(clean_exit());
        let projected = project_certification_evidence(&result);

        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0].kind, CertificationEvidenceKind::Lifecycle);
        assert_eq!(
            projected[1].kind,
            CertificationEvidenceKind::DurableEvidenceChain
        );
        assert!(projected
            .iter()
            .all(|item| item.kind != CertificationEvidenceKind::RuntimeBinaryIdentity));
        assert!(projected
            .iter()
            .all(|item| item.kind != CertificationEvidenceKind::ImageIntegrity));
    }

    #[test]
    fn nonzero_exit_blocks_lifecycle_without_downgrading_verified_identities_or_chain() {
        let result = result_with_identity(SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(9),
            containment: None,
        });
        let projected = project_certification_evidence(&result);

        assert_eq!(projected[0].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[2].assessment, EvidenceAssessment::Blocked);
        assert_eq!(projected[3].assessment, EvidenceAssessment::Proven);
    }

    #[test]
    fn timeout_or_containment_terminal_cannot_become_proven_lifecycle() {
        let result = result_with_identity(SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::TimedOut,
            reason: SupervisorLifecycleReason::TimeoutContained,
            exit_code: None,
            containment: Some(ContainmentMode::Forced),
        });
        let projected = project_certification_evidence(&result);

        assert_eq!(projected[0].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[2].assessment, EvidenceAssessment::Blocked);
        assert_eq!(projected[3].assessment, EvidenceAssessment::Proven);
    }

    #[test]
    fn runner_error_preserves_host_source() {
        let error = LinuxEvidencedRunError::Host(LinuxHostError::InvalidFirecrackerSha256);
        assert_eq!(
            error.to_string(),
            "Firecracker digest is not a canonical lowercase sha256"
        );
        assert!(error.source().is_some());
    }
}
