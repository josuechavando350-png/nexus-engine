//! `gatewayd` — zone boundary and edge execution.
//!
//! Two responsibilities, deliberately in one process so the separation
//! between them is visible in one file:
//!
//! 1. **Observation diode.** Telemetry leaves the protected zone. There is no
//!    inbound path here at all.
//! 2. **Controlled edge.** A separate, authenticated channel that verifies a
//!    signed task and hands it to the WASM sandbox for execution.
//!
//! The two never share an identity, and `assert_distinct_from` enforces that
//! at startup rather than in a code review.

use std::sync::Arc;

use nexus_edge_protocol::{NonceLedger, SignerRegistry};
use nexus_edge_wasm::{MockHostFactory, SimulationExecutor};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result};
use nexus_observability::{
    AuditTrail, ComponentState, HealthRegistry, JsonLinesAuditSink, Level, Logger, Metrics,
    RuntimeProfile,
};
use nexus_oneway::{
    AnalyticsReceiver, BufferedEgress, ControlledEdgeConfig, DiodeConfig, ObservationDiodeSender,
    Profile,
};

fn main() {
    let level = Level::parse_or_info(
        &std::env::var("NEXUS_LOG_LEVEL").unwrap_or_else(|_| "info".to_string()),
    );
    let logger = Logger::stderr("gatewayd", level);
    if let Err(error) = run(&logger) {
        logger.error(
            "gatewayd failed",
            vec![("error", Value::string(error.to_string()))],
        );
        std::process::exit(1);
    }
}

fn run(logger: &Logger) -> Result<()> {
    let profile = RuntimeProfile::from_env()?;
    validate_runtime(profile)?;
    let metrics = Arc::new(Metrics::new());
    let audit = Arc::new(AuditTrail::new(Box::new(JsonLinesAuditSink), 20_000));
    let health = HealthRegistry::new();

    let telemetry_identity =
        std::env::var("NEXUS_TELEMETRY_IDENTITY").unwrap_or_else(|_| "ot-telemetry".to_string());
    let control_identity =
        std::env::var("NEXUS_CONTROL_IDENTITY").unwrap_or_else(|_| "control-plane".to_string());

    // ---- Profile A: observation diode. Egress only. -----------------------
    let egress = Arc::new(BufferedEgress::new());
    let diode = ObservationDiodeSender::new(
        DiodeConfig::default(),
        Box::new(EgressHandle(Arc::clone(&egress))),
    );
    let receiver = AnalyticsReceiver::new(&[telemetry_identity.as_str()], true);
    health.set(
        "observation-diode",
        ComponentState::Degraded,
        "non-production buffered egress",
    );

    // ---- Profile B: controlled edge. Separate identity and channel. -------
    let control = ControlledEdgeConfig::new(
        control_identity,
        std::env::var("NEXUS_MTLS_CERT_PATH")
            .unwrap_or_else(|_| "/etc/nexus/tls/client.pem".into()),
        std::env::var("NEXUS_MTLS_KEY_PATH").unwrap_or_else(|_| "/etc/nexus/tls/client.key".into()),
        std::env::var("NEXUS_MTLS_CA_PATH").unwrap_or_else(|_| "/etc/nexus/tls/ca.pem".into()),
    )?;
    control.assert_distinct_from(&telemetry_identity)?;
    health.set(
        "controlled-edge",
        ComponentState::Degraded,
        "configuration parsed; channel not connected",
    );

    let signers = SignerRegistry::new();
    let nonces = NonceLedger::new(100_000);
    let executor = SimulationExecutor::new(
        std::env::var("NEXUS_DEVICE_ID").unwrap_or_else(|_| "robot-inspect-01".to_string()),
        vec![
            "navigate.waypoint".to_string(),
            "sensor.temperature".to_string(),
            "sensor.generic".to_string(),
        ],
        SignerRegistry::new(),
        MockHostFactory::new().with_reading("probe-a", 96.5),
    );

    health.set(
        "edge-sandbox",
        ComponentState::Degraded,
        "mock-host simulation mode",
    );

    logger.info(
        "gatewayd non-production runtime started",
        vec![
            ("runtime_profile", Value::string(profile.as_str())),
            ("health", health.report()),
            (
                "profiles",
                Value::Array(vec![
                    Value::string(Profile::ObservationDiode.as_str()),
                    Value::string(Profile::ControlledEdge.as_str()),
                ]),
            ),
            (
                "diode_note",
                Value::string("software zone separation; not a hardware data diode"),
            ),
        ],
    );

    // Nothing is polled in the default build: there is no broker connected.
    // The demo in examples/factory-line drives this wiring end to end.
    let _ = (&diode, &receiver, &signers, &nonces, &executor, &audit);

    if diode.rejected() > 0 {
        return Err(NexusError::invalid("diode rejected traffic during startup"));
    }

    print!("{}", metrics.render_text());
    Ok(())
}

fn validate_runtime(profile: RuntimeProfile) -> Result<()> {
    profile.require_non_production("buffered-egress")?;
    profile.require_non_production("unconnected-controlled-edge")?;
    profile.require_non_production("mock-host-simulation-executor")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_rejects_simulated_gateway_wiring() {
        assert!(validate_runtime(RuntimeProfile::Production).is_err());
        assert!(validate_runtime(RuntimeProfile::Development).is_ok());
        assert!(validate_runtime(RuntimeProfile::Test).is_ok());
    }

    #[test]
    fn simulated_gateway_is_live_but_never_ready() {
        let health = HealthRegistry::new();
        health.set(
            "controlled-edge",
            ComponentState::Degraded,
            "channel not connected",
        );
        health.set(
            "edge-sandbox",
            ComponentState::Degraded,
            "mock-host simulation mode",
        );
        assert!(health.is_live());
        assert!(!health.is_ready());
    }
}

#[derive(Debug)]
struct EgressHandle(Arc<BufferedEgress>);

impl nexus_oneway::EgressTransport for EgressHandle {
    fn emit(&self, record: &nexus_oneway::EgressRecord) -> Result<()> {
        nexus_oneway::EgressTransport::emit(&*self.0, record)
    }
}
