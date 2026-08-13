//! # nexus-ontology
//!
//! What NEXUS knows, independent of where it is stored.
//!
//! - [`model`] — entity kinds, relationship kinds, temporal facts, provenance
//! - [`store`] — the storage ports (`GraphReader`, `GraphWriter`, `GraphStore`)
//! - [`resolution`] — the deterministic entity-resolution pipeline
//!
//! ## Hard architectural rule
//!
//! **No graph database appears anywhere in this crate.** No driver, no
//! connection string, no Cypher, no vendor row type. Substituting Memgraph
//! for Neo4j, or either for something else, is a change confined to
//! `nexus-graph`. CI enforces this with a source-level gate rather than a
//! code review convention.

#![forbid(unsafe_code)]

pub mod model;
pub mod resolution;
pub mod store;

pub use model::{
    Entity, EntityKind, Provenance, RelationKind, Relationship, TemporalFact,
};
pub use resolution::{
    merge_audit, normalize_detection, normalize_key, normalize_telemetry, pipeline_for_telemetry,
    provenance_from, resolve, resolve_conflict, score_candidate, to_mutations, ConflictWinner,
    MatchRule, MatchScore, MergeAudit, NormalizedRecord, PropertyConflict, ResolutionOutcome,
    AUTO_MERGE_THRESHOLD, REVIEW_THRESHOLD,
};
pub use store::{GraphMutation, GraphReader, GraphStore, GraphWriter, LineageStep, Neighbor};
