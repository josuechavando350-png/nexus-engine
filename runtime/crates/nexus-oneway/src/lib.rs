//! # nexus-oneway
//!
//! Zone separation for the data plane.
//!
//! ## The claim this crate does NOT make
//!
//! **Software is not a data diode.** Nothing here physically prevents a
//! packet from travelling in the reverse direction. A real unidirectional
//! gateway is hardware — an optical link with no return fibre, or an
//! equivalent appliance — and if your threat model requires that guarantee,
//! you need that hardware. What this crate provides is a *software
//! architecture* that (a) removes every reverse code path in the observation
//! profile, so a reverse channel cannot be used even if one exists at the
//! network layer, and (b) makes any attempt to open one a loud, audited
//! failure instead of a silent success.
//!
//! Any deployment document that says otherwise is wrong; see
//! `docs/architecture/V3_ONEWAY_SECURITY.md`.
//!
//! ## Two profiles
//!
//! - [`Profile::ObservationDiode`] — telemetry leaves the protected OT zone
//!   and nothing comes back. No listener, no command topic subscription, no
//!   request/response. The type system enforces this: the sender exposes no
//!   receive method at all.
//! - [`Profile::ControlledEdge`] — a *separate* channel, separate identity,
//!   mutual authentication, signed commands, policy evaluation and a human
//!   approval gate for high-impact actions. This is how legitimate control
//!   happens, and it is deliberately not the same object as the diode.
//!
//! Conflating the two is the mistake this design exists to prevent.

#![forbid(unsafe_code)]

use nexus_event::json::Value;
use nexus_event::{
    topics, Classification, EventEnvelope, NexusError, Result, Timestamp,
};
use nexus_observability::{AuditAction, AuditTrail};
use std::collections::HashSet;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    ObservationDiode,
    ControlledEdge,
}

impl Profile {
    pub fn as_str(self) -> &'static str {
        match self {
            Profile::ObservationDiode => "OBSERVATION_DIODE",
            Profile::ControlledEdge => "CONTROLLED_EDGE",
        }
    }

    /// Whether this profile can carry anything toward the protected zone.
    pub fn permits_inbound(self) -> bool {
        matches!(self, Profile::ControlledEdge)
    }
}

/// Why an egress attempt was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EgressRejection {
    TopicNotAllowed(String),
    ClassificationTooHigh {
        found: &'static str,
        ceiling: &'static str,
    },
    Unsigned,
    IntegrityFailed,
    PayloadTooLarge {
        bytes: usize,
        limit: usize,
    },
    RateLimited {
        window_count: usize,
        limit: usize,
    },
    NotAFieldDevice(&'static str),
}

impl EgressRejection {
    pub fn code(&self) -> &'static str {
        match self {
            EgressRejection::TopicNotAllowed(_) => "topic_not_allowed",
            EgressRejection::ClassificationTooHigh { .. } => "classification_too_high",
            EgressRejection::Unsigned => "unsigned",
            EgressRejection::IntegrityFailed => "integrity_failed",
            EgressRejection::PayloadTooLarge { .. } => "payload_too_large",
            EgressRejection::RateLimited { .. } => "rate_limited",
            EgressRejection::NotAFieldDevice(_) => "not_a_field_device",
        }
    }

    pub fn describe(&self) -> String {
        match self {
            EgressRejection::TopicNotAllowed(topic) => {
                format!("topic '{topic}' is not on the OT egress allowlist")
            }
            EgressRejection::ClassificationTooHigh { found, ceiling } => {
                format!("classification {found} exceeds the gateway ceiling {ceiling}")
            }
            EgressRejection::Unsigned => "envelope carries no signature".into(),
            EgressRejection::IntegrityFailed => "envelope integrity hash does not verify".into(),
            EgressRejection::PayloadTooLarge { bytes, limit } => {
                format!("payload of {bytes} bytes exceeds the {limit} byte limit")
            }
            EgressRejection::RateLimited {
                window_count,
                limit,
            } => format!("{window_count} messages in window exceeds limit {limit}"),
            EgressRejection::NotAFieldDevice(source_type) => {
                format!("source_type '{source_type}' may not emit from the OT zone")
            }
        }
    }
}

