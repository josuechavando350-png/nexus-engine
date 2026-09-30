//! RMC-014 terminal Real Market Census certification.
//!
//! This crate owns one thing: deciding whether the Census may legitimately
//! emit REAL_MARKET_CENSUS_CLOSED. It has no network, transaction, discovery,
//! routing, capture or P&L authority. Every upstream proof must already exist,
//! be content-addressed and be explicitly admitted.

use nqc_census_core::Hash32;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fmt::{Display, Formatter},
};

const CLOSEOUT_DOMAIN: &[u8] = b"NQC-RMC014-REAL-MARKET-CENSUS-CLOSEOUT-V1";
const REQUIRED_STAGE_COUNT: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RmcStage {
    Rmc006,
    Rmc007,
    Rmc008,
    Rmc009,
    Rmc010,
    Rmc011,
    Rmc012,
    Rmc013,
}

impl RmcStage {
    pub const REQUIRED: [Self; REQUIRED_STAGE_COUNT] = [
        Self::Rmc006,
        Self::Rmc007,
        Self::Rmc008,
        Self::Rmc009,
        Self::Rmc010,
        Self::Rmc011,
        Self::Rmc012,
        Self::Rmc013,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::Rmc006 => "RMC-006",
            Self::Rmc007 => "RMC-007",
            Self::Rmc008 => "RMC-008",
            Self::Rmc009 => "RMC-009",
            Self::Rmc010 => "RMC-010",
            Self::Rmc011 => "RMC-011",
            Self::Rmc012 => "RMC-012",
            Self::Rmc013 => "RMC-013",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Rmc006 => 6,
            Self::Rmc007 => 7,
            Self::Rmc008 => 8,
            Self::Rmc009 => 9,
            Self::Rmc010 => 10,
            Self::Rmc011 => 11,
            Self::Rmc012 => 12,
            Self::Rmc013 => 13,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CloseoutError {
    InvalidGitObjectId,
    DuplicateStage(RmcStage),
    MissingStage(RmcStage),
    StageNotAdmitted(RmcStage),
    StageCoverageIncomplete(RmcStage),
    StageHasUnresolvedMismatch(RmcStage),
    StageHasUnknownFailure(RmcStage),
    StageHasOpenBlocker(RmcStage),
    EmptyStageEvidence(RmcStage),
    DuplicateStageEvidence(RmcStage),
    PipelineNotMonotonic,
    CandidateCountMismatch,
    EconomicsCoverageMismatch,
    ShadowHandoffMismatch,
    ZeroOwnCapitalNotProven,
    ProfitabilityClaimForbidden,
    ScopeClaimForbidden,
    EmptyTerminalEvidence,
    DuplicateTerminalEvidence,
}

impl Display for CloseoutError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidGitObjectId => f.write_str("git object id must be canonical 40-hex"),
            Self::DuplicateStage(stage) => {
                write!(f, "duplicate terminal proof for {}", stage.code())
            }
            Self::MissingStage(stage) => write!(f, "missing terminal proof for {}", stage.code()),
            Self::StageNotAdmitted(stage) => write!(f, "{} is not admitted", stage.code()),
            Self::StageCoverageIncomplete(stage) => {
                write!(f, "{} coverage is incomplete", stage.code())
            }
            Self::StageHasUnresolvedMismatch(stage) => {
                write!(f, "{} has unresolved mismatches", stage.code())
            }
            Self::StageHasUnknownFailure(stage) => {
                write!(f, "{} has UNKNOWN failures", stage.code())
            }
            Self::StageHasOpenBlocker(stage) => write!(f, "{} has open blockers", stage.code()),
            Self::EmptyStageEvidence(stage) => write!(f, "{} has no evidence", stage.code()),
            Self::DuplicateStageEvidence(stage) => {
                write!(f, "{} repeats evidence", stage.code())
            }
            Self::PipelineNotMonotonic => {
                f.write_str("census stage counts violate the non-increasing pipeline")
            }
            Self::CandidateCountMismatch => {
                f.write_str("terminal candidate counts disagree with pipeline counts")
            }
            Self::EconomicsCoverageMismatch => f.write_str(
                "execution economics does not cover every execution-simulatable candidate",
            ),
            Self::ShadowHandoffMismatch => {
                f.write_str("shadow handoff coverage is internally inconsistent")
            }
            Self::ZeroOwnCapitalNotProven => {
                f.write_str("capital-feasible opportunities exist without zero-own-capital proof")
            }
            Self::ProfitabilityClaimForbidden => {
                f.write_str("RMC closeout cannot claim realized or target profitability")
            }
            Self::ScopeClaimForbidden => f.write_str(
                "RMC closeout must remain conservative and cannot claim global capital or route completeness",
            ),
            Self::EmptyTerminalEvidence => f.write_str("terminal closeout requires evidence"),
            Self::DuplicateTerminalEvidence => f.write_str("terminal closeout repeats evidence"),
        }
    }
}

