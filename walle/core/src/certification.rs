use crate::{is_valid_sha256, CertificationProfile, RunMachine, RunState, TransitionError};

pub(crate) struct CertificationTransitionToken(());

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum CertificationEvidenceKind {
    SourceIdentity,
    HostIsolation,
    RuntimeBinaryIdentity,
    ImageIntegrity,
    MicroVmBoot,
    ResourceControls,
    NetworkIsolation,
    GuestSeccomp,
    GuestCompletionAck,
    Lifecycle,
    OutputBounds,
    DurableEvidenceChain,
}

impl CertificationEvidenceKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::SourceIdentity => "SOURCE_IDENTITY",
            Self::HostIsolation => "HOST_ISOLATION",
            Self::RuntimeBinaryIdentity => "RUNTIME_BINARY_IDENTITY",
            Self::ImageIntegrity => "IMAGE_INTEGRITY",
            Self::MicroVmBoot => "MICROVM_BOOT",
            Self::ResourceControls => "RESOURCE_CONTROLS",
            Self::NetworkIsolation => "NETWORK_ISOLATION",
            Self::GuestSeccomp => "GUEST_SECCOMP",
            Self::GuestCompletionAck => "GUEST_COMPLETION_ACK",
            Self::Lifecycle => "LIFECYCLE",
            Self::OutputBounds => "OUTPUT_BOUNDS",
            Self::DurableEvidenceChain => "DURABLE_EVIDENCE_CHAIN",
        }
    }
}

pub const REQUIRED_CERTIFICATION_EVIDENCE: [CertificationEvidenceKind; 12] = [
    CertificationEvidenceKind::SourceIdentity,
    CertificationEvidenceKind::HostIsolation,
    CertificationEvidenceKind::RuntimeBinaryIdentity,
    CertificationEvidenceKind::ImageIntegrity,
    CertificationEvidenceKind::MicroVmBoot,
    CertificationEvidenceKind::ResourceControls,
    CertificationEvidenceKind::NetworkIsolation,
    CertificationEvidenceKind::GuestSeccomp,
    CertificationEvidenceKind::GuestCompletionAck,
    CertificationEvidenceKind::Lifecycle,
    CertificationEvidenceKind::OutputBounds,
    CertificationEvidenceKind::DurableEvidenceChain,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EvidenceAssessment {
    Proven,
    InsufficientData,
    Blocked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CertificationEvidence<'a> {
    pub kind: CertificationEvidenceKind,
    pub run_id: &'a str,
    pub source_sha256: &'a str,
    pub receipt_sha256: &'a str,
    pub assessment: EvidenceAssessment,
}

#[derive(Debug, Clone, Copy)]
pub struct CertificationInput<'a> {
    pub run_id: &'a str,
    pub source_sha256: &'a str,
    pub profile: CertificationProfile,
    pub run_state: RunState,
    pub evidence: &'a [CertificationEvidence<'a>],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalCertificationVerdict {
    Certified,
    InsufficientData,
    Blocked,
}

impl FinalCertificationVerdict {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Certified => "CERTIFIED",
            Self::InsufficientData => "INSUFFICIENT_DATA",
            Self::Blocked => "BLOCKED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FinalCertificationReason {
    AllRequiredEvidenceProven,
    CertificationProfileRequired,
    RunNotInCertifyingState,
    MissingRequiredEvidence,
    EvidenceInsufficient,
    EvidenceBlocked,
    InvalidEvidenceBinding,
    DuplicateEvidenceKind,
    DuplicateEvidenceReceipt,
}

impl FinalCertificationReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::AllRequiredEvidenceProven => "ALL_REQUIRED_EVIDENCE_PROVEN",
            Self::CertificationProfileRequired => "CERTIFICATION_PROFILE_REQUIRED",
            Self::RunNotInCertifyingState => "RUN_NOT_IN_CERTIFYING_STATE",
            Self::MissingRequiredEvidence => "MISSING_REQUIRED_EVIDENCE",
            Self::EvidenceInsufficient => "EVIDENCE_INSUFFICIENT",
            Self::EvidenceBlocked => "EVIDENCE_BLOCKED",
            Self::InvalidEvidenceBinding => "INVALID_EVIDENCE_BINDING",
            Self::DuplicateEvidenceKind => "DUPLICATE_EVIDENCE_KIND",
            Self::DuplicateEvidenceReceipt => "DUPLICATE_EVIDENCE_RECEIPT",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FinalCertificationDecision {
    pub verdict: FinalCertificationVerdict,
    pub reason: FinalCertificationReason,
    pub evidence_kind: Option<CertificationEvidenceKind>,
}

