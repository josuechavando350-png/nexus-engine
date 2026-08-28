//! `graphd` — the ontology writer.
//!
//! Consumes graph mutations and commits them to the configured backend. It is
//! the only process that writes to the graph, which is what makes the
//! mutation topic the single audit point for everything the system believes.

use std::sync::Arc;

use nexus_event::json::Value;
use nexus_event::{EventEnvelope, Result};
use nexus_graph::{GraphBackend, InMemoryGraph};
use nexus_ingest::{
    EventHandler, HandlerOutcome, InMemoryBus, IngestConfig, IngestPipeline, MessageBus,
};
use nexus_observability::{
    names, AuditAction, AuditTrail, ComponentState, HealthRegistry, JsonLinesAuditSink, Level,
    Logger, Metrics, RuntimeProfile,
};
use nexus_ontology::store::{GraphMutation, GraphWriter};
use nexus_ontology::{Entity, EntityKind, Provenance};

struct CommitHandler {
    writer: Arc<dyn GraphWriter>,
    metrics: Arc<Metrics>,
    audit: Arc<AuditTrail>,
    logger: Logger,
}

impl EventHandler for CommitHandler {
    fn name(&self) -> &'static str {
        "commit"
    }

    fn handle(&self, envelope: &EventEnvelope) -> Result<HandlerOutcome> {
        let started = nexus_event::Timestamp::now();

        // The mutation topic carries entity documents; anything else is
        // recognised and skipped rather than guessed at.
        let Some(kind) = envelope.payload.get("kind").and_then(Value::as_str) else {
            return Ok(HandlerOutcome::Skipped("no entity kind".into()));
        };
        let kind = EntityKind::parse(kind)?;
        let natural_key = envelope.payload.require_str("natural_key")?;

        let provenance = Provenance::asserted(
            envelope.event_id.as_str(),
            envelope.source_id.clone(),
            &envelope.integrity_hash,
            "graphd",
            envelope.ingested_at,
        )
        .with_trace(envelope.trace_id.clone());

        let mut entity = Entity::new(kind, natural_key, provenance.clone(), envelope.occurred_at);
        if let Some(Value::Object(properties)) = envelope.payload.get("properties") {
            for (key, value) in properties {
                entity.set_property(key, value.clone(), envelope.occurred_at, provenance.clone());
            }
        }

        let applied = self.writer.apply(&[GraphMutation::UpsertEntity(entity)])?;

        let elapsed = nexus_event::Timestamp::now().delta_millis(started) as f64;
        self.metrics
            .histogram(names::GRAPH_MUTATION_LATENCY_MS)
            .observe(elapsed);

        self.audit.record(
            AuditAction::GraphMutation,
            natural_key,
            "graphd",
            Some(&envelope.trace_id),
            Value::object(vec![("applied", Value::number(applied as f64))]),
        );

        self.logger.with_trace(&envelope.trace_id).info(
            "committed",
            vec![("applied", Value::number(applied as f64))],
        );

        Ok(HandlerOutcome::Processed)
    }
}

fn main() {
    let level = Level::parse_or_info(
        &std::env::var("NEXUS_LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
    );
    let logger = Logger::stderr("graphd", level);
    if let Err(error) = run(&logger) {
        logger.error(
            "graphd failed",
            vec![("error", Value::string(error.to_string()))],
        );
        std::process::exit(1);
    }
}

fn run(logger: &Logger) -> Result<()> {
    let profile = RuntimeProfile::from_env()?;
    let backend = GraphBackend::resolve(
        std::env::var("NEXUS_GRAPH_BACKEND").ok().as_deref(),
        std::env::var("NEXUS_GRAPH_URI").ok().as_deref(),
        std::env::var("NEXUS_GRAPH_DATABASE").ok().as_deref(),
    )?;
    validate_runtime(profile, &backend)?;

    let health = HealthRegistry::new();
    let metrics = Arc::new(Metrics::new());
    let audit = Arc::new(AuditTrail::new(Box::new(JsonLinesAuditSink), 10_000));

    // Only the in-memory backend is reachable in the default build. Selecting
    // neo4j without the feature is a startup error rather than a silent
    // downgrade to a non-durable store.
    let writer: Arc<dyn GraphWriter> = match &backend {
        GraphBackend::InMemory => {
            health.set(
                "graph",
                ComponentState::Degraded,
                "non-production in-memory",
            );
            Arc::new(InMemoryGraph::new())
        }
        GraphBackend::Neo4j { uri, .. } => {
            #[cfg(feature = "neo4j")]
            {
                let config = nexus_graph::neo4j::Neo4jConfig::from_env()?;
                let graph = nexus_graph::neo4j::Neo4jGraph::connect(&config)?;
                graph.ensure_schema()?;
                health.set("graph", ComponentState::Up, uri.clone());
                Arc::new(graph)
            }
            #[cfg(not(feature = "neo4j"))]
            {
                let _ = uri;
                return Err(nexus_event::NexusError::unsupported(
                    "NEXUS_GRAPH_BACKEND=neo4j requires building with --features neo4j",
                ));
            }
        }
    };

    let config = IngestConfig::from_env()?;
    let bus: Arc<dyn MessageBus> = Arc::new(InMemoryBus::new(4));
    health.set(
        "bus",
        ComponentState::Degraded,
        "non-production in-memory transport",
    );

    let handler = Arc::new(CommitHandler {
        writer,
        metrics: Arc::clone(&metrics),
        audit: Arc::clone(&audit),
        logger: logger.clone(),
    });

    let pipeline = IngestPipeline::new(
        config,
        Arc::clone(&bus),
        handler,
        Arc::clone(&metrics),
        logger.clone(),
        Arc::clone(&audit),
    )?;

    logger.info(
        "graphd non-production runtime started",
        vec![
            ("runtime_profile", Value::string(profile.as_str())),
            ("backend", Value::string(backend.name())),
            ("health", health.report()),
        ],
    );

    let report = pipeline.run_until_idle(1_000)?;
    logger.info(
        "drain complete",
        vec![("accepted", Value::number(report.accepted as f64))],
    );
    print!("{}", metrics.render_text());
    Ok(())
}

fn validate_runtime(profile: RuntimeProfile, backend: &GraphBackend) -> Result<()> {
    if matches!(backend, GraphBackend::InMemory) {
        profile.require_non_production("in-memory-graph")?;
    }
    // graphd has no real broker wiring yet, even when a durable graph adapter
    // is compiled. Production must not claim readiness on a process-local bus.
    profile.require_non_production("in-memory-bus")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_rejects_every_current_graphd_wiring() {
        assert!(validate_runtime(RuntimeProfile::Production, &GraphBackend::InMemory).is_err());
        assert!(validate_runtime(
            RuntimeProfile::Production,
            &GraphBackend::Neo4j {
                uri: "bolt://graph:7687".into(),
                database: "neo4j".into()
            }
        )
        .is_err());
        assert!(validate_runtime(RuntimeProfile::Development, &GraphBackend::InMemory).is_ok());
    }

    #[test]
    fn missing_or_invalid_graph_configuration_does_not_select_a_durable_backend() {
        assert!(GraphBackend::resolve(Some("neo4j"), None, None).is_err());
        assert_eq!(
            GraphBackend::resolve(None, None, None).unwrap(),
            GraphBackend::InMemory
        );
        assert!(validate_runtime(
            RuntimeProfile::Production,
            &GraphBackend::resolve(None, None, None).unwrap()
        )
        .is_err());
    }
}
