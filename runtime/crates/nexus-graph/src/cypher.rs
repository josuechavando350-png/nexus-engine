//! Cypher statement generation for Neo4j and Memgraph.
//!
//! Kept as pure string+parameter construction, separate from any driver, for
//! three reasons: the statements are unit-testable without a database, the
//! `neo4j` feature can be off without losing them, and a reviewer can read
//! exactly what will run against the graph.
//!
//! ## Injection
//!
//! Every user-controlled value is a **parameter**, never interpolated. Labels
//! and relationship types cannot be parameterised in Cypher, so they are
//! taken exclusively from the closed `EntityKind` / `RelationKind` enums and
//! additionally validated by [`safe_label`] before they reach a statement.

use nexus_event::json::Value;
use nexus_event::{NexusError, Result};
use nexus_ontology::model::{Entity, EntityKind, RelationKind, Relationship};
use nexus_ontology::store::GraphMutation;
use std::collections::BTreeMap;

/// A statement plus its parameters.
#[derive(Debug, Clone, PartialEq)]
pub struct CypherStatement {
    pub query: String,
    pub parameters: BTreeMap<String, Value>,
}

impl CypherStatement {
    pub fn new(query: impl Into<String>) -> Self {
        CypherStatement {
            query: query.into(),
            parameters: BTreeMap::new(),
        }
    }

    pub fn param(mut self, key: &str, value: Value) -> Self {
        self.parameters.insert(key.to_string(), value);
        self
    }
}

/// Rejects anything that is not a plain identifier.
///
/// Belt and braces: the enums already guarantee this, but a future addition
/// to the enum with a hostile string would otherwise flow straight into a
/// query.
pub fn safe_label(label: &str) -> Result<&str> {
    let acceptable = !label.is_empty()
        && label.len() <= 64
        && label
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_');
    if acceptable {
        Ok(label)
    } else {
        Err(NexusError::invalid(format!(
            "unsafe label or relationship type '{label}'"
        )))
    }
}

fn properties_to_value(entity: &Entity) -> Value {
    let mut map: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in &entity.properties {
        map.insert(key.clone(), value.clone());
    }
    Value::Object(map)
}

/// Schema statements: uniqueness constraints and lookup indexes.
///
/// Idempotent (`IF NOT EXISTS`), so they can run at every service start.
pub fn schema_statements() -> Vec<CypherStatement> {
    let mut statements = Vec::new();
    for kind in EntityKind::all() {
        let label = kind.as_str();
        statements.push(CypherStatement::new(format!(
            "CREATE CONSTRAINT nexus_{}_id IF NOT EXISTS \
             FOR (n:{label}) REQUIRE n.id IS UNIQUE",
            label.to_ascii_lowercase()
        )));
        statements.push(CypherStatement::new(format!(
            "CREATE INDEX nexus_{}_natural_key IF NOT EXISTS \
             FOR (n:{label}) ON (n.natural_key)",
            label.to_ascii_lowercase()
        )));
    }
    statements
}

/// Upserts a node, preserving `created_at` and every provenance field.
pub fn upsert_entity(entity: &Entity) -> Result<CypherStatement> {
    let label = safe_label(entity.kind.as_str())?;
    let query = format!(
        "MERGE (n:{label} {{ id: $id }})
ON CREATE SET n.created_at = $created_at,
              n.natural_key = $natural_key,
              n.kind = $kind
SET n.updated_at = $updated_at,
    n.natural_key = $natural_key,
    n += $properties,
    n.provenance_event_id = $provenance_event_id,
    n.provenance_source_id = $provenance_source_id,
    n.provenance_hash = $provenance_hash,
    n.provenance_producer = $provenance_producer,
    n.provenance_confidence = $provenance_confidence
RETURN n.id AS id"
    );

    Ok(CypherStatement::new(query)
        .param("id", Value::string(entity.id.as_str()))
        .param("kind", Value::string(entity.kind.as_str()))
        .param("natural_key", Value::string(&entity.natural_key))
        .param(
            "created_at",
            Value::number(entity.created_at.as_millis() as f64),
        )
        .param(
            "updated_at",
            Value::number(entity.updated_at.as_millis() as f64),
        )
        .param("properties", properties_to_value(entity))
        .param(
            "provenance_event_id",
            Value::string(&entity.provenance.event_id),
        )
        .param(
            "provenance_source_id",
            Value::string(entity.provenance.source_id.as_str()),
        )
        .param(
            "provenance_hash",
            Value::string(&entity.provenance.source_integrity_hash),
        )
        .param(
            "provenance_producer",
            Value::string(&entity.provenance.producer),
        )
        .param(
            "provenance_confidence",
            Value::number(entity.provenance.confidence),
        ))
}

