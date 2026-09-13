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

/// A concrete Linux supervisor execution plus the certification evidence that
/// this layer can actually prove from that execution.
///
/// Deliberately emits only `LIFECYCLE` and `DURABLE_EVIDENCE_CHAIN`. It does not
/// manufacture host-isolation, microVM-boot, guest-ACK, guest-seccomp, network,
/// output-bound, image-integrity or source-identity proof. Those remain separate
/// obligations at the final certification boundary.
#[derive(Debug)]
pub struct LinuxSupervisorEvidenceBundle {
    supervisor: EvidencedSupervisorResult,
    certification_evidence: [OwnedCertificationEvidence; 2],
}

impl LinuxSupervisorEvidenceBundle {
    pub fn supervisor(&self) -> &EvidencedSupervisorResult {
        &self.supervisor
    }

    pub fn certification_evidence(&self) -> [CertificationEvidence<'_>; 2] {
        [
            self.certification_evidence[0].as_borrowed(),
            self.certification_evidence[1].as_borrowed(),
        ]
    }
}

/// Executes one exact supervisor plan through the concrete Linux host while
/// binding the run to the durable supervisor evidence chain.
///
/// The Linux host is constructed first so an invalid trusted-runtime
/// configuration cannot create an evidence directory that looks like an
/// attempted workload run. Once construction succeeds, `SupervisorEvidenceRun`
/// persists the canonical plan before any workload-side lifecycle effect,
/// executes the existing fail-closed supervisor, persists the terminal result,
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

/// Executes the same verified Linux supervisor path and projects only the two
/// final-certification proof categories this layer can establish directly.
///
/// The durable-chain assessment is `PROVEN` only because the wrapped execution
/// cannot return until `SupervisorEvidenceRun` has re-read and verified the
/// sealed receipt chain. The plan receipt is used as the chain-anchor identity;
/// the distinct lifecycle receipt binds the terminal lifecycle result.
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
) -> [OwnedCertificationEvidence; 2] {
    let lifecycle_assessment = if result.lifecycle.status == SupervisorTerminalStatus::Exited
        && result.lifecycle.reason == SupervisorLifecycleReason::ProcessExited
        && result.lifecycle.exit_code == Some(0)
    {
        EvidenceAssessment::Proven
    } else {
        EvidenceAssessment::Blocked
    };

    let lifecycle = OwnedCertificationEvidence {
        kind: CertificationEvidenceKind::Lifecycle,
        run_id: result.seal.run_id.clone(),
        source_sha256: result.seal.source_sha256.clone(),
        receipt_sha256: result.lifecycle_receipt.receipt_sha256.clone(),
        assessment: lifecycle_assessment,
    };
    let durable_chain = OwnedCertificationEvidence {
        kind: CertificationEvidenceKind::DurableEvidenceChain,
        run_id: result.seal.run_id.clone(),
        source_sha256: result.seal.source_sha256.clone(),
        receipt_sha256: result.plan_receipt.receipt_sha256.clone(),
        assessment: EvidenceAssessment::Proven,
    };
    [lifecycle, durable_chain]
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
    const LIFECYCLE_RECEIPT_SHA: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn receipt(sequence: u64, kind: &str, sha256: &str) -> EvidenceReceipt {
        EvidenceReceipt {
            sequence,
            kind: kind.to_owned(),
            payload_file: format!("{sequence:06}.payload"),
            payload_sha256:
                "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc".to_owned(),
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

    fn result(lifecycle: SupervisorLifecycleResult) -> EvidencedSupervisorResult {
        EvidencedSupervisorResult {
            lifecycle,
            plan_receipt: receipt(1, "supervisor-plan", PLAN_RECEIPT_SHA),
            lifecycle_receipt: receipt(2, "supervisor-lifecycle-result", LIFECYCLE_RECEIPT_SHA),
            seal: EvidenceSeal {
                run_id: RUN_ID.to_owned(),
                source_sha256: SOURCE_SHA.to_owned(),
                entry_count: 2,
                head_receipt_sha256: LIFECYCLE_RECEIPT_SHA.to_owned(),
                seal_file: "seal.json".to_owned(),
                seal_sha256:
                    "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
                        .to_owned(),
            },
        }
    }

    #[test]
    fn successful_supervisor_projects_only_proven_lifecycle_and_chain() {
        let result = result(SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(0),
            containment: None,
        });
        let projected = project_certification_evidence(&result);

        assert_eq!(projected.len(), 2);
        assert_eq!(projected[0].kind, CertificationEvidenceKind::Lifecycle);
        assert_eq!(projected[0].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[0].receipt_sha256, LIFECYCLE_RECEIPT_SHA);
        assert_eq!(
            projected[1].kind,
            CertificationEvidenceKind::DurableEvidenceChain
        );
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
        assert_eq!(projected[1].receipt_sha256, PLAN_RECEIPT_SHA);
        assert_ne!(projected[0].receipt_sha256, projected[1].receipt_sha256);
        assert!(projected.iter().all(|item| item.run_id == RUN_ID));
        assert!(projected
            .iter()
            .all(|item| item.source_sha256 == SOURCE_SHA));
    }

    #[test]
    fn nonzero_exit_blocks_lifecycle_without_downgrading_verified_chain() {
        let result = result(SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(9),
            containment: None,
        });
        let projected = project_certification_evidence(&result);

        assert_eq!(projected[0].assessment, EvidenceAssessment::Blocked);
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
    }

    #[test]
    fn timeout_or_containment_terminal_cannot_become_proven_lifecycle() {
        let result = result(SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::TimedOut,
            reason: SupervisorLifecycleReason::TimeoutContained,
            exit_code: None,
            containment: Some(ContainmentMode::Forced),
        });
        let projected = project_certification_evidence(&result);

        assert_eq!(projected[0].assessment, EvidenceAssessment::Blocked);
        assert_eq!(projected[1].assessment, EvidenceAssessment::Proven);
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
