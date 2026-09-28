use crate::{Address, ChainDomain, Hash32};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};

const OBSERVATION_DOMAIN: &[u8] = b"NQC-CENSUS-OBSERVATION-V1";
const RAW_LOG_DOMAIN: &[u8] = b"NQC-CENSUS-RAW-LOG-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObservationDigest([u8; 32]);

impl ObservationDigest {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AnchorMismatchField {
    ChainDomain,
    BlockNumber,
    BlockHash,
    ParentHash,
    Timestamp,
    StateRoot,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ObservationError {
    ZeroValue(&'static str),
    BlockEqualsParent,
    TooManyLogTopics(usize),
    PayloadTooLarge,
    AnchorMismatch(AnchorMismatchField),
}

impl Display for ObservationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroValue(name) => write!(formatter, "{name} must not be zero"),
            Self::BlockEqualsParent => {
                formatter.write_str("block hash must differ from parent hash")
            }
            Self::TooManyLogTopics(count) => {
                write!(formatter, "EVM log has {count} topics; maximum is four")
            }
            Self::PayloadTooLarge => formatter.write_str("payload exceeds u32 canonical length"),
            Self::AnchorMismatch(field) => write!(formatter, "state anchor mismatch: {field:?}"),
        }
    }
}

impl std::error::Error for ObservationError {}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StateAnchor {
    chain: ChainDomain,
    block_number: u64,
    block_hash: Hash32,
    parent_hash: Hash32,
    timestamp: u64,
    state_root: Hash32,
}

