//! Canonical, versioned, byte-stable encoding for every durable store object.
//!
//! The layout follows the RMC-001 identity TLV discipline (magic, big-endian
//! schema version, object kind, strictly increasing `tag:u8 || len:u32-be ||
//! value` fields, exact field sets, no trailing bytes) under a distinct magic so
//! that a store object can never be parsed as an identity object or vice versa.
//! The RMC-001 codec is private to `identity.rs`, which is byte-immutable under
//! the RMC-001 regression gate, so it cannot be exported from there.

use crate::error::StoreError;
use sha2::{Digest, Sha256};

pub(crate) const MAGIC: &[u8; 16] = b"NQC-CENSUS-STORE";
pub const STORE_FORMAT_VERSION: u16 = 1;
const HEADER_LEN: usize = 19;
const FIELD_HEADER_LEN: usize = 5;

pub(crate) const CONFIG_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-CONFIG-V1";
pub(crate) const CHUNK_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-CHUNK-V1";
pub(crate) const FRAME_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-FRAME-V1";
pub(crate) const SCOPE_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-SCOPE-V1";
pub(crate) const CHECKPOINT_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-CHECKPOINT-V1";
pub(crate) const HEAD_SEAL_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-HEAD-SEAL-V1";
pub(crate) const GEAR_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-GEAR-V1";
pub(crate) const EVIDENCE_ROOT_DOMAIN: &[u8] = b"NQC-CENSUS-STORE-EVIDENCE-ROOT-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Config,
    ChunkFrame,
    Manifest,
    Scope,
    Checkpoint,
    Head,
    Anchor,
    Deployment,
}

impl Kind {
    const fn tag(self) -> u8 {
        match self {
            Self::Config => 0x01,
            Self::ChunkFrame => 0x02,
            Self::Manifest => 0x03,
            Self::Scope => 0x04,
            Self::Checkpoint => 0x05,
            Self::Head => 0x06,
            Self::Anchor => 0x07,
            Self::Deployment => 0x08,
        }
    }

    pub(crate) const fn name(self) -> &'static str {
        match self {
            Self::Config => "store config",
            Self::ChunkFrame => "chunk frame",
            Self::Manifest => "artifact manifest",
            Self::Scope => "stream scope",
            Self::Checkpoint => "checkpoint",
            Self::Head => "HEAD cache",
            Self::Anchor => "state anchor",
            Self::Deployment => "deployment binding",
        }
    }
}

pub(crate) struct Encoder {
    out: Vec<u8>,
    last_tag: u8,
}

impl Encoder {
    pub(crate) fn new(kind: Kind) -> Self {
        let mut out = Vec::with_capacity(128);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&STORE_FORMAT_VERSION.to_be_bytes());
        out.push(kind.tag());
        Self { out, last_tag: 0 }
    }

    pub(crate) fn bytes(mut self, tag: u8, value: &[u8]) -> Result<Self, StoreError> {
        if tag <= self.last_tag {
            return Err(StoreError::malformed(
                "canonical encoder",
                "field tags must be non-zero and strictly increasing",
            ));
        }
        let len = u32::try_from(value.len())
            .map_err(|_| StoreError::malformed("canonical encoder", "field exceeds u32 length"))?;
        self.out.push(tag);
        self.out.extend_from_slice(&len.to_be_bytes());
        self.out.extend_from_slice(value);
        self.last_tag = tag;
        Ok(self)
    }

    pub(crate) fn u8(self, tag: u8, value: u8) -> Result<Self, StoreError> {
        self.bytes(tag, &[value])
    }

    pub(crate) fn u16(self, tag: u8, value: u16) -> Result<Self, StoreError> {
        self.bytes(tag, &value.to_be_bytes())
    }

    pub(crate) fn u32(self, tag: u8, value: u32) -> Result<Self, StoreError> {
        self.bytes(tag, &value.to_be_bytes())
    }

    pub(crate) fn u64(self, tag: u8, value: u64) -> Result<Self, StoreError> {
        self.bytes(tag, &value.to_be_bytes())
    }

    pub(crate) fn finish(self) -> Vec<u8> {
        self.out
    }
}

pub(crate) struct Fields<'a> {
    object: &'static str,
    fields: Vec<(u8, &'a [u8])>,
}

