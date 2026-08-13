//! The ontology itself: entity kinds, relationship kinds, temporal facts and
//! provenance.
//!
//! This module has **no knowledge of any graph database**. It defines what a
//! node and an edge mean in NEXUS; `nexus-graph` decides where they are
//! stored. That separation is a gate in CI, not just a convention.

use nexus_event::json::Value;
use nexus_event::{EntityId, NexusError, Result, SourceId, Timestamp, TraceId};
use std::collections::BTreeMap;

/// Closed set of entity kinds.
///
/// Non-military by construction. There is no Target, Threat, Combatant or
/// Person-of-interest kind, and `parse` refuses anything outside this list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum EntityKind {
    Asset,
    Sensor,
    Camera,
    Robot,
    Vehicle,
    Facility,
    Zone,
    Observation,
    Detection,
    Incident,
    Task,
    Operator,
    Policy,
    Model,
    TelemetryStream,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            EntityKind::Asset => "Asset",
            EntityKind::Sensor => "Sensor",
            EntityKind::Camera => "Camera",
            EntityKind::Robot => "Robot",
            EntityKind::Vehicle => "Vehicle",
            EntityKind::Facility => "Facility",
            EntityKind::Zone => "Zone",
            EntityKind::Observation => "Observation",
            EntityKind::Detection => "Detection",
            EntityKind::Incident => "Incident",
            EntityKind::Task => "Task",
            EntityKind::Operator => "Operator",
            EntityKind::Policy => "Policy",
            EntityKind::Model => "Model",
            EntityKind::TelemetryStream => "TelemetryStream",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "Asset" => EntityKind::Asset,
            "Sensor" => EntityKind::Sensor,
            "Camera" => EntityKind::Camera,
            "Robot" => EntityKind::Robot,
            "Vehicle" => EntityKind::Vehicle,
            "Facility" => EntityKind::Facility,
            "Zone" => EntityKind::Zone,
            "Observation" => EntityKind::Observation,
            "Detection" => EntityKind::Detection,
            "Incident" => EntityKind::Incident,
            "Task" => EntityKind::Task,
            "Operator" => EntityKind::Operator,
            "Policy" => EntityKind::Policy,
            "Model" => EntityKind::Model,
            "TelemetryStream" => EntityKind::TelemetryStream,
            other => return Err(NexusError::schema(format!("unknown entity kind '{other}'"))),
        })
    }

    pub fn all() -> &'static [EntityKind] {
        &[
            EntityKind::Asset,
            EntityKind::Sensor,
            EntityKind::Camera,
            EntityKind::Robot,
            EntityKind::Vehicle,
            EntityKind::Facility,
            EntityKind::Zone,
            EntityKind::Observation,
            EntityKind::Detection,
            EntityKind::Incident,
            EntityKind::Task,
            EntityKind::Operator,
            EntityKind::Policy,
            EntityKind::Model,
            EntityKind::TelemetryStream,
        ]
    }

    /// Kinds that describe a durable physical thing, as opposed to an event
    /// or a record. Only these participate in entity resolution.
    pub fn is_physical(self) -> bool {
        matches!(
            self,
            EntityKind::Asset
                | EntityKind::Sensor
                | EntityKind::Camera
                | EntityKind::Robot
                | EntityKind::Vehicle
                | EntityKind::Facility
                | EntityKind::Zone
        )
    }
}

/// Closed set of relationship kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RelationKind {
    LocatedIn,
    ObservedBy,
    Reported,
    DerivedFrom,
    AssignedTo,
    Generated,
    DependsOn,
    Violates,
    ApprovedBy,
    ExecutedBy,
    /// Two records determined to describe the same physical thing.
    SameAs,
    /// An incident is about an asset or zone.
    Concerns,
}

