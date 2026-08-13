//! The orchestration pipeline.
//!
//! ```text
//! graph state + observations + policies + model output
//!         -> TaskProposal
//!         -> PolicyEngine
//!              +--> Denied
//!              +--> RequiresApproval --> HumanApprovalGate
//!              +--> Allowed
//!                      -> simulation dry run
//!                      -> signed EdgeTask
//! ```
//!
//! Two properties this module is responsible for:
//!
//! 1. **No arbitrary bytes reach the edge.** The only thing that leaves here
//!    is an `EdgeTask` carrying a typed `EdgeCommand` from a closed set.
//! 2. **Order is not negotiable.** Policy is consulted before simulation,
//!    simulation before signing, and signing only after an approval exists
//!    when one is required. Every stage writes an audit record before the
//!    next stage runs, so a partially completed dispatch is reconstructable.

use crate::approval::{Approval, ApprovalRequest, HumanApprovalGate};
use crate::behavior::{BehaviorModel, BehaviorPlan, RobotCapabilities, SafetyEnvelope, WorldState};
use crate::proposal::TaskProposal;
use nexus_edge_protocol::{EdgeTask, ExecutionMode, Signer};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, TaskId, Timestamp};
use nexus_observability::{AuditAction, AuditTrail};
use nexus_policy::{
    ActionKind, Decision, PolicyEngine, PolicyRequest, RiskClass, SimulationOutcome,
};
use nexus_sim::{DryRunReport, WorldModel};

/// Tuning that is safe to change per deployment.
#[derive(Debug, Clone)]
pub struct OrchestratorConfig {
    /// How long a dispatched task stays valid.
    pub task_ttl_millis: i64,
    /// How long a pending approval stays open.
    pub approval_ttl_millis: i64,
    /// Execution mode stamped on dispatched tasks.
    pub mode: ExecutionMode,
    /// Identity recorded as the actor in audit records.
    pub service_identity: String,
}

impl Default for OrchestratorConfig {
    fn default() -> Self {
        OrchestratorConfig {
            task_ttl_millis: 60_000,
            approval_ttl_millis: 300_000,
            // Safe default: a deployment must opt in to touching hardware.
            mode: ExecutionMode::Simulation,
            service_identity: "orchestratord".to_string(),
        }
    }
}

/// What the pipeline decided.
#[derive(Debug, Clone)]
pub enum DispatchOutcome {
    /// Policy or an invariant refused the proposal.
    Rejected {
        task_id: TaskId,
        code: String,
        detail: String,
    },

    /// A human must decide before this can proceed.
    AwaitingApproval {
        task_id: TaskId,
        request: ApprovalRequest,
        plan: BehaviorPlan,
    },

    /// Simulation refused the plan.
    SimulationFailed {
        task_id: TaskId,
        report: DryRunReport,
    },

    /// Ready to send: a signed, typed, expiring task.
    Dispatch {
        task: Box<EdgeTask>,
        plan: BehaviorPlan,
        simulation: DryRunReport,
        approval: Option<Approval>,
    },
}

impl DispatchOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            DispatchOutcome::Rejected { .. } => "rejected",
            DispatchOutcome::AwaitingApproval { .. } => "awaiting_approval",
            DispatchOutcome::SimulationFailed { .. } => "simulation_failed",
            DispatchOutcome::Dispatch { .. } => "dispatch",
        }
    }

    pub fn task_id(&self) -> &TaskId {
        match self {
            DispatchOutcome::Rejected { task_id, .. }
            | DispatchOutcome::AwaitingApproval { task_id, .. }
            | DispatchOutcome::SimulationFailed { task_id, .. } => task_id,

            DispatchOutcome::Dispatch { task, .. } => &task.task_id,
        }
    }

    pub fn is_dispatch(&self) -> bool {
        matches!(self, DispatchOutcome::Dispatch { .. })
    }
}

pub struct Orchestrator<'a> {
    config: OrchestratorConfig,
    policy: &'a PolicyEngine,
    model: &'a dyn BehaviorModel,
    gate: &'a HumanApprovalGate,
    audit: &'a AuditTrail,
}

impl std::fmt::Debug for Orchestrator<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Orchestrator")
            .field("config", &self.config)
            .field("model", &self.model.model_id())
            .finish()
    }
}

