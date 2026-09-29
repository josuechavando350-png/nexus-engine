use crate::keccak::keccak256;
use crate::rlp;
use crate::{Address, ChainDomain, Hash32};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};

const OBSERVATION_DOMAIN: &[u8] = b"NQC-CENSUS-OBSERVATION-V1";
const RAW_LOG_DOMAIN: &[u8] = b"NQC-CENSUS-RAW-LOG-V1";
const RAW_CONTRACT_CALL_DOMAIN: &[u8] = b"NQC-CENSUS-RAW-CONTRACT-CALL-V1";
const RAW_RUNTIME_CODE_DOMAIN: &[u8] = b"NQC-CENSUS-RAW-RUNTIME-CODE-V1";
const RAW_BLOCK_HEADER_DOMAIN: &[u8] = b"NQC-CENSUS-RAW-BLOCK-HEADER-V1";
const TYPED_OBSERVATION_MAGIC: &[u8] = b"NQC-CENSUS-OBS";
const ETHEREUM_HEADER_MIN_FIELDS: usize = 15;

/// Schema version of the canonical typed-observation encoding.
pub const TYPED_OBSERVATION_SCHEMA_VERSION: u16 = 1;

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
    ProvenanceClassMismatch {
        class: ObservationClass,
        authority: ProvenanceAuthority,
    },
    HeaderAnchorMismatch(AnchorMismatchField),
    HeaderHashMismatch,
    MalformedHeader(&'static str),
    MalformedCanonical(&'static str),
    ClassMismatch {
        expected: ObservationClass,
        found: ObservationClass,
    },
    DigestMismatch(&'static str),
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
            Self::ProvenanceClassMismatch { class, authority } => write!(
                formatter,
                "{} observation requires {:?} provenance, got {authority:?}",
                class.code(),
                class.required_authority()
            ),
            Self::HeaderAnchorMismatch(field) => {
                write!(
                    formatter,
                    "block header disagrees with its anchor: {field:?}"
                )
            }
            Self::HeaderHashMismatch => {
                formatter.write_str("block hash is not the Keccak-256 of the encoded header")
            }
            Self::MalformedHeader(reason) => write!(formatter, "malformed block header: {reason}"),
            Self::MalformedCanonical(reason) => {
                write!(formatter, "malformed canonical observation: {reason}")
            }
            Self::ClassMismatch { expected, found } => write!(
                formatter,
                "expected {} observation, found {}",
                expected.code(),
                found.code()
            ),
            Self::DigestMismatch(which) => {
                write!(formatter, "{which} digest does not match content")
            }
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
    const ALL: [Self; 7] = [
        Self::BlockHeader,
        Self::ContractCall,
        Self::ReceiptLog,
        Self::StorageProof,
        Self::CodeRead,
        Self::ConfigurationRead,
        Self::LocalDerivation,
    ];

    fn from_tag(tag: u8) -> Result<Self, ObservationError> {
        Self::ALL
            .into_iter()
            .find(|authority| authority.tag() == tag)
            .ok_or(ObservationError::MalformedCanonical(
                "unknown provenance authority",
            ))
    }

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
        let topic_count = u8::try_from(self.topics.len())
            .map_err(|_| ObservationError::TooManyLogTopics(self.topics.len()))?;

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
            envelope: ObservationEnvelope::new(anchor, semantics, provenance, raw_payload_digest),
            payload,
        })
    }
}

/// Semantic class of a typed observation. Every class has its own raw-payload
/// digest domain and exactly one admissible provenance authority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObservationClass {
    Log,
    ContractCall,
    RuntimeCode,
    BlockHeader,
}

impl ObservationClass {
    pub const ALL: [Self; 4] = [
        Self::Log,
        Self::ContractCall,
        Self::RuntimeCode,
        Self::BlockHeader,
    ];

