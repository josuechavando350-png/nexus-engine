//! Storage ports.
//!
//! These traits are the entire contract between the ontology and whatever
//! actually stores it. Neo4j, Memgraph, an in-memory map or a future columnar
//! store all sit behind the same surface.
//!
//! Two rules keep this honest and both are enforced by CI:
//!
//! - No type in this crate names a database, a driver, a connection string
//!   or a query language.
//! - No query here returns a vendor row type. Everything is expressed in
//!   ontology terms.
//!
//! The traits are synchronous. The adapters that need async (a network
//! driver) own their runtime internally and expose this surface, rather than
//! forcing an async colour on the ontology, the orchestrator and the
//! simulator that do not need one.

use crate::model::{Entity, EntityKind, RelationKind, Relationship};
use nexus_event::{EntityId, Result, Timestamp};

/// A single change to apply to the graph.
///
/// Mutations are described as data so they can be batched, replayed, written
/// to the audit trail and shipped across the one-way gateway without the
/// producer holding a connection.
#[derive(Debug, Clone, PartialEq)]
pub enum GraphMutation {
    UpsertEntity(Entity),
    UpsertRelationship(Relationship),
    /// Closes a relationship's validity interval instead of deleting it.
    CloseRelationship {
        from: EntityId,
        kind: RelationKind,
        to: EntityId,
        at: Timestamp,
    },
    /// Records that two entities are the same physical thing.
    MergeEntities {
        canonical: EntityId,
        duplicate: EntityId,
        confidence: f64,
        rationale: String,
    },
}

impl GraphMutation {
    pub fn kind_name(&self) -> &'static str {
        match self {
            GraphMutation::UpsertEntity(_) => "upsert_entity",
            GraphMutation::UpsertRelationship(_) => "upsert_relationship",
            GraphMutation::CloseRelationship { .. } => "close_relationship",
            GraphMutation::MergeEntities { .. } => "merge_entities",
        }
    }

    /// Idempotency key: applying the same mutation twice is a no-op.
    pub fn idempotency_key(&self) -> String {
        match self {
            GraphMutation::UpsertEntity(entity) => {
                format!("upsert_entity|{}|{}", entity.id, entity.updated_at.as_millis())
            }
            GraphMutation::UpsertRelationship(relationship) => {
                format!("upsert_rel|{}", relationship.edge_key())
            }
            GraphMutation::CloseRelationship { from, kind, to, at } => format!(
                "close_rel|{}|{}|{}|{}",
                from,
                kind.as_str(),
                to,
                at.as_millis()
            ),
            GraphMutation::MergeEntities {
                canonical,
                duplicate,
                ..
            } => format!("merge|{canonical}|{duplicate}"),
        }
    }
}

/// One step of a provenance/lineage walk.
#[derive(Debug, Clone, PartialEq)]
pub struct LineageStep {
    pub entity_id: EntityId,
    pub kind: EntityKind,
    pub natural_key: String,
    pub via: RelationKind,
    pub depth: usize,
    pub producer: String,
    pub event_id: String,
}

/// A neighbour returned by a neighbourhood query.
#[derive(Debug, Clone, PartialEq)]
pub struct Neighbor {
    pub entity: Entity,
    pub relation: RelationKind,
    /// True when the edge points from the queried entity outward.
    pub outgoing: bool,
}

/// Write side of the graph.
pub trait GraphWriter: Send + Sync {
    /// Applies mutations atomically **within this call** if the backend
    /// supports it, and reports how many were newly applied.
    ///
    /// No cross-call transaction is exposed, because the broker cannot join
    /// one; see the delivery guarantees in `nexus-event`.
    fn apply(&self, mutations: &[GraphMutation]) -> Result<usize>;
}

/// Read side of the graph.
pub trait GraphReader: Send + Sync {
    fn get_entity(&self, id: &EntityId) -> Result<Option<Entity>>;

    fn find_by_natural_key(&self, kind: EntityKind, natural_key: &str)
        -> Result<Option<Entity>>;

    /// Entities within `depth` hops, optionally filtered by relation kind.
    fn neighborhood(
        &self,
        id: &EntityId,
        depth: usize,
        relations: &[RelationKind],
    ) -> Result<Vec<Neighbor>>;

    /// Shortest path between two entities, as the sequence of entities.
    fn path(&self, from: &EntityId, to: &EntityId, max_depth: usize) -> Result<Vec<Entity>>;

    /// Everything this entity was derived from, transitively.
    fn lineage(&self, id: &EntityId, max_depth: usize) -> Result<Vec<LineageStep>>;

    /// Most recent state of an asset: its current properties plus the
    /// observations and detections that produced them.
    fn latest_asset_state(&self, natural_key: &str) -> Result<Option<Entity>>;

    /// Events (observations, detections, incidents) attached to a zone
    /// within a time window.
    fn events_in_zone(
        &self,
        zone_natural_key: &str,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Entity>>;

    fn entity_count(&self) -> Result<usize>;

    fn relationship_count(&self) -> Result<usize>;
}

/// Convenience supertrait for backends that do both.
pub trait GraphStore: GraphReader + GraphWriter {
    /// Human-readable backend name for logs and health reports.
    fn backend_name(&self) -> &'static str;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntityKind, Provenance};
    use nexus_event::SourceId;

    fn entity() -> Entity {
        Entity::new(
            EntityKind::Asset,
            "press-04",
            Provenance::asserted(
                "evt_1",
                SourceId::from_external("s1"),
                "hash",
                "test",
                Timestamp::from_millis(1),
            ),
            Timestamp::from_millis(1),
        )
    }

    #[test]
    fn mutation_idempotency_keys_are_stable_and_distinct() {
        let upsert = GraphMutation::UpsertEntity(entity());
        assert_eq!(upsert.idempotency_key(), upsert.clone().idempotency_key());

        let merge = GraphMutation::MergeEntities {
            canonical: entity().id,
            duplicate: EntityId::from_external("ent_other"),
            confidence: 0.9,
            rationale: "same serial".into(),
        };
        assert_ne!(upsert.idempotency_key(), merge.idempotency_key());
        assert_eq!(merge.kind_name(), "merge_entities");
    }

    #[test]
    fn upsert_key_changes_when_the_entity_changes() {
        let mut updated = entity();
        updated.updated_at = Timestamp::from_millis(500);
        assert_ne!(
            GraphMutation::UpsertEntity(entity()).idempotency_key(),
            GraphMutation::UpsertEntity(updated).idempotency_key()
        );
    }
}