/// Upserts a relationship between two existing nodes.
pub fn upsert_relationship(relationship: &Relationship) -> Result<CypherStatement> {
    let relation = safe_label(relationship.kind.as_str())?;
    let from_label = safe_label(relationship.from_kind.as_str())?;
    let to_label = safe_label(relationship.to_kind.as_str())?;

    let mut properties: BTreeMap<String, Value> = BTreeMap::new();
    for (key, value) in &relationship.properties {
        properties.insert(key.clone(), value.clone());
    }

    let query = format!(
        "MATCH (a:{from_label} {{ id: $from }})
MATCH (b:{to_label} {{ id: $to }})
MERGE (a)-[r:{relation}]->(b)
ON CREATE SET r.valid_from = $valid_from
SET r += $properties,
    r.valid_to = $valid_to,
    r.provenance_event_id = $provenance_event_id,
    r.provenance_producer = $provenance_producer,
    r.provenance_confidence = $provenance_confidence
RETURN type(r) AS relation"
    );

    Ok(CypherStatement::new(query)
        .param("from", Value::string(relationship.from.as_str()))
        .param("to", Value::string(relationship.to.as_str()))
        .param(
            "valid_from",
            Value::number(relationship.valid_from.as_millis() as f64),
        )
        .param(
            "valid_to",
            match relationship.valid_to {
                Some(at) => Value::number(at.as_millis() as f64),
                None => Value::Null,
            },
        )
        .param("properties", Value::Object(properties))
        .param(
            "provenance_event_id",
            Value::string(&relationship.provenance.event_id),
        )
        .param(
            "provenance_producer",
            Value::string(&relationship.provenance.producer),
        )
        .param(
            "provenance_confidence",
            Value::number(relationship.provenance.confidence),
        ))
}

/// Closes a relationship's validity interval. Never deletes.
pub fn close_relationship(
    from: &str,
    kind: RelationKind,
    to: &str,
    at_millis: i64,
) -> Result<CypherStatement> {
    let relation = safe_label(kind.as_str())?;
    let query = format!(
        "MATCH (a {{ id: $from }})-[r:{relation}]->(b {{ id: $to }})
WHERE r.valid_to IS NULL
SET r.valid_to = $at
RETURN count(r) AS closed"
    );
    Ok(CypherStatement::new(query)
        .param("from", Value::string(from))
        .param("to", Value::string(to))
        .param("at", Value::number(at_millis as f64)))
}

/// Records a merge as a SAME_AS edge rather than destroying the duplicate.
///
/// Destructive merges lose the evidence that a merge happened, which makes an
/// incorrect resolution impossible to unwind. The read path follows SAME_AS.
pub fn merge_entities(
    canonical: &str,
    duplicate: &str,
    confidence: f64,
    rationale: &str,
) -> CypherStatement {
    let query = "MATCH (canonical { id: $canonical })
MATCH (duplicate { id: $duplicate })
MERGE (duplicate)-[r:SAME_AS]->(canonical)
SET r.confidence = $confidence,
    r.rationale = $rationale,
    duplicate.merged_into = $canonical
RETURN r.confidence AS confidence";
    CypherStatement::new(query)
        .param("canonical", Value::string(canonical))
        .param("duplicate", Value::string(duplicate))
        .param("confidence", Value::number(confidence))
        .param("rationale", Value::string(rationale))
}

/// Neighbourhood query to a bounded depth.
pub fn neighborhood(entity_id: &str, depth: usize) -> CypherStatement {
    // Depth is clamped and inlined because Cypher does not accept a
    // parameter inside a variable-length pattern.
    let bounded = depth.clamp(1, 6);
    let query = format!(
        "MATCH (start {{ id: $id }})
MATCH path = (start)-[*1..{bounded}]-(neighbor)
WHERE neighbor.id IS NOT NULL
RETURN DISTINCT neighbor.id AS id,
                neighbor.kind AS kind,
                neighbor.natural_key AS natural_key,
                length(path) AS distance
ORDER BY distance, id
LIMIT 500"
    );
    CypherStatement::new(query).param("id", Value::string(entity_id))
}

