//! Provider-free semantic primitives for Real Market Census.
//!
//! This crate defines canonical identity, observation/state binding, stage evidence,
//! rejection accounting, and explicit adapter capability declarations. It performs
//! no RPC, signing, routing, pricing, capital allocation, or execution.

pub mod capability;
pub mod deployment;
pub mod identity;
pub mod observation;
pub mod pipeline;

pub use capability::{
    AdapterCapability, AdapterDeclaration, CapabilityError, CapabilityMatrix, CapabilityScope,
    UnsupportedCapability,
};
pub use deployment::{
    AdmissionId, AdmissionOutcome, AdmissionRecord, BlockWindow, CapabilityAdmission,
    DeclaredUniverse, DeploymentBinding, DeploymentLifeState, DeploymentRegistry,
    DeploymentRegistryError, DiscoveryRoot, DiscoveryRootKind, ProxyKind,
    SupportedSemanticsProfile, UniverseId, UniverseScope,
};

pub use identity::{
    count_identities, reconcile_aliases, ActionSurfaceId, ActionSurfaceKey, Address, AliasEvidence,
    CanonicalMarketKey, ChainDomain, DeploymentKey, DeploymentSemanticsVersion, Hash32,
    IdentityCounts, IdentityError, MarketId, MarketStateId, MarketUnit, MigrationEvidence,
    ObservationAnchor, ProtocolFamily, SourceLocator, StrategySemanticsKey,
    IDENTITY_SCHEMA_VERSION,
};
pub use observation::{
    require_same_anchor, AnchorMismatchField, CensusObservation, ObservationDigest,
    ObservationEnvelope, ObservationError, ObservationProvenance, ObservationSemantics,
    ProvenanceAuthority, RawLogEnvelope, StateAnchor,
};
pub use pipeline::{
    BlockerId, CensusStage, CensusUnitId, CensusUnitKind, EvidenceBasis, EvidenceRef,
    PipelineError, RejectionReason, RejectionRecord, RejectionRecordId, StageDecision, StageDomain,
    StageEvidence, StageLedger, StageMetrics, StageRecord,
};
