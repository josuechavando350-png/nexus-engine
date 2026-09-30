use crate::{EconomicsError, ProbabilityPpb, SignedValue};
use nqc_census_core::Hash32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PnlScenario {
    pub scenario_id: Hash32,
    pub probability: ProbabilityPpb,
    pub pnl: SignedValue,
    pub evidence: Hash32,
}

impl PnlScenario {
    pub fn new(
        scenario_id: Hash32,
        probability: ProbabilityPpb,
        pnl: SignedValue,
        evidence: Hash32,
    ) -> Result<Self, EconomicsError> {
        if scenario_id.as_bytes().iter().all(|byte| *byte == 0)
            || evidence.as_bytes().iter().all(|byte| *byte == 0)
        {
            return Err(EconomicsError::EmptyEvidence);
        }
        Ok(Self {
            scenario_id,
            probability,
            pnl,
            evidence,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScenarioReport {
    expected_pnl: SignedValue,
    worst_case: SignedValue,
    loss_probability: ProbabilityPpb,
}

impl ScenarioReport {
    pub const fn expected_pnl(self) -> SignedValue {
        self.expected_pnl
    }

    pub const fn worst_case(self) -> SignedValue {
        self.worst_case
    }

    pub const fn loss_probability(self) -> ProbabilityPpb {
        self.loss_probability
    }
}

pub fn evaluate_scenarios(scenarios: &[PnlScenario]) -> Result<ScenarioReport, EconomicsError> {
    if scenarios.is_empty() {
        return Err(EconomicsError::ScenarioEmpty);
    }

    let mut probability_sum = 0_u64;
    let mut loss_probability = 0_u64;
    let mut expected = SignedValue::ZERO;
    let mut worst = scenarios[0].pnl;

    for scenario in scenarios {
        probability_sum = probability_sum
            .checked_add(u64::from(scenario.probability.get()))
            .ok_or(EconomicsError::ArithmeticOverflow)?;
        if scenario.pnl.is_negative() {
            loss_probability = loss_probability
                .checked_add(u64::from(scenario.probability.get()))
                .ok_or(EconomicsError::ArithmeticOverflow)?;
        }
        expected = expected.checked_add(scenario.pnl.scale(scenario.probability)?)?;
        if scenario.pnl < worst {
            worst = scenario.pnl;
        }
    }

    if probability_sum != u64::from(crate::math::PPB_ONE) {
        return Err(EconomicsError::ScenarioProbabilityNotOne);
    }
    let loss_probability =
        u32::try_from(loss_probability).map_err(|_| EconomicsError::ArithmeticOverflow)?;

    Ok(ScenarioReport {
        expected_pnl: expected,
        worst_case: worst,
        loss_probability: ProbabilityPpb::new(loss_probability)?,
    })
}
