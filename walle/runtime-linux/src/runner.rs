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
/// `SOURCE_IDENTITY` is emitted from the dedicated durable receipt created only
/// after the supervisor plan and evidence run are confirmed to share the exact
/// run id and source SHA-256. `RESOURCE_CONTROLS` is emitted only from the
/// dedicated receipt created after the concrete Linux host successfully creates
/// its cgroup-v2 leaf, writes the CPU/memory/PID limits and reads those exact
/// limits back. Runtime identity, image integrity and output bounds likewise
/// require their own receipts. `LIFECYCLE` and `DURABLE_EVIDENCE_CHAIN` retain
/// independent semantics. This layer still does not manufacture host-isolation,
/// microVM-boot, network, guest-seccomp or guest-completion proof.
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
/// No category is inferred from the plan. The durable-chain assessment is
/// `PROVEN` only because the wrapped execution cannot return until
/// `SupervisorEvidenceRun` has re-read and verified the sealed receipt chain.
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
    let mut projected = Vec::with_capacity(7);

    projected.push(OwnedCertificationEvidence {
        kind: CertificationEvidenceKind::SourceIdentity,
        run_id: result.seal.run_id.clone(),
        source_sha256: result.seal.source_sha256.clone(),
        receipt_sha256: result.source_identity_receipt.receipt_sha256.clone(),
        assessment: EvidenceAssessment::Proven,
    });

    if let Some(receipt) = result.resource_controls_receipt.as_ref() {
        projected.push(OwnedCertificationEvidence {
            kind: CertificationEvidenceKind::ResourceControls,
            run_id: result.seal.run_id.clone(),
            source_sha256: result.seal.source_sha256.clone(),
            receipt_sha256: receipt.receipt_sha256.clone(),
            assessment: EvidenceAssessment::Proven,
        });
    }

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

    if let Some(receipt) = result.output_bounds_receipt.as_ref() {
        projected.push(OwnedCertificationEvidence {
            kind: CertificationEvidenceKind::OutputBounds,
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
    const SOURCE_RECEIPT_SHA: &str =
        "sha256:9999999999999999999999999999999999999999999999999999999999999999";
    const RESOURCE_RECEIPT_SHA: &str =
        "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const RUNTIME_RECEIPT_SHA: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const IMAGE_RECEIPT_SHA: &str =
        "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    const OUTPUT_RECEIPT_SHA: &str =
        "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const LIFECYCLE_RECEIPT_SHA: &str =
        "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

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

    fn clean_exit() -> SupervisorLifecycleResult {
        SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(0),
            containment: None,
        }
    }

    fn result(
        lifecycle: SupervisorLifecycleResult,
        resource: bool,
        runtime: bool,
        image: bool,
        output: bool,
    ) -> EvidencedSupervisorResult {
        EvidencedSupervisorResult {
            lifecycle,
            plan_receipt: receipt(1, "supervisor-plan", PLAN_RECEIPT_SHA),
            source_identity_receipt: receipt(2, "source-identity", SOURCE_RECEIPT_SHA),
            resource_controls_receipt: resource
                .then(|| receipt(3, "resource-controls", RESOURCE_RECEIPT_SHA)),
            runtime_binary_identity_receipt: runtime
                .then(|| receipt(4, "runtime-binary-identity", RUNTIME_RECEIPT_SHA)),
            image_integrity_receipt: image
                .then(|| receipt(5, "image-integrity", IMAGE_RECEIPT_SHA)),
            output_bounds_receipt: output
                .then(|| receipt(6, "supervisor-output-bounds", OUTPUT_RECEIPT_SHA)),
            lifecycle_receipt: receipt(7, "supervisor-lifecycle-result", LIFECYCLE_RECEIPT_SHA),
            seal: EvidenceSeal {
                run_id: RUN_ID.to_owned(),
                source_sha256: SOURCE_SHA.to_owned(),
                entry_count: 7,
                head_receipt_sha256: LIFECYCLE_RECEIPT_SHA.to_owned(),
                seal_file: "seal.json".to_owned(),
                seal_sha256:
                    "sha256:1111111111111111111111111111111111111111111111111111111111111111"
                        .to_owned(),
            },
        }
    }

    fn evidence(
        projected: &[OwnedCertificationEvidence],
        kind: CertificationEvidenceKind,
    ) -> &OwnedCertificationEvidence {
        projected
            .iter()
            .find(|item| item.kind == kind)
            .expect("projected evidence kind")
    }

    #[test]
    fn successful_supervisor_projects_seven_distinct_verified_categories() {
        let projected =
            project_certification_evidence(&result(clean_exit(), true, true, true, true));

        assert_eq!(projected.len(), 7);
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::SourceIdentity).receipt_sha256,
            SOURCE_RECEIPT_SHA
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::ResourceControls).receipt_sha256,
            RESOURCE_RECEIPT_SHA
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::RuntimeBinaryIdentity).receipt_sha256,
            RUNTIME_RECEIPT_SHA
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::ImageIntegrity).receipt_sha256,
            IMAGE_RECEIPT_SHA
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::OutputBounds).receipt_sha256,
            OUTPUT_RECEIPT_SHA
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::Lifecycle).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::DurableEvidenceChain).receipt_sha256,
            PLAN_RECEIPT_SHA
        );
        assert!(projected
            .iter()
            .all(|item| item.assessment == EvidenceAssessment::Proven));
        for (index, item) in projected.iter().enumerate() {
            assert!(projected[..index]
                .iter()
                .all(|earlier| earlier.receipt_sha256 != item.receipt_sha256));
        }
        assert!(projected.iter().all(|item| item.run_id == RUN_ID));
        assert!(projected
            .iter()
            .all(|item| item.source_sha256 == SOURCE_SHA));
    }

    #[test]
    fn source_identity_is_always_projected_from_its_dedicated_receipt() {
        let projected =
            project_certification_evidence(&result(clean_exit(), false, false, false, false));
        let source = evidence(&projected, CertificationEvidenceKind::SourceIdentity);

        assert_eq!(source.receipt_sha256, SOURCE_RECEIPT_SHA);
        assert_eq!(source.assessment, EvidenceAssessment::Proven);
        assert_ne!(source.receipt_sha256, PLAN_RECEIPT_SHA);
        assert_ne!(source.receipt_sha256, LIFECYCLE_RECEIPT_SHA);
    }

    #[test]
    fn missing_resource_receipt_is_never_inferred_from_other_success_proof() {
        let projected =
            project_certification_evidence(&result(clean_exit(), false, true, true, true));

        assert_eq!(projected.len(), 6);
        assert!(projected
            .iter()
            .all(|item| item.kind != CertificationEvidenceKind::ResourceControls));
        assert!(projected
            .iter()
            .any(|item| item.kind == CertificationEvidenceKind::SourceIdentity));
        assert!(projected
            .iter()
            .any(|item| item.kind == CertificationEvidenceKind::RuntimeBinaryIdentity));
    }

    #[test]
    fn missing_all_optional_receipts_keeps_source_lifecycle_and_durable_chain() {
        let projected =
            project_certification_evidence(&result(clean_exit(), false, false, false, false));

        assert_eq!(projected.len(), 3);
        assert!(projected
            .iter()
            .any(|item| item.kind == CertificationEvidenceKind::SourceIdentity));
        assert!(projected
            .iter()
            .any(|item| item.kind == CertificationEvidenceKind::Lifecycle));
        assert!(projected
            .iter()
            .any(|item| item.kind == CertificationEvidenceKind::DurableEvidenceChain));
    }

    #[test]
    fn nonzero_exit_blocks_lifecycle_without_downgrading_verified_other_proof() {
        let lifecycle = SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::Exited,
            reason: SupervisorLifecycleReason::ProcessExited,
            exit_code: Some(9),
            containment: None,
        };
        let projected = project_certification_evidence(&result(lifecycle, true, true, true, true));

        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::SourceIdentity).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::ResourceControls).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::RuntimeBinaryIdentity).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::ImageIntegrity).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::OutputBounds).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::Lifecycle).assessment,
            EvidenceAssessment::Blocked
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::DurableEvidenceChain).assessment,
            EvidenceAssessment::Proven
        );
    }

    #[test]
    fn timeout_cannot_invent_output_or_lifecycle_proof() {
        let lifecycle = SupervisorLifecycleResult {
            status: SupervisorTerminalStatus::TimedOut,
            reason: SupervisorLifecycleReason::TimeoutContained,
            exit_code: None,
            containment: Some(ContainmentMode::Forced),
        };
        let projected = project_certification_evidence(&result(lifecycle, true, true, true, false));

        assert_eq!(projected.len(), 6);
        assert!(projected
            .iter()
            .all(|item| item.kind != CertificationEvidenceKind::OutputBounds));
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::SourceIdentity).assessment,
            EvidenceAssessment::Proven
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::Lifecycle).assessment,
            EvidenceAssessment::Blocked
        );
        assert_eq!(
            evidence(&projected, CertificationEvidenceKind::ResourceControls).assessment,
            EvidenceAssessment::Proven
        );
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
