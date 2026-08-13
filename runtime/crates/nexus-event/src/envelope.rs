//! The canonical event envelope.
//!
//! Every byte that crosses a zone boundary in NEXUS V3 is wrapped in an
//! `EventEnvelope`. The envelope is the contract between the OT side, the
//! data highway, the ontology and the orchestrator.
//!
//! ## Delivery guarantees actually provided
//!
//! - **At-least-once delivery** from the broker. Nothing in this runtime
//!   claims exactly-once end to end, because the graph backend is not
//!   enrolled in a distributed transaction with the broker.
//! - **Effectively-once processing** for graph mutations, obtained by making
//!   the mutation idempotent under `idempotency_key` and by deduplicating
//!   with `DedupIndex` before commit. A duplicate delivery therefore
//!   produces no second effect, but the duplicate *is* delivered.
//! - **Ordering per `(source_id, stream)` only**, via `sequence`. There is no
//!   global order across sources and none is assumed anywhere.
//! - **Replay** is supported because envelopes are self-describing and their
//!   identifiers are content-derivable.
//!
//! See `docs/architecture/V3_DATA_PLANE.md` for the full statement.

use crate::classification::Classification;
use crate::error::{NexusError, Result};
use crate::hash::{constant_time_eq, from_hex, sha256, to_hex};
use crate::ids::{EventId, SourceId, TraceId};
use crate::json::Value;
use crate::time::Timestamp;
use std::collections::BTreeMap;

/// Current envelope schema version. Bump only for breaking changes; additive
/// optional fields do not require a bump.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Oldest schema version this build can still read.
pub const MIN_SUPPORTED_SCHEMA_VERSION: u32 = 1;

/// What produced the event. Kept closed so ingest can route on it without
/// string matching, and so no "unknown" category silently becomes trusted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SourceType {
    Sensor,
    Camera,
    Robot,
    Vehicle,
    Gateway,
    Service,
    Simulation,
    Operator,
}

impl SourceType {
    pub fn as_str(self) -> &'static str {
        match self {
            SourceType::Sensor => "sensor",
            SourceType::Camera => "camera",
            SourceType::Robot => "robot",
            SourceType::Vehicle => "vehicle",
            SourceType::Gateway => "gateway",
            SourceType::Service => "service",
            SourceType::Simulation => "simulation",
            SourceType::Operator => "operator",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "sensor" => SourceType::Sensor,
            "camera" => SourceType::Camera,
            "robot" => SourceType::Robot,
            "vehicle" => SourceType::Vehicle,
            "gateway" => SourceType::Gateway,
            "service" => SourceType::Service,
            "simulation" => SourceType::Simulation,
            "operator" => SourceType::Operator,
            other => return Err(NexusError::schema(format!("unknown source_type '{other}'"))),
        })
    }

    /// Whether an event from this source may be treated as originating inside
    /// a protected OT zone. Used by the one-way gateway profiles.
    pub fn is_field_device(self) -> bool {
        matches!(
            self,
            SourceType::Sensor | SourceType::Camera | SourceType::Robot | SourceType::Vehicle
        )
    }
}

/// Detached signature over the canonical envelope bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Signature {
    pub algorithm: String,
    pub signer_id: String,
    /// Lowercase hex.
    pub value: String,
}

impl Signature {
    pub fn new(
        algorithm: impl Into<String>,
        signer_id: impl Into<String>,
        value: impl Into<String>,
    ) -> Self {
        Signature {
            algorithm: algorithm.into(),
            signer_id: signer_id.into(),
            value: value.into(),
        }
    }

    fn to_json(&self) -> Value {
        Value::object(vec![
            ("algorithm", Value::string(&self.algorithm)),
            ("signer_id", Value::string(&self.signer_id)),
            ("value", Value::string(&self.value)),
        ])
    }

