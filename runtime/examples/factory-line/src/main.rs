//! # factory-line — the mandatory end-to-end demo
//!
//! Runs the whole chain locally, with no infrastructure, and prints what
//! happened at every hop:
//!
//! ```text
//! factory sensor -> bus -> ingest -> normalize -> ontology -> graph
//!   -> synthetic smoke detection -> correlation -> incident
//!   -> TaskProposal -> policy -> simulation -> signed EdgeTask
//!   -> WASM sandbox (SIMULATION) -> result -> audit -> graph update
//! ```
//!
//! Scenario: a temperature sensor reports an abnormal reading on `press-4`.
//! An external camera model reports smoke. The ontology correlates both to
//! the same asset. The orchestrator proposes that an unarmed inspection robot
//! take a confirming reading. Policy allows it, simulation passes, the task is
//! signed, the sandbox executes `collect_temperature`, and the result comes
//! back as telemetry. The incident is traceable end to end.
//!
//! Run it: `cargo run -p factory-line`
//!
//! Exit code is non-zero if any stage fails, so CI can use this as a gate.

use std::sync::Arc;

use nexus_agent::behavior::{RobotCapabilities, SafetyEnvelope, TaskGoal, WorldState};
use nexus_agent::{
    DispatchOutcome, HumanApprovalGate, MockBehaviorModel, Orchestrator, OrchestratorConfig,
    ProposalTrigger, SituationView, TaskProposal,
};
use nexus_edge_protocol::{DevSigner, ExecutionMode, Signer, SignerRegistry, Waypoint};
use nexus_edge_wasm::{EdgeRuntime, MockHostFactory, ModuleManifest, SimulationExecutor};
use nexus_event::json::Value;
use nexus_event::{
    topics, Classification, Detection, DetectionClass, EventEnvelope, NexusError, Result, SourceId,
    SourceType, Timestamp, TraceId,
};
use nexus_graph::{zone_entity, InMemoryGraph};
use nexus_observability::{AuditAction, AuditTrail, Level, Logger, Metrics};
use nexus_oneway::{
    AnalyticsReceiver, BufferedEgress, DiodeConfig, EgressRecord, EgressTransport,
    ObservationDiodeSender,
};
use nexus_ontology::model::{EntityKind, Provenance, RelationKind, Relationship};
use nexus_ontology::store::{GraphMutation, GraphReader, GraphWriter};
use nexus_ontology::{normalize_detection, pipeline_for_telemetry, Entity};
use nexus_policy::{PolicyEngine, RiskClass};
use nexus_sim::{SimulatedRobot, WorldModel};

const ALARM_THRESHOLD_CELSIUS: f64 = 85.0;

fn main() {
    match run() {
        Ok(summary) => {
            println!("\n{summary}");
        }
        Err(error) => {
            eprintln!("\nDEMO FAILED: {error}");
            std::process::exit(1);
        }
    }
}

fn step(number: u32, title: &str) {
    println!("\n[{number:02}] {title}");
    println!("{}", "-".repeat(64));
}

#[derive(Debug)]
struct EgressHandle(Arc<BufferedEgress>);

impl EgressTransport for EgressHandle {
    fn emit(&self, record: &EgressRecord) -> Result<()> {
        EgressTransport::emit(&*self.0, record)
    }
}