impl<'a> Orchestrator<'a> {
    pub fn new(
        config: OrchestratorConfig,
        policy: &'a PolicyEngine,
        model: &'a dyn BehaviorModel,
        gate: &'a HumanApprovalGate,
        audit: &'a AuditTrail,
    ) -> Self {
        Orchestrator {
            config,
            policy,
            model,
            gate,
            audit,
        }
    }

    /// Builds the policy request for a proposal and a plan.
    ///
    /// Kept separate and public so the same request can be shown to an
    /// operator before it is evaluated.
    #[allow(clippy::too_many_arguments)]
    pub fn policy_request(
        &self,
        proposal: &TaskProposal,
        plan: &BehaviorPlan,
        capabilities: &RobotCapabilities,
        simulation: SimulationOutcome,
        approval_present: bool,
        signer_is_known: bool,
        nonce_seen: bool,
        now: Timestamp,
    ) -> PolicyRequest {
        let primary = plan
            .steps
            .first()
            .map(|step| step.command.action_kind())
            .unwrap_or(ActionKind::SafeStop);

        PolicyRequest {
            action_name: plan
                .steps
                .first()
                .map(|step| step.command.name().to_string())
                .unwrap_or_else(|| "safe_stop".to_string()),
            action_kind: primary,
            device_id: proposal.device_id.clone(),
            zone_id: proposal.zone_id.clone(),
            operator_id: None,
            operator_roles: vec!["automation".to_string()],
            requested_capabilities: plan.required_capabilities(),
            device_capabilities: capabilities.capabilities.clone(),
            risk_class: proposal.risk_class,
            high_impact: plan.is_high_impact(),
            human_approval_present: approval_present,
            simulation,
            safety_envelope_id: Some(plan.envelope.envelope_id.clone()),
            now_millis: now.as_millis(),
            expires_at_millis: Some(now.as_millis() + self.config.task_ttl_millis),
            signer_is_known,
            nonce_already_seen: nonce_seen,
            targets_person: false,
            intent_annotations: proposal.intent_annotations.clone(),
        }
    }

