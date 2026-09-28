//! Canonical, provider-free identity primitives for Real Market Census.
//!
//! This crate deliberately performs no RPC, signing, routing, economics, or
//! execution. It defines stable semantic identities that later Census stages
//! may bind to independently proven observations.

pub mod identity;

pub use identity::{
    count_identities, reconcile_aliases, ActionSurfaceId, ActionSurfaceKey, Address, AliasEvidence,
    CanonicalMarketKey, ChainDomain, DeploymentKey, DeploymentSemanticsVersion, Hash32,
    IdentityCounts, IdentityError, MarketId, MarketStateId, MarketUnit, MigrationEvidence,
    ObservationAnchor, ProtocolFamily, SourceLocator, StrategySemanticsKey,
    IDENTITY_SCHEMA_VERSION,
};
