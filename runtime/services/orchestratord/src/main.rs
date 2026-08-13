//! `orchestratord` — proposal, policy, simulation, approval, signing.
//!
//! This is the only process that can produce a signed `EdgeTask`. It holds
//! the policy engine, the human approval gate and the simulator, and it
//! writes an audit record at every stage before moving to the next.
//!
//! It never opens a connection to a device. Dispatch means publishing a
//! signed task; delivery is `gatewayd`'s responsibility, across a channel
//! `orchestratord` does not own.

use std::sync::Arc;

use nexus_agent::behavior::{
    RobotCapabilities,
    SafetyEnvelope,
    TaskGoal,
    WorldState,
};

use nexus_agent::{
    DispatchOutcome,
    HumanApprovalGate,
    MockBehaviorModel,
    Orchestrator,
    OrchestratorConfig,
    ProposalTrigger,
    TaskProposal,
};

use nexus_edge_protocol::{
    DevSigner,
    ExecutionMode,
    Waypoint,
};

use nexus_event::json::Value;

use nexus_event::{
    topics,
    NexusError,
    Result,
    Timestamp,
    TraceId,
};

use nexus_ingest::{
    InMemoryBus,
    MessageBus,
    OutboundMessage,
};

use nexus_observability::{
    names,
    AuditTrail,
    ComponentState,
    HealthRegistry,
    JsonLinesAuditSink,
    Level,
    Logger,
    Metrics,
};

use nexus_policy::{
    PolicyEngine,
    RiskClass,
};

use nexus_sim::{
    SimulatedRobot,
    WorldModel,
};

fn main() {
    let level =
        Level::parse_or_info(
            &std::env::var(
                "NEXUS_LOG_LEVEL",
            )
            .unwrap_or_else(
                |_| "info".to_string(),
            ),
        );

    let logger =
        Logger::stderr(
            "orchestratord",
            level,
        );

    if let Err(error) =
        run(&logger)
    {
        logger.error(
            "orchestratord failed",
            vec![(
                "error",
                Value::string(
                    error.to_string(),
                ),
            )],
        );

        std::process::exit(1);
    }
}

/// Resolves the execution mode from configuration.
///
/// Defaults to SIMULATION. Touching hardware requires setting the variable
/// explicitly to `physical_non_weaponized`; there is no way to reach a
/// physical mode by omission.
fn execution_mode_from_env() -> Result<ExecutionMode> {
    match std::env::var(
        "NEXUS_EXECUTION_MODE",
    )
    .unwrap_or_else(
        |_| "simulation".to_string(),
    )
    .trim()
    .to_ascii_lowercase()
    .as_str()
    {
        "simulation" => {
            Ok(
                ExecutionMode::Simulation,
            )
        }

        "physical_non_weaponized" => {
            Ok(
                ExecutionMode::PhysicalNonWeaponized,
            )
        }

        other => {
            Err(
                NexusError::invalid(
                    format!(
                        "unknown NEXUS_EXECUTION_MODE '{other}'"
                    ),
                ),
            )
        }
    }
}