/// Strictly parses one canonical object of `kind`. The field set must equal one
/// of `allowed` exactly (each alternative listed in increasing tag order).
pub(crate) fn parse<'a>(
    bytes: &'a [u8],
    kind: Kind,
    allowed: &[&[u8]],
) -> Result<Fields<'a>, StoreError> {
    let object = kind.name();
    let header = bytes
        .get(..HEADER_LEN)
        .ok_or(StoreError::malformed(object, "truncated header"))?;
    let (magic, rest) = header.split_at(MAGIC.len());
    if magic != MAGIC {
        return Err(StoreError::malformed(object, "invalid magic"));
    }
    let [v0, v1, found_kind] =
        <[u8; 3]>::try_from(rest).map_err(|_| StoreError::malformed(object, "truncated header"))?;
    let version = u16::from_be_bytes([v0, v1]);
    if version != STORE_FORMAT_VERSION {
        return Err(StoreError::UnsupportedFormatVersion(version));
    }
    if found_kind != kind.tag() {
        return Err(StoreError::malformed(object, "unexpected object kind"));
    }

    let mut cursor = HEADER_LEN;
    let mut last_tag = 0_u8;
    let mut fields = Vec::new();
    while cursor < bytes.len() {
        let field_header = bytes
            .get(cursor..cursor.saturating_add(FIELD_HEADER_LEN))
            .ok_or(StoreError::malformed(object, "truncated field header"))?;
        let [tag, l0, l1, l2, l3] = <[u8; 5]>::try_from(field_header)
            .map_err(|_| StoreError::malformed(object, "truncated field header"))?;
        if tag <= last_tag {
            return Err(StoreError::malformed(
                object,
                "field tags must be non-zero and strictly increasing",
            ));
        }
        last_tag = tag;
        let len = usize::try_from(u32::from_be_bytes([l0, l1, l2, l3]))
            .map_err(|_| StoreError::malformed(object, "field length overflow"))?;
        let start = cursor + FIELD_HEADER_LEN;
        let end = start
            .checked_add(len)
            .ok_or(StoreError::malformed(object, "field range overflow"))?;
        let value = bytes
            .get(start..end)
            .ok_or(StoreError::malformed(object, "truncated field value"))?;
        fields.push((tag, value));
        cursor = end;
    }

    let tags: Vec<u8> = fields.iter().map(|(tag, _)| *tag).collect();
    if !allowed.contains(&tags.as_slice()) {
        return Err(StoreError::malformed(
            object,
            "unexpected canonical field set",
        ));
    }
    Ok(Fields { object, fields })
}

impl<'a> Fields<'a> {
    pub(crate) fn has(&self, tag: u8) -> bool {
        self.fields.iter().any(|(candidate, _)| *candidate == tag)
    }

    pub(crate) fn bytes(&self, tag: u8) -> Result<&'a [u8], StoreError> {
        self.fields
            .iter()
            .find_map(|(candidate, value)| (*candidate == tag).then_some(*value))
            .ok_or(StoreError::malformed(self.object, "missing required field"))
    }

    pub(crate) fn fixed<const N: usize>(&self, tag: u8) -> Result<[u8; N], StoreError> {
        <[u8; N]>::try_from(self.bytes(tag)?)
            .map_err(|_| StoreError::malformed(self.object, "fixed-width field length mismatch"))
    }

    pub(crate) fn u8(&self, tag: u8) -> Result<u8, StoreError> {
        let [value] = self.fixed::<1>(tag)?;
        Ok(value)
    }

    pub(crate) fn u16(&self, tag: u8) -> Result<u16, StoreError> {
        Ok(u16::from_be_bytes(self.fixed::<2>(tag)?))
    }

    pub(crate) fn u32(&self, tag: u8) -> Result<u32, StoreError> {
        Ok(u32::from_be_bytes(self.fixed::<4>(tag)?))
    }

    pub(crate) fn u64(&self, tag: u8) -> Result<u64, StoreError> {
        Ok(u64::from_be_bytes(self.fixed::<8>(tag)?))
    }
}

/// `SHA256(domain || 0x00 || payload)`, the RMC-001 domain-separation rule.
pub(crate) fn domain_digest(domain: &[u8], payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(payload);
    finalize(hasher)
}

/// Plain `SHA256(payload)`, the Protocol/Fork evidence-artifact convention.
pub(crate) fn plain_sha256(payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(payload);
    finalize(hasher)
}

pub(crate) fn finalize(hasher: Sha256) -> [u8; 32] {
    let digest = hasher.finalize();
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

/// Parses exactly 64 lowercase hexadecimal characters. Uppercase, prefixes and
/// any other length are rejected so that each digest has one textual form.
pub(crate) fn parse_hex32(text: &str) -> Option<[u8; 32]> {
    let raw = text.as_bytes();
    if raw.len() != 64 {
        return None;
    }
    let mut out = [0_u8; 32];
    let (pairs, _) = raw.as_chunks::<2>();
    for (slot, [high, low]) in out.iter_mut().zip(pairs) {
        *slot = (nibble(*high)? << 4) | nibble(*low)?;
    }
    Some(out)
}

const fn nibble(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}