/// Full provenance/lineage walk for one record.
pub fn lineage(entity_id: &str, max_depth: usize) -> CypherStatement {
    let bounded = max_depth.clamp(1, 10);
    let query = format!(
        "MATCH (start {{ id: $id }})
MATCH path = (start)-[:DERIVED_FROM|GENERATED|OBSERVED_BY*1..{bounded}]->(origin)
RETURN origin.id AS id,
       origin.kind AS kind,
       origin.natural_key AS natural_key,
       origin.provenance_event_id AS event_id,
       origin.provenance_producer AS producer,
       length(path) AS depth
ORDER BY depth, id"
    );
    CypherStatement::new(query).param("id", Value::string(entity_id))
}

/// Latest known state of an asset, with its most recent observations.
pub fn latest_asset_state(natural_key: &str) -> CypherStatement {
    let query = "MATCH (asset:Asset { natural_key: $natural_key })
OPTIONAL MATCH (observation:Observation)-[:CONCERNS]->(asset)
WITH asset, observation
ORDER BY observation.updated_at DESC
RETURN asset.id AS id,
       asset.natural_key AS natural_key,
       asset.updated_at AS updated_at,
       properties(asset) AS properties,
       collect(observation.id)[0..10] AS recent_observations";
    CypherStatement::new(query).param("natural_key", Value::string(natural_key))
}

/// Everything recorded about a zone inside a time window.
pub fn events_in_zone(zone_natural_key: &str, from_millis: i64, to_millis: i64) -> CypherStatement {
    let query = "MATCH (zone:Zone { natural_key: $zone })
OPTIONAL MATCH (asset)-[:LOCATED_IN]->(zone)
WITH zone, collect(asset) AS assets
MATCH (record)-[:CONCERNS]->(subject)
WHERE subject = zone OR subject IN assets
  AND record.updated_at >= $from AND record.updated_at < $to
RETURN record.id AS id,
       record.kind AS kind,
       record.natural_key AS natural_key,
       record.updated_at AS updated_at
ORDER BY record.updated_at";
    CypherStatement::new(query)
        .param("zone", Value::string(zone_natural_key))
        .param("from", Value::number(from_millis as f64))
        .param("to", Value::number(to_millis as f64))
}

