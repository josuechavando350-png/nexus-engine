use crate::canonical::{self, Encoder, Kind, CHUNK_DOMAIN, FRAME_DOMAIN};
use crate::chunker::{self, GearTable};
use crate::codec;
use crate::config::{CompressionPolicy, ConfigId, StoreConfig};
use crate::error::StoreError;
use nqc_census_core::{EvidenceRef, Hash32};

const CHUNK_ENTRY_LEN: usize = 72;
const FRAME_RAW: u8 = 1;
const FRAME_NQC_LZ_V1: u8 = 2;

/// Logical evidence identity: plain `SHA256(logical bytes)`.
///
/// This is the Protocol/Fork evidence-manifest convention
/// (`artifact_digest_algorithm = sha256`), so any artifact can be checked with a
/// stock `sha256sum` and it maps directly onto RMC-003 `EvidenceRef::Artifact`.
/// It is independent of chunking, compression and every store setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtifactId([u8; 32]);

impl ArtifactId {
    pub fn of(bytes: &[u8]) -> Self {
        Self(canonical::plain_sha256(bytes))
    }

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn parse_hex(text: &str) -> Result<Self, StoreError> {
        canonical::parse_hex32(text)
            .map(Self)
            .ok_or(StoreError::malformed(
                "artifact id",
                "expected 64 lowercase hex",
            ))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        canonical::hex(&self.0)
    }

    /// The RMC-003 evidence reference for this artifact.
    pub fn evidence_ref(&self) -> Result<EvidenceRef, StoreError> {
        Ok(EvidenceRef::Artifact(Hash32::new(self.0)?))
    }
}

/// Identity of one logical chunk: `SHA256("NQC-CENSUS-STORE-CHUNK-V1" || 0x00 || raw)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ChunkId([u8; 32]);

impl ChunkId {
    pub(crate) fn of(raw: &[u8]) -> Self {
        Self(canonical::domain_digest(CHUNK_DOMAIN, raw))
    }

    pub(crate) const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        canonical::hex(&self.0)
    }
}

/// One row of the manifest chunk table. Two integrity layers are recorded:
/// `frame_digest` covers the stored bytes, `id` covers the logical bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChunkEntry {
    pub id: ChunkId,
    pub raw_len: u32,
    pub stored_len: u32,
    pub frame_digest: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub config_id: ConfigId,
    pub artifact_id: ArtifactId,
    pub logical_len: u64,
    pub chunks: Vec<ChunkEntry>,
}

pub(crate) struct EncodedArtifact {
    pub(crate) id: ArtifactId,
    pub(crate) manifest_bytes: Vec<u8>,
    pub(crate) frames: Vec<(ChunkId, Vec<u8>)>,
}

/// Deterministically encodes `bytes` into frames and a manifest. The output is a
/// pure function of `(bytes, config)`.
pub(crate) fn encode_artifact(
    bytes: &[u8],
    config: &StoreConfig,
    config_id: ConfigId,
    gear: &GearTable,
) -> Result<EncodedArtifact, StoreError> {
    if bytes.is_empty() {
        return Err(StoreError::ArtifactEmpty);
    }
    let length = u64::try_from(bytes.len()).map_err(|_| StoreError::ArtifactTooLarge {
        length: u64::MAX,
        limit: config.max_artifact_bytes(),
    })?;
    if length > config.max_artifact_bytes() {
        return Err(StoreError::ArtifactTooLarge {
            length,
            limit: config.max_artifact_bytes(),
        });
    }

    let mut frames = Vec::new();
    let mut entries = Vec::new();
    let mut offset = 0_usize;
    for chunk_len in chunker::chunk_lengths(bytes, config, gear) {
        let end = offset + chunk_len;
        let raw = bytes
            .get(offset..end)
            .ok_or(StoreError::malformed("chunker", "boundary outside input"))?;
        offset = end;
        let frame = encode_frame(raw, config)?;
        let entry = ChunkEntry {
            id: ChunkId::of(raw),
            raw_len: u32::try_from(raw.len())
                .map_err(|_| StoreError::malformed("chunker", "chunk exceeds u32"))?,
            stored_len: u32::try_from(frame.len())
                .map_err(|_| StoreError::malformed("chunk frame", "frame exceeds u32"))?,
            frame_digest: canonical::domain_digest(FRAME_DOMAIN, &frame),
        };
        entries.push(entry);
        frames.push((entry.id, frame));
    }

    let manifest = Manifest {
        config_id,
        artifact_id: ArtifactId::of(bytes),
        logical_len: length,
        chunks: entries,
    };
    Ok(EncodedArtifact {
        id: manifest.artifact_id,
        manifest_bytes: encode_manifest(&manifest)?,
        frames,
    })
}

