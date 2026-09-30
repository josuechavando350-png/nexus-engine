//! RMC-013 exact execution economics and capture semantics.
//!
//! RMC-012 removes portfolio double counting. This crate makes the next
//! boundary explicit: gross opportunity is not realized P&L. Every quote
//! carries a complete cost vector, exact capture calibration, nonlinear size,
//! and deterministic evidence commitment. No network or transaction authority
//! exists here.

use nqc_census_capital::{Amount256, CapitalError};
use nqc_census_core::{Hash32, StateAnchor};
use nqc_census_portfolio::{PortfolioCandidate, PortfolioCandidateId};
use sha2::{Digest, Sha256};
use std::{
    cmp::Ordering,
    collections::BTreeSet,
    fmt::{Display, Formatter},
};

pub const WAD: u64 = 1_000_000_000_000_000_000;
const QUOTE_DOMAIN: &[u8] = b"NQC-RMC013-EXECUTION-QUOTE-V2";
const CURVE_DOMAIN: &[u8] = b"NQC-RMC013-CAPACITY-CURVE-V2";
const SHADOW_PREDICTION_DOMAIN: &[u8] = b"NQC-RMC013-SHADOW-PREDICTION-V1";
const SHADOW_BATCH_DOMAIN: &[u8] = b"NQC-RMC013-SHADOW-BATCH-V1";
const USD_WAD_UNIT_DOMAIN: &[u8] = b"NQC-RMC013-USD-WAD-VALUATION-UNIT-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EconomicsError {
    ZeroValue(&'static str),
    InvalidProbability(u64),
    MissingCostKind(CostKind),
    DuplicateCostKind(CostKind),
    MissingEvidence,
    DuplicateEvidence,
    MissingCommitment(&'static str),
    MissingEvidenceCommitment(&'static str),
    CandidateAnchorMismatch,
    AmountOverflow,
    ProbabilityArithmeticOverflow,
    CaptureSamplesRequired,
    InvalidCaptureInterval,
    InvalidTailBound,
    ProfitBucketRequiresUsdWad,
    CurveEmpty,
    CurveCandidateMismatch,
    CurveAnchorMismatch,
    CurveValuationUnitMismatch,
    CurveOpportunityMismatch,
    CurveExecutionPlanMismatch,
    CurveEconomicModelMismatch,
    CurveTradeSizeNotStrictlyIncreasing,
    ScenarioEmpty,
    ScenarioProbabilityNotOne,
    ShadowExpiryNotAfterAnchor,
    ShadowDuplicateCandidate,
}

impl Display for EconomicsError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroValue(name) => write!(f, "{name} must not be zero"),
            Self::InvalidProbability(value) => write!(f, "probability WAD exceeds 1e18: {value}"),
            Self::MissingCostKind(kind) => write!(f, "execution cost vector omits {kind:?}"),
            Self::DuplicateCostKind(kind) => write!(f, "execution cost vector repeats {kind:?}"),
            Self::MissingEvidence => f.write_str("economics record requires evidence"),
            Self::DuplicateEvidence => f.write_str("economics record repeats evidence"),
            Self::MissingCommitment(name) => write!(f, "{name} commitment must be non-zero"),
            Self::MissingEvidenceCommitment(name) => {
                write!(f, "{name} evidence commitment must be non-zero")
            }
            Self::CandidateAnchorMismatch => {
                f.write_str("execution quote anchor differs from its RMC-012 candidate")
            }
            Self::AmountOverflow => f.write_str("uint256 economics amount overflow"),
            Self::ProbabilityArithmeticOverflow => {
                f.write_str("probability-weighted arithmetic overflow")
            }
            Self::CaptureSamplesRequired => {
                f.write_str("empirical capture calibration requires observations")
            }
            Self::InvalidCaptureInterval => {
                f.write_str("capture probability interval is not ordered")
            }
            Self::InvalidTailBound => f.write_str("tail-risk bound is internally inconsistent"),
            Self::ProfitBucketRequiresUsdWad => {
                f.write_str("profit buckets require the canonical USD-WAD valuation unit")
            }
            Self::CurveEmpty => f.write_str("capacity curve is empty"),
            Self::CurveCandidateMismatch => {
                f.write_str("capacity curve mixes execution candidates")
            }
            Self::CurveAnchorMismatch => f.write_str("capacity curve mixes state anchors"),
            Self::CurveValuationUnitMismatch => f.write_str("capacity curve mixes valuation units"),
            Self::CurveOpportunityMismatch => {
                f.write_str("capacity curve mixes distinct economic opportunities")
            }
            Self::CurveExecutionPlanMismatch => {
                f.write_str("capacity curve mixes distinct execution plans")
            }
            Self::CurveEconomicModelMismatch => {
                f.write_str("capacity curve mixes distinct economic models")
            }
            Self::CurveTradeSizeNotStrictlyIncreasing => {
                f.write_str("capacity curve trade sizes are not strictly increasing")
            }
            Self::ScenarioEmpty => f.write_str("scenario distribution is empty"),
            Self::ScenarioProbabilityNotOne => {
                f.write_str("scenario probabilities must sum to exactly 1e18")
            }
            Self::ShadowExpiryNotAfterAnchor => {
                f.write_str("shadow prediction expiry must be after its observation anchor")
            }
            Self::ShadowDuplicateCandidate => {
                f.write_str("shadow prediction batch repeats a candidate")
            }
        }
    }
}

impl std::error::Error for EconomicsError {}

