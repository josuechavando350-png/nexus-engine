use alloy::primitives::U256;
use nqc_core::{checked_add, checked_mul, checked_sub, mul_div_floor, MathError};
use thiserror::Error;

pub const PPM_DENOMINATOR: u64 = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeVector {
    pub information_ppm: u32,
    pub execution_ppm: u32,
    pub inclusion_ppm: u32,
}

impl EdgeVector {
    pub fn validate(self) -> Result<Self, EdgeError> {
        for value in [self.information_ppm, self.execution_ppm, self.inclusion_ppm] {
            if u64::from(value) > PPM_DENOMINATOR {
                return Err(EdgeError::InvalidProbabilityPpm(value));
            }
        }
        Ok(self)
    }

    #[must_use]
    pub fn bottleneck_ppm(self) -> u32 {
        self.information_ppm
            .min(self.execution_ppm)
            .min(self.inclusion_ppm)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeEconomics {
    pub safe_profit_usd_wad: U256,
    pub loss_if_adverse_usd_wad: U256,
    pub opportunity_cost_usd_wad: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgePolicy {
    pub min_information_ppm: u32,
    pub min_execution_ppm: u32,
    pub min_inclusion_ppm: u32,
    pub min_bottleneck_ppm: u32,
    pub min_safe_profit_usd_wad: U256,
    pub min_expected_value_usd_wad: U256,
}

impl EdgePolicy {
    pub fn validate(self) -> Result<Self, EdgeError> {
        for value in [
            self.min_information_ppm,
            self.min_execution_ppm,
            self.min_inclusion_ppm,
            self.min_bottleneck_ppm,
        ] {
            if u64::from(value) > PPM_DENOMINATOR {
                return Err(EdgeError::InvalidProbabilityPpm(value));
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EdgeAssessment {
    vector: EdgeVector,
    bottleneck_ppm: u32,
    expected_value_usd_wad: U256,
    expected_success_value_usd_wad: U256,
    expected_adverse_loss_usd_wad: U256,
}

impl EdgeAssessment {
    #[must_use]
    pub const fn vector(self) -> EdgeVector { self.vector }
    #[must_use]
    pub const fn bottleneck_ppm(self) -> u32 { self.bottleneck_ppm }
    #[must_use]
    pub const fn expected_value_usd_wad(self) -> U256 { self.expected_value_usd_wad }
    #[must_use]
    pub const fn expected_success_value_usd_wad(self) -> U256 { self.expected_success_value_usd_wad }
    #[must_use]
    pub const fn expected_adverse_loss_usd_wad(self) -> U256 { self.expected_adverse_loss_usd_wad }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeRejectReason {
    InformationEdgeTooWeak,
    ExecutionEdgeTooWeak,
    InclusionEdgeTooWeak,
    BottleneckTooWeak,
    SafeProfitBelowFloor,
    ExpectedValueBelowFloor,
    NegativeExpectedValue,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EdgeDecision {
    Eligible(EdgeAssessment),
    Reject(EdgeRejectReason),
}

pub fn assess_edge(
    vector: EdgeVector,
    economics: EdgeEconomics,
    policy: EdgePolicy,
) -> Result<EdgeDecision, EdgeError> {
    let vector = vector.validate()?;
    let policy = policy.validate()?;

    if vector.information_ppm < policy.min_information_ppm {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::InformationEdgeTooWeak));
    }
    if vector.execution_ppm < policy.min_execution_ppm {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::ExecutionEdgeTooWeak));
    }
    if vector.inclusion_ppm < policy.min_inclusion_ppm {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::InclusionEdgeTooWeak));
    }
    let bottleneck_ppm = vector.bottleneck_ppm();
    if bottleneck_ppm < policy.min_bottleneck_ppm {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::BottleneckTooWeak));
    }
    if economics.safe_profit_usd_wad < policy.min_safe_profit_usd_wad {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::SafeProfitBelowFloor));
    }

    // Deliberately conservative: only inclusion probability is used as the success
    // probability in EV. Information/execution scores are hard gates, not multiplied
    // as if they were statistically independent probabilities.
    let expected_success_value_usd_wad = mul_div_floor(
        economics.safe_profit_usd_wad,
        U256::from(vector.inclusion_ppm),
        U256::from(PPM_DENOMINATOR),
    )?;
    let adverse_ppm = PPM_DENOMINATOR
        .checked_sub(u64::from(vector.execution_ppm))
        .ok_or(EdgeError::ProbabilityUnderflow)?;
    let expected_adverse_loss_usd_wad = mul_div_floor(
        economics.loss_if_adverse_usd_wad,
        U256::from(adverse_ppm),
        U256::from(PPM_DENOMINATOR),
    )?;
    let total_expected_cost = checked_add(
        expected_adverse_loss_usd_wad,
        economics.opportunity_cost_usd_wad,
    )?;
    if total_expected_cost > expected_success_value_usd_wad {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::NegativeExpectedValue));
    }
    let expected_value_usd_wad = checked_sub(expected_success_value_usd_wad, total_expected_cost)?;
    if expected_value_usd_wad < policy.min_expected_value_usd_wad {
        return Ok(EdgeDecision::Reject(EdgeRejectReason::ExpectedValueBelowFloor));
    }

    Ok(EdgeDecision::Eligible(EdgeAssessment {
        vector,
        bottleneck_ppm,
        expected_value_usd_wad,
        expected_success_value_usd_wad,
        expected_adverse_loss_usd_wad,
    }))
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum EdgeError {
    #[error(transparent)]
    Math(#[from] MathError),
    #[error("parts-per-million value exceeds 1,000,000: {0}")]
    InvalidProbabilityPpm(u32),
    #[error("probability arithmetic underflow")]
    ProbabilityUnderflow,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd(value: u64) -> U256 {
        U256::from(value) * U256::from(1_000_000_000_000_000_000u64)
    }

    #[test]
    fn precision_first_policy_rejects_weak_information_even_with_large_profit() -> Result<(), EdgeError> {
        let decision = assess_edge(
            EdgeVector {
                information_ppm: 700_000,
                execution_ppm: 995_000,
                inclusion_ppm: 800_000,
            },
            EdgeEconomics {
                safe_profit_usd_wad: usd(1_000_000),
                loss_if_adverse_usd_wad: usd(1_000),
                opportunity_cost_usd_wad: U256::ZERO,
            },
            EdgePolicy {
                min_information_ppm: 900_000,
                min_execution_ppm: 990_000,
                min_inclusion_ppm: 500_000,
                min_bottleneck_ppm: 500_000,
                min_safe_profit_usd_wad: usd(100),
                min_expected_value_usd_wad: usd(50),
            },
        )?;
        assert_eq!(decision, EdgeDecision::Reject(EdgeRejectReason::InformationEdgeTooWeak));
        Ok(())
    }

    #[test]
    fn eligible_candidate_has_positive_conservative_ev() -> Result<(), EdgeError> {
        let decision = assess_edge(
            EdgeVector {
                information_ppm: 970_000,
                execution_ppm: 999_000,
                inclusion_ppm: 700_000,
            },
            EdgeEconomics {
                safe_profit_usd_wad: usd(10_000),
                loss_if_adverse_usd_wad: usd(500),
                opportunity_cost_usd_wad: usd(50),
            },
            EdgePolicy {
                min_information_ppm: 950_000,
                min_execution_ppm: 995_000,
                min_inclusion_ppm: 500_000,
                min_bottleneck_ppm: 500_000,
                min_safe_profit_usd_wad: usd(1_000),
                min_expected_value_usd_wad: usd(5_000),
            },
        )?;
        assert!(matches!(decision, EdgeDecision::Eligible(_)));
        if let EdgeDecision::Eligible(assessment) = decision {
            assert!(assessment.expected_value_usd_wad >= usd(5_000));
            assert_eq!(assessment.bottleneck_ppm, 700_000);
        }
        Ok(())
    }
}