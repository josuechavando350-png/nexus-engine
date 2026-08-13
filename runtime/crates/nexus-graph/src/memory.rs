//! In-memory graph store.
//!
//! This is not a toy stub. It is the default backend: it implements the full
//! [`GraphStore`] surface, is what the end-to-end demo and CI run against,
//! and it is what makes the pipeline testable without infrastructure.
//!
//! It is *not* durable, and it is not intended to be. A deployment that needs
//! persistence enables the `neo4j` feature and swaps the adapter; nothing
//! upstream of the port changes.

use nexus_event::json::Value;
use nexus_event::{EntityId, NexusError, Result, Timestamp};
use nexus_ontology::model::{Entity, EntityKind, RelationKind, Relationship};
use nexus_ontology::store::{
    GraphMutation, GraphReader, GraphStore, GraphWriter, LineageStep, Neighbor,
};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::sync::RwLock;

#[derive(Debug, Default)]
struct GraphState {
    entities: BTreeMap<String, Entity>,
    /// Keyed by `Relationship::edge_key`.
    relationships: BTreeMap<String, Relationship>,
    /// Duplicate id -> canonical id, applied on read.
    merges: HashMap<String, String>,
    applied_keys: HashSet<String>,
}

#[derive(Debug, Default)]
pub struct InMemoryGraph {
    state: RwLock<GraphState>,
}

impl InMemoryGraph {
    pub fn new() -> Self {
        InMemoryGraph::default()
    }

    /// Follows merge pointers to the surviving entity.
    fn canonical_id(state: &GraphState, id: &str) -> String {
        let mut current = id.to_string();
        // Bounded so a cycle introduced by a bad merge cannot hang a read.
        for _ in 0..16 {
            match state.merges.get(&current) {
                Some(next) if next != &current => current = next.clone(),
                _ => break,
            }
        }
        current
    }

    fn read_entity(state: &GraphState, id: &str) -> Option<Entity> {
        let canonical = Self::canonical_id(state, id);
        state.entities.get(&canonical).cloned()
    }

    /// Seeds an entity directly. Test and fixture helper.
    pub fn seed_entity(&self, entity: Entity) -> Result<()> {
        self.apply(&[GraphMutation::UpsertEntity(entity)])?;
        Ok(())
    }

    pub fn seed_relationship(&self, relationship: Relationship) -> Result<()> {
        self.apply(&[GraphMutation::UpsertRelationship(relationship)])?;
        Ok(())
    }

