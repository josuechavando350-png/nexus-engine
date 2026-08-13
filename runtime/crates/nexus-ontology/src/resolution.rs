//! Entity resolution.
//!
//! ```text
//! Raw event -> normalize -> candidates -> resolve -> enrich -> mutations -> commit
//! ```
//!
//! ## No theatrical ML
//!
//! There is no learned matcher here and none is implied. Matching is a set of
//! named deterministic rules, each with a fixed weight, and every decision
//! carries the list of rules that fired. A human can read a merge audit
//! record and reconstruct exactly why two records were joined.
//!
//! If a learned matcher is introduced later it plugs in as an additional
//! [`MatchRule`] with its own name and weight, and the audit record will say
//! which rule contributed what. The interface is designed so that adding one
//! does not make the decision unexplainable.

use crate::model::{Entity, EntityKind, Provenance, RelationKind, Relationship};
use crate::store::GraphMutation;
use nexus_event::json::Value;
use nexus_event::{
    Detection, EntityId, EventEnvelope, NexusError, Result, SourceId, Timestamp, TraceId,
};

/// Confidence at or above which two records are merged automatically.
pub const AUTO_MERGE_THRESHOLD: f64 = 0.90;
/// Confidence at or above which a merge is proposed for human review.
pub const REVIEW_THRESHOLD: f64 = 0.60;

/// A named deterministic matching rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MatchRule {
    /// Identical natural key within the same entity kind.
    ExactNaturalKey,
    /// Same manufacturer serial number property.
    SerialNumber,
    /// Same network identity (MAC, device id) property.
    DeviceIdentity,
    /// Same asset tag reported by different sources.
    AssetTag,
    /// Co-located in the same zone and reporting the same stream.
    ZoneAndStream,
    /// Natural keys equal after normalization (case, separators, padding).
    NormalizedNaturalKey,
}

impl MatchRule {
    pub fn as_str(self) -> &'static str {
        match self {
            MatchRule::ExactNaturalKey => "exact_natural_key",
            MatchRule::SerialNumber => "serial_number",
            MatchRule::DeviceIdentity => "device_identity",
            MatchRule::AssetTag => "asset_tag",
            MatchRule::ZoneAndStream => "zone_and_stream",
            MatchRule::NormalizedNaturalKey => "normalized_natural_key",
        }
    }

    /// Fixed weight. Weights are documented constants, not tuned parameters.
    pub fn weight(self) -> f64 {
        match self {
            MatchRule::ExactNaturalKey => 1.00,
            MatchRule::SerialNumber => 0.95,
            MatchRule::DeviceIdentity => 0.90,
            MatchRule::AssetTag => 0.80,
            MatchRule::NormalizedNaturalKey => 0.70,
            // Weak on its own: two sensors in one zone are not one sensor.
            MatchRule::ZoneAndStream => 0.30,
        }
    }
}

/// Outcome of comparing an incoming record against a stored candidate.
#[derive(Debug, Clone, PartialEq)]
pub struct MatchScore {
    pub candidate: EntityId,
    pub confidence: f64,
    pub fired_rules: Vec<MatchRule>,
}

impl MatchScore {
    pub fn explanation(&self) -> String {
        if self.fired_rules.is_empty() {
            return "no rule fired".to_string();
        }
        let parts: Vec<String> = self
            .fired_rules
            .iter()
            .map(|rule| format!("{}({:.2})", rule.as_str(), rule.weight()))
            .collect();
        parts.join(" + ")
    }
}

/// What resolution decided.
#[derive(Debug, Clone, PartialEq)]
pub enum ResolutionOutcome {
    /// No existing entity matched; a new one was created.
    Created(EntityId),
    /// Matched an existing entity with sufficient confidence.
    Matched {
        entity_id: EntityId,
        score: MatchScore,
    },
    /// Matched with middling confidence: recorded, flagged, not merged.
    NeedsReview {
        candidate: EntityId,
        score: MatchScore,
    },
    /// Two candidates matched equally well; resolution refused to guess.
    Ambiguous { candidates: Vec<MatchScore> },
}

