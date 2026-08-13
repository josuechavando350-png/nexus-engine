//! Neo4j / Memgraph adapter.
//!
//! **Build status: this module is behind the `neo4j` feature and is not part
//! of the default build.** See `docs/architecture/V3_DATA_PLANE.md` for the
//! verification status of the feature-gated adapters.
//!
//! The adapter owns its async runtime and exposes the synchronous
//! `GraphReader`/`GraphWriter` ports, so enabling a database does not turn the
//! orchestrator, the simulator or the policy engine async.
//!
//! Configuration comes from the environment; there are no credentials in the
//! source and no default password.

use nexus_event::json::Value;
use nexus_event::SourceId;
use nexus_event::{EntityId, NexusError, Result, Timestamp};
use nexus_ontology::model::{Entity, EntityKind, Provenance, RelationKind};
use nexus_ontology::store::{
    GraphMutation, GraphReader, GraphStore, GraphWriter, LineageStep, Neighbor,
};
use std::collections::BTreeMap;

use crate::cypher::{self, CypherStatement};

/// Connection settings, read from the environment.
///
/// `Debug` is implemented by hand so the password cannot reach a log line
/// through an error context or a `{:?}` in a diagnostic.
#[derive(Clone)]
pub struct Neo4jConfig {
    pub uri: String,
    pub user: String,
    pub password: String,
    pub database: String,
    pub max_connections: usize,
}

impl std::fmt::Debug for Neo4jConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Neo4jConfig")
            .field("uri", &self.uri)
            .field("user", &self.user)
            .field("password", &"<redacted>")
            .field("database", &self.database)
            .field("max_connections", &self.max_connections)
            .finish()
    }
}

impl Neo4jConfig {
    /// Reads `NEXUS_GRAPH_URI`, `NEXUS_GRAPH_USER`, `NEXUS_GRAPH_PASSWORD`,
    /// `NEXUS_GRAPH_DATABASE`.
    ///
    /// Fails if any required variable is missing. There is deliberately no
    /// fallback to `neo4j/neo4j` or to a hardcoded localhost URI: a service
    /// that silently starts against the wrong graph is worse than one that
    /// refuses to start.
    pub fn from_env() -> Result<Self> {
        fn required(key: &str) -> Result<String> {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    NexusError::invalid(format!("environment variable {key} is required"))
                })
        }

        let uri = required("NEXUS_GRAPH_URI")?;
        if uri.contains('@') {
            return Err(NexusError::invalid(
                "NEXUS_GRAPH_URI must not embed credentials; use NEXUS_GRAPH_USER and NEXUS_GRAPH_PASSWORD",
            ));
        }

        Ok(Neo4jConfig {
            uri,
            user: required("NEXUS_GRAPH_USER")?,
            password: required("NEXUS_GRAPH_PASSWORD")?,
            database: std::env::var("NEXUS_GRAPH_DATABASE").unwrap_or_else(|_| "neo4j".to_string()),
            max_connections: std::env::var("NEXUS_GRAPH_MAX_CONNECTIONS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(16),
        })
    }
}

/// Converts a `nexus_event::json::Value` into a driver parameter.
fn to_bolt(value: &Value) -> neo4rs::BoltType {
    match value {
        Value::Null => neo4rs::BoltType::Null(neo4rs::BoltNull),
        Value::Bool(flag) => neo4rs::BoltType::from(*flag),
        Value::Number(number) => {
            if number.fract() == 0.0 && number.abs() < 9.0e15 {
                neo4rs::BoltType::from(*number as i64)
            } else {
                neo4rs::BoltType::from(*number)
            }
        }
        Value::String(text) => neo4rs::BoltType::from(text.as_str()),
        Value::Array(items) => {
            let converted: Vec<neo4rs::BoltType> = items.iter().map(to_bolt).collect();
            neo4rs::BoltType::List(neo4rs::BoltList::from(converted))
        }
        Value::Object(map) => {
            let mut bolt_map = neo4rs::BoltMap::new();
            for (key, item) in map {
                bolt_map.put(neo4rs::BoltString::from(key.as_str()), to_bolt(item));
            }
            neo4rs::BoltType::Map(bolt_map)
        }
    }
}

fn build_query(statement: &CypherStatement) -> neo4rs::Query {
    let mut query = neo4rs::query(&statement.query);
    for (key, value) in &statement.parameters {
        query = query.param(key, to_bolt(value));
    }
    query
}

/// Neo4j-backed graph store.
pub struct Neo4jGraph {
    graph: neo4rs::Graph,
    runtime: tokio::runtime::Runtime,
    database: String,
}

/// `Debug` is implemented by hand because `neo4rs::Graph` is an opaque
/// connection pool that does not implement it, matching what `Neo4jConfig`
/// does above.
///
/// The database name is the part worth seeing in a diagnostic; the pool
/// handle and the tokio runtime are not, and neither is reachable from here
/// without leaking connection detail into a log line.
impl std::fmt::Debug for Neo4jGraph {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Neo4jGraph")
            .field("backend", &"neo4j")
            .field("database", &self.database)
            .finish_non_exhaustive()
    }
}