    /// All entities of a kind. Used by resolution to build a candidate set.
    pub fn entities_of_kind(&self, kind: EntityKind) -> Vec<Entity> {
        self.state
            .read()
            .map(|state| {
                state
                    .entities
                    .values()
                    .filter(|entity| entity.kind == kind)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn all_relationships(&self) -> Vec<Relationship> {
        self.state
            .read()
            .map(|state| state.relationships.values().cloned().collect())
            .unwrap_or_default()
    }
}

impl GraphWriter for InMemoryGraph {
    fn apply(&self, mutations: &[GraphMutation]) -> Result<usize> {
        // Validate everything before mutating anything, so a batch either
        // applies fully or leaves the graph untouched.
        for mutation in mutations {
            match mutation {
                GraphMutation::UpsertEntity(entity) => entity.validate()?,
                GraphMutation::UpsertRelationship(relationship) => relationship.validate()?,
                GraphMutation::MergeEntities {
                    canonical,
                    duplicate,
                    confidence,
                    ..
                } => {
                    if canonical == duplicate {
                        return Err(NexusError::invalid("cannot merge an entity into itself"));
                    }
                    if !(0.0..=1.0).contains(confidence) {
                        return Err(NexusError::invalid(
                            "merge confidence must be within 0.0..=1.0",
                        ));
                    }
                }
                GraphMutation::CloseRelationship { .. } => {}
            }
        }

        let mut state = self
            .state
            .write()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        let mut applied = 0usize;

        for mutation in mutations {
            let key = mutation.idempotency_key();
            if state.applied_keys.contains(&key) {
                continue;
            }

            match mutation {
                GraphMutation::UpsertEntity(entity) => {
                    let id = InMemoryGraph::canonical_id(&state, entity.id.as_str());
                    match state.entities.get_mut(&id) {
                        Some(existing) => {
                            for (property_key, value) in &entity.properties {
                                existing.set_property(
                                    property_key,
                                    value.clone(),
                                    entity.updated_at,
                                    entity.provenance.clone(),
                                );
                            }
                            existing.updated_at = entity.updated_at;
                        }
                        None => {
                            state.entities.insert(id, entity.clone());
                        }
                    }
                }
                GraphMutation::UpsertRelationship(relationship) => {
                    state
                        .relationships
                        .insert(relationship.edge_key(), relationship.clone());
                }
                GraphMutation::CloseRelationship { from, kind, to, at } => {
                    let edge_key = format!("{}|{}|{}", from.as_str(), kind.as_str(), to.as_str());
                    if let Some(relationship) = state.relationships.get_mut(&edge_key) {
                        relationship.valid_to = Some(*at);
                    }
                }
                GraphMutation::MergeEntities {
                    canonical,
                    duplicate,
                    ..
                } => {
                    state.merges.insert(
                        duplicate.as_str().to_string(),
                        canonical.as_str().to_string(),
                    );
                    // Fold the duplicate's properties into the survivor
                    // rather than dropping them.
                    if let Some(losing) = state.entities.remove(duplicate.as_str()) {
                        if let Some(surviving) = state.entities.get_mut(canonical.as_str()) {
                            for (property_key, value) in losing.properties {
                                surviving.properties.entry(property_key).or_insert(value);
                            }
                        }
                    }
                }
            }

            state.applied_keys.insert(key);
            applied += 1;
        }

        Ok(applied)
    }
}

impl GraphReader for InMemoryGraph {
    fn get_entity(&self, id: &EntityId) -> Result<Option<Entity>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        Ok(InMemoryGraph::read_entity(&state, id.as_str()))
    }

    fn find_by_natural_key(&self, kind: EntityKind, natural_key: &str) -> Result<Option<Entity>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        Ok(state
            .entities
            .values()
            .find(|entity| entity.kind == kind && entity.natural_key == natural_key)
            .cloned())
    }

    fn neighborhood(
        &self,
        id: &EntityId,
        depth: usize,
        relations: &[RelationKind],
    ) -> Result<Vec<Neighbor>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        let start = InMemoryGraph::canonical_id(&state, id.as_str());

        let mut found: Vec<Neighbor> = Vec::new();
        let mut visited: HashSet<String> = HashSet::new();
        visited.insert(start.clone());
        let mut frontier: VecDeque<(String, usize)> = VecDeque::new();
        frontier.push_back((start, 0));

        while let Some((current, current_depth)) = frontier.pop_front() {
            if current_depth >= depth {
                continue;
            }
            for relationship in state.relationships.values() {
                if !relations.is_empty() && !relations.contains(&relationship.kind) {
                    continue;
                }
                let (other, outgoing) = if relationship.from.as_str() == current {
                    (relationship.to.as_str().to_string(), true)
                } else if relationship.to.as_str() == current {
                    (relationship.from.as_str().to_string(), false)
                } else {
                    continue;
                };

                if !visited.insert(other.clone()) {
                    continue;
                }
                if let Some(entity) = InMemoryGraph::read_entity(&state, &other) {
                    found.push(Neighbor {
                        entity,
                        relation: relationship.kind,
                        outgoing,
                    });
                    frontier.push_back((other, current_depth + 1));
                }
            }
        }

        Ok(found)
    }

    fn path(&self, from: &EntityId, to: &EntityId, max_depth: usize) -> Result<Vec<Entity>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        let start = InMemoryGraph::canonical_id(&state, from.as_str());
        let goal = InMemoryGraph::canonical_id(&state, to.as_str());

        let mut previous: HashMap<String, String> = HashMap::new();
        let mut visited: HashSet<String> = HashSet::new();
        visited.insert(start.clone());
        let mut frontier: VecDeque<(String, usize)> = VecDeque::new();
        frontier.push_back((start.clone(), 0));

        while let Some((current, depth)) = frontier.pop_front() {
            if current == goal {
                let mut chain = vec![current.clone()];
                let mut cursor = current;
                while let Some(parent) = previous.get(&cursor) {
                    chain.push(parent.clone());
                    cursor = parent.clone();
                }
                chain.reverse();
                let entities = chain
                    .iter()
                    .filter_map(|id| InMemoryGraph::read_entity(&state, id))
                    .collect();
                return Ok(entities);
            }
            if depth >= max_depth {
                continue;
            }
            for relationship in state.relationships.values() {
                let other = if relationship.from.as_str() == current {
                    relationship.to.as_str().to_string()
                } else if relationship.to.as_str() == current {
                    relationship.from.as_str().to_string()
                } else {
                    continue;
                };
                if visited.insert(other.clone()) {
                    previous.insert(other.clone(), current.clone());
                    frontier.push_back((other, depth + 1));
                }
            }
        }

