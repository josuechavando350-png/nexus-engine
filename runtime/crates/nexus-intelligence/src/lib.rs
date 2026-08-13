//! V4 autonomous intelligence substrate.
//!
//! Deliberately does NOT depend on nexus-edge-protocol or a hardware adapter.
//! Its terminal output is a validated CognitiveDecision that must enter V3's
//! policy/simulation/approval/orchestrator pipeline before any physical effect.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result, Timestamp};
use nexus_goal::{Goal, GoalStatus};
use nexus_memory::{MemoryQuery, MemoryStore};
use nexus_planner::{Plan, Planner};
#[derive(Debug, Clone, PartialEq)]
pub struct CognitiveDecision {
    pub goal_id: String,
    pub plan: Plan,
    pub evidence_refs: Vec<String>,
    pub requires_v3_dispatch_gate: bool,
}
pub struct IntelligenceEngine<'a> {
    pub memory: &'a dyn MemoryStore,
    pub planner: &'a dyn Planner,
}
impl IntelligenceEngine<'_> {
    pub fn prepare(&self, goal: &mut Goal, now: Timestamp) -> Result<CognitiveDecision> {
        if goal.status == GoalStatus::Created {
            goal.transition(GoalStatus::Validated, now, "validated by V4")?;
        }
        if goal.status == GoalStatus::Validated {
            goal.transition(GoalStatus::Planning, now, "planning")?;
        }
        let memories = self.memory.query(&MemoryQuery {
            scope: Some(goal.policy_scope.clone()),
            at: Some(now),
            limit: 32,
            ..Default::default()
        })?;
        let evidence: Vec<String> = memories
            .iter()
            .flat_map(|m| m.source_refs.clone())
            .collect();
        if evidence.is_empty() {
            goal.transition(GoalStatus::Blocked, now, "no grounded evidence")?;
            return Err(NexusError::invalid(
                "autonomous planning requires grounded evidence",
            ));
        }
        let mut plans = self.planner.propose(goal, &evidence)?;
        let plan = plans
            .pop()
            .ok_or_else(|| NexusError::not_found("planner returned no candidate"))?;
        plan.validate()?;
        goal.transition(
            GoalStatus::Ready,
            now,
            "validated plan ready for V3 dispatch gates",
        )?;
        Ok(CognitiveDecision {
            goal_id: goal.id.clone(),
            plan,
            evidence_refs: evidence,
            requires_v3_dispatch_gate: true,
        })
    }
}
