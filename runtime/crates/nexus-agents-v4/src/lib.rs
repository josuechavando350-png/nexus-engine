//! Capability-bounded specialist delegation.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result};
use std::collections::BTreeSet;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRole {
    Coordinator,
    Planner,
    Researcher,
    Simulator,
    Executor,
    Evaluator,
    Recovery,
    Specialist,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSpec {
    pub id: String,
    pub role: AgentRole,
    pub capabilities: BTreeSet<String>,
    pub permitted_tools: BTreeSet<String>,
    pub max_steps: u32,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Delegation {
    pub parent_id: String,
    pub child_id: String,
    pub delegated_capabilities: BTreeSet<String>,
    pub task_code: String,
}
impl AgentSpec {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(NexusError::schema("agent id required"));
        }
        if self.max_steps == 0 {
            return Err(NexusError::invalid("agent max_steps must be positive"));
        }
        Ok(())
    }
}
impl Delegation {
    pub fn validate(&self, parent: &AgentSpec, child: &AgentSpec) -> Result<()> {
        parent.validate()?;
        child.validate()?;
        if self.task_code.trim().is_empty() {
            return Err(NexusError::schema("delegation task_code required"));
        }
        if self.parent_id != parent.id || self.child_id != child.id {
            return Err(NexusError::invalid("delegation identity mismatch"));
        }
        if !self.delegated_capabilities.is_subset(&parent.capabilities)
            || !self.delegated_capabilities.is_subset(&child.capabilities)
        {
            return Err(NexusError::denied("delegation would elevate capability"));
        }
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delegation_cannot_elevate() {
        let p = AgentSpec {
            id: "p".into(),
            role: AgentRole::Coordinator,
            capabilities: ["observe".to_string()].into_iter().collect(),
            permitted_tools: BTreeSet::new(),
            max_steps: 5,
        };
        let c = AgentSpec {
            id: "c".into(),
            role: AgentRole::Specialist,
            capabilities: ["observe".to_string(), "act".to_string()]
                .into_iter()
                .collect(),
            permitted_tools: BTreeSet::new(),
            max_steps: 5,
        };
        let d = Delegation {
            parent_id: "p".into(),
            child_id: "c".into(),
            delegated_capabilities: ["act".to_string()].into_iter().collect(),
            task_code: "x".into(),
        };
        assert!(d.validate(&p, &c).is_err());
    }
}