        Ok(Vec::new())
    }

    fn lineage(&self, id: &EntityId, max_depth: usize) -> Result<Vec<LineageStep>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;
        let start = InMemoryGraph::canonical_id(&state, id.as_str());

        let mut steps = Vec::new();
        let mut visited: HashSet<String> = HashSet::new();
        visited.insert(start.clone());
        let mut frontier: VecDeque<(String, usize)> = VecDeque::new();
        frontier.push_back((start, 0));

        while let Some((current, depth)) = frontier.pop_front() {
            if depth >= max_depth {
                continue;
            }
            for relationship in state.relationships.values() {
                // Lineage walks DERIVED_FROM and GENERATED backwards.
                let follows = matches!(
                    relationship.kind,
                    RelationKind::DerivedFrom | RelationKind::Generated | RelationKind::ObservedBy
                );
                if !follows || relationship.from.as_str() != current {
                    continue;
                }
                let target = relationship.to.as_str().to_string();
                if !visited.insert(target.clone()) {
                    continue;
                }
                if let Some(entity) = InMemoryGraph::read_entity(&state, &target) {
                    steps.push(LineageStep {
                        entity_id: entity.id.clone(),
                        kind: entity.kind,
                        natural_key: entity.natural_key.clone(),
                        via: relationship.kind,
                        depth: depth + 1,
                        producer: relationship.provenance.producer.clone(),
                        event_id: relationship.provenance.event_id.clone(),
                    });
                    frontier.push_back((target, depth + 1));
                }
            }
        }

        Ok(steps)
    }

    fn latest_asset_state(&self, natural_key: &str) -> Result<Option<Entity>> {
        self.find_by_natural_key(EntityKind::Asset, natural_key)
    }

    fn events_in_zone(
        &self,
        zone_natural_key: &str,
        from: Timestamp,
        to: Timestamp,
    ) -> Result<Vec<Entity>> {
        let state = self
            .state
            .read()
            .map_err(|_| NexusError::adapter("graph lock poisoned"))?;

        let zone = state
            .entities
            .values()
            .find(|entity| {
                entity.kind == EntityKind::Zone && entity.natural_key == zone_natural_key
            })
            .cloned();
        let zone = match zone {
            Some(zone) => zone,
            None => return Ok(Vec::new()),
        };

        // Assets located in the zone, plus anything recorded about them.
        let mut in_zone: HashSet<String> = HashSet::new();
        for relationship in state.relationships.values() {
            if relationship.kind == RelationKind::LocatedIn
                && relationship.to.as_str() == zone.id.as_str()
            {
                in_zone.insert(relationship.from.as_str().to_string());
            }
        }

        let mut results: Vec<Entity> = Vec::new();
        for relationship in state.relationships.values() {
            let concerns_zone = relationship.kind == RelationKind::Concerns
                && (relationship.to.as_str() == zone.id.as_str()
                    || in_zone.contains(relationship.to.as_str()));
            if !concerns_zone {
                continue;
            }
            if let Some(entity) = InMemoryGraph::read_entity(&state, relationship.from.as_str()) {
                let at = entity.updated_at;
                if !at.is_before(from) && at.is_before(to) {
                    results.push(entity);
                }
            }
        }

        results.sort_by_key(|entity| entity.updated_at.as_millis());
        results.dedup_by(|a, b| a.id == b.id);
        Ok(results)
    }

    fn entity_count(&self) -> Result<usize> {
        Ok(self
            .state
            .read()
            .map(|state| state.entities.len())
            .unwrap_or(0))
    }

    fn relationship_count(&self) -> Result<usize> {
        Ok(self
            .state
            .read()
            .map(|state| state.relationships.len())
            .unwrap_or(0))
    }
}

impl GraphStore for InMemoryGraph {
    fn backend_name(&self) -> &'static str {
        "in-memory"
    }
}

