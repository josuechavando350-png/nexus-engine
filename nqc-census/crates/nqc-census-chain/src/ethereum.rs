//! Ethereum header reconstruction and chain-domain derivation.
//!
//! A JSON-RPC block object is never trusted as-is. Its header fields are
//! re-encoded as canonical RLP in consensus order and the claimed hash is
//! accepted only if it equals `keccak256(rlp)` (checked inside RMC-003's
//! `BlockHeaderEnvelope`). Which optional fields exist is decided by explicit
//! hard-fork eras, and the fields present in the provider's object must match
//! the era of that block exactly; an unknown field fails closed.

use crate::error::ChainError;
use crate::hex;
use crate::json::Json;
use nqc_census_core::{BlockHeaderEnvelope, ChainDomain, Hash32, HeaderEncoding};
use sha2::{Digest, Sha256};

pub const MAINNET_CHAIN_ID: u64 = 1;
/// Declared identity of the target chain; verified from the block-0 header.
pub const MAINNET_GENESIS_HASH: &str =
    "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3";
/// Lineage checkpoint: the first block of the DAO-fork lineage, which
/// separates this chain from the chain that shares its genesis and chain id
/// history. Verified from its header on every provider.
pub const MAINNET_LINEAGE_BLOCK: u64 = 1_920_000;
pub const MAINNET_LINEAGE_HASH: &str =
    "0x4985f5ca3d2afbec36529aa96f74de3cc10a2a4a6c44f2157a57d2c6059a11bb";

const LONDON_BLOCK: u64 = 12_965_000;
const SHANGHAI_TIME: u64 = 1_681_338_455;
const CANCUN_TIME: u64 = 1_710_338_135;
const PRAGUE_TIME: u64 = 1_746_612_311;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Hash,
    Address,
    Bloom,
    Quantity,
    Data,
    Nonce,
}

const BASE_FIELDS: [(&str, Kind); 15] = [
    ("parentHash", Kind::Hash),
    ("sha3Uncles", Kind::Hash),
    ("miner", Kind::Address),
    ("stateRoot", Kind::Hash),
    ("transactionsRoot", Kind::Hash),
    ("receiptsRoot", Kind::Hash),
    ("logsBloom", Kind::Bloom),
    ("difficulty", Kind::Quantity),
    ("number", Kind::Quantity),
    ("gasLimit", Kind::Quantity),
    ("gasUsed", Kind::Quantity),
    ("timestamp", Kind::Quantity),
    ("extraData", Kind::Data),
    ("mixHash", Kind::Hash),
    ("nonce", Kind::Nonce),
];

/// Optional header fields in consensus order; each era is a prefix.
const OPTIONAL_FIELDS: [(&str, Kind); 6] = [
    ("baseFeePerGas", Kind::Quantity),
    ("withdrawalsRoot", Kind::Hash),
    ("blobGasUsed", Kind::Quantity),
    ("excessBlobGas", Kind::Quantity),
    ("parentBeaconBlockRoot", Kind::Hash),
    ("requestsHash", Kind::Hash),
];

/// Block-object members that are not header fields.
const NON_HEADER_FIELDS: [&str; 6] = [
    "hash",
    "size",
    "totalDifficulty",
    "transactions",
    "uncles",
    "withdrawals",
];

/// Named header era with the exact number of optional fields it carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeaderEra {
    Frontier,
    London,
    Shanghai,
    Cancun,
    Prague,
}

impl HeaderEra {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Frontier => "FRONTIER_TO_BERLIN",
            Self::London => "LONDON_TO_PARIS",
            Self::Shanghai => "SHANGHAI",
            Self::Cancun => "CANCUN",
            Self::Prague => "PRAGUE_OR_LATER_KNOWN",
        }
    }

    const fn optional_fields(self) -> usize {
        match self {
            Self::Frontier => 0,
            Self::London => 1,
            Self::Shanghai => 2,
            Self::Cancun => 5,
            Self::Prague => 6,
        }
    }

    /// Mainnet era by block number (London) and timestamp (post-merge forks).
    pub const fn mainnet(number: u64, timestamp: u64) -> Self {
        if number < LONDON_BLOCK {
            Self::Frontier
        } else if timestamp < SHANGHAI_TIME {
            Self::London
        } else if timestamp < CANCUN_TIME {
            Self::Shanghai
        } else if timestamp < PRAGUE_TIME {
            Self::Cancun
        } else {
            Self::Prague
        }
    }
}