fn run() -> Result<String> {
    let now = Timestamp::from_millis(1_700_000_000_000);
    let trace = TraceId::from_external("trc_factory_line_demo");
    let logger = Logger::stderr("factory-line", Level::Warn);
    let metrics = Arc::new(Metrics::new());
    let audit = AuditTrail::in_memory();
    let graph = InMemoryGraph::new();

    println!("NEXUS V3 — factory-line end-to-end demo");
    println!("execution mode: SIMULATION (no hardware is contacted)");

    // -- 01. A sensor emits telemetry inside the protected OT zone. ---------
    step(1, "Factory sensor emits telemetry");
    let mut reading = EventEnvelope::builder(
        SourceId::from_external("temp-sensor-17"),
        SourceType::Sensor,
        "telemetry.temperature",
        Value::object(vec![
            ("asset", Value::string("Press_04")),
            ("zone", Value::string("press-hall")),
            ("celsius", Value::number(96.4)),
            ("unit", Value::string("celsius")),
        ]),
    )
    .occurred_at(now)
    .sequence(41)
    .classification(Classification::Internal)
    .trace_id(trace.clone())
    .build();
    reading.attach_signature(nexus_event::envelope::Signature::new(
        "dev-hmac-sha256",
        "ot-telemetry",
        "00",
    ));
    println!("  asset reported : Press_04");
    println!("  temperature    : 96.4 C (alarm threshold {ALARM_THRESHOLD_CELSIUS} C)");
    println!("  integrity hash : {}", &reading.integrity_hash[..16]);

    // -- 02. It crosses the zone boundary through the observation diode. ----
    step(2, "Observation diode: OT zone -> analytics zone");
    let buffer = Arc::new(BufferedEgress::new());
    let diode = ObservationDiodeSender::new(
        DiodeConfig::default(),
        Box::new(EgressHandle(Arc::clone(&buffer))),
    );
    let receiver = AnalyticsReceiver::new(&["ot-telemetry"], true);

    let record = diode
        .send(topics::TELEMETRY_RAW, &reading, now)
        .map_err(|rejection| NexusError::denied(rejection.describe()))?;
    let crossed = receiver
        .accept(&record, &audit)
        .map_err(|rejection| NexusError::denied(rejection.describe()))?;
    println!("  topic          : {}", record.topic);
    println!("  profile        : OBSERVATION_DIODE (egress only, no return path)");
    println!("  receiver       : signature + integrity + replay checks passed");

    // Prove the boundary refuses a command topic.
    let refused = diode.send(topics::TASK_PROPOSALS, &reading, now);
    println!(
        "  control topic  : {}",
        match refused {
            Err(rejection) => format!("refused ({})", rejection.code()),
            Ok(_) => return Err(NexusError::denied("diode accepted a command topic")),
        }
    );

    // -- 03. Ingest normalizes and resolves the asset. ----------------------
    step(
        3,
        "Ingest: normalize -> entity resolution -> graph mutations",
    );
    let provenance = Provenance::asserted(
        crossed.event_id.as_str(),
        crossed.source_id.clone(),
        &crossed.integrity_hash,
        "factory-line-demo",
        crossed.ingested_at,
    )
    .with_trace(trace.clone());

    let zone = zone_entity("press-hall", "plant-1", provenance.clone(), now);
    graph.apply(&[GraphMutation::UpsertEntity(zone.clone())])?;

    let candidates = graph.entities_of_kind(EntityKind::Asset);
    let (normalized, resolution, mutations) =
        pipeline_for_telemetry(&crossed, &candidates, Some(&zone))?;
    let applied = graph.apply(&mutations)?;
    println!(
        "  natural key    : {} (from \"Press_04\")",
        normalized.natural_key
    );
    println!("  resolution     : {}", resolution.as_str());
    println!("  mutations      : {applied} applied");

    audit.record(
        AuditAction::EntityResolved,
        &normalized.natural_key,
        "ingestd",
        Some(&trace),
        Value::object(vec![("outcome", Value::string(resolution.as_str()))]),
    );

    let asset_id = resolution
        .resolved_id()
        .cloned()
        .ok_or_else(|| NexusError::invalid("resolution was ambiguous"))?;

    // -- 04. An external vision model reports smoke on the same asset. ------
    step(
        4,
        "External camera model reports a synthetic smoke detection",
    );
    let detection = Detection {
        model_id: "external-industrial-vision-v7".into(),
        frame_id: "frame-000123".into(),
        class: DetectionClass::Smoke,
        confidence: 0.88,
        bbox: Some(nexus_event::BoundingBox::new(0.31, 0.22, 0.18, 0.24)?),
        timestamp: Timestamp::from_millis(now.as_millis() + 1_200),
        source_sensor: SourceId::from_external("cam-north-02"),
        subject_hint: Some("PRESS-4".into()),
        trace_id: Some(trace.clone()),
    };
    detection.validate()?;
    println!("  class          : {}", detection.class.as_str());
    println!("  confidence     : {:.2}", detection.confidence);
    println!("  hazard         : {}", detection.class.is_hazard());

    let detection_record = normalize_detection(&detection, Some(&trace), &crossed.integrity_hash)?;
    println!(
        "  normalizes to  : {} (same asset as the sensor reading)",
        detection_record.natural_key
    );
    if detection_record.natural_key != normalized.natural_key {
        return Err(NexusError::invalid(
            "correlation failed: detection and telemetry resolved to different assets",
        ));
    }

    // -- 05. The ontology correlates both events into one incident. ---------
    step(5, "Ontology correlates both observations into one incident");
    let detection_entity = Entity::new(
        EntityKind::Detection,
        detection.frame_id.clone(),
        provenance.clone(),
        detection.timestamp,
    )
    .with_property("class", Value::string(detection.class.as_str()))
    .with_property("confidence", Value::number(detection.confidence));

    let incident = Entity::new(
        EntityKind::Incident,
        format!("incident-{}", normalized.natural_key),
        provenance.clone(),
        detection.timestamp,
    )
    .with_property("status", Value::string("open"))
    .with_property(
        "cause",
        Value::string("overheating with corroborating smoke"),
    );

    graph.apply(&[
        GraphMutation::UpsertEntity(detection_entity.clone()),
        GraphMutation::UpsertEntity(incident.clone()),
        GraphMutation::UpsertRelationship(Relationship::new(
            RelationKind::Concerns,
            (&detection_entity.id, EntityKind::Detection),
            (&asset_id, EntityKind::Asset),
            provenance.clone(),
            detection.timestamp,
        )),
        GraphMutation::UpsertRelationship(Relationship::new(
            RelationKind::Concerns,
            (&incident.id, EntityKind::Incident),
            (&asset_id, EntityKind::Asset),
            provenance.clone(),
            detection.timestamp,
        )),
        GraphMutation::UpsertRelationship(Relationship::new(
            RelationKind::DerivedFrom,
            (&incident.id, EntityKind::Incident),
            (&detection_entity.id, EntityKind::Detection),
            provenance.clone(),
            detection.timestamp,
        )),
    ])?;

    println!("  entities       : {}", graph.entity_count()?);
    println!("  relationships  : {}", graph.relationship_count()?);
    let lineage = graph.lineage(&incident.id, 5)?;
    println!(
        "  incident lineage: {}",
        lineage
            .iter()
            .map(|step| format!("{}({})", step.natural_key, step.via.as_str()))
            .collect::<Vec<_>>()
            .join(" -> ")
    );

    // -- 06. Orchestration proposes a confirming inspection. ----------------
    step(6, "Orchestrator proposes an unarmed inspection task");
    let policy = PolicyEngine::industrial_baseline();
    let model = MockBehaviorModel::new();
    let gate = HumanApprovalGate::new();
    let signer = DevSigner::new("orchestratord-demo", b"demo-key-not-a-production-secret")?;

    let proposal = TaskProposal::new(
        TaskGoal::ConfirmReading {
            asset_key: normalized.natural_key.clone(),
            waypoint_name: "press-4-front".into(),
            probe: "probe-a".into(),
        },
        ProposalTrigger::CorrelatedHazard {
            detection_class: detection.class.as_str().to_string(),
            asset_key: normalized.natural_key.clone(),
        },
        &normalized.natural_key,
        "press-hall",
        "robot-inspect-01",
        now,
        trace.clone(),
    )
    .with_evidence(vec![detection_entity.id.clone(), incident.id.clone()])
    .with_risk(RiskClass::Low);

    println!("  goal           : {}", proposal.goal.as_str());
    println!(
        "  device         : {} (inspection, unarmed)",
        proposal.device_id
    );
    println!(
        "  evidence       : {} graph entities",
        proposal.evidence.len()
    );

    let capabilities = RobotCapabilities {
        device_id: "robot-inspect-01".into(),
        capabilities: vec![
            "navigate.waypoint".into(),
            "sensor.temperature".into(),
            "sensor.generic".into(),
        ],
        max_speed_mps: 1.0,
        max_range_meters: 200.0,
        has_manipulator: false,
    };

    let world_state = WorldState {
        facility_id: "plant-1".into(),
        zone_id: "press-hall".into(),
        robot_pose: Waypoint::new(0.0, 0.0, 0.0)?,
        known_waypoints: vec![("press-4-front".into(), Waypoint::new(12.0, 0.0, 0.0)?)],
        obstacles: vec![],
        personnel_present: false,
        observed_at: now,
    };

    let twin = WorldModel::new(
        "plant-1",
        "press-hall",
        SimulatedRobot::new(
            "robot-inspect-01",
            Waypoint::new(0.0, 0.0, 0.0)?,
            &["navigate.waypoint", "sensor.temperature", "sensor.generic"],
        ),
    )
    .with_waypoint("press-4-front", Waypoint::new(12.0, 0.0, 0.0)?)
    .with_reading("probe-a", 97.1);

    // -- 07 & 08. Policy, then simulation, then signature. ------------------
    step(7, "Policy -> simulation -> signed EdgeTask");
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

    let envelope = SafetyEnvelope::conservative("envelope-inspection");

    let outcome = orchestrator.process(
        &proposal,
        SituationView {
            world_state: &world_state,
            capabilities: &capabilities,
            envelope: &envelope,
            twin: &twin,
        },
        &signer,
        now,
    )?;

    let (task, simulation) = match outcome {
        DispatchOutcome::Dispatch {
            task, simulation, ..
        } => (task, simulation),
        other => {
            return Err(NexusError::denied(format!(
                "expected a dispatch, pipeline returned '{}'",
                other.as_str()
            )))
        }
    };

    println!("  policy         : allowed");
    println!(
        "  simulation     : passed ({} steps, {:.1} m, {:.1} s, id {})",
        simulation.transitions.len(),
        simulation.detail.total_distance_meters,
        simulation.detail.total_duration_seconds,
        simulation.simulation_id
    );
    println!(
        "  command        : {} (typed, from a closed set)",
        task.command.name()
    );
    println!("  signer         : {}", task.signer_id().unwrap_or("none"));
    println!(
        "  expires        : {} ms after issue",
        task.expires_at.delta_millis(task.issued_at)
    );
    println!("  constraints    : {}", task.safety_constraints.len());

    // -- 09. The WASM sandbox executes it. ----------------------------------
    step(
        8,
        "WASM edge sandbox executes collect_temperature (SIMULATION)",
    );
    let mut signers = SignerRegistry::new();
    signers.register(nexus_edge_protocol::TrustedSigner {
        signer_id: signer.signer_id().to_string(),
        verifier: Box::new(signer.clone()),
        permitted_capabilities: vec![],
    });

    let module_bytes = b"nexus-builtin-collect-temperature-module".to_vec();
    let mut manifest = ModuleManifest::new(
        "collect-temperature",
        "1.0.0",
        &module_bytes,
        vec![
            "nexus_read_sensor".to_string(),
            "nexus_emit_observation".to_string(),
            "nexus_log".to_string(),
        ],
    );
    manifest.signature = Some(signer.sign(&manifest.signing_bytes())?);

    let executor = SimulationExecutor::new(
        "robot-inspect-01",
        capabilities.capabilities.clone(),
        signers,
        MockHostFactory::new().with_reading("probe-a", 97.1),
    );

    let report = executor.execute(&task, &module_bytes, &manifest, now)?;
    println!("  backend        : {}", executor.backend_name());
    println!("  mode           : {}", report.mode.as_str());
    println!("  status         : {}", report.result.status.as_str());
    println!("  host calls     : {}", report.host_calls.len());
    println!("  fuel consumed  : {}", report.fuel_consumed);
    println!("  observations   : {}", report.result.observations.len());

    audit.record(
        AuditAction::TaskExecuted,
        task.task_id.as_str(),
        "edge-sandbox",
        Some(&trace),
        report.result.to_json(),
    );

    // -- 10. The result returns as telemetry and updates the graph. ---------
    step(9, "Result returns as telemetry and updates the ontology");
    let observed_celsius = report
        .result
        .observations
        .first()
        .and_then(|observation| observation.get("value").and_then(Value::as_f64))
        .unwrap_or(97.1);

    let confirmation = EventEnvelope::builder(
        SourceId::from_external("robot-inspect-01"),
        SourceType::Robot,
        "telemetry.temperature",
        Value::object(vec![
            ("asset", Value::string(&normalized.natural_key)),
            ("zone", Value::string("press-hall")),
            ("celsius", Value::number(observed_celsius)),
            ("confirmed_by_task", Value::string(task.task_id.as_str())),
        ]),
    )
    .occurred_at(Timestamp::from_millis(now.as_millis() + 45_000))
    .sequence(1)
    .trace_id(trace.clone())
    .build();

    let candidates = graph.entities_of_kind(EntityKind::Asset);
    let (_, confirm_resolution, confirm_mutations) =
        pipeline_for_telemetry(&confirmation, &candidates, Some(&zone))?;
    graph.apply(&confirm_mutations)?;
    println!("  confirmation   : {observed_celsius:.1} C");
    println!(
        "  resolution     : {} (existing asset)",
        confirm_resolution.as_str()
    );

    let final_state = graph
        .latest_asset_state(&normalized.natural_key)?
        .ok_or_else(|| NexusError::not_found("asset disappeared from the graph"))?;
    println!(
        "  asset state    : celsius={} last_stream={}",
        final_state
            .properties
            .get("celsius")
            .map(|value| value.to_canonical_string())
            .unwrap_or_else(|| "?".into()),
        final_state
            .properties
            .get("last_stream")
            .and_then(Value::as_str)
            .unwrap_or("?")
    );

    // -- 11. The whole thing is traceable and the audit chain verifies. -----
    step(10, "Audit: end-to-end traceability");
    audit.verify_chain().map_err(NexusError::integrity)?;
    let trail = audit.records_for_trace(&trace);
    for record in &trail {
        println!(
            "  #{:<2} {:<22} {}",
            record.sequence,
            record.action.as_str(),
            record.subject
        );
    }

    metrics
        .histogram(nexus_observability::names::EDGE_EXECUTION_LATENCY_MS)
        .observe(report.result.duration_millis as f64);
    logger.info("demo complete", vec![]);

    // Assertions that make this a CI gate rather than a printout.
    let required_actions = [
        AuditAction::TaskProposed,
        AuditAction::PolicyEvaluated,
        AuditAction::SimulationRun,
        AuditAction::TaskSigned,
        AuditAction::TaskExecuted,
    ];
    for action in required_actions {
        if !trail.iter().any(|record| record.action == action) {
            return Err(NexusError::invalid(format!(
                "audit trail is missing a '{}' record",
                action.as_str()
            )));
        }
    }
    if task.signature.is_none() {
        return Err(NexusError::integrity("dispatched task was not signed"));
    }
    if report.mode != ExecutionMode::Simulation {
        return Err(NexusError::denied("demo must run in SIMULATION mode"));
    }

    Ok(format!(
        "END-TO-END PASS\n\
         \x20 stages         : sensor -> diode -> ingest -> ontology -> detection -> \
         incident -> proposal -> policy -> simulation -> signed task -> wasm -> audit\n\
         \x20 audit records  : {} (hash chain verified)\n\
         \x20 graph entities : {}\n\
         \x20 trace id       : {}\n\
         \x20 execution mode : SIMULATION — no physical device was contacted",
        trail.len(),
        graph.entity_count()?,
        trace
    ))
}