    pub const fn code(self) -> &'static str {
        match self {
            Self::Log => "LOG",
            Self::ContractCall => "CONTRACT_CALL",
            Self::RuntimeCode => "RUNTIME_CODE",
            Self::BlockHeader => "BLOCK_HEADER",
        }
    }

    pub const fn required_authority(self) -> ProvenanceAuthority {
        match self {
            Self::Log => ProvenanceAuthority::ReceiptLog,
            Self::ContractCall => ProvenanceAuthority::ContractCall,
            Self::RuntimeCode => ProvenanceAuthority::CodeRead,
            Self::BlockHeader => ProvenanceAuthority::BlockHeader,
        }
    }

    const fn tag(self) -> u8 {
        match self {
            Self::Log => 1,
            Self::ContractCall => 2,
            Self::RuntimeCode => 3,
            Self::BlockHeader => 4,
        }
    }

    const fn payload_domain(self) -> &'static [u8] {
        match self {
            Self::Log => RAW_LOG_DOMAIN,
            Self::ContractCall => RAW_CONTRACT_CALL_DOMAIN,
            Self::RuntimeCode => RAW_RUNTIME_CODE_DOMAIN,
            Self::BlockHeader => RAW_BLOCK_HEADER_DOMAIN,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, ObservationError> {
        Self::ALL
            .into_iter()
            .find(|class| class.tag() == tag)
            .ok_or(ObservationError::MalformedCanonical(
                "unknown observation class",
            ))
    }
}

mod sealed {
    pub trait Sealed {}
    impl Sealed for super::RawLogEnvelope {}
    impl Sealed for super::ContractCallEnvelope {}
    impl Sealed for super::RuntimeCodeEnvelope {}
    impl Sealed for super::BlockHeaderEnvelope {}
}

/// A raw chain payload that RMC-003 can bind into an observation. The trait is
/// sealed: only the four typed payloads defined here exist, and their digests
/// are always computed internally from their canonical bytes.
pub trait ObservationPayload: sealed::Sealed + Sized {
    const CLASS: ObservationClass;

    /// Canonical class-specific payload bytes (without domain or class tag).
    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, ObservationError>;

    /// Class-domain-separated digest of the canonical payload bytes.
    fn payload_digest(&self) -> Result<ObservationDigest, ObservationError> {
        Ok(domain_digest(
            Self::CLASS.payload_domain(),
            &self.canonical_payload_bytes()?,
        ))
    }

    /// Strict inverse of `canonical_payload_bytes`.
    fn decode_canonical_payload(bytes: &[u8]) -> Result<Self, ObservationError>;

    /// Class-specific consistency between the payload and its anchor.
    fn validate_anchor(&self, _anchor: &StateAnchor) -> Result<(), ObservationError> {
        Ok(())
    }
}

impl ObservationPayload for RawLogEnvelope {
    const CLASS: ObservationClass = ObservationClass::Log;

    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, ObservationError> {
        let data_len =
            u32::try_from(self.data.len()).map_err(|_| ObservationError::PayloadTooLarge)?;
        let topic_count = u8::try_from(self.topics.len())
            .map_err(|_| ObservationError::TooManyLogTopics(self.topics.len()))?;
        let mut out = Vec::with_capacity(97 + self.topics.len() * 32 + self.data.len());
        out.extend_from_slice(self.emitter.as_bytes());
        out.extend_from_slice(self.transaction_hash.as_bytes());
        out.extend_from_slice(&self.transaction_index.to_be_bytes());
        out.extend_from_slice(&self.log_index.to_be_bytes());
        out.push(topic_count);
        for topic in &self.topics {
            out.extend_from_slice(topic.as_bytes());
        }
        out.extend_from_slice(&data_len.to_be_bytes());
        out.extend_from_slice(&self.data);
        out.push(u8::from(self.removed));
        Ok(out)
    }

    /// The legacy RMC-003 raw-log digest, unchanged.
    fn payload_digest(&self) -> Result<ObservationDigest, ObservationError> {
        self.digest()
    }

    fn decode_canonical_payload(bytes: &[u8]) -> Result<Self, ObservationError> {
        let mut reader = Reader::new(bytes);
        let emitter = reader.address()?;
        let transaction_hash = reader.hash()?;
        let transaction_index = reader.u32()?;
        let log_index = reader.u32()?;
        let topic_count = usize::from(reader.u8()?);
        let mut topics = Vec::with_capacity(topic_count.min(4));
        for _ in 0..topic_count {
            topics.push(reader.hash()?);
        }
        let data = reader.length_prefixed()?.to_vec();
        let removed = reader.flag()?;
        reader.finish()?;
        Self::new(
            emitter,
            transaction_hash,
            transaction_index,
            log_index,
            topics,
            data,
            removed,
        )
    }
}

