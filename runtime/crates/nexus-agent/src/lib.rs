//! # nexus-agent
//!
//! Turns graph state plus observations into proposals, and proposals into
//! signed edge tasks — never skipping a gate.
//!
//! ```text
//! graph state + observations + policies + model output
//!         -> TaskProposal
//!         -> PolicyEngine
//!              +-- Denied
//!              +-- RequiresApproval -> HumanApprovalGate
//!              +-- Allowed
//!                    -> simulation dry run
//!                    -> signed EdgeTask
//! ```
//!
//! ## On behaviour models
//!
//! [`BehaviorModel`] is a trait, and [`MockBehaviorModel`] is a deterministic
//! rule-based implementation. There is no trained large behaviour model in
//! this repository and nothing here pretends otherwise: `MockBehaviorModel`
//! reports `model_id() == "mock-rule-based-v1"` and `is_learned() == false`,
//! and the orchestrator records both in the audit trail for every plan it
//! acts on. Integrating a real model means implementing the trait; the gates
//! downstream of it do not change, which is the point.

#![forbid(unsafe_code)]

pub mod approval;
pub mod behavior;
pub mod orchestrator;
pub mod proposal;

pub use approval::{Approval, ApprovalDecision, ApprovalRequest, HumanApprovalGate};
pub use behavior::{
    BehaviorModel, BehaviorPlan, MockBehaviorModel, PlanStep, RobotCapabilities, SafetyEnvelope,
    TaskGoal, WorldState,
};
pub use orchestrator::{DispatchOutcome, Orchestrator, OrchestratorConfig};
pub use proposal::{ProposalTrigger, TaskProposal};