impl StateAnchor {
    pub fn new(
        chain: ChainDomain,
        block_number: u64,
        block_hash: Hash32,
        parent_hash: Hash32,
        timestamp: u64,
        state_root: Hash32,
    ) -> Result<Self, ObservationError> {
        if block_number == 0 {
            return Err(ObservationError::ZeroValue("block_number"));
        }
        if timestamp == 0 {
            return Err(ObservationError::ZeroValue("timestamp"));
        }
        if block_hash == parent_hash {
            return Err(ObservationError::BlockEqualsParent);
        }
        Ok(Self {
            chain,
            block_number,
            block_hash,
            parent_hash,
            timestamp,
            state_root,
        })
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn block_number(&self) -> u64 {
        self.block_number
    }

    pub const fn block_hash(&self) -> Hash32 {
        self.block_hash
    }

    pub const fn parent_hash(&self) -> Hash32 {
        self.parent_hash
    }

    pub const fn timestamp(&self) -> u64 {
        self.timestamp
    }

    pub const fn state_root(&self) -> Hash32 {
        self.state_root
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ProvenanceAuthority {
    BlockHeader,
    ContractCall,
    ReceiptLog,
    StorageProof,
    CodeRead,
    ConfigurationRead,
    LocalDerivation,
}

impl ProvenanceAuthority {
    const fn tag(self) -> u8 {
        match self {
            Self::BlockHeader => 1,
            Self::ContractCall => 2,
            Self::ReceiptLog => 3,
            Self::StorageProof => 4,
            Self::CodeRead => 5,
            Self::ConfigurationRead => 6,
            Self::LocalDerivation => 7,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObservationProvenance {
    authority: ProvenanceAuthority,
    source_namespace: u16,
    source_locator_hash: Hash32,
    request_hash: Hash32,
    response_hash: Hash32,
}

impl ObservationProvenance {
    pub fn new(
        authority: ProvenanceAuthority,
        source_namespace: u16,
        source_locator_hash: Hash32,
        request_hash: Hash32,
        response_hash: Hash32,
    ) -> Result<Self, ObservationError> {
        if source_namespace == 0 {
            return Err(ObservationError::ZeroValue("source_namespace"));
        }
        Ok(Self {
            authority,
            source_namespace,
            source_locator_hash,
            request_hash,
            response_hash,
        })
    }

    pub const fn authority(&self) -> ProvenanceAuthority {
        self.authority
    }

    pub const fn source_namespace(&self) -> u16 {
        self.source_namespace
    }

    pub const fn source_locator_hash(&self) -> Hash32 {
        self.source_locator_hash
    }

    pub const fn request_hash(&self) -> Hash32 {
        self.request_hash
    }

    pub const fn response_hash(&self) -> Hash32 {
        self.response_hash
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObservationSemantics {
    code_hash: Hash32,
    configuration_hash: Hash32,
}

impl ObservationSemantics {
    pub const fn new(code_hash: Hash32, configuration_hash: Hash32) -> Self {
        Self {
            code_hash,
            configuration_hash,
        }
    }

    pub const fn code_hash(&self) -> Hash32 {
        self.code_hash
    }

    pub const fn configuration_hash(&self) -> Hash32 {
        self.configuration_hash
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObservationEnvelope {
    anchor: StateAnchor,
    semantics: ObservationSemantics,
    provenance: ObservationProvenance,
    raw_payload_digest: ObservationDigest,
    observation_digest: ObservationDigest,
}

impl ObservationEnvelope {
    pub fn new(
        anchor: StateAnchor,
        semantics: ObservationSemantics,
        provenance: ObservationProvenance,
        raw_payload_digest: ObservationDigest,
    ) -> Self {
        let observation_digest =
            digest_observation(&anchor, semantics, &provenance, raw_payload_digest);
        Self {
            anchor,
            semantics,
            provenance,
            raw_payload_digest,
            observation_digest,
        }
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn semantics(&self) -> ObservationSemantics {
        self.semantics
    }

    pub const fn provenance(&self) -> &ObservationProvenance {
        &self.provenance
    }

    pub const fn raw_payload_digest(&self) -> ObservationDigest {
        self.raw_payload_digest
    }

    pub const fn digest(&self) -> ObservationDigest {
        self.observation_digest
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CensusObservation<T> {
    envelope: ObservationEnvelope,
    payload: T,
}

impl<T> CensusObservation<T> {
    pub const fn envelope(&self) -> &ObservationEnvelope {
        &self.envelope
    }

    pub const fn payload(&self) -> &T {
        &self.payload
    }

    pub fn into_payload(self) -> T {
        self.payload
    }

    pub fn map_payload<U, E, F>(self, mapper: F) -> Result<CensusObservation<U>, E>
    where
        F: FnOnce(T) -> Result<U, E>,
    {
        let payload = mapper(self.payload)?;
        Ok(CensusObservation {
            envelope: self.envelope,
            payload,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawLogEnvelope {
    emitter: Address,
    transaction_hash: Hash32,
    transaction_index: u32,
    log_index: u32,
    topics: Vec<Hash32>,
    data: Vec<u8>,
    removed: bool,
}

impl RawLogEnvelope {
    pub fn new(
        emitter: Address,
        transaction_hash: Hash32,
        transaction_index: u32,
        log_index: u32,
        topics: Vec<Hash32>,
        data: Vec<u8>,
        removed: bool,
    ) -> Result<Self, ObservationError> {
        if topics.len() > 4 {
            return Err(ObservationError::TooManyLogTopics(topics.len()));
        }
        if u32::try_from(data.len()).is_err() {
            return Err(ObservationError::PayloadTooLarge);
        }
        Ok(Self {
            emitter,
            transaction_hash,
            transaction_index,
            log_index,
            topics,
            data,
            removed,
        })
    }

    pub const fn emitter(&self) -> Address {
        self.emitter
    }

    pub const fn transaction_hash(&self) -> Hash32 {
        self.transaction_hash
    }

    pub const fn transaction_index(&self) -> u32 {
        self.transaction_index
    }

    pub const fn log_index(&self) -> u32 {
        self.log_index
    }

    pub fn topics(&self) -> &[Hash32] {
        &self.topics
    }

    pub fn data(&self) -> &[u8] {
        &self.data
    }

    pub const fn removed(&self) -> bool {
        self.removed
    }

    pub fn digest(&self) -> Result<ObservationDigest, ObservationError> {
        let data_len =
            u32::try_from(self.data.len()).map_err(|_| ObservationError::PayloadTooLarge)?;
        let topic_count =
            u8::try_from(self.topics.len()).map_err(|_| ObservationError::TooManyLogTopics(
                self.topics.len(),
            ))?;

        let mut hasher = Sha256::new();
        hasher.update(RAW_LOG_DOMAIN);
        hasher.update([0]);
        hasher.update(self.emitter.as_bytes());
        hasher.update(self.transaction_hash.as_bytes());
        hasher.update(self.transaction_index.to_be_bytes());
        hasher.update(self.log_index.to_be_bytes());
        hasher.update([topic_count]);
        for topic in &self.topics {
            hasher.update(topic.as_bytes());
        }
        hasher.update(data_len.to_be_bytes());
        hasher.update(&self.data);
        hasher.update([u8::from(self.removed)]);
        Ok(ObservationDigest(finalize_hash(hasher)))
    }
}

impl CensusObservation<RawLogEnvelope> {
    pub fn from_raw_log(
        anchor: StateAnchor,
        semantics: ObservationSemantics,
        provenance: ObservationProvenance,
        payload: RawLogEnvelope,
    ) -> Result<Self, ObservationError> {
        let raw_payload_digest = payload.digest()?;
        Ok(Self {
            envelope: ObservationEnvelope::new(
                anchor,
                semantics,
                provenance,
                raw_payload_digest,
            ),
            payload,
        })
    }
}

pub fn require_same_anchor<A, B>(
    left: &CensusObservation<A>,
    right: &CensusObservation<B>,
) -> Result<(), ObservationError> {
    let left = left.envelope().anchor();
    let right = right.envelope().anchor();

    if left.chain() != right.chain() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::ChainDomain,
        ));
    }
    if left.block_number() != right.block_number() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::BlockNumber,
        ));
    }
    if left.block_hash() != right.block_hash() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::BlockHash,
        ));
    }
    if left.parent_hash() != right.parent_hash() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::ParentHash,
        ));
    }
    if left.timestamp() != right.timestamp() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::Timestamp,
        ));
    }
    if left.state_root() != right.state_root() {
        return Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::StateRoot,
        ));
    }
    Ok(())
}

fn digest_observation(
    anchor: &StateAnchor,
    semantics: ObservationSemantics,
    provenance: &ObservationProvenance,
    raw_payload_digest: ObservationDigest,
) -> ObservationDigest {
    let mut hasher = Sha256::new();
    hasher.update(OBSERVATION_DOMAIN);
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update(semantics.code_hash().as_bytes());
    hasher.update(semantics.configuration_hash().as_bytes());
    hasher.update([provenance.authority().tag()]);
    hasher.update(provenance.source_namespace().to_be_bytes());
    hasher.update(provenance.source_locator_hash().as_bytes());
    hasher.update(provenance.request_hash().as_bytes());
    hasher.update(provenance.response_hash().as_bytes());
    hasher.update(raw_payload_digest.as_bytes());
    ObservationDigest(finalize_hash(hasher))
}

fn finalize_hash(hasher: Sha256) -> [u8; 32] {
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
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