impl std::error::Error for CloseoutError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct GitObjectId([u8; 20]);

impl GitObjectId {
    pub fn parse_hex(value: &str) -> Result<Self, CloseoutError> {
        if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CloseoutError::InvalidGitObjectId);
        }
        if value.bytes().all(|byte| byte == b'0')
            || value.bytes().any(|byte| byte.is_ascii_uppercase())
        {
            return Err(CloseoutError::InvalidGitObjectId);
        }
        let mut out = [0_u8; 20];
        let bytes = value.as_bytes();
        for (index, output) in out.iter_mut().enumerate() {
            let offset = index * 2;
            *output = (hex_nibble(bytes[offset])? << 4) | hex_nibble(bytes[offset + 1])?;
        }
        Ok(Self(out))
    }

    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageProof {
    pub stage: RmcStage,
    pub code_commit: GitObjectId,
    pub code_tree: GitObjectId,
    pub artifact_sha256: Hash32,
    pub authority_commitment: Hash32,
    pub coverage_commitment: Hash32,
    pub admitted: bool,
    pub coverage_complete: bool,
    pub unresolved_mismatch_count: u64,
    pub unknown_failure_count: u64,
    pub blocker_count: u64,
    pub evidence: Vec<Hash32>,
}

impl StageProof {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        stage: RmcStage,
        code_commit: GitObjectId,
        code_tree: GitObjectId,
        artifact_sha256: Hash32,
        authority_commitment: Hash32,
        coverage_commitment: Hash32,
        admitted: bool,
        coverage_complete: bool,
        unresolved_mismatch_count: u64,
        unknown_failure_count: u64,
        blocker_count: u64,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, CloseoutError> {
        if evidence.is_empty() {
            return Err(CloseoutError::EmptyStageEvidence(stage));
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(CloseoutError::DuplicateStageEvidence(stage));
        }
        Ok(Self {
            stage,
            code_commit,
            code_tree,
            artifact_sha256,
            authority_commitment,
            coverage_commitment,
            admitted,
            coverage_complete,
            unresolved_mismatch_count,
            unknown_failure_count,
            blocker_count,
            evidence,
        })
    }

