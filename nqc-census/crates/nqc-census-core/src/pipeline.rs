use crate::{ActionSurfaceId, ChainDomain, Hash32, MarketId, ObservationDigest, ProtocolFamily};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

const UNIT_MARKET_DOMAIN: &[u8] = b"NQC-CENSUS-UNIT-MARKET-V1";
const UNIT_ACTION_DOMAIN: &[u8] = b"NQC-CENSUS-UNIT-ACTION-V1";
const UNIT_SCOPED_DOMAIN: &[u8] = b"NQC-CENSUS-UNIT-SCOPED-V1";
const REJECTION_RECORD_DOMAIN: &[u8] = b"NQC-CENSUS-REJECTION-RECORD-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CensusStage {
    MarketsDiscovered,
    MarketsCanonicalized,
    MarketsStateReconstructable,
    MarketsEconomicallyActive,
    MarketsBorrowable,
    MarketsLiquidatableOrActionable,
    MarketsCapitalFeasible,
    MarketsExecutionSimulatable,
    MarketsPositiveGrossEv,
    MarketsPositiveNetEv,
    MarketsPositiveTailAdjustedEv,
    MarketsCapacityMaterial,
    MarketsShadowEligible,
}

impl CensusStage {
    pub const ALL: [Self; 13] = [
        Self::MarketsDiscovered,
        Self::MarketsCanonicalized,
        Self::MarketsStateReconstructable,
        Self::MarketsEconomicallyActive,
        Self::MarketsBorrowable,
        Self::MarketsLiquidatableOrActionable,
        Self::MarketsCapitalFeasible,
        Self::MarketsExecutionSimulatable,
        Self::MarketsPositiveGrossEv,
        Self::MarketsPositiveNetEv,
        Self::MarketsPositiveTailAdjustedEv,
        Self::MarketsCapacityMaterial,
        Self::MarketsShadowEligible,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::MarketsDiscovered => "MARKETS_DISCOVERED",
            Self::MarketsCanonicalized => "MARKETS_CANONICALIZED",
            Self::MarketsStateReconstructable => "MARKETS_STATE_RECONSTRUCTABLE",
            Self::MarketsEconomicallyActive => "MARKETS_ECONOMICALLY_ACTIVE",
            Self::MarketsBorrowable => "MARKETS_BORROWABLE",
            Self::MarketsLiquidatableOrActionable => "MARKETS_LIQUIDATABLE_OR_ACTIONABLE",
            Self::MarketsCapitalFeasible => "MARKETS_CAPITAL_FEASIBLE",
            Self::MarketsExecutionSimulatable => "MARKETS_EXECUTION_SIMULATABLE",
            Self::MarketsPositiveGrossEv => "MARKETS_POSITIVE_GROSS_EV",
            Self::MarketsPositiveNetEv => "MARKETS_POSITIVE_NET_EV",
            Self::MarketsPositiveTailAdjustedEv => "MARKETS_POSITIVE_TAIL_ADJUSTED_EV",
            Self::MarketsCapacityMaterial => "MARKETS_CAPACITY_MATERIAL",
            Self::MarketsShadowEligible => "MARKETS_SHADOW_ELIGIBLE",
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::MarketsDiscovered => 1,
            Self::MarketsCanonicalized => 2,
            Self::MarketsStateReconstructable => 3,
            Self::MarketsEconomicallyActive => 4,
            Self::MarketsBorrowable => 5,
            Self::MarketsLiquidatableOrActionable => 6,
            Self::MarketsCapitalFeasible => 7,
            Self::MarketsExecutionSimulatable => 8,
            Self::MarketsPositiveGrossEv => 9,
            Self::MarketsPositiveNetEv => 10,
            Self::MarketsPositiveTailAdjustedEv => 11,
            Self::MarketsCapacityMaterial => 12,
            Self::MarketsShadowEligible => 13,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EvidenceBasis {
    Proven,
    Derived,
    Assumed,
    NotTested,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RejectionReason {
    NoActiveState,
    NoBorrowers,
    NoLiquidity,
    InsufficientFlashCapital,
    UnprofitableAfterGas,
    UnprofitableAfterSwap,
    OracleStale,
    MarketPaused,
    CapReached,
    UnsupportedTokenBehavior,
    RouteUnavailable,
    NonAtomicCapitalRequirement,
    MevNegative,
    StateUnreconstructable,
    UnsupportedCapability,
    UnsupportedProtocolVersion,
    Unknown,
}

impl RejectionReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::NoActiveState => "NO_ACTIVE_STATE",
            Self::NoBorrowers => "NO_BORROWERS",
            Self::NoLiquidity => "NO_LIQUIDITY",
            Self::InsufficientFlashCapital => "INSUFFICIENT_FLASH_CAPITAL",
            Self::UnprofitableAfterGas => "UNPROFITABLE_AFTER_GAS",
            Self::UnprofitableAfterSwap => "UNPROFITABLE_AFTER_SWAP",
            Self::OracleStale => "ORACLE_STALE",
            Self::MarketPaused => "MARKET_PAUSED",
            Self::CapReached => "CAP_REACHED",
            Self::UnsupportedTokenBehavior => "UNSUPPORTED_TOKEN_BEHAVIOR",
            Self::RouteUnavailable => "ROUTE_UNAVAILABLE",
            Self::NonAtomicCapitalRequirement => "NON_ATOMIC_CAPITAL_REQUIREMENT",
            Self::MevNegative => "MEV_NEGATIVE",
            Self::StateUnreconstructable => "STATE_UNRECONSTRUCTABLE",
            Self::UnsupportedCapability => "UNSUPPORTED_CAPABILITY",
            Self::UnsupportedProtocolVersion => "UNSUPPORTED_PROTOCOL_VERSION",
            Self::Unknown => "UNKNOWN",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockerId(String);

impl BlockerId {
    pub fn parse(value: &str) -> Result<Self, PipelineError> {
        let Some(suffix) = value.strip_prefix("RMC-GAP-") else {
            return Err(PipelineError::InvalidBlockerId);
        };
        if suffix.len() != 3 || !suffix.bytes().all(|byte| byte.is_ascii_digit()) || suffix == "000"
        {
            return Err(PipelineError::InvalidBlockerId);
        }
        Ok(Self(value.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EvidenceRef {
    Observation(ObservationDigest),
    Artifact(Hash32),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StageDecision {
    Advance,
    Reject(RejectionReason),
    Unknown {
        reason: RejectionReason,
        blocker: BlockerId,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageEvidence {
    stage: CensusStage,
    basis: EvidenceBasis,
    decision: StageDecision,
    evidence_refs: Vec<EvidenceRef>,
}

impl StageEvidence {
    pub fn new(
        stage: CensusStage,
        basis: EvidenceBasis,
        decision: StageDecision,
        mut evidence_refs: Vec<EvidenceRef>,
    ) -> Result<Self, PipelineError> {
        evidence_refs.sort_unstable();
        evidence_refs.dedup();

        match &decision {
            StageDecision::Advance => {
                if basis == EvidenceBasis::NotTested {
                    return Err(PipelineError::NotTestedCannotAdvance);
                }
                if evidence_refs.is_empty() {
                    return Err(PipelineError::MissingEvidenceReference);
                }
            }
            StageDecision::Reject(reason) => {
                if *reason == RejectionReason::Unknown {
                    return Err(PipelineError::UnknownMustCarryBlocker);
                }
                if basis == EvidenceBasis::NotTested {
                    return Err(PipelineError::NotTestedMustBeUnknown);
                }
                if evidence_refs.is_empty() {
                    return Err(PipelineError::MissingEvidenceReference);
                }
            }
            StageDecision::Unknown { reason, .. } => {
                if *reason != RejectionReason::Unknown {
                    return Err(PipelineError::UnknownMustUseUnknownReason);
                }
                if basis != EvidenceBasis::NotTested {
                    return Err(PipelineError::UnknownMustBeNotTested);
                }
            }
        }

        Ok(Self {
            stage,
            basis,
            decision,
            evidence_refs,
        })
    }

    pub const fn stage(&self) -> CensusStage {
        self.stage
    }

    pub const fn basis(&self) -> EvidenceBasis {
        self.basis
    }

    pub const fn decision(&self) -> &StageDecision {
        &self.decision
    }

    pub fn evidence_refs(&self) -> &[EvidenceRef] {
        &self.evidence_refs
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CensusUnitId([u8; 32]);

impl CensusUnitId {
    pub fn from_market(market_id: MarketId) -> Self {
        Self(domain_hash(UNIT_MARKET_DOMAIN, market_id.as_bytes()))
    }

    pub fn from_action_surface(action_surface_id: ActionSurfaceId) -> Self {
        Self(domain_hash(
            UNIT_ACTION_DOMAIN,
            action_surface_id.as_bytes(),
        ))
    }

    pub fn from_scoped_hash(namespace: u16, hash: Hash32) -> Result<Self, PipelineError> {
        if namespace == 0 {
            return Err(PipelineError::ZeroNamespace);
        }
        let mut payload = Vec::with_capacity(34);
        payload.extend_from_slice(&namespace.to_be_bytes());
        payload.extend_from_slice(hash.as_bytes());
        Ok(Self(domain_hash(UNIT_SCOPED_DOMAIN, &payload)))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CensusUnitKind {
    Market,
    ActionSurface,
    Account,
    Candidate,
    Opportunity,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StageDomain {
    chain: ChainDomain,
    protocol: ProtocolFamily,
    unit_kind: CensusUnitKind,
}

impl StageDomain {
    pub const fn new(
        chain: ChainDomain,
        protocol: ProtocolFamily,
        unit_kind: CensusUnitKind,
    ) -> Self {
        Self {
            chain,
            protocol,
            unit_kind,
        }
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn protocol(&self) -> ProtocolFamily {
        self.protocol
    }

    pub const fn unit_kind(&self) -> CensusUnitKind {
        self.unit_kind
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageRecord {
    domain: StageDomain,
    unit_id: CensusUnitId,
    evidence: StageEvidence,
}

impl StageRecord {
    pub const fn new(domain: StageDomain, unit_id: CensusUnitId, evidence: StageEvidence) -> Self {
        Self {
            domain,
            unit_id,
            evidence,
        }
    }

    pub const fn domain(&self) -> &StageDomain {
        &self.domain
    }

    pub const fn unit_id(&self) -> CensusUnitId {
        self.unit_id
    }

    pub const fn evidence(&self) -> &StageEvidence {
        &self.evidence
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RejectionRecordId([u8; 32]);

impl RejectionRecordId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RejectionRecord {
    id: RejectionRecordId,
    domain: StageDomain,
    unit_id: CensusUnitId,
    stage: CensusStage,
    reason: RejectionReason,
    blocker: Option<BlockerId>,
    evidence_refs: Vec<EvidenceRef>,
}

impl RejectionRecord {
    fn from_stage(record: &StageRecord) -> Option<Self> {
        let (reason, blocker) = match record.evidence().decision() {
            StageDecision::Advance => return None,
            StageDecision::Reject(reason) => (*reason, None),
            StageDecision::Unknown { reason, blocker } => (*reason, Some(blocker.clone())),
        };
        let id = rejection_record_id(
            record.unit_id(),
            record.evidence().stage(),
            reason,
            blocker.as_ref(),
            record.evidence().evidence_refs(),
        );
        Some(Self {
            id,
            domain: record.domain().clone(),
            unit_id: record.unit_id(),
            stage: record.evidence().stage(),
            reason,
            blocker,
            evidence_refs: record.evidence().evidence_refs().to_vec(),
        })
    }

    pub const fn id(&self) -> RejectionRecordId {
        self.id
    }

    pub const fn domain(&self) -> &StageDomain {
        &self.domain
    }

    pub const fn unit_id(&self) -> CensusUnitId {
        self.unit_id
    }

    pub const fn stage(&self) -> CensusStage {
        self.stage
    }

    pub const fn reason(&self) -> RejectionReason {
        self.reason
    }

    pub fn blocker(&self) -> Option<&BlockerId> {
        self.blocker.as_ref()
    }

    pub fn evidence_refs(&self) -> &[EvidenceRef] {
        &self.evidence_refs
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StageMetrics {
    pub input_count: usize,
    pub advanced_count: usize,
    pub rejected_count: usize,
    pub unknown_count: usize,
    pub proven_count: usize,
    pub derived_count: usize,
    pub assumed_count: usize,
    pub not_tested_count: usize,
}

impl StageMetrics {
    pub const fn is_conserved(&self) -> bool {
        self.input_count == self.advanced_count + self.rejected_count + self.unknown_count
            && self.input_count
                == self.proven_count
                    + self.derived_count
                    + self.assumed_count
                    + self.not_tested_count
    }
}

#[derive(Debug, Default)]
pub struct StageLedger {
    records: BTreeMap<(StageDomain, CensusUnitId, CensusStage), StageRecord>,
}

impl StageLedger {
    pub fn record(&mut self, record: StageRecord) -> Result<(), PipelineError> {
        let key = (
            record.domain().clone(),
            record.unit_id(),
            record.evidence().stage(),
        );
        if self.records.contains_key(&key) {
            return Err(PipelineError::DuplicateStageRecord);
        }
        self.records.insert(key, record);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn metrics(&self, domain: &StageDomain, stage: CensusStage) -> StageMetrics {
        let mut metrics = StageMetrics {
            input_count: 0,
            advanced_count: 0,
            rejected_count: 0,
            unknown_count: 0,
            proven_count: 0,
            derived_count: 0,
            assumed_count: 0,
            not_tested_count: 0,
        };

        for record in self.records.values() {
            if record.domain() != domain || record.evidence().stage() != stage {
                continue;
            }
            metrics.input_count += 1;
            match record.evidence().decision() {
                StageDecision::Advance => metrics.advanced_count += 1,
                StageDecision::Reject(_) => metrics.rejected_count += 1,
                StageDecision::Unknown { .. } => metrics.unknown_count += 1,
            }
            match record.evidence().basis() {
                EvidenceBasis::Proven => metrics.proven_count += 1,
                EvidenceBasis::Derived => metrics.derived_count += 1,
                EvidenceBasis::Assumed => metrics.assumed_count += 1,
                EvidenceBasis::NotTested => metrics.not_tested_count += 1,
            }
        }
        metrics
    }

    pub fn rejection_records(&self) -> Vec<RejectionRecord> {
        self.records
            .values()
            .filter_map(RejectionRecord::from_stage)
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PipelineError {
    InvalidBlockerId,
    ZeroNamespace,
    MissingEvidenceReference,
    NotTestedCannotAdvance,
    NotTestedMustBeUnknown,
    UnknownMustCarryBlocker,
    UnknownMustUseUnknownReason,
    UnknownMustBeNotTested,
    DuplicateStageRecord,
}

impl Display for PipelineError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidBlockerId => formatter.write_str("invalid RMC blocker id"),
            Self::ZeroNamespace => formatter.write_str("unit namespace must not be zero"),
            Self::MissingEvidenceReference => {
                formatter.write_str("proven, derived, or assumed stage decision requires evidence")
            }
            Self::NotTestedCannotAdvance => {
                formatter.write_str("NOT_TESTED evidence cannot advance a stage")
            }
            Self::NotTestedMustBeUnknown => {
                formatter.write_str("NOT_TESTED evidence must use UNKNOWN decision")
            }
            Self::UnknownMustCarryBlocker => {
                formatter.write_str("UNKNOWN rejection cannot be recorded without a blocker")
            }
            Self::UnknownMustUseUnknownReason => {
                formatter.write_str("UNKNOWN decision must use UNKNOWN reason")
            }
            Self::UnknownMustBeNotTested => {
                formatter.write_str("UNKNOWN decision must be classified NOT_TESTED")
            }
            Self::DuplicateStageRecord => {
                formatter.write_str("duplicate stage decision for the same domain and unit")
            }
        }
    }
}

impl std::error::Error for PipelineError {}

fn rejection_record_id(
    unit_id: CensusUnitId,
    stage: CensusStage,
    reason: RejectionReason,
    blocker: Option<&BlockerId>,
    evidence_refs: &[EvidenceRef],
) -> RejectionRecordId {
    let mut hasher = Sha256::new();
    hasher.update(REJECTION_RECORD_DOMAIN);
    hasher.update([0]);
    hasher.update(unit_id.as_bytes());
    hasher.update([stage.tag()]);
    hasher.update(reason.code().as_bytes());
    if let Some(blocker) = blocker {
        hasher.update([1]);
        hasher.update(blocker.as_str().as_bytes());
    } else {
        hasher.update([0]);
    }
    for evidence in evidence_refs {
        match evidence {
            EvidenceRef::Observation(digest) => {
                hasher.update([1]);
                hasher.update(digest.as_bytes());
            }
            EvidenceRef::Artifact(hash) => {
                hasher.update([2]);
                hasher.update(hash.as_bytes());
            }
        }
    }
    RejectionRecordId(finalize_hash(hasher))
}

fn domain_hash(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    finalize_hash(hasher)
}

fn finalize_hash(hasher: Sha256) -> [u8; 32] {
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}
