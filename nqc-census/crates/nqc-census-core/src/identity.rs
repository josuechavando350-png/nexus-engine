use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt::{Display, Formatter};

pub const IDENTITY_SCHEMA_VERSION: u16 = 1;

const MAGIC: &[u8] = b"NQC-CENSUS-ID";
const CHAIN_KIND: u8 = 0x01;
const DEPLOYMENT_KIND: u8 = 0x02;
const ANCHOR_KIND: u8 = 0x03;
const SEMANTICS_KIND: u8 = 0x04;
const STRATEGY_KIND: u8 = 0x05;
const MARKET_KIND: u8 = 0x10;
const ACTION_KIND: u8 = 0x11;
const STATE_KIND: u8 = 0x12;

const MARKET_DOMAIN: &[u8] = b"NQC-CENSUS-MARKET-ID-V1";
const STATE_DOMAIN: &[u8] = b"NQC-CENSUS-MARKET-STATE-ID-V1";
const ACTION_DOMAIN: &[u8] = b"NQC-CENSUS-ACTION-SURFACE-ID-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityError {
    InvalidHexLength { expected: usize, actual: usize },
    InvalidHexCharacter { index: usize },
    InvalidInteger,
    ZeroValue(&'static str),
    UnknownSchemaVersion(u16),
    UnexpectedObjectKind { expected: u8, actual: u8 },
    MalformedEncoding(&'static str),
    FieldTooLarge,
    InvalidProtocolFamily(u16),
    InvalidMarketVariant(u8),
    ProtocolMarketMismatch,
    ContradictoryV2Pair,
    SameActionAssets,
    InvalidStrategy,
    AliasConflict,
    MigrationSelfReference,
    HashCollision,
    UnknownMarketReference,
}

impl Display for IdentityError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidHexLength { expected, actual } => {
                write!(f, "invalid hex length: expected {expected} bytes, got {actual}")
            }
            Self::InvalidHexCharacter { index } => write!(f, "invalid hex character at {index}"),
            Self::InvalidInteger => f.write_str("invalid or overflowing integer"),
            Self::ZeroValue(name) => write!(f, "{name} must not be zero"),
            Self::UnknownSchemaVersion(v) => write!(f, "unknown identity schema version {v}"),
            Self::UnexpectedObjectKind { expected, actual } => {
                write!(f, "unexpected object kind {actual:#04x}; expected {expected:#04x}")
            }
            Self::MalformedEncoding(reason) => write!(f, "malformed encoding: {reason}"),
            Self::FieldTooLarge => f.write_str("canonical field exceeds u32 length"),
            Self::InvalidProtocolFamily(tag) => write!(f, "invalid protocol family {tag:#06x}"),
            Self::InvalidMarketVariant(tag) => write!(f, "invalid market variant {tag:#04x}"),
            Self::ProtocolMarketMismatch => f.write_str("market/protocol mismatch"),
            Self::ContradictoryV2Pair => f.write_str("contradictory V2 pair identity"),
            Self::SameActionAssets => f.write_str("collateral and debt assets must differ"),
            Self::InvalidStrategy => f.write_str("invalid strategy semantics"),
            Self::AliasConflict => f.write_str("alias source maps to conflicting markets"),
            Self::MigrationSelfReference => f.write_str("migration source equals destination"),
            Self::HashCollision => f.write_str("semantic ID collision with different bytes"),
            Self::UnknownMarketReference => f.write_str("action references absent base market"),
        }
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Address([u8; 20]);

impl Address {
    pub fn new(bytes: [u8; 20]) -> Result<Self, IdentityError> {
        if bytes == [0; 20] {
            return Err(IdentityError::ZeroValue("address"));
        }
        Ok(Self(bytes))
    }

    pub fn parse_hex(value: &str) -> Result<Self, IdentityError> {
        Self::new(parse_fixed_hex::<20>(value)?)
    }