/// Convenience for building a zone entity in fixtures and examples.
pub fn zone_entity(
    natural_key: &str,
    facility: &str,
    provenance: nexus_ontology::model::Provenance,
    at: Timestamp,
) -> Entity {
    Entity::new(EntityKind::Zone, natural_key, provenance, at)
        .with_property("facility", Value::string(facility))
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_event::SourceId;
    use nexus_ontology::model::Provenance;

    fn provenance() -> Provenance {
        Provenance::asserted(
            "evt_1",
            SourceId::from_external("s1"),
            "hash",
            "test",
            Timestamp::from_millis(1),
        )
    }

    fn entity(kind: EntityKind, key: &str) -> Entity {
        Entity::new(kind, key, provenance(), Timestamp::from_millis(1_000))
    }

    #[test]
    fn upsert_is_idempotent() {
        let graph = InMemoryGraph::new();
        let asset = entity(EntityKind::Asset, "press-4");
        let mutation = GraphMutation::UpsertEntity(asset.clone());
        assert_eq!(graph.apply(&[mutation.clone()]).unwrap(), 1);
        assert_eq!(graph.apply(&[mutation]).unwrap(), 0);
        assert_eq!(graph.entity_count().unwrap(), 1);
    }

    #[test]
    fn invalid_mutation_leaves_the_batch_unapplied() {
        let graph = InMemoryGraph::new();
        let asset = entity(EntityKind::Asset, "press-4");
        let operator = entity(EntityKind::Operator, "op-1");
        let illegal = Relationship::new(
            RelationKind::LocatedIn,
            (&operator.id, EntityKind::Operator),
            (&asset.id, EntityKind::Asset),
            provenance(),
            Timestamp::from_millis(1),
        );

        let result = graph.apply(&[
            GraphMutation::UpsertEntity(asset),
            GraphMutation::UpsertRelationship(illegal),
        ]);
        assert!(result.is_err());
        assert_eq!(graph.entity_count().unwrap(), 0);
    }

    #[test]
    fn neighborhood_respects_depth_and_relation_filters() {
        let graph = InMemoryGraph::new();
        let facility = entity(EntityKind::Facility, "plant-1");
        let zone = entity(EntityKind::Zone, "press-hall");
        let asset = entity(EntityKind::Asset, "press-4");

        graph.seed_entity(facility.clone()).unwrap();
        graph.seed_entity(zone.clone()).unwrap();
        graph.seed_entity(asset.clone()).unwrap();
        graph
            .seed_relationship(Relationship::new(
                RelationKind::LocatedIn,
                (&asset.id, EntityKind::Asset),
                (&zone.id, EntityKind::Zone),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();
        graph
            .seed_relationship(Relationship::new(
                RelationKind::LocatedIn,
                (&zone.id, EntityKind::Zone),
                (&facility.id, EntityKind::Facility),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();

        let depth_one = graph.neighborhood(&asset.id, 1, &[]).unwrap();
        assert_eq!(depth_one.len(), 1);
        assert_eq!(depth_one[0].entity.natural_key, "press-hall");
        assert!(depth_one[0].outgoing);

        let depth_two = graph.neighborhood(&asset.id, 2, &[]).unwrap();
        assert_eq!(depth_two.len(), 2);

        let filtered = graph
            .neighborhood(&asset.id, 2, &[RelationKind::ObservedBy])
            .unwrap();
        assert!(filtered.is_empty());
    }

    #[test]
    fn path_finds_the_shortest_chain() {
        let graph = InMemoryGraph::new();
        let facility = entity(EntityKind::Facility, "plant-1");
        let zone = entity(EntityKind::Zone, "press-hall");
        let asset = entity(EntityKind::Asset, "press-4");
        for candidate in [&facility, &zone, &asset] {
            graph.seed_entity(candidate.clone()).unwrap();
        }
        graph
            .seed_relationship(Relationship::new(
                RelationKind::LocatedIn,
                (&asset.id, EntityKind::Asset),
                (&zone.id, EntityKind::Zone),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();
        graph
            .seed_relationship(Relationship::new(
                RelationKind::LocatedIn,
                (&zone.id, EntityKind::Zone),
                (&facility.id, EntityKind::Facility),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();

        let path = graph.path(&asset.id, &facility.id, 5).unwrap();
        assert_eq!(path.len(), 3);
        assert_eq!(path[0].natural_key, "press-4");
        assert_eq!(path[2].natural_key, "plant-1");

        assert!(graph.path(&asset.id, &facility.id, 1).unwrap().is_empty());
    }

    #[test]
    fn merged_entities_are_readable_through_the_duplicate_id() {
        let graph = InMemoryGraph::new();
        let canonical = entity(EntityKind::Asset, "press-4");
        let mut duplicate = entity(EntityKind::Asset, "press-04");
        duplicate
            .properties
            .insert("serial_number".into(), Value::string("SN-9"));

        graph.seed_entity(canonical.clone()).unwrap();
        graph.seed_entity(duplicate.clone()).unwrap();
        graph
            .apply(&[GraphMutation::MergeEntities {
                canonical: canonical.id.clone(),
                duplicate: duplicate.id.clone(),
                confidence: 0.95,
                rationale: "normalized key".into(),
            }])
            .unwrap();

        let via_duplicate = graph.get_entity(&duplicate.id).unwrap().expect("resolves");
        assert_eq!(via_duplicate.id, canonical.id);
        // The duplicate's unique property survived the merge.
        assert_eq!(
            via_duplicate.properties.get("serial_number"),
            Some(&Value::string("SN-9"))
        );
        assert_eq!(graph.entity_count().unwrap(), 1);
    }

    #[test]
    fn merge_cycles_cannot_hang_a_read() {
        let graph = InMemoryGraph::new();
        let a = entity(EntityKind::Asset, "a");
        let b = entity(EntityKind::Asset, "b");
        graph.seed_entity(a.clone()).unwrap();
        graph.seed_entity(b.clone()).unwrap();
        graph
            .apply(&[GraphMutation::MergeEntities {
                canonical: a.id.clone(),
                duplicate: b.id.clone(),
                confidence: 1.0,
                rationale: "x".into(),
            }])
            .unwrap();
        graph
            .apply(&[GraphMutation::MergeEntities {
                canonical: b.id.clone(),
                duplicate: a.id.clone(),
                confidence: 1.0,
                rationale: "y".into(),
            }])
            .unwrap();
        // Terminates rather than looping forever.
        let _ = graph.get_entity(&a.id).unwrap();
    }

    #[test]
    fn lineage_walks_derivation_edges() {
        let graph = InMemoryGraph::new();
        let incident = entity(EntityKind::Incident, "inc-1");
        let detection = entity(EntityKind::Detection, "det-1");
        let camera = entity(EntityKind::Camera, "cam-1");
        for candidate in [&incident, &detection, &camera] {
            graph.seed_entity(candidate.clone()).unwrap();
        }
        graph
            .seed_relationship(Relationship::new(
                RelationKind::DerivedFrom,
                (&incident.id, EntityKind::Incident),
                (&detection.id, EntityKind::Detection),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();
        graph
            .seed_relationship(Relationship::new(
                RelationKind::ObservedBy,
                (&detection.id, EntityKind::Detection),
                (&camera.id, EntityKind::Camera),
                provenance(),
                Timestamp::from_millis(1),
            ))
            .unwrap();

        let lineage = graph.lineage(&incident.id, 5).unwrap();
        assert_eq!(lineage.len(), 2);
        assert_eq!(lineage[0].natural_key, "det-1");
        assert_eq!(lineage[1].natural_key, "cam-1");
        assert_eq!(lineage[1].depth, 2);
        assert_eq!(lineage[0].event_id, "evt_1");
    }

    #[test]
    fn close_relationship_preserves_history() {
        let graph = InMemoryGraph::new();
        let asset = entity(EntityKind::Asset, "press-4");
        let zone = entity(EntityKind::Zone, "press-hall");
        graph.seed_entity(asset.clone()).unwrap();
        graph.seed_entity(zone.clone()).unwrap();
        graph
            .seed_relationship(Relationship::new(
                RelationKind::LocatedIn,
                (&asset.id, EntityKind::Asset),
                (&zone.id, EntityKind::Zone),
                provenance(),
                Timestamp::from_millis(1_000),
            ))
            .unwrap();

        graph
            .apply(&[GraphMutation::CloseRelationship {
                from: asset.id.clone(),
                kind: RelationKind::LocatedIn,
                to: zone.id.clone(),
                at: Timestamp::from_millis(5_000),
            }])
            .unwrap();

        let edges = graph.all_relationships();
        assert_eq!(edges.len(), 1);
        assert!(edges[0].is_valid_at(Timestamp::from_millis(2_000)));
        assert!(!edges[0].is_valid_at(Timestamp::from_millis(6_000)));
    }
}
