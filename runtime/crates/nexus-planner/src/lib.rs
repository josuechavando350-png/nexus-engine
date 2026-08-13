//! Typed plan graph and deterministic validation/scoring.
#![forbid(unsafe_code)]

use nexus_event::{NexusError, Result};
use nexus_goal::Goal;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq)]
pub struct PlanNode {
    pub id: String,
    pub action: String,
    pub prerequisites: Vec<String>,
    pub expected_effect: String,
    pub required_capability: String,
    pub policy_context: String,
    pub confidence: f64,
    pub timeout_millis: u64,
    pub max_retries: u32,
    pub reversible: bool,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Plan {
    pub id: String,
    pub goal_id: String,
    pub schema_version: u16,
    pub nodes: Vec<PlanNode>,
}

impl Plan {
    pub fn validate(&self) -> Result<()> {
        if self.schema_version != 1 {
            return Err(NexusError::schema("unsupported plan schema version"));
        }

        if self.nodes.is_empty() {
            return Err(NexusError::invalid("plan requires at least one node"));
        }

        let mut ids = BTreeSet::new();

        for n in &self.nodes {
            if n.id.trim().is_empty() || !ids.insert(n.id.clone()) {
                return Err(NexusError::invalid("empty/duplicate plan node id"));
            }

            if n.action.trim().is_empty()
                || n.required_capability.trim().is_empty()
                || n.policy_context.trim().is_empty()
            {
                return Err(NexusError::schema(
                    "plan node action/capability/policy required",
                ));
            }

            if n.timeout_millis == 0 {
                return Err(NexusError::invalid("plan node timeout must be positive"));
            }

            if !(0.0..=1.0).contains(&n.confidence) || !n.confidence.is_finite() {
                return Err(NexusError::invalid("plan confidence outside [0,1]"));
            }

            if n.evidence_refs.is_empty() {
                return Err(NexusError::invalid("plan node lacks evidence"));
            }
        }

        for n in &self.nodes {
            for d in &n.prerequisites {
                if !ids.contains(d) {
                    return Err(NexusError::invalid("plan dependency missing"));
                }
            }
        }

        if has_cycle(&self.nodes) {
            return Err(NexusError::invalid("plan contains dependency cycle"));
        }

        Ok(())
    }
}

fn has_cycle(nodes: &[PlanNode]) -> bool {
    let map: BTreeMap<_, _> = nodes.iter().map(|n| (n.id.as_str(), n)).collect();

    fn visit<'a>(
        id: &'a str,
        map: &BTreeMap<&'a str, &'a PlanNode>,
        vis: &mut BTreeSet<&'a str>,
        stack: &mut BTreeSet<&'a str>,
    ) -> bool {
        if stack.contains(id) {
            return true;
        }

        if !vis.insert(id) {
            return false;
        }

        stack.insert(id);

        if let Some(n) = map.get(id) {
            for d in &n.prerequisites {
                if visit(d, map, vis, stack) {
                    return true;
                }
            }
        }

        stack.remove(id);
        false
    }

    let mut vis = BTreeSet::new();

    for id in map.keys().copied() {
        let mut stack = BTreeSet::new();

        if visit(id, &map, &mut vis, &mut stack) {
            return true;
        }
    }

    false
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CandidateScore {
    pub success: f64,
    pub risk: f64,
    pub resource_cost: f64,
    pub time_cost: f64,
    pub reversibility: f64,
    pub uncertainty: f64,
    pub policy_compatibility: f64,
}

impl CandidateScore {
    pub fn total(self) -> f64 {
        2.0 * self.success + 1.5 * self.policy_compatibility + self.reversibility
            - self.risk
            - self.resource_cost * 0.5
            - self.time_cost * 0.25
            - self.uncertainty
    }
}

pub trait Planner: Send + Sync {
    fn propose(&self, goal: &Goal, evidence: &[String]) -> Result<Vec<Plan>>;
}

#[derive(Debug, Default)]
pub struct DeterministicPlanner;

impl Planner for DeterministicPlanner {
    fn propose(&self, goal: &Goal, evidence: &[String]) -> Result<Vec<Plan>> {
        if evidence.is_empty() {
            return Err(NexusError::invalid("planner requires evidence"));
        }

        let node = PlanNode {
            id: "step-1".into(),
            action: "inspect_state".into(),
            prerequisites: vec![],
            expected_effect: "state refreshed".into(),
            required_capability: "observe".into(),
            policy_context: goal.policy_scope.clone(),
            confidence: 1.0,
            timeout_millis: 5_000,
            max_retries: 1,
            reversible: true,
            evidence_refs: evidence.to_vec(),
        };

        let p = Plan {
            id: format!("plan:{}:0", goal.id),
            goal_id: goal.id.clone(),
            schema_version: 1,
            nodes: vec![node],
        };

        p.validate()?;
        Ok(vec![p])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cycle_rejected() {
        let n = |id: &str, d: &str| PlanNode {
            id: id.into(),
            action: "x".into(),
            prerequisites: vec![d.into()],
            expected_effect: "x".into(),
            required_capability: "observe".into(),
            policy_context: "d".into(),
            confidence: 1.0,
            timeout_millis: 1,
            max_retries: 0,
            reversible: true,
            evidence_refs: vec!["e".into()],
        };

        let p = Plan {
            id: "p".into(),
            goal_id: "g".into(),
            schema_version: 1,
            nodes: vec![n("a", "b"), n("b", "a")],
        };

        assert!(p.validate().is_err());
    }

    #[test]
    fn risk_lowers_score() {
        let a = CandidateScore {
            success: 1.0,
            risk: 0.0,
            resource_cost: 0.0,
            time_cost: 0.0,
            reversibility: 1.0,
            uncertainty: 0.0,
            policy_compatibility: 1.0,
        };

        let mut b = a;
        b.risk = 1.0;

        assert!(a.total() > b.total());
    }
}
