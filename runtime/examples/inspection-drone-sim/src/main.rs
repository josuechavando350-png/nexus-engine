//! # inspection-drone-sim — simulation, failure injection, and hard refusals
//!
//! An unarmed inspection drone surveying a substation. Three things are shown:
//!
//! 1. Deterministic dry-run: the same world and plan give the same result.
//! 2. Failure injection: a stalled sensor, an obstacle and a person entering
//!    the zone each stop the plan, in the simulator, before anything moves.
//! 3. The prohibitions: requests framed as targeting, pursuit or weapons are
//!    refused by an invariant that no policy configuration can switch off.
//!
//! Run it: `cargo run -p inspection-drone-sim`

use nexus_edge_protocol::{EdgeCommand, SafetyConstraint, Waypoint};
use nexus_event::{NexusError, Result};
use nexus_policy::{
    ActionKind, PolicyEngine, PolicyRequest, RiskClass, Rule, RuleOutcome, SimulationOutcome,
};
use nexus_sim::{FailureInjection, SimulatedRobot, WorldModel, WorldObject};

fn main() {
    if let Err(error) = run() {
        eprintln!("EXAMPLE FAILED: {error}");
        std::process::exit(1);
    }
}

fn point(x: f64, y: f64) -> Waypoint {
    Waypoint { x, y, z: 2.0 }
}

fn base_world() -> WorldModel {
    WorldModel::new(
        "substation-north",
        "yard-a",
        SimulatedRobot::new(
            "drone-inspect-07",
            point(0.0, 0.0),
            &[
                "navigate.waypoint",
                "sensor.thermal",
                "sensor.camera",
                "sensor.generic",
            ],
        ),
    )
    .with_waypoint("transformer-3", point(24.0, 0.0))
    .with_reading("thermal-1", 78.2)
}

fn constraints() -> Vec<SafetyConstraint> {
    vec![
        SafetyConstraint::MaxLinearSpeedMetersPerSecond(1.0),
        SafetyConstraint::MaxDurationSeconds(600.0),
        SafetyConstraint::GeofenceRadiusMeters(60.0),
        SafetyConstraint::MinHumanClearanceMeters(3.0),
    ]
}

fn plan() -> Vec<EdgeCommand> {
    vec![
        EdgeCommand::NavigateToWaypoint {
            waypoint: point(24.0, 0.0),
        },
        EdgeCommand::CollectThermalReading {
            probe: "thermal-1".into(),
        },
        EdgeCommand::ReturnToBase,
    ]
}

fn run() -> Result<()> {
    println!("NEXUS V3 — inspection-drone-sim (SIMULATION only)\n");

    println!("[1] Nominal dry run");
    let nominal = base_world().dry_run(&plan(), &constraints());
    println!("    passed        : {}", nominal.passed);
    println!(
        "    distance      : {:.1} m",
        nominal.detail.total_distance_meters
    );
    println!(
        "    duration      : {:.1} s",
        nominal.detail.total_duration_seconds
    );
    println!("    simulation id : {}", nominal.simulation_id);
    if !nominal.passed {
        return Err(NexusError::invalid("the nominal plan should pass"));
    }

    println!("\n[2] Determinism: the same inputs give the same run");
    let repeat = base_world().dry_run(&plan(), &constraints());
    println!("    identical     : {}", repeat == nominal);
    if repeat != nominal {
        return Err(NexusError::invalid("simulation is not deterministic"));
    }

    println!("\n[3] Failure injection");
    let cases: Vec<(&str, WorldModel)> = vec![
        (
            "thermal sensor fails",
            base_world().with_injection(FailureInjection::SensorFailure {
                sensor: "thermal-1".into(),
            }),
        ),
        (
            "obstacle on the approach",
            base_world().with_object(WorldObject::obstacle("scaffold", point(12.0, 0.0), 1.5)),
        ),
        (
            "technician enters the yard",
            base_world().with_injection(FailureInjection::PersonnelEntersZone { before_step: 1 }),
        ),
        (
            "keep-out area crossed",
            base_world().with_object(WorldObject::keep_out("live-bay", point(18.0, 0.0), 2.0)),
        ),
    ];

    for (label, world) in cases {
        let report = world.dry_run(&plan(), &constraints());
        println!(
            "    {:<28} -> {:<10} {}",
            label,
            if report.passed { "PASSED" } else { "BLOCKED" },
            report.first_error_code().unwrap_or("-")
        );
        if report.passed {
            return Err(NexusError::invalid(format!(
                "injected failure '{label}' should have blocked the plan"
            )));
        }
    }

    println!("\n[4] Hard invariants: prohibited intent is refused");
    // A deliberately permissive policy, to show the invariants are not part
    // of the configurable layer.
    let permissive =
        PolicyEngine::new().with_rule(Rule::new("allow-everything", RuleOutcome::Allow));

    let prohibited = [
        ("track_person", "person tracking"),
        ("pursue_person_of_interest", "pursuit"),
        ("weapon_release", "weapon release"),
        ("engage_target", "targeting"),
        ("facial_recognition_sweep", "biometric identification"),
    ];

    for (action, description) in prohibited {
        let request = PolicyRequest {
            action_name: action.into(),
            action_kind: ActionKind::Capture,
            device_id: "drone-inspect-07".into(),
            zone_id: "yard-a".into(),
            operator_id: Some("op-1".into()),
            operator_roles: vec!["site_supervisor".into()],
            requested_capabilities: vec![],
            device_capabilities: vec![],
            risk_class: RiskClass::Low,
            high_impact: false,
            human_approval_present: true,
            simulation: SimulationOutcome::Passed,
            safety_envelope_id: Some("envelope-drone".into()),
            now_millis: 1_700_000_000_000,
            expires_at_millis: Some(1_700_000_060_000),
            signer_is_known: true,
            nonce_already_seen: false,
            targets_person: false,
            intent_annotations: vec![],
        };

        let decision = permissive.evaluate(&request);
        println!(
            "    {:<30} -> {} ({})",
            description,
            decision.as_str(),
            decision.denial_code().unwrap_or("-")
        );
        if !decision.is_denied() {
            return Err(NexusError::denied(format!(
                "prohibited action '{action}' was not refused"
            )));
        }
    }

    println!("\nPASS — every injected failure blocked the plan, and every prohibited");
    println!("       request was refused by an invariant a permissive policy could not override.");
    Ok(())
}
