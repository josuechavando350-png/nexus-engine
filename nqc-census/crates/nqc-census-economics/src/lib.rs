//! RMC-013 exact execution economics and capture-prediction contract.
//!
//! This crate converts an already capital-feasible, conflict-accounted
//! execution candidate into exact, evidence-bound economic predictions.
//! It deliberately does not claim realized P&L. Shadow Execution must
//! calibrate capture probabilities and compare predictions with observed
//! outcomes before any live profitability claim is admissible.

mod curve;
mod math;
mod model;
mod scenario;

pub use curve::{CapacityCurve, CapacityCurvePoint};
pub use math::{mul_div_floor, ProbabilityPpb, SignedValue};
pub use model::{
    CalibrationState, CaptureEstimate, CostComponent, CostKind, EconomicDecision, EconomicQuote,
    ExecutionCostVector, GasValuation, ProfitBucket, TailRiskBound, ValueUnit,
};
pub use scenario::{evaluate_scenarios, PnlScenario, ScenarioReport};

use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EconomicsError {
    ZeroValue(&'static str),
    ProbabilityOutOfRange,
    InvalidProbabilityInterval,
    InvalidCalibration,
    ZeroDenominator,
    ArithmeticOverflow,
    EmptyEvidence,
    DuplicateEvidence,
    MissingCostKind(CostKind),
    DuplicateCostKind(CostKind),
    EmptyCurve,
    NonIncreasingTradeSize,
    TradeSizeMismatch,
    AnchorMismatch,
    ValueUnitMismatch,
    CandidateMismatch,
    InvalidTailBound,
    NegativeSuccessNet,
    UncalibratedCapture,
    ScenarioEmpty,
    ScenarioProbabilityNotOne,
}

impl Display for EconomicsError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroValue(name) => write!(f, "{name} must not be zero"),
            Self::ProbabilityOutOfRange => f.write_str("probability exceeds one"),
            Self::InvalidProbabilityInterval => {
                f.write_str("capture probability interval is not ordered")
            }
            Self::InvalidCalibration => f.write_str("capture calibration evidence is invalid"),
            Self::ZeroDenominator => f.write_str("division denominator must be non-zero"),
            Self::ArithmeticOverflow => f.write_str("exact economics arithmetic overflow"),
            Self::EmptyEvidence => f.write_str("economic record requires evidence"),
            Self::DuplicateEvidence => f.write_str("economic record repeats evidence"),
            Self::MissingCostKind(kind) => write!(f, "execution cost vector omits {kind:?}"),
            Self::DuplicateCostKind(kind) => write!(f, "execution cost vector repeats {kind:?}"),
            Self::EmptyCurve => f.write_str("capacity curve must contain at least one point"),
            Self::NonIncreasingTradeSize => {
                f.write_str("capacity curve trade sizes must increase strictly")
            }
            Self::TradeSizeMismatch => {
                f.write_str("capacity point trade size differs from quote commitment")
            }
            Self::AnchorMismatch => f.write_str("economic evidence anchors differ"),
            Self::ValueUnitMismatch => f.write_str("economic value units differ"),
            Self::CandidateMismatch => f.write_str("capacity curve candidate lineage differs"),
            Self::InvalidTailBound => f.write_str("tail-risk bound is internally inconsistent"),
            Self::NegativeSuccessNet => {
                f.write_str("successful execution is not positive after exact costs")
            }
            Self::UncalibratedCapture => {
                f.write_str("capture model is not Shadow-calibrated")
            }
            Self::ScenarioEmpty => f.write_str("scenario distribution is empty"),
            Self::ScenarioProbabilityNotOne => {
                f.write_str("scenario probabilities must sum to exactly one")
            }
        }
    }
}

impl std::error::Error for EconomicsError {}
