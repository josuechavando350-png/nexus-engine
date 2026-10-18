//! RMC-004 durable evidence substrate for Real Market Census.
//!
//! * an immutable, deduplicating, content-addressed artifact store with
//!   deterministic content-defined chunking, optional deterministic compression
//!   and two integrity layers (stored frame digest and logical identity);
//! * append-only, crash-safe range checkpoint streams bound to RMC-001 chain and
//!   deployment identity and RMC-003 state anchors, with exact continuity;
//! * resumability from the authoritative catalog, with a HEAD cache that is
//!   rebuilt from it and never trusted over it;
//! * an offline verifier ([`verify::verify_store`]) that needs only the store
//!   directory: no RPC, network, secrets, signer or external service.
//!
//! This crate stores and verifies evidence. It does not discover markets,
//! enumerate positions, evaluate economics, or claim that any stored range is
//! the complete market universe.

mod canonical;
mod checkpoint;
mod chunker;
pub mod codec;
mod config;
mod durable;
mod error;
mod fault;
mod object;
mod scope;
mod store;
pub mod verify;

pub use canonical::STORE_FORMAT_VERSION;
pub use checkpoint::{Checkpoint, CheckpointId, ResumePoint, MAX_EVIDENCE_PER_CHECKPOINT};
pub use config::{
    CompressionPolicy, ConfigId, StoreConfig, ARTIFACT_MAX_CEILING, CHUNK_MAX_CEILING,
    CHUNK_MIN_FLOOR, MAX_CHUNKS_PER_ARTIFACT,
};
pub use error::StoreError;
pub use fault::{FaultHook, FaultPoint};
pub use object::{ArtifactId, ChunkEntry, ChunkId, Manifest};
pub use scope::{ScopeId, StreamKind, StreamScope};
pub use store::{
    CommitOutcome, HeadStatus, PutReport, RangeCertificate, Recovery, RecoveryMode, Store,
};