impl RelationKind {
    pub fn as_str(self) -> &'static str {
        match self {
            RelationKind::LocatedIn => "LOCATED_IN",
            RelationKind::ObservedBy => "OBSERVED_BY",
            RelationKind::Reported => "REPORTED",
            RelationKind::DerivedFrom => "DERIVED_FROM",
            RelationKind::AssignedTo => "ASSIGNED_TO",
            RelationKind::Generated => "GENERATED",
            RelationKind::DependsOn => "DEPENDS_ON",
            RelationKind::Violates => "VIOLATES",
            RelationKind::ApprovedBy => "APPROVED_BY",
            RelationKind::ExecutedBy => "EXECUTED_BY",
            RelationKind::SameAs => "SAME_AS",
            RelationKind::Concerns => "CONCERNS",
        }
    }

    pub fn parse(value: &str) -> Result<Self> {
        Ok(match value {
            "LOCATED_IN" => RelationKind::LocatedIn,
            "OBSERVED_BY" => RelationKind::ObservedBy,
            "REPORTED" => RelationKind::Reported,
            "DERIVED_FROM" => RelationKind::DerivedFrom,
            "ASSIGNED_TO" => RelationKind::AssignedTo,
            "GENERATED" => RelationKind::Generated,
            "DEPENDS_ON" => RelationKind::DependsOn,
            "VIOLATES" => RelationKind::Violates,
            "APPROVED_BY" => RelationKind::ApprovedBy,
            "EXECUTED_BY" => RelationKind::ExecutedBy,
            "SAME_AS" => RelationKind::SameAs,
            "CONCERNS" => RelationKind::Concerns,
            other => {
                return Err(NexusError::schema(format!(
                    "unknown relation kind '{other}'"
                )))
            }
        })
    }

    pub fn all() -> &'static [RelationKind] {
        &[
            RelationKind::LocatedIn,
            RelationKind::ObservedBy,
            RelationKind::Reported,
            RelationKind::DerivedFrom,
            RelationKind::AssignedTo,
            RelationKind::Generated,
            RelationKind::DependsOn,
            RelationKind::Violates,
            RelationKind::ApprovedBy,
            RelationKind::ExecutedBy,
            RelationKind::SameAs,
            RelationKind::Concerns,
        ]
    }

    /// Which `(from, to)` kind pairs are legal for this relationship.
    ///
    /// An empty list means "any pair". Enforced by `Relationship::validate`,
    /// so a malformed correlation cannot quietly create nonsense topology.
    pub fn allowed_endpoints(self) -> &'static [(EntityKind, EntityKind)] {
        match self {
            RelationKind::LocatedIn => &[
                (EntityKind::Asset, EntityKind::Zone),
                (EntityKind::Sensor, EntityKind::Zone),
                (EntityKind::Camera, EntityKind::Zone),
                (EntityKind::Robot, EntityKind::Zone),
                (EntityKind::Vehicle, EntityKind::Zone),
                (EntityKind::Zone, EntityKind::Facility),
            ],
            RelationKind::ObservedBy => &[
                (EntityKind::Observation, EntityKind::Sensor),
                (EntityKind::Observation, EntityKind::Camera),
                (EntityKind::Detection, EntityKind::Camera),
                (EntityKind::Detection, EntityKind::Sensor),
            ],
            RelationKind::Concerns => &[
                (EntityKind::Incident, EntityKind::Asset),
                (EntityKind::Incident, EntityKind::Zone),
                (EntityKind::Observation, EntityKind::Asset),
                (EntityKind::Detection, EntityKind::Asset),
            ],
            RelationKind::ExecutedBy => &[
                (EntityKind::Task, EntityKind::Robot),
                (EntityKind::Task, EntityKind::Vehicle),
            ],
            RelationKind::ApprovedBy => &[(EntityKind::Task, EntityKind::Operator)],
            RelationKind::Generated => &[
                (EntityKind::Sensor, EntityKind::Observation),
                (EntityKind::Camera, EntityKind::Detection),
                (EntityKind::Model, EntityKind::Detection),
                (EntityKind::Incident, EntityKind::Task),
            ],
            // Deliberately unconstrained: lineage and equivalence can link
            // any two records.
            RelationKind::DerivedFrom | RelationKind::SameAs => &[],
            _ => &[],
        }
    }
}

/// Where a fact came from. Every node and edge carries one.
#[derive(Debug, Clone, PartialEq)]
pub struct Provenance {
    /// The event that produced this fact.
    pub event_id: String,
    pub source_id: SourceId,
    pub trace_id: Option<TraceId>,
    /// Hash of the originating envelope, so a fact can be tied to bytes.
    pub source_integrity_hash: String,
    pub recorded_at: Timestamp,
    /// Which pipeline stage wrote it.
    pub producer: String,
    /// 0.0..=1.0. 1.0 means directly asserted by a trusted source.
    pub confidence: f64,
}