/// Call context of an `eth_call` observation. Census reads use
/// `CallContext::static_read()`; any other context is bound explicitly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CallContext {
    caller: Option<Address>,
    value: [u8; 32],
    gas_limit: Option<u64>,
}

impl CallContext {
    pub const fn new(caller: Option<Address>, value: [u8; 32], gas_limit: Option<u64>) -> Self {
        Self {
            caller,
            value,
            gas_limit,
        }
    }

    /// No caller, zero value, provider default gas.
    pub const fn static_read() -> Self {
        Self::new(None, [0; 32], None)
    }

    pub const fn caller(&self) -> Option<Address> {
        self.caller
    }

    pub const fn value(&self) -> &[u8; 32] {
        &self.value
    }

    pub const fn gas_limit(&self) -> Option<u64> {
        self.gas_limit
    }
}

/// Chain-level result of an executed call. Transport, provider, or archive
/// failures are not call outcomes and can never be represented here.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CallOutcome {
    Returned(Vec<u8>),
    Reverted(Vec<u8>),
}

impl CallOutcome {
    const fn tag(&self) -> u8 {
        match self {
            Self::Returned(_) => 1,
            Self::Reverted(_) => 2,
        }
    }

    pub const fn is_success(&self) -> bool {
        matches!(self, Self::Returned(_))
    }