fn rlp_string(value: &[u8], out: &mut Vec<u8>) {
    if value.len() == 1 && value[0] < 0x80 {
        out.push(value[0]);
    } else {
        rlp_length(0x80, value.len(), out);
        out.extend_from_slice(value);
    }
}

fn rlp_length(offset: u8, length: usize, out: &mut Vec<u8>) {
    if length <= 55 {
        out.push(offset + length as u8);
    } else {
        let bytes = length.to_be_bytes();
        let first = bytes
            .iter()
            .position(|byte| *byte != 0)
            .unwrap_or(bytes.len() - 1);
        out.push(offset + 55 + (bytes.len() - first) as u8);
        out.extend_from_slice(&bytes[first..]);
    }
}

fn field_bytes(object: &Json, name: &str, kind: Kind) -> Result<Vec<u8>, ChainError> {
    let text = object
        .get(name)
        .and_then(Json::as_str)
        .ok_or(ChainError::Header("missing header field"))?;
    let bytes = match kind {
        Kind::Quantity => hex::decode_quantity_bytes(text)?,
        _ => hex::decode_data(text)?,
    };
    let expected = match kind {
        Kind::Hash => Some(32),
        Kind::Address => Some(20),
        Kind::Bloom => Some(256),
        Kind::Nonce => Some(8),
        Kind::Quantity | Kind::Data => None,
    };
    if expected.is_some_and(|width| bytes.len() != width) {
        return Err(ChainError::Header("header field has the wrong width"));
    }
    Ok(bytes)
}

/// A header proven by recomputing its hash from reconstructed canonical RLP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedHeader {
    envelope: BlockHeaderEnvelope,
    era: HeaderEra,
}

impl VerifiedHeader {
    pub const fn envelope(&self) -> &BlockHeaderEnvelope {
        &self.envelope
    }

    pub fn into_envelope(self) -> BlockHeaderEnvelope {
        self.envelope
    }

    pub const fn era(&self) -> HeaderEra {
        self.era
    }

    pub const fn number(&self) -> u64 {
        self.envelope.number()
    }

    pub const fn hash(&self) -> Hash32 {
        self.envelope.hash()
    }
}

/// Re-encodes the header fields of a JSON-RPC block object as canonical RLP,
/// enforcing the exact field set of the block's hard-fork era.
pub fn header_rlp(object: &Json) -> Result<(Vec<u8>, HeaderEra), ChainError> {
    let members = object
        .as_object()
        .ok_or(ChainError::Header("block is not an object"))?;
    let known = |key: &str| {
        BASE_FIELDS.iter().any(|(name, _)| *name == key)
            || OPTIONAL_FIELDS.iter().any(|(name, _)| *name == key)
            || NON_HEADER_FIELDS.contains(&key)
    };
    if let Some((unknown, _)) = members.iter().find(|(key, _)| !known(key)) {
        return Err(ChainError::UnsupportedHeaderField(unknown.clone()));
    }
    let number = hex::decode_quantity_u64(object.str_field("number")?)?;
    let timestamp = hex::decode_quantity_u64(object.str_field("timestamp")?)?;
    let era = HeaderEra::mainnet(number, timestamp);
    let present = OPTIONAL_FIELDS
        .iter()
        .take_while(|(name, _)| object.get(name).is_some())
        .count();
    if OPTIONAL_FIELDS[present..]
        .iter()
        .any(|(name, _)| object.get(name).is_some())
    {
        return Err(ChainError::Header(
            "optional header fields are not a prefix",
        ));
    }
    if present != era.optional_fields() {
        return Err(ChainError::Header(
            "optional header fields do not match the block's hard-fork era",
        ));
    }
    let mut payload = Vec::with_capacity(640);
    for (name, kind) in BASE_FIELDS.iter().chain(OPTIONAL_FIELDS[..present].iter()) {
        rlp_string(&field_bytes(object, name, *kind)?, &mut payload);
    }
    let mut encoded = Vec::with_capacity(payload.len() + 4);
    rlp_length(0xc0, payload.len(), &mut encoded);
    encoded.extend_from_slice(&payload);
    Ok((encoded, era))
}

