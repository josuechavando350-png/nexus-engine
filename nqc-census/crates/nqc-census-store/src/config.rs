use crate::canonical::{self, Encoder, Kind, CONFIG_DOMAIN};
use crate::error::StoreError;

/// Smallest permitted minimum chunk size. Below the 64-byte gear-hash window a
/// boundary would depend on bytes outside the chunk being cut.
pub const CHUNK_MIN_FLOOR: u32 = 64;
/// Largest permitted chunk; bounds every allocation made while decoding a frame.
pub const CHUNK_MAX_CEILING: u32 = 4 * 1024 * 1024;
/// Largest permitted logical artifact; artifacts are handled in memory.
pub const ARTIFACT_MAX_CEILING: u64 = 1 << 30;
/// Bound on chunks per artifact, which bounds manifest size before it is read.
pub const MAX_CHUNKS_PER_ARTIFACT: u64 = 1 << 20;

const CHUNKER_GEAR_CDC_V1: u8 = 1;

/// Whether stored chunk frames may be compressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CompressionPolicy {
    /// Every frame stores raw bytes.
    RawOnly,
    /// A frame uses NQC-LZ-V1 exactly when that is strictly smaller than raw.
    NqcLzV1WhenSmaller,
}

impl CompressionPolicy {
    const fn tag(self) -> u8 {
        match self {
            Self::RawOnly => 1,
            Self::NqcLzV1WhenSmaller => 2,
        }
    }

    const fn from_tag(tag: u8) -> Result<Self, StoreError> {
        match tag {
            1 => Ok(Self::RawOnly),
            2 => Ok(Self::NqcLzV1WhenSmaller),
            _ => Err(StoreError::InvalidConfig("unknown compression policy")),
        }
    }
}

/// Every setting that affects stored encoding or decoding policy.
///
/// It is persisted once as `STORE`, validated on every open and bound by digest
/// into every manifest. Artifact and checkpoint identities do not depend on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct StoreConfig {
    chunk_min: u32,
    chunk_mask_bits: u8,
    chunk_max: u32,
    compression: CompressionPolicy,
    max_artifact_bytes: u64,
}

impl StoreConfig {
    pub fn new(
        chunk_min: u32,
        chunk_mask_bits: u8,
        chunk_max: u32,
        compression: CompressionPolicy,
        max_artifact_bytes: u64,
    ) -> Result<Self, StoreError> {
        if chunk_min < CHUNK_MIN_FLOOR {
            return Err(StoreError::InvalidConfig("chunk_min below 64 bytes"));
        }
        if chunk_max <= chunk_min {
            return Err(StoreError::InvalidConfig("chunk_max must exceed chunk_min"));
        }
        if chunk_max > CHUNK_MAX_CEILING {
            return Err(StoreError::InvalidConfig("chunk_max above 4 MiB"));
        }
        if !(4..=24).contains(&chunk_mask_bits) {
            return Err(StoreError::InvalidConfig(
                "chunk_mask_bits must be within 4..=24",
            ));
        }
        if max_artifact_bytes == 0 || max_artifact_bytes > ARTIFACT_MAX_CEILING {
            return Err(StoreError::InvalidConfig(
                "max_artifact_bytes must be within 1..=1 GiB",
            ));
        }
        if max_artifact_bytes.div_ceil(u64::from(chunk_min)) > MAX_CHUNKS_PER_ARTIFACT {
            return Err(StoreError::InvalidConfig(
                "max_artifact_bytes / chunk_min exceeds the chunk-count bound",
            ));
        }
        Ok(Self {
            chunk_min,
            chunk_mask_bits,
            chunk_max,
            compression,
            max_artifact_bytes,
        })
    }

    /// Production default: 8 KiB minimum, ~16 KiB expected extension, 128 KiB
    /// maximum chunk, compression when smaller, 256 MiB artifact bound.
    pub const fn standard() -> Self {
        Self {
            chunk_min: 8 * 1024,
            chunk_mask_bits: 14,
            chunk_max: 128 * 1024,
            compression: CompressionPolicy::NqcLzV1WhenSmaller,
            max_artifact_bytes: 256 * 1024 * 1024,
        }
    }