impl ResolutionOutcome {
    pub fn as_str(&self) -> &'static str {
        match self {
            ResolutionOutcome::Created(_) => "created",
            ResolutionOutcome::Matched { .. } => "matched",
            ResolutionOutcome::NeedsReview { .. } => "needs_review",
            ResolutionOutcome::Ambiguous { .. } => "ambiguous",
        }
    }

    pub fn resolved_id(&self) -> Option<&EntityId> {
        match self {
            ResolutionOutcome::Created(id) => Some(id),
            ResolutionOutcome::Matched { entity_id, .. } => Some(entity_id),
            ResolutionOutcome::NeedsReview { candidate, .. } => Some(candidate),
            ResolutionOutcome::Ambiguous { .. } => None,
        }
    }
}

/// Audit record for a merge decision, written to the audit trail.
#[derive(Debug, Clone, PartialEq)]
pub struct MergeAudit {
    pub canonical: EntityId,
    pub duplicate: EntityId,
    pub confidence: f64,
    pub fired_rules: Vec<MatchRule>,
    pub rationale: String,
    pub decided_at: Timestamp,
    /// Property values that differed between the two records.
    pub conflicts: Vec<PropertyConflict>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct PropertyConflict {
    pub key: String,
    pub canonical_value: Value,
    pub duplicate_value: Value,
    pub winner: ConflictWinner,
    pub reason: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictWinner {
    Canonical,
    Duplicate,
    /// Neither could be preferred; both retained as temporal facts.
    BothRetained,
}

/// Result of normalizing a raw envelope into ontology candidates.
#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedRecord {
    pub kind: EntityKind,
    pub natural_key: String,
    pub properties: Vec<(String, Value)>,
    pub zone_hint: Option<String>,
    pub observed_at: Timestamp,
    pub provenance: Provenance,
}

/// Normalizes a telemetry envelope into a record the ontology can resolve.
///
/// Rejects rather than guesses: an envelope without an identifiable subject
/// produces an error, which sends the event to the dead-letter topic where a
/// human can look at it.
pub fn normalize_telemetry(envelope: &EventEnvelope) -> Result<NormalizedRecord> {
    envelope.validate()?;

    let asset_key = envelope
        .payload
        .get("asset")
        .and_then(Value::as_str)
        .ok_or_else(|| NexusError::schema("telemetry payload must name an 'asset'"))?;

    if asset_key.trim().is_empty() {
        return Err(NexusError::schema("telemetry 'asset' must not be blank"));
    }

    let mut properties = Vec::new();
    if let Value::Object(map) = &envelope.payload {
        for (key, value) in map {
            if key == "asset" {
                continue;
            }
            properties.push((key.clone(), value.clone()));
        }
    }
    properties.push(("last_stream".to_string(), Value::string(&envelope.stream)));

    let provenance = Provenance::asserted(
        envelope.event_id.as_str(),
        envelope.source_id.clone(),
        &envelope.integrity_hash,
        "nexus-ontology/normalize_telemetry",
        envelope.ingested_at,
    )
    .with_trace(envelope.trace_id.clone());

    Ok(NormalizedRecord {
        kind: EntityKind::Asset,
        natural_key: normalize_key(asset_key),
        properties,
        zone_hint: envelope
            .payload
            .get("zone")
            .and_then(Value::as_str)
            .map(normalize_key),
        observed_at: envelope.occurred_at,
        provenance,
    })
}

/// Normalizes an external detection into a record.
pub fn normalize_detection(
    detection: &Detection,
    trace_id: Option<&TraceId>,
    integrity_hash: &str,
) -> Result<NormalizedRecord> {
    detection.validate()?;

    let subject = detection
        .subject_hint
        .as_deref()
        .ok_or_else(|| NexusError::schema("detection must carry a subject_hint to be resolved"))?;

    let mut provenance = Provenance::asserted(
        detection.frame_id.clone(),
        detection.source_sensor.clone(),
        integrity_hash,
        "nexus-ontology/normalize_detection",
        detection.timestamp,
    )
    .with_confidence(detection.confidence);
    if let Some(trace_id) = trace_id {
        provenance = provenance.with_trace(trace_id.clone());
    }

    Ok(NormalizedRecord {
        kind: EntityKind::Asset,
        natural_key: normalize_key(subject),
        properties: vec![
            (
                "last_detection_class".into(),
                Value::string(detection.class.as_str()),
            ),
            (
                "last_detection_confidence".into(),
                Value::number(detection.confidence),
            ),
            (
                "last_detection_model".into(),
                Value::string(&detection.model_id),
            ),
        ],
        zone_hint: None,
        observed_at: detection.timestamp,
        provenance,
    })
}

/// Canonical form of a natural key: lowercase, trimmed, separators unified,
/// numeric segments stripped of leading zeros.
///
/// `Press_04`, `PRESS-4` and ` press 04 ` all become `press-4`.
pub fn normalize_key(raw: &str) -> String {
    let lowered = raw.trim().to_ascii_lowercase();
    let unified: String = lowered
        .chars()
        .map(|c| {
            if c == '_' || c == ' ' || c == '.' {
                '-'
            } else {
                c
            }
        })
        .collect();

    unified
        .split('-')
        .filter(|segment| !segment.is_empty())
        .map(|segment| {
            if segment.chars().all(|c| c.is_ascii_digit()) {
                let trimmed = segment.trim_start_matches('0');
                if trimmed.is_empty() {
                    "0".to_string()
                } else {
                    trimmed.to_string()
                }
            } else {
                segment.to_string()
            }
        })
        .collect::<Vec<String>>()
        .join("-")
}

/// Scores an incoming record against one stored candidate.
pub fn score_candidate(record: &NormalizedRecord, candidate: &Entity) -> MatchScore {
    let mut fired = Vec::new();

    if candidate.kind == record.kind {
        if candidate.natural_key == record.natural_key {
            fired.push(MatchRule::ExactNaturalKey);
        } else if normalize_key(&candidate.natural_key) == normalize_key(&record.natural_key) {
            fired.push(MatchRule::NormalizedNaturalKey);
        }
    }

    for (key, rule) in [
        ("serial_number", MatchRule::SerialNumber),
        ("device_id", MatchRule::DeviceIdentity),
        ("asset_tag", MatchRule::AssetTag),
    ] {
        let incoming = record
            .properties
            .iter()
            .find(|(property_key, _)| property_key == key)
            .map(|(_, value)| value);
        if let (Some(incoming), Some(stored)) = (incoming, candidate.properties.get(key)) {
            if incoming == stored && incoming != &Value::Null {
                fired.push(rule);
            }
        }
    }

    if let (Some(zone), Some(stored_zone)) = (
        record.zone_hint.as_ref(),
        candidate.properties.get("zone").and_then(Value::as_str),
    ) {
        if normalize_key(zone) == normalize_key(stored_zone) {
            fired.push(MatchRule::ZoneAndStream);
        }
    }

    // Combine with a noisy-or so that several weak signals cannot be added up
    // into a false certainty, and one strong signal is enough.
    let mut complement = 1.0f64;
    for rule in &fired {
        complement *= 1.0 - rule.weight();
    }
    let confidence = if fired.is_empty() {
        0.0
    } else {
        1.0 - complement
    };

    MatchScore {
        candidate: candidate.id.clone(),
        confidence,
        fired_rules: fired,
    }
}

/// Resolves a record against a candidate set.
pub fn resolve(record: &NormalizedRecord, candidates: &[Entity]) -> ResolutionOutcome {
    let mut scores: Vec<MatchScore> = candidates
        .iter()
        .map(|candidate| score_candidate(record, candidate))
        .filter(|score| score.confidence > 0.0)
        .collect();

    scores.sort_by(|a, b| {
        b.confidence
            .partial_cmp(&a.confidence)
            .unwrap_or(std::cmp::Ordering::Equal)
            // Stable tiebreak so replay is deterministic.
            .then_with(|| a.candidate.as_str().cmp(b.candidate.as_str()))
    });

    let best = match scores.first() {
        None => {
            let id = EntityId::derive_from(&[record.kind.as_str(), &record.natural_key]);
            return ResolutionOutcome::Created(id);
        }
        Some(best) => best.clone(),
    };

    // Refuse to guess between equally good candidates.
    if let Some(second) = scores.get(1) {
        if (best.confidence - second.confidence).abs() < 1e-9 && best.confidence >= REVIEW_THRESHOLD
        {
            return ResolutionOutcome::Ambiguous {
                candidates: scores.into_iter().take(4).collect(),
            };
        }
    }

    if best.confidence >= AUTO_MERGE_THRESHOLD {
        ResolutionOutcome::Matched {
            entity_id: best.candidate.clone(),
            score: best,
        }
    } else if best.confidence >= REVIEW_THRESHOLD {
        ResolutionOutcome::NeedsReview {
            candidate: best.candidate.clone(),
            score: best,
        }
    } else {
        let id = EntityId::derive_from(&[record.kind.as_str(), &record.natural_key]);
        ResolutionOutcome::Created(id)
    }
}

/// Deterministic conflict resolution between two property values.
///
/// Rules, in order:
/// 1. Higher provenance confidence wins.
/// 2. If equal, the more recent observation wins.
/// 3. If still equal, both are retained as temporal facts and the conflict is
///    reported. Nothing is silently discarded.
pub fn resolve_conflict(
    key: &str,
    canonical_value: &Value,
    canonical_confidence: f64,
    canonical_at: Timestamp,
    duplicate_value: &Value,
    duplicate_confidence: f64,
    duplicate_at: Timestamp,
) -> PropertyConflict {
    let (winner, reason) = if canonical_value == duplicate_value {
        (ConflictWinner::Canonical, "values agree".to_string())
    } else if canonical_confidence > duplicate_confidence {
        (
            ConflictWinner::Canonical,
            format!(
                "higher provenance confidence ({canonical_confidence:.2} > {duplicate_confidence:.2})"
            ),
        )
    } else if duplicate_confidence > canonical_confidence {
        (
            ConflictWinner::Duplicate,
            format!(
                "higher provenance confidence ({duplicate_confidence:.2} > {canonical_confidence:.2})"
            ),
        )
    } else if canonical_at.as_millis() > duplicate_at.as_millis() {
        (ConflictWinner::Canonical, "more recent observation".into())
    } else if duplicate_at.as_millis() > canonical_at.as_millis() {
        (ConflictWinner::Duplicate, "more recent observation".into())
    } else {
        (
            ConflictWinner::BothRetained,
            "equal confidence and timestamp; retained as concurrent facts".into(),
        )
    };

    PropertyConflict {
        key: key.to_string(),
        canonical_value: canonical_value.clone(),
        duplicate_value: duplicate_value.clone(),
        winner,
        reason,
    }
}

/// Turns a resolved record into the mutations that commit it.
pub fn to_mutations(
    record: &NormalizedRecord,
    outcome: &ResolutionOutcome,
    zone_entity: Option<&Entity>,
) -> Result<Vec<GraphMutation>> {
    let entity_id = match outcome.resolved_id() {
        Some(id) => id.clone(),
        None => {
            return Err(NexusError::invalid(
                "ambiguous resolution cannot be committed without review",
            ))
        }
    };

    let mut entity = Entity::new(
        record.kind,
        record.natural_key.clone(),
        record.provenance.clone(),
        record.observed_at,
    );
    // Preserve the resolved identity rather than the derived one, so a match
    // against an existing entity updates it instead of forking it.
    entity.id = entity_id.clone();
    for (key, value) in &record.properties {
        entity.set_property(
            key,
            value.clone(),
            record.observed_at,
            record.provenance.clone(),
        );
    }
    if let Some(zone) = &record.zone_hint {
        entity.set_property(
            "zone",
            Value::string(zone),
            record.observed_at,
            record.provenance.clone(),
        );
    }

    let mut mutations = vec![GraphMutation::UpsertEntity(entity.clone())];

    if let Some(zone) = zone_entity {
        let relationship = Relationship::new(
            RelationKind::LocatedIn,
            (&entity.id, record.kind),
            (&zone.id, EntityKind::Zone),
            record.provenance.clone(),
            record.observed_at,
        );
        relationship.validate()?;
        mutations.push(GraphMutation::UpsertRelationship(relationship));
    }

    if let ResolutionOutcome::Matched { score, .. } = outcome {
        let derived = EntityId::derive_from(&[record.kind.as_str(), &record.natural_key]);
        if derived != entity_id {
            mutations.push(GraphMutation::MergeEntities {
                canonical: entity_id,
                duplicate: derived,
                confidence: score.confidence,
                rationale: score.explanation(),
            });
        }
    }

    Ok(mutations)
}

/// Convenience: the full pipeline for one telemetry envelope.
pub fn pipeline_for_telemetry(
    envelope: &EventEnvelope,
    candidates: &[Entity],
    zone_entity: Option<&Entity>,
) -> Result<(NormalizedRecord, ResolutionOutcome, Vec<GraphMutation>)> {
    let record = normalize_telemetry(envelope)?;
    let outcome = resolve(&record, candidates);
    let mutations = to_mutations(&record, &outcome, zone_entity)?;
    Ok((record, outcome, mutations))
}

/// Builds the merge audit record for a decided merge.
pub fn merge_audit(
    canonical: &Entity,
    duplicate: &Entity,
    score: &MatchScore,
    at: Timestamp,
) -> MergeAudit {
    let mut conflicts = Vec::new();
    for (key, canonical_value) in &canonical.properties {
        if let Some(duplicate_value) = duplicate.properties.get(key) {
            if canonical_value != duplicate_value {
                conflicts.push(resolve_conflict(
                    key,
                    canonical_value,
                    canonical.provenance.confidence,
                    canonical.updated_at,
                    duplicate_value,
                    duplicate.provenance.confidence,
                    duplicate.updated_at,
                ));
            }
        }
    }

    MergeAudit {
        canonical: canonical.id.clone(),
        duplicate: duplicate.id.clone(),
        confidence: score.confidence,
        fired_rules: score.fired_rules.clone(),
        rationale: score.explanation(),
        decided_at: at,
        conflicts,
    }
}

/// Helper used by services to build a provenance record from an envelope.
pub fn provenance_from(envelope: &EventEnvelope, producer: &str) -> Provenance {
    Provenance::asserted(
        envelope.event_id.as_str(),
        SourceId::from_external(envelope.source_id.as_str()),
        &envelope.integrity_hash,
        producer,
        envelope.ingested_at,
    )
    .with_trace(envelope.trace_id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_event::envelope::SourceType;

    fn envelope(asset: &str, celsius: f64) -> EventEnvelope {
        EventEnvelope::builder(
            SourceId::from_external("temp-17"),
            SourceType::Sensor,
            "telemetry.temperature",
            Value::object(vec![
                ("asset", Value::string(asset)),
                ("celsius", Value::number(celsius)),
                ("zone", Value::string("Zone_Press Hall")),
            ]),
        )
        .occurred_at(Timestamp::from_millis(1_700_000_000_000))
        .sequence(1)
        .build()
    }

    fn stored(natural_key: &str, properties: Vec<(&str, Value)>) -> Entity {
        let mut entity = Entity::new(
            EntityKind::Asset,
            natural_key,
            Provenance::asserted(
                "evt_seed",
                SourceId::from_external("seed"),
                "hash",
                "seed",
                Timestamp::from_millis(1),
            ),
            Timestamp::from_millis(1),
        );
        for (key, value) in properties {
            entity.properties.insert(key.to_string(), value);
        }
        entity
    }

    #[test]
    fn key_normalization_is_idempotent_and_forgiving() {
        assert_eq!(normalize_key("Press_04"), "press-4");
        assert_eq!(normalize_key("PRESS-4"), "press-4");
        assert_eq!(normalize_key("  press 04 "), "press-4");
        assert_eq!(normalize_key("press-004"), "press-4");
        assert_eq!(normalize_key(normalize_key("Press_04").as_str()), "press-4");
        assert_eq!(normalize_key("press-000"), "press-0");
    }

    #[test]
    fn normalization_rejects_telemetry_without_a_subject() {
        let anonymous = EventEnvelope::builder(
            SourceId::from_external("t"),
            SourceType::Sensor,
            "telemetry.temperature",
            Value::object(vec![("celsius", Value::number(20.0))]),
        )
        .occurred_at(Timestamp::from_millis(1_700_000_000_000))
        .build();
        assert!(normalize_telemetry(&anonymous).is_err());
    }

    #[test]
    fn unknown_asset_produces_a_created_outcome() {
        let record = normalize_telemetry(&envelope("press-04", 91.0)).unwrap();
        let outcome = resolve(&record, &[]);
        assert_eq!(outcome.as_str(), "created");
    }

    #[test]
    fn exact_natural_key_matches_with_full_confidence() {
        let record = normalize_telemetry(&envelope("press-04", 91.0)).unwrap();
        let candidate = stored("press-4", vec![]);
        let outcome = resolve(&record, &[candidate]);
        match outcome {
            ResolutionOutcome::Matched { score, .. } => {
                assert!(score.confidence >= AUTO_MERGE_THRESHOLD);
                assert!(score.fired_rules.contains(&MatchRule::ExactNaturalKey));
            }
            other => panic!("expected a match, got {other:?}"),
        }
    }

    #[test]
    fn weak_signals_alone_do_not_reach_the_merge_threshold() {
        let record = normalize_telemetry(&envelope("unknown-asset", 20.0)).unwrap();
        let candidate = stored("press-4", vec![("zone", Value::string("zone-press-hall"))]);
        let score = score_candidate(&record, &candidate);
        assert!(score.fired_rules.contains(&MatchRule::ZoneAndStream));
        assert!(score.confidence < REVIEW_THRESHOLD, "{score:?}");
    }

    #[test]
    fn serial_number_matches_across_different_natural_keys() {
        let mut record = normalize_telemetry(&envelope("press-4-north", 20.0)).unwrap();
        record
            .properties
            .push(("serial_number".into(), Value::string("SN-99")));
        let candidate = stored("press-4", vec![("serial_number", Value::string("SN-99"))]);
        let score = score_candidate(&record, &candidate);
        assert!(score.fired_rules.contains(&MatchRule::SerialNumber));
        assert!(score.confidence >= AUTO_MERGE_THRESHOLD);
    }

    #[test]
    fn two_equally_good_candidates_produce_ambiguous_not_a_guess() {
        let record = normalize_telemetry(&envelope("press-04", 91.0)).unwrap();
        let mut first = stored("press-4", vec![]);
        let mut second = stored("press-4", vec![]);
        first.id = EntityId::from_external("ent_first");
        second.id = EntityId::from_external("ent_second");
        let outcome = resolve(&record, &[first, second]);
        assert_eq!(outcome.as_str(), "ambiguous");
        assert!(outcome.resolved_id().is_none());
        assert!(to_mutations(&record, &outcome, None).is_err());
    }

    #[test]
    fn resolution_is_deterministic_under_candidate_reordering() {
        let mut record = normalize_telemetry(&envelope("press-04", 91.0)).unwrap();
        record
            .properties
            .push(("serial_number".into(), Value::string("SN-1")));
        let strong = stored("press-4", vec![("serial_number", Value::string("SN-1"))]);
        let weak = stored(
            "other-asset",
            vec![("zone", Value::string("zone-press-hall"))],
        );

        let forward = resolve(&record, &[strong.clone(), weak.clone()]);
        let backward = resolve(&record, &[weak, strong]);
        assert_eq!(forward, backward);
    }

    #[test]
    fn conflict_resolution_prefers_confidence_then_recency() {
        let higher_confidence = resolve_conflict(
            "state",
            &Value::string("running"),
            0.9,
            Timestamp::from_millis(10),
            &Value::string("stopped"),
            0.4,
            Timestamp::from_millis(100),
        );
        assert_eq!(higher_confidence.winner, ConflictWinner::Canonical);

        let more_recent = resolve_conflict(
            "state",
            &Value::string("running"),
            0.5,
            Timestamp::from_millis(10),
            &Value::string("stopped"),
            0.5,
            Timestamp::from_millis(100),
        );
        assert_eq!(more_recent.winner, ConflictWinner::Duplicate);

        let tie = resolve_conflict(
            "state",
            &Value::string("running"),
            0.5,
            Timestamp::from_millis(10),
            &Value::string("stopped"),
            0.5,
            Timestamp::from_millis(10),
        );
        assert_eq!(tie.winner, ConflictWinner::BothRetained);
    }

    #[test]
    fn pipeline_produces_committable_mutations_with_provenance() {
        let event = envelope("press-04", 91.0);
        let (record, outcome, mutations) = pipeline_for_telemetry(&event, &[], None).unwrap();
        assert_eq!(outcome.as_str(), "created");
        assert_eq!(mutations.len(), 1);
        match &mutations[0] {
            GraphMutation::UpsertEntity(entity) => {
                assert_eq!(entity.natural_key, "press-4");
                assert_eq!(entity.provenance.event_id, event.event_id.as_str());
                assert_eq!(
                    entity.provenance.source_integrity_hash,
                    event.integrity_hash
                );
                assert!(entity.properties.contains_key("celsius"));
            }
            other => panic!("unexpected mutation {other:?}"),
        }
        assert_eq!(record.zone_hint.as_deref(), Some("zone-press-hall"));
    }

    #[test]
    fn merge_audit_lists_the_rules_that_fired_and_the_conflicts() {
        let canonical = stored("press-4", vec![("state", Value::string("running"))]);
        let duplicate = stored("press-04", vec![("state", Value::string("stopped"))]);
        let score = MatchScore {
            candidate: canonical.id.clone(),
            confidence: 0.95,
            fired_rules: vec![MatchRule::NormalizedNaturalKey, MatchRule::SerialNumber],
        };
        let audit = merge_audit(&canonical, &duplicate, &score, Timestamp::from_millis(5));
        assert_eq!(audit.conflicts.len(), 1);
        assert!(audit.rationale.contains("normalized_natural_key"));
        assert!(audit.rationale.contains("serial_number"));
    }

    #[test]
    fn detection_without_a_subject_is_not_silently_attached() {
        let detection = Detection {
            model_id: "m".into(),
            frame_id: "f".into(),
            class: nexus_event::DetectionClass::Smoke,
            confidence: 0.9,
            bbox: None,
            timestamp: Timestamp::from_millis(1_700_000_000_000),
            source_sensor: SourceId::from_external("cam-1"),
            subject_hint: None,
            trace_id: None,
        };
        assert!(normalize_detection(&detection, None, "hash").is_err());
    }
}