impl Provenance {
    pub fn asserted(
        event_id: impl Into<String>,
        source_id: SourceId,
        integrity_hash: impl Into<String>,
        producer: impl Into<String>,
        recorded_at: Timestamp,
    ) -> Self {
        Provenance {
            event_id: event_id.into(),
            source_id,
            trace_id: None,
            source_integrity_hash: integrity_hash.into(),
            recorded_at,
            producer: producer.into(),
            confidence: 1.0,
        }
    }

    pub fn with_trace(mut self, trace_id: TraceId) -> Self {
        self.trace_id = Some(trace_id);
        self
    }

    pub fn with_confidence(mut self, confidence: f64) -> Self {
        self.confidence = confidence.clamp(0.0, 1.0);
        self
    }

    pub fn validate(&self) -> Result<()> {
        if self.event_id.is_empty() {
            return Err(NexusError::invalid("provenance.event_id must not be empty"));
        }
        if self.producer.is_empty() {
            return Err(NexusError::invalid("provenance.producer must not be empty"));
        }
        if !self.confidence.is_finite() || !(0.0..=1.0).contains(&self.confidence) {
            return Err(NexusError::invalid(
                "provenance.confidence must be within 0.0..=1.0",
            ));
        }
        Ok(())
    }

    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("event_id", Value::string(&self.event_id)),
            ("source_id", Value::string(self.source_id.as_str())),
            (
                "trace_id",
                match &self.trace_id {
                    Some(id) => Value::string(id.as_str()),
                    None => Value::Null,
                },
            ),
            (
                "source_integrity_hash",
                Value::string(&self.source_integrity_hash),
            ),
            (
                "recorded_at",
                Value::number(self.recorded_at.as_millis() as f64),
            ),
            ("producer", Value::string(&self.producer)),
            ("confidence", Value::number(self.confidence)),
        ])
    }
}

/// A property value with its own validity interval.
///
/// Temporal facts are why the ontology can answer "what did we believe about
/// this asset at 14:03?" instead of only "what do we believe now".
#[derive(Debug, Clone, PartialEq)]
pub struct TemporalFact {
    pub value: Value,
    /// Inclusive.
    pub valid_from: Timestamp,
    /// Exclusive. `None` means still current.
    pub valid_to: Option<Timestamp>,
    pub provenance: Provenance,
}

impl TemporalFact {
    pub fn new(value: Value, valid_from: Timestamp, provenance: Provenance) -> Self {
        TemporalFact {
            value,
            valid_from,
            valid_to: None,
            provenance,
        }
    }

    pub fn is_valid_at(&self, at: Timestamp) -> bool {
        if at.is_before(self.valid_from) {
            return false;
        }
        match self.valid_to {
            Some(end) => at.is_before(end),
            None => true,
        }
    }

    pub fn close(&mut self, at: Timestamp) {
        self.valid_to = Some(at);
    }

    pub fn is_current(&self) -> bool {
        self.valid_to.is_none()
    }
}

/// A node in the ontology.
#[derive(Debug, Clone, PartialEq)]
pub struct Entity {
    pub id: EntityId,
    pub kind: EntityKind,
    /// Stable business key within the kind, e.g. `press-04`.
    pub natural_key: String,
    /// Current property values.
    pub properties: BTreeMap<String, Value>,
    /// Full history, including superseded values.
    pub history: Vec<(String, TemporalFact)>,
    pub provenance: Provenance,
    pub created_at: Timestamp,
    pub updated_at: Timestamp,
}

impl Entity {
    pub fn new(
        kind: EntityKind,
        natural_key: impl Into<String>,
        provenance: Provenance,
        at: Timestamp,
    ) -> Self {
        let natural_key = natural_key.into();
        Entity {
            id: EntityId::derive_from(&[kind.as_str(), &natural_key]),
            kind,
            natural_key,
            properties: BTreeMap::new(),
            history: Vec::new(),
            provenance,
            created_at: at,
            updated_at: at,
        }
    }

    pub fn with_property(mut self, key: &str, value: Value) -> Self {
        let fact = TemporalFact::new(value.clone(), self.created_at, self.provenance.clone());
        self.properties.insert(key.to_string(), value);
        self.history.push((key.to_string(), fact));
        self
    }

