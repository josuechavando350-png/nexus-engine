//! # nexus-edge-protocol
//!
//! The only thing the orchestrator is allowed to send to a device.
//!
//! ## The central rule
//!
//! **No arbitrary payload ever reaches an edge device.** An [`EdgeTask`]
//! carries an [`EdgeCommand`], which is a closed Rust enum with typed
//! parameters. There is no "raw bytes", no "script", no "eval" and no
//! escape hatch. Adding a command is a source change that goes through
//! review and through the policy engine's capability allowlist.
//!
//! Every task additionally carries `task_id`, `device_id`, `issued_at`,
//! `expires_at`, `nonce`, `required_capabilities`, `safety_constraints`,
//! `signature` and `signer_id`, and is rejected at the device unless all of
//! them verify.
//!
//! ## Signatures
//!
//! [`Signer`] and [`Verifier`] are traits. The production implementation is
//! Ed25519 behind the `ed25519` feature. The default build ships
//! [`DevSigner`], which is a keyed SHA-256 construction and is **not
//! cryptography**: it refuses to operate outside simulation, and
//! [`SignerRegistry::require_production_signer`] fails closed if a device in
//! `PHYSICAL_NON_WEAPONIZED` mode is presented with a dev-signed task.

#![forbid(unsafe_code)]

pub mod command;
pub mod signing;
pub mod task;

pub use command::{EdgeCommand, FixtureOperation, SafetyConstraint, Waypoint};
pub use signing::{
    DevSigner, NonceLedger, SignatureEnvelope, Signer, SignerRegistry, TrustedSigner, Verifier,
};
pub use task::{EdgeTask, EdgeTaskResult, ExecutionMode, TaskStatus, VerificationError};
