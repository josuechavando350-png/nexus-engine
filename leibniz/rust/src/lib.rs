//! LEIBNIZ: standalone, offline, standard-library-only formal inference nucleus.
//! No internet ingestion, external API, or physical actuation in the library.
//! The fixed-point reasoner supports finite positive Horn rules, typed n-ary facts,
//! reified facts (facts about facts), source provenance and reproducible proofs.

#![forbid(unsafe_code)]

pub mod authorized_ingest;
pub mod axioms;
pub mod gauss_bridge;
pub mod handoff;
pub mod higher_order;
pub mod persistence;
pub mod quantified;
mod reasoning;
#[path = "../models/schema.rs"]
pub mod schema;
pub mod semantic_archive;
pub mod semantics;

pub use reasoning::{
    ArgumentKind, Atom, Decision, Fact, Graph, GraphArchive, Justification, Limits, Pattern,
    PatternTerm, Predicate, ProblemSnapshot, Proof, Rule, Term,
};
pub mod hol;

pub mod finite_model;
pub mod formal_audit;
pub mod operational_gate;