    pub const fn as_bytes(&self) -> &[u8; 20] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        format!("0x{}", hex_encode(&self.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hash32([u8; 32]);

impl Hash32 {
    pub fn new(bytes: [u8; 32]) -> Result<Self, IdentityError> {
        if bytes == [0; 32] {
            return Err(IdentityError::ZeroValue("hash32"));
        }
        Ok(Self(bytes))
    }

    pub fn parse_hex(value: &str) -> Result<Self, IdentityError> {
        Self::new(parse_fixed_hex::<32>(value)?)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        format!("0x{}", hex_encode(&self.0))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProtocolFamily {
    AaveV2,
    AaveV3,
    AaveV4,
    UniswapV2,
}

impl ProtocolFamily {
    pub const fn tag(self) -> u16 {
        match self {
            Self::AaveV2 => 0x0102,
            Self::AaveV3 => 0x0103,
            Self::AaveV4 => 0x0104,
            Self::UniswapV2 => 0x0202,
        }
    }

    const fn is_aave(self) -> bool {
        matches!(self, Self::AaveV2 | Self::AaveV3 | Self::AaveV4)
    }

    fn from_tag(tag: u16) -> Result<Self, IdentityError> {
        match tag {
            0x0102 => Ok(Self::AaveV2),
            0x0103 => Ok(Self::AaveV3),
            0x0104 => Ok(Self::AaveV4),
            0x0202 => Ok(Self::UniswapV2),
            other => Err(IdentityError::InvalidProtocolFamily(other)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChainDomain {
    chain_id: u64,
    genesis_hash: Hash32,
    fork_lineage: Hash32,
}

impl ChainDomain {
    pub fn new(
        chain_id: u64,
        genesis_hash: Hash32,
        fork_lineage: Hash32,
    ) -> Result<Self, IdentityError> {
        if chain_id == 0 {
            return Err(IdentityError::ZeroValue("chain_id"));
        }
        Ok(Self {
            chain_id,
            genesis_hash,
            fork_lineage,
        })
    }

    pub fn parse(
        chain_id: &str,
        genesis_hash: &str,
        fork_lineage: &str,
    ) -> Result<Self, IdentityError> {
        let chain_id = chain_id
            .parse::<u64>()
            .map_err(|_| IdentityError::InvalidInteger)?;
        Self::new(
            chain_id,
            Hash32::parse_hex(genesis_hash)?,
            Hash32::parse_hex(fork_lineage)?,
        )
    }

    pub const fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub const fn genesis_hash(&self) -> Hash32 {
        self.genesis_hash
    }

    pub const fn fork_lineage(&self) -> Hash32 {
        self.fork_lineage
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(CHAIN_KIND);
        push_field(&mut out, 1, &self.chain_id.to_be_bytes())?;
        push_field(&mut out, 2, self.genesis_hash.as_bytes())?;
        push_field(&mut out, 3, self.fork_lineage.as_bytes())?;
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Self, IdentityError> {
        let object = ParsedObject::parse(bytes, CHAIN_KIND)?;
        object.ensure_tags(&[1, 2, 3])?;
        Self::new(
            read_u64(object.field(1)?)?,
            Hash32::new(read_array::<32>(object.field(2)?)?)?,
            Hash32::new(read_array::<32>(object.field(3)?)?)?,
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DeploymentKey {
    chain: ChainDomain,
    protocol: ProtocolFamily,
    address: Address,
    deployment_instance: Hash32,
}

impl DeploymentKey {
    pub const fn new(
        chain: ChainDomain,
        protocol: ProtocolFamily,
        address: Address,
        deployment_instance: Hash32,
    ) -> Self {
        Self {
            chain,
            protocol,
            address,
            deployment_instance,
        }
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn protocol(&self) -> ProtocolFamily {
        self.protocol
    }

    pub const fn address(&self) -> Address {
        self.address
    }

    pub const fn deployment_instance(&self) -> Hash32 {
        self.deployment_instance
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(DEPLOYMENT_KIND);
        push_field(&mut out, 1, &self.chain.canonical_bytes()?)?;
        push_field(&mut out, 2, &self.protocol.tag().to_be_bytes())?;
        push_field(&mut out, 3, self.address.as_bytes())?;
        push_field(&mut out, 4, self.deployment_instance.as_bytes())?;
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Self, IdentityError> {
        let object = ParsedObject::parse(bytes, DEPLOYMENT_KIND)?;
        object.ensure_tags(&[1, 2, 3, 4])?;
        Ok(Self::new(
            ChainDomain::decode(object.field(1)?)?,
            ProtocolFamily::from_tag(read_u16(object.field(2)?)?)?,
            Address::new(read_array::<20>(object.field(3)?)?)?,
            Hash32::new(read_array::<32>(object.field(4)?)?)?,
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MarketUnit {
    AavePool,
    AaveReserve,
    V2Pair,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum MarketKind {
    AavePool {
        deployment: DeploymentKey,
    },
    AaveReserve {
        deployment: DeploymentKey,
        reserve_asset: Address,
    },
    V2Pair {
        deployment: DeploymentKey,
        pair: Address,
        token0: Address,
        token1: Address,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CanonicalMarketKey {
    kind: MarketKind,
}

impl CanonicalMarketKey {
    pub fn aave_pool(deployment: DeploymentKey) -> Result<Self, IdentityError> {
        if !deployment.protocol().is_aave() {
            return Err(IdentityError::ProtocolMarketMismatch);
        }
        Ok(Self {
            kind: MarketKind::AavePool { deployment },
        })
    }

    pub fn aave_reserve(
        deployment: DeploymentKey,
        reserve_asset: Address,
    ) -> Result<Self, IdentityError> {
        if !deployment.protocol().is_aave() {
            return Err(IdentityError::ProtocolMarketMismatch);
        }
        Ok(Self {
            kind: MarketKind::AaveReserve {
                deployment,
                reserve_asset,
            },
        })
    }

    pub fn v2_pair(
        deployment: DeploymentKey,
        pair: Address,
        token0: Address,
        token1: Address,
    ) -> Result<Self, IdentityError> {
        if deployment.protocol() != ProtocolFamily::UniswapV2 {
            return Err(IdentityError::ProtocolMarketMismatch);
        }
        if token0 >= token1
            || pair == token0
            || pair == token1
            || pair == deployment.address()
            || token0 == deployment.address()
            || token1 == deployment.address()
        {
            return Err(IdentityError::ContradictoryV2Pair);
        }
        Ok(Self {
            kind: MarketKind::V2Pair {
                deployment,
                pair,
                token0,
                token1,
            },
        })
    }

    pub const fn unit(&self) -> MarketUnit {
        match &self.kind {
            MarketKind::AavePool { .. } => MarketUnit::AavePool,
            MarketKind::AaveReserve { .. } => MarketUnit::AaveReserve,
            MarketKind::V2Pair { .. } => MarketUnit::V2Pair,
        }
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(MARKET_KIND);
        match &self.kind {
            MarketKind::AavePool { deployment } => {
                push_field(&mut out, 1, &[0x01])?;
                push_field(&mut out, 2, &deployment.canonical_bytes()?)?;
            }
            MarketKind::AaveReserve {
                deployment,
                reserve_asset,
            } => {
                push_field(&mut out, 1, &[0x02])?;
                push_field(&mut out, 2, &deployment.canonical_bytes()?)?;
                push_field(&mut out, 3, reserve_asset.as_bytes())?;
            }
            MarketKind::V2Pair {
                deployment,
                pair,
                token0,
                token1,
            } => {
                push_field(&mut out, 1, &[0x03])?;
                push_field(&mut out, 2, &deployment.canonical_bytes()?)?;
                push_field(&mut out, 3, pair.as_bytes())?;
                push_field(&mut out, 4, token0.as_bytes())?;
                push_field(&mut out, 5, token1.as_bytes())?;
            }
        }
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, IdentityError> {
        let object = ParsedObject::parse(bytes, MARKET_KIND)?;
        let variant = read_u8(object.field(1)?)?;
        let deployment = DeploymentKey::decode(object.field(2)?)?;
        match variant {
            0x01 => {
                object.ensure_tags(&[1, 2])?;
                Self::aave_pool(deployment)
            }
            0x02 => {
                object.ensure_tags(&[1, 2, 3])?;
                Self::aave_reserve(
                    deployment,
                    Address::new(read_array::<20>(object.field(3)?)?)?,
                )
            }
            0x03 => {
                object.ensure_tags(&[1, 2, 3, 4, 5])?;
                Self::v2_pair(
                    deployment,
                    Address::new(read_array::<20>(object.field(3)?)?)?,
                    Address::new(read_array::<20>(object.field(4)?)?)?,
                    Address::new(read_array::<20>(object.field(5)?)?)?,
                )
            }
            other => Err(IdentityError::InvalidMarketVariant(other)),
        }
    }

    pub fn id(&self) -> Result<MarketId, IdentityError> {
        Ok(MarketId(domain_hash(MARKET_DOMAIN, &self.canonical_bytes()?)))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MarketId([u8; 32]);

impl MarketId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationAnchor {
    block_number: u64,
    block_hash: Hash32,
    parent_hash: Hash32,
}

impl ObservationAnchor {
    pub fn new(
        block_number: u64,
        block_hash: Hash32,
        parent_hash: Hash32,
    ) -> Result<Self, IdentityError> {
        if block_number == 0 {
            return Err(IdentityError::ZeroValue("block_number"));
        }
        if block_hash == parent_hash {
            return Err(IdentityError::MalformedEncoding(
                "block hash must differ from parent hash",
            ));
        }
        Ok(Self {
            block_number,
            block_hash,
            parent_hash,
        })
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(ANCHOR_KIND);
        push_field(&mut out, 1, &self.block_number.to_be_bytes())?;
        push_field(&mut out, 2, self.block_hash.as_bytes())?;
        push_field(&mut out, 3, self.parent_hash.as_bytes())?;
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeploymentSemanticsVersion {
    version: u32,
    implementation_code_hash: Hash32,
    configuration_hash: Hash32,
    oracle_configuration_hash: Hash32,
}

impl DeploymentSemanticsVersion {
    pub fn new(
        version: u32,
        implementation_code_hash: Hash32,
        configuration_hash: Hash32,
        oracle_configuration_hash: Hash32,
    ) -> Result<Self, IdentityError> {
        if version == 0 {
            return Err(IdentityError::ZeroValue("semantics_version"));
        }
        Ok(Self {
            version,
            implementation_code_hash,
            configuration_hash,
            oracle_configuration_hash,
        })
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(SEMANTICS_KIND);
        push_field(&mut out, 1, &self.version.to_be_bytes())?;
        push_field(&mut out, 2, self.implementation_code_hash.as_bytes())?;
        push_field(&mut out, 3, self.configuration_hash.as_bytes())?;
        push_field(&mut out, 4, self.oracle_configuration_hash.as_bytes())?;
        Ok(out)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct MarketStateId([u8; 32]);

impl MarketStateId {
    pub fn derive(
        market_id: MarketId,
        anchor: &ObservationAnchor,
        semantics: &DeploymentSemanticsVersion,
    ) -> Result<Self, IdentityError> {
        let mut out = object_header(STATE_KIND);
        push_field(&mut out, 1, market_id.as_bytes())?;
        push_field(&mut out, 2, &anchor.canonical_bytes()?)?;
        push_field(&mut out, 3, &semantics.canonical_bytes()?)?;
        Ok(Self(domain_hash(STATE_DOMAIN, &out)))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StrategySemanticsKey {
    namespace: u16,
    version: u16,
    semantics_hash: Hash32,
}

impl StrategySemanticsKey {
    pub fn new(
        namespace: u16,
        version: u16,
        semantics_hash: Hash32,
    ) -> Result<Self, IdentityError> {
        if namespace == 0 || version == 0 {
            return Err(IdentityError::InvalidStrategy);
        }
        Ok(Self {
            namespace,
            version,
            semantics_hash,
        })
    }

    fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(STRATEGY_KIND);
        push_field(&mut out, 1, &self.namespace.to_be_bytes())?;
        push_field(&mut out, 2, &self.version.to_be_bytes())?;
        push_field(&mut out, 3, self.semantics_hash.as_bytes())?;
        Ok(out)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActionSurfaceKey {
    market_id: MarketId,
    collateral_asset: Address,
    debt_asset: Address,
    strategy: StrategySemanticsKey,
}

impl ActionSurfaceKey {
    pub fn new(
        market_id: MarketId,
        collateral_asset: Address,
        debt_asset: Address,
        strategy: StrategySemanticsKey,
    ) -> Result<Self, IdentityError> {
        if collateral_asset == debt_asset {
            return Err(IdentityError::SameActionAssets);
        }
        Ok(Self {
            market_id,
            collateral_asset,
            debt_asset,
            strategy,
        })
    }

    pub const fn market_id(&self) -> MarketId {
        self.market_id
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        let mut out = object_header(ACTION_KIND);
        push_field(&mut out, 1, self.market_id.as_bytes())?;
        push_field(&mut out, 2, self.collateral_asset.as_bytes())?;
        push_field(&mut out, 3, self.debt_asset.as_bytes())?;
        push_field(&mut out, 4, &self.strategy.canonical_bytes()?)?;
        Ok(out)
    }

    pub fn id(&self) -> Result<ActionSurfaceId, IdentityError> {
        Ok(ActionSurfaceId(domain_hash(
            ACTION_DOMAIN,
            &self.canonical_bytes()?,
        )))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ActionSurfaceId([u8; 32]);

impl ActionSurfaceId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SourceLocator {
    namespace: u16,
    locator_hash: Hash32,
}

impl SourceLocator {
    pub fn new(namespace: u16, locator_hash: Hash32) -> Result<Self, IdentityError> {
        if namespace == 0 {
            return Err(IdentityError::ZeroValue("source_namespace"));
        }
        Ok(Self {
            namespace,
            locator_hash,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AliasEvidence {
    source: SourceLocator,
    target: MarketId,
    evidence_hash: Hash32,
}

impl AliasEvidence {
    pub const fn new(source: SourceLocator, target: MarketId, evidence_hash: Hash32) -> Self {
        Self {
            source,
            target,
            evidence_hash,
        }
    }

    pub const fn source(&self) -> SourceLocator {
        self.source
    }

    pub const fn target(&self) -> MarketId {
        self.target
    }

    pub const fn evidence_hash(&self) -> Hash32 {
        self.evidence_hash
    }
}

pub fn reconcile_aliases(
    aliases: &[AliasEvidence],
) -> Result<BTreeMap<SourceLocator, MarketId>, IdentityError> {
    let mut out = BTreeMap::new();
    for alias in aliases {
        match out.get(&alias.source) {
            Some(existing) if existing != &alias.target => return Err(IdentityError::AliasConflict),
            Some(_) => {}
            None => {
                out.insert(alias.source, alias.target);
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MigrationEvidence {
    from: MarketId,
    to: MarketId,
    evidence_hash: Hash32,
}

impl MigrationEvidence {
    pub fn new(
        from: MarketId,
        to: MarketId,
        evidence_hash: Hash32,
    ) -> Result<Self, IdentityError> {
        if from == to {
            return Err(IdentityError::MigrationSelfReference);
        }
        Ok(Self {
            from,
            to,
            evidence_hash,
        })
    }

    pub const fn from(&self) -> MarketId {
        self.from
    }

    pub const fn to(&self) -> MarketId {
        self.to
    }

    pub const fn evidence_hash(&self) -> Hash32 {
        self.evidence_hash
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdentityCounts {
    pub markets: usize,
    pub aave_pools: usize,
    pub aave_reserves: usize,
    pub v2_pairs: usize,
    pub action_surfaces: usize,
}

pub fn count_identities(
    markets: &[CanonicalMarketKey],
    actions: &[ActionSurfaceKey],
) -> Result<IdentityCounts, IdentityError> {
    let mut market_bytes = BTreeMap::<MarketId, Vec<u8>>::new();
    let mut market_units = BTreeMap::<MarketId, MarketUnit>::new();

    for market in markets {
        let bytes = market.canonical_bytes()?;
        let id = MarketId(domain_hash(MARKET_DOMAIN, &bytes));
        match market_bytes.get(&id) {
            Some(existing) if existing != &bytes => return Err(IdentityError::HashCollision),
            Some(_) => {}
            None => {
                market_bytes.insert(id, bytes);
                market_units.insert(id, market.unit());
            }
        }
    }

    let mut action_bytes = BTreeMap::<ActionSurfaceId, Vec<u8>>::new();
    for action in actions {
        if !market_bytes.contains_key(&action.market_id()) {
            return Err(IdentityError::UnknownMarketReference);
        }
        let bytes = action.canonical_bytes()?;
        let id = ActionSurfaceId(domain_hash(ACTION_DOMAIN, &bytes));
        match action_bytes.get(&id) {
            Some(existing) if existing != &bytes => return Err(IdentityError::HashCollision),
            Some(_) => {}
            None => {
                action_bytes.insert(id, bytes);
            }
        }
    }

    let mut counts = IdentityCounts {
        markets: market_bytes.len(),
        aave_pools: 0,
        aave_reserves: 0,
        v2_pairs: 0,
        action_surfaces: action_bytes.len(),
    };
    for unit in market_units.values() {
        match unit {
            MarketUnit::AavePool => counts.aave_pools += 1,
            MarketUnit::AaveReserve => counts.aave_reserves += 1,
            MarketUnit::V2Pair => counts.v2_pairs += 1,
        }
    }
    Ok(counts)
}

fn object_header(kind: u8) -> Vec<u8> {
    let mut out = Vec::with_capacity(MAGIC.len() + 3);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&IDENTITY_SCHEMA_VERSION.to_be_bytes());
    out.push(kind);
    out
}

fn push_field(out: &mut Vec<u8>, tag: u8, value: &[u8]) -> Result<(), IdentityError> {
    let len = u32::try_from(value.len()).map_err(|_| IdentityError::FieldTooLarge)?;
    out.push(tag);
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(value);
    Ok(())
}

fn domain_hash(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn parse_fixed_hex<const N: usize>(value: &str) -> Result<[u8; N], IdentityError> {
    let raw = value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value);
    if raw.len() != N * 2 {
        return Err(IdentityError::InvalidHexLength {
            expected: N,
            actual: raw.len() / 2,
        });
    }
    let mut out = [0_u8; N];
    let source = raw.as_bytes();
    for (index, byte) in out.iter_mut().enumerate() {
        let high_index = index * 2;
        let low_index = high_index + 1;
        *byte = (decode_nibble(source[high_index], high_index)? << 4)
            | decode_nibble(source[low_index], low_index)?;
    }
    Ok(out)
}

fn decode_nibble(value: u8, index: usize) -> Result<u8, IdentityError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(IdentityError::InvalidHexCharacter { index }),
    }
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

fn read_array<const N: usize>(value: &[u8]) -> Result<[u8; N], IdentityError> {
    value
        .try_into()
        .map_err(|_| IdentityError::MalformedEncoding("fixed-width field length mismatch"))
}

fn read_u8(value: &[u8]) -> Result<u8, IdentityError> {
    Ok(read_array::<1>(value)?[0])
}

fn read_u16(value: &[u8]) -> Result<u16, IdentityError> {
    Ok(u16::from_be_bytes(read_array::<2>(value)?))
}

fn read_u64(value: &[u8]) -> Result<u64, IdentityError> {
    Ok(u64::from_be_bytes(read_array::<8>(value)?))
}

struct ParsedObject<'a> {
    fields: Vec<(u8, &'a [u8])>,
}

impl<'a> ParsedObject<'a> {
    fn parse(bytes: &'a [u8], expected_kind: u8) -> Result<Self, IdentityError> {
        let header_len = MAGIC.len() + 3;
        if bytes.len() < header_len {
            return Err(IdentityError::MalformedEncoding("truncated object header"));
        }
        if &bytes[..MAGIC.len()] != MAGIC {
            return Err(IdentityError::MalformedEncoding("invalid magic"));
        }

        let offset = MAGIC.len();
        let version = u16::from_be_bytes([bytes[offset], bytes[offset + 1]]);
        if version != IDENTITY_SCHEMA_VERSION {
            return Err(IdentityError::UnknownSchemaVersion(version));
        }
        let kind = bytes[offset + 2];
        if kind != expected_kind {
            return Err(IdentityError::UnexpectedObjectKind {
                expected: expected_kind,
                actual: kind,
            });
        }

        let mut cursor = header_len;
        let mut previous_tag = None;
        let mut fields = Vec::new();
        while cursor < bytes.len() {
            let header_end = cursor
                .checked_add(5)
                .ok_or(IdentityError::MalformedEncoding("field header overflow"))?;
            if header_end > bytes.len() {
                return Err(IdentityError::MalformedEncoding("truncated field header"));
            }

            let tag = bytes[cursor];
            if previous_tag.is_some_and(|previous| tag <= previous) {
                return Err(IdentityError::MalformedEncoding(
                    "field tags must be strictly increasing",
                ));
            }
            previous_tag = Some(tag);

            let len = u32::from_be_bytes([
                bytes[cursor + 1],
                bytes[cursor + 2],
                bytes[cursor + 3],
                bytes[cursor + 4],
            ]);
            let len = usize::try_from(len)
                .map_err(|_| IdentityError::MalformedEncoding("field length overflow"))?;
            let value_end = header_end
                .checked_add(len)
                .ok_or(IdentityError::MalformedEncoding("field range overflow"))?;
            if value_end > bytes.len() {
                return Err(IdentityError::MalformedEncoding("truncated field value"));
            }
            fields.push((tag, &bytes[header_end..value_end]));
            cursor = value_end;
        }
        Ok(Self { fields })
    }

    fn field(&self, tag: u8) -> Result<&'a [u8], IdentityError> {
        self.fields
            .iter()
            .find_map(|(candidate, value)| (*candidate == tag).then_some(*value))
            .ok_or(IdentityError::MalformedEncoding("missing required field"))
    }

    fn ensure_tags(&self, expected: &[u8]) -> Result<(), IdentityError> {
        if self.fields.len() != expected.len()
            || self
                .fields
                .iter()
                .zip(expected)
                .any(|((actual, _), wanted)| actual != wanted)
        {
            return Err(IdentityError::MalformedEncoding(
                "unexpected canonical field set",
            ));
        }
        Ok(())
    }
}