fn run(
    logger: &Logger,
) -> Result<()> {
    let mode =
        execution_mode_from_env()?;

    let metrics =
        Arc::new(
            Metrics::new(),
        );

    let audit =
        Arc::new(
            AuditTrail::new(
                Box::new(
                    JsonLinesAuditSink,
                ),
                20_000,
            ),
        );

    let health =
        HealthRegistry::new();

    let policy =
        PolicyEngine::industrial_baseline();

    let model =
        MockBehaviorModel::new();

    let gate =
        HumanApprovalGate::new();

    let bus:
        Arc<dyn MessageBus> =
        Arc::new(
            InMemoryBus::new(4),
        );

    // The signing key is read from the environment. There is no default and
    // no embedded key; a missing key stops the service.
    let signing_key =
        std::env::var(
            "NEXUS_SIGNING_KEY",
        )
        .map_err(|_| {
            NexusError::invalid(
                "NEXUS_SIGNING_KEY is required",
            )
        })?;

    let signer_id =
        std::env::var(
            "NEXUS_SIGNER_ID",
        )
        .unwrap_or_else(
            |_| {
                "orchestratord"
                    .to_string()
            },
        );

    let signer =
        DevSigner::new(
            signer_id.clone(),
            signing_key.as_bytes(),
        )?;

    health.set(
        "policy",
        ComponentState::Up,
        "industrial baseline",
    );

    health.set(
        "signer",
        ComponentState::Up,
        signer_id.clone(),
    );

    health.set(
        "simulator",
        ComponentState::Up,
        "deterministic twin",
    );

    let config =
        OrchestratorConfig {
            mode,
            ..OrchestratorConfig::default()
        };

    let orchestrator =
        Orchestrator::new(
            config,
            &policy,
            &model,
            &gate,
            &audit,
        );

    logger.info(
        "orchestratord ready",
        vec![
            (
                "mode",
                Value::string(
                    mode.as_str(),
                ),
            ),
            (
                "policy_rules",
                Value::number(
                    policy.rule_count()
                        as f64,
                ),
            ),
            (
                "health",
                health.report(),
            ),
        ],
    );

    // A worked proposal so the service demonstrates the full path on start.
    let now =
        Timestamp::now();

    let trace =
        TraceId::new();

    let proposal =
        TaskProposal::new(
            TaskGoal::ConfirmReading {
                asset_key:
                    "press-4".into(),

                waypoint_name:
                    "press-4-front".into(),

                probe:
                    "probe-a".into(),
            },

            ProposalTrigger::CorrelatedHazard {
                detection_class:
                    "smoke".into(),

                asset_key:
                    "press-4".into(),
            },

            "press-4",
            "press-hall",
            "robot-inspect-01",

            now,

            trace.clone(),
        )
        .with_risk(
            RiskClass::Low,
        );

    let capabilities =
        RobotCapabilities {
            device_id:
                "robot-inspect-01"
                    .into(),

            capabilities: vec![
                "navigate.waypoint"
                    .into(),

                "sensor.temperature"
                    .into(),

                "sensor.generic"
                    .into(),
            ],

            max_speed_mps:
                1.0,

            max_range_meters:
                200.0,

            has_manipulator:
                false,
        };

    let world_state =
        WorldState {
            facility_id:
                "plant-1".into(),

            zone_id:
                "press-hall".into(),

            robot_pose:
                Waypoint::new(
                    0.0,
                    0.0,
                    0.0,
                )?,

            known_waypoints:
                vec![(
                    "press-4-front"
                        .into(),

                    Waypoint::new(
                        10.0,
                        0.0,
                        0.0,
                    )?,
                )],

            obstacles:
                vec![],

            personnel_present:
                false,

            observed_at:
                now,
        };

    let twin =
        WorldModel::new(
            "plant-1",
            "press-hall",

            SimulatedRobot::new(
                "robot-inspect-01",

                Waypoint::new(
                    0.0,
                    0.0,
                    0.0,
                )?,

                &[
                    "navigate.waypoint",
                    "sensor.temperature",
                    "sensor.generic",
                ],
            ),
        )
        .with_waypoint(
            "press-4-front",

            Waypoint::new(
                10.0,
                0.0,
                0.0,
            )?,
        )
        .with_reading(
            "probe-a",
            96.5,
        );

    let started =
        Timestamp::now();

    let outcome =
        orchestrator.process(
            &proposal,

            &world_state,

            &capabilities,

            &SafetyEnvelope::conservative(
                "envelope-inspection",
            ),

            &twin,

            &signer,

            now,
        )?;

    metrics
        .histogram(
            names::TASK_PROPOSAL_LATENCY_MS,
        )
        .observe(
            Timestamp::now()
                .delta_millis(
                    started,
                )
                as f64,
        );

    match &outcome {
        DispatchOutcome::Dispatch {
            task,
            ..
        } => {
            let message =
                OutboundMessage::json(
                    topics::TASK_PROPOSALS,

                    task.task_id
                        .as_str(),

                    &task
                        .to_json()
                        .to_canonical_string(),
                );

            bus.produce(
                &[message],
            )?;

            logger
                .with_trace(
                    &trace,
                )
                .info(
                    "task dispatched",
                    vec![
                        (
                            "task_id",

                            Value::string(
                                task.task_id
                                    .as_str(),
                            ),
                        ),

                        (
                            "command",

                            Value::string(
                                task.command
                                    .name(),
                            ),
                        ),
                    ],
                );
        }

        DispatchOutcome::Rejected {
            code,
            detail,
            ..
        } => {
            metrics
                .counter(
                    names::POLICY_DENIED,
                )
                .incr();

            logger
                .with_trace(
                    &trace,
                )
                .warn(
                    "proposal rejected",
                    vec![
                        (
                            "code",
                            Value::string(
                                code,
                            ),
                        ),
                        (
                            "detail",
                            Value::string(
                                detail,
                            ),
                        ),
                    ],
                );
        }

        DispatchOutcome::AwaitingApproval {
            request,
            ..
        } => {
            metrics
                .counter(
                    names::POLICY_APPROVAL_REQUIRED,
                )
                .incr();

            logger
                .with_trace(
                    &trace,
                )
                .info(
                    "awaiting human approval
                            DispatchOutcome::AwaitingApproval {
            request,
            ..
        } => {
            metrics
                .counter(
                    names::POLICY_APPROVAL_REQUIRED,
                )
                .incr();

            logger
                .with_trace(
                    &trace,
                )
                .info(
                    "awaiting human approval",
                    vec![(
                        "reason",
                        Value::string(
                            &request.reason,
                        ),
                    )],
                );
        }

        DispatchOutcome::SimulationFailed {
            report,
            ..
        } => {
            logger
                .with_trace(
                    &trace,
                )
                .warn(
                    "simulation rejected the plan",
                    vec![(
                        "error",
                        Value::string(
                            report
                                .first_error_code()
                                .unwrap_or(
                                    "unknown",
                                ),
                        ),
                    )],
                );
        }
    }

    audit
        .verify_chain()
        .map_err(
            NexusError::integrity,
        )?;

    print!(
        "{}",
        metrics.render_text()
    );

    Ok(())
}