impl Neo4jGraph {
    pub fn connect(config: &Neo4jConfig) -> Result<Self> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("nexus-graph")
            .build()
            .map_err(|error| NexusError::adapter(format!("tokio runtime: {error}")))?;

        let neo4j_config = neo4rs::ConfigBuilder::default()
            .uri(&config.uri)
            .user(&config.user)
            .password(&config.password)
            .db(config.database.as_str())
            .max_connections(config.max_connections)
            .build()
            .map_err(|error| NexusError::adapter(format!("neo4j config: {error}")))?;

        let graph = runtime
            .block_on(neo4rs::Graph::connect(neo4j_config))
            .map_err(|error| NexusError::adapter(format!("neo4j connect: {error}")))?;

        Ok(Neo4jGraph {
            graph,
            runtime,
            database: config.database.clone(),
        })
    }

    pub fn database(&self) -> &str {
        &self.database
    }

    /// Applies constraints and indexes. Safe to call on every start.
    pub fn ensure_schema(&self) -> Result<()> {
        for statement in cypher::schema_statements() {
            self.run(&statement)?;
        }
        Ok(())
    }

    fn run(&self, statement: &CypherStatement) -> Result<()> {
        let query = build_query(statement);
        self.runtime.block_on(async {
            self.graph
                .run(query)
                .await
                .map_err(|error| NexusError::adapter(format!("neo4j run: {error}")))
        })
    }

    fn fetch(&self, statement: &CypherStatement) -> Result<Vec<neo4rs::Row>> {
        let query = build_query(statement);
        self.runtime.block_on(async {
            let mut stream = self
                .graph
                .execute(query)
                .await
                .map_err(|error| NexusError::adapter(format!("neo4j execute: {error}")))?;
            let mut rows = Vec::new();
            while let Some(row) = stream
                .next()
                .await
                .map_err(|error| NexusError::adapter(format!("neo4j stream: {error}")))?
            {
                rows.push(row);
            }
            Ok(rows)
        })
    }

    fn row_to_entity(row: &neo4rs::Row) -> Option<Entity> {
        let id: String = row.get("id").ok()?;
        let kind: String = row.get("kind").ok()?;
        let natural_key: String = row.get("natural_key").unwrap_or_default();
        let kind = EntityKind::parse(&kind).ok()?;

        let provenance = Provenance::asserted(
            row.get::<String>("event_id").unwrap_or_default(),
            SourceId::from_external(row.get::<String>("source_id").unwrap_or_default()),
            row.get::<String>("provenance_hash").unwrap_or_default(),
            "neo4j",
            Timestamp::from_millis(row.get::<i64>("updated_at").unwrap_or(0)),
        );

        let mut entity = Entity::new(
            kind,
            natural_key,
            provenance,
            Timestamp::from_millis(row.get::<i64>("created_at").unwrap_or(0)),
        );
        entity.id = EntityId::from_external(id);
        entity.updated_at = Timestamp::from_millis(row.get::<i64>("updated_at").unwrap_or(0));
        entity.properties = BTreeMap::new();
        Some(entity)
    }
}

impl GraphWriter for Neo4jGraph {
    fn apply(&self, mutations: &[GraphMutation]) -> Result<usize> {
        for mutation in mutations {
            match mutation {
                GraphMutation::UpsertEntity(entity) => entity.validate()?,
                GraphMutation::UpsertRelationship(relationship) => relationship.validate()?,
                _ => {}
            }
        }

        let statements: Vec<CypherStatement> = mutations
            .iter()
            .map(cypher::statement_for)
            .collect::<Result<Vec<_>>>()?;

        // One transaction per batch. This is the real transactional unit and
        // it does NOT extend to the broker offset commit; see the delivery
        // guarantees documented in nexus-event.
        self.runtime.block_on(async {
            let mut transaction = self
                .graph
                .start_txn()
                .await
                .map_err(|error| NexusError::adapter(format!("neo4j txn: {error}")))?;

            for statement in &statements {
                transaction
                    .run(build_query(statement))
                    .await
                    .map_err(|error| NexusError::adapter(format!("neo4j txn run: {error}")))?;
            }

            transaction
                .commit()
                .await
                .map_err(|error| NexusError::adapter(format!("neo4j commit: {error}")))?;
            Ok(statements.len())
        })
    }
}

impl GraphReader for Neo4jGraph {
    fn get_entity(&self, id: &EntityId) -> Result<Option<Entity>> {
        let statement = CypherStatement::new(
            "MATCH (n { id: $id })
OPTIONAL MATCH (n)-[:SAME_AS]->(canonical)
WITH coalesce(canonical, n) AS n
RETURN n.id AS id, n.kind AS kind, n.natural_key AS natural_key,
       n.created_at AS created_at, n.updated_at AS updated_at,
       n.provenance_event_id AS event_id, n.provenance_source_id AS source_id,
       n.provenance_hash AS provenance_hash
LIMIT 1",
        )
        .param("id", Value::string(id.as_str()));

        Ok(self
            .fetch(&statement)?
            .first()
            .and_then(Neo4jGraph::row_to_entity))
    }

