//! `ingestd` — telemetry intake.
//!
//! Consumes raw telemetry, validates the envelope, deduplicates, normalizes
//! into ontology records and publishes graph mutations. It does not write to
//! the graph itself: that is `graphd`'s job, and keeping the split means a
//! graph outage backs up in the broker instead of dropping telemetry.
//!
//! Configuration comes from the environment only. There are no defaults for
//! brokers or credentials.

use std::sync::Arc;

use nexus_event::json::Value;
use nexus_event::{topics, EventEnvelope, Result};
use nexus_graph::InMemoryGraph;
use nexus_ingest::{
    EventHandler,
    HandlerOutcome,
    IngestConfig,
    InMemoryBus,
    IngestPipeline,
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
use nexus_ontology::pipeline_for_telemetry;
use nexus_ontology::store::GraphMutation;

/// Normalizes telemetry and emits graph mutations onto the bus.
struct NormalizeHandler {
    bus: Arc<dyn MessageBus>,
    graph: Arc<InMemoryGraph>,
    metrics: Arc<Metrics>,
    logger: Logger,
}

impl EventHandler for NormalizeHandler {
    fn name(&self) -> &'static str {
        "normalize"
    }

    fn handle(
        &self,
        envelope: &EventEnvelope,
    ) -> Result<HandlerOutcome> {
        if envelope
            .stream
            .starts_with("control.")
        {
            return Ok(
                HandlerOutcome::Skipped(
                    "control stream".into(),
                ),
            );
        }

        let candidates = self
            .graph
            .entities_of_kind(
                nexus_ontology::EntityKind::Asset,
            );

        let (record, outcome, mutations) =
            pipeline_for_telemetry(
                envelope,
                &candidates,
                None,
            )?;

        for mutation in &mutations {
            let payload = match mutation {
                GraphMutation::UpsertEntity(
                    entity,
                ) => entity.to_json(),

                other => Value::object(vec![
                    (
                        "kind",
                        Value::string(
                            other.kind_name(),
                        ),
                    ),
                    (
                        "idempotency_key",
                        Value::string(
                            other
                                .idempotency_key(),
                        ),
                    ),
                ]),
            };

            let message =
                OutboundMessage::json(
                    topics::GRAPH_MUTATIONS,
                    record
                        .natural_key
                        .clone(),
                    &payload
                        .to_canonical_string(),
                );

            self.bus.produce(&[message])?;
        }

        self.metrics
            .counter(
                names::INGEST_ACCEPTED,
            )
            .incr();

        self.logger
            .with_trace(
                &envelope.trace_id,
            )
            .info(
                "normalized",
                vec![
                    (
                        "asset",
                        Value::string(
                            &record.natural_key,
                        ),
                    ),
                    (
                        "resolution",
                        Value::string(
                            outcome.as_str(),
                        ),
                    ),
                    (
                        "mutations",
                        Value::number(
                            mutations.len()
                                as f64,
                        ),
                    ),
                ],
            );

        Ok(
            HandlerOutcome::Processed,
        )
    }
}

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
            "ingestd",
            level,
        );

    if let Err(error) =
        run(&logger)
    {
        logger.error(
            "ingestd failed to start",
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

fn run(
    logger: &Logger,
) -> Result<()> {
    let config =
        match IngestConfig::from_env() {
            Ok(config) => config,

            Err(error) => {
                logger.error(
                    "configuration is incomplete",
                    vec![(
                        "error",
                        Value::string(
                            error.to_string(),
                        ),
                    )],
                );

                return Err(error);
            }
        };

    config.validate()?;

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
                10_000,
            ),
        );

    let health =
        HealthRegistry::new();

    let bus:
        Arc<dyn MessageBus> =
        Arc::new(
            InMemoryBus::new(4),
        );

    health.set(
        "bus",
        ComponentState::Up,
        "in-memory transport",
    );

    let graph =
        Arc::new(
            InMemoryGraph::new(),
        );

    health.set(
        "graph-cache",
        ComponentState::Up,
        "in-memory candidates",
    );

    let handler =
        Arc::new(
            NormalizeHandler {
                bus:
                    Arc::clone(
                        &bus,
                    ),
                graph,
                metrics:
                    Arc::clone(
                        &metrics,
                    ),
                logger:
                    logger.clone(),
            },
        );

    let pipeline =
        IngestPipeline::new(
            config,
            Arc::clone(
                &bus,
            ),
            handler,
            Arc::clone(
                &metrics,
            ),
            logger.clone(),
            Arc::clone(
                &audit,
            ),
        )?;

    logger.info(
        "ingestd ready",
        vec![
            (
                "health",
                health.report(),
            ),
            (
                "topics",
                Value::string(
                    topics::TELEMETRY_RAW,
                ),
            ),
        ],
    );

    let report =
        pipeline
            .run_until_idle(
                1_000,
            )?;

    logger.info(
        "drain complete",
        vec![
            (
                "accepted",
                Value::number(
                    report.accepted
                        as f64,
                ),
            ),
            (
                "duplicates",
                Value::number(
                    report.duplicates
                        as f64,
                ),
            ),
            (
                "dead_lettered",
                Value::number(
                    report.dead_lettered
                        as f64,
                ),
            ),
        ],
    );

    print!(
        "{}",
        metrics.render_text()
    );

    Ok(())
}
