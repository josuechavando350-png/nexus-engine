//! Bounded reasoning control. Stores structured artifacts, never hidden chain-of-thought.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result, Timestamp};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReasoningBudget {
    pub max_steps: u32,
    pub max_model_calls: u32,
    pub max_tool_calls: u32,
    pub max_retries: u32,
    pub max_wall_millis: u64,
}
impl Default for ReasoningBudget {
    fn default() -> Self {
        Self {
            max_steps: 16,
            max_model_calls: 8,
            max_tool_calls: 16,
            max_retries: 3,
            max_wall_millis: 30_000,
        }
    }
}
impl ReasoningBudget {
    pub fn validate(&self) -> Result<()> {
        if self.max_steps == 0 || self.max_wall_millis == 0 {
            return Err(NexusError::invalid(
                "reasoning step/time budgets must be positive",
            ));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct ReasoningStep {
    pub index: u32,
    pub at: Timestamp,
    pub observation_refs: Vec<String>,
    pub candidate_action_codes: Vec<String>,
    pub rejected_action_codes: Vec<String>,
    pub selected_action_code: Option<String>,
    pub confidence: f64,
    pub evaluator_codes: Vec<String>,
}
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ReasoningTrace {
    pub steps: Vec<ReasoningStep>,
    pub model_calls: u32,
    pub tool_calls: u32,
    pub retries: u32,
}
impl ReasoningTrace {
    pub fn push(&mut self, b: &ReasoningBudget, s: ReasoningStep) -> Result<()> {
        b.validate()?;
        if self.steps.len() as u32 >= b.max_steps {
            return Err(NexusError::exhausted("reasoning step budget exhausted"));
        }
        if s.index != self.steps.len() as u32 {
            return Err(NexusError::invalid(
                "reasoning step index is non-sequential",
            ));
        }
        if let Some(previous) = self.steps.last() {
            if s.at.is_before(previous.at) {
                return Err(NexusError::invalid("reasoning step time moved backwards"));
            }
        }
        if !(0.0..=1.0).contains(&s.confidence) {
            return Err(NexusError::invalid("reasoning confidence outside [0,1]"));
        }
        self.steps.push(s);
        Ok(())
    }
    pub fn record_model_call(&mut self, b: &ReasoningBudget) -> Result<()> {
        if self.model_calls >= b.max_model_calls {
            return Err(NexusError::exhausted("model-call budget exhausted"));
        }
        self.model_calls += 1;
        Ok(())
    }
    pub fn record_tool_call(&mut self, b: &ReasoningBudget) -> Result<()> {
        if self.tool_calls >= b.max_tool_calls {
            return Err(NexusError::exhausted("tool-call budget exhausted"));
        }
        self.tool_calls += 1;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded() {
        let b = ReasoningBudget {
            max_steps: 1,
            ..Default::default()
        };
        let mut t = ReasoningTrace::default();
        let s = ReasoningStep {
            index: 0,
            at: Timestamp::from_millis(0),
            observation_refs: vec![],
            candidate_action_codes: vec![],
            rejected_action_codes: vec![],
            selected_action_code: None,
            confidence: 1.0,
            evaluator_codes: vec![],
        };
        t.push(&b, s.clone()).unwrap();
        assert!(t.push(&b, s).is_err());
    }
    #[test]
    fn time_cannot_move_backwards() {
        let b = ReasoningBudget::default();
        let mut t = ReasoningTrace::default();
        let step = |i, ms| ReasoningStep {
            index: i,
            at: Timestamp::from_millis(ms),
            observation_refs: vec![],
            candidate_action_codes: vec![],
            rejected_action_codes: vec![],
            selected_action_code: None,
            confidence: 1.0,
            evaluator_codes: vec![],
        };
        t.push(&b, step(0, 10)).unwrap();
        assert!(t.push(&b, step(1, 9)).is_err());
    }
}
