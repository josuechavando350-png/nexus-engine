use crate::canonical;
use crate::checkpoint::{Checkpoint, CheckpointId, HeadRecord, ResumePoint};
use crate::chunker::GearTable;
use crate::config::{ConfigId, StoreConfig};
use crate::durable::{
    self, read_bounded, require_dir, root_device, sync_dir, sync_file, Disk, Published,
    CHECKPOINT_POINTS, OBJECT_POINTS,
};
use crate::error::StoreError;
use crate::fault::FaultHook;
use crate::object::{self, ArtifactId, ChunkId, Manifest};
use crate::scope::{ScopeId, StreamScope};
use std::collections::BTreeSet;
use std::fmt::{Debug, Formatter};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

pub(crate) const STORE_FILE: &str = "STORE";
pub(crate) const OBJECTS_DIR: &str = "objects";
pub(crate) const CHUNKS_DIR: &str = "chunks";
pub(crate) const ARTIFACTS_DIR: &str = "artifacts";
pub(crate) const STREAMS_DIR: &str = "streams";
pub(crate) const STAGING_DIR: &str = "tmp";
pub(crate) const SCOPE_FILE: &str = "SCOPE";
pub(crate) const CHECKPOINTS_DIR: &str = "checkpoints";
pub(crate) const HEAD_FILE: &str = "HEAD";

pub(crate) const SMALL_OBJECT_LIMIT: u64 = 4096;
pub(crate) const CHECKPOINT_LIMIT: u64 = 4 * 1024 * 1024;

/// Outcome of storing an artifact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PutReport {
    pub id: ArtifactId,
    pub manifest_created: bool,
    pub chunks_created: usize,
    pub chunks_reused: usize,
}

/// Outcome of committing a checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommitOutcome {
    /// This call made the checkpoint authoritative.
    Created(CheckpointId),
    /// The identical checkpoint was already authoritative (idempotent retry).
    AlreadyCommitted(CheckpointId),
}

impl CommitOutcome {
    pub const fn id(&self) -> CheckpointId {
        match self {
            Self::Created(id) | Self::AlreadyCommitted(id) => *id,
        }
    }
}

/// State of the HEAD cache as found by recovery.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadStatus {
    Absent,
    /// Present but structurally invalid (torn, truncated, bad seal).
    Corrupt,
    /// Well-formed, consistent with the catalog, but behind the durable tip.
    Stale {
        head_sequence: u64,
    },
    /// Names exactly the durable tip.
    Consistent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryMode {
    /// Trusts the prefix up to a HEAD that is itself proven against the
    /// authoritative checkpoint it names; validates every link after it.
    Accelerated,
    /// Ignores HEAD for authority and validates every link from sequence 0.
    Full,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recovery {
    pub resume: ResumePoint,
    pub head: HeadStatus,
    /// The HEAD cache was rewritten (or a corrupt cache removed).
    pub head_repaired: bool,
    /// Checkpoints read and link-validated during this recovery.
    pub checkpoints_walked: u64,
}

/// A completion proof for an inclusive block range.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeCertificate {
    pub scope_id: ScopeId,
    pub first_block: u64,
    pub last_block: u64,
    pub first_sequence: u64,
    pub last_sequence: u64,
    /// Identity of the checkpoint that completes the range; it transitively
    /// commits to every predecessor and every evidence artifact they reference.
    pub commitment: CheckpointId,
    pub artifacts_verified: u64,
}

/// A durable, content-addressed evidence store with append-only range streams.
///
/// Authority model:
/// * `objects/` is an immutable CAS: chunk frames and manifests named by
///   content-derived identities, written once, never replaced;
/// * `streams/<scope>/checkpoints/<sequence>` is the append-only catalog and the
///   only authority for committed progress;
/// * `streams/<scope>/HEAD` is a rebuildable cache and never authority.
pub struct Store {
    root: PathBuf,
    device: u64,
    config: StoreConfig,
    config_id: ConfigId,
    gear: GearTable,
    faults: Option<FaultHook>,
}

