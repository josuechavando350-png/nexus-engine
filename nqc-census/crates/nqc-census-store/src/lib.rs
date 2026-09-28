//! Durable, content-addressed evidence storage for Real Market Census.
//!
//! The store is local and provider-free. Immutable evidence bytes live in a
//! SHA-256 CAS. Range checkpoints are append-only references to immutable
//! checkpoint objects. The HEAD file is only a rebuildable cache.

use nqc_census_core::{ChainDomain, Hash32};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};
use std::fs::{self, File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const STORE_CONFIG_MAGIC: &[u8] = b"NQC-CENSUS-STORE-V1";
const ARTIFACT_MAGIC: &[u8] = b"NQC-CENSUS-ARTIFACT-V1";
const CHECKPOINT_MAGIC: &[u8] = b"NQC-CENSUS-CHECKPOINT-V1";
const SCOPE_DOMAIN: &[u8] = b"NQC-CENSUS-RANGE-SCOPE-V1";
const STORE_SCHEMA_VERSION: u16 = 1;
const ARTIFACT_SCHEMA_VERSION: u16 = 1;
const CHECKPOINT_SCHEMA_VERSION: u16 = 1;
const MIN_CHUNK_SIZE: usize = 64;
const MAX_CHUNK_SIZE: usize = 16 * 1024 * 1024;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ArtifactDigest([u8; 32]);

impl ArtifactDigest {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn parse_hex(value: &str) -> Result<Self, StoreError> {
        Ok(Self(parse_hex_32(value)?))
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ScopeId([u8; 32]);

impl ScopeId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn parse_hex(value: &str) -> Result<Self, StoreError> {
        Ok(Self(parse_hex_32(value)?))
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArtifactRef {
    manifest_digest: ArtifactDigest,
    payload_digest: ArtifactDigest,
    original_len: u64,
    chunk_count: u32,
}

impl ArtifactRef {
    pub const fn manifest_digest(&self) -> ArtifactDigest {
        self.manifest_digest
    }

    pub const fn payload_digest(&self) -> ArtifactDigest {
        self.payload_digest
    }

    pub const fn original_len(&self) -> u64 {
        self.original_len
    }

    pub const fn chunk_count(&self) -> u32 {
        self.chunk_count
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkCodec {
    Raw,
    RunLength,
}

impl ChunkCodec {
    const fn tag(self) -> u8 {
        match self {
            Self::Raw => 0,
            Self::RunLength => 1,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, StoreError> {
        match tag {
            0 => Ok(Self::Raw),
            1 => Ok(Self::RunLength),
            _ => Err(StoreError::CorruptArtifact("unknown chunk codec")),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChunkRef {
    codec: ChunkCodec,
    raw_len: u32,
    stored_len: u32,
    raw_digest: ArtifactDigest,
    stored_digest: ArtifactDigest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ArtifactManifest {
    original_len: u64,
    chunk_size: u32,
    payload_digest: ArtifactDigest,
    chunks: Vec<ChunkRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct RangeScope {
    chain: ChainDomain,
    deployment_identity: Hash32,
    stream_namespace: u16,
}

impl RangeScope {
    pub fn new(
        chain: ChainDomain,
        deployment_identity: Hash32,
        stream_namespace: u16,
    ) -> Result<Self, StoreError> {
        if stream_namespace == 0 {
            return Err(StoreError::ZeroStreamNamespace);
        }
        Ok(Self {
            chain,
            deployment_identity,
            stream_namespace,
        })
    }

    pub const fn chain(&self) -> &ChainDomain {
        &self.chain
    }

    pub const fn deployment_identity(&self) -> Hash32 {
        self.deployment_identity
    }

    pub const fn stream_namespace(&self) -> u16 {
        self.stream_namespace
    }

    pub fn id(&self) -> ScopeId {
        let mut hasher = Sha256::new();
        hasher.update(SCOPE_DOMAIN);
        hasher.update([0]);
        hasher.update(self.chain.chain_id().to_be_bytes());
        hasher.update(self.chain.genesis_hash().as_bytes());
        hasher.update(self.chain.fork_lineage().as_bytes());
        hasher.update(self.deployment_identity.as_bytes());
        hasher.update(self.stream_namespace.to_be_bytes());
        ScopeId(finalize_hash(hasher))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeCheckpoint {
    scope: RangeScope,
    sequence: u64,
    from_block: u64,
    to_block: u64,
    parent_before_from_hash: Hash32,
    end_block_hash: Hash32,
    artifact: ArtifactRef,
    previous_checkpoint: Option<ArtifactDigest>,
}

impl RangeCheckpoint {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        scope: RangeScope,
        sequence: u64,
        from_block: u64,
        to_block: u64,
        parent_before_from_hash: Hash32,
        end_block_hash: Hash32,
        artifact: ArtifactRef,
        previous_checkpoint: Option<ArtifactDigest>,
    ) -> Result<Self, StoreError> {
        if sequence == 0 {
            return Err(StoreError::ZeroSequence);
        }
        if from_block == 0 {
            return Err(StoreError::ZeroBlock);
        }
        if to_block < from_block {
            return Err(StoreError::InvalidRange {
                from_block,
                to_block,
            });
        }
        if parent_before_from_hash == end_block_hash {
            return Err(StoreError::InvalidCheckpointHashes);
        }
        Ok(Self {
            scope,
            sequence,
            from_block,
            to_block,
            parent_before_from_hash,
            end_block_hash,
            artifact,
            previous_checkpoint,
        })
    }

    pub const fn scope(&self) -> &RangeScope {
        &self.scope
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn from_block(&self) -> u64 {
        self.from_block
    }

    pub const fn to_block(&self) -> u64 {
        self.to_block
    }

    pub const fn parent_before_from_hash(&self) -> Hash32 {
        self.parent_before_from_hash
    }

    pub const fn end_block_hash(&self) -> Hash32 {
        self.end_block_hash
    }

    pub const fn artifact(&self) -> ArtifactRef {
        self.artifact
    }

    pub const fn previous_checkpoint(&self) -> Option<ArtifactDigest> {
        self.previous_checkpoint
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CommittedCheckpoint {
    pub scope_id: ScopeId,
    pub checkpoint_digest: ArtifactDigest,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifiedRange {
    pub scope_id: ScopeId,
    pub checkpoint_count: usize,
    pub from_block: u64,
    pub to_block: u64,
    pub head_digest: ArtifactDigest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitFault {
    None,
    AfterCheckpointObject,
    AfterDurableReference,
}

#[derive(Debug)]
pub struct CensusStore {
    root: PathBuf,
    chunk_size: usize,
}

impl CensusStore {
    pub fn create(root: impl AsRef<Path>, chunk_size: usize) -> Result<Self, StoreError> {
        if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
            return Err(StoreError::InvalidChunkSize(chunk_size));
        }
        let root = root.as_ref().to_path_buf();
        fs::create_dir_all(root.join("objects/sha256"))?;
        fs::create_dir_all(root.join("checkpoints"))?;
        fs::create_dir_all(root.join("tmp"))?;
        atomic_write_once(
            &root,
            &root.join("STORE_CONFIG"),
            &encode_store_config(chunk_size)?,
        )?;
        sync_directory(&root)?;
        Ok(Self { root, chunk_size })
    }

    pub fn open(root: impl AsRef<Path>) -> Result<Self, StoreError> {
        let root = root.as_ref().to_path_buf();
        if !root.join("objects/sha256").is_dir()
            || !root.join("checkpoints").is_dir()
            || !root.join("tmp").is_dir()
            || !root.join("STORE_CONFIG").is_file()
        {
            return Err(StoreError::StoreLayoutMissing);
        }
        let config = fs::read(root.join("STORE_CONFIG"))?;
        let chunk_size = decode_store_config(&config)?;
        Ok(Self { root, chunk_size })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn object_path(&self, digest: ArtifactDigest) -> PathBuf {
        object_path(&self.root, digest)
    }

    pub fn put_artifact(&self, bytes: &[u8]) -> Result<ArtifactRef, StoreError> {
        let payload_digest = ArtifactDigest(hash_bytes(bytes));
        let mut chunks = Vec::new();

        for raw in bytes.chunks(self.chunk_size) {
            let raw_len = u32::try_from(raw.len()).map_err(|_| StoreError::LengthOverflow)?;
            let rle = encode_rle(raw);
            let (codec, stored) = if rle.len() < raw.len() {
                (ChunkCodec::RunLength, rle)
            } else {
                (ChunkCodec::Raw, raw.to_vec())
            };
            let stored_len = u32::try_from(stored.len()).map_err(|_| StoreError::LengthOverflow)?;
            let raw_digest = ArtifactDigest(hash_bytes(raw));
            let stored_digest = ArtifactDigest(hash_bytes(&stored));
            self.put_object(stored_digest, &stored)?;
            chunks.push(ChunkRef {
                codec,
                raw_len,
                stored_len,
                raw_digest,
                stored_digest,
            });
        }

        let original_len = u64::try_from(bytes.len()).map_err(|_| StoreError::LengthOverflow)?;
        let manifest = ArtifactManifest {
            original_len,
            chunk_size: u32::try_from(self.chunk_size).map_err(|_| StoreError::LengthOverflow)?,
            payload_digest,
            chunks,
        };
        let manifest_bytes = encode_manifest(&manifest)?;
        let manifest_digest = ArtifactDigest(hash_bytes(&manifest_bytes));
        self.put_object(manifest_digest, &manifest_bytes)?;

        Ok(ArtifactRef {
            manifest_digest,
            payload_digest,
            original_len,
            chunk_count: u32::try_from(manifest.chunks.len())
                .map_err(|_| StoreError::LengthOverflow)?,
        })
    }

    pub fn read_artifact(&self, artifact: ArtifactRef) -> Result<Vec<u8>, StoreError> {
        let manifest_bytes = self.read_object(artifact.manifest_digest)?;
        let manifest = decode_manifest(&manifest_bytes)?;
        if manifest.payload_digest != artifact.payload_digest
            || manifest.original_len != artifact.original_len
            || u32::try_from(manifest.chunks.len()).map_err(|_| StoreError::LengthOverflow)?
                != artifact.chunk_count
        {
            return Err(StoreError::ArtifactReferenceMismatch);
        }

        let capacity =
            usize::try_from(manifest.original_len).map_err(|_| StoreError::LengthOverflow)?;
        let mut output = Vec::with_capacity(capacity);
        for chunk in manifest.chunks {
            let stored = self.read_object(chunk.stored_digest)?;
            if stored.len()
                != usize::try_from(chunk.stored_len).map_err(|_| StoreError::LengthOverflow)?
            {
                return Err(StoreError::CorruptArtifact("stored chunk length mismatch"));
            }
            let raw = match chunk.codec {
                ChunkCodec::Raw => stored,
                ChunkCodec::RunLength => decode_rle(&stored, chunk.raw_len)?,
            };
            if raw.len()
                != usize::try_from(chunk.raw_len).map_err(|_| StoreError::LengthOverflow)?
            {
                return Err(StoreError::CorruptArtifact("raw chunk length mismatch"));
            }
            if ArtifactDigest(hash_bytes(&raw)) != chunk.raw_digest {
                return Err(StoreError::CorruptArtifact("raw chunk digest mismatch"));
            }
            output.extend_from_slice(&raw);
        }

        if output.len() != capacity {
            return Err(StoreError::CorruptArtifact("artifact length mismatch"));
        }
        if ArtifactDigest(hash_bytes(&output)) != manifest.payload_digest {
            return Err(StoreError::CorruptArtifact(
                "artifact payload digest mismatch",
            ));
        }
        Ok(output)
    }

    pub fn verify_artifact(&self, artifact: ArtifactRef) -> Result<(), StoreError> {
        let _ = self.read_artifact(artifact)?;
        Ok(())
    }

    pub fn artifact_chunk_codecs(
        &self,
        artifact: ArtifactRef,
    ) -> Result<Vec<ChunkCodec>, StoreError> {
        let manifest_bytes = self.read_object(artifact.manifest_digest())?;
        let manifest = decode_manifest(&manifest_bytes)?;
        if manifest.payload_digest != artifact.payload_digest()
            || manifest.original_len != artifact.original_len()
            || u32::try_from(manifest.chunks.len()).map_err(|_| StoreError::LengthOverflow)?
                != artifact.chunk_count()
        {
            return Err(StoreError::ArtifactReferenceMismatch);
        }
        Ok(manifest.chunks.iter().map(|chunk| chunk.codec).collect())
    }

    pub fn commit_checkpoint(
        &self,
        checkpoint: &RangeCheckpoint,
    ) -> Result<CommittedCheckpoint, StoreError> {
        self.commit_checkpoint_with_fault(checkpoint, CommitFault::None)
    }

    pub fn commit_checkpoint_with_fault(
        &self,
        checkpoint: &RangeCheckpoint,
        fault: CommitFault,
    ) -> Result<CommittedCheckpoint, StoreError> {
        self.verify_artifact(checkpoint.artifact())?;
        let scope_id = checkpoint.scope().id();
        let bytes = encode_checkpoint(checkpoint)?;
        let checkpoint_digest = ArtifactDigest(hash_bytes(&bytes));
        let existing = self.load_scope_checkpoints(scope_id)?;

        if let Some((existing_digest, existing_checkpoint)) = existing
            .iter()
            .find(|(_, item)| item.sequence() == checkpoint.sequence())
        {
            if *existing_digest != checkpoint_digest || existing_checkpoint != checkpoint {
                return Err(StoreError::CheckpointConflict(checkpoint.sequence()));
            }
            let scope_dir = self.scope_dir(scope_id);
            atomic_replace(
                &self.root,
                &scope_dir.join("HEAD"),
                format!("{}\n", checkpoint_digest.to_hex()).as_bytes(),
            )?;
            return Ok(CommittedCheckpoint {
                scope_id,
                checkpoint_digest,
                sequence: checkpoint.sequence(),
            });
        }

        validate_next_checkpoint(&existing, checkpoint)?;
        self.put_object(checkpoint_digest, &bytes)?;
        if fault == CommitFault::AfterCheckpointObject {
            return Err(StoreError::InjectedCrash(fault));
        }

        let scope_dir = self.scope_dir(scope_id);
        fs::create_dir_all(&scope_dir)?;
        sync_directory(&self.root.join("checkpoints"))?;
        let reference_path = scope_dir.join(format!("{:020}.ref", checkpoint.sequence()));
        atomic_write_once(
            &self.root,
            &reference_path,
            format!("{}\n", checkpoint_digest.to_hex()).as_bytes(),
        )?;
        if fault == CommitFault::AfterDurableReference {
            return Err(StoreError::InjectedCrash(fault));
        }

        atomic_replace(
            &self.root,
            &scope_dir.join("HEAD"),
            format!("{}\n", checkpoint_digest.to_hex()).as_bytes(),
        )?;

        Ok(CommittedCheckpoint {
            scope_id,
            checkpoint_digest,
            sequence: checkpoint.sequence(),
        })
    }

    pub fn load_scope_checkpoints(
        &self,
        scope_id: ScopeId,
    ) -> Result<Vec<(ArtifactDigest, RangeCheckpoint)>, StoreError> {
        let scope_dir = self.scope_dir(scope_id);
        if !scope_dir.exists() {
            return Ok(Vec::new());
        }

        let mut references = Vec::new();
        for entry in fs::read_dir(&scope_dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("ref") {
                continue;
            }
            let file_name = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or(StoreError::InvalidReferenceName)?;
            let sequence = file_name
                .parse::<u64>()
                .map_err(|_| StoreError::InvalidReferenceName)?;
            let digest = ArtifactDigest::parse_hex(read_trimmed(&path)?.as_str())?;
            let bytes = self.read_object(digest)?;
            let checkpoint = decode_checkpoint(&bytes)?;
            if checkpoint.scope().id() != scope_id {
                return Err(StoreError::ScopeMismatch);
            }
            if checkpoint.sequence() != sequence {
                return Err(StoreError::ReferenceSequenceMismatch {
                    reference: sequence,
                    checkpoint: checkpoint.sequence(),
                });
            }
            references.push((digest, checkpoint));
        }

        references.sort_by_key(|(_, checkpoint)| checkpoint.sequence());
        validate_checkpoint_chain(&references)?;
        Ok(references)
    }

    pub fn verify_range(
        &self,
        scope_id: ScopeId,
        expected_from: u64,
        expected_to: u64,
    ) -> Result<VerifiedRange, StoreError> {
        let checkpoints = self.load_scope_checkpoints(scope_id)?;
        let Some((_, first)) = checkpoints.first() else {
            return Err(StoreError::NoCheckpoints);
        };
        let Some((head_digest, last)) = checkpoints.last() else {
            return Err(StoreError::NoCheckpoints);
        };

        if first.from_block() != expected_from || last.to_block() != expected_to {
            return Err(StoreError::RangeBoundaryMismatch {
                expected_from,
                expected_to,
                actual_from: first.from_block(),
                actual_to: last.to_block(),
            });
        }

        for (_, checkpoint) in &checkpoints {
            self.verify_artifact(checkpoint.artifact())?;
        }

        Ok(VerifiedRange {
            scope_id,
            checkpoint_count: checkpoints.len(),
            from_block: first.from_block(),
            to_block: last.to_block(),
            head_digest: *head_digest,
        })
    }

    pub fn rebuild_head(&self, scope_id: ScopeId) -> Result<ArtifactDigest, StoreError> {
        let checkpoints = self.load_scope_checkpoints(scope_id)?;
        let Some((digest, _)) = checkpoints.last() else {
            return Err(StoreError::NoCheckpoints);
        };
        let scope_dir = self.scope_dir(scope_id);
        atomic_replace(
            &self.root,
            &scope_dir.join("HEAD"),
            format!("{}\n", digest.to_hex()).as_bytes(),
        )?;
        Ok(*digest)
    }

    pub fn cached_head(&self, scope_id: ScopeId) -> Result<Option<ArtifactDigest>, StoreError> {
        let path = self.scope_dir(scope_id).join("HEAD");
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(ArtifactDigest::parse_hex(
            read_trimmed(&path)?.as_str(),
        )?))
    }

    fn put_object(&self, digest: ArtifactDigest, bytes: &[u8]) -> Result<(), StoreError> {
        if ArtifactDigest(hash_bytes(bytes)) != digest {
            return Err(StoreError::DigestMismatch);
        }
        let path = self.object_path(digest);
        if path.exists() {
            let existing = fs::read(&path)?;
            if ArtifactDigest(hash_bytes(&existing)) != digest || existing != bytes {
                return Err(StoreError::CorruptObject(digest));
            }
            return Ok(());
        }

        let parent = path.parent().ok_or(StoreError::InvalidObjectPath)?;
        fs::create_dir_all(parent)?;
        let temp = unique_temp_path(&self.root, "object");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);

        match fs::hard_link(&temp, &path) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {
                let existing = fs::read(&path)?;
                if ArtifactDigest(hash_bytes(&existing)) != digest || existing != bytes {
                    let _ = fs::remove_file(&temp);
                    return Err(StoreError::CorruptObject(digest));
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&temp);
                return Err(StoreError::from(error));
            }
        }
        fs::remove_file(&temp)?;
        sync_directory(parent)?;
        sync_directory(&self.root.join("tmp"))?;
        Ok(())
    }

    fn read_object(&self, digest: ArtifactDigest) -> Result<Vec<u8>, StoreError> {
        let path = self.object_path(digest);
        let bytes = fs::read(path)?;
        if ArtifactDigest(hash_bytes(&bytes)) != digest {
            return Err(StoreError::CorruptObject(digest));
        }
        Ok(bytes)
    }

    fn scope_dir(&self, scope_id: ScopeId) -> PathBuf {
        self.root.join("checkpoints").join(scope_id.to_hex())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    Io {
        kind: ErrorKind,
        message: String,
    },
    InvalidChunkSize(usize),
    InvalidHex,
    ZeroStreamNamespace,
    ZeroSequence,
    ZeroBlock,
    InvalidRange {
        from_block: u64,
        to_block: u64,
    },
    InvalidCheckpointHashes,
    LengthOverflow,
    DigestMismatch,
    CorruptObject(ArtifactDigest),
    CorruptArtifact(&'static str),
    CorruptCheckpoint(&'static str),
    ArtifactReferenceMismatch,
    StoreLayoutMissing,
    InvalidReferenceName,
    ScopeMismatch,
    ReferenceSequenceMismatch {
        reference: u64,
        checkpoint: u64,
    },
    CheckpointConflict(u64),
    SequenceMismatch {
        expected: u64,
        actual: u64,
    },
    RangeGap {
        expected_from: u64,
        actual_from: u64,
    },
    ParentHashMismatch,
    PreviousCheckpointMismatch,
    FirstCheckpointHasPrevious,
    NoCheckpoints,
    RangeBoundaryMismatch {
        expected_from: u64,
        expected_to: u64,
        actual_from: u64,
        actual_to: u64,
    },
    InjectedCrash(CommitFault),
    InvalidObjectPath,
}

impl From<std::io::Error> for StoreError {
    fn from(error: std::io::Error) -> Self {
        Self::Io {
            kind: error.kind(),
            message: error.to_string(),
        }
    }
}

impl Display for StoreError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { kind, message } => write!(formatter, "I/O {kind:?}: {message}"),
            Self::InvalidChunkSize(size) => write!(formatter, "invalid chunk size {size}"),
            Self::InvalidHex => formatter.write_str("invalid 32-byte lowercase hex"),
            Self::ZeroStreamNamespace => formatter.write_str("stream namespace must not be zero"),
            Self::ZeroSequence => formatter.write_str("checkpoint sequence must not be zero"),
            Self::ZeroBlock => formatter.write_str("checkpoint block must not be zero"),
            Self::InvalidRange {
                from_block,
                to_block,
            } => write!(formatter, "invalid range {from_block}..={to_block}"),
            Self::InvalidCheckpointHashes => {
                formatter.write_str("checkpoint parent and end hashes must differ")
            }
            Self::LengthOverflow => formatter.write_str("length conversion overflow"),
            Self::DigestMismatch => formatter.write_str("content digest mismatch"),
            Self::CorruptObject(digest) => write!(formatter, "corrupt CAS object {}", digest.to_hex()),
            Self::CorruptArtifact(reason) => write!(formatter, "corrupt artifact: {reason}"),
            Self::CorruptCheckpoint(reason) => write!(formatter, "corrupt checkpoint: {reason}"),
            Self::ArtifactReferenceMismatch => formatter.write_str("artifact reference mismatch"),
            Self::StoreLayoutMissing => formatter.write_str("census store layout is missing"),
            Self::InvalidReferenceName => formatter.write_str("invalid checkpoint reference name"),
            Self::ScopeMismatch => formatter.write_str("checkpoint scope mismatch"),
            Self::ReferenceSequenceMismatch {
                reference,
                checkpoint,
            } => write!(
                formatter,
                "reference/checkpoint sequence mismatch {reference} != {checkpoint}"
            ),
            Self::CheckpointConflict(sequence) => {
                write!(formatter, "checkpoint sequence {sequence} already has different content")
            }
            Self::SequenceMismatch { expected, actual } => {
                write!(formatter, "checkpoint sequence mismatch expected {expected}, got {actual}")
            }
            Self::RangeGap {
                expected_from,
                actual_from,
            } => write!(
                formatter,
                "checkpoint range gap expected {expected_from}, got {actual_from}"
            ),
            Self::ParentHashMismatch => formatter.write_str("checkpoint parent hash mismatch"),
            Self::PreviousCheckpointMismatch => {
                formatter.write_str("previous checkpoint digest mismatch")
            }
            Self::FirstCheckpointHasPrevious => {
                formatter.write_str("first checkpoint must not reference a predecessor")
            }
            Self::NoCheckpoints => formatter.write_str("scope has no durable checkpoints"),
            Self::RangeBoundaryMismatch {
                expected_from,
                expected_to,
                actual_from,
                actual_to,
            } => write!(
                formatter,
                "range boundary mismatch expected {expected_from}..={expected_to}, got {actual_from}..={actual_to}"
            ),
            Self::InjectedCrash(stage) => write!(formatter, "injected crash at {stage:?}"),
            Self::InvalidObjectPath => formatter.write_str("invalid CAS object path"),
        }
    }
}

impl std::error::Error for StoreError {}

fn validate_next_checkpoint(
    existing: &[(ArtifactDigest, RangeCheckpoint)],
    next: &RangeCheckpoint,
) -> Result<(), StoreError> {
    if let Some((digest, previous)) = existing.last() {
        let expected_sequence = previous
            .sequence()
            .checked_add(1)
            .ok_or(StoreError::LengthOverflow)?;
        if next.sequence() != expected_sequence {
            return Err(StoreError::SequenceMismatch {
                expected: expected_sequence,
                actual: next.sequence(),
            });
        }
        let expected_from = previous
            .to_block()
            .checked_add(1)
            .ok_or(StoreError::LengthOverflow)?;
        if next.from_block() != expected_from {
            return Err(StoreError::RangeGap {
                expected_from,
                actual_from: next.from_block(),
            });
        }
        if next.parent_before_from_hash() != previous.end_block_hash() {
            return Err(StoreError::ParentHashMismatch);
        }
        if next.previous_checkpoint() != Some(*digest) {
            return Err(StoreError::PreviousCheckpointMismatch);
        }
    } else {
        if next.sequence() != 1 {
            return Err(StoreError::SequenceMismatch {
                expected: 1,
                actual: next.sequence(),
            });
        }
        if next.previous_checkpoint().is_some() {
            return Err(StoreError::FirstCheckpointHasPrevious);
        }
    }
    Ok(())
}

fn validate_checkpoint_chain(
    checkpoints: &[(ArtifactDigest, RangeCheckpoint)],
) -> Result<(), StoreError> {
    let mut previous: Option<&(ArtifactDigest, RangeCheckpoint)> = None;
    for current in checkpoints {
        if let Some((previous_digest, previous_checkpoint)) = previous {
            let expected_sequence = previous_checkpoint
                .sequence()
                .checked_add(1)
                .ok_or(StoreError::LengthOverflow)?;
            if current.1.sequence() != expected_sequence {
                return Err(StoreError::SequenceMismatch {
                    expected: expected_sequence,
                    actual: current.1.sequence(),
                });
            }
            let expected_from = previous_checkpoint
                .to_block()
                .checked_add(1)
                .ok_or(StoreError::LengthOverflow)?;
            if current.1.from_block() != expected_from {
                return Err(StoreError::RangeGap {
                    expected_from,
                    actual_from: current.1.from_block(),
                });
            }
            if current.1.parent_before_from_hash() != previous_checkpoint.end_block_hash() {
                return Err(StoreError::ParentHashMismatch);
            }
            if current.1.previous_checkpoint() != Some(*previous_digest) {
                return Err(StoreError::PreviousCheckpointMismatch);
            }
        } else if current.1.sequence() != 1 {
            return Err(StoreError::SequenceMismatch {
                expected: 1,
                actual: current.1.sequence(),
            });
        } else if current.1.previous_checkpoint().is_some() {
            return Err(StoreError::FirstCheckpointHasPrevious);
        }
        previous = Some(current);
    }
    Ok(())
}

fn encode_store_config(chunk_size: usize) -> Result<Vec<u8>, StoreError> {
    let chunk_size = u32::try_from(chunk_size).map_err(|_| StoreError::LengthOverflow)?;
    let mut output = Vec::new();
    output.extend_from_slice(STORE_CONFIG_MAGIC);
    output.extend_from_slice(&STORE_SCHEMA_VERSION.to_be_bytes());
    output.extend_from_slice(&chunk_size.to_be_bytes());
    Ok(output)
}

fn decode_store_config(bytes: &[u8]) -> Result<usize, StoreError> {
    let mut reader = Reader::new(bytes);
    reader.require_magic(STORE_CONFIG_MAGIC, "store config magic")?;
    let version = reader.u16()?;
    if version != STORE_SCHEMA_VERSION {
        return Err(StoreError::CorruptArtifact("store config schema version"));
    }
    let chunk_size = usize::try_from(reader.u32()?).map_err(|_| StoreError::LengthOverflow)?;
    reader.finish("store config trailing bytes")?;
    if !(MIN_CHUNK_SIZE..=MAX_CHUNK_SIZE).contains(&chunk_size) {
        return Err(StoreError::InvalidChunkSize(chunk_size));
    }
    Ok(chunk_size)
}

fn encode_manifest(manifest: &ArtifactManifest) -> Result<Vec<u8>, StoreError> {
    let count = u32::try_from(manifest.chunks.len()).map_err(|_| StoreError::LengthOverflow)?;
    let mut out = Vec::new();
    out.extend_from_slice(ARTIFACT_MAGIC);
    out.extend_from_slice(&ARTIFACT_SCHEMA_VERSION.to_be_bytes());
    out.extend_from_slice(&manifest.original_len.to_be_bytes());
    out.extend_from_slice(&manifest.chunk_size.to_be_bytes());
    out.extend_from_slice(manifest.payload_digest.as_bytes());
    out.extend_from_slice(&count.to_be_bytes());
    for chunk in &manifest.chunks {
        out.push(chunk.codec.tag());
        out.extend_from_slice(&chunk.raw_len.to_be_bytes());
        out.extend_from_slice(&chunk.stored_len.to_be_bytes());
        out.extend_from_slice(chunk.raw_digest.as_bytes());
        out.extend_from_slice(chunk.stored_digest.as_bytes());
    }
    Ok(out)
}

fn decode_manifest(bytes: &[u8]) -> Result<ArtifactManifest, StoreError> {
    let mut reader = Reader::new(bytes);
    reader.require_magic(ARTIFACT_MAGIC, "artifact magic")?;
    let version = reader.u16()?;
    if version != ARTIFACT_SCHEMA_VERSION {
        return Err(StoreError::CorruptArtifact("artifact schema version"));
    }
    let original_len = reader.u64()?;
    let chunk_size = reader.u32()?;
    let payload_digest = ArtifactDigest(reader.array_32()?);
    let count = reader.u32()?;
    let capacity = usize::try_from(count).map_err(|_| StoreError::LengthOverflow)?;
    let mut chunks = Vec::with_capacity(capacity);
    for _ in 0..count {
        chunks.push(ChunkRef {
            codec: ChunkCodec::from_tag(reader.u8()?)?,
            raw_len: reader.u32()?,
            stored_len: reader.u32()?,
            raw_digest: ArtifactDigest(reader.array_32()?),
            stored_digest: ArtifactDigest(reader.array_32()?),
        });
    }
    reader.finish("artifact trailing bytes")?;
    Ok(ArtifactManifest {
        original_len,
        chunk_size,
        payload_digest,
        chunks,
    })
}

fn encode_checkpoint(checkpoint: &RangeCheckpoint) -> Result<Vec<u8>, StoreError> {
    let mut out = Vec::new();
    out.extend_from_slice(CHECKPOINT_MAGIC);
    out.extend_from_slice(&CHECKPOINT_SCHEMA_VERSION.to_be_bytes());
    out.extend_from_slice(&checkpoint.scope().chain().chain_id().to_be_bytes());
    out.extend_from_slice(checkpoint.scope().chain().genesis_hash().as_bytes());
    out.extend_from_slice(checkpoint.scope().chain().fork_lineage().as_bytes());
    out.extend_from_slice(checkpoint.scope().deployment_identity().as_bytes());
    out.extend_from_slice(&checkpoint.scope().stream_namespace().to_be_bytes());
    out.extend_from_slice(&checkpoint.sequence().to_be_bytes());
    out.extend_from_slice(&checkpoint.from_block().to_be_bytes());
    out.extend_from_slice(&checkpoint.to_block().to_be_bytes());
    out.extend_from_slice(checkpoint.parent_before_from_hash().as_bytes());
    out.extend_from_slice(checkpoint.end_block_hash().as_bytes());
    out.extend_from_slice(checkpoint.artifact().manifest_digest().as_bytes());
    out.extend_from_slice(checkpoint.artifact().payload_digest().as_bytes());
    out.extend_from_slice(&checkpoint.artifact().original_len().to_be_bytes());
    out.extend_from_slice(&checkpoint.artifact().chunk_count().to_be_bytes());
    match checkpoint.previous_checkpoint() {
        Some(previous) => {
            out.push(1);
            out.extend_from_slice(previous.as_bytes());
        }
        None => out.push(0),
    }
    Ok(out)
}

fn decode_checkpoint(bytes: &[u8]) -> Result<RangeCheckpoint, StoreError> {
    let mut reader = Reader::new(bytes);
    reader.require_magic(CHECKPOINT_MAGIC, "checkpoint magic")?;
    let version = reader.u16()?;
    if version != CHECKPOINT_SCHEMA_VERSION {
        return Err(StoreError::CorruptCheckpoint("checkpoint schema version"));
    }

    let chain_id = reader.u64()?;
    let genesis = Hash32::new(reader.array_32()?)
        .map_err(|_| StoreError::CorruptCheckpoint("zero genesis hash"))?;
    let fork = Hash32::new(reader.array_32()?)
        .map_err(|_| StoreError::CorruptCheckpoint("zero fork lineage"))?;
    let chain = ChainDomain::new(chain_id, genesis, fork)
        .map_err(|_| StoreError::CorruptCheckpoint("invalid chain domain"))?;
    let deployment = Hash32::new(reader.array_32()?)
        .map_err(|_| StoreError::CorruptCheckpoint("zero deployment identity"))?;
    let namespace = reader.u16()?;
    let scope = RangeScope::new(chain, deployment, namespace)?;
    let sequence = reader.u64()?;
    let from_block = reader.u64()?;
    let to_block = reader.u64()?;
    let parent = Hash32::new(reader.array_32()?)
        .map_err(|_| StoreError::CorruptCheckpoint("zero parent hash"))?;
    let end = Hash32::new(reader.array_32()?)
        .map_err(|_| StoreError::CorruptCheckpoint("zero end hash"))?;
    let artifact = ArtifactRef {
        manifest_digest: ArtifactDigest(reader.array_32()?),
        payload_digest: ArtifactDigest(reader.array_32()?),
        original_len: reader.u64()?,
        chunk_count: reader.u32()?,
    };
    let previous_checkpoint = match reader.u8()? {
        0 => None,
        1 => Some(ArtifactDigest(reader.array_32()?)),
        _ => return Err(StoreError::CorruptCheckpoint("previous checkpoint flag")),
    };
    reader.finish("checkpoint trailing bytes")?;
    RangeCheckpoint::new(
        scope,
        sequence,
        from_block,
        to_block,
        parent,
        end,
        artifact,
        previous_checkpoint,
    )
}

fn encode_rle(bytes: &[u8]) -> Vec<u8> {
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        let mut count: u8 = 1;
        while index + usize::from(count) < bytes.len()
            && bytes[index + usize::from(count)] == byte
            && count < u8::MAX
        {
            count += 1;
        }
        output.push(count);
        output.push(byte);
        index += usize::from(count);
    }
    output
}

fn decode_rle(bytes: &[u8], expected_len: u32) -> Result<Vec<u8>, StoreError> {
    if bytes.len() % 2 != 0 {
        return Err(StoreError::CorruptArtifact("odd RLE byte length"));
    }
    let expected = usize::try_from(expected_len).map_err(|_| StoreError::LengthOverflow)?;
    let mut output = Vec::with_capacity(expected);
    for pair in bytes.chunks_exact(2) {
        let count = pair[0];
        if count == 0 {
            return Err(StoreError::CorruptArtifact("zero RLE count"));
        }
        let new_len = output
            .len()
            .checked_add(usize::from(count))
            .ok_or(StoreError::LengthOverflow)?;
        if new_len > expected {
            return Err(StoreError::CorruptArtifact(
                "RLE expands beyond expected length",
            ));
        }
        output.resize(new_len, pair[1]);
    }
    if output.len() != expected {
        return Err(StoreError::CorruptArtifact("RLE length mismatch"));
    }
    Ok(output)
}

fn object_path(root: &Path, digest: ArtifactDigest) -> PathBuf {
    let hex = digest.to_hex();
    root.join("objects")
        .join("sha256")
        .join(&hex[..2])
        .join(&hex[2..])
}

fn atomic_write_once(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    if path.exists() {
        let existing = fs::read(path)?;
        if existing == bytes {
            return Ok(());
        }
        return Err(StoreError::DigestMismatch);
    }
    let parent = path.parent().ok_or(StoreError::InvalidObjectPath)?;
    fs::create_dir_all(parent)?;
    let temp = unique_temp_path(root, "reference");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    match fs::hard_link(&temp, path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let existing = fs::read(path)?;
            if existing != bytes {
                let _ = fs::remove_file(&temp);
                return Err(StoreError::DigestMismatch);
            }
        }
        Err(error) => {
            let _ = fs::remove_file(&temp);
            return Err(StoreError::from(error));
        }
    }
    fs::remove_file(&temp)?;
    sync_directory(parent)?;
    sync_directory(&root.join("tmp"))?;
    Ok(())
}

fn atomic_replace(root: &Path, path: &Path, bytes: &[u8]) -> Result<(), StoreError> {
    let parent = path.parent().ok_or(StoreError::InvalidObjectPath)?;
    fs::create_dir_all(parent)?;
    let temp = unique_temp_path(root, "head");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temp, path)?;
    sync_directory(parent)?;
    sync_directory(&root.join("tmp"))?;
    Ok(())
}

fn unique_temp_path(root: &Path, kind: &str) -> PathBuf {
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    root.join("tmp")
        .join(format!("{kind}-{}-{sequence}.tmp", std::process::id()))
}

fn sync_directory(path: &Path) -> Result<(), StoreError> {
    File::open(path)?.sync_all()?;
    Ok(())
}

fn read_trimmed(path: &Path) -> Result<String, StoreError> {
    let mut file = File::open(path)?;
    let mut value = String::new();
    file.read_to_string(&mut value)?;
    Ok(value.trim().to_owned())
}

fn hash_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    finalize_hash(hasher)
}

fn finalize_hash(hasher: Sha256) -> [u8; 32] {
    let digest = hasher.finalize();
    let mut output = [0_u8; 32];
    output.copy_from_slice(&digest);
    output
}

fn parse_hex_32(value: &str) -> Result<[u8; 32], StoreError> {
    let raw = value.strip_prefix("0x").unwrap_or(value);
    if raw.len() != 64 || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(StoreError::InvalidHex);
    }
    let mut output = [0_u8; 32];
    let source = raw.as_bytes();
    for (index, target) in output.iter_mut().enumerate() {
        let high = decode_nibble(source[index * 2])?;
        let low = decode_nibble(source[index * 2 + 1])?;
        *target = (high << 4) | low;
    }
    Ok(output)
}

fn decode_nibble(value: u8) -> Result<u8, StoreError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        b'A'..=b'F' => Ok(value - b'A' + 10),
        _ => Err(StoreError::InvalidHex),
    }
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

struct Reader<'a> {
    bytes: &'a [u8],
    cursor: usize,
}

impl<'a> Reader<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, cursor: 0 }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], StoreError> {
        let end = self
            .cursor
            .checked_add(length)
            .ok_or(StoreError::LengthOverflow)?;
        let Some(slice) = self.bytes.get(self.cursor..end) else {
            return Err(StoreError::CorruptArtifact("truncated canonical bytes"));
        };
        self.cursor = end;
        Ok(slice)
    }

    fn require_magic(&mut self, magic: &[u8], reason: &'static str) -> Result<(), StoreError> {
        if self.take(magic.len())? != magic {
            return Err(StoreError::CorruptArtifact(reason));
        }
        Ok(())
    }

    fn u8(&mut self) -> Result<u8, StoreError> {
        Ok(self.take(1)?[0])
    }

    fn u16(&mut self) -> Result<u16, StoreError> {
        let bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| StoreError::CorruptArtifact("u16"))?;
        Ok(u16::from_be_bytes(bytes))
    }

    fn u32(&mut self) -> Result<u32, StoreError> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| StoreError::CorruptArtifact("u32"))?;
        Ok(u32::from_be_bytes(bytes))
    }

    fn u64(&mut self) -> Result<u64, StoreError> {
        let bytes: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| StoreError::CorruptArtifact("u64"))?;
        Ok(u64::from_be_bytes(bytes))
    }

    fn array_32(&mut self) -> Result<[u8; 32], StoreError> {
        self.take(32)?
            .try_into()
            .map_err(|_| StoreError::CorruptArtifact("32-byte field"))
    }

    fn finish(&self, reason: &'static str) -> Result<(), StoreError> {
        if self.cursor != self.bytes.len() {
            return Err(StoreError::CorruptArtifact(reason));
        }
        Ok(())
    }
}