/// Evaluates only the final fail-closed policy boundary.
///
/// Every `CertificationEvidence` entry must already refer to a receipt whose
/// durable hash chain has been verified by the evidence plane. This function
/// deliberately does not turn an in-memory assertion into proof: it validates
/// identity bindings, completeness, uniqueness and the supplied verified
/// assessments before allowing the terminal `CERTIFIED` verdict.
pub fn evaluate_final_certification(input: CertificationInput<'_>) -> FinalCertificationDecision {
    if input.profile != CertificationProfile::Certification {
        return decision(
            FinalCertificationVerdict::InsufficientData,
            FinalCertificationReason::CertificationProfileRequired,
            None,
        );
    }
    if input.run_state != RunState::Certifying {
        return decision(
            FinalCertificationVerdict::Blocked,
            FinalCertificationReason::RunNotInCertifyingState,
            None,
        );
    }
    if !valid_run_id(input.run_id) || !is_valid_sha256(input.source_sha256) {
        return decision(
            FinalCertificationVerdict::Blocked,
            FinalCertificationReason::InvalidEvidenceBinding,
            None,
        );
    }

    for (index, evidence) in input.evidence.iter().enumerate() {
        if evidence.run_id != input.run_id
            || evidence.source_sha256 != input.source_sha256
            || !is_valid_sha256(evidence.receipt_sha256)
        {
            return decision(
                FinalCertificationVerdict::Blocked,
                FinalCertificationReason::InvalidEvidenceBinding,
                Some(evidence.kind),
            );
        }
        if input.evidence[..index]
            .iter()
            .any(|earlier| earlier.kind == evidence.kind)
        {
            return decision(
                FinalCertificationVerdict::Blocked,
                FinalCertificationReason::DuplicateEvidenceKind,
                Some(evidence.kind),
            );
        }
        if input.evidence[..index]
            .iter()
            .any(|earlier| earlier.receipt_sha256 == evidence.receipt_sha256)
        {
            return decision(
                FinalCertificationVerdict::Blocked,
                FinalCertificationReason::DuplicateEvidenceReceipt,
                Some(evidence.kind),
            );
        }
    }

    for required in REQUIRED_CERTIFICATION_EVIDENCE {
        let Some(evidence) = input.evidence.iter().find(|item| item.kind == required) else {
            return decision(
                FinalCertificationVerdict::InsufficientData,
                FinalCertificationReason::MissingRequiredEvidence,
                Some(required),
            );
        };
        match evidence.assessment {
            EvidenceAssessment::Proven => {}
            EvidenceAssessment::InsufficientData => {
                return decision(
                    FinalCertificationVerdict::InsufficientData,
                    FinalCertificationReason::EvidenceInsufficient,
                    Some(required),
                )
            }
            EvidenceAssessment::Blocked => {
                return decision(
                    FinalCertificationVerdict::Blocked,
                    FinalCertificationReason::EvidenceBlocked,
                    Some(required),
                )
            }
        }
    }

    decision(
        FinalCertificationVerdict::Certified,
        FinalCertificationReason::AllRequiredEvidenceProven,
        None,
    )
}

/// Evaluates the final policy against the machine's actual state and applies
/// exactly one terminal transition. This prevents callers from accidentally
/// evaluating a stale `run_state` value and then promoting a different machine.
pub fn evaluate_and_apply_final_certification(
    machine: &mut RunMachine,
    input: CertificationInput<'_>,
) -> Result<FinalCertificationDecision, TransitionError> {
    let bound_input = CertificationInput {
        run_state: machine.state(),
        ..input
    };
    let decision = evaluate_final_certification(bound_input);
    match decision.verdict {
        FinalCertificationVerdict::Certified => {
            machine.certify_from_gate(CertificationTransitionToken(()))?
        }
        FinalCertificationVerdict::InsufficientData => {
            machine.transition(RunState::InsufficientData)?
        }
        FinalCertificationVerdict::Blocked => machine.transition(RunState::Blocked)?,
    }
    Ok(decision)
}