    /// Return data on success, revert data on revert.
    pub fn output(&self) -> &[u8] {
        match self {
            Self::Returned(bytes) | Self::Reverted(bytes) => bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContractCallEnvelope {
    target: Address,
    context: CallContext,
    calldata: Vec<u8>,
    outcome: CallOutcome,
}

impl ContractCallEnvelope {
    pub fn new(
        target: Address,
        context: CallContext,
        calldata: Vec<u8>,
        outcome: CallOutcome,
    ) -> Result<Self, ObservationError> {
        if u32::try_from(calldata.len()).is_err() || u32::try_from(outcome.output().len()).is_err()
        {
            return Err(ObservationError::PayloadTooLarge);
        }
        Ok(Self {
            target,
            context,
            calldata,
            outcome,
        })
    }

    pub const fn target(&self) -> Address {
        self.target
    }

    pub const fn context(&self) -> &CallContext {
        &self.context
    }

    pub fn calldata(&self) -> &[u8] {
        &self.calldata
    }

    /// The four-byte function selector, when the calldata carries one.
    pub fn selector(&self) -> Option<[u8; 4]> {
        let mut selector = [0_u8; 4];
        selector.copy_from_slice(self.calldata.get(..4)?);
        Some(selector)
    }

    pub const fn outcome(&self) -> &CallOutcome {
        &self.outcome
    }
}

impl ObservationPayload for ContractCallEnvelope {
    const CLASS: ObservationClass = ObservationClass::ContractCall;

    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, ObservationError> {
        let mut out = Vec::with_capacity(96 + self.calldata.len() + self.outcome.output().len());
        out.extend_from_slice(self.target.as_bytes());
        match self.context.caller {
            Some(caller) => {
                out.push(1);
                out.extend_from_slice(caller.as_bytes());
            }
            None => out.push(0),
        }
        out.extend_from_slice(&self.context.value);
        match self.context.gas_limit {
            Some(gas) => {
                out.push(1);
                out.extend_from_slice(&gas.to_be_bytes());
            }
            None => out.push(0),
        }
        push_length_prefixed(&mut out, &self.calldata)?;
        out.push(self.outcome.tag());
        push_length_prefixed(&mut out, self.outcome.output())?;
        Ok(out)
    }

    fn decode_canonical_payload(bytes: &[u8]) -> Result<Self, ObservationError> {
        let mut reader = Reader::new(bytes);
        let target = reader.address()?;
        let caller = if reader.flag()? {
            Some(reader.address()?)
        } else {
            None
        };
        let value = reader.array::<32>()?;
        let gas_limit = if reader.flag()? {
            Some(reader.u64()?)
        } else {
            None
        };
        let calldata = reader.length_prefixed()?.to_vec();
        let outcome_tag = reader.u8()?;
        let output = reader.length_prefixed()?.to_vec();
        reader.finish()?;
        let outcome = match outcome_tag {
            1 => CallOutcome::Returned(output),
            2 => CallOutcome::Reverted(output),
            _ => return Err(ObservationError::MalformedCanonical("unknown call outcome")),
        };
        Self::new(
            target,
            CallContext::new(caller, value, gas_limit),
            calldata,
            outcome,
        )
    }
}

/// Exact runtime bytecode of an account at the anchor. Empty code is a valid
/// observation: it proves the absence of code at that block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCodeEnvelope {
    account: Address,
    code: Vec<u8>,
}

impl RuntimeCodeEnvelope {
    pub fn new(account: Address, code: Vec<u8>) -> Result<Self, ObservationError> {
        if u32::try_from(code.len()).is_err() {
            return Err(ObservationError::PayloadTooLarge);
        }
        Ok(Self { account, code })
    }

    pub const fn account(&self) -> Address {
        self.account
    }

    pub fn code(&self) -> &[u8] {
        &self.code
    }

    pub fn is_absent(&self) -> bool {
        self.code.is_empty()
    }
}

impl ObservationPayload for RuntimeCodeEnvelope {
    const CLASS: ObservationClass = ObservationClass::RuntimeCode;

    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, ObservationError> {
        let mut out = Vec::with_capacity(24 + self.code.len());
        out.extend_from_slice(self.account.as_bytes());
        push_length_prefixed(&mut out, &self.code)?;
        Ok(out)
    }

    fn decode_canonical_payload(bytes: &[u8]) -> Result<Self, ObservationError> {
        let mut reader = Reader::new(bytes);
        let account = reader.address()?;
        let code = reader.length_prefixed()?.to_vec();
        reader.finish()?;
        Self::new(account, code)
    }
}

/// Canonical header encoding family. Each variant fixes how the block hash is
/// derived from the encoded header and where the bound fields live.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum HeaderEncoding {
    /// Keccak-256 over the canonical RLP header list. Field positions 0..=14
    /// are shared by every Ethereum hard-fork era; later eras only append.
    EthereumRlp,
}

impl HeaderEncoding {
    const fn tag(self) -> u8 {
        match self {
            Self::EthereumRlp => 1,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, ObservationError> {
        match tag {
            1 => Ok(Self::EthereumRlp),
            _ => Err(ObservationError::MalformedCanonical(
                "unknown header encoding",
            )),
        }
    }
}

/// A block header whose hash is recomputed from its canonical encoding. The
/// number, parent, timestamp, and roots are parsed from those same bytes, so
/// no provider-claimed header field is trusted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockHeaderEnvelope {
    encoding: HeaderEncoding,
    hash: Hash32,
    encoded: Vec<u8>,
    field_count: usize,
    number: u64,
    parent_hash: [u8; 32],
    state_root: [u8; 32],
    transactions_root: [u8; 32],
    receipts_root: [u8; 32],
    logs_bloom: [u8; 256],
    timestamp: u64,
}

impl BlockHeaderEnvelope {
    pub fn new(
        encoding: HeaderEncoding,
        hash: Hash32,
        encoded: Vec<u8>,
    ) -> Result<Self, ObservationError> {
        if u32::try_from(encoded.len()).is_err() {
            return Err(ObservationError::PayloadTooLarge);
        }
        match encoding {
            HeaderEncoding::EthereumRlp => Self::ethereum_rlp(hash, encoded),
        }
    }

