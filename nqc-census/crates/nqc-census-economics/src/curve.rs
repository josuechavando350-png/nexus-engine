use crate::{EconomicQuote, EconomicsError, SignedValue, ValueUnit};
use nqc_census_capital::Amount256;
use nqc_census_core::{Hash32, StateAnchor};

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
    opportunity_id: Hash32,
    anchor: StateAnchor,
    unit: ValueUnit,
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
        let opportunity_id = first.quote().opportunity_id();
        let anchor = first.quote().anchor().clone();
        let unit = first.quote().unit();
        let model_commitment = first.quote().model_commitment();

        for point in &points {
            if point.quote().opportunity_id() != opportunity_id {
                return Err(EconomicsError::CandidateMismatch);
            }
            if point.quote().anchor() != &anchor {
                return Err(EconomicsError::AnchorMismatch);
            }
            if point.quote().unit() != unit {
                return Err(EconomicsError::ValueUnitMismatch);
            }
            if point.quote().model_commitment() != model_commitment {
                return Err(EconomicsError::CandidateMismatch);
            }
        }

        Ok(Self {
            opportunity_id,
            anchor,
            unit,
            model_commitment,
            points,
        })
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
