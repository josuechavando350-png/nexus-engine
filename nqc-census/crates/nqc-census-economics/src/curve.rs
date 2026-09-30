use crate::{EconomicQuote, EconomicsError, SignedValue, ValueUnit};
use nqc_census_capital::Amount256;
use nqc_census_core::{Hash32, StateAnchor};
use nqc_census_portfolio::PortfolioCandidateId;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityCurvePoint {
    trade_size: Amount256,
    quote: EconomicQuote,
}

impl CapacityCurvePoint {
    pub fn new(trade_size: Amount256, quote: EconomicQuote) -> Result<Self, EconomicsError> {
        if trade_size.is_zero() {
            return Err(EconomicsError::NonIncreasingTradeSize);
        }
        if quote.trade_size() != trade_size {
            return Err(EconomicsError::TradeSizeMismatch);
        }
        Ok(Self { trade_size, quote })
    }

    pub const fn trade_size(&self) -> Amount256 {
        self.trade_size
    }

    pub const fn quote(&self) -> &EconomicQuote {
        &self.quote
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapacityCurve {
    candidate_id: PortfolioCandidateId,
    opportunity_id: Hash32,
    anchor: StateAnchor,
    unit: ValueUnit,
    execution_plan_commitment: Hash32,
    model_commitment: Hash32,
    points: Vec<CapacityCurvePoint>,
}

impl CapacityCurve {
    pub fn new(mut points: Vec<CapacityCurvePoint>) -> Result<Self, EconomicsError> {
        if points.is_empty() {
            return Err(EconomicsError::EmptyCurve);
        }
        points.sort_by_key(CapacityCurvePoint::trade_size);
        if points
            .windows(2)
            .any(|pair| pair[0].trade_size() >= pair[1].trade_size())
        {
            return Err(EconomicsError::NonIncreasingTradeSize);
        }

        let first = points.first().ok_or(EconomicsError::EmptyCurve)?;
        let candidate_id = first.quote().candidate_id();
        let opportunity_id = first.quote().opportunity_id();
        let anchor = first.quote().anchor().clone();
        let unit = first.quote().unit();
        let execution_plan_commitment = first.quote().execution_plan_commitment();
        let model_commitment = first.quote().model_commitment();

        for point in &points {
            let quote = point.quote();
            if quote.candidate_id() != candidate_id
                || quote.opportunity_id() != opportunity_id
                || quote.execution_plan_commitment() != execution_plan_commitment
                || quote.model_commitment() != model_commitment
            {
                return Err(EconomicsError::CandidateMismatch);
            }
            if quote.anchor() != &anchor {
                return Err(EconomicsError::AnchorMismatch);
            }
            if quote.unit() != unit {
                return Err(EconomicsError::ValueUnitMismatch);
            }
        }

        Ok(Self {
            candidate_id,
            opportunity_id,
            anchor,
            unit,
            execution_plan_commitment,
            model_commitment,
            points,
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

    pub const fn execution_plan_commitment(&self) -> Hash32 {
        self.execution_plan_commitment
    }

    pub const fn model_commitment(&self) -> Hash32 {
        self.model_commitment
    }

    pub fn points(&self) -> &[CapacityCurvePoint] {
        &self.points
    }

    pub fn best_tail_adjusted_positive(
        &self,
    ) -> Result<Option<&CapacityCurvePoint>, EconomicsError> {
        let mut best: Option<(&CapacityCurvePoint, SignedValue)> = None;
        for point in &self.points {
            let value = point.quote().tail_adjusted_ev()?;
            if !value.is_positive() {
                continue;
            }
            match best {
                Some((_, best_value)) if value <= best_value => {}
                _ => best = Some((point, value)),
            }
        }
        Ok(best.map(|(point, _)| point))
    }

    pub fn largest_positive_size(&self) -> Result<Option<Amount256>, EconomicsError> {
        let mut largest = None;
        for point in &self.points {
            if point.quote().tail_adjusted_ev()?.is_positive() {
                largest = Some(point.trade_size());
            }
        }
        Ok(largest)
    }
}
