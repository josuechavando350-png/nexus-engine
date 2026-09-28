use crate::{
    AdapterCapability, Address, CapabilityScope, ChainDomain, DeploymentKey, EvidenceRef, Hash32,
    ObservationSemantics, ProtocolFamily, StateAnchor,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};

const UNIVERSE_DOMAIN: &[u8] = b"NQC-CENSUS-DEPLOYMENT-UNIVERSE-V1";
const ADMISSION_DOMAIN: &[u8] = b"NQC-CENSUS-DEPLOYMENT-ADMISSION-V1";

const ALL_CAPABILITIES: [AdapterCapability; 10] = [
    AdapterCapability::MarketDiscovery,
    AdapterCapability::StateReconstruction,
    AdapterCapability::PositionDiscovery,
    AdapterCapability::OracleObservation,
    AdapterCapability::TokenAdmission,
    AdapterCapability::CapitalCensus,
    AdapterCapability::RouteQuotation,
    AdapterCapability::ExecutionSimulation,
    AdapterCapability::CompetitionObservation,
    AdapterCapability::EconomicClassification,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DiscoveryRootKind {
    AaveAddressesProvider,
    V2Factory,
}

impl DiscoveryRootKind {
    const fn tag(self) -> u8 {
        match self {
            Self::AaveAddressesProvider => 1,
            Self::V2Factory => 2,
        }
    }

    fn supports(self, protocol: ProtocolFamily) -> bool {
        match self {
            Self::AaveAddressesProvider => matches!(
                protocol,
                ProtocolFamily::AaveV2 | ProtocolFamily::AaveV3 | ProtocolFamily::AaveV4
            ),
            Self::V2Factory => protocol == ProtocolFamily::UniswapV2,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DiscoveryRoot {
    kind: DiscoveryRootKind,
    address: Address,
}

impl DiscoveryRoot {
    pub const fn new(kind: DiscoveryRootKind, address: Address) -> Self {
        Self { kind, address }
    }

    pub const fn kind(&self) -> DiscoveryRootKind {
        self.kind
    }

    pub const fn address(&self) -> Address {
        self.address
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BlockWindow {
    first: u64,
    last: u64,
}

impl BlockWindow {
    pub fn new(first: u64, last: u64) -> Result<Self, DeploymentRegistryError> {
        if first == 0 || last == 0 {
            return Err(DeploymentRegistryError::ZeroBlockWindow);
        }
        if first > last {
            return Err(DeploymentRegistryError::InvalidBlockWindow { first, last });
        }
        Ok(Self { first, last })
    }

    pub const fn first(&self) -> u64 {
        self.first
    }

    pub const fn last(&self) -> u64 {
        self.last
    }

    pub const fn contains(&self, block: u64) -> bool {
        block >= self.first && block <= self.last
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UniverseScope {
    chain: ChainDomain,
    protocol: ProtocolFamily,
    discovery_roots: BTreeSet<DiscoveryRoot>,
    creation_window: BlockWindow,
    observation_window: BlockWindow,
}

impl UniverseScope {
    pub fn new(
        chain: ChainDomain,
        protocol: ProtocolFamily,
        roots: Vec<DiscoveryRoot>,
        creation_window: BlockWindow,
        observation_window: BlockWindow,
    ) -> Result<Self, DeploymentRegistryError> {
        let discovery_roots = roots.into_iter().collect::<BTreeSet<_>>();
        if discovery_roots.is_empty() {
            return Err(DeploymentRegistryError::EmptyDiscoveryRoots);
        }
        if discovery_roots
            .iter()
            .any(|root| !root.kind().supports(protocol))
        {
            return Err(DeploymentRegistryError::DiscoveryRootProtocolMismatch);
        }
        if creation_window.last() > observation_window.last() {
            return Err(DeploymentRegistryError::CreationWindowAfterObservationWindow);
        }
        Ok(Self {
            chain,
            protocol,
            discovery_roots,
            creation_window,
            observation_window,
        })
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn protocol(&self) -> ProtocolFamily {
        self.protocol
    }

    pub fn discovery_roots(&self) -> &BTreeSet<DiscoveryRoot> {
        &self.discovery_roots
    }

    pub const fn creation_window(&self) -> BlockWindow {
        self.creation_window
    }

    pub const fn observation_window(&self) -> BlockWindow {
        self.observation_window
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        push_chain(&mut out, &self.chain);
        out.extend_from_slice(&self.protocol.tag().to_be_bytes());
        out.extend_from_slice(&self.creation_window.first().to_be_bytes());
        out.extend_from_slice(&self.creation_window.last().to_be_bytes());
        out.extend_from_slice(&self.observation_window.first().to_be_bytes());
        out.extend_from_slice(&self.observation_window.last().to_be_bytes());
        out.extend_from_slice(&(self.discovery_roots.len() as u32).to_be_bytes());
        for root in &self.discovery_roots {
            out.push(root.kind().tag());
            out.extend_from_slice(root.address().as_bytes());
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct UniverseId([u8; 32]);

impl UniverseId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeclaredUniverse {
    scopes: BTreeMap<(ChainDomain, ProtocolFamily), UniverseScope>,
    id: UniverseId,
}

impl DeclaredUniverse {
    pub fn new(scopes: Vec<UniverseScope>) -> Result<Self, DeploymentRegistryError> {
        if scopes.is_empty() {
            return Err(DeploymentRegistryError::EmptyUniverse);
        }
        let mut by_scope = BTreeMap::new();
        for scope in scopes {
            let key = (scope.chain().clone(), scope.protocol());
            if by_scope.insert(key, scope).is_some() {
                return Err(DeploymentRegistryError::DuplicateUniverseScope);
            }
        }
        let id = UniverseId(domain_hash(
            UNIVERSE_DOMAIN,
            &canonical_universe_bytes(&by_scope),
        ));
        Ok(Self {
            scopes: by_scope,
            id,
        })
    }

    pub const fn id(&self) -> UniverseId {
        self.id
    }

    pub fn scopes(&self) -> impl Iterator<Item = &UniverseScope> {
        self.scopes.values()
    }

    pub fn scope(&self, chain: &ChainDomain, protocol: ProtocolFamily) -> Option<&UniverseScope> {
        self.scopes.get(&(chain.clone(), protocol))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProxyKind {
    Direct,
    Transparent,
    Uups,
    Beacon,
    ExplicitOther,
}

impl ProxyKind {
    const fn tag(self) -> u8 {
        match self {
            Self::Direct => 1,
            Self::Transparent => 2,
            Self::Uups => 3,
            Self::Beacon => 4,
            Self::ExplicitOther => 5,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DeploymentLifeState {
    Active,
    Paused,
    Deprecated,
    Removed,
}

impl DeploymentLifeState {
    const fn tag(self) -> u8 {
        match self {
            Self::Active => 1,
            Self::Paused => 2,
            Self::Deprecated => 3,
            Self::Removed => 4,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityAdmission {
    states: BTreeMap<AdapterCapability, bool>,
}

impl CapabilityAdmission {
    pub fn new(entries: Vec<(AdapterCapability, bool)>) -> Result<Self, DeploymentRegistryError> {
        let mut states = BTreeMap::new();
        for (capability, supported) in entries {
            if states.insert(capability, supported).is_some() {
                return Err(DeploymentRegistryError::DuplicateCapabilityState);
            }
        }
        if states.len() != ALL_CAPABILITIES.len()
            || ALL_CAPABILITIES
                .iter()
                .any(|capability| !states.contains_key(capability))
        {
            return Err(DeploymentRegistryError::IncompleteCapabilityState);
        }
        Ok(Self { states })
    }

    pub fn supports(&self, capability: AdapterCapability) -> bool {
        self.states.get(&capability).copied().unwrap_or(false)
    }

    pub fn iter(&self) -> impl Iterator<Item = (AdapterCapability, bool)> + '_ {
        self.states
            .iter()
            .map(|(capability, supported)| (*capability, *supported))
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(ALL_CAPABILITIES.len() * 2);
        for capability in ALL_CAPABILITIES {
            out.push(capability_tag(capability));
            out.push(u8::from(self.supports(capability)));
        }
        out
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupportedSemanticsProfile {
    scope: CapabilityScope,
    proxy_kind: ProxyKind,
    deployment_code_hash: Hash32,
    implementation_code_hash: Hash32,
    configuration_hash: Hash32,
    oracle_configuration_hash: Hash32,
    capabilities: CapabilityAdmission,
}

impl SupportedSemanticsProfile {
    pub const fn new(
        scope: CapabilityScope,
        proxy_kind: ProxyKind,
        deployment_code_hash: Hash32,
        implementation_code_hash: Hash32,
        configuration_hash: Hash32,
        oracle_configuration_hash: Hash32,
        capabilities: CapabilityAdmission,
    ) -> Self {
        Self {
            scope,
            proxy_kind,
            deployment_code_hash,
            implementation_code_hash,
            configuration_hash,
            oracle_configuration_hash,
            capabilities,
        }
    }

    pub const fn scope(&self) -> &CapabilityScope {
        &self.scope
    }

    pub const fn proxy_kind(&self) -> ProxyKind {
        self.proxy_kind
    }

    pub const fn deployment_code_hash(&self) -> Hash32 {
        self.deployment_code_hash
    }

    pub const fn implementation_code_hash(&self) -> Hash32 {
        self.implementation_code_hash
    }

    pub const fn configuration_hash(&self) -> Hash32 {
        self.configuration_hash
    }

    pub const fn oracle_configuration_hash(&self) -> Hash32 {
        self.oracle_configuration_hash
    }

    pub const fn capabilities(&self) -> &CapabilityAdmission {
        &self.capabilities
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentBinding {
    deployment: DeploymentKey,
    discovery_root: DiscoveryRoot,
    creation_anchor: StateAnchor,
    observation_anchor: StateAnchor,
    proxy_kind: ProxyKind,
    implementation_address: Address,
    implementation_code_hash: Hash32,
    semantics: ObservationSemantics,
    oracle_configuration_hash: Hash32,
    semantics_version: u32,
    life_state: DeploymentLifeState,
    capabilities: CapabilityAdmission,
    evidence_refs: Vec<EvidenceRef>,
}

impl DeploymentBinding {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        deployment: DeploymentKey,
        discovery_root: DiscoveryRoot,
        creation_anchor: StateAnchor,
        observation_anchor: StateAnchor,
        proxy_kind: ProxyKind,
        implementation_address: Address,
        implementation_code_hash: Hash32,
        semantics: ObservationSemantics,
        oracle_configuration_hash: Hash32,
        semantics_version: u32,
        life_state: DeploymentLifeState,
        capabilities: CapabilityAdmission,
        mut evidence_refs: Vec<EvidenceRef>,
    ) -> Result<Self, DeploymentRegistryError> {
        if semantics_version == 0 {
            return Err(DeploymentRegistryError::ZeroSemanticsVersion);
        }
        if creation_anchor.chain() != deployment.chain()
            || observation_anchor.chain() != deployment.chain()
        {
            return Err(DeploymentRegistryError::AnchorChainMismatch);
        }
        if creation_anchor.block_number() > observation_anchor.block_number() {
            return Err(DeploymentRegistryError::CreationAfterObservation);
        }
        match proxy_kind {
            ProxyKind::Direct if implementation_address != deployment.address() => {
                return Err(DeploymentRegistryError::DirectImplementationMismatch)
            }
            ProxyKind::Direct if implementation_code_hash != semantics.code_hash() => {
                return Err(DeploymentRegistryError::DirectCodeHashMismatch)
            }
            ProxyKind::Direct => {}
            _ if implementation_address == deployment.address() => {
                return Err(DeploymentRegistryError::ProxyImplementationMustDiffer)
            }
            _ => {}
        }
        evidence_refs.sort_unstable();
        evidence_refs.dedup();
        if evidence_refs.is_empty() {
            return Err(DeploymentRegistryError::MissingAdmissionEvidence);
        }
        Ok(Self {
            deployment,
            discovery_root,
            creation_anchor,
            observation_anchor,
            proxy_kind,
            implementation_address,
            implementation_code_hash,
            semantics,
            oracle_configuration_hash,
            semantics_version,
            life_state,
            capabilities,
            evidence_refs,
        })
    }

    pub const fn deployment(&self) -> &DeploymentKey {
        &self.deployment
    }

    pub const fn discovery_root(&self) -> DiscoveryRoot {
        self.discovery_root
    }

    pub const fn creation_anchor(&self) -> &StateAnchor {
        &self.creation_anchor
    }

    pub const fn observation_anchor(&self) -> &StateAnchor {
        &self.observation_anchor
    }

    pub const fn proxy_kind(&self) -> ProxyKind {
        self.proxy_kind
    }

    pub const fn implementation_address(&self) -> Address {
        self.implementation_address
    }

    pub const fn implementation_code_hash(&self) -> Hash32 {
        self.implementation_code_hash
    }

    pub const fn semantics(&self) -> ObservationSemantics {
        self.semantics
    }

    pub const fn oracle_configuration_hash(&self) -> Hash32 {
        self.oracle_configuration_hash
    }

    pub const fn semantics_version(&self) -> u32 {
        self.semantics_version
    }

    pub const fn life_state(&self) -> DeploymentLifeState {
        self.life_state
    }

    pub const fn capabilities(&self) -> &CapabilityAdmission {
        &self.capabilities
    }

    pub fn evidence_refs(&self) -> &[EvidenceRef] {
        &self.evidence_refs
    }

    fn semantics_fingerprint(&self) -> [u8; 32] {
        semantics_fingerprint(
            self.proxy_kind,
            self.semantics.code_hash(),
            self.implementation_code_hash,
            self.semantics.configuration_hash(),
            self.oracle_configuration_hash,
            &self.capabilities,
        )
    }

    fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::new();
        push_deployment(&mut out, &self.deployment);
        out.push(self.discovery_root.kind().tag());
        out.extend_from_slice(self.discovery_root.address().as_bytes());
        push_anchor(&mut out, &self.creation_anchor);
        push_anchor(&mut out, &self.observation_anchor);
        out.push(self.proxy_kind.tag());
        out.extend_from_slice(self.implementation_address.as_bytes());
        out.extend_from_slice(self.implementation_code_hash.as_bytes());
        out.extend_from_slice(self.semantics.code_hash().as_bytes());
        out.extend_from_slice(self.semantics.configuration_hash().as_bytes());
        out.extend_from_slice(self.oracle_configuration_hash.as_bytes());
        out.extend_from_slice(&self.semantics_version.to_be_bytes());
        out.push(self.life_state.tag());
        out.extend_from_slice(&self.capabilities.canonical_bytes());
        out.extend_from_slice(&(self.evidence_refs.len() as u32).to_be_bytes());
        for reference in &self.evidence_refs {
            push_evidence_ref(&mut out, *reference);
        }
        out
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct AdmissionId([u8; 32]);

impl AdmissionId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmissionRecord {
    id: AdmissionId,
    universe_id: UniverseId,
    binding: DeploymentBinding,
    supersedes: Option<AdmissionId>,
}

impl AdmissionRecord {
    pub const fn id(&self) -> AdmissionId {
        self.id
    }

    pub const fn universe_id(&self) -> UniverseId {
        self.universe_id
    }

    pub const fn binding(&self) -> &DeploymentBinding {
        &self.binding
    }

    pub const fn supersedes(&self) -> Option<AdmissionId> {
        self.supersedes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionOutcome {
    Created(AdmissionId),
    AlreadyAdmitted(AdmissionId),
}

impl AdmissionOutcome {
    pub const fn id(self) -> AdmissionId {
        match self {
            Self::Created(id) | Self::AlreadyAdmitted(id) => id,
        }
    }
}

#[derive(Debug)]
pub struct DeploymentRegistry {
    universe: DeclaredUniverse,
    profiles: BTreeMap<CapabilityScope, SupportedSemanticsProfile>,
    records: BTreeMap<AdmissionId, AdmissionRecord>,
    active: BTreeMap<DeploymentKey, AdmissionId>,
}

impl DeploymentRegistry {
    pub fn new(universe: DeclaredUniverse) -> Self {
        Self {
            universe,
            profiles: BTreeMap::new(),
            records: BTreeMap::new(),
            active: BTreeMap::new(),
        }
    }

    pub const fn universe(&self) -> &DeclaredUniverse {
        &self.universe
    }

    pub fn declare_supported_semantics(
        &mut self,
        profile: SupportedSemanticsProfile,
    ) -> Result<(), DeploymentRegistryError> {
        if self
            .universe
            .scope(profile.scope().chain(), profile.scope().protocol())
            .is_none()
        {
            return Err(DeploymentRegistryError::UndeclaredUniverseScope);
        }
        let key = profile.scope().clone();
        match self.profiles.get(&key) {
            Some(existing) if existing == &profile => Ok(()),
            Some(_) => Err(DeploymentRegistryError::ConflictingSemanticsProfile),
            None => {
                self.profiles.insert(key, profile);
                Ok(())
            }
        }
    }

    pub fn active_record(&self, deployment: &DeploymentKey) -> Option<&AdmissionRecord> {
        self.active
            .get(deployment)
            .and_then(|id| self.records.get(id))
    }

    pub fn record(&self, id: AdmissionId) -> Option<&AdmissionRecord> {
        self.records.get(&id)
    }

    pub fn admit(
        &mut self,
        binding: DeploymentBinding,
        supersedes: Option<AdmissionId>,
    ) -> Result<AdmissionOutcome, DeploymentRegistryError> {
        let scope = self
            .universe
            .scope(
                binding.deployment().chain(),
                binding.deployment().protocol(),
            )
            .ok_or(DeploymentRegistryError::UndeclaredUniverseScope)?;

        if !scope.discovery_roots().contains(&binding.discovery_root()) {
            return Err(DeploymentRegistryError::UndeclaredDiscoveryRoot);
        }
        if !scope
            .creation_window()
            .contains(binding.creation_anchor().block_number())
        {
            return Err(DeploymentRegistryError::CreationOutsideDeclaredWindow);
        }
        if !scope
            .observation_window()
            .contains(binding.observation_anchor().block_number())
        {
            return Err(DeploymentRegistryError::ObservationOutsideDeclaredWindow);
        }

        let capability_scope = CapabilityScope::new(
            binding.deployment().chain().clone(),
            binding.deployment().protocol(),
            binding.semantics_version(),
        )
        .map_err(|_| DeploymentRegistryError::ZeroSemanticsVersion)?;
        let profile = self
            .profiles
            .get(&capability_scope)
            .ok_or(DeploymentRegistryError::UnsupportedDeploymentSemantics)?;
        validate_profile(profile, &binding)?;

        let universe_id = self.universe.id();
        let id = AdmissionId(domain_hash(
            ADMISSION_DOMAIN,
            &canonical_admission_bytes(universe_id, &binding, supersedes),
        ));
        if let Some(existing) = self.records.get(&id) {
            if existing.binding() == &binding && existing.supersedes() == supersedes {
                return Ok(AdmissionOutcome::AlreadyAdmitted(id));
            }
            return Err(DeploymentRegistryError::AdmissionHashCollision);
        }

        let active = self.active_record(binding.deployment()).cloned();
        if let Some(previous) = &active {
            if previous.binding().life_state() == DeploymentLifeState::Removed {
                return Err(DeploymentRegistryError::RemovedDeploymentIsTerminal);
            }
            if binding.creation_anchor() != previous.binding().creation_anchor() {
                return Err(DeploymentRegistryError::CreationAnchorChanged);
            }
            if binding.observation_anchor().block_number()
                <= previous.binding().observation_anchor().block_number()
            {
                return Err(DeploymentRegistryError::NonMonotonicObservation);
            }
            if binding.semantics_version() < previous.binding().semantics_version() {
                return Err(DeploymentRegistryError::NonMonotonicSemanticsVersion);
            }
            let semantic_change =
                binding.semantics_fingerprint() != previous.binding().semantics_fingerprint();
            if semantic_change
                && binding.semantics_version() <= previous.binding().semantics_version()
            {
                return Err(DeploymentRegistryError::SemanticChangeRequiresVersionIncrease);
            }
            if supersedes != Some(previous.id()) {
                return Err(DeploymentRegistryError::UpgradeEvidenceRequired {
                    expected: previous.id(),
                    actual: supersedes,
                });
            }
        } else if supersedes.is_some() {
            return Err(DeploymentRegistryError::UnexpectedSupersedes);
        }

        let record = AdmissionRecord {
            id,
            universe_id,
            binding,
            supersedes,
        };
        let deployment = record.binding().deployment().clone();
        self.records.insert(id, record);
        self.active.insert(deployment, id);
        Ok(AdmissionOutcome::Created(id))
    }

    pub fn records(&self) -> impl Iterator<Item = &AdmissionRecord> {
        self.records.values()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeploymentRegistryError {
    ZeroBlockWindow,
    InvalidBlockWindow {
        first: u64,
        last: u64,
    },
    EmptyDiscoveryRoots,
    DiscoveryRootProtocolMismatch,
    CreationWindowAfterObservationWindow,
    EmptyUniverse,
    DuplicateUniverseScope,
    DuplicateCapabilityState,
    IncompleteCapabilityState,
    ZeroSemanticsVersion,
    AnchorChainMismatch,
    CreationAfterObservation,
    DirectImplementationMismatch,
    DirectCodeHashMismatch,
    ProxyImplementationMustDiffer,
    MissingAdmissionEvidence,
    UndeclaredUniverseScope,
    ConflictingSemanticsProfile,
    UndeclaredDiscoveryRoot,
    CreationOutsideDeclaredWindow,
    ObservationOutsideDeclaredWindow,
    UnsupportedDeploymentSemantics,
    SemanticsFingerprintMismatch,
    CapabilityStateMismatch,
    UpgradeEvidenceRequired {
        expected: AdmissionId,
        actual: Option<AdmissionId>,
    },
    UnexpectedSupersedes,
    CreationAnchorChanged,
    NonMonotonicObservation,
    NonMonotonicSemanticsVersion,
    SemanticChangeRequiresVersionIncrease,
    RemovedDeploymentIsTerminal,
    AdmissionHashCollision,
}

impl Display for DeploymentRegistryError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroBlockWindow => formatter.write_str("block window cannot contain zero"),
            Self::InvalidBlockWindow { first, last } => {
                write!(formatter, "invalid block window {first}..={last}")
            }
            Self::EmptyDiscoveryRoots => formatter.write_str("discovery roots cannot be empty"),
            Self::DiscoveryRootProtocolMismatch => {
                formatter.write_str("discovery root is incompatible with protocol family")
            }
            Self::CreationWindowAfterObservationWindow => {
                formatter.write_str("creation window cannot extend beyond observation window")
            }
            Self::EmptyUniverse => formatter.write_str("declared universe cannot be empty"),
            Self::DuplicateUniverseScope => {
                formatter.write_str("duplicate chain/protocol universe scope")
            }
            Self::DuplicateCapabilityState => {
                formatter.write_str("duplicate capability admission state")
            }
            Self::IncompleteCapabilityState => formatter
                .write_str("every adapter capability must be explicitly supported or unsupported"),
            Self::ZeroSemanticsVersion => {
                formatter.write_str("protocol semantics version must not be zero")
            }
            Self::AnchorChainMismatch => {
                formatter.write_str("deployment observation anchor belongs to another chain domain")
            }
            Self::CreationAfterObservation => {
                formatter.write_str("deployment creation anchor is after observation anchor")
            }
            Self::DirectImplementationMismatch => formatter
                .write_str("direct deployment implementation must equal deployment address"),
            Self::DirectCodeHashMismatch => formatter
                .write_str("direct deployment runtime and implementation code hashes must match"),
            Self::ProxyImplementationMustDiffer => formatter.write_str(
                "proxy implementation address must differ from proxy deployment address",
            ),
            Self::MissingAdmissionEvidence => {
                formatter.write_str("deployment admission requires content-addressed evidence")
            }
            Self::UndeclaredUniverseScope => {
                formatter.write_str("chain/protocol scope is outside declared universe")
            }
            Self::ConflictingSemanticsProfile => {
                formatter.write_str("conflicting supported semantics profile")
            }
            Self::UndeclaredDiscoveryRoot => {
                formatter.write_str("deployment was not bound to a declared discovery root")
            }
            Self::CreationOutsideDeclaredWindow => {
                formatter.write_str("deployment creation is outside declared window")
            }
            Self::ObservationOutsideDeclaredWindow => {
                formatter.write_str("deployment observation is outside declared window")
            }
            Self::UnsupportedDeploymentSemantics => {
                formatter.write_str("no supported semantics profile matches this version")
            }
            Self::SemanticsFingerprintMismatch => formatter
                .write_str("observed code/config/proxy fingerprint is not explicitly supported"),
            Self::CapabilityStateMismatch => formatter
                .write_str("observed deployment capability state differs from admitted profile"),
            Self::UpgradeEvidenceRequired { expected, actual } => {
                write!(
                    formatter,
                    "transition must explicitly supersede {} but got {}",
                    expected.to_hex(),
                    actual
                        .map(|value| value.to_hex())
                        .unwrap_or_else(|| "NONE".to_owned())
                )
            }
            Self::UnexpectedSupersedes => {
                formatter.write_str("first admission cannot supersede another record")
            }
            Self::CreationAnchorChanged => formatter
                .write_str("deployment creation anchor is immutable across admission epochs"),
            Self::NonMonotonicObservation => {
                formatter.write_str("deployment observations must advance block height")
            }
            Self::NonMonotonicSemanticsVersion => {
                formatter.write_str("semantics version must never decrease")
            }
            Self::SemanticChangeRequiresVersionIncrease => formatter
                .write_str("semantic fingerprint changed without increasing semantics version"),
            Self::RemovedDeploymentIsTerminal => {
                formatter.write_str("removed deployment identity cannot be revived")
            }
            Self::AdmissionHashCollision => {
                formatter.write_str("admission id collision with different canonical record")
            }
        }
    }
}

impl std::error::Error for DeploymentRegistryError {}

fn validate_profile(
    profile: &SupportedSemanticsProfile,
    binding: &DeploymentBinding,
) -> Result<(), DeploymentRegistryError> {
    if profile.proxy_kind() != binding.proxy_kind()
        || profile.deployment_code_hash() != binding.semantics().code_hash()
        || profile.implementation_code_hash() != binding.implementation_code_hash()
        || profile.configuration_hash() != binding.semantics().configuration_hash()
        || profile.oracle_configuration_hash() != binding.oracle_configuration_hash()
    {
        return Err(DeploymentRegistryError::SemanticsFingerprintMismatch);
    }
    if profile.capabilities() != binding.capabilities() {
        return Err(DeploymentRegistryError::CapabilityStateMismatch);
    }
    Ok(())
}

fn canonical_universe_bytes(
    scopes: &BTreeMap<(ChainDomain, ProtocolFamily), UniverseScope>,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(scopes.len() as u32).to_be_bytes());
    for scope in scopes.values() {
        let bytes = scope.canonical_bytes();
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(&bytes);
    }
    out
}

fn canonical_admission_bytes(
    universe_id: UniverseId,
    binding: &DeploymentBinding,
    supersedes: Option<AdmissionId>,
) -> Vec<u8> {
    let binding_bytes = binding.canonical_bytes();
    let mut out = Vec::new();
    out.extend_from_slice(universe_id.as_bytes());
    out.extend_from_slice(&(binding_bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(&binding_bytes);
    match supersedes {
        Some(id) => {
            out.push(1);
            out.extend_from_slice(id.as_bytes());
        }
        None => out.push(0),
    }
    out
}

fn semantics_fingerprint(
    proxy_kind: ProxyKind,
    deployment_code_hash: Hash32,
    implementation_code_hash: Hash32,
    configuration_hash: Hash32,
    oracle_configuration_hash: Hash32,
    capabilities: &CapabilityAdmission,
) -> [u8; 32] {
    let mut bytes = Vec::new();
    bytes.push(proxy_kind.tag());
    bytes.extend_from_slice(deployment_code_hash.as_bytes());
    bytes.extend_from_slice(implementation_code_hash.as_bytes());
    bytes.extend_from_slice(configuration_hash.as_bytes());
    bytes.extend_from_slice(oracle_configuration_hash.as_bytes());
    bytes.extend_from_slice(&capabilities.canonical_bytes());
    domain_hash(b"NQC-CENSUS-DEPLOYMENT-SEMANTICS-V1", &bytes)
}

fn push_chain(out: &mut Vec<u8>, chain: &ChainDomain) {
    out.extend_from_slice(&chain.chain_id().to_be_bytes());
    out.extend_from_slice(chain.genesis_hash().as_bytes());
    out.extend_from_slice(chain.fork_lineage().as_bytes());
}

fn push_deployment(out: &mut Vec<u8>, deployment: &DeploymentKey) {
    push_chain(out, deployment.chain());
    out.extend_from_slice(&deployment.protocol().tag().to_be_bytes());
    out.extend_from_slice(deployment.address().as_bytes());
    out.extend_from_slice(deployment.deployment_instance().as_bytes());
}

fn push_anchor(out: &mut Vec<u8>, anchor: &StateAnchor) {
    push_chain(out, anchor.chain());
    out.extend_from_slice(&anchor.block_number().to_be_bytes());
    out.extend_from_slice(anchor.block_hash().as_bytes());
    out.extend_from_slice(anchor.parent_hash().as_bytes());
    out.extend_from_slice(&anchor.timestamp().to_be_bytes());
    out.extend_from_slice(anchor.state_root().as_bytes());
}

fn push_evidence_ref(out: &mut Vec<u8>, reference: EvidenceRef) {
    match reference {
        EvidenceRef::Observation(value) => {
            out.push(1);
            out.extend_from_slice(value.as_bytes());
        }
        EvidenceRef::Artifact(value) => {
            out.push(2);
            out.extend_from_slice(value.as_bytes());
        }
    }
}

fn capability_tag(capability: AdapterCapability) -> u8 {
    match capability {
        AdapterCapability::MarketDiscovery => 1,
        AdapterCapability::StateReconstruction => 2,
        AdapterCapability::PositionDiscovery => 3,
        AdapterCapability::OracleObservation => 4,
        AdapterCapability::TokenAdmission => 5,
        AdapterCapability::CapitalCensus => 6,
        AdapterCapability::RouteQuotation => 7,
        AdapterCapability::ExecutionSimulation => 8,
        AdapterCapability::CompetitionObservation => 9,
        AdapterCapability::EconomicClassification => 10,
    }
}

fn domain_hash(domain: &[u8], bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(bytes);
    let mut output = [0_u8; 32];
    output.copy_from_slice(&hasher.finalize());
    output
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(HEX[usize::from(byte >> 4)]));
        output.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    output
}