    /// Records a new value, closing the previous fact rather than discarding it.
    pub fn set_property(&mut self, key: &str, value: Value, at: Timestamp, provenance: Provenance) {
        for (existing_key, fact) in self.history.iter_mut() {
            if existing_key == key && fact.is_current() {
                fact.close(at);
            }
        }
        self.history.push((
            key.to_string(),
            TemporalFact::new(value.clone(), at, provenance),
        ));
        self.properties.insert(key.to_string(), value);
        self.updated_at = at;
    }

    /// What this property was believed to be at a point in time.
    pub fn property_at(&self, key: &str, at: Timestamp) -> Option<&Value> {
        self.history
            .iter()
            .filter(|(existing_key, fact)| existing_key == key && fact.is_valid_at(at))
            .map(|(_, fact)| &fact.value)
            .next_back()
    }

    pub fn validate(&self) -> Result<()> {
        if self.natural_key.is_empty() || self.natural_key.len() > 256 {
            return Err(NexusError::invalid(
                "entity natural_key must be 1..=256 characters",
            ));
        }
        self.provenance.validate()
    }

    pub fn to_json(&self) -> Value {
        let mut properties: BTreeMap<String, Value> = BTreeMap::new();
        for (key, value) in &self.properties {
            properties.insert(key.clone(), value.clone());
        }
        Value::object(vec![
            ("id", Value::string(self.id.as_str())),
            ("kind", Value::string(self.kind.as_str())),
            ("natural_key", Value::string(&self.natural_key)),
            ("properties", Value::Object(properties)),
            ("provenance", self.provenance.to_json()),
            (
                "created_at",
                Value::number(self.created_at.as_millis() as f64),
            ),
            (
                "updated_at",
                Value::number(self.updated_at.as_millis() as f64),
            ),
        ])
    }
}

/// An edge in the ontology.
#[derive(Debug, Clone, PartialEq)]
pub struct Relationship {
    pub kind: RelationKind,
    pub from: EntityId,
    pub from_kind: EntityKind,
    pub to: EntityId,
    pub to_kind: EntityKind,
    pub properties: BTreeMap<String, Value>,
    pub provenance: Provenance,
    pub valid_from: Timestamp,
    pub valid_to: Option<Timestamp>,
}

impl Relationship {
    pub fn new(
        kind: RelationKind,
        from: (&EntityId, EntityKind),
        to: (&EntityId, EntityKind),
        provenance: Provenance,
        at: Timestamp,
    ) -> Self {
        Relationship {
            kind,
            from: from.0.clone(),
            from_kind: from.1,
            to: to.0.clone(),
            to_kind: to.1,
            properties: BTreeMap::new(),
            provenance,
            valid_from: at,
            valid_to: None,
        }
    }

    pub fn with_property(mut self, key: &str, value: Value) -> Self {
        self.properties.insert(key.to_string(), value);
        self
    }

    /// Stable edge identity: same endpoints and kind means the same edge.
    pub fn edge_key(&self) -> String {
        format!(
            "{}|{}|{}",
            self.from.as_str(),
            self.kind.as_str(),
            self.to.as_str()
        )
    }

    pub fn validate(&self) -> Result<()> {
        if self.from == self.to && self.kind != RelationKind::DependsOn {
            return Err(NexusError::invalid(format!(
                "self-loop is not allowed for {}",
                self.kind.as_str()
            )));
        }
        let allowed = self.kind.allowed_endpoints();
        if !allowed.is_empty() && !allowed.contains(&(self.from_kind, self.to_kind)) {
            return Err(NexusError::invalid(format!(
                "{} may not connect {} to {}",
                self.kind.as_str(),
                self.from_kind.as_str(),
                self.to_kind.as_str()
            )));
        }
        self.provenance.validate()
    }