impl Debug for Store {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Store")
            .field("root", &self.root)
            .field("config", &self.config)
            .field("faults", &self.faults.is_some())
            .finish_non_exhaustive()
    }
}

impl Store {
    /// Initialises a store at `root` (creating the directory if absent) or
    /// reopens it when it already holds exactly `config`.
    pub fn create(root: &Path, config: StoreConfig) -> Result<Self, StoreError> {
        match fs::symlink_metadata(root) {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {
                fs::create_dir(root).map_err(|error| StoreError::io("mkdir", root, &error))?;
                if let Some(parent) = root.parent().filter(|p| !p.as_os_str().is_empty()) {
                    sync_dir(parent)?;
                }
            }
            Err(error) => return Err(StoreError::io("stat", root, &error)),
        }
        let device = root_device(root)?;
        if !root.join(STORE_FILE).exists() {
            // Only an empty directory, or the layout of an interrupted create,
            // may become a store; anything else is someone else's data.
            for name in durable::entry_names(root)? {
                if ![OBJECTS_DIR, STREAMS_DIR, STAGING_DIR].contains(&name.as_str()) {
                    return Err(StoreError::UnexpectedEntry(root.join(name)));
                }
            }
        }
        let staging = root.join(STAGING_DIR);
        let disk = Disk {
            staging: &staging,
            device,
            faults: None,
        };
        disk.ensure_dir(root, STAGING_DIR)?;
        let objects = disk.ensure_dir(root, OBJECTS_DIR)?;
        disk.ensure_dir(&objects, CHUNKS_DIR)?;
        disk.ensure_dir(&objects, ARTIFACTS_DIR)?;
        disk.ensure_dir(root, STREAMS_DIR)?;
        disk.probe_hard_links()?;
        match disk.publish_once(
            root,
            STORE_FILE,
            &config.sealed_bytes()?,
            SMALL_OBJECT_LIMIT,
            OBJECT_POINTS,
        ) {
            Ok(_) => {}
            Err(StoreError::ObjectConflict(_)) => return Err(StoreError::ConfigMismatch),
            Err(error) => return Err(error),
        }
        Self::open(root, &config)
    }

    /// Opens an existing store and requires its persisted policy to equal
    /// `expected`. A second process can never reinterpret a store.
    pub fn open(root: &Path, expected: &StoreConfig) -> Result<Self, StoreError> {
        let store = Self::open_existing(root)?;
        if store.config != *expected {
            return Err(StoreError::ConfigMismatch);
        }
        Ok(store)
    }

    /// Opens an existing store under its persisted policy.
    pub fn open_existing(root: &Path) -> Result<Self, StoreError> {
        let device = root_device(root)?;
        let bytes = read_bounded(&root.join(STORE_FILE), SMALL_OBJECT_LIMIT, "store config")?
            .ok_or_else(|| StoreError::StoreNotInitialized(root.to_path_buf()))?;
        let config = StoreConfig::decode_sealed(&bytes)?;
        let objects = root.join(OBJECTS_DIR);
        for dir in [
            root.join(STAGING_DIR),
            objects.clone(),
            objects.join(CHUNKS_DIR),
            objects.join(ARTIFACTS_DIR),
            root.join(STREAMS_DIR),
        ] {
            require_dir(&dir, device)?;
        }
        Ok(Self {
            root: root.to_path_buf(),
            device,
            config_id: config.id()?,
            config,
            gear: GearTable::derive(),
            faults: None,
        })
    }