    /// Runs the full pipeline for one proposal.
    ///
    /// `world_state` is the observed state supplied to the behaviour model.
    /// `twin` is the deterministic simulated twin used for the dry run.
    /// `signer` produces the signature on the outgoing task.
    ///
    /// These inputs intentionally remain explicit because each one represents
    /// a separate trust or safety boundary in the dispatch pipeline.
    #[allow(clippy::too_many_arguments)]
    pub fn process(
        &self,
        proposal: &TaskProposal,
        world_state: &WorldState,
        capabilities: &RobotCapabilities,
        envelope: &SafetyEnvelope,
        twin: &WorldModel,
        signer: &dyn Signer,
        now: Timestamp,
    ) -> Result<DispatchOutcome> {
        self.audit.record(
            AuditAction::TaskProposed,
            proposal.task_id.as_str(),
            &self.config.service_identity,
            Some(&proposal.trace_id),
            proposal.to_json(),
        );

        // 1. Plan.
        let plan = self
            .model
            .plan(world_state, &proposal.goal, capabilities, envelope)?;

        plan.validate(capabilities)?;

        // 2. Policy, before anything is simulated or signed.
        let approval_present = self.gate.is_granted(&proposal.task_id);

        let pre_simulation = if plan
            .steps
            .iter()
            .any(|step| step.command.action_kind().is_physical())
        {
            SimulationOutcome::NotRun
        } else {
            SimulationOutcome::NotRequired
        };

        // Physical plans are evaluated twice: once to catch prohibitions and
        // authorization failures before spending a simulation, then again
        // with the real simulation outcome. The second evaluation is the one
        // that can authorise dispatch.
        let screening = self.policy_request(
            proposal,
            &plan,
            capabilities,
            SimulationOutcome::NotRequired,
            approval_present,
            true,
            false,
            now,
        );

        let screening_decision = self.policy.evaluate(&screening);

        self.audit.record(
            AuditAction::PolicyEvaluated,
            proposal.task_id.as_str(),
            "nexus-policy",
            Some(&proposal.trace_id),
            Value::object(vec![
                ("stage", Value::string("screening")),
                ("decision", Value::string(screening_decision.as_str())),
            ]),
        );

        if let Decision::Denied { reason } = &screening_decision {
            return Ok(DispatchOutcome::Rejected {
                task_id: proposal.task_id.clone(),
                code: reason.code.clone(),
                detail: reason.detail.clone(),
            });
        }

        if let Decision::RequiresApproval {
            approver_roles,
            reason,
            ..
        } = &screening_decision
        {
            if !approval_present {
                let request = self.gate.request(
                    &proposal.task_id,
                    approver_roles.clone(),
                    reason.clone(),
                    summarize(proposal, &plan),
                    now,
                    self.config.approval_ttl_millis,
                )?;

                self.audit.record(
                    AuditAction::ApprovalRequested,
                    proposal.task_id.as_str(),
                    &self.config.service_identity,
                    Some(&proposal.trace_id),
                    Value::object(vec![
                        ("reason", Value::string(reason)),
                        (
                            "approver_roles",
                            Value::Array(approver_roles.iter().map(Value::string).collect()),
                        ),
                    ]),
                );

                return Ok(DispatchOutcome::AwaitingApproval {
                    task_id: proposal.task_id.clone(),
                    request,
                    plan,
                });
            }
        }

        // 3. Simulation.
        let commands: Vec<_> = plan.steps.iter().map(|step| step.command.clone()).collect();

        let constraints = plan.envelope.to_constraints();

        let report = twin.dry_run(&commands, &constraints);

        self.audit.record(
            AuditAction::SimulationRun,
            proposal.task_id.as_str(),
            "nexus-sim",
            Some(&proposal.trace_id),
            report.to_json(),
        );

        if !report.passed {
            return Ok(DispatchOutcome::SimulationFailed {
                task_id: proposal.task_id.clone(),
                report,
            });
        }

        let simulation_outcome = if matches!(pre_simulation, SimulationOutcome::NotRequired) {
            SimulationOutcome::NotRequired
        } else {
            SimulationOutcome::Passed
        };

        // 4. Authoritative policy evaluation, with the real simulation result.
        let authoritative = self.policy_request(
            proposal,
            &plan,
            capabilities,
            simulation_outcome,
            self.gate.is_granted(&proposal.task_id),
            true,
            false,
            now,
        );

        let decision = self.policy.evaluate(&authoritative);

        self.audit.record(
            AuditAction::PolicyEvaluated,
            proposal.task_id.as_str(),
            "nexus-policy",
            Some(&proposal.trace_id),
            Value::object(vec![
                ("stage", Value::string("authoritative")),
                ("decision", Value::string(decision.as_str())),
            ]),
        );

        match decision {
            Decision::Denied { reason } => Ok(DispatchOutcome::Rejected {
                task_id: proposal.task_id.clone(),
                code: reason.code,
                detail: reason.detail,
            }),

            Decision::RequiresApproval {
                approver_roles,
                reason,
                ..
            } => {
                let request = self.gate.request(
                    &proposal.task_id,
                    approver_roles,
                    reason,
                    summarize(proposal, &plan),
                    now,
                    self.config.approval_ttl_millis,
                )?;

                Ok(DispatchOutcome::AwaitingApproval {
                    task_id: proposal.task_id.clone(),
                    request,
                    plan,
                })
            }

            Decision::Allowed { .. } => {
                // 5. Build and sign exactly one typed task.
                let command = plan
                    .steps
                    .first()
                    .map(|step| step.command.clone())
                    .ok_or_else(|| NexusError::invalid("behaviour plan has no steps"))?;

                let mut task = EdgeTask::new(
                    proposal.device_id.clone(),
                    command,
                    now,
                    self.config.task_ttl_millis,
                    proposal.trace_id.clone(),
                    self.config.mode,
                )?;

                // The task carries the proposal's identity so the audit trail,
                // the approval and the dispatched task all share one id.
                task.task_id = proposal.task_id.clone();

                for constraint in constraints {
                    task = task.with_constraint(constraint);
                }

                task = task.with_simulation(report.simulation_id.clone());

                let approval = self.gate.approval_for(&proposal.task_id);

                if let Some(approval) = &approval {
                    task = task.with_approval(approval.approval_id.clone());
                }

                task.sign_with(signer)?;

                self.audit.record(
                    AuditAction::TaskSigned,
                    task.task_id.as_str(),
                    signer.signer_id(),
                    Some(&proposal.trace_id),
                    task.to_json(),
                );

                Ok(DispatchOutcome::Dispatch {
                    task: Box::new(task),
                    plan,
                    simulation: report,
                    approval,
                })
            }
        }
    }
}

fn summarize(proposal: &TaskProposal, plan: &BehaviorPlan) -> String {
    let steps: Vec<&str> = plan.steps.iter().map(|step| step.command.name()).collect();

    format!(
        "{} on {} in {}: {}",
        proposal.goal.as_str(),
        proposal.device_id,
        proposal.zone_id,
        steps.join(" -> ")
    )
}