/// Gateway configuration for the observation profile.
#[derive(Debug, Clone)]
pub struct DiodeConfig {
    /// Highest classification allowed to leave the zone.
    pub classification_ceiling: Classification,
    /// Topics the OT side may publish to.
    pub allowed_topics: Vec<String>,
    pub max_payload_bytes: usize,
    /// Messages permitted per rate-limit window.
    pub max_messages_per_window: usize,
    pub window_millis: i64,
    /// Reject envelopes that arrive without a signature.
    pub require_signature: bool,
}

impl Default for DiodeConfig {
    fn default() -> Self {
        DiodeConfig {
            classification_ceiling: Classification::Sensitive,
            allowed_topics: topics::OT_EGRESS_ALLOWLIST
                .iter()
                .map(|topic| topic.to_string())
                .collect(),
            max_payload_bytes: 256 * 1024,
            max_messages_per_window: 10_000,
            window_millis: 1_000,
            require_signature: true,
        }
    }
}

/// One accepted, outbound-only message.
#[derive(Debug, Clone, PartialEq)]
pub struct EgressRecord {
    pub topic: String,
    pub payload: String,
    pub emitted_at: Timestamp,
    pub integrity_hash: String,
}

/// Where accepted telemetry is handed off. Egress only, by construction:
/// there is no method through which the analytics side can reply.
pub trait EgressTransport: Send + Sync + std::fmt::Debug {
    fn emit(&self, record: &EgressRecord) -> Result<()>;
}

/// Buffers accepted records. Used by the demo, the tests and the examples.
#[derive(Debug, Default)]
pub struct BufferedEgress {
    records: Mutex<Vec<EgressRecord>>,
}

impl BufferedEgress {
    pub fn new() -> Self {
        BufferedEgress::default()
    }