    /// Installs the fault-injection seam (tests only; no hook means no faults).
    #[must_use]
    pub fn with_fault_hook(mut self, hook: FaultHook) -> Self {
        self.faults = Some(hook);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub const fn config(&self) -> &StoreConfig {
        &self.config
    }

    pub const fn config_id(&self) -> ConfigId {
        self.config_id
    }

    fn staging(&self) -> PathBuf {
        self.root.join(STAGING_DIR)
    }

    fn with_disk<T>(
        &self,
        work: impl FnOnce(&Disk<'_>) -> Result<T, StoreError>,
    ) -> Result<T, StoreError> {
        let staging = self.staging();
        let disk = Disk {
            staging: &staging,
            device: self.device,
            faults: self.faults.as_ref(),
        };
        work(&disk)
    }

    pub(crate) fn chunk_path(&self, id: &ChunkId) -> PathBuf {
        fanout_path(&self.root, CHUNKS_DIR, id.as_bytes())
    }

    pub(crate) fn manifest_path(&self, id: &ArtifactId) -> PathBuf {
        fanout_path(&self.root, ARTIFACTS_DIR, id.as_bytes())
    }

    fn require_object_fanout(&self, kind: &str, id: &[u8; 32]) -> Result<PathBuf, StoreError> {
        let objects = self.root.join(OBJECTS_DIR);
        require_dir(&objects, self.device)?;
        let kind_dir = objects.join(kind);
        require_dir(&kind_dir, self.device)?;
        let fanout = kind_dir.join(canonical::hex(&id[..1]));
        require_dir(&fanout, self.device)?;
        Ok(fanout)
    }

    // ----------------------------------------------------------------- CAS

    /// Stores `bytes` and returns their identity. Identical bytes deduplicate;
    /// an existing object with different bytes under a content-derived name is a
    /// hard `ObjectConflict` and is never overwritten.
    pub fn put_artifact(&self, bytes: &[u8]) -> Result<PutReport, StoreError> {
        let encoded = object::encode_artifact(bytes, &self.config, self.config_id, &self.gear)?;
        self.with_disk(|disk| {
            let mut chunks_created = 0;
            let mut chunks_reused = 0;
            for (chunk_id, frame) in &encoded.frames {
                let dir = self.ensure_fanout(disk, CHUNKS_DIR, chunk_id.as_bytes())?;
                match disk.publish_once(
                    &dir,
                    &chunk_id.to_hex(),
                    frame,
                    self.config.max_frame_bytes(),
                    OBJECT_POINTS,
                )? {
                    Published::Created => chunks_created += 1,
                    Published::AlreadyPresent => chunks_reused += 1,
                }
            }
            let dir = self.ensure_fanout(disk, ARTIFACTS_DIR, encoded.id.as_bytes())?;
            let manifest = disk.publish_once(
                &dir,
                &encoded.id.to_hex(),
                &encoded.manifest_bytes,
                self.manifest_limit(),
                OBJECT_POINTS,
            )?;
            Ok(PutReport {
                id: encoded.id,
                manifest_created: manifest == Published::Created,
                chunks_created,
                chunks_reused,
            })
        })
    }

    /// Returns the logical bytes of an artifact after verifying both integrity
    /// layers of every chunk and the artifact identity itself.
    pub fn get_artifact(&self, id: &ArtifactId) -> Result<Vec<u8>, StoreError> {
        self.read_artifact(id).map(|(bytes, _, _)| bytes)
    }

    pub fn contains_artifact(&self, id: &ArtifactId) -> Result<bool, StoreError> {
        self.require_object_fanout(ARTIFACTS_DIR, id.as_bytes())?;
        Ok(read_bounded(
            &self.manifest_path(id),
            self.manifest_limit(),
            "artifact manifest",
        )?
        .is_some())
    }

    /// Integrity plus canonicality: the manifest must be exactly the manifest the
    /// frozen encoder derives from the logical bytes under this policy. Because
    /// the manifest pins each frame digest, this also proves every stored frame
    /// (chunk boundaries and codec choice) is the canonical one.
    pub fn verify_artifact(&self, id: &ArtifactId) -> Result<u64, StoreError> {
        let (bytes, manifest_bytes, _) = self.read_artifact(id)?;
        self.require_canonical_manifest(&bytes, &manifest_bytes)?;
        u64::try_from(bytes.len()).map_err(|_| StoreError::ArtifactTooLarge {
            length: u64::MAX,
            limit: self.config.max_artifact_bytes(),
        })
    }

    /// The stored manifest must equal the one the frozen encoder derives.
    pub(crate) fn require_canonical_manifest(
        &self,
        logical: &[u8],
        manifest_bytes: &[u8],
    ) -> Result<(), StoreError> {
        let encoded = object::encode_artifact(logical, &self.config, self.config_id, &self.gear)?;
        if encoded.manifest_bytes != manifest_bytes {
            return Err(StoreError::NonCanonical {
                object: "artifact manifest",
            });
        }
        Ok(())
    }

    pub(crate) fn read_artifact(
        &self,
        id: &ArtifactId,
    ) -> Result<(Vec<u8>, Vec<u8>, Manifest), StoreError> {
        self.require_object_fanout(ARTIFACTS_DIR, id.as_bytes())?;
        let manifest_bytes = read_bounded(
            &self.manifest_path(id),
            self.manifest_limit(),
            "artifact manifest",
        )?
        .ok_or_else(|| StoreError::ArtifactMissing(id.to_hex()))?;
        let manifest = object::decode_manifest(&manifest_bytes, &self.config)?;
        if manifest.config_id != self.config_id {
            return Err(StoreError::ForeignConfig);
        }
        if manifest.artifact_id != *id {
            return Err(StoreError::DigestMismatch {
                object: "artifact manifest",
            });
        }
        let capacity =
            usize::try_from(manifest.logical_len).map_err(|_| StoreError::ArtifactTooLarge {
                length: manifest.logical_len,
                limit: self.config.max_artifact_bytes(),
            })?;
        let mut logical = Vec::with_capacity(capacity);
        for entry in &manifest.chunks {
            self.require_object_fanout(CHUNKS_DIR, entry.id.as_bytes())?;
            let frame = read_bounded(
                &self.chunk_path(&entry.id),
                self.config.max_frame_bytes(),
                "chunk frame",
            )?
            .ok_or_else(|| StoreError::ChunkMissing(entry.id.to_hex()))?;
            if u64::try_from(frame.len()).ok() != Some(u64::from(entry.stored_len)) {
                return Err(StoreError::malformed(
                    "chunk frame",
                    "stored length differs from manifest",
                ));
            }
            if object::frame_digest(&frame) != entry.frame_digest {
                return Err(StoreError::DigestMismatch {
                    object: "chunk frame",
                });
            }
            let raw = object::decode_frame(&frame, entry.raw_len, &self.config)?;
            if ChunkId::of(&raw) != entry.id {
                return Err(StoreError::DigestMismatch { object: "chunk" });
            }
            logical.extend_from_slice(&raw);
        }
        if ArtifactId::of(&logical) != *id {
            return Err(StoreError::DigestMismatch { object: "artifact" });
        }
        Ok((logical, manifest_bytes, manifest))
    }

    /// Canonical verification plus fsync of every file and directory entry the
    /// artifact depends on, so a checkpoint can never become durable ahead of
    /// evidence that another (possibly crashed) writer linked without fsync.
    fn verify_artifact_durable(&self, id: &ArtifactId) -> Result<(), StoreError> {
        let (bytes, manifest_bytes, manifest) = self.read_artifact(id)?;
        self.require_canonical_manifest(&bytes, &manifest_bytes)?;
        let mut dirs = BTreeSet::new();
        let mut files = vec![self.manifest_path(id)];
        files.extend(
            manifest
                .chunks
                .iter()
                .map(|entry| self.chunk_path(&entry.id)),
        );
        for file in &files {
            sync_file(file)?;
            if let Some(parent) = file.parent() {
                dirs.insert(parent.to_path_buf());
            }
        }
        for dir in &dirs {
            sync_dir(dir)?;
        }
        Ok(())
    }

    fn manifest_limit(&self) -> u64 {
        // Header and field headers are well under 256 bytes; each row is 72 bytes.
        256 + self.config.max_chunks().saturating_mul(72)
    }

    fn ensure_fanout(
        &self,
        disk: &Disk<'_>,
        kind: &str,
        id: &[u8; 32],
    ) -> Result<PathBuf, StoreError> {
        let parent = self.root.join(OBJECTS_DIR).join(kind);
        disk.ensure_dir(&parent, &canonical::hex(&id[..1]))
    }

    // ------------------------------------------------------------- streams

    /// Registers (write-once) the scope of a stream. Idempotent.
    pub fn register_stream(&self, scope: &StreamScope) -> Result<ScopeId, StoreError> {
        let id = scope.id()?;
        self.with_disk(|disk| {
            let stream = disk.ensure_dir(&self.root.join(STREAMS_DIR), &id.to_hex())?;
            match disk.publish_once(
                &stream,
                SCOPE_FILE,
                &scope.canonical_bytes()?,
                SMALL_OBJECT_LIMIT,
                OBJECT_POINTS,
            ) {
                Ok(_) => {}
                Err(StoreError::ObjectConflict(_)) => return Err(StoreError::ScopeMismatch),
                Err(error) => return Err(error),
            }
            disk.ensure_dir(&stream, CHECKPOINTS_DIR)?;
            Ok(id)
        })
    }

    fn stream_dir(&self, id: &ScopeId) -> PathBuf {
        self.root.join(STREAMS_DIR).join(id.to_hex())
    }

    /// The stream must be registered with exactly this scope.
    fn registered_stream(&self, scope: &StreamScope) -> Result<Option<PathBuf>, StoreError> {
        let id = scope.id()?;
        let stream = self.stream_dir(&id);
        match fs::symlink_metadata(&stream) {
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(StoreError::io("stat", &stream, &error)),
            Ok(_) => require_dir(&stream, self.device)?,
        }
        let recorded = read_bounded(&stream.join(SCOPE_FILE), SMALL_OBJECT_LIMIT, "stream scope")?
            .ok_or_else(|| StoreError::StreamNotRegistered(id.to_hex()))?;
        if StreamScope::decode(&recorded)? != *scope {
            return Err(StoreError::ScopeMismatch);
        }
        require_dir(&stream.join(CHECKPOINTS_DIR), self.device)?;
        Ok(Some(stream))
    }

    pub(crate) fn read_checkpoint(
        stream: &Path,
        scope: &StreamScope,
        sequence: u64,
    ) -> Result<Option<Checkpoint>, StoreError> {
        let path = stream.join(CHECKPOINTS_DIR).join(checkpoint_name(sequence));
        let Some(bytes) = read_bounded(&path, CHECKPOINT_LIMIT, "checkpoint")? else {
            return Ok(None);
        };
        let checkpoint = Checkpoint::decode(&bytes, scope)?;
        if checkpoint.sequence() != sequence {
            return Err(StoreError::InvalidCheckpoint(
                "sequence field differs from catalog name",
            ));
        }
        Ok(Some(checkpoint))
    }

    fn prove_checkpoint_durable(
        &self,
        stream: &Path,
        checkpoint: &Checkpoint,
    ) -> Result<(), StoreError> {
        for artifact in checkpoint.evidence() {
            self.verify_artifact_durable(artifact)?;
        }
        let catalog = stream.join(CHECKPOINTS_DIR);
        let path = catalog.join(checkpoint_name(checkpoint.sequence()));
        sync_file(&path)?;
        sync_dir(&catalog)?;
        Ok(())
    }

    /// Appends `checkpoint` to its stream.
    ///
    /// * an identical checkpoint already at this sequence is an idempotent
    ///   `AlreadyCommitted`;
    /// * different bytes at this sequence are a deterministic `SequenceConflict`;
    /// * a sequence whose predecessor is not durable is a `SequenceGap`;
    /// * the predecessor link, range continuity and lineage must hold exactly;
    /// * every evidence artifact must be present, intact, canonical and durable;
    /// * publication is a no-replace `link(2)`, so racing writers get one winner.
    pub fn commit(
        &self,
        scope: &StreamScope,
        checkpoint: &Checkpoint,
    ) -> Result<CommitOutcome, StoreError> {
        let scope_id = scope.id()?;
        if checkpoint.scope_id() != scope_id {
            return Err(StoreError::ScopeMismatch);
        }
        self.register_stream(scope)?;
        let stream = self.stream_dir(&scope_id);
        let catalog = stream.join(CHECKPOINTS_DIR);
        let sequence = checkpoint.sequence();
        let name = checkpoint_name(sequence);
        let bytes = checkpoint.canonical_bytes()?;
        let id = checkpoint.id()?;

        self.validate_head(&stream, scope, scope_id)?;

        // HEAD is cache only. Before adding or reusing authority, re-walk the
        // authoritative catalog from sequence 0, revalidate referenced evidence,
        // and establish the durability barrier for every committed checkpoint.
        let recovery = self.recover(scope, RecoveryMode::Full)?;
        if sequence > recovery.resume.next_sequence {
            return Err(StoreError::SequenceGap {
                requested: sequence,
            });
        }

        if let Some(existing) = read_bounded(&catalog.join(&name), CHECKPOINT_LIMIT, "checkpoint")?
        {
            if existing != bytes {
                return Err(StoreError::SequenceConflict { sequence });
            }
            // The full recovery above revalidated the chain and its evidence.
            // Re-establish this exact entry's durability too, covering a writer
            // that linked it and died before its directory fsync.
            self.prove_checkpoint_durable(&stream, checkpoint)?;
            self.advance_head(&stream, scope_id, sequence, id)?;
            return Ok(CommitOutcome::AlreadyCommitted(id));
        }

        if let Some(previous) = sequence.checked_sub(1) {
            let predecessor = Self::read_checkpoint(&stream, scope, previous)?.ok_or(
                StoreError::SequenceGap {
                    requested: sequence,
                },
            )?;
            predecessor.check_successor(checkpoint)?;
        }

        for artifact in checkpoint.evidence() {
            self.verify_artifact_durable(artifact)?;
        }

        let outcome = self.with_disk(|disk| {
            match disk.publish_once(&catalog, &name, &bytes, CHECKPOINT_LIMIT, CHECKPOINT_POINTS) {
                Ok(Published::Created) => Ok(CommitOutcome::Created(id)),
                Ok(Published::AlreadyPresent) => Ok(CommitOutcome::AlreadyCommitted(id)),
                Err(StoreError::ObjectConflict(_)) => {
                    Err(StoreError::SequenceConflict { sequence })
                }
                Err(error) => Err(error),
            }
        })?;
        self.advance_head(&stream, scope_id, sequence, id)?;
        Ok(outcome)
    }

    /// Before anything is written on top of a stream, a well-formed HEAD must
    /// agree with the authoritative catalog. A structurally corrupt HEAD is only
    /// a damaged cache and is repaired; a well-sealed HEAD that names a missing
    /// checkpoint, another scope or another identity is tamper evidence, and the
    /// write is refused.
    fn validate_head(
        &self,
        stream: &Path,
        scope: &StreamScope,
        scope_id: ScopeId,
    ) -> Result<(), StoreError> {
        let Some(head) = read_head(stream)?.and_then(Result::ok) else {
            return Ok(());
        };
        if head.scope_id != scope_id {
            return Err(StoreError::HeadConflictsWithAuthority);
        }
        let checkpoint = Self::read_checkpoint(stream, scope, head.sequence)?.ok_or(
            StoreError::HeadAheadOfAuthority {
                head_sequence: head.sequence,
            },
        )?;
        if checkpoint.id()? != head.checkpoint_id {
            return Err(StoreError::HeadConflictsWithAuthority);
        }
        Ok(())
    }

    /// Moves HEAD forward to a checkpoint this process has just proven durable.
    /// It never moves HEAD backwards over a newer well-formed HEAD.
    fn advance_head(
        &self,
        stream: &Path,
        scope_id: ScopeId,
        sequence: u64,
        checkpoint_id: CheckpointId,
    ) -> Result<(), StoreError> {
        if let Some(Ok(head)) = read_head(stream)? {
            if head.scope_id == scope_id && head.sequence >= sequence {
                return Ok(());
            }
        }
        let record = HeadRecord {
            scope_id,
            sequence,
            checkpoint_id,
        };
        self.with_disk(|disk| disk.publish_replace(stream, HEAD_FILE, &record.encode()?))
    }

    /// Derives the resume point from the authoritative catalog and repairs the
    /// HEAD cache idempotently. A HEAD that is ahead of, or contradicts, the
    /// catalog is never trusted or silently overwritten: recovery fails closed.
    pub fn recover(
        &self,
        scope: &StreamScope,
        _mode: RecoveryMode,
    ) -> Result<Recovery, StoreError> {
        let Some(stream) = self.registered_stream(scope)? else {
            return Ok(Recovery {
                resume: ResumePoint::genesis(scope)?,
                head: HeadStatus::Absent,
                head_repaired: false,
                checkpoints_walked: 0,
            });
        };
        let scope_id = scope.id()?;
        let head_path = stream.join(HEAD_FILE);
        let head = read_head(&stream)?;
        let valid_head = match &head {
            Some(Ok(record)) => {
                if record.scope_id != scope_id {
                    return Err(StoreError::HeadConflictsWithAuthority);
                }
                Some(*record)
            }
            _ => None,
        };

        // Until an authenticated skip structure exists, even "accelerated"
        // recovery must prove the authoritative prefix from sequence 0. HEAD is
        // advisory cache only and can never suppress validation of earlier
        // checkpoints or their evidence.
        let mut walked = 0_u64;
        let start = Self::read_checkpoint(&stream, scope, 0)?;
        walked += u64::from(start.is_some());

        let tip = match start {
            None => None,
            Some(mut current) => loop {
                self.prove_checkpoint_durable(&stream, &current)?;
                if let Some(record) = valid_head {
                    if record.sequence == current.sequence()
                        && record.checkpoint_id != current.id()?
                    {
                        return Err(StoreError::HeadConflictsWithAuthority);
                    }
                }
                let Some(next_sequence) = current.sequence().checked_add(1) else {
                    break Some(current);
                };
                match Self::read_checkpoint(&stream, scope, next_sequence)? {
                    Some(next) => {
                        current.check_successor(&next)?;
                        walked += 1;
                        current = next;
                    }
                    None => break Some(current),
                }
            },
        };

        if let (Some(record), tip_sequence) = (valid_head, tip.as_ref().map(Checkpoint::sequence)) {
            if tip_sequence.is_none_or(|sequence| record.sequence > sequence) {
                return Err(StoreError::HeadAheadOfAuthority {
                    head_sequence: record.sequence,
                });
            }
        }

        let status = match (&head, valid_head, &tip) {
            (None, _, _) => HeadStatus::Absent,
            (Some(Err(_)), _, _) => HeadStatus::Corrupt,
            (Some(Ok(_)), Some(record), Some(tip)) if record.sequence == tip.sequence() => {
                HeadStatus::Consistent
            }
            (Some(Ok(_)), Some(record), _) => HeadStatus::Stale {
                head_sequence: record.sequence,
            },
            (Some(Ok(_)), None, _) => HeadStatus::Corrupt,
        };

        let mut repaired = false;
        match (&tip, status) {
            (Some(tip), HeadStatus::Absent | HeadStatus::Corrupt | HeadStatus::Stale { .. }) => {
                let record = HeadRecord {
                    scope_id,
                    sequence: tip.sequence(),
                    checkpoint_id: tip.id()?,
                };
                self.with_disk(|disk| disk.publish_replace(&stream, HEAD_FILE, &record.encode()?))?;
                repaired = true;
            }
            (None, HeadStatus::Corrupt) => {
                durable::remove_if_present(&head_path)?;
                sync_dir(&stream)?;
                repaired = true;
            }
            _ => {}
        }

        let resume = match &tip {
            Some(tip) => ResumePoint::after(tip)?,
            None => ResumePoint::genesis(scope)?,
        };
        Ok(Recovery {
            resume,
            head: status,
            head_repaired: repaired,
            checkpoints_walked: walked,
        })
    }

    /// Accelerated recovery; see [`Store::recover`].
    pub fn resume(&self, scope: &StreamScope) -> Result<ResumePoint, StoreError> {
        self.recover(scope, RecoveryMode::Accelerated)
            .map(|recovery| recovery.resume)
    }

    /// Proves that `first..=last` is completely covered by a contiguous,
    /// origin-anchored chain whose every link and evidence artifact verifies.
    /// Partial history can never certify a larger range.
    pub fn certify_range(
        &self,
        scope: &StreamScope,
        first: u64,
        last: u64,
    ) -> Result<RangeCertificate, StoreError> {
        if first > last {
            return Err(StoreError::RangeInvalid);
        }
        if first < scope.origin_block() {
            return Err(StoreError::RangeBeforeOrigin {
                requested_first: first,
                origin: scope.origin_block(),
            });
        }
        let stream = self
            .registered_stream(scope)?
            .ok_or(StoreError::RangeIncomplete {
                requested_last: last,
                covered_last: None,
            })?;
        let mut verified = BTreeSet::new();
        let mut previous: Option<Checkpoint> = None;
        let mut first_sequence = None;
        let mut sequence = 0_u64;
        loop {
            let Some(checkpoint) = Self::read_checkpoint(&stream, scope, sequence)? else {
                return Err(StoreError::RangeIncomplete {
                    requested_last: last,
                    covered_last: previous.as_ref().map(Checkpoint::last_block),
                });
            };
            if let Some(previous) = &previous {
                previous.check_successor(&checkpoint)?;
            }
            for artifact in checkpoint.evidence() {
                if verified.insert(*artifact) {
                    self.verify_artifact(artifact)?;
                }
            }
            if first_sequence.is_none() && checkpoint.last_block() >= first {
                first_sequence = Some(sequence);
            }
            if checkpoint.last_block() >= last {
                return Ok(RangeCertificate {
                    scope_id: scope.id()?,
                    first_block: first,
                    last_block: last,
                    first_sequence: first_sequence.unwrap_or(sequence),
                    last_sequence: sequence,
                    commitment: checkpoint.id()?,
                    artifacts_verified: u64::try_from(verified.len()).unwrap_or(u64::MAX),
                });
            }
            previous = Some(checkpoint);
            sequence = sequence
                .checked_add(1)
                .ok_or(StoreError::InvalidCheckpoint("sequence space exhausted"))?;
        }
    }

    /// Removes staging leftovers of crashed writers. Staging files are never
    /// authoritative; call this only while no writer is active.
    pub fn purge_staging(&self) -> Result<usize, StoreError> {
        let staging = self.staging();
        let mut removed = 0;
        for name in durable::entry_names(&staging)? {
            let path = staging.join(&name);
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| StoreError::io("stat", &path, &error))?;
            if !metadata.is_file() {
                return Err(StoreError::UnexpectedEntry(path));
            }
            durable::remove_if_present(&path)?;
            removed += 1;
        }
        sync_dir(&staging)?;
        Ok(removed)
    }
}

/// Reads the HEAD cache. `Some(Err(HeadCorrupt))` marks a structurally invalid
/// (including oversized) cache, which is repairable and never authoritative.
pub(crate) fn read_head(
    stream: &Path,
) -> Result<Option<Result<HeadRecord, StoreError>>, StoreError> {
    match read_bounded(&stream.join(HEAD_FILE), SMALL_OBJECT_LIMIT, "HEAD cache") {
        Ok(None) => Ok(None),
        Ok(Some(bytes)) => Ok(Some(HeadRecord::decode(&bytes))),
        Err(StoreError::ObjectTooLarge { .. }) => Ok(Some(Err(StoreError::HeadCorrupt))),
        Err(error) => Err(error),
    }
}

pub(crate) fn fanout_path(root: &Path, kind: &str, id: &[u8; 32]) -> PathBuf {
    root.join(OBJECTS_DIR)
        .join(kind)
        .join(canonical::hex(&id[..1]))
        .join(canonical::hex(id))
}

pub(crate) fn checkpoint_name(sequence: u64) -> String {
    format!("{sequence:020}")
}

/// Accepts only the exact 20-digit zero-padded decimal form.
pub(crate) fn parse_checkpoint_name(name: &str) -> Option<u64> {
    if name.len() != 20 || !name.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let sequence = name.parse::<u64>().ok()?;
    (checkpoint_name(sequence) == name).then_some(sequence)
}