    fn ethereum_rlp(hash: Hash32, encoded: Vec<u8>) -> Result<Self, ObservationError> {
        if keccak256(&encoded) != *hash.as_bytes() {
            return Err(ObservationError::HeaderHashMismatch);
        }
        let fields = rlp::decode_flat_list(&encoded)
            .map_err(|error| ObservationError::MalformedHeader(error.reason()))?;
        if fields.len() < ETHEREUM_HEADER_MIN_FIELDS {
            return Err(ObservationError::MalformedHeader(
                "fewer than fifteen header fields",
            ));
        }
        let field = |index: usize| fields.get(index).copied().unwrap_or_default();
        let parent_hash = fixed_field::<32>(field(0), "parent hash")?;
        fixed_field::<32>(field(1), "ommers hash")?;
        fixed_field::<20>(field(2), "beneficiary")?;
        let state_root = fixed_field::<32>(field(3), "state root")?;
        let transactions_root = fixed_field::<32>(field(4), "transactions root")?;
        let receipts_root = fixed_field::<32>(field(5), "receipts root")?;
        let logs_bloom = fixed_field::<256>(field(6), "logs bloom")?;
        let number = rlp::decode_u64(field(8))
            .map_err(|error| ObservationError::MalformedHeader(error.reason()))?;
        let timestamp = rlp::decode_u64(field(11))
            .map_err(|error| ObservationError::MalformedHeader(error.reason()))?;
        fixed_field::<32>(field(13), "mix hash")?;
        fixed_field::<8>(field(14), "nonce")?;
        let field_count = fields.len();
        Ok(Self {
            encoding: HeaderEncoding::EthereumRlp,
            hash,
            encoded,
            field_count,
            number,
            parent_hash,
            state_root,
            transactions_root,
            receipts_root,
            logs_bloom,
            timestamp,
        })
    }

    pub const fn encoding(&self) -> HeaderEncoding {
        self.encoding
    }

    pub const fn hash(&self) -> Hash32 {
        self.hash
    }

    pub fn encoded(&self) -> &[u8] {
        &self.encoded
    }

    pub const fn field_count(&self) -> usize {
        self.field_count
    }

    pub const fn number(&self) -> u64 {
        self.number
    }

    pub const fn parent_hash(&self) -> &[u8; 32] {
        &self.parent_hash
    }

    pub const fn state_root(&self) -> &[u8; 32] {
        &self.state_root
    }

    pub const fn transactions_root(&self) -> &[u8; 32] {
        &self.transactions_root
    }

    pub const fn receipts_root(&self) -> &[u8; 32] {
        &self.receipts_root
    }

    pub const fn logs_bloom(&self) -> &[u8; 256] {
        &self.logs_bloom
    }

    pub const fn timestamp(&self) -> u64 {
        self.timestamp
    }

    /// Raw encoded header field by position.
    pub fn field(&self, index: usize) -> Option<Vec<u8>> {
        rlp::decode_flat_list(&self.encoded)
            .ok()?
            .get(index)
            .map(|field| field.to_vec())
    }

    /// The state anchor established by this verified header.
    pub fn anchor(&self, chain: ChainDomain) -> Result<StateAnchor, ObservationError> {
        let parent_hash = Hash32::new(self.parent_hash)
            .map_err(|_| ObservationError::ZeroValue("parent_hash"))?;
        let state_root =
            Hash32::new(self.state_root).map_err(|_| ObservationError::ZeroValue("state_root"))?;
        StateAnchor::new(
            chain,
            self.number,
            self.hash,
            parent_hash,
            self.timestamp,
            state_root,
        )
    }
}

impl ObservationPayload for BlockHeaderEnvelope {
    const CLASS: ObservationClass = ObservationClass::BlockHeader;

    fn canonical_payload_bytes(&self) -> Result<Vec<u8>, ObservationError> {
        let mut out = Vec::with_capacity(37 + self.encoded.len());
        out.push(self.encoding.tag());
        out.extend_from_slice(self.hash.as_bytes());
        push_length_prefixed(&mut out, &self.encoded)?;
        Ok(out)
    }

    fn decode_canonical_payload(bytes: &[u8]) -> Result<Self, ObservationError> {
        let mut reader = Reader::new(bytes);
        let encoding = HeaderEncoding::from_tag(reader.u8()?)?;
        let hash = reader.hash()?;
        let encoded = reader.length_prefixed()?.to_vec();
        reader.finish()?;
        Self::new(encoding, hash, encoded)
    }