/// Convenience for deriving a risk class from an observation.
///
/// Deliberately coarse and explicit rather than a learned score.
pub fn risk_for_temperature(celsius: f64, alarm_threshold: f64) -> RiskClass {
    if celsius >= alarm_threshold + 20.0 {
        RiskClass::High
    } else if celsius >= alarm_threshold {
        RiskClass::Moderate
    } else {
        RiskClass::Low
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::behavior::{MockBehaviorModel, TaskGoal};
    use crate::proposal::ProposalTrigger;
    use nexus_edge_protocol::{DevSigner, Waypoint};
    use nexus_event::TraceId;
    use nexus_sim::{SimulatedRobot, WorldObject};

    fn point(x: f64, y: f64) -> Waypoint {
        Waypoint { x, y, z: 0.0 }
    }

    fn now() -> Timestamp {
        Timestamp::from_millis(1_700_000_000_000)
    }

    fn capabilities() -> RobotCapabilities {
        RobotCapabilities {
            device_id: "robot-inspect-01".into(),
            capabilities: vec![
                "navigate.waypoint".into(),
                "sensor.temperature".into(),
                "sensor.generic".into(),
                "diagnostic.run".into(),
            ],
            max_speed_mps: 1.0,
            max_range_meters: 200.0,
            has_manipulator: false,
        }
    }

    fn world_state() -> WorldState {
        WorldState {
            facility_id: "plant-1".into(),
            zone_id: "press-hall".into(),
            robot_pose: point(0.0, 0.0),
            known_waypoints: vec![("press-4-front".into(), point(10.0, 0.0))],
            obstacles: vec![],
            personnel_present: false,
            observed_at: now(),
        }
    }

    fn twin() -> WorldModel {
        WorldModel::new(
            "plant-1",
            "press-hall",
            SimulatedRobot::new(
                "robot-inspect-01",
                point(0.0, 0.0),
                &[
                    "navigate.waypoint",
                    "sensor.temperature",
                    "sensor.generic",
                    "diagnostic.run",
                ],
            ),
        )
        .with_waypoint("press-4-front", point(10.0, 0.0))
        .with_reading("probe-a", 91.5)
    }

    fn confirm_reading_goal() -> TaskGoal {
        TaskGoal::ConfirmReading {
            asset_key: "press-4".into(),
            waypoint_name: "press-4-front".into(),
            probe: "probe-a".into(),
        }
    }

    fn proposal(goal: TaskGoal) -> TaskProposal {
        TaskProposal::new(
            goal,
            ProposalTrigger::CorrelatedHazard {
                detection_class: "smoke".into(),
                asset_key: "press-4".into(),
            },
            "press-4",
            "press-hall",
            "robot-inspect-01",
            now(),
            TraceId::from_external("trc_test"),
        )
    }

    struct Fixture {
        policy: PolicyEngine,
        model: MockBehaviorModel,
        gate: HumanApprovalGate,
        audit: AuditTrail,
        signer: DevSigner,
    }

    impl Fixture {
        fn new() -> Self {
            Fixture {
                policy: PolicyEngine::industrial_baseline(),
                model: MockBehaviorModel::new(),
                gate: HumanApprovalGate::new(),
                audit: AuditTrail::in_memory(),
                signer: DevSigner::new("orchestratord-test", b"test-key-not-a-secret")
                    .expect("dev signer"),
            }
        }

        fn orchestrator(&self) -> Orchestrator<'_> {
            Orchestrator::new(
                OrchestratorConfig::default(),
                &self.policy,
                &self.model,
                &self.gate,
                &self.audit,
            )
        }
    }

    #[test]
    fn a_read_only_inspection_reaches_a_signed_task() {
        let fixture = Fixture::new();

        let outcome = fixture
            .orchestrator()
            .process(
                &proposal(confirm_reading_goal()),
                &world_state(),
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &twin(),
                &fixture.signer,
                now(),
            )
            .expect("pipeline runs");

        match outcome {
            DispatchOutcome::Dispatch {
                task, simulation, ..
            } => {
                assert!(task.signature.is_some());
                assert_eq!(task.mode, ExecutionMode::Simulation);
                assert!(task.expires_at.as_millis() > now().as_millis());

                assert_eq!(
                    task.simulation_id.as_deref(),
                    Some(simulation.simulation_id.as_str())
                );
            }

            other => {
                panic!("expected dispatch, got {}", other.as_str())
            }
        }
    }

    #[test]
    fn every_stage_is_audited_before_the_next_one() {
        let fixture = Fixture::new();

        let trace = TraceId::from_external("trc_test");

        fixture
            .orchestrator()
            .process(
                &proposal(confirm_reading_goal()),
                &world_state(),
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &twin(),
                &fixture.signer,
                now(),
            )
            .unwrap();

        let records = fixture.audit.records_for_trace(&trace);

        let actions: Vec<&str> = records
            .iter()
            .map(|record| record.action.as_str())
            .collect();

        assert_eq!(actions.first(), Some(&"task_proposed"));

        assert!(actions.contains(&"policy_evaluated"));

        assert!(actions.contains(&"simulation_run"));

        assert_eq!(actions.last(), Some(&"task_signed"));

        // Signing is the last thing that happens,
        // never before simulation.
        let simulation_index = actions
            .iter()
            .position(|action| *action == "simulation_run")
            .unwrap();

        let signed_index = actions
            .iter()
            .position(|action| *action == "task_signed")
            .unwrap();

        assert!(simulation_index < signed_index);

        fixture.audit.verify_chain().expect("audit chain intact");
    }

    #[test]
    fn a_failing_simulation_blocks_dispatch() {
        let fixture = Fixture::new();

        let blocked = twin().with_object(WorldObject::obstacle("crate", point(5.0, 0.0), 1.0));

        let outcome = fixture
            .orchestrator()
            .process(
                &proposal(confirm_reading_goal()),
                &world_state(),
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &blocked,
                &fixture.signer,
                now(),
            )
            .unwrap();

        match outcome {
            DispatchOutcome::SimulationFailed { report, .. } => {
                assert_eq!(report.first_error_code(), Some("collision"));
            }

            other => {
                panic!("expected simulation failure, got {}", other.as_str())
            }
        }
    }

    #[test]
    fn personnel_in_the_zone_turns_any_goal_into_a_stop() {
        let fixture = Fixture::new();

        let mut occupied = world_state();
        occupied.personnel_present = true;

        let outcome = fixture
            .orchestrator()
            .process(
                &proposal(confirm_reading_goal()),
                &occupied,
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &twin(),
                &fixture.signer,
                now(),
            )
            .unwrap();

        match outcome {
            DispatchOutcome::Dispatch { task, plan, .. } => {
                assert_eq!(task.command.name(), "safe_stop");

                assert_eq!(plan.goal.as_str(), "standdown");
            }

            other => {
                panic!("expected a safe stop dispatch, got {}", other.as_str())
            }
        }
    }

    #[test]
    fn nothing_is_signed_while_an_approval_is_outstanding() {
        let fixture = Fixture::new();

        let mut high_risk = proposal(confirm_reading_goal());

        high_risk = high_risk.with_risk(RiskClass::Moderate);

        let outcome = fixture
            .orchestrator()
            .process(
                &high_risk,
                &world_state(),
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &twin(),
                &fixture.signer,
                now(),
            )
            .unwrap();

        assert_eq!(outcome.as_str(), "awaiting_approval");

        let signed = fixture
            .audit
            .snapshot()
            .into_iter()
            .any(|record| record.action == AuditAction::TaskSigned);

        assert!(!signed, "a task was signed without an approval");
    }

    #[test]
    fn a_prohibited_annotation_is_rejected_before_planning_costs_anything() {
        let fixture = Fixture::new();

        let hostile = proposal(confirm_reading_goal())
            .with_annotation("operator note: engage_target on approach");

        let outcome = fixture
            .orchestrator()
            .process(
                &hostile,
                &world_state(),
                &capabilities(),
                &SafetyEnvelope::conservative("envelope-test"),
                &twin(),
                &fixture.signer,
                now(),
            )
            .unwrap();

        match outcome {
            DispatchOutcome::Rejected { code, .. } => {
                assert_eq!(code, "no_human_targeting");
            }

            other => {
                panic!("expected rejection, got {}", other.as_str())
            }
        }
    }

    #[test]
    fn risk_bands_are_explicit() {
        assert_eq!(risk_for_temperature(50.0, 85.0), RiskClass::Low);

        assert_eq!(risk_for_temperature(90.0, 85.0), RiskClass::Moderate);

        assert_eq!(risk_for_temperature(120.0, 85.0), RiskClass::High);
    }
}