    fn from_json(value: &Value) -> Result<Self> {
        Ok(Signature {
            algorithm: value.require_str("algorithm")?.to_string(),
            signer_id: value.require_str("signer_id")?.to_string(),
            value: value.require_str("value")?.to_string(),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct EventEnvelope {
    pub event_id: EventId,
    pub schema_version: u32,
    pub source_id: SourceId,
    pub source_type: SourceType,
    /// When the observation happened, according to the source.
    pub occurred_at: Timestamp,
    /// When the runtime accepted it. Set by ingest, never by the source.
    pub ingested_at: Timestamp,
    /// Monotonic per `(source_id, stream)`. Gaps mean loss; repeats mean
    /// duplicate delivery.
    pub sequence: u64,
    pub classification: Classification,
    pub trace_id: TraceId,
    /// Logical stream name, e.g. `telemetry.temperature` or `detections`.
    pub stream: String,
    pub payload: Value,
    pub signature: Option<Signature>,
    /// Hex SHA-256 over the canonical bytes of every field except the
    /// signature and the hash itself.
    pub integrity_hash: String,
}

/// Builder so callers cannot forget to compute the integrity hash.
#[derive(Debug)]
pub struct EnvelopeBuilder {
    event_id: Option<EventId>,
    source_id: SourceId,
    source_type: SourceType,
    occurred_at: Timestamp,
    ingested_at: Option<Timestamp>,
    sequence: u64,
    classification: Classification,
    trace_id: Option<TraceId>,
    stream: String,
    payload: Value,
}

impl EnvelopeBuilder {
    pub fn new(
        source_id: SourceId,
        source_type: SourceType,
        stream: impl Into<String>,
        payload: Value,
    ) -> Self {
        EnvelopeBuilder {
            event_id: None,
            source_id,
            source_type,
            occurred_at: Timestamp::from_millis(0),
            ingested_at: None,
            sequence: 0,
            classification: Classification::Internal,
            trace_id: None,
            stream: stream.into(),
            payload,
        }
    }

    pub fn event_id(mut self, id: EventId) -> Self {
        self.event_id = Some(id);
        self
    }

    pub fn occurred_at(mut self, at: Timestamp) -> Self {
        self.occurred_at = at;
        self
    }

    pub fn ingested_at(mut self, at: Timestamp) -> Self {
        self.ingested_at = Some(at);
        self
    }

    pub fn sequence(mut self, sequence: u64) -> Self {
        self.sequence = sequence;
        self
    }

    pub fn classification(mut self, classification: Classification) -> Self {
        self.classification = classification;
        self
    }

    pub fn trace_id(mut self, trace_id: TraceId) -> Self {
        self.trace_id = Some(trace_id);
        self
    }

    pub fn build(self) -> EventEnvelope {
        let ingested_at = self.ingested_at.unwrap_or(self.occurred_at);
        let mut envelope = EventEnvelope {
            event_id: self.event_id.unwrap_or_default(),
            schema_version: CURRENT_SCHEMA_VERSION,
            source_id: self.source_id,
            source_type: self.source_type,
            occurred_at: self.occurred_at,
            ingested_at,
            sequence: self.sequence,
            classification: self.classification,
            trace_id: self.trace_id.unwrap_or_default(),
            stream: self.stream,
            payload: self.payload,
            signature: None,
            integrity_hash: String::new(),
        };
        envelope.integrity_hash = envelope.compute_integrity_hash();
        envelope
    }
}

impl EventEnvelope {
    pub fn builder(
        source_id: SourceId,
        source_type: SourceType,
        stream: impl Into<String>,
        payload: Value,
    ) -> EnvelopeBuilder {
        EnvelopeBuilder::new(source_id, source_type, stream, payload)
    }

    /// Canonical bytes covered by the integrity hash and by any signature.
    ///
    /// Deliberately excludes `ingested_at` (set downstream of the signer) and
    /// the signature/hash fields themselves, so a signature made at the edge
    /// still verifies after the gateway stamps arrival time.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let canonical = Value::object(vec![
            ("event_id", Value::string(self.event_id.as_str())),
            ("schema_version", Value::number(self.schema_version as f64)),
            ("source_id", Value::string(self.source_id.as_str())),
            ("source_type", Value::string(self.source_type.as_str())),
            (
                "occurred_at",
                Value::number(self.occurred_at.as_millis() as f64),
            ),
            ("sequence", Value::number(self.sequence as f64)),
            (
                "classification",
                Value::string(self.classification.as_str()),
            ),
            ("trace_id", Value::string(self.trace_id.as_str())),
            ("stream", Value::string(&self.stream)),
            ("payload", self.payload.clone()),
        ]);
        canonical.to_canonical_bytes()
    }

    pub fn compute_integrity_hash(&self) -> String {
        to_hex(&sha256(&self.signing_bytes()))
    }

    /// Idempotency key used by ingest and by graph mutation.
    ///
    /// Content-derived rather than random: a replayed or re-sent envelope
    /// carrying the same payload collapses to the same key.
    pub fn idempotency_key(&self) -> String {
        let material = format!(
            "{}|{}|{}|{}",
            self.source_id, self.stream, self.sequence, self.integrity_hash
        );
        to_hex(&sha256(material.as_bytes()))
    }

    /// Structural and semantic validation. Called at every trust boundary.
    pub fn validate(&self) -> Result<()> {
        if self.schema_version < MIN_SUPPORTED_SCHEMA_VERSION
            || self.schema_version > CURRENT_SCHEMA_VERSION
        {
            return Err(NexusError::schema(format!(
                "unsupported schema_version {} (supported {}..={})",
                self.schema_version, MIN_SUPPORTED_SCHEMA_VERSION, CURRENT_SCHEMA_VERSION
            )));
        }
        if self.source_id.as_str().is_empty() {
            return Err(NexusError::schema("source_id must not be empty"));
        }
        if self.stream.is_empty() || self.stream.len() > 128 {
            return Err(NexusError::schema("stream must be 1..=128 characters"));
        }
        if !self
            .stream
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        {
            return Err(NexusError::schema("stream may only contain [A-Za-z0-9._-]"));
        }
        if !matches!(self.payload, Value::Object(_)) {
            return Err(NexusError::schema("payload must be a JSON object"));
        }
        if self.occurred_at.as_millis() <= 0 {
            return Err(NexusError::schema("occurred_at must be a positive epoch"));
        }
        if let Some(signature) = &self.signature {
            if from_hex(&signature.value).is_none() {
                return Err(NexusError::schema("signature value must be hex"));
            }
            if signature.signer_id.is_empty() {
                return Err(NexusError::schema("signature signer_id must not be empty"));
            }
        }
        self.verify_integrity()
    }

    pub fn verify_integrity(&self) -> Result<()> {
        let expected = self.compute_integrity_hash();
        if !constant_time_eq(expected.as_bytes(), self.integrity_hash.as_bytes()) {
            return Err(NexusError::integrity(format!(
                "integrity_hash mismatch for event {}",
                self.event_id
            )));
        }
        Ok(())
    }

    /// Clock plausibility, evaluated against the receiving side's clock.
    ///
    /// Separate from `validate` because a skewed edge clock is an operational
    /// signal, not necessarily a rejection.
    pub fn clock_skew_millis(&self, now: Timestamp) -> i64 {
        self.occurred_at.delta_millis(now)
    }

    pub fn attach_signature(&mut self, signature: Signature) {
        self.signature = Some(signature);
    }

    pub fn to_json(&self) -> Value {
        let mut map: BTreeMap<String, Value> = BTreeMap::new();
        map.insert("event_id".into(), Value::string(self.event_id.as_str()));
        map.insert(
            "schema_version".into(),
            Value::number(self.schema_version as f64),
        );
        map.insert("source_id".into(), Value::string(self.source_id.as_str()));
        map.insert(
            "source_type".into(),
            Value::string(self.source_type.as_str()),
        );
        map.insert(
            "occurred_at".into(),
            Value::number(self.occurred_at.as_millis() as f64),
        );
        map.insert(
            "ingested_at".into(),
            Value::number(self.ingested_at.as_millis() as f64),
        );
        map.insert("sequence".into(), Value::number(self.sequence as f64));
        map.insert(
            "classification".into(),
            Value::string(self.classification.as_str()),
        );
        map.insert("trace_id".into(), Value::string(self.trace_id.as_str()));
        map.insert("stream".into(), Value::string(&self.stream));
        map.insert("payload".into(), self.payload.clone());
        map.insert("integrity_hash".into(), Value::string(&self.integrity_hash));
        map.insert(
            "signature".into(),
            match &self.signature {
                Some(signature) => signature.to_json(),
                None => Value::Null,
            },
        );
        Value::Object(map)
    }

    pub fn to_canonical_string(&self) -> String {
        self.to_json().to_canonical_string()
    }

    pub fn from_json(value: &Value) -> Result<Self> {
        let signature = match value.get("signature") {
            None | Some(Value::Null) => None,
            Some(node) => Some(Signature::from_json(node)?),
        };
        let payload = value
            .get("payload")
            .ok_or_else(|| NexusError::schema("missing field 'payload'"))?
            .clone();

        let envelope = EventEnvelope {
            event_id: EventId::from_external(value.require_str("event_id")?),
            schema_version: value.require_u64("schema_version")? as u32,
            source_id: SourceId::from_external(value.require_str("source_id")?),
            source_type: SourceType::parse(value.require_str("source_type")?)?,
            occurred_at: Timestamp::from_millis(value.require_f64("occurred_at")? as i64),
            ingested_at: Timestamp::from_millis(value.require_f64("ingested_at")? as i64),
            sequence: value.require_u64("sequence")?,
            classification: Classification::parse(value.require_str("classification")?)?,
            trace_id: TraceId::from_external(value.require_str("trace_id")?),
            stream: value.require_str("stream")?.to_string(),
            payload,
            signature,
            integrity_hash: value.require_str("integrity_hash")?.to_string(),
        };
        Ok(envelope)
    }

    pub fn decode(source: &str) -> Result<Self> {
        let value = crate::json::parse(source)?;
        let envelope = EventEnvelope::from_json(&value)?;
        envelope.validate()?;
        Ok(envelope)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> EventEnvelope {
        EventEnvelope::builder(
            SourceId::from_external("temp-sensor-17"),
            SourceType::Sensor,
            "telemetry.temperature",
            Value::object(vec![
                ("celsius", Value::number(91.5)),
                ("asset", Value::string("press-04")),
            ]),
        )
        .occurred_at(Timestamp::from_millis(1_700_000_000_000))
        .sequence(42)
        .build()
    }

    #[test]
    fn builder_produces_a_valid_envelope() {
        let envelope = sample();
        envelope.validate().expect("valid");
        assert_eq!(envelope.schema_version, CURRENT_SCHEMA_VERSION);
        assert_eq!(envelope.ingested_at, envelope.occurred_at);
    }

    #[test]
    fn json_round_trip_preserves_every_field() {
        let envelope = sample();
        let decoded = EventEnvelope::decode(&envelope.to_canonical_string()).expect("decodes");
        assert_eq!(decoded, envelope);
    }

    #[test]
    fn tampering_with_the_payload_breaks_the_integrity_hash() {
        let mut envelope = sample();
        envelope.payload = Value::object(vec![("celsius", Value::number(20.0))]);
        let error = envelope.verify_integrity().unwrap_err();
        assert_eq!(error.kind(), "integrity");
    }

    #[test]
    fn ingest_timestamp_is_outside_the_signed_bytes() {
        let mut envelope = sample();
        let before = envelope.signing_bytes();
        envelope.ingested_at = Timestamp::from_millis(1_700_000_009_999);
        assert_eq!(before, envelope.signing_bytes());
        envelope.verify_integrity().expect("still intact");
    }

    #[test]
    fn idempotency_key_is_stable_and_content_derived() {
        let first = sample();
        let second = sample();
        assert_ne!(first.event_id, second.event_id);
        assert_ne!(first.idempotency_key(), second.idempotency_key());

        let replay = EventEnvelope::decode(&first.to_canonical_string()).unwrap();
        assert_eq!(replay.idempotency_key(), first.idempotency_key());
    }

    #[test]
    fn rejects_unsupported_schema_version() {
        let mut envelope = sample();
        envelope.schema_version = 99;
        envelope.integrity_hash = envelope.compute_integrity_hash();
        let error = envelope.validate().unwrap_err();
        assert_eq!(error.kind(), "schema");
    }

    #[test]
    fn rejects_non_object_payload() {
        let mut envelope = sample();
        envelope.payload = Value::string("not an object");
        envelope.integrity_hash = envelope.compute_integrity_hash();
        assert!(envelope.validate().is_err());
    }

    #[test]
    fn rejects_hostile_stream_names() {
        for bad in ["", "../etc/passwd", "a b", "nexus/telemetry"] {
            let mut envelope = sample();
            envelope.stream = bad.to_string();
            envelope.integrity_hash = envelope.compute_integrity_hash();
            assert!(envelope.validate().is_err(), "should reject stream {bad:?}");
        }
    }

    #[test]
    fn unknown_source_type_is_rejected_not_defaulted() {
        assert!(SourceType::parse("weapon").is_err());
        assert!(SourceType::parse("").is_err());
    }

    #[test]
    fn clock_skew_is_reported_signed() {
        let envelope = sample();
        let later = Timestamp::from_millis(1_700_000_005_000);
        assert_eq!(envelope.clock_skew_millis(later), -5_000);
    }
}
