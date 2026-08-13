//! # warehouse-robot — the human approval gate, demonstrated
//!
//! A pallet is detected out of zone and the obvious automated response is to
//! have a robot reposition a fixture. That is a high-impact physical action,
//! so this example shows the part of the system that refuses to do it on its
//! own:
//!
//! 1. The proposal is made.
//! 2. Policy returns `RequiresApproval` — nothing is signed.
//! 3. An operator without the right role is rejected.
//! 4. An expired approval window is rejected.
//! 5. A supervisor approves, and only then does a signed task exist.
//!
//! Run it: `cargo run -p warehouse-robot`

use nexus_agent::behavior::{RobotCapabilities, SafetyEnvelope, TaskGoal, WorldState};
use nexus_agent::{
    ApprovalDecision, DispatchOutcome, HumanApprovalGate, MockBehaviorModel, Orchestrator,
    OrchestratorConfig, ProposalTrigger, TaskProposal,
};
use nexus_edge_protocol::{DevSigner, ExecutionMode, Waypoint};
use nexus_event::{NexusError, Result, Timestamp, TraceId};
use nexus_observability::AuditTrail;
use nexus_policy::{PolicyEngine, RiskClass};
use nexus_sim::{SimulatedRobot, WorldModel};

fn main() {
    if let Err(error) = run() {
        eprintln!("EXAMPLE FAILED: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let now = Timestamp::from_millis(1_700_000_000_000);
    let trace = TraceId::from_external("trc_warehouse_demo");

    let policy = PolicyEngine::industrial_baseline();
    let model = MockBehaviorModel::new();
    let gate = HumanApprovalGate::new();
    let audit = AuditTrail::in_memory();
    let signer = DevSigner::new("orchestratord-demo", b"demo-key-not-a-production-secret")?;

    let capabilities = RobotCapabilities {
        device_id: "robot-warehouse-03".into(),
        capabilities: vec!["navigate.waypoint".into(), "sensor.generic".into()],
        max_speed_mps: 1.2,
        max_range_meters: 150.0,
        has_manipulator: false,
    };

    let world_state = WorldState {
        facility_id: "dc-2".into(),
        zone_id: "aisle-7".into(),
        robot_pose: Waypoint::new(0.0, 0.0, 0.0)?,
        known_waypoints: vec![("bay-14".into(), Waypoint::new(18.0, 0.0, 0.0)?)],
        obstacles: vec![],
        personnel_present: false,
        observed_at: now,
    };

    let twin = WorldModel::new(
        "dc-2",
        "aisle-7",
        SimulatedRobot::new(
            "robot-warehouse-03",
            Waypoint::new(0.0, 0.0, 0.0)?,
            &["navigate.waypoint", "sensor.generic"],
        ),
    )
    .with_waypoint("bay-14", Waypoint::new(18.0, 0.0, 0.0)?)
    .with_reading("bay-scan", 1.0);

    // Moderate risk navigation in an occupied distribution centre.
    let proposal = TaskProposal::new(
        TaskGoal::InspectZone {
            zone_id: "aisle-7".into(),
            dwell_seconds: 20,
        },
        ProposalTrigger::CorrelatedHazard {
            detection_class: "object_out_of_zone".into(),
            asset_key: "pallet-8821".into(),
        },
        "pallet-8821",
        "aisle-7",
        "robot-warehouse-03",
        now,
        trace.clone(),
    )
    .with_risk(RiskClass::Moderate);

    let orchestrator = Orchestrator::new(
        OrchestratorConfig {
            mode: ExecutionMode::Simulation,
            ..OrchestratorConfig::default()
        },
        &policy,
        &model,
        &gate,
        &audit,
    );

    println!("NEXUS V3 — warehouse-robot: the human approval gate\n");

    println!("[1] Proposal submitted at moderate risk");
    let outcome = orchestrator.process(
        &proposal,
        &world_state,
        &capabilities,
        &SafetyEnvelope::conservative("envelope-warehouse"),
        &twin,
        &signer,
        now,
    )?;

    let request = match outcome {
        DispatchOutcome::AwaitingApproval { request, .. } => {
            println!("    -> policy: REQUIRES APPROVAL");
            println!("    -> reason: {}", request.reason);
            println!("    -> approvers: {}", request.approver_roles.join(", "));
            request
        }
        other => {
            return Err(NexusError::denied(format!(
                "expected an approval requirement, got '{}'",
                other.as_str()
            )))
        }
    };

    println!("\n[2] Nothing was signed while the request is outstanding");
    let signed_count = audit
        .snapshot()
        .into_iter()
        .filter(|record| record.action == nexus_observability::AuditAction::TaskSigned)
        .count();
    println!("    -> signed tasks so far: {signed_count}");
    if signed_count != 0 {
        return Err(NexusError::denied("a task was signed before approval"));
    }

    println!("\n[3] An operator without the required role is refused");
    let wrong_role = gate.decide(
        &proposal.task_id,
        "op-99",
        "warehouse_picker",
        ApprovalDecision::Granted,
        "looks fine to me",
        now,
    );
    match wrong_role {
        Err(error) => println!("    -> refused: {error}"),
        Ok(_) => return Err(NexusError::denied("an unauthorised role was accepted")),
    }

    println!("\n[4] A decision after the window closed is refused");
    let too_late = gate.decide(
        &proposal.task_id,
        "op-01",
        "site_supervisor",
        ApprovalDecision::Granted,
        "approved late",
        Timestamp::from_millis(request.expires_at.as_millis() + 1_000),
    );
    match too_late {
        Err(error) => println!("    -> refused: {error}"),
        Ok(_) => return Err(NexusError::denied("an expired approval was accepted")),
    }

    println!("\n[5] A supervisor approves inside the window");
    let approval = gate.decide(
        &proposal.task_id,
        "op-01",
        "site_supervisor",
        ApprovalDecision::Granted,
        "aisle cleared, proceed with inspection",
        Timestamp::from_millis(now.as_millis() + 30_000),
    )?;
    println!("    -> approval id: {}", approval.approval_id);
    println!("    -> operator   : {} ({})", approval.operator_id, approval.operator_role);

    println!("\n[6] The same proposal now reaches a signed task");
    let outcome = orchestrator.process(
        &proposal,
        &world_state,
        &capabilities,
        &SafetyEnvelope::conservative("envelope-warehouse"),
        &twin,
        &signer,
        Timestamp::from_millis(now.as_millis() + 31_000),
    )?;

    match outcome {
        DispatchOutcome::Dispatch { task, .. } => {
            println!("    -> command  : {}", task.command.name());
            println!("    -> approval : {}", task.approval_id.as_deref().unwrap_or("none"));
            if task.approval_id.is_none() {
                return Err(NexusError::denied("dispatched task lost its approval link"));
            }
        }
        other => {
            return Err(NexusError::denied(format!(
                "expected dispatch after approval, got '{}'",
                other.as_str()
            )))
        }
    }

    audit.verify_chain().map_err(NexusError::integrity)?;
    println!("\nPASS — no high-impact action was dispatched without a recorded human decision.");
    Ok(())
}