/// Translates a mutation into the statement that applies it.
pub fn statement_for(mutation: &GraphMutation) -> Result<CypherStatement> {
    match mutation {
        GraphMutation::UpsertEntity(entity) => upsert_entity(entity),
        GraphMutation::UpsertRelationship(relationship) => upsert_relationship(relationship),
        GraphMutation::CloseRelationship { from, kind, to, at } => {
            close_relationship(from.as_str(), *kind, to.as_str(), at.as_millis())
        }
        GraphMutation::MergeEntities {
            canonical,
            duplicate,
            confidence,
            rationale,
        } => Ok(merge_entities(
            canonical.as_str(),
            duplicate.as_str(),
            *confidence,
            rationale,
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_event::{SourceId, Timestamp};
    use nexus_ontology::model::Provenance;

    fn provenance() -> Provenance {
        Provenance::asserted(
            "evt_1",
            SourceId::from_external("s1"),
            "hash",
            "producer",
            Timestamp::from_millis(1),
        )
    }

    fn asset() -> Entity {
        Entity::new(
            EntityKind::Asset,
            "press-4",
            provenance(),
            Timestamp::from_millis(1_000),
        )
        .with_property("celsius", Value::number(91.5))
    }

    #[test]
    fn upsert_uses_parameters_for_every_value() {
        let statement = upsert_entity(&asset()).unwrap();
        // No user value is interpolated into the query text.
        assert!(!statement.query.contains("press-4"));
        assert!(!statement.query.contains("91.5"));
        assert!(statement.query.contains("MERGE (n:Asset { id: $id })"));
        assert_eq!(
            statement.parameters.get("natural_key"),
            Some(&Value::string("press-4"))
        );
    }

    #[test]
    fn upsert_preserves_created_at_on_update() {
        let statement = upsert_entity(&asset()).unwrap();
        assert!(statement.query.contains("ON CREATE SET n.created_at"));
        assert!(!statement.query.contains("SET n.created_at = $created_at,\n    n.updated_at"));
    }

    #[test]
    fn labels_come_only_from_the_closed_enums() {
        for kind in EntityKind::all() {
            assert!(safe_label(kind.as_str()).is_ok());
        }
        for relation in RelationKind::all() {
            assert!(safe_label(relation.as_str()).is_ok());
        }
    }

    #[test]
    fn hostile_labels_are_rejected() {
        for hostile in [
            "Asset) DETACH DELETE (n",
            "Asset`",
            "",
            "with space",
            "a-b",
        ] {
            assert!(safe_label(hostile).is_err(), "must reject {hostile:?}");
        }
    }

    #[test]
    fn relationship_statement_matches_both_endpoints_by_label() {
        let zone = Entity::new(
            EntityKind::Zone,
            "press-hall",
            provenance(),
            Timestamp::from_millis(1),
        );
        let relationship = Relationship::new(
            RelationKind::LocatedIn,
            (&asset().id, EntityKind::Asset),
            (&zone.id, EntityKind::Zone),
            provenance(),
            Timestamp::from_millis(1),
        );
        let statement = upsert_relationship(&relationship).unwrap();
        assert!(statement.query.contains("MATCH (a:Asset { id: $from })"));
        assert!(statement.query.contains("MATCH (b:Zone { id: $to })"));
        assert!(statement.query.contains("MERGE (a)-[r:LOCATED_IN]->(b)"));
    }

    #[test]
    fn merges_are_recorded_not_destructive() {
        let statement = merge_entities("ent_a", "ent_b", 0.95, "same serial");
        assert!(statement.query.contains("MERGE (duplicate)-[r:SAME_AS]->(canonical)"));
        assert!(!statement.query.to_uppercase().contains("DELETE"));
    }

    #[test]
    fn no_generated_statement_deletes_anything() {
        let mut statements = schema_statements();
        statements.push(upsert_entity(&asset()).unwrap());
        statements.push(neighborhood("ent_a", 3));
        statements.push(lineage("ent_a", 4));
        statements.push(latest_asset_state("press-4"));
        statements.push(events_in_zone("press-hall", 0, 10));
        statements.push(close_relationship("a", RelationKind::LocatedIn, "b", 5).unwrap());

        for statement in statements {
            let upper = statement.query.to_uppercase();
            assert!(!upper.contains("DELETE"), "found DELETE in: {}", statement.query);
            assert!(!upper.contains("DROP"), "found DROP in: {}", statement.query);
        }
    }

    #[test]
    fn variable_length_depth_is_clamped() {
        assert!(neighborhood("x", 999).query.contains("[*1..6]"));
        assert!(neighborhood("x", 0).query.contains("[*1..1]"));
        assert!(lineage("x", 999).query.contains("*1..10"));
    }

    #[test]
    fn schema_statements_are_idempotent() {
        let statements = schema_statements();
        assert_eq!(statements.len(), EntityKind::all().len() * 2);
        for statement in statements {
            assert!(statement.query.contains("IF NOT EXISTS"));
        }
    }

    #[test]
    fn every_mutation_kind_maps_to_a_statement() {
        let zone = Entity::new(
            EntityKind::Zone,
            "press-hall",
            provenance(),
            Timestamp::from_millis(1),
        );
        let mutations = vec![
            GraphMutation::UpsertEntity(asset()),
            GraphMutation::UpsertRelationship(Relationship::new(
                RelationKind::LocatedIn,
                (&asset().id, EntityKind::Asset),
                (&zone.id, EntityKind::Zone),
                provenance(),
                Timestamp::from_millis(1),
            )),
            GraphMutation::CloseRelationship {
                from: asset().id,
                kind: RelationKind::LocatedIn,
                to: zone.id.clone(),
                at: Timestamp::from_millis(9),
            },
            GraphMutation::MergeEntities {
                canonical: asset().id,
                duplicate: zone.id,
                confidence: 0.9,
                rationale: "x".into(),
            },
        ];
        for mutation in &mutations {
            let statement = statement_for(mutation).expect("statement");
            assert!(!statement.query.is_empty());
        }
    }
}
