//! # nexus-graph
//!
//! Storage backends for the ontology. This is the only crate in the runtime
//! that is allowed to know a graph database exists.
//!
//! - [`memory::InMemoryGraph`] — default backend, no dependencies, used by
//!   CI and by the offline end-to-end demo.
//! - [`cypher`] — parameterised Cypher generation for Neo4j and Memgraph.
//!   Always compiled, always tested, independent of any driver.
//! - `neo4j` (feature) — the driver-backed adapter built on top of [`cypher`].
//!
//! Swapping the backend is a change to this crate only. Nothing in
//! `nexus-ontology`, `nexus-agent`, `nexus-policy` or the services names a
//! database.

#![forbid(unsafe_code)]

pub mod backend;
pub mod cypher;
pub mod memory;

#[cfg(feature = "neo4j")]
pub mod neo4j;

pub use backend::{GraphBackend, DEFAULT_DATABASE};
pub use cypher::{statement_for, CypherStatement};
pub use memory::{zone_entity, InMemoryGraph};

#[cfg(feature = "neo4j")]
pub use neo4j::{Neo4jConfig, Neo4jGraph};
