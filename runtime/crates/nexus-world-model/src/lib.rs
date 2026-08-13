//! V4 world-state layering: observed/inferred/predicted/simulated/committed never collapse implicitly.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result, Timestamp};
use std::collections::BTreeMap;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactClass {
    Observed,
    Inferred,
    Predicted,
    Simulated,
    Committed,
}
#[derive(Debug, Clone, PartialEq)]
pub struct WorldFact {
    pub id: String,
    pub class: FactClass,
    pub value: String,
    pub provenance_refs: Vec<String>,
    pub confidence: f64,
    pub at: Timestamp,
}
impl WorldFact {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(NexusError::schema("world fact id required"));
        }
        if self.provenance_refs.is_empty() {
            return Err(NexusError::invalid("world fact lacks provenance"));
        }
        if !(0.0..=1.0).contains(&self.confidence) || !self.confidence.is_finite() {
            return Err(NexusError::invalid("world fact confidence outside [0,1]"));
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Default)]
pub struct WorldBranch {
    pub branch_id: String,
    pub facts: BTreeMap<String, WorldFact>,
    pub speculative: bool,
}
impl WorldBranch {
    pub fn fork(&self, id: impl Into<String>) -> Self {
        let mut c = self.clone();
        c.branch_id = id.into();
        c.speculative = true;
        c
    }
    pub fn insert(&mut self, f: WorldFact) -> Result<()> {
        f.validate()?;
        if self.speculative && f.class == FactClass::Observed {
            return Err(NexusError::invalid(
                "speculative branch cannot create observed fact",
            ));
        }
        self.facts.insert(f.id.clone(), f);
        Ok(())
    }
    pub fn promotable_facts(&self) -> Vec<&WorldFact> {
        self.facts
            .values()
            .filter(|f| matches!(f.class, FactClass::Committed | FactClass::Observed))
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simulation_cannot_become_observation() {
        let base = WorldBranch::default();
        let mut b = base.fork("sim");
        let f = WorldFact {
            id: "x".into(),
            class: FactClass::Observed,
            value: "x".into(),
            provenance_refs: vec!["evt".into()],
            confidence: 1.0,
            at: Timestamp::from_millis(0),
        };
        assert!(b.insert(f).is_err());
    }
}