    fn find_by_natural_key(&self, kind: EntityKind, natural_key: &str) -> Result<Option<Entity>> {
        let label = cypher::safe_label(kind.as_str())?;
        let statement = CypherStatement::new(format!(
            "MATCH (n:{label} {{ natural_key: $natural_key }})
RETURN n.id AS id, n.kind AS kind, n.natural_key AS natural_key,
       n.created_at AS created_at, n.updated_at AS updated_at,
       n.provenance_event_id AS event_id, n.provenance_source_id AS source_id,
       n.provenance_hash AS provenance_hash
LIMIT 1"
        ))
        .param("natural_key", Value::string(natural_key));

        Ok(self
            .fetch(&statement)?
            .first()
            .and_then(Neo4jGraph::row_to_entity))
    }

    fn neighborhood(
        &self,
        id: &EntityId,
        depth: usize,
        _relations: &[RelationKind],
    ) -> Result<Vec<Neighbor>> {
        let rows = self.fetch(&cypher::neighborhood(id.as_str(), depth))?;
        let mut neighbors = Vec::new();
        for row in &rows {
            if let Some(entity) = Neo4jGraph::row_to_entity(row) {
                neighbors.push(Neighbor {
                    entity,
                    relation: RelationKind::DependsOn,
                    outgoing: true,
                });
            }
        }
        Ok(neighbors)
    }

    fn path(&self, from: &EntityId, to: &EntityId, max_depth: usize) -> Result<Vec<Entity>> {
        let bounded = max_depth.clamp(1, 8);
        let statement = CypherStatement::new(format!(
            "MATCH path = shortestPath((a {{ id: $from }})-[*1..{bounded}]-(b {{ id: $to }}))
UNWIND nodes(path) AS n
RETURN n.id AS id, n.kind AS kind, n.natural_key AS natural_key,
       n.created_at AS created_at, n.updated_at AS updated_at,
       n.provenance_event_id AS event_id, n.provenance_source_id AS source_id,
       n.provenance_hash AS provenance_hash"
        ))
        .param("from", Value::string(from.as_str()))
        .param("to", Value::string(to.as_str()));

        Ok(self
            .fetch(&statement)?
            .iter()
            .filter_map(Neo4jGraph::row_to_entity)
            .collect())
    }

    fn lineage(&self, id: &EntityId, max_depth: usize) -> Result<Vec<LineageStep>> {
        let rows = self.fetch(&cypher::lineage(id.as_str(), max_depth))?;
        let mut steps = Vec::new();
        for row in &rows {
            let kind: String = row.get("kind").unwrap_or_default();
            let Ok(kind) = EntityKind::parse(&kind) else {
                continue;
            };
            steps.push(LineageStep {
                entity_id: EntityId::from_external(row.get::<String>("id").unwrap_or_default()),
                kind,
                natural_key: row.get::<String>("natural_key").unwrap_or_default(),
                via: RelationKind::DerivedFrom,
                depth: row.get::<i64>("depth").unwrap_or(0).max(0) as usize,
                producer: row.get::<String>("producer").unwrap_or_default(),
                event_id: row.get::<String>("event_id").unwrap_or_default(),
            });
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
        let statement = cypher::events_in_zone(zone_natural_key, from.as_millis(), to.as_millis());
        Ok(self
            .fetch(&statement)?
            .iter()
            .filter_map(Neo4jGraph::row_to_entity)
            .collect())
    }

    fn entity_count(&self) -> Result<usize> {
        let rows = self.fetch(&CypherStatement::new(
            "MATCH (n) WHERE n.id IS NOT NULL RETURN count(n) AS total",
        ))?;
        Ok(rows
            .first()
            .and_then(|row| row.get::<i64>("total").ok())
            .unwrap_or(0)
            .max(0) as usize)
    }

    fn relationship_count(&self) -> Result<usize> {
        let rows = self.fetch(&CypherStatement::new(
            "MATCH ()-[r]->() RETURN count(r) AS total",
        ))?;
        Ok(rows
            .first()
            .and_then(|row| row.get::<i64>("total").ok())
            .unwrap_or(0)
            .max(0) as usize)
    }
}

impl GraphStore for Neo4jGraph {
    fn backend_name(&self) -> &'static str {
        "neo4j"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_refuses_to_invent_credentials() {
        // Nothing in this module supplies a default password or URI.
        let source = include_str!("neo4j.rs");
        assert!(!source.contains("bolt://localhost:7687\""));
        assert!(!source.to_lowercase().contains("password: \"neo4j\""));
    }
}