/// Reconstructs and verifies a header from a JSON-RPC block object
/// (transactions as hashes or omitted): the claimed `hash` is accepted only if
/// it is the Keccak-256 of the reconstructed canonical RLP.
pub fn verify_mainnet_header(object: &Json) -> Result<VerifiedHeader, ChainError> {
    let (encoded, era) = header_rlp(object)?;
    let number = hex::decode_quantity_u64(object.str_field("number")?)?;
    let timestamp = hex::decode_quantity_u64(object.str_field("timestamp")?)?;
    let claimed = Hash32::new(hex::decode_fixed::<32>(object.str_field("hash")?)?)?;
    let envelope = BlockHeaderEnvelope::new(HeaderEncoding::EthereumRlp, claimed, encoded)?;
    if envelope.number() != number || envelope.timestamp() != timestamp {
        return Err(ChainError::Header(
            "decoded header disagrees with its object",
        ));
    }
    Ok(VerifiedHeader { envelope, era })
}

/// Declared identity of a chain: id, genesis hash, and one lineage checkpoint
/// block. Every value is re-verified from keccak-checked headers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChainProfile {
    chain_id: u64,
    genesis_hash: Hash32,
    lineage_block: u64,
    lineage_hash: Hash32,
}

impl ChainProfile {
    pub fn new(
        chain_id: u64,
        genesis_hash: Hash32,
        lineage_block: u64,
        lineage_hash: Hash32,
    ) -> Result<Self, ChainError> {
        if chain_id == 0 || lineage_block == 0 {
            return Err(ChainError::Config(
                "chain id and lineage block must be non-zero".into(),
            ));
        }
        Ok(Self {
            chain_id,
            genesis_hash,
            lineage_block,
            lineage_hash,
        })
    }

    pub fn mainnet() -> Result<Self, ChainError> {
        Self::new(
            MAINNET_CHAIN_ID,
            Hash32::parse_hex(MAINNET_GENESIS_HASH)?,
            MAINNET_LINEAGE_BLOCK,
            Hash32::parse_hex(MAINNET_LINEAGE_HASH)?,
        )
    }

    pub const fn chain_id(&self) -> u64 {
        self.chain_id
    }

    pub const fn lineage_block(&self) -> u64 {
        self.lineage_block
    }

    /// `fork_lineage = sha256("NQC-CENSUS-FORK-LINEAGE-V1" || 0 || chain_id ||
    /// genesis || lineage_block || lineage_hash)` over verified headers.
    pub fn derive_domain(
        &self,
        genesis: &BlockHeaderEnvelope,
        lineage: &BlockHeaderEnvelope,
    ) -> Result<ChainDomain, ChainError> {
        if genesis.number() != 0 || genesis.hash() != self.genesis_hash {
            return Err(ChainError::Config(format!(
                "genesis {} is not the declared genesis",
                genesis.hash().to_hex()
            )));
        }
        if lineage.number() != self.lineage_block || lineage.hash() != self.lineage_hash {
            return Err(ChainError::Config(format!(
                "lineage block {} {} is not the declared lineage",
                lineage.number(),
                lineage.hash().to_hex()
            )));
        }
        let mut hasher = Sha256::new();
        hasher.update(b"NQC-CENSUS-FORK-LINEAGE-V1");
        hasher.update([0]);
        hasher.update(self.chain_id.to_be_bytes());
        hasher.update(genesis.hash().as_bytes());
        hasher.update(self.lineage_block.to_be_bytes());
        hasher.update(lineage.hash().as_bytes());
        let lineage_id: [u8; 32] = hasher.finalize().into();
        Ok(ChainDomain::new(
            self.chain_id,
            genesis.hash(),
            Hash32::new(lineage_id)?,
        )?)
    }
}