const fn decision(
    verdict: FinalCertificationVerdict,
    reason: FinalCertificationReason,
    evidence_kind: Option<CertificationEvidenceKind>,
) -> FinalCertificationDecision {
    FinalCertificationDecision {
        verdict,
        reason,
        evidence_kind,
    }
}

fn valid_run_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUN_ID: &str = "run-0123456789abcdef0123456789abcdef";
    const SOURCE_SHA: &str =
        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RECEIPT_SHAS: [&str; 12] = [
        "sha256:0000000000000000000000000000000000000000000000000000000000000001",
        "sha256:0000000000000000000000000000000000000000000000000000000000000002",
        "sha256:0000000000000000000000000000000000000000000000000000000000000003",
        "sha256:0000000000000000000000000000000000000000000000000000000000000004",
        "sha256:0000000000000000000000000000000000000000000000000000000000000005",
        "sha256:0000000000000000000000000000000000000000000000000000000000000006",
        "sha256:0000000000000000000000000000000000000000000000000000000000000007",
        "sha256:0000000000000000000000000000000000000000000000000000000000000008",
        "sha256:0000000000000000000000000000000000000000000000000000000000000009",
        "sha256:000000000000000000000000000000000000000000000000000000000000000a",
        "sha256:000000000000000000000000000000000000000000000000000000000000000b",
        "sha256:000000000000000000000000000000000000000000000000000000000000000c",
    ];

    fn all_proven() -> Vec<CertificationEvidence<'static>> {
        REQUIRED_CERTIFICATION_EVIDENCE
            .iter()
            .copied()
            .enumerate()
            .map(|(index, kind)| CertificationEvidence {
                kind,
                run_id: RUN_ID,
                source_sha256: SOURCE_SHA,
                receipt_sha256: RECEIPT_SHAS[index],
                assessment: EvidenceAssessment::Proven,
            })
            .collect()
    }

    fn input<'a>(evidence: &'a [CertificationEvidence<'a>]) -> CertificationInput<'a> {
        CertificationInput {
            run_id: RUN_ID,
            source_sha256: SOURCE_SHA,
            profile: CertificationProfile::Certification,
            run_state: RunState::Certifying,
            evidence,
        }
    }

    fn machine_at_certifying() -> RunMachine {
        let mut machine = RunMachine::new();
        for next in [
            RunState::Preparing,
            RunState::Isolated,
            RunState::Executing,
            RunState::Verifying,
            RunState::Certifying,
        ] {
            machine.transition(next).expect("advance machine");
        }
        machine
    }

    #[test]
    fn certifies_only_when_every_required_bound_proof_is_proven() {
        let evidence = all_proven();
        assert_eq!(
            evaluate_final_certification(input(&evidence)),
            FinalCertificationDecision {
                verdict: FinalCertificationVerdict::Certified,
                reason: FinalCertificationReason::AllRequiredEvidenceProven,
                evidence_kind: None,
            }
        );
    }

    #[test]
    fn connected_gate_is_the_only_certified_terminal_transition() {
        let evidence = all_proven();
        let mut machine = machine_at_certifying();
        assert!(machine.transition(RunState::Certified).is_err());
        let decision = evaluate_and_apply_final_certification(&mut machine, input(&evidence))
            .expect("apply certification");
        assert_eq!(decision.verdict, FinalCertificationVerdict::Certified);
        assert_eq!(machine.state(), RunState::Certified);
    }

    #[test]
    fn missing_guest_ack_stays_insufficient_data() {
        let mut evidence = all_proven();
        evidence.retain(|item| item.kind != CertificationEvidenceKind::GuestCompletionAck);
        assert_eq!(
            evaluate_final_certification(input(&evidence)),
            FinalCertificationDecision {
                verdict: FinalCertificationVerdict::InsufficientData,
                reason: FinalCertificationReason::MissingRequiredEvidence,
                evidence_kind: Some(CertificationEvidenceKind::GuestCompletionAck),
            }
        );

        let mut machine = machine_at_certifying();
        evaluate_and_apply_final_certification(&mut machine, input(&evidence))
            .expect("apply insufficient-data decision");
        assert_eq!(machine.state(), RunState::InsufficientData);
    }

    #[test]
    fn blocked_required_proof_blocks_terminal_certification() {
        let mut evidence = all_proven();
        evidence
            .iter_mut()
            .find(|item| item.kind == CertificationEvidenceKind::MicroVmBoot)
            .expect("microvm proof")
            .assessment = EvidenceAssessment::Blocked;
        assert_eq!(
            evaluate_final_certification(input(&evidence)),
            FinalCertificationDecision {
                verdict: FinalCertificationVerdict::Blocked,
                reason: FinalCertificationReason::EvidenceBlocked,
                evidence_kind: Some(CertificationEvidenceKind::MicroVmBoot),
            }
        );
    }

    #[test]
    fn insufficient_required_proof_cannot_be_promoted() {
        let mut evidence = all_proven();
        evidence
            .iter_mut()
            .find(|item| item.kind == CertificationEvidenceKind::HostIsolation)
            .expect("host proof")
            .assessment = EvidenceAssessment::InsufficientData;
        assert_eq!(
            evaluate_final_certification(input(&evidence)).verdict,
            FinalCertificationVerdict::InsufficientData
        );
    }

    #[test]
    fn cross_run_or_malformed_receipt_binding_blocks() {
        let mut evidence = all_proven();
        evidence[0].run_id = "run-other";
        assert_eq!(
            evaluate_final_certification(input(&evidence)).reason,
            FinalCertificationReason::InvalidEvidenceBinding
        );

        let mut evidence = all_proven();
        evidence[0].receipt_sha256 = "sha256:deadbeef";
        assert_eq!(
            evaluate_final_certification(input(&evidence)).reason,
            FinalCertificationReason::InvalidEvidenceBinding
        );
    }

    #[test]
    fn duplicate_evidence_kind_blocks_instead_of_shadowing() {
        let mut evidence = all_proven();
        evidence.push(evidence[0]);
        assert_eq!(
            evaluate_final_certification(input(&evidence)),
            FinalCertificationDecision {
                verdict: FinalCertificationVerdict::Blocked,
                reason: FinalCertificationReason::DuplicateEvidenceKind,
                evidence_kind: Some(CertificationEvidenceKind::SourceIdentity),
            }
        );
    }

    #[test]
    fn one_receipt_cannot_be_reused_for_multiple_required_proofs() {
        let mut evidence = all_proven();
        let duplicate_receipt = evidence[0].receipt_sha256;
        evidence[1].receipt_sha256 = duplicate_receipt;
        assert_eq!(
            evaluate_final_certification(input(&evidence)),
            FinalCertificationDecision {
                verdict: FinalCertificationVerdict::Blocked,
                reason: FinalCertificationReason::DuplicateEvidenceReceipt,
                evidence_kind: Some(CertificationEvidenceKind::HostIsolation),
            }
        );
    }

    #[test]
    fn fast_or_hardened_profile_cannot_emit_final_certified() {
        let evidence = all_proven();
        let mut candidate = input(&evidence);
        candidate.profile = CertificationProfile::Hardened;
        assert_eq!(
            evaluate_final_certification(candidate).verdict,
            FinalCertificationVerdict::InsufficientData
        );
    }

    #[test]
    fn connected_gate_uses_machine_state_not_caller_claim() {
        let evidence = all_proven();
        let mut machine = RunMachine::new();
        machine.transition(RunState::Preparing).expect("preparing");
        let decision = evaluate_and_apply_final_certification(&mut machine, input(&evidence))
            .expect("fail closed into blocked");
        assert_eq!(decision.verdict, FinalCertificationVerdict::Blocked);
        assert_eq!(
            decision.reason,
            FinalCertificationReason::RunNotInCertifyingState
        );
        assert_eq!(machine.state(), RunState::Blocked);
    }
}