pub(crate) fn encode_frame(raw: &[u8], config: &StoreConfig) -> Result<Vec<u8>, StoreError> {
    let raw_len = u32::try_from(raw.len())
        .map_err(|_| StoreError::malformed("chunk frame", "chunk exceeds u32"))?;
    let compressed = match config.compression() {
        CompressionPolicy::RawOnly => None,
        CompressionPolicy::NqcLzV1WhenSmaller => {
            Some(codec::compress(raw)).filter(|packed| packed.len() < raw.len())
        }
    };
    let (codec_tag, payload) = match &compressed {
        Some(packed) => (FRAME_NQC_LZ_V1, packed.as_slice()),
        None => (FRAME_RAW, raw),
    };
    Ok(Encoder::new(Kind::ChunkFrame)
        .u8(1, codec_tag)?
        .u32(2, raw_len)?
        .bytes(3, payload)?
        .finish())
}

/// Decodes a stored frame into logical bytes, enforcing the persisted policy and
/// the expected logical length before any allocation proportional to it.
pub(crate) fn decode_frame(
    frame: &[u8],
    expected_raw_len: u32,
    config: &StoreConfig,
) -> Result<Vec<u8>, StoreError> {
    let object = Kind::ChunkFrame.name();
    let fields = canonical::parse(frame, Kind::ChunkFrame, &[&[1, 2, 3]])?;
    let raw_len = fields.u32(2)?;
    if raw_len == 0 || raw_len > config.chunk_max() {
        return Err(StoreError::malformed(
            object,
            "raw length outside policy bounds",
        ));
    }
    if raw_len != expected_raw_len {
        return Err(StoreError::malformed(
            object,
            "raw length differs from manifest",
        ));
    }
    let raw_len_usize = usize::try_from(raw_len)
        .map_err(|_| StoreError::malformed(object, "raw length overflow"))?;
    let payload = fields.bytes(3)?;
    match fields.u8(1)? {
        FRAME_RAW => {
            if payload.len() != raw_len_usize {
                return Err(StoreError::malformed(object, "raw payload length mismatch"));
            }
            Ok(payload.to_vec())
        }
        FRAME_NQC_LZ_V1 => {
            if config.compression() != CompressionPolicy::NqcLzV1WhenSmaller {
                return Err(StoreError::malformed(
                    object,
                    "compressed frame under a raw-only policy",
                ));
            }
            if payload.len() >= raw_len_usize {
                return Err(StoreError::NonCanonical { object });
            }
            codec::decompress(payload, raw_len_usize)
                .map_err(|error| StoreError::Codec(error.reason()))
        }
        _ => Err(StoreError::malformed(object, "unknown frame codec")),
    }
}

/// Decodes a frame using the raw length it declares (bounded by policy); used
/// when a frame is examined on its own rather than through a manifest.
pub(crate) fn decode_frame_standalone(
    frame: &[u8],
    config: &StoreConfig,
) -> Result<Vec<u8>, StoreError> {
    let fields = canonical::parse(frame, Kind::ChunkFrame, &[&[1, 2, 3]])?;
    decode_frame(frame, fields.u32(2)?, config)
}

