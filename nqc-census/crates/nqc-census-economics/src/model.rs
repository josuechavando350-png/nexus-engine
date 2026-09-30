use crate::{
    math::{scale_probability, ProbabilityPpb, SignedValue},
    mul_div_floor, EconomicsError,
};
use nqc_census_capital::{Amount256, CapitalAsset};
use nqc_census_core::{Hash32, StateAnchor};
use nqc_census_portfolio::PortfolioCandidateId;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const ECONOMIC_QUOTE_DOMAIN: &[u8] = b"NQC-RMC013-ECONOMIC-QUOTE-V2";
const WEI_PER_NATIVE: u64 = 1_000_000_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalibrationState {
    PriorOnly {
        prior_commitment: Hash32,
    },
    ShadowCalibrated {
        sample_count: u64,
        window_commitment: Hash32,
        model_commitment: Hash32,
        calibration_commitment: Hash32,
    },
}

impl CalibrationState {
    pub const fn is_shadow_calibrated(self) -> bool {
        matches!(self, Self::ShadowCalibrated { .. })
    }

    fn validate(self) -> Result<(), EconomicsError> {
        let nonzero = |value: Hash32| value.as_bytes().iter().any(|byte| *byte != 0);
        match self {
            Self::PriorOnly { prior_commitment } => {
                if !nonzero(prior_commitment) {
                    return Err(EconomicsError::InvalidCalibration);
                }
            }
            Self::ShadowCalibrated {
                sample_count,
                window_commitment,
                model_commitment,
                calibration_commitment,
            } => {
                if sample_count == 0
                    || !nonzero(window_commitment)
                    || !nonzero(model_commitment)
                    || !nonzero(calibration_commitment)
                {
                    return Err(EconomicsError::InvalidCalibration);
                }
            }
        }
        Ok(())
    }