    fn validate_terminal(&self) -> Result<(), CloseoutError> {
        if !self.admitted {
            return Err(CloseoutError::StageNotAdmitted(self.stage));
        }
        if !self.coverage_complete {
            return Err(CloseoutError::StageCoverageIncomplete(self.stage));
        }
        if self.unresolved_mismatch_count != 0 {
            return Err(CloseoutError::StageHasUnresolvedMismatch(self.stage));
        }
        if self.unknown_failure_count != 0 {
            return Err(CloseoutError::StageHasUnknownFailure(self.stage));
        }
        if self.blocker_count != 0 {
            return Err(CloseoutError::StageHasOpenBlocker(self.stage));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PipelineCounts {
    // Market-universe funnel. These counts are all canonical market units.
    pub markets_discovered: u64,
    pub markets_canonicalized: u64,
    pub markets_state_reconstructable: u64,
    pub markets_economically_active: u64,
    pub markets_borrowable: u64,

    // Opportunity/candidate funnel. One market may yield many borrower/debt/
    // collateral candidates, so this funnel is intentionally separate from
    // the market funnel rather than pretending both populations are the same.
    pub actionable_candidates: u64,
    pub capital_feasible_candidates: u64,
    pub execution_simulatable_candidates: u64,
    pub positive_gross_value_candidates: u64,
    pub positive_success_path_net_candidates: u64,
    pub capacity_material_candidates: u64,
    pub shadow_eligible_candidates: u64,
}

impl PipelineCounts {
    pub fn validate(self) -> Result<(), CloseoutError> {
        let market_values = [
            self.markets_discovered,
            self.markets_canonicalized,
            self.markets_state_reconstructable,
            self.markets_economically_active,
            self.markets_borrowable,
        ];
        if market_values.windows(2).any(|pair| pair[1] > pair[0]) {
            return Err(CloseoutError::PipelineNotMonotonic);
        }

        let opportunity_values = [
            self.actionable_candidates,
            self.capital_feasible_candidates,
            self.execution_simulatable_candidates,
            self.positive_gross_value_candidates,
            self.positive_success_path_net_candidates,
            self.capacity_material_candidates,
            self.shadow_eligible_candidates,
        ];
        if opportunity_values.windows(2).any(|pair| pair[1] > pair[0]) {
            return Err(CloseoutError::PipelineNotMonotonic);
        }
        Ok(())
    }

    fn encode(self, hasher: &mut Sha256) {
        for value in [
            self.markets_discovered,
            self.markets_canonicalized,
            self.markets_state_reconstructable,
            self.markets_economically_active,
            self.markets_borrowable,
            self.actionable_candidates,
            self.capital_feasible_candidates,
            self.execution_simulatable_candidates,
            self.positive_gross_value_candidates,
            self.positive_success_path_net_candidates,
            self.capacity_material_candidates,
            self.shadow_eligible_candidates,
        ] {
            hasher.update(value.to_be_bytes());
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EconomicBoundary {
    /// Exact real candidates produced by the actionability/liquidation bridge.
    pub real_candidate_count: u64,
    /// Candidates for which RMC-013 emitted exact pre-capture economics.
    pub economics_quote_count: u64,
    /// Deterministic ex-ante records ready to be observed by Shadow.
    pub shadow_prediction_count: u64,
    /// Number whose capture model is already empirically calibrated. This may
    /// be zero at RMC close; Shadow owns calibration.
    pub capture_calibrated_count: u64,
    /// True only when RMC-011 proved no operator-owned capital was required by
    /// every opportunity classified as capital-feasible.
    pub zero_own_capital_proven: bool,
    /// Must remain false in RMC. Realized profitability belongs to Canary/P&L.
    pub realized_profitability_proven: bool,
    /// Must remain false in RMC. The monthly target is an empirical target,
    /// never a closeout assumption.
    pub monthly_target_probability_proven: bool,
    /// RMC closes on the evidence-admitted universe and reports a conservative
    /// realizable lower bound rather than an unsupported global maximum.
    pub conservative_realizable_capacity_only: bool,
    /// Must remain false until an explicit global capital-source completeness
    /// certification exists.
    pub global_capital_source_completeness_claimed: bool,
    /// Must remain false until all economically relevant route/venue families
    /// are exhaustively admitted or rejected with evidence.
    pub global_route_venue_completeness_claimed: bool,
}

impl EconomicBoundary {
    fn validate(self, counts: PipelineCounts) -> Result<(), CloseoutError> {
        if self.real_candidate_count != counts.actionable_candidates {
            return Err(CloseoutError::CandidateCountMismatch);
        }
        if self.economics_quote_count != counts.execution_simulatable_candidates {
            return Err(CloseoutError::EconomicsCoverageMismatch);
        }
        if self.shadow_prediction_count != counts.shadow_eligible_candidates
            || self.capture_calibrated_count > self.economics_quote_count
        {
            return Err(CloseoutError::ShadowHandoffMismatch);
        }
        if counts.capital_feasible_candidates > 0 && !self.zero_own_capital_proven {
            return Err(CloseoutError::ZeroOwnCapitalNotProven);
        }
        if self.realized_profitability_proven || self.monthly_target_probability_proven {
            return Err(CloseoutError::ProfitabilityClaimForbidden);
        }
        if !self.conservative_realizable_capacity_only
            || self.global_capital_source_completeness_claimed
            || self.global_route_venue_completeness_claimed
        {
            return Err(CloseoutError::ScopeClaimForbidden);
        }
        Ok(())
    }

    fn encode(self, hasher: &mut Sha256) {
        hasher.update(self.real_candidate_count.to_be_bytes());
        hasher.update(self.economics_quote_count.to_be_bytes());
        hasher.update(self.shadow_prediction_count.to_be_bytes());
        hasher.update(self.capture_calibrated_count.to_be_bytes());
        hasher.update([u8::from(self.zero_own_capital_proven)]);
        hasher.update([u8::from(self.realized_profitability_proven)]);
        hasher.update([u8::from(self.monthly_target_probability_proven)]);
        hasher.update([u8::from(self.conservative_realizable_capacity_only)]);
        hasher.update([u8::from(self.global_capital_source_completeness_claimed)]);
        hasher.update([u8::from(self.global_route_venue_completeness_claimed)]);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CloseoutCertificate {
    stages: Vec<StageProof>,
    counts: PipelineCounts,
    economics: EconomicBoundary,
    evidence: Vec<Hash32>,
    commitment: [u8; 32],
}

impl CloseoutCertificate {
    pub fn certify(
        stages: Vec<StageProof>,
        counts: PipelineCounts,
        economics: EconomicBoundary,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, CloseoutError> {
        counts.validate()?;
        economics.validate(counts)?;
        if evidence.is_empty() {
            return Err(CloseoutError::EmptyTerminalEvidence);
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(CloseoutError::DuplicateTerminalEvidence);
        }

        let mut by_stage = BTreeMap::new();
        for proof in stages {
            proof.validate_terminal()?;
            let stage = proof.stage;
            if by_stage.insert(stage, proof).is_some() {
                return Err(CloseoutError::DuplicateStage(stage));
            }
        }
        for required in RmcStage::REQUIRED {
            if !by_stage.contains_key(&required) {
                return Err(CloseoutError::MissingStage(required));
            }
        }
        let ordered = RmcStage::REQUIRED
            .into_iter()
            .filter_map(|stage| by_stage.remove(&stage))
            .collect::<Vec<_>>();
        if ordered.len() != REQUIRED_STAGE_COUNT {
            return Err(CloseoutError::PipelineNotMonotonic);
        }

        let commitment = closeout_commitment(&ordered, counts, economics, &evidence);
        Ok(Self {
            stages: ordered,
            counts,
            economics,
            evidence,
            commitment,
        })
    }

    pub const fn real_market_census_closed(&self) -> bool {
        true
    }

    pub const fn status(&self) -> &'static str {
        "REAL_MARKET_CENSUS_CLOSED"
    }

    pub fn stages(&self) -> &[StageProof] {
        &self.stages
    }

    pub const fn counts(&self) -> PipelineCounts {
        self.counts
    }

    pub const fn economics(&self) -> EconomicBoundary {
        self.economics
    }

    pub fn evidence(&self) -> &[Hash32] {
        &self.evidence
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }

    pub fn commitment_hex(&self) -> String {
        hex_encode(&self.commitment)
    }
}

fn closeout_commitment(
    stages: &[StageProof],
    counts: PipelineCounts,
    economics: EconomicBoundary,
    evidence: &[Hash32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(CLOSEOUT_DOMAIN);
    hasher.update([0]);
    for proof in stages {
        hasher.update([proof.stage.tag()]);
        hasher.update(proof.code_commit.as_bytes());
        hasher.update(proof.code_tree.as_bytes());
        hasher.update(proof.artifact_sha256.as_bytes());
        hasher.update(proof.authority_commitment.as_bytes());
        hasher.update(proof.coverage_commitment.as_bytes());
        hasher.update([u8::from(proof.admitted)]);
        hasher.update([u8::from(proof.coverage_complete)]);
        hasher.update(proof.unresolved_mismatch_count.to_be_bytes());
        hasher.update(proof.unknown_failure_count.to_be_bytes());
        hasher.update(proof.blocker_count.to_be_bytes());
        hasher.update(
            u64::try_from(proof.evidence.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for item in &proof.evidence {
            hasher.update(item.as_bytes());
        }
    }
    counts.encode(&mut hasher);
    economics.encode(&mut hasher);
    hasher.update(
        u64::try_from(evidence.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for item in evidence {
        hasher.update(item.as_bytes());
    }
    hasher.finalize().into()
}

fn hex_nibble(byte: u8) -> Result<u8, CloseoutError> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(CloseoutError::InvalidGitObjectId),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(TABLE[usize::from(byte >> 4)]));
        out.push(char::from(TABLE[usize::from(byte & 0x0f)]));
    }
    out
}