    pub fn is_valid_at(&self, at: Timestamp) -> bool {
        if at.is_before(self.valid_from) {
            return false;
        }
        match self.valid_to {
            Some(end) => at.is_before(end),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn provenance() -> Provenance {
        Provenance::asserted(
            "evt_1",
            SourceId::from_external("sensor-1"),
            "hash",
            "test",
            Timestamp::from_millis(1_000),
        )
    }

    #[test]
    fn entity_kind_set_is_closed_and_non_military() {
        for kind in EntityKind::all() {
            assert_eq!(EntityKind::parse(kind.as_str()).unwrap(), *kind);
        }
        for rejected in [
            "Target",
            "Threat",
            "Combatant",
            "Weapon",
            "PersonOfInterest",
        ] {
            assert!(
                EntityKind::parse(rejected).is_err(),
                "must reject {rejected}"
            );
        }
    }

    #[test]
    fn relation_kind_set_is_closed() {
        for kind in RelationKind::all() {
            assert_eq!(RelationKind::parse(kind.as_str()).unwrap(), *kind);
        }
        assert!(RelationKind::parse("ENGAGES").is_err());
    }

    #[test]
    fn entity_ids_are_derived_from_kind_and_natural_key() {
        let first = Entity::new(
            EntityKind::Asset,
            "press-04",
            provenance(),
            Timestamp::from_millis(1),
        );
        let second = Entity::new(
            EntityKind::Asset,
            "press-04",
            provenance(),
            Timestamp::from_millis(999),
        );
        assert_eq!(first.id, second.id);

        let different_kind = Entity::new(
            EntityKind::Robot,
            "press-04",
            provenance(),
            Timestamp::from_millis(1),
        );
        assert_ne!(first.id, different_kind.id);
    }

    #[test]
    fn superseded_property_values_stay_queryable() {
        let mut asset = Entity::new(
            EntityKind::Asset,
            "press-04",
            provenance(),
            Timestamp::from_millis(1_000),
        )
        .with_property("state", Value::string("running"));

        asset.set_property(
            "state",
            Value::string("stopped"),
            Timestamp::from_millis(5_000),
            provenance(),
        );

        assert_eq!(
            asset.properties.get("state"),
            Some(&Value::string("stopped"))
        );
        assert_eq!(
            asset.property_at("state", Timestamp::from_millis(2_000)),
            Some(&Value::string("running"))
        );
        assert_eq!(
            asset.property_at("state", Timestamp::from_millis(6_000)),
            Some(&Value::string("stopped"))
        );
        assert_eq!(asset.property_at("state", Timestamp::from_millis(10)), None);
    }

    #[test]
    fn relationships_enforce_endpoint_kinds() {
        let zone = Entity::new(
            EntityKind::Zone,
            "z1",
            provenance(),
            Timestamp::from_millis(1),
        );
        let asset = Entity::new(
            EntityKind::Asset,
            "a1",
            provenance(),
            Timestamp::from_millis(1),
        );
        let operator = Entity::new(
            EntityKind::Operator,
            "op1",
            provenance(),
            Timestamp::from_millis(1),
        );

        let valid = Relationship::new(
            RelationKind::LocatedIn,
            (&asset.id, EntityKind::Asset),
            (&zone.id, EntityKind::Zone),
            provenance(),
            Timestamp::from_millis(1),
        );
        assert!(valid.validate().is_ok());

        let invalid = Relationship::new(
            RelationKind::LocatedIn,
            (&operator.id, EntityKind::Operator),
            (&asset.id, EntityKind::Asset),
            provenance(),
            Timestamp::from_millis(1),
        );
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn self_loops_are_rejected_except_for_dependencies() {
        let asset = Entity::new(
            EntityKind::Asset,
            "a1",
            provenance(),
            Timestamp::from_millis(1),
        );
        let loop_edge = Relationship::new(
            RelationKind::LocatedIn,
            (&asset.id, EntityKind::Asset),
            (&asset.id, EntityKind::Asset),
            provenance(),
            Timestamp::from_millis(1),
        );
        assert!(loop_edge.validate().is_err());
    }

    #[test]
    fn provenance_confidence_is_bounded() {
        let bounded = provenance().with_confidence(5.0);
        assert_eq!(bounded.confidence, 1.0);
        let mut invalid = provenance();
        invalid.confidence = f64::NAN;
        assert!(invalid.validate().is_err());
    }

    #[test]
    fn temporal_fact_intervals_are_half_open() {
        let mut fact = TemporalFact::new(
            Value::number(1.0),
            Timestamp::from_millis(100),
            provenance(),
        );
        fact.close(Timestamp::from_millis(200));
        assert!(!fact.is_valid_at(Timestamp::from_millis(99)));
        assert!(fact.is_valid_at(Timestamp::from_millis(100)));
        assert!(fact.is_valid_at(Timestamp::from_millis(199)));
        assert!(!fact.is_valid_at(Timestamp::from_millis(200)));
    }
}
