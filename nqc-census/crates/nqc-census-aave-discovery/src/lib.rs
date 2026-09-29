//! RMC-006 — reconciled Aave V3 reserve discovery.
//!
//! This crate is a reconciliation adapter only. D01 owns identity, D03 owns
//! observations, D04 owns durable evidence/checkpoints, D05 owns deployment
//! admission, and nqc-census-chain owns acquisition/replay.

mod interface;
mod reconcile;

pub use interface::{
    aave_interface, decode_reserve_dropped, decode_reserve_initialized, AaveDiscoveryInterface,
    ReserveDroppedEvent, ReserveInitializedEvent,
};
pub use reconcile::{
    reconcile, CurrentReserve, Delta, DeltaKind, Reconciliation, ReconciliationSummary,
    ReserveDropProof, ReserveInitProof, ReserveManifest,
};

use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    InvalidInterface(&'static str),
    InvalidReserve(&'static str),
    ConflictingReserveId,
    ConflictingReserveIdentity,
    ConflictingLifecycle,
    Admission(&'static str),
    Core(String),
    Chain(String),
}

impl Display for DiscoveryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInterface(reason) => write!(formatter, "invalid Aave interface: {reason}"),
            Self::InvalidReserve(reason) => write!(formatter, "invalid Aave reserve: {reason}"),
            Self::ConflictingReserveId => formatter.write_str("conflicting reserve id"),
            Self::ConflictingReserveIdentity => formatter.write_str("conflicting reserve identity"),
            Self::ConflictingLifecycle => formatter.write_str("conflicting reserve lifecycle"),
            Self::Admission(reason) => write!(formatter, "deployment admission rejected: {reason}"),
            Self::Core(reason) => write!(formatter, "core error: {reason}"),
            Self::Chain(reason) => write!(formatter, "chain error: {reason}"),
        }
    }
}

impl std::error::Error for DiscoveryError {}

impl From<nqc_census_core::IdentityError> for DiscoveryError {
    fn from(value: nqc_census_core::IdentityError) -> Self {
        Self::Core(value.to_string())
    }
}

impl From<nqc_census_chain::ChainError> for DiscoveryError {
    fn from(value: nqc_census_chain::ChainError) -> Self {
        Self::Chain(value.to_string())
    }
}
