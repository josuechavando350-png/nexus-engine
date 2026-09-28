use crate::canonical::{self, Encoder, Kind, SCOPE_DOMAIN};
use crate::error::StoreError;
use nqc_census_core::{Address, ChainDomain, DeploymentKey, Hash32, ProtocolFamily};

/// What a stream produces and under which versioned semantics.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StreamKind {
    namespace: u16,
    version: u16,
    semantics_hash: Hash32,
}

impl StreamKind {
    pub fn new(namespace: u16, version: u16, semantics_hash: Hash32) -> Result<Self, StoreError> {
        if namespace == 0 || version == 0 {
            return Err(StoreError::InvalidScope(
                "stream namespace and version must be non-zero",
            ));
        }
        Ok(Self {
            namespace,
            version,
            semantics_hash,
        })
    }

    pub const fn namespace(&self) -> u16 {
        self.namespace
    }

    pub const fn version(&self) -> u16 {
        self.version
    }

    pub const fn semantics_hash(&self) -> Hash32 {
        self.semantics_hash
    }
}

/// The lineage a checkpoint stream belongs to.
///
/// It binds the RMC-001 `ChainDomain` (chain id, genesis, fork lineage), an
/// optional RMC-001 `DeploymentKey` on that same chain, the producing stream's
/// versioned semantics, and the origin: the first block the stream may cover
/// and the parent hash that block must extend. Two streams that differ in any of
/// these have different [`ScopeId`]s and live in different catalog directories,
/// so their checkpoints can never be chained together.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StreamScope {
    chain: ChainDomain,
    deployment: Option<DeploymentKey>,
    kind: StreamKind,
    origin_block: u64,
    origin_parent_hash: Hash32,
}

impl StreamScope {
    pub fn new(
        chain: ChainDomain,
        deployment: Option<DeploymentKey>,
        kind: StreamKind,
        origin_block: u64,
        origin_parent_hash: Hash32,
    ) -> Result<Self, StoreError> {
        if let Some(deployment) = &deployment {
            if deployment.chain() != &chain {
                return Err(StoreError::InvalidScope(
                    "deployment chain domain differs from stream chain domain",
                ));
            }
        }
        if origin_block == 0 {
            return Err(StoreError::InvalidScope(
                "origin block must be non-zero (RMC-003 anchors reject block 0)",
            ));
        }
        Ok(Self {
            chain,
            deployment,
            kind,
            origin_block,
            origin_parent_hash,
        })
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn deployment(&self) -> Option<&DeploymentKey> {
        self.deployment.as_ref()
    }

    pub const fn kind(&self) -> &StreamKind {
        &self.kind
    }

    pub const fn origin_block(&self) -> u64 {
        self.origin_block
    }

    pub const fn origin_parent_hash(&self) -> Hash32 {
        self.origin_parent_hash
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, StoreError> {
        let mut encoder = Encoder::new(Kind::Scope)
            .u64(1, self.chain.chain_id())?
            .bytes(2, self.chain.genesis_hash().as_bytes())?
            .bytes(3, self.chain.fork_lineage().as_bytes())?;
        if let Some(deployment) = &self.deployment {
            let nested = Encoder::new(Kind::Deployment)
                .u16(1, deployment.protocol().tag())?
                .bytes(2, deployment.address().as_bytes())?
                .bytes(3, deployment.deployment_instance().as_bytes())?
                .finish();
            encoder = encoder.bytes(4, &nested)?;
        }
        Ok(encoder
            .u16(5, self.kind.namespace)?
            .u16(6, self.kind.version)?
            .bytes(7, self.kind.semantics_hash.as_bytes())?
            .u64(8, self.origin_block)?
            .bytes(9, self.origin_parent_hash.as_bytes())?
            .finish())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, StoreError> {
        let fields = canonical::parse(
            bytes,
            Kind::Scope,
            &[&[1, 2, 3, 5, 6, 7, 8, 9], &[1, 2, 3, 4, 5, 6, 7, 8, 9]],
        )?;
        let chain = ChainDomain::new(
            fields.u64(1)?,
            Hash32::new(fields.fixed::<32>(2)?)?,
            Hash32::new(fields.fixed::<32>(3)?)?,
        )?;
        let deployment = if fields.has(4) {
            let nested = canonical::parse(fields.bytes(4)?, Kind::Deployment, &[&[1, 2, 3]])?;
            Some(DeploymentKey::new(
                chain.clone(),
                protocol_from_tag(nested.u16(1)?)?,
                Address::new(nested.fixed::<20>(2)?)?,
                Hash32::new(nested.fixed::<32>(3)?)?,
            ))
        } else {
            None
        };
        let scope = Self::new(
            chain,
            deployment,
            StreamKind::new(
                fields.u16(5)?,
                fields.u16(6)?,
                Hash32::new(fields.fixed::<32>(7)?)?,
            )?,
            fields.u64(8)?,
            Hash32::new(fields.fixed::<32>(9)?)?,
        )?;
        if scope.canonical_bytes()? != bytes {
            return Err(StoreError::NonCanonical {
                object: Kind::Scope.name(),
            });
        }
        Ok(scope)
    }

    pub fn id(&self) -> Result<ScopeId, StoreError> {
        Ok(ScopeId(canonical::domain_digest(
            SCOPE_DOMAIN,
            &self.canonical_bytes()?,
        )))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ScopeId(pub(crate) [u8; 32]);

impl ScopeId {
    pub fn parse_hex(text: &str) -> Result<Self, StoreError> {
        canonical::parse_hex32(text)
            .map(Self)
            .ok_or(StoreError::malformed(
                "scope id",
                "expected 64 lowercase hex",
            ))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        canonical::hex(&self.0)
    }
}

/// Every RMC-001 protocol family, used to decode `ProtocolFamily::tag()`.
///
/// RMC-001 keeps `ProtocolFamily::from_tag` private and `identity.rs` is
/// byte-immutable, so decoding matches against the public `tag()` of each
/// variant. The exhaustive match in the unit test below stops compiling if
/// RMC-001 ever adds a family without this table being extended; until then an
/// unknown tag fails closed.
const PROTOCOL_FAMILIES: [ProtocolFamily; 4] = [
    ProtocolFamily::AaveV2,
    ProtocolFamily::AaveV3,
    ProtocolFamily::AaveV4,
    ProtocolFamily::UniswapV2,
];

fn protocol_from_tag(tag: u16) -> Result<ProtocolFamily, StoreError> {
    PROTOCOL_FAMILIES
        .into_iter()
        .find(|family| family.tag() == tag)
        .ok_or(StoreError::InvalidScope("unknown protocol family tag"))
}

#[cfg(test)]
mod tests {
    use super::{protocol_from_tag, PROTOCOL_FAMILIES};
    use nqc_census_core::ProtocolFamily;

    const fn table_index(family: ProtocolFamily) -> usize {
        match family {
            ProtocolFamily::AaveV2 => 0,
            ProtocolFamily::AaveV3 => 1,
            ProtocolFamily::AaveV4 => 2,
            ProtocolFamily::UniswapV2 => 3,
        }
    }

    #[test]
    fn protocol_table_covers_every_rmc001_family() {
        for family in PROTOCOL_FAMILIES {
            assert_eq!(PROTOCOL_FAMILIES.get(table_index(family)), Some(&family));
            assert_eq!(protocol_from_tag(family.tag()), Ok(family));
        }
        assert!(protocol_from_tag(0xffff).is_err());
    }
}