    pub const fn chunk_min(&self) -> u32 {
        self.chunk_min
    }

    pub const fn chunk_mask_bits(&self) -> u8 {
        self.chunk_mask_bits
    }

    pub const fn chunk_max(&self) -> u32 {
        self.chunk_max
    }

    pub const fn compression(&self) -> CompressionPolicy {
        self.compression
    }

    pub const fn max_artifact_bytes(&self) -> u64 {
        self.max_artifact_bytes
    }

    pub(crate) fn max_chunks(&self) -> u64 {
        self.max_artifact_bytes.div_ceil(u64::from(self.chunk_min))
    }

    /// Upper bound on the size of any canonical chunk frame under this policy.
    pub(crate) fn max_frame_bytes(&self) -> u64 {
        // Header (19) + three field headers (15) + codec (1) + raw_len (4) + payload.
        u64::from(self.chunk_max) + 64
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, StoreError> {
        Ok(Encoder::new(Kind::Config)
            .u8(1, CHUNKER_GEAR_CDC_V1)?
            .u32(2, self.chunk_min)?
            .u8(3, self.chunk_mask_bits)?
            .u32(4, self.chunk_max)?
            .u8(5, self.compression.tag())?
            .u64(6, self.max_artifact_bytes)?
            .finish())
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, StoreError> {
        let fields = canonical::parse(bytes, Kind::Config, &[&[1, 2, 3, 4, 5, 6]])?;
        if fields.u8(1)? != CHUNKER_GEAR_CDC_V1 {
            return Err(StoreError::InvalidConfig("unknown chunker"));
        }
        let config = Self::new(
            fields.u32(2)?,
            fields.u8(3)?,
            fields.u32(4)?,
            CompressionPolicy::from_tag(fields.u8(5)?)?,
            fields.u64(6)?,
        )?;
        if config.canonical_bytes()? != bytes {
            return Err(StoreError::NonCanonical {
                object: Kind::Config.name(),
            });
        }
        Ok(config)
    }

    /// The persisted `STORE` file: the canonical policy fields followed by field
    /// 7, the policy's own [`ConfigId`]. The seal turns any corruption of the
    /// file into a hard failure instead of a different, silently valid policy.
    pub fn sealed_bytes(&self) -> Result<Vec<u8>, StoreError> {
        Ok(Encoder::new(Kind::Config)
            .u8(1, CHUNKER_GEAR_CDC_V1)?
            .u32(2, self.chunk_min)?
            .u8(3, self.chunk_mask_bits)?
            .u32(4, self.chunk_max)?
            .u8(5, self.compression.tag())?
            .u64(6, self.max_artifact_bytes)?
            .bytes(7, self.id()?.as_bytes())?
            .finish())
    }

    pub fn decode_sealed(bytes: &[u8]) -> Result<Self, StoreError> {
        let fields = canonical::parse(bytes, Kind::Config, &[&[1, 2, 3, 4, 5, 6, 7]])?;
        if fields.u8(1)? != CHUNKER_GEAR_CDC_V1 {
            return Err(StoreError::InvalidConfig("unknown chunker"));
        }
        let config = Self::new(
            fields.u32(2)?,
            fields.u8(3)?,
            fields.u32(4)?,
            CompressionPolicy::from_tag(fields.u8(5)?)?,
            fields.u64(6)?,
        )?;
        if fields.fixed::<32>(7)? != *config.id()?.as_bytes() {
            return Err(StoreError::DigestMismatch {
                object: Kind::Config.name(),
            });
        }
        if config.sealed_bytes()? != bytes {
            return Err(StoreError::NonCanonical {
                object: Kind::Config.name(),
            });
        }
        Ok(config)
    }

    pub fn id(&self) -> Result<ConfigId, StoreError> {
        Ok(ConfigId(canonical::domain_digest(
            CONFIG_DOMAIN,
            &self.canonical_bytes()?,
        )))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ConfigId(pub(crate) [u8; 32]);

impl ConfigId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        canonical::hex(&self.0)
    }
}