pub(crate) fn encode_manifest(manifest: &Manifest) -> Result<Vec<u8>, StoreError> {
    let mut table = Vec::with_capacity(manifest.chunks.len() * CHUNK_ENTRY_LEN);
    for entry in &manifest.chunks {
        table.extend_from_slice(entry.id.as_bytes());
        table.extend_from_slice(&entry.raw_len.to_be_bytes());
        table.extend_from_slice(&entry.stored_len.to_be_bytes());
        table.extend_from_slice(&entry.frame_digest);
    }
    Ok(Encoder::new(Kind::Manifest)
        .bytes(1, manifest.config_id.as_bytes())?
        .bytes(2, manifest.artifact_id.as_bytes())?
        .u64(3, manifest.logical_len)?
        .bytes(4, &table)?
        .finish())
}

/// Strictly decodes a manifest and checks every bound that can be checked
/// without reading chunks. Canonicality is proven later by re-encoding.
pub(crate) fn decode_manifest(bytes: &[u8], config: &StoreConfig) -> Result<Manifest, StoreError> {
    let object = Kind::Manifest.name();
    let fields = canonical::parse(bytes, Kind::Manifest, &[&[1, 2, 3, 4]])?;
    let config_id = ConfigId(fields.fixed::<32>(1)?);
    let artifact_id = ArtifactId(fields.fixed::<32>(2)?);
    let logical_len = fields.u64(3)?;
    let table = fields.bytes(4)?;

    if logical_len == 0 || logical_len > config.max_artifact_bytes() {
        return Err(StoreError::malformed(
            object,
            "logical length outside policy bounds",
        ));
    }
    if table.is_empty() || table.len() % CHUNK_ENTRY_LEN != 0 {
        return Err(StoreError::malformed(object, "chunk table length"));
    }
    let count = u64::try_from(table.len() / CHUNK_ENTRY_LEN)
        .map_err(|_| StoreError::malformed(object, "chunk count overflow"))?;
    if count > config.max_chunks() || count > logical_len {
        return Err(StoreError::malformed(
            object,
            "chunk count outside policy bounds",
        ));
    }

    let mut chunks = Vec::with_capacity(table.len() / CHUNK_ENTRY_LEN);
    let mut total = 0_u64;
    let (rows, _) = table.as_chunks::<CHUNK_ENTRY_LEN>();
    for row in rows {
        let (id, rest) = row.split_at(32);
        let (raw_len, rest) = rest.split_at(4);
        let (stored_len, digest) = rest.split_at(4);
        let entry = ChunkEntry {
            id: ChunkId(to_array::<32>(id, object)?),
            raw_len: u32::from_be_bytes(to_array::<4>(raw_len, object)?),
            stored_len: u32::from_be_bytes(to_array::<4>(stored_len, object)?),
            frame_digest: to_array::<32>(digest, object)?,
        };
        if entry.raw_len == 0 || entry.raw_len > config.chunk_max() {
            return Err(StoreError::malformed(
                object,
                "chunk length outside policy bounds",
            ));
        }
        if u64::from(entry.stored_len) > config.max_frame_bytes() {
            return Err(StoreError::malformed(
                object,
                "frame length outside policy bounds",
            ));
        }
        total = total
            .checked_add(u64::from(entry.raw_len))
            .ok_or(StoreError::malformed(object, "logical length overflow"))?;
        chunks.push(entry);
    }
    if total != logical_len {
        return Err(StoreError::malformed(
            object,
            "chunk lengths do not sum to logical length",
        ));
    }
    Ok(Manifest {
        config_id,
        artifact_id,
        logical_len,
        chunks,
    })
}

pub(crate) fn frame_digest(frame: &[u8]) -> [u8; 32] {
    canonical::domain_digest(FRAME_DOMAIN, frame)
}

fn to_array<const N: usize>(bytes: &[u8], object: &'static str) -> Result<[u8; N], StoreError> {
    <[u8; N]>::try_from(bytes).map_err(|_| StoreError::malformed(object, "fixed-width field"))
}