    fn validate_anchor(&self, anchor: &StateAnchor) -> Result<(), ObservationError> {
        let mismatch = if anchor.block_number() != self.number {
            Some(AnchorMismatchField::BlockNumber)
        } else if anchor.block_hash() != self.hash {
            Some(AnchorMismatchField::BlockHash)
        } else if anchor.parent_hash().as_bytes() != &self.parent_hash {
            Some(AnchorMismatchField::ParentHash)
        } else if anchor.timestamp() != self.timestamp {
            Some(AnchorMismatchField::Timestamp)
        } else if anchor.state_root().as_bytes() != &self.state_root {
            Some(AnchorMismatchField::StateRoot)
        } else {
            None
        };
        mismatch.map_or(Ok(()), |field| {
            Err(ObservationError::HeaderAnchorMismatch(field))
        })
    }
}

impl<T: ObservationPayload> CensusObservation<T> {
    /// Binds a typed raw payload to its anchor, semantics, and provenance. The
    /// provenance authority must be the one admissible for the payload class
    /// and every digest is computed here.
    pub fn observe(
        anchor: StateAnchor,
        semantics: ObservationSemantics,
        provenance: ObservationProvenance,
        payload: T,
    ) -> Result<Self, ObservationError> {
        require_class_authority(T::CLASS, &provenance)?;
        payload.validate_anchor(&anchor)?;
        let raw_payload_digest = payload.payload_digest()?;
        Ok(Self {
            envelope: ObservationEnvelope::new(anchor, semantics, provenance, raw_payload_digest),
            payload,
        })
    }

    pub const fn class(&self) -> ObservationClass {
        T::CLASS
    }

    /// Fails unless this observation is anchored exactly at `expected`.
    pub fn require_anchor(&self, expected: &StateAnchor) -> Result<(), ObservationError> {
        compare_anchors(self.envelope.anchor(), expected).map_err(ObservationError::AnchorMismatch)
    }

    /// Canonical typed encoding:
    /// `MAGIC || schema:u16 || class:u8 || TLV(1 anchor, 2 semantics,
    /// 3 provenance, 4 payload, 5 raw digest, 6 observation digest)`.
    pub fn canonical_bytes(&self) -> Result<Vec<u8>, ObservationError> {
        require_class_authority(T::CLASS, self.envelope.provenance())?;
        let payload = self.payload.canonical_payload_bytes()?;
        let mut out = Vec::with_capacity(TYPED_OBSERVATION_MAGIC.len() + 450 + payload.len());
        out.extend_from_slice(TYPED_OBSERVATION_MAGIC);
        out.extend_from_slice(&TYPED_OBSERVATION_SCHEMA_VERSION.to_be_bytes());
        out.push(T::CLASS.tag());
        push_tlv(&mut out, 1, &anchor_bytes(self.envelope.anchor()))?;
        push_tlv(&mut out, 2, &semantics_bytes(self.envelope.semantics()))?;
        push_tlv(&mut out, 3, &provenance_bytes(self.envelope.provenance()))?;
        push_tlv(&mut out, 4, &payload)?;
        push_tlv(&mut out, 5, self.envelope.raw_payload_digest().as_bytes())?;
        push_tlv(&mut out, 6, self.envelope.digest().as_bytes())?;
        Ok(out)
    }