impl From<CapitalError> for EconomicsError {
    fn from(_: CapitalError) -> Self {
        Self::AmountOverflow
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ValuationUnitId([u8; 32]);

impl ValuationUnitId {
    pub fn from_commitment(commitment: Hash32) -> Self {
        Self(*commitment.as_bytes())
    }

    /// Canonical cross-market valuation unit: USD with 18 decimal places.
    /// The identity is domain-separated rather than a human-readable symbol.
    pub fn usd_wad() -> Self {
        let mut hasher = Sha256::new();
        hasher.update(USD_WAD_UNIT_DOMAIN);
        hasher.update([0]);
        Self(hasher.finalize().into())
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ProbabilityWad(u64);

impl ProbabilityWad {
    pub const ZERO: Self = Self(0);
    pub const ONE: Self = Self(WAD);

    pub fn new(value: u64) -> Result<Self, EconomicsError> {
        if value > WAD {
            return Err(EconomicsError::InvalidProbability(value));
        }
        Ok(Self(value))
    }

    pub const fn value(self) -> u64 {
        self.0
    }

    pub const fn complement(self) -> Self {
        Self(WAD - self.0)
    }

    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    /// Exact integer weighting rounded down: floor(amount * p / 1e18).
    ///
    /// This works across the full uint256 domain without floating point.
    pub fn apply_floor(self, amount: Amount256) -> Result<Amount256, EconomicsError> {
        let (quotient, remainder) = div_mod_u64(amount, WAD)?;
        let major = mul_u64_checked(quotient, self.0)?;
        let minor_numerator = u128::from(remainder)
            .checked_mul(u128::from(self.0))
            .ok_or(EconomicsError::ProbabilityArithmeticOverflow)?;
        let minor = minor_numerator / u128::from(WAD);
        major
            .checked_add(Amount256::from_u128(minor))
            .map_err(|_| EconomicsError::AmountOverflow)
    }

    /// Exact integer weighting rounded up. Costs and losses use this so
    /// integer rounding can never make an opportunity look more profitable.
    pub fn apply_ceil(self, amount: Amount256) -> Result<Amount256, EconomicsError> {
        let (quotient, remainder) = div_mod_u64(amount, WAD)?;
        let major = mul_u64_checked(quotient, self.0)?;
        let numerator = u128::from(remainder)
            .checked_mul(u128::from(self.0))
            .ok_or(EconomicsError::ProbabilityArithmeticOverflow)?;
        let divisor = u128::from(WAD);
        let minor = if numerator == 0 {
            0
        } else {
            numerator
                .checked_add(divisor - 1)
                .ok_or(EconomicsError::ProbabilityArithmeticOverflow)?
                / divisor
        };
        major
            .checked_add(Amount256::from_u128(minor))
            .map_err(|_| EconomicsError::AmountOverflow)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SignedAmount {
    negative: bool,
    magnitude: Amount256,
}

impl SignedAmount {
    pub const ZERO: Self = Self {
        negative: false,
        magnitude: Amount256::ZERO,
    };

    pub fn positive(magnitude: Amount256) -> Self {
        Self {
            negative: false,
            magnitude,
        }
    }

    pub fn negative(magnitude: Amount256) -> Self {
        if magnitude.is_zero() {
            Self::ZERO
        } else {
            Self {
                negative: true,
                magnitude,
            }
        }
    }

    pub fn from_difference(
        positive: Amount256,
        negative: Amount256,
    ) -> Result<Self, EconomicsError> {
        match positive.cmp(&negative) {
            Ordering::Greater | Ordering::Equal => Ok(Self::positive(
                positive
                    .checked_sub(negative)
                    .map_err(|_| EconomicsError::AmountOverflow)?,
            )),
            Ordering::Less => Ok(Self::negative(
                negative
                    .checked_sub(positive)
                    .map_err(|_| EconomicsError::AmountOverflow)?,
            )),
        }
    }

    pub const fn is_negative(self) -> bool {
        self.negative
    }

    pub fn is_positive(self) -> bool {
        !self.negative && !self.magnitude.is_zero()
    }

    pub const fn magnitude(self) -> Amount256 {
        self.magnitude
    }

    pub fn checked_add(self, rhs: Self) -> Result<Self, EconomicsError> {
        match (self.negative, rhs.negative) {
            (false, false) => Ok(Self::positive(
                self.magnitude
                    .checked_add(rhs.magnitude)
                    .map_err(|_| EconomicsError::AmountOverflow)?,
            )),
            (true, true) => Ok(Self::negative(
                self.magnitude
                    .checked_add(rhs.magnitude)
                    .map_err(|_| EconomicsError::AmountOverflow)?,
            )),
            (false, true) => Self::from_difference(self.magnitude, rhs.magnitude),
            (true, false) => Self::from_difference(rhs.magnitude, self.magnitude),
        }
    }

    pub fn weighted(self, probability: ProbabilityWad) -> Result<Self, EconomicsError> {
        let magnitude = if self.negative {
            probability.apply_ceil(self.magnitude)?
        } else {
            probability.apply_floor(self.magnitude)?
        };
        Ok(if self.negative {
            Self::negative(magnitude)
        } else {
            Self::positive(magnitude)
        })
    }

    pub fn subtract_unsigned(self, rhs: Amount256) -> Result<Self, EconomicsError> {
        if self.negative {
            return Ok(Self::negative(
                self.magnitude
                    .checked_add(rhs)
                    .map_err(|_| EconomicsError::AmountOverflow)?,
            ));
        }
        Self::from_difference(self.magnitude, rhs)
    }
}

impl Ord for SignedAmount {
    fn cmp(&self, other: &Self) -> Ordering {
        match (self.negative, other.negative) {
            (false, true) => Ordering::Greater,
            (true, false) => Ordering::Less,
            (false, false) => self.magnitude.cmp(&other.magnitude),
            (true, true) => other.magnitude.cmp(&self.magnitude),
        }
    }
}

impl PartialOrd for SignedAmount {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CostKind {
    ProtocolFee,
    CapitalFee,
    SwapFee,
    PriceImpact,
    Gas,
    PriorityFee,
    BuilderPayment,
    Financing,
    Hedging,
    Inventory,
    ExpectedFailureRevert,
    OpportunityCost,
    Mev,
    ChainSpecific,
}

impl CostKind {
    pub const ALL: [Self; 14] = [
        Self::ProtocolFee,
        Self::CapitalFee,
        Self::SwapFee,
        Self::PriceImpact,
        Self::Gas,
        Self::PriorityFee,
        Self::BuilderPayment,
        Self::Financing,
        Self::Hedging,
        Self::Inventory,
        Self::ExpectedFailureRevert,
        Self::OpportunityCost,
        Self::Mev,
        Self::ChainSpecific,
    ];

    const fn tag(self) -> u8 {
        match self {
            Self::ProtocolFee => 1,
            Self::CapitalFee => 2,
            Self::SwapFee => 3,
            Self::PriceImpact => 4,
            Self::Gas => 5,
            Self::PriorityFee => 6,
            Self::BuilderPayment => 7,
            Self::Financing => 8,
            Self::Hedging => 9,
            Self::Inventory => 10,
            Self::ExpectedFailureRevert => 11,
            Self::OpportunityCost => 12,
            Self::Mev => 13,
            Self::ChainSpecific => 14,
        }
    }
}

/// One complete cost category.
///
/// unconditional is incurred independently of capture.
/// on_capture is incurred only on a successful capture.
/// on_failure is incurred only when capture fails.
///
/// This separation prevents the incorrect shortcut of multiplying every cost
/// by capture probability.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CostComponent {
    pub kind: CostKind,
    pub unconditional: Amount256,
    pub on_capture: Amount256,
    pub on_failure: Amount256,
    pub evidence: Hash32,
}

impl CostComponent {
    pub const fn new(
        kind: CostKind,
        unconditional: Amount256,
        on_capture: Amount256,
        on_failure: Amount256,
        evidence: Hash32,
    ) -> Self {
        Self {
            kind,
            unconditional,
            on_capture,
            on_failure,
            evidence,
        }
    }

    fn success_cost(self) -> Result<Amount256, EconomicsError> {
        self.unconditional
            .checked_add(self.on_capture)
            .map_err(|_| EconomicsError::AmountOverflow)
    }

    fn expected_cost(self, capture: ProbabilityWad) -> Result<Amount256, EconomicsError> {
        self.unconditional
            .checked_add(capture.apply_ceil(self.on_capture)?)
            .map_err(|_| EconomicsError::AmountOverflow)?
            .checked_add(capture.complement().apply_ceil(self.on_failure)?)
            .map_err(|_| EconomicsError::AmountOverflow)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionCostVector {
    components: Vec<CostComponent>,
}

impl ExecutionCostVector {
    pub fn new(mut components: Vec<CostComponent>) -> Result<Self, EconomicsError> {
        components.sort_by_key(|component| component.kind);
        let mut seen = BTreeSet::new();
        for component in &components {
            if is_zero_hash(component.evidence) {
                return Err(EconomicsError::MissingEvidenceCommitment("cost_component"));
            }
            if !seen.insert(component.kind) {
                return Err(EconomicsError::DuplicateCostKind(component.kind));
            }
        }
        for required in CostKind::ALL {
            if !seen.contains(&required) {
                return Err(EconomicsError::MissingCostKind(required));
            }
        }
        Ok(Self { components })
    }

    pub fn components(&self) -> &[CostComponent] {
        &self.components
    }

    pub fn success_total(&self) -> Result<Amount256, EconomicsError> {
        let mut total = Amount256::ZERO;
        for component in &self.components {
            total = total
                .checked_add(component.success_cost()?)
                .map_err(|_| EconomicsError::AmountOverflow)?;
        }
        Ok(total)
    }

    pub fn expected_total(&self, capture: ProbabilityWad) -> Result<Amount256, EconomicsError> {
        let mut total = Amount256::ZERO;
        for component in &self.components {
            total = total
                .checked_add(component.expected_cost(capture)?)
                .map_err(|_| EconomicsError::AmountOverflow)?;
        }
        Ok(total)
    }

    /// Maximum integer-only downward deviation that can occur inside a
    /// non-degenerate capture-probability interval relative to the smaller
    /// discretely evaluated endpoint.
    ///
    /// The underlying rational expectation is affine, but conservative
    /// floor/ceil operations make the integer result a staircase. With N
    /// probability-dependent rounded terms, every discrete value is strictly
    /// less than N atomic valuation units below its rational counterpart.
    /// Since both endpoint and interior reports are integers, N-1 units are a
    /// sufficient fail-closed reserve.
    fn interval_rounding_reserve(&self, gross_value: Amount256) -> Amount256 {
        let mut rounded_terms = if gross_value.is_zero() {
            0_u128
        } else {
            1_u128
        };
        for component in &self.components {
            if !component.on_capture.is_zero() {
                rounded_terms += 1;
            }
            if !component.on_failure.is_zero() {
                rounded_terms += 1;
            }
        }
        Amount256::from_u128(rounded_terms.saturating_sub(1))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CaptureCalibration {
    Uncalibrated {
        model_commitment: Hash32,
    },
    ShadowCalibrated {
        lower: ProbabilityWad,
        point: ProbabilityWad,
        upper: ProbabilityWad,
        sample_count: u64,
        observation_window: Hash32,
        model_commitment: Hash32,
        evidence_commitment: Hash32,
    },
}

impl CaptureCalibration {
    /// Backward-compatible exact-point empirical calibration. New Shadow
    /// evidence should prefer an interval unless the uncertainty truly
    /// collapses to one point.
    pub fn empirical(
        probability: ProbabilityWad,
        sample_count: u64,
        observation_window: Hash32,
        model_commitment: Hash32,
        evidence_commitment: Hash32,
    ) -> Result<Self, EconomicsError> {
        Self::shadow_calibrated(
            probability,
            probability,
            probability,
            sample_count,
            observation_window,
            model_commitment,
            evidence_commitment,
        )
    }

    pub fn shadow_calibrated(
        lower: ProbabilityWad,
        point: ProbabilityWad,
        upper: ProbabilityWad,
        sample_count: u64,
        observation_window: Hash32,
        model_commitment: Hash32,
        evidence_commitment: Hash32,
    ) -> Result<Self, EconomicsError> {
        if sample_count == 0 {
            return Err(EconomicsError::CaptureSamplesRequired);
        }
        if lower > point || point > upper {
            return Err(EconomicsError::InvalidCaptureInterval);
        }
        for (name, commitment) in [
            ("capture_observation_window", observation_window),
            ("capture_model", model_commitment),
            ("capture_evidence", evidence_commitment),
        ] {
            if is_zero_hash(commitment) {
                return Err(EconomicsError::MissingEvidenceCommitment(name));
            }
        }
        Ok(Self::ShadowCalibrated {
            lower,
            point,
            upper,
            sample_count,
            observation_window,
            model_commitment,
            evidence_commitment,
        })
    }

    fn validate(&self) -> Result<(), EconomicsError> {
        match self {
            Self::Uncalibrated { model_commitment } => {
                if is_zero_hash(*model_commitment) {
                    return Err(EconomicsError::MissingEvidenceCommitment("capture_model"));
                }
            }
            Self::ShadowCalibrated {
                lower,
                point,
                upper,
                sample_count,
                observation_window,
                model_commitment,
                evidence_commitment,
            } => {
                if *sample_count == 0 {
                    return Err(EconomicsError::CaptureSamplesRequired);
                }
                if lower > point || point > upper {
                    return Err(EconomicsError::InvalidCaptureInterval);
                }
                for (name, commitment) in [
                    ("capture_observation_window", *observation_window),
                    ("capture_model", *model_commitment),
                    ("capture_evidence", *evidence_commitment),
                ] {
                    if is_zero_hash(commitment) {
                        return Err(EconomicsError::MissingEvidenceCommitment(name));
                    }
                }
            }
        }
        Ok(())
    }

    pub const fn point_probability(&self) -> Option<ProbabilityWad> {
        match self {
            Self::Uncalibrated { .. } => None,
            Self::ShadowCalibrated { point, .. } => Some(*point),
        }
    }

    pub const fn interval(&self) -> Option<(ProbabilityWad, ProbabilityWad)> {
        match self {
            Self::Uncalibrated { .. } => None,
            Self::ShadowCalibrated { lower, upper, .. } => Some((*lower, *upper)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailRiskBound {
    confidence: ProbabilityWad,
    loss_at_confidence: Amount256,
    absolute_max_loss: Amount256,
    reserve: Amount256,
    evidence: Hash32,
}

impl TailRiskBound {
    pub fn new(
        confidence: ProbabilityWad,
        loss_at_confidence: Amount256,
        absolute_max_loss: Amount256,
        reserve: Amount256,
        evidence: Hash32,
    ) -> Result<Self, EconomicsError> {
        if confidence.is_zero()
            || loss_at_confidence > absolute_max_loss
            || reserve < loss_at_confidence
            || reserve > absolute_max_loss
        {
            return Err(EconomicsError::InvalidTailBound);
        }
        if is_zero_hash(evidence) {
            return Err(EconomicsError::MissingEvidenceCommitment("tail_risk"));
        }
        Ok(Self {
            confidence,
            loss_at_confidence,
            absolute_max_loss,
            reserve,
            evidence,
        })
    }

    pub const fn confidence(self) -> ProbabilityWad {
        self.confidence
    }

    pub const fn loss_at_confidence(self) -> Amount256 {
        self.loss_at_confidence
    }

    pub const fn absolute_max_loss(self) -> Amount256 {
        self.absolute_max_loss
    }

    pub const fn reserve(self) -> Amount256 {
        self.reserve
    }

    pub const fn evidence(self) -> Hash32 {
        self.evidence
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GasValuation {
    gas_used: u64,
    effective_gas_price_wei: Amount256,
    native_usd_wad: Amount256,
    gas_wei: Amount256,
    gas_usd_wad: Amount256,
    price_evidence: Hash32,
}

impl GasValuation {
    pub fn new(
        gas_used: u64,
        effective_gas_price_wei: Amount256,
        native_usd_wad: Amount256,
        price_evidence: Hash32,
    ) -> Result<Self, EconomicsError> {
        if is_zero_hash(price_evidence) {
            return Err(EconomicsError::MissingEvidenceCommitment("gas_price"));
        }
        let gas_wei = mul_u64_checked(effective_gas_price_wei, gas_used)?;
        let gas_usd_wad = mul_div_floor(gas_wei, native_usd_wad, WAD)?;
        Ok(Self {
            gas_used,
            effective_gas_price_wei,
            native_usd_wad,
            gas_wei,
            gas_usd_wad,
            price_evidence,
        })
    }

    pub const fn gas_used(self) -> u64 {
        self.gas_used
    }

    pub const fn effective_gas_price_wei(self) -> Amount256 {
        self.effective_gas_price_wei
    }

    pub const fn native_usd_wad(self) -> Amount256 {
        self.native_usd_wad
    }

    pub const fn gas_wei(self) -> Amount256 {
        self.gas_wei
    }

    pub const fn gas_usd_wad(self) -> Amount256 {
        self.gas_usd_wad
    }

    pub const fn price_evidence(self) -> Hash32 {
        self.price_evidence
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfitBucket {
    ZeroToOne,
    OneToThree,
    ThreeToFive,
    FiveToTen,
    TenToTwenty,
    TwentyToFifty,
    FiftyToOneHundred,
    OneHundredToFiveHundred,
    FiveHundredPlus,
}

impl ProfitBucket {
    pub fn classify(
        valuation_unit: ValuationUnitId,
        value: SignedAmount,
    ) -> Result<Option<Self>, EconomicsError> {
        if valuation_unit != ValuationUnitId::usd_wad() {
            return Err(EconomicsError::ProfitBucketRequiresUsdWad);
        }
        if !value.is_positive() {
            return Ok(None);
        }
        let amount = value.magnitude();
        let usd = |dollars: u128| Amount256::from_u128(dollars * u128::from(WAD));
        Ok(Some(if amount < usd(1) {
            Self::ZeroToOne
        } else if amount < usd(3) {
            Self::OneToThree
        } else if amount < usd(5) {
            Self::ThreeToFive
        } else if amount < usd(10) {
            Self::FiveToTen
        } else if amount < usd(20) {
            Self::TenToTwenty
        } else if amount < usd(50) {
            Self::TwentyToFifty
        } else if amount < usd(100) {
            Self::FiftyToOneHundred
        } else if amount < usd(500) {
            Self::OneHundredToFiveHundred
        } else {
            Self::FiveHundredPlus
        }))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionQuote {
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    execution_plan_commitment: Hash32,
    economic_model_commitment: Hash32,
    anchor: StateAnchor,
    valuation_unit: ValuationUnitId,
    trade_size: Amount256,
    gross_value: Amount256,
    costs: ExecutionCostVector,
    capture: CaptureCalibration,
    tail: TailRiskBound,
    evidence: Vec<Hash32>,
    commitment: [u8; 32],
}

impl ExecutionQuote {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        candidate: &PortfolioCandidate,
        opportunity_id: Hash32,
        execution_plan_commitment: Hash32,
        economic_model_commitment: Hash32,
        anchor: StateAnchor,
        valuation_unit: ValuationUnitId,
        trade_size: Amount256,
        gross_value: Amount256,
        costs: ExecutionCostVector,
        capture: CaptureCalibration,
        tail: TailRiskBound,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, EconomicsError> {
        if candidate.anchor() != &anchor {
            return Err(EconomicsError::CandidateAnchorMismatch);
        }
        let candidate_id = candidate.id();
        if trade_size.is_zero() {
            return Err(EconomicsError::ZeroValue("trade_size"));
        }
        capture.validate()?;
        for (name, commitment) in [
            ("opportunity", opportunity_id),
            ("execution_plan", execution_plan_commitment),
            ("economic_model", economic_model_commitment),
        ] {
            if commitment.as_bytes().iter().all(|byte| *byte == 0) {
                return Err(EconomicsError::MissingCommitment(name));
            }
        }
        if evidence.is_empty() {
            return Err(EconomicsError::MissingEvidence);
        }
        if evidence.iter().copied().any(is_zero_hash) {
            return Err(EconomicsError::MissingEvidenceCommitment("quote"));
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(EconomicsError::DuplicateEvidence);
        }
        let commitment = quote_commitment(
            candidate_id,
            opportunity_id,
            execution_plan_commitment,
            economic_model_commitment,
            &anchor,
            valuation_unit,
            trade_size,
            gross_value,
            &costs,
            &capture,
            tail,
            &evidence,
        );
        Ok(Self {
            candidate_id,
            opportunity_id,
            execution_plan_commitment,
            economic_model_commitment,
            anchor,
            valuation_unit,
            trade_size,
            gross_value,
            costs,
            capture,
            tail,
            evidence,
            commitment,
        })
    }

    pub const fn candidate_id(&self) -> PortfolioCandidateId {
        self.candidate_id
    }

    pub const fn opportunity_id(&self) -> Hash32 {
        self.opportunity_id
    }

    pub const fn execution_plan_commitment(&self) -> Hash32 {
        self.execution_plan_commitment
    }

    pub const fn economic_model_commitment(&self) -> Hash32 {
        self.economic_model_commitment
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn valuation_unit(&self) -> ValuationUnitId {
        self.valuation_unit
    }

    pub const fn trade_size(&self) -> Amount256 {
        self.trade_size
    }

    pub const fn gross_value(&self) -> Amount256 {
        self.gross_value
    }

    pub const fn capture(&self) -> &CaptureCalibration {
        &self.capture
    }

    pub const fn tail(&self) -> TailRiskBound {
        self.tail
    }

    pub fn costs(&self) -> &ExecutionCostVector {
        &self.costs
    }

    pub fn evidence(&self) -> &[Hash32] {
        &self.evidence
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }

    fn net_at_probability(
        &self,
        probability: ProbabilityWad,
    ) -> Result<SignedAmount, EconomicsError> {
        let expected_gross = probability.apply_floor(self.gross_value)?;
        let expected_cost = self.costs.expected_total(probability)?;
        SignedAmount::from_difference(expected_gross, expected_cost)
    }

    pub fn evaluate(&self) -> Result<EconomicsReport, EconomicsError> {
        let success_cost = self.costs.success_total()?;
        let success_path_net = SignedAmount::from_difference(self.gross_value, success_cost)?;

        let point_capture_adjusted_net = match self.capture.point_probability() {
            None => None,
            Some(probability) => Some(self.net_at_probability(probability)?),
        };

        // The rational expectation is affine in capture probability, but the
        // intentionally conservative integer semantics are not: gross uses
        // floor while conditional costs use ceil. Those staircase jumps can
        // create a lower interior value even when both rational endpoints are
        // higher. Bound that discretization effect explicitly instead of
        // treating endpoint evaluation as exact.
        let interval_worst_case_net = match self.capture.interval() {
            None => None,
            Some((lower, upper)) => {
                let low = self.net_at_probability(lower)?;
                let high = self.net_at_probability(upper)?;
                let endpoint_min = low.min(high);
                if upper.value().saturating_sub(lower.value()) <= 1 {
                    Some(endpoint_min)
                } else {
                    Some(endpoint_min.subtract_unsigned(
                        self.costs.interval_rounding_reserve(self.gross_value),
                    )?)
                }
            }
        };
        let tail_adjusted_net = match interval_worst_case_net {
            None => None,
            Some(value) => Some(value.subtract_unsigned(self.tail.reserve())?),
        };

        let decision = if !success_path_net.is_positive() {
            QuoteDecision::NonPositivePreCaptureNet
        } else {
            match (interval_worst_case_net, tail_adjusted_net) {
                (None, _) => QuoteDecision::CaptureUncalibrated,
                (Some(value), _) if !value.is_positive() => {
                    QuoteDecision::NonPositiveCaptureAdjustedNet
                }
                (_, Some(value)) if value.is_positive() => QuoteDecision::Admitted,
                _ => QuoteDecision::NonPositiveTailAdjustedNet,
            }
        };

        Ok(EconomicsReport {
            success_cost,
            success_path_net,
            capture_adjusted_net: point_capture_adjusted_net,
            interval_worst_case_net,
            tail_adjusted_net,
            decision,
            quote_commitment: self.commitment,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuoteDecision {
    NonPositivePreCaptureNet,
    CaptureUncalibrated,
    NonPositiveCaptureAdjustedNet,
    NonPositiveTailAdjustedNet,
    Admitted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EconomicsReport {
    pub success_cost: Amount256,
    pub success_path_net: SignedAmount,
    /// Point-estimate expected net. This is never the admission authority.
    pub capture_adjusted_net: Option<SignedAmount>,
    /// Conservative integer lower bound for expected net across the
    /// calibrated capture interval. It includes an explicit atomic-unit
    /// reserve for floor/ceil staircase effects between the endpoints.
    pub interval_worst_case_net: Option<SignedAmount>,
    /// Interval-worst net after explicit tail reserve. Admission requires this
    /// value to remain positive.
    pub tail_adjusted_net: Option<SignedAmount>,
    pub decision: QuoteDecision,
    pub quote_commitment: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityCurve {
    points: Vec<ExecutionQuote>,
    commitment: [u8; 32],
}

impl CapacityCurve {
    pub fn new(mut points: Vec<ExecutionQuote>) -> Result<Self, EconomicsError> {
        if points.is_empty() {
            return Err(EconomicsError::CurveEmpty);
        }
        points.sort_by_key(ExecutionQuote::trade_size);
        let first = &points[0];
        let mut previous = None;
        for point in &points {
            if point.candidate_id() != first.candidate_id() {
                return Err(EconomicsError::CurveCandidateMismatch);
            }
            if point.anchor() != first.anchor() {
                return Err(EconomicsError::CurveAnchorMismatch);
            }
            if point.valuation_unit() != first.valuation_unit() {
                return Err(EconomicsError::CurveValuationUnitMismatch);
            }
            if point.opportunity_id() != first.opportunity_id() {
                return Err(EconomicsError::CurveOpportunityMismatch);
            }
            if point.execution_plan_commitment() != first.execution_plan_commitment() {
                return Err(EconomicsError::CurveExecutionPlanMismatch);
            }
            if point.economic_model_commitment() != first.economic_model_commitment() {
                return Err(EconomicsError::CurveEconomicModelMismatch);
            }
            if previous.is_some_and(|size| point.trade_size() <= size) {
                return Err(EconomicsError::CurveTradeSizeNotStrictlyIncreasing);
            }
            previous = Some(point.trade_size());
        }
        let mut hasher = Sha256::new();
        hasher.update(CURVE_DOMAIN);
        hasher.update([0]);
        for point in &points {
            hasher.update(point.commitment());
        }
        Ok(Self {
            points,
            commitment: hasher.finalize().into(),
        })
    }

    pub fn points(&self) -> &[ExecutionQuote] {
        &self.points
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }

    /// Select only among explicitly measured/simulated and empirically
    /// calibrated curve points. No interpolation or extrapolation is allowed.
    pub fn best_admitted_point(&self) -> Result<Option<&ExecutionQuote>, EconomicsError> {
        let mut best: Option<(&ExecutionQuote, SignedAmount)> = None;
        for point in &self.points {
            let report = point.evaluate()?;
            if report.decision != QuoteDecision::Admitted {
                continue;
            }
            let Some(value) = report.tail_adjusted_net else {
                continue;
            };
            match best {
                Some((_, current)) if current >= value => {}
                _ => best = Some((point, value)),
            }
        }
        Ok(best.map(|(point, _)| point))
    }

    /// Best explicitly measured/simulated point before any capture
    /// probability is assumed. This is the canonical RMC -> Shadow handoff
    /// selector and therefore remains usable when capture is UNCALIBRATED.
    pub fn best_pre_capture_point(&self) -> Result<Option<&ExecutionQuote>, EconomicsError> {
        let mut best: Option<(&ExecutionQuote, SignedAmount)> = None;
        for point in &self.points {
            let net = point.evaluate()?.success_path_net;
            if !net.is_positive() {
                continue;
            }
            match best {
                Some((current_point, current_net))
                    if current_net > net
                        || (current_net == net
                            && current_point.trade_size() <= point.trade_size()) => {}
                _ => best = Some((point, net)),
            }
        }
        Ok(best.map(|(point, _)| point))
    }

    /// Largest explicitly measured/simulated size whose interval-worst,
    /// tail-adjusted EV remains positive. This is a capacity boundary, not a
    /// license to extrapolate beyond the measured curve.
    pub fn largest_positive_size(&self) -> Result<Option<Amount256>, EconomicsError> {
        let mut largest = None;
        for point in &self.points {
            if point.evaluate()?.decision == QuoteDecision::Admitted {
                largest = Some(point.trade_size());
            }
        }
        Ok(largest)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowPrediction {
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    anchor: StateAnchor,
    curve_commitment: [u8; 32],
    quote_commitment: [u8; 32],
    execution_plan_commitment: Hash32,
    economic_model_commitment: Hash32,
    trade_size: Amount256,
    gross_value: Amount256,
    success_cost: Amount256,
    success_path_net: SignedAmount,
    expires_after_block: u64,
    evidence: Vec<Hash32>,
    commitment: [u8; 32],
}

impl ShadowPrediction {
    /// Build an ex-ante Shadow handoff from the best explicitly measured
    /// pre-capture point. Capture probability is intentionally not required:
    /// Shadow is the empirical authority that will calibrate it.
    pub fn from_curve(
        curve: &CapacityCurve,
        expires_after_block: u64,
        mut evidence: Vec<Hash32>,
    ) -> Result<Option<Self>, EconomicsError> {
        let Some(quote) = curve.best_pre_capture_point()? else {
            return Ok(None);
        };
        if expires_after_block <= quote.anchor().block_number() {
            return Err(EconomicsError::ShadowExpiryNotAfterAnchor);
        }
        if evidence.is_empty() {
            return Err(EconomicsError::MissingEvidence);
        }
        if evidence.iter().copied().any(is_zero_hash) {
            return Err(EconomicsError::MissingEvidenceCommitment(
                "shadow_prediction",
            ));
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(EconomicsError::DuplicateEvidence);
        }

        let report = quote.evaluate()?;
        let mut hasher = Sha256::new();
        hasher.update(SHADOW_PREDICTION_DOMAIN);
        hasher.update([0]);
        hasher.update(quote.candidate_id().as_bytes());
        hasher.update(quote.opportunity_id().as_bytes());
        encode_anchor(quote.anchor(), &mut hasher);
        hasher.update(curve.commitment());
        hasher.update(quote.commitment());
        hasher.update(quote.execution_plan_commitment().as_bytes());
        hasher.update(quote.economic_model_commitment().as_bytes());
        hasher.update(quote.trade_size().as_be_bytes());
        hasher.update(quote.gross_value().as_be_bytes());
        hasher.update(report.success_cost.as_be_bytes());
        hasher.update([u8::from(report.success_path_net.is_negative())]);
        hasher.update(report.success_path_net.magnitude().as_be_bytes());
        hasher.update(expires_after_block.to_be_bytes());
        for item in &evidence {
            hasher.update(item.as_bytes());
        }
        let commitment = hasher.finalize().into();

        Ok(Some(Self {
            candidate_id: quote.candidate_id(),
            opportunity_id: quote.opportunity_id(),
            anchor: quote.anchor().clone(),
            curve_commitment: *curve.commitment(),
            quote_commitment: *quote.commitment(),
            execution_plan_commitment: quote.execution_plan_commitment(),
            economic_model_commitment: quote.economic_model_commitment(),
            trade_size: quote.trade_size(),
            gross_value: quote.gross_value(),
            success_cost: report.success_cost,
            success_path_net: report.success_path_net,
            expires_after_block,
            evidence,
            commitment,
        }))
    }

    pub const fn candidate_id(&self) -> PortfolioCandidateId {
        self.candidate_id
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn success_path_net(&self) -> SignedAmount {
        self.success_path_net
    }

    pub const fn expires_after_block(&self) -> u64 {
        self.expires_after_block
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowPredictionBatch {
    predictions: Vec<ShadowPrediction>,
    commitment: [u8; 32],
}

impl ShadowPredictionBatch {
    /// Derive one deterministic prediction for every curve that has a positive
    /// pre-capture net point. Curves with no positive success-path economics
    /// are not Shadow-eligible and are not silently counted.
    pub fn from_curves(
        curves: &[CapacityCurve],
        expires_after_block: u64,
        evidence: Vec<Hash32>,
    ) -> Result<Self, EconomicsError> {
        let mut predictions = Vec::new();
        let mut candidates = BTreeSet::new();
        for curve in curves {
            if let Some(prediction) =
                ShadowPrediction::from_curve(curve, expires_after_block, evidence.clone())?
            {
                if !candidates.insert(prediction.candidate_id()) {
                    return Err(EconomicsError::ShadowDuplicateCandidate);
                }
                predictions.push(prediction);
            }
        }
        predictions.sort_by_key(ShadowPrediction::candidate_id);
        let mut hasher = Sha256::new();
        hasher.update(SHADOW_BATCH_DOMAIN);
        hasher.update([0]);
        hasher.update(
            u64::try_from(predictions.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for prediction in &predictions {
            hasher.update(prediction.commitment());
        }
        Ok(Self {
            predictions,
            commitment: hasher.finalize().into(),
        })
    }

    pub fn predictions(&self) -> &[ShadowPrediction] {
        &self.predictions
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PnlScenario {
    pub probability: ProbabilityWad,
    pub pnl: SignedAmount,
    pub evidence: Hash32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenarioRiskReport {
    pub conservative_expected_pnl: SignedAmount,
    pub worst_case_pnl: SignedAmount,
    pub loss_probability: ProbabilityWad,
}

pub fn evaluate_scenarios(scenarios: &[PnlScenario]) -> Result<ScenarioRiskReport, EconomicsError> {
    if scenarios.is_empty() {
        return Err(EconomicsError::ScenarioEmpty);
    }
    let mut scenario_evidence = BTreeSet::new();
    for scenario in scenarios {
        if is_zero_hash(scenario.evidence) {
            return Err(EconomicsError::MissingEvidenceCommitment("scenario"));
        }
        if !scenario_evidence.insert(scenario.evidence) {
            return Err(EconomicsError::DuplicateEvidence);
        }
    }
    let probability_sum = scenarios.iter().try_fold(0_u128, |sum, scenario| {
        sum.checked_add(u128::from(scenario.probability.value()))
            .ok_or(EconomicsError::ProbabilityArithmeticOverflow)
    })?;
    if probability_sum != u128::from(WAD) {
        return Err(EconomicsError::ScenarioProbabilityNotOne);
    }

    let mut expected = SignedAmount::ZERO;
    let mut worst = scenarios[0].pnl;
    let mut loss_probability = 0_u128;
    for scenario in scenarios {
        expected = expected.checked_add(scenario.pnl.weighted(scenario.probability)?)?;
        if scenario.pnl < worst {
            worst = scenario.pnl;
        }
        if scenario.pnl.is_negative() {
            loss_probability = loss_probability
                .checked_add(u128::from(scenario.probability.value()))
                .ok_or(EconomicsError::ProbabilityArithmeticOverflow)?;
        }
    }
    let loss_probability_u64 = u64::try_from(loss_probability)
        .map_err(|_| EconomicsError::ProbabilityArithmeticOverflow)?;
    Ok(ScenarioRiskReport {
        conservative_expected_pnl: expected,
        worst_case_pnl: worst,
        loss_probability: ProbabilityWad::new(loss_probability_u64)?,
    })
}

#[allow(clippy::too_many_arguments)]
fn quote_commitment(
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    execution_plan_commitment: Hash32,
    economic_model_commitment: Hash32,
    anchor: &StateAnchor,
    valuation_unit: ValuationUnitId,
    trade_size: Amount256,
    gross_value: Amount256,
    costs: &ExecutionCostVector,
    capture: &CaptureCalibration,
    tail: TailRiskBound,
    evidence: &[Hash32],
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(QUOTE_DOMAIN);
    hasher.update([0]);
    hasher.update(candidate_id.as_bytes());
    hasher.update(opportunity_id.as_bytes());
    hasher.update(execution_plan_commitment.as_bytes());
    hasher.update(economic_model_commitment.as_bytes());
    encode_anchor(anchor, &mut hasher);
    hasher.update(valuation_unit.as_bytes());
    hasher.update(trade_size.as_be_bytes());
    hasher.update(gross_value.as_be_bytes());
    for component in costs.components() {
        hasher.update([component.kind.tag()]);
        hasher.update(component.unconditional.as_be_bytes());
        hasher.update(component.on_capture.as_be_bytes());
        hasher.update(component.on_failure.as_be_bytes());
        hasher.update(component.evidence.as_bytes());
    }
    match capture {
        CaptureCalibration::Uncalibrated { model_commitment } => {
            hasher.update([0]);
            hasher.update(model_commitment.as_bytes());
        }
        CaptureCalibration::ShadowCalibrated {
            lower,
            point,
            upper,
            sample_count,
            observation_window,
            model_commitment,
            evidence_commitment,
        } => {
            hasher.update([1]);
            hasher.update(lower.value().to_be_bytes());
            hasher.update(point.value().to_be_bytes());
            hasher.update(upper.value().to_be_bytes());
            hasher.update(sample_count.to_be_bytes());
            hasher.update(observation_window.as_bytes());
            hasher.update(model_commitment.as_bytes());
            hasher.update(evidence_commitment.as_bytes());
        }
    }
    hasher.update(tail.confidence().value().to_be_bytes());
    hasher.update(tail.loss_at_confidence().as_be_bytes());
    hasher.update(tail.absolute_max_loss().as_be_bytes());
    hasher.update(tail.reserve().as_be_bytes());
    hasher.update(tail.evidence().as_bytes());
    for item in evidence {
        hasher.update(item.as_bytes());
    }
    hasher.finalize().into()
}

fn encode_anchor(anchor: &StateAnchor, hasher: &mut Sha256) {
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
}

/// Compute floor(left * right / denominator) with a full 512-bit
/// intermediate. This is used for exact cross-asset valuation such as gas
/// wei times an anchor-pinned native/USD WAD price.
pub fn mul_div_floor(
    left: Amount256,
    right: Amount256,
    denominator: u64,
) -> Result<Amount256, EconomicsError> {
    if denominator == 0 {
        return Err(EconomicsError::ProbabilityArithmeticOverflow);
    }
    if left.is_zero() || right.is_zero() {
        return Ok(Amount256::ZERO);
    }

    // Base-256 little-endian product. Each pre-normalization cell receives at
    // most 32 products of two bytes, far below u64::MAX.
    let mut product = [0_u64; 64];
    for left_index in 0..32 {
        let a = u64::from(left.as_be_bytes()[31 - left_index]);
        for right_index in 0..32 {
            let b = u64::from(right.as_be_bytes()[31 - right_index]);
            let term = a.checked_mul(b).ok_or(EconomicsError::AmountOverflow)?;
            product[left_index + right_index] = product[left_index + right_index]
                .checked_add(term)
                .ok_or(EconomicsError::AmountOverflow)?;
        }
    }

    for index in 0..63 {
        let carry = product[index] >> 8;
        product[index] &= 0xff;
        product[index + 1] = product[index + 1]
            .checked_add(carry)
            .ok_or(EconomicsError::AmountOverflow)?;
    }
    if product[63] > 0xff {
        return Err(EconomicsError::AmountOverflow);
    }

    let mut product_be = [0_u8; 64];
    for (index, cell) in product.iter().enumerate() {
        product_be[63 - index] = u8::try_from(*cell).map_err(|_| EconomicsError::AmountOverflow)?;
    }

    let divisor = u128::from(denominator);
    let mut quotient = [0_u8; 64];
    let mut remainder = 0_u128;
    for (index, byte) in product_be.iter().enumerate() {
        let expanded = remainder
            .checked_mul(256)
            .and_then(|value| value.checked_add(u128::from(*byte)))
            .ok_or(EconomicsError::AmountOverflow)?;
        let digit = expanded / divisor;
        quotient[index] = u8::try_from(digit).map_err(|_| EconomicsError::AmountOverflow)?;
        remainder = expanded % divisor;
    }

    if quotient[..32].iter().any(|byte| *byte != 0) {
        return Err(EconomicsError::AmountOverflow);
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&quotient[32..]);
    Ok(Amount256::from_be_bytes(out))
}

fn is_zero_hash(value: Hash32) -> bool {
    value.as_bytes().iter().all(|byte| *byte == 0)
}

fn div_mod_u64(amount: Amount256, divisor: u64) -> Result<(Amount256, u64), EconomicsError> {
    if divisor == 0 {
        return Err(EconomicsError::ProbabilityArithmeticOverflow);
    }
    let mut quotient = [0_u8; 32];
    let mut remainder = 0_u128;
    for (index, byte) in amount.as_be_bytes().iter().enumerate() {
        let current = remainder
            .checked_mul(256)
            .and_then(|value| value.checked_add(u128::from(*byte)))
            .ok_or(EconomicsError::ProbabilityArithmeticOverflow)?;
        let digit = current / u128::from(divisor);
        quotient[index] =
            u8::try_from(digit).map_err(|_| EconomicsError::ProbabilityArithmeticOverflow)?;
        remainder = current % u128::from(divisor);
    }
    Ok((
        Amount256::from_be_bytes(quotient),
        u64::try_from(remainder).map_err(|_| EconomicsError::ProbabilityArithmeticOverflow)?,
    ))
}

fn mul_u64_checked(amount: Amount256, factor: u64) -> Result<Amount256, EconomicsError> {
    if factor == 0 || amount.is_zero() {
        return Ok(Amount256::ZERO);
    }
    let mut out = [0_u8; 32];
    let mut carry = 0_u128;
    for index in (0..32).rev() {
        let product = u128::from(amount.as_be_bytes()[index])
            .checked_mul(u128::from(factor))
            .and_then(|value| value.checked_add(carry))
            .ok_or(EconomicsError::AmountOverflow)?;
        out[index] = u8::try_from(product & 0xff).map_err(|_| EconomicsError::AmountOverflow)?;
        carry = product >> 8;
    }
    if carry != 0 {
        return Err(EconomicsError::AmountOverflow);
    }
    Ok(Amount256::from_be_bytes(out))
}