    fn encode(self, out: &mut Vec<u8>) {
        match self {
            Self::PriorOnly { prior_commitment } => {
                out.push(1);
                out.extend_from_slice(prior_commitment.as_bytes());
            }
            Self::ShadowCalibrated {
                sample_count,
                window_commitment,
                model_commitment,
                calibration_commitment,
            } => {
                out.push(2);
                out.extend_from_slice(&sample_count.to_be_bytes());
                out.extend_from_slice(window_commitment.as_bytes());
                out.extend_from_slice(model_commitment.as_bytes());
                out.extend_from_slice(calibration_commitment.as_bytes());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureEstimate {
    lower: ProbabilityPpb,
    point: ProbabilityPpb,
    upper: ProbabilityPpb,
    calibration: CalibrationState,
}

impl CaptureEstimate {
    pub fn new(
        lower: ProbabilityPpb,
        point: ProbabilityPpb,
        upper: ProbabilityPpb,
        calibration: CalibrationState,
    ) -> Result<Self, EconomicsError> {
        if lower > point || point > upper {
            return Err(EconomicsError::InvalidProbabilityInterval);
        }
        calibration.validate()?;
        Ok(Self {
            lower,
            point,
            upper,
            calibration,
        })
    }

    pub const fn lower(self) -> ProbabilityPpb {
        self.lower
    }

    pub const fn point(self) -> ProbabilityPpb {
        self.point
    }

    pub const fn upper(self) -> ProbabilityPpb {
        self.upper
    }

    pub const fn calibration(self) -> CalibrationState {
        self.calibration
    }

    fn encode(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.lower.get().to_be_bytes());
        out.extend_from_slice(&self.point.get().to_be_bytes());
        out.extend_from_slice(&self.upper.get().to_be_bytes());
        self.calibration.encode(out);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueUnit {
    UsdWad,
    Asset(CapitalAsset),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CostComponent {
    pub kind: CostKind,
    pub unconditional: Amount256,
    pub on_capture: Amount256,
    pub on_failure: Amount256,
    pub evidence: Hash32,
}

impl CostComponent {
    pub fn new(
        kind: CostKind,
        unconditional: Amount256,
        on_capture: Amount256,
        on_failure: Amount256,
        evidence: Hash32,
    ) -> Result<Self, EconomicsError> {
        if evidence.as_bytes().iter().all(|byte| *byte == 0) {
            return Err(EconomicsError::EmptyEvidence);
        }
        Ok(Self {
            kind,
            unconditional,
            on_capture,
            on_failure,
            evidence,
        })
    }

    fn encode(self, out: &mut Vec<u8>) {
        out.push(self.kind.tag());
        out.extend_from_slice(self.unconditional.as_be_bytes());
        out.extend_from_slice(self.on_capture.as_be_bytes());
        out.extend_from_slice(self.on_failure.as_be_bytes());
        out.extend_from_slice(self.evidence.as_bytes());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionCostVector {
    components: Vec<CostComponent>,
}

impl ExecutionCostVector {
    pub fn new(mut components: Vec<CostComponent>) -> Result<Self, EconomicsError> {
        components.sort_by_key(|component| component.kind);
        for kind in CostKind::ALL {
            let count = components.iter().filter(|component| component.kind == kind).count();
            match count {
                0 => return Err(EconomicsError::MissingCostKind(kind)),
                1 => {}
                _ => return Err(EconomicsError::DuplicateCostKind(kind)),
            }
        }
        if components.len() != CostKind::ALL.len() {
            return Err(EconomicsError::DuplicateCostKind(
                components
                    .first()
                    .map(|component| component.kind)
                    .unwrap_or(CostKind::ChainSpecific),
            ));
        }
        Ok(Self { components })
    }

    pub fn components(&self) -> &[CostComponent] {
        &self.components
    }

    pub fn total_unconditional(&self) -> Result<Amount256, EconomicsError> {
        sum_costs(self.components.iter().map(|component| component.unconditional))
    }

    pub fn total_on_capture(&self) -> Result<Amount256, EconomicsError> {
        sum_costs(self.components.iter().map(|component| component.on_capture))
    }

    pub fn total_on_failure(&self) -> Result<Amount256, EconomicsError> {
        sum_costs(self.components.iter().map(|component| component.on_failure))
    }

    fn encode(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(
            &u32::try_from(self.components.len())
                .unwrap_or(u32::MAX)
                .to_be_bytes(),
        );
        for component in &self.components {
            component.encode(out);
        }
    }
}

fn sum_costs<I>(values: I) -> Result<Amount256, EconomicsError>
where
    I: IntoIterator<Item = Amount256>,
{
    let mut total = Amount256::ZERO;
    for value in values {
        total = total
            .checked_add(value)
            .map_err(|_| EconomicsError::ArithmeticOverflow)?;
    }
    Ok(total)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TailRiskBound {
    confidence: ProbabilityPpb,
    loss_at_confidence: Amount256,
    absolute_max_loss: Amount256,
    reserve: Amount256,
}

impl TailRiskBound {
    pub fn new(
        confidence: ProbabilityPpb,
        loss_at_confidence: Amount256,
        absolute_max_loss: Amount256,
        reserve: Amount256,
    ) -> Result<Self, EconomicsError> {
        if confidence.is_zero()
            || loss_at_confidence > absolute_max_loss
            || reserve > absolute_max_loss
        {
            return Err(EconomicsError::InvalidTailBound);
        }
        Ok(Self {
            confidence,
            loss_at_confidence,
            absolute_max_loss,
            reserve,
        })
    }

    pub const fn confidence(self) -> ProbabilityPpb {
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

    fn encode(self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.confidence.get().to_be_bytes());
        out.extend_from_slice(self.loss_at_confidence.as_be_bytes());
        out.extend_from_slice(self.absolute_max_loss.as_be_bytes());
        out.extend_from_slice(self.reserve.as_be_bytes());
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GasValuation {
    gas_used: u64,
    effective_gas_price_wei: Amount256,
    native_usd_wad: Amount256,
    gas_wei: Amount256,
    gas_usd_wad: Amount256,
}

impl GasValuation {
    pub fn new(
        gas_used: u64,
        effective_gas_price_wei: Amount256,
        native_usd_wad: Amount256,
    ) -> Result<Self, EconomicsError> {
        let gas_wei = mul_div_floor(
            effective_gas_price_wei,
            Amount256::from_u128(u128::from(gas_used)),
            1,
        )?;
        let gas_usd_wad = mul_div_floor(gas_wei, native_usd_wad, WEI_PER_NATIVE)?;
        Ok(Self {
            gas_used,
            effective_gas_price_wei,
            native_usd_wad,
            gas_wei,
            gas_usd_wad,
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EconomicDecision {
    NonPositiveSuccessNet,
    CaptureUncalibrated,
    NonPositiveTailAdjustedNet,
    Admitted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EconomicQuote {
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    anchor: StateAnchor,
    unit: ValueUnit,
    trade_size: Amount256,
    gross_value: Amount256,
    costs: ExecutionCostVector,
    capture: CaptureEstimate,
    tail: TailRiskBound,
    execution_plan_commitment: Hash32,
    model_commitment: Hash32,
    evidence: Vec<Hash32>,
    commitment: Hash32,
}

impl EconomicQuote {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        candidate_id: PortfolioCandidateId,
        opportunity_id: Hash32,
        anchor: StateAnchor,
        unit: ValueUnit,
        trade_size: Amount256,
        gross_value: Amount256,
        costs: ExecutionCostVector,
        capture: CaptureEstimate,
        tail: TailRiskBound,
        execution_plan_commitment: Hash32,
        model_commitment: Hash32,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, EconomicsError> {
        if trade_size.is_zero() {
            return Err(EconomicsError::ZeroValue("trade_size"));
        }
        if evidence.is_empty() {
            return Err(EconomicsError::EmptyEvidence);
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(EconomicsError::DuplicateEvidence);
        }
        if execution_plan_commitment
            .as_bytes()
            .iter()
            .all(|byte| *byte == 0)
            || model_commitment.as_bytes().iter().all(|byte| *byte == 0)
        {
            return Err(EconomicsError::EmptyEvidence);
        }
        let commitment = quote_commitment(
            candidate_id,
            opportunity_id,
            &anchor,
            unit,
            trade_size,
            gross_value,
            &costs,
            capture,
            tail,
            execution_plan_commitment,
            model_commitment,
            &evidence,
        )?;
        Ok(Self {
            candidate_id,
            opportunity_id,
            anchor,
            unit,
            trade_size,
            gross_value,
            costs,
            capture,
            tail,
            execution_plan_commitment,
            model_commitment,
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

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn unit(&self) -> ValueUnit {
        self.unit
    }

    pub const fn trade_size(&self) -> Amount256 {
        self.trade_size
    }

    pub const fn gross_value(&self) -> Amount256 {
        self.gross_value
    }

    pub const fn costs(&self) -> &ExecutionCostVector {
        &self.costs
    }

    pub const fn capture(&self) -> CaptureEstimate {
        self.capture
    }

    pub const fn tail(&self) -> TailRiskBound {
        self.tail
    }

    pub const fn execution_plan_commitment(&self) -> Hash32 {
        self.execution_plan_commitment
    }

    pub const fn model_commitment(&self) -> Hash32 {
        self.model_commitment
    }

    pub fn evidence(&self) -> &[Hash32] {
        &self.evidence
    }

    pub const fn commitment(&self) -> Hash32 {
        self.commitment
    }

    pub fn success_net(&self) -> Result<SignedValue, EconomicsError> {
        let success_costs = self
            .costs
            .total_unconditional()?
            .checked_add(self.costs.total_on_capture()?)
            .map_err(|_| EconomicsError::ArithmeticOverflow)?;
        SignedValue::from_difference(self.gross_value, success_costs)
    }

    fn expected_at(&self, probability: ProbabilityPpb) -> Result<SignedValue, EconomicsError> {
        let expected_gross = scale_probability(self.gross_value, probability)?;
        let expected_capture_cost =
            scale_probability(self.costs.total_on_capture()?, probability)?;
        let expected_failure_cost = scale_probability(
            self.costs.total_on_failure()?,
            probability.complement(),
        )?;
        let expected_costs = self
            .costs
            .total_unconditional()?
            .checked_add(expected_capture_cost)
            .and_then(|value| value.checked_add(expected_failure_cost))
            .map_err(|_| EconomicsError::ArithmeticOverflow)?;
        SignedValue::from_difference(expected_gross, expected_costs)
    }

    pub fn expected_realized_ev(&self) -> Result<SignedValue, EconomicsError> {
        self.expected_at(self.capture.point())
    }

    /// Conservative bound over the declared capture interval.
    ///
    /// Expected value is affine in capture probability, so the interval
    /// minimum must occur at one of the two endpoints. We evaluate both
    /// rather than assuming that "lower probability" is always worse.
    pub fn lower_bound_realized_ev(&self) -> Result<SignedValue, EconomicsError> {
        let lower = self.expected_at(self.capture.lower())?;
        let upper = self.expected_at(self.capture.upper())?;
        Ok(lower.min(upper))
    }

    pub fn point_tail_adjusted_ev(&self) -> Result<SignedValue, EconomicsError> {
        self.expected_realized_ev()?
            .subtract_unsigned(self.tail.reserve())
    }

    pub fn tail_adjusted_ev(&self) -> Result<SignedValue, EconomicsError> {
        self.lower_bound_realized_ev()?
            .subtract_unsigned(self.tail.reserve())
    }

    pub fn require_positive_success_net(&self) -> Result<Amount256, EconomicsError> {
        let net = self.success_net()?;
        if !net.is_positive() {
            return Err(EconomicsError::NegativeSuccessNet);
        }
        Ok(net.magnitude())
    }

    pub fn certified_expected_realized_ev(&self) -> Result<SignedValue, EconomicsError> {
        if !self.capture.calibration().is_shadow_calibrated() {
            return Err(EconomicsError::UncalibratedCapture);
        }
        self.lower_bound_realized_ev()
    }

    pub fn decision(&self) -> Result<EconomicDecision, EconomicsError> {
        if !self.success_net()?.is_positive() {
            return Ok(EconomicDecision::NonPositiveSuccessNet);
        }
        if !self.capture.calibration().is_shadow_calibrated() {
            return Ok(EconomicDecision::CaptureUncalibrated);
        }
        if !self.tail_adjusted_ev()?.is_positive() {
            return Ok(EconomicDecision::NonPositiveTailAdjustedNet);
        }
        Ok(EconomicDecision::Admitted)
    }

    pub fn profit_bucket(&self) -> Result<Option<ProfitBucket>, EconomicsError> {
        if self.unit != ValueUnit::UsdWad {
            return Err(EconomicsError::ValueUnitMismatch);
        }
        let value = self.tail_adjusted_ev()?;
        if !value.is_positive() {
            return Ok(None);
        }
        Ok(Some(ProfitBucket::from_usd_wad(value.magnitude())))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ProfitBucket {
    Usd0To1,
    Usd1To3,
    Usd3To5,
    Usd5To10,
    Usd10To20,
    Usd20To50,
    Usd50To100,
    Usd100To500,
    Usd500Plus,
}

impl ProfitBucket {
    pub fn from_usd_wad(value: Amount256) -> Self {
        let threshold = |dollars: u128| Amount256::from_u128(dollars * 1_000_000_000_000_000_000);
        if value < threshold(1) {
            Self::Usd0To1
        } else if value < threshold(3) {
            Self::Usd1To3
        } else if value < threshold(5) {
            Self::Usd3To5
        } else if value < threshold(10) {
            Self::Usd5To10
        } else if value < threshold(20) {
            Self::Usd10To20
        } else if value < threshold(50) {
            Self::Usd20To50
        } else if value < threshold(100) {
            Self::Usd50To100
        } else if value < threshold(500) {
            Self::Usd100To500
        } else {
            Self::Usd500Plus
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn quote_commitment(
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    anchor: &StateAnchor,
    unit: ValueUnit,
    trade_size: Amount256,
    gross_value: Amount256,
    costs: &ExecutionCostVector,
    capture: CaptureEstimate,
    tail: TailRiskBound,
    execution_plan_commitment: Hash32,
    model_commitment: Hash32,
    evidence: &[Hash32],
) -> Result<Hash32, EconomicsError> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(ECONOMIC_QUOTE_DOMAIN);
    bytes.extend_from_slice(candidate_id.as_bytes());
    bytes.extend_from_slice(opportunity_id.as_bytes());
    encode_anchor(anchor, &mut bytes);
    encode_unit(unit, &mut bytes);
    bytes.extend_from_slice(trade_size.as_be_bytes());
    bytes.extend_from_slice(gross_value.as_be_bytes());
    costs.encode(&mut bytes);
    capture.encode(&mut bytes);
    tail.encode(&mut bytes);
    bytes.extend_from_slice(execution_plan_commitment.as_bytes());
    bytes.extend_from_slice(model_commitment.as_bytes());
    let evidence_len =
        u64::try_from(evidence.len()).map_err(|_| EconomicsError::ArithmeticOverflow)?;
    bytes.extend_from_slice(&evidence_len.to_be_bytes());
    for item in evidence {
        bytes.extend_from_slice(item.as_bytes());
    }
    let digest = Sha256::digest(&bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    Hash32::new(out).map_err(|_| EconomicsError::ArithmeticOverflow)
}

fn encode_anchor(anchor: &StateAnchor, out: &mut Vec<u8>) {
    out.extend_from_slice(&anchor.chain().chain_id().to_be_bytes());
    out.extend_from_slice(anchor.chain().genesis_hash().as_bytes());
    out.extend_from_slice(anchor.chain().fork_lineage().as_bytes());
    out.extend_from_slice(&anchor.block_number().to_be_bytes());
    out.extend_from_slice(anchor.block_hash().as_bytes());
    out.extend_from_slice(anchor.parent_hash().as_bytes());
    out.extend_from_slice(&anchor.timestamp().to_be_bytes());
    out.extend_from_slice(anchor.state_root().as_bytes());
}

fn encode_unit(unit: ValueUnit, out: &mut Vec<u8>) {
    match unit {
        ValueUnit::UsdWad => out.push(1),
        ValueUnit::Asset(CapitalAsset::NativeGas) => out.push(2),
        ValueUnit::Asset(CapitalAsset::Token(address)) => {
            out.push(3);
            out.extend_from_slice(address.as_bytes());
        }
    }
}