    /// Strict inverse of `canonical_bytes`. Every digest is recomputed; stored
    /// digests that disagree with the content are rejected, as is any
    /// non-canonical byte representation.
    pub fn decode_canonical(bytes: &[u8]) -> Result<Self, ObservationError> {
        let found = peek_observation_class(bytes)?;
        if found != T::CLASS {
            return Err(ObservationError::ClassMismatch {
                expected: T::CLASS,
                found,
            });
        }
        let mut reader = Reader::new(bytes.get(TYPED_HEADER_LEN..).unwrap_or_default());
        let anchor = decode_anchor(reader.tlv(1)?)?;
        let semantics = decode_semantics(reader.tlv(2)?)?;
        let provenance = decode_provenance(reader.tlv(3)?)?;
        let payload = T::decode_canonical_payload(reader.tlv(4)?)?;
        let raw_payload_digest = fixed_value::<32>(reader.tlv(5)?)?;
        let observation_digest = fixed_value::<32>(reader.tlv(6)?)?;
        reader.finish()?;

        let observation = Self::observe(anchor, semantics, provenance, payload)?;
        if observation.envelope.raw_payload_digest().as_bytes() != &raw_payload_digest {
            return Err(ObservationError::DigestMismatch("raw payload"));
        }
        if observation.envelope.digest().as_bytes() != &observation_digest {
            return Err(ObservationError::DigestMismatch("observation"));
        }
        if observation.canonical_bytes()? != bytes {
            return Err(ObservationError::MalformedCanonical(
                "non-canonical observation bytes",
            ));
        }
        Ok(observation)
    }
}

const TYPED_HEADER_LEN: usize = 14 + 2 + 1;

/// Reads the class of a canonical typed observation without decoding it.
pub fn peek_observation_class(bytes: &[u8]) -> Result<ObservationClass, ObservationError> {
    let mut reader = Reader::new(bytes);
    if reader.take(TYPED_OBSERVATION_MAGIC.len())? != TYPED_OBSERVATION_MAGIC {
        return Err(ObservationError::MalformedCanonical("bad magic"));
    }
    if reader.u16()? != TYPED_OBSERVATION_SCHEMA_VERSION {
        return Err(ObservationError::MalformedCanonical(
            "unsupported schema version",
        ));
    }
    ObservationClass::from_tag(reader.u8()?)
}

fn require_class_authority(
    class: ObservationClass,
    provenance: &ObservationProvenance,
) -> Result<(), ObservationError> {
    if provenance.authority() != class.required_authority() {
        return Err(ObservationError::ProvenanceClassMismatch {
            class,
            authority: provenance.authority(),
        });
    }
    Ok(())
}

fn domain_digest(domain: &[u8], payload: &[u8]) -> ObservationDigest {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    ObservationDigest(finalize_hash(hasher))
}

fn fixed_field<const N: usize>(
    bytes: &[u8],
    name: &'static str,
) -> Result<[u8; N], ObservationError> {
    <[u8; N]>::try_from(bytes).map_err(|_| ObservationError::MalformedHeader(name))
}

fn fixed_value<const N: usize>(bytes: &[u8]) -> Result<[u8; N], ObservationError> {
    <[u8; N]>::try_from(bytes).map_err(|_| ObservationError::MalformedCanonical("fixed width"))
}

fn push_length_prefixed(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), ObservationError> {
    let length = u32::try_from(bytes.len()).map_err(|_| ObservationError::PayloadTooLarge)?;
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}

fn push_tlv(out: &mut Vec<u8>, tag: u8, value: &[u8]) -> Result<(), ObservationError> {
    out.push(tag);
    push_length_prefixed(out, value)
}

fn anchor_bytes(anchor: &StateAnchor) -> Vec<u8> {
    let mut out = Vec::with_capacity(184);
    out.extend_from_slice(&anchor.chain().chain_id().to_be_bytes());
    out.extend_from_slice(anchor.chain().genesis_hash().as_bytes());
    out.extend_from_slice(anchor.chain().fork_lineage().as_bytes());
    out.extend_from_slice(&anchor.block_number().to_be_bytes());
    out.extend_from_slice(anchor.block_hash().as_bytes());
    out.extend_from_slice(anchor.parent_hash().as_bytes());
    out.extend_from_slice(&anchor.timestamp().to_be_bytes());
    out.extend_from_slice(anchor.state_root().as_bytes());
    out
}

fn decode_anchor(bytes: &[u8]) -> Result<StateAnchor, ObservationError> {
    let mut reader = Reader::new(bytes);
    let chain_id = reader.u64()?;
    let genesis_hash = reader.hash()?;
    let fork_lineage = reader.hash()?;
    let block_number = reader.u64()?;
    let block_hash = reader.hash()?;
    let parent_hash = reader.hash()?;
    let timestamp = reader.u64()?;
    let state_root = reader.hash()?;
    reader.finish()?;
    let chain = ChainDomain::new(chain_id, genesis_hash, fork_lineage)
        .map_err(|_| ObservationError::MalformedCanonical("invalid chain domain"))?;
    StateAnchor::new(
        chain,
        block_number,
        block_hash,
        parent_hash,
        timestamp,
        state_root,
    )
}

fn semantics_bytes(semantics: ObservationSemantics) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(semantics.code_hash().as_bytes());
    out.extend_from_slice(semantics.configuration_hash().as_bytes());
    out
}

fn decode_semantics(bytes: &[u8]) -> Result<ObservationSemantics, ObservationError> {
    let mut reader = Reader::new(bytes);
    let code_hash = reader.hash()?;
    let configuration_hash = reader.hash()?;
    reader.finish()?;
    Ok(ObservationSemantics::new(code_hash, configuration_hash))
}

fn provenance_bytes(provenance: &ObservationProvenance) -> Vec<u8> {
    let mut out = Vec::with_capacity(99);
    out.push(provenance.authority().tag());
    out.extend_from_slice(&provenance.source_namespace().to_be_bytes());
    out.extend_from_slice(provenance.source_locator_hash().as_bytes());
    out.extend_from_slice(provenance.request_hash().as_bytes());
    out.extend_from_slice(provenance.response_hash().as_bytes());
    out
}

fn decode_provenance(bytes: &[u8]) -> Result<ObservationProvenance, ObservationError> {
    let mut reader = Reader::new(bytes);
    let authority = ProvenanceAuthority::from_tag(reader.u8()?)?;
    let source_namespace = reader.u16()?;
    let source_locator_hash = reader.hash()?;
    let request_hash = reader.hash()?;
    let response_hash = reader.hash()?;
    reader.finish()?;
    ObservationProvenance::new(
        authority,
        source_namespace,
        source_locator_hash,
        request_hash,
        response_hash,
    )
}

struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], ObservationError> {
        if self.bytes.len() < length {
            return Err(ObservationError::MalformedCanonical("truncated"));
        }
        let (head, tail) = self.bytes.split_at(length);
        self.bytes = tail;
        Ok(head)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], ObservationError> {
        fixed_value::<N>(self.take(N)?)
    }

    fn u8(&mut self) -> Result<u8, ObservationError> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, ObservationError> {
        Ok(u16::from_be_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, ObservationError> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    fn u64(&mut self) -> Result<u64, ObservationError> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    fn flag(&mut self) -> Result<bool, ObservationError> {
        match self.u8()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err(ObservationError::MalformedCanonical("non-canonical flag")),
        }
    }

    fn hash(&mut self) -> Result<Hash32, ObservationError> {
        Hash32::new(self.array()?).map_err(|_| ObservationError::MalformedCanonical("zero hash"))
    }

    fn address(&mut self) -> Result<Address, ObservationError> {
        Address::new(self.array()?)
            .map_err(|_| ObservationError::MalformedCanonical("zero address"))
    }

    fn length_prefixed(&mut self) -> Result<&'a [u8], ObservationError> {
        let length = usize::try_from(self.u32()?)
            .map_err(|_| ObservationError::MalformedCanonical("length overflow"))?;
        self.take(length)
    }

    fn tlv(&mut self, expected_tag: u8) -> Result<&'a [u8], ObservationError> {
        if self.u8()? != expected_tag {
            return Err(ObservationError::MalformedCanonical(
                "missing, unknown, or reordered field",
            ));
        }
        self.length_prefixed()
    }

    fn finish(self) -> Result<(), ObservationError> {
        if self.bytes.is_empty() {
            Ok(())
        } else {
            Err(ObservationError::MalformedCanonical("trailing bytes"))
        }
    }
}

pub fn require_same_anchor<A, B>(
    left: &CensusObservation<A>,
    right: &CensusObservation<B>,
) -> Result<(), ObservationError> {
    compare_anchors(left.envelope().anchor(), right.envelope().anchor())
        .map_err(ObservationError::AnchorMismatch)
}

fn compare_anchors(left: &StateAnchor, right: &StateAnchor) -> Result<(), AnchorMismatchField> {
    if left.chain() != right.chain() {
        return Err(AnchorMismatchField::ChainDomain);
    }
    if left.block_number() != right.block_number() {
        return Err(AnchorMismatchField::BlockNumber);
    }
    if left.block_hash() != right.block_hash() {
        return Err(AnchorMismatchField::BlockHash);
    }
    if left.parent_hash() != right.parent_hash() {
        return Err(AnchorMismatchField::ParentHash);
    }
    if left.timestamp() != right.timestamp() {
        return Err(AnchorMismatchField::Timestamp);
    }
    if left.state_root() != right.state_root() {
        return Err(AnchorMismatchField::StateRoot);
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
