use crate::{
    math::{scale_probability, ProbabilityPpb, SignedValue},
    mul_div_floor, EconomicsError,
};
use nqc_census_capital::{Amount256, CapitalAsset};
use nqc_census_core::{Hash32, StateAnchor};
use nqc_census_portfolio::PortfolioCandidateId;
use sha2::{Digest, Sha256};

const ECONOMIC_QUOTE_DOMAIN: &[u8] = b"NQC-RMC013-ECONOMIC-QUOTE-V1";
const WEI_PER_NATIVE: u64 = 1_000_000_000_000_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CalibrationState {
    PriorOnly {
        prior_commitment: Hash32,
    },
    ShadowCalibrated {
        sample_count: u64,
        calibration_commitment: Hash32,
    },
}

impl CalibrationState {
    pub const fn is_shadow_calibrated(self) -> bool {
        matches!(self, Self::ShadowCalibrated { .. })
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
        if matches!(
            calibration,
            CalibrationState::ShadowCalibrated {
                sample_count: 0,
                ..
            }
        ) {
            return Err(EconomicsError::InvalidCalibration);
        }
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueUnit {
    UsdWad,
    Asset(CapitalAsset),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct ExecutionCostVector {
    pub protocol_fee: Amount256,
    pub capital_fee: Amount256,
    pub swap_fee: Amount256,
    pub price_impact: Amount256,
    pub gas: Amount256,
    pub priority_fee: Amount256,
    pub builder_payment: Amount256,
    pub financing: Amount256,
    pub hedging: Amount256,
    pub inventory: Amount256,
    pub opportunity_cost: Amount256,
    pub mev: Amount256,
    pub chain_other: Amount256,
}

impl ExecutionCostVector {
    pub fn total(self) -> Result<Amount256, EconomicsError> {
        let values = [
            self.protocol_fee,
            self.capital_fee,
            self.swap_fee,
            self.price_impact,
            self.gas,
            self.priority_fee,
            self.builder_payment,
            self.financing,
            self.hedging,
            self.inventory,
            self.opportunity_cost,
            self.mev,
            self.chain_other,
        ];
        let mut total = Amount256::ZERO;
        for value in values {
            total = total
                .checked_add(value)
                .map_err(|_| EconomicsError::ArithmeticOverflow)?;
        }
        Ok(total)
    }

    fn encode(self, out: &mut Vec<u8>) {
        for value in [
            self.protocol_fee,
            self.capital_fee,
            self.swap_fee,
            self.price_impact,
            self.gas,
            self.priority_fee,
            self.builder_payment,
            self.financing,
            self.hedging,
            self.inventory,
            self.opportunity_cost,
            self.mev,
            self.chain_other,
        ] {
            out.extend_from_slice(value.as_be_bytes());
        }
    }
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EconomicQuote {
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    anchor: StateAnchor,
    unit: ValueUnit,
    gross_value: Amount256,
    success_costs: ExecutionCostVector,
    capture: CaptureEstimate,
    failure_cost_if_lost: Amount256,
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
        gross_value: Amount256,
        success_costs: ExecutionCostVector,
        capture: CaptureEstimate,
        failure_cost_if_lost: Amount256,
        tail: TailRiskBound,
        execution_plan_commitment: Hash32,
        model_commitment: Hash32,
        mut evidence: Vec<Hash32>,
    ) -> Result<Self, EconomicsError> {
        if evidence.is_empty() {
            return Err(EconomicsError::EmptyEvidence);
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(EconomicsError::DuplicateEvidence);
        }
        let commitment = quote_commitment(
            candidate_id,
            opportunity_id,
            &anchor,
            unit,
            gross_value,
            success_costs,
            capture,
            failure_cost_if_lost,
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
            gross_value,
            success_costs,
            capture,
            failure_cost_if_lost,
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

    pub const fn gross_value(&self) -> Amount256 {
        self.gross_value
    }

    pub const fn success_costs(&self) -> ExecutionCostVector {
        self.success_costs
    }

    pub const fn capture(&self) -> CaptureEstimate {
        self.capture
    }

    pub const fn failure_cost_if_lost(&self) -> Amount256 {
        self.failure_cost_if_lost
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
        SignedValue::from_difference(self.gross_value, self.success_costs.total()?)
    }

    pub fn expected_realized_ev(&self) -> Result<SignedValue, EconomicsError> {
        let success = self.success_net()?.scale(self.capture.point())?;
        let loss = scale_probability(
            self.failure_cost_if_lost,
            self.capture.point().complement(),
        )?;
        success.subtract_unsigned(loss)
    }

    pub fn lower_bound_realized_ev(&self) -> Result<SignedValue, EconomicsError> {
        let success = self.success_net()?.scale(self.capture.lower())?;
        let loss = scale_probability(
            self.failure_cost_if_lost,
            self.capture.lower().complement(),
        )?;
        success.subtract_unsigned(loss)
    }

    pub fn tail_adjusted_ev(&self) -> Result<SignedValue, EconomicsError> {
        self.expected_realized_ev()?.subtract_unsigned(self.tail.reserve())
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
        self.expected_realized_ev()
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
    gross_value: Amount256,
    success_costs: ExecutionCostVector,
    capture: CaptureEstimate,
    failure_cost_if_lost: Amount256,
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
    bytes.extend_from_slice(gross_value.as_be_bytes());
    success_costs.encode(&mut bytes);
    bytes.extend_from_slice(&capture.lower().get().to_be_bytes());
    bytes.extend_from_slice(&capture.point().get().to_be_bytes());
    bytes.extend_from_slice(&capture.upper().get().to_be_bytes());
    match capture.calibration() {
        CalibrationState::PriorOnly { prior_commitment } => {
            bytes.push(1);
            bytes.extend_from_slice(prior_commitment.as_bytes());
        }
        CalibrationState::ShadowCalibrated {
            sample_count,
            calibration_commitment,
        } => {
            bytes.push(2);
            bytes.extend_from_slice(&sample_count.to_be_bytes());
            bytes.extend_from_slice(calibration_commitment.as_bytes());
        }
    }
    bytes.extend_from_slice(failure_cost_if_lost.as_be_bytes());
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
