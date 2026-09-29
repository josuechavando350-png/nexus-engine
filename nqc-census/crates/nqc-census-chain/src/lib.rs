//! Protocol-agnostic chain-evidence acquisition for Real Market Census.
//!
//! Remote JSON-RPC providers only transport canonical chain data. This crate
//! turns their replies into RMC-003 typed observations (headers re-hashed from
//! canonical RLP, block-pinned code and calls, strictly decoded logs),
//! persists every exchange and observation in the RMC-004 store, drives
//! resumable jobs and window-checkpointed log scans through RMC-004
//! checkpoints, and compares providers without ever voting a disagreement
//! away. It contains no protocol semantics, signer, or transaction submission.

pub mod abi;
pub mod acquire;
pub mod boundary;
pub mod catalog;
pub mod consensus;
pub mod error;
pub mod ethereum;
pub mod evm;
pub mod hex;
pub mod job;
pub mod json;
pub mod provider;
pub mod rpc;
pub mod testkit;
pub mod transport;

pub use error::ChainError;
