//! RMC-007 — reconciled Uniswap V2 discovery.
//!
//! This crate owns no chain truth, identity, admission, evidence storage or
//! checkpoint authority. It consumes D01/D03/D04/D05 plus the shared chain
//! evidence layer and reconciles semantically independent discovery surfaces.

pub mod boundary;
pub mod enumeration;
pub mod history;
mod interface;
pub mod live;
pub mod membership;
mod reconcile;

pub use interface::{
    decode_pair_created, factory_interface, verify_factory_runtime, PairCreatedEvent,
    V2FactoryInterface,
};
pub use reconcile::{
    reconcile, CurrentPair, Delta, DeltaKind, DirectLookupProof, PairCreatedProof, PairManifest,
    Reconciliation, ReconciliationSummary, RuntimeCodeProof,
};

use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DiscoveryError {
    InvalidInterface(&'static str),
    InvalidPair(&'static str),
    ConflictingPairIdentity,
    ConflictingEnumerationIndex,
    ConflictingCreationLog,
    ConflictingDirectLookup,
    DirectLookupMismatch,
    Admission(&'static str),
    Core(String),
    Chain(String),
}

impl Display for DiscoveryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidInterface(reason) => write!(formatter, "invalid V2 interface: {reason}"),
            Self::InvalidPair(reason) => write!(formatter, "invalid V2 pair: {reason}"),
            Self::ConflictingPairIdentity => formatter.write_str("conflicting pair identity"),
            Self::ConflictingEnumerationIndex => {
                formatter.write_str("conflicting allPairs enumeration index")
            }
            Self::ConflictingCreationLog => formatter.write_str("conflicting PairCreated log"),
            Self::ConflictingDirectLookup => formatter.write_str("conflicting getPair proof"),
            Self::DirectLookupMismatch => {
                formatter.write_str("getPair disagrees with discovered pair")
            }
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