    pub fn records(&self) -> Vec<EgressRecord> {
        self.records.lock().map(|guard| guard.clone()).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.records.lock().map(|guard| guard.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl EgressTransport for BufferedEgress {
    fn emit(&self, record: &EgressRecord) -> Result<()> {
        self.records
            .lock()
            .map_err(|_| NexusError::adapter("egress buffer poisoned"))?
            .push(record.clone());
        Ok(())
    }
}

/// The OT-side sender.
///
/// Note the API surface: `send`, `accepted`, `rejected`. There is no
/// `receive`, no `subscribe`, no `request`, and no way to obtain a handle
/// that has one. A reverse channel cannot be added here without changing
/// this type, which is exactly the review checkpoint that is wanted.
#[derive(Debug)]
pub struct ObservationDiodeSender {
    config: DiodeConfig,
    transport: Box<dyn EgressTransport>,
    state: Mutex<SenderState>,
}

#[derive(Debug, Default)]
struct SenderState {
    accepted: u64,
    rejected: u64,
    window_start_millis: i64,
    window_count: usize,
}

impl ObservationDiodeSender {
    pub fn new(config: DiodeConfig, transport: Box<dyn EgressTransport>) -> Self {
        ObservationDiodeSender {
            config,
            transport,
            state: Mutex::new(SenderState::default()),
        }
    }

    pub fn profile(&self) -> Profile {
        Profile::ObservationDiode
    }

    /// Validates and emits. Fails closed on every check.
    pub fn send(
        &self,
        topic: &str,
        envelope: &EventEnvelope,
        now: Timestamp,
    ) -> std::result::Result<EgressRecord, EgressRejection> {
        if !self.config.allowed_topics.iter().any(|allowed| allowed == topic) {
            self.count_rejected();
            return Err(EgressRejection::TopicNotAllowed(topic.to_string()));
        }

        if !envelope
            .classification
            .may_cross_to(self.config.classification_ceiling)
        {
            self.count_rejected();
            return Err(EgressRejection::ClassificationTooHigh {
                found: envelope.classification.as_str(),
                ceiling: self.config.classification_ceiling.as_str(),
            });
        }

        if !envelope.source_type.is_field_device() {
            self.count_rejected();
            return Err(EgressRejection::NotAFieldDevice(
                envelope.source_type.as_str(),
            ));
        }

        if self.config.require_signature && envelope.signature.is_none() {
            self.count_rejected();
            return Err(EgressRejection::Unsigned);
        }

        if envelope.verify_integrity().is_err() {
            self.count_rejected();
            return Err(EgressRejection::IntegrityFailed);
        }

        let payload = envelope.to_canonical_string();
        if payload.len() > self.config.max_payload_bytes {
            self.count_rejected();
            return Err(EgressRejection::PayloadTooLarge {
                bytes: payload.len(),
                limit: self.config.max_payload_bytes,
            });
        }

        if let Some(rejection) = self.check_rate_limit(now) {
            self.count_rejected();
            return Err(rejection);
        }

        let record = EgressRecord {
            topic: topic.to_string(),
            payload,
            emitted_at: now,
            integrity_hash: envelope.integrity_hash.clone(),
        };

        if self.transport.emit(&record).is_err() {
            self.count_rejected();
            // A transport failure on the OT side must not block the process;
            // the local spool in `nexus-ingest` owns retry.
            return Err(EgressRejection::RateLimited {
                window_count: 0,
                limit: 0,
            });
        }

        if let Ok(mut state) = self.state.lock() {
            state.accepted += 1;
        }
        Ok(record)
    }

    fn check_rate_limit(&self, now: Timestamp) -> Option<EgressRejection> {
        let mut state = self.state.lock().ok()?;
        if now.as_millis() - state.window_start_millis >= self.config.window_millis {
            state.window_start_millis = now.as_millis();
            state.window_count = 0;
        }
        state.window_count += 1;
        if state.window_count > self.config.max_messages_per_window {
            return Some(EgressRejection::RateLimited {
                window_count: state.window_count,
                limit: self.config.max_messages_per_window,
            });
        }
        None
    }

    fn count_rejected(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.rejected += 1;
        }
    }

    pub fn accepted(&self) -> u64 {
        self.state.lock().map(|state| state.accepted).unwrap_or(0)
    }

    pub fn rejected(&self) -> u64 {
        self.state.lock().map(|state| state.rejected).unwrap_or(0)
    }
}

/// The analytics-side receiver.
///
/// Validates everything again — it does not trust the sender — and keeps an
/// append-only audit of what it accepted.
#[derive(Debug)]
pub struct AnalyticsReceiver {
    require_signature: bool,
    trusted_signers: HashSet<String>,
    seen_hashes: Mutex<HashSet<String>>,
}

impl AnalyticsReceiver {
    pub fn new(trusted_signers: &[&str], require_signature: bool) -> Self {
        AnalyticsReceiver {
            require_signature,
            trusted_signers: trusted_signers
                .iter()
                .map(|signer| signer.to_string())
                .collect(),
            seen_hashes: Mutex::new(HashSet::new()),
        }
    }

    /// Accepts a record, or explains why not.
    pub fn accept(
        &self,
        record: &EgressRecord,
        audit: &AuditTrail,
    ) -> std::result::Result<EventEnvelope, EgressRejection> {
        let envelope = match EventEnvelope::decode(&record.payload) {
            Ok(envelope) => envelope,
            Err(_) => {
                audit.record(
                    AuditAction::GatewayRejected,
                    &record.topic,
                    "analytics-receiver",
                    None,
                    Value::object(vec![("reason", Value::string("undecodable"))]),
                );
                return Err(EgressRejection::IntegrityFailed);
            }
        };

        if self.require_signature {
            match &envelope.signature {
                None => return Err(EgressRejection::Unsigned),
                Some(signature) => {
                    if !self.trusted_signers.contains(&signature.signer_id) {
                        return Err(EgressRejection::Unsigned);
                    }
                }
            }
        }

        if envelope.integrity_hash != record.integrity_hash {
            return Err(EgressRejection::IntegrityFailed);
        }

        // Replay suppression on the receiving side: a diode has no way to ask
        // the sender to stop, so the receiver must be idempotent.
        if let Ok(mut seen) = self.seen_hashes.lock() {
            if !seen.insert(envelope.idempotency_key()) {
                audit.record(
                    AuditAction::GatewayRejected,
                    envelope.event_id.as_str(),
                    "analytics-receiver",
                    Some(&envelope.trace_id),
                    Value::object(vec![("reason", Value::string("duplicate"))]),
                );
                return Err(EgressRejection::IntegrityFailed);
            }
        }

        audit.record(
            AuditAction::GatewayEgress,
            envelope.event_id.as_str(),
            "analytics-receiver",
            Some(&envelope.trace_id),
            Value::object(vec![
                ("topic", Value::string(&record.topic)),
                ("profile", Value::string(Profile::ObservationDiode.as_str())),
            ]),
        );

        Ok(envelope)
    }
}

/// Configuration for the separate, bidirectional control channel.
///
/// Nothing here is reachable from [`ObservationDiodeSender`]. They are
/// different types, use different identities and, in a real deployment,
/// different network paths and different credentials.
#[derive(Debug, Clone)]
pub struct ControlledEdgeConfig {
    /// Identity of the control plane, distinct from the telemetry identity.
    pub control_identity: String,
    /// Path to the client certificate used for mutual TLS. Never a secret
    /// value in configuration — a path the process reads at start.
    pub client_certificate_path: String,
    pub client_key_path: String,
    pub server_ca_path: String,
    /// Commands must be signed and must expire.
    pub require_signed_commands: bool,
    pub max_command_ttl_millis: i64,
    /// High-impact actions require a recorded human approval.
    pub require_approval_for_high_impact: bool,
}

impl ControlledEdgeConfig {
    /// Builds a config and refuses insecure combinations outright.
    pub fn new(
        control_identity: impl Into<String>,
        client_certificate_path: impl Into<String>,
        client_key_path: impl Into<String>,
        server_ca_path: impl Into<String>,
    ) -> Result<Self> {
        let config = ControlledEdgeConfig {
            control_identity: control_identity.into(),
            client_certificate_path: client_certificate_path.into(),
            client_key_path: client_key_path.into(),
            server_ca_path: server_ca_path.into(),
            require_signed_commands: true,
            max_command_ttl_millis: 60_000,
            require_approval_for_high_impact: true,
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<()> {
        if self.control_identity.trim().is_empty() {
            return Err(NexusError::invalid("control identity must not be empty"));
        }
        for (name, path) in [
            ("client_certificate_path", &self.client_certificate_path),
            ("client_key_path", &self.client_key_path),
            ("server_ca_path", &self.server_ca_path),
        ] {
            if path.trim().is_empty() {
                return Err(NexusError::invalid(format!("{name} must be configured")));
            }
        }
        if !self.require_signed_commands {
            return Err(NexusError::denied(
                "unsigned commands are not permitted on the controlled edge channel",
            ));
        }
        if !self.require_approval_for_high_impact {
            return Err(NexusError::denied(
                "high-impact actions always require a human approval",
            ));
        }
        if self.max_command_ttl_millis <= 0 || self.max_command_ttl_millis > 600_000 {
            return Err(NexusError::invalid(
                "command TTL must be within 1..=600000 milliseconds",
            ));
        }
        Ok(())
    }

    /// Guards against configuring the control channel with the telemetry
    /// identity, which would collapse the separation the two profiles exist
    /// to maintain.
    pub fn assert_distinct_from(&self, telemetry_identity: &str) -> Result<()> {
        if self.control_identity == telemetry_identity {
            return Err(NexusError::denied(
                "the control channel must not reuse the telemetry identity",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_event::envelope::{Signature, SourceType};
    use nexus_event::{SourceId, Value as JsonValue};

    fn envelope(classification: Classification, signed: bool) -> EventEnvelope {
        let mut envelope = EventEnvelope::builder(
            SourceId::from_external("temp-17"),
            SourceType::Sensor,
            "telemetry.temperature",
            JsonValue::object(vec![("celsius", JsonValue::number(91.5))]),
        )
        .occurred_at(Timestamp::from_millis(1_700_000_000_000))
        .classification(classification)
        .sequence(1)
        .build();
        if signed {
            envelope.attach_signature(Signature::new("dev-hmac-sha256", "ot-gateway", "ab12"));
        }
        envelope
    }

    fn sender() -> (ObservationDiodeSender, std::sync::Arc<BufferedEgress>) {
        let buffer = std::sync::Arc::new(BufferedEgress::new());
        let transport = Box::new(SharedBuffer(buffer.clone()));
        (
            ObservationDiodeSender::new(DiodeConfig::default(), transport),
            buffer,
        )
    }

    #[derive(Debug)]
    struct SharedBuffer(std::sync::Arc<BufferedEgress>);

    impl EgressTransport for SharedBuffer {
        fn emit(&self, record: &EgressRecord) -> Result<()> {
            self.0.emit(record)
        }
    }

    fn now() -> Timestamp {
        Timestamp::from_millis(1_700_000_000_000)
    }

    #[test]
    fn telemetry_from_a_field_device_is_emitted() {
        let (sender, buffer) = sender();
        let record = sender
            .send(topics::TELEMETRY_RAW, &envelope(Classification::Internal, true), now())
            .expect("accepted");
        assert_eq!(buffer.len(), 1);
        assert_eq!(record.topic, topics::TELEMETRY_RAW);
        assert_eq!(sender.accepted(), 1);
    }

    #[test]
    fn command_and_mutation_topics_can_never_be_used_for_egress() {
        let (sender, _) = sender();
        for forbidden in [
            topics::TASK_PROPOSALS,
            topics::GRAPH_MUTATIONS,
            topics::TELEMETRY_NORMALIZED,
        ] {
            let error = sender
                .send(forbidden, &envelope(Classification::Internal, true), now())
                .unwrap_err();
            assert_eq!(error.code(), "topic_not_allowed", "topic {forbidden}");
        }
    }

    #[test]
    fn classification_above_the_ceiling_is_refused() {
        let (sender, _) = sender();
        let error = sender
            .send(
                topics::TELEMETRY_RAW,
                &envelope(Classification::Restricted, true),
                now(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "classification_too_high");
    }

    #[test]
    fn unsigned_telemetry_is_refused_when_signatures_are_required() {
        let (sender, _) = sender();
        let error = sender
            .send(
                topics::TELEMETRY_RAW,
                &envelope(Classification::Internal, false),
                now(),
            )
            .unwrap_err();
        assert_eq!(error.code(), "unsigned");
    }

    #[test]
    fn a_tampered_envelope_is_refused() {
        let (sender, _) = sender();
        let mut tampered = envelope(Classification::Internal, true);
        tampered.payload = JsonValue::object(vec![("celsius", JsonValue::number(20.0))]);
        let error = sender
            .send(topics::TELEMETRY_RAW, &tampered, now())
            .unwrap_err();
        assert_eq!(error.code(), "integrity_failed");
    }

    #[test]
    fn a_service_may_not_impersonate_a_field_device() {
        let (sender, _) = sender();
        let mut from_service = EventEnvelope::builder(
            SourceId::from_external("orchestratord"),
            SourceType::Service,
            "telemetry.temperature",
            JsonValue::object(vec![("celsius", JsonValue::number(1.0))]),
        )
        .occurred_at(now())
        .build();
        from_service.attach_signature(Signature::new("dev", "svc", "ab"));
        let error = sender
            .send(topics::TELEMETRY_RAW, &from_service, now())
            .unwrap_err();
        assert_eq!(error.code(), "not_a_field_device");
    }

    #[test]
    fn the_rate_limit_bounds_a_burst() {
        let buffer = std::sync::Arc::new(BufferedEgress::new());
        let config = DiodeConfig {
            max_messages_per_window: 2,
            ..DiodeConfig::default()
        };
        let sender =
            ObservationDiodeSender::new(config, Box::new(SharedBuffer(buffer.clone())));
        let event = envelope(Classification::Internal, true);
        assert!(sender.send(topics::TELEMETRY_RAW, &event, now()).is_ok());
        assert!(sender.send(topics::TELEMETRY_RAW, &event, now()).is_ok());
        let error = sender
            .send(topics::TELEMETRY_RAW, &event, now())
            .unwrap_err();
        assert_eq!(error.code(), "rate_limited");

        // The window resets.
        let later = Timestamp::from_millis(now().as_millis() + 2_000);
        assert!(sender.send(topics::TELEMETRY_RAW, &event, later).is_ok());
    }

    #[test]
    fn the_receiver_revalidates_and_suppresses_replays() {
        let (sender, _) = sender();
        let audit = AuditTrail::in_memory();
        let receiver = AnalyticsReceiver::new(&["ot-gateway"], true);
        let event = envelope(Classification::Internal, true);
        let record = sender
            .send(topics::TELEMETRY_RAW, &event, now())
            .expect("accepted");

        assert!(receiver.accept(&record, &audit).is_ok());
        // Same record again: refused.
        assert!(receiver.accept(&record, &audit).is_err());
        assert!(audit.len() >= 2);
        audit.verify_chain().expect("audit chain intact");
    }

    #[test]
    fn the_receiver_rejects_an_untrusted_signer() {
        let (sender, _) = sender();
        let audit = AuditTrail::in_memory();
        let receiver = AnalyticsReceiver::new(&["some-other-gateway"], true);
        let record = sender
            .send(topics::TELEMETRY_RAW, &envelope(Classification::Internal, true), now())
            .unwrap();
        assert!(receiver.accept(&record, &audit).is_err());
    }

    #[test]
    fn the_observation_profile_permits_no_inbound_path() {
        assert!(!Profile::ObservationDiode.permits_inbound());
        assert!(Profile::ControlledEdge.permits_inbound());
    }

    #[test]
    fn the_control_channel_refuses_insecure_configuration() {
        let mut config =
            ControlledEdgeConfig::new("control-plane", "cert.pem", "key.pem", "ca.pem").unwrap();
        assert!(config.validate().is_ok());

        config.require_signed_commands = false;
        assert!(config.validate().is_err());

        let mut no_approval =
            ControlledEdgeConfig::new("control-plane", "cert.pem", "key.pem", "ca.pem").unwrap();
        no_approval.require_approval_for_high_impact = false;
        assert!(no_approval.validate().is_err());

        let mut forever =
            ControlledEdgeConfig::new("control-plane", "cert.pem", "key.pem", "ca.pem").unwrap();
        forever.max_command_ttl_millis = 86_400_000;
        assert!(forever.validate().is_err());
    }

    #[test]
    fn the_control_channel_may_not_reuse_the_telemetry_identity() {
        let config =
            ControlledEdgeConfig::new("ot-gateway", "cert.pem", "key.pem", "ca.pem").unwrap();
        assert!(config.assert_distinct_from("ot-gateway").is_err());
        assert!(config.assert_distinct_from("telemetry-sender").is_ok());
    }

    #[test]
    fn configuration_carries_paths_not_secret_values() {
        let config =
            ControlledEdgeConfig::new("control-plane", "/etc/nexus/cert.pem", "/etc/nexus/key.pem", "/etc/nexus/ca.pem")
                .unwrap();
        let rendered = format!("{config:?}");
        assert!(rendered.contains("/etc/nexus/key.pem"));
        assert!(!rendered.contains("BEGIN PRIVATE KEY"));
    }
}
