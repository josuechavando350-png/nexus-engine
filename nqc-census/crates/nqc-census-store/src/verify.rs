//! Offline verifier for a store directory.
//!
//! It needs nothing but the directory: no RPC, network, provider, secret,
//! signer, SaaS, CI system or clock. It trusts no cache and no file name it has
//! not re-derived. Every object is re-hashed against the identity that names it
//! and re-encoded to prove canonicality; every checkpoint link is re-proven from
//! sequence 0; every referenced artifact is fully decoded. Any entry the format
//! does not define is an unknown state and fails verification.

use crate::canonical::{self, EVIDENCE_ROOT_DOMAIN};
use crate::checkpoint::{Checkpoint, CheckpointId, HeadRecord};
use crate::durable::{entry_names, read_bounded, require_dir};
use crate::error::StoreError;
use crate::object::{self, ArtifactId, ChunkId};
use crate::scope::{ScopeId, StreamScope};
use crate::store::{
    parse_checkpoint_name, HeadStatus, Store, ARTIFACTS_DIR, CHECKPOINTS_DIR, CHUNKS_DIR,
    HEAD_FILE, OBJECTS_DIR, SCOPE_FILE, SMALL_OBJECT_LIMIT, STAGING_DIR, STORE_FILE, STREAMS_DIR,
};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt::{Display, Formatter};
use std::fs;
use std::path::{Path, PathBuf};

/// Require that `first..=last` is covered by the stream `scope_id`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeRequirement {
    pub scope_id: ScopeId,
    pub first: u64,
    pub last: u64,
}

/// Require that the stream tip equals an externally recorded commitment. This
/// is what detects a wholesale replacement of the newest checkpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TipRequirement {
    pub scope_id: ScopeId,
    pub tip: CheckpointId,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct VerifyRequest {
    pub ranges: Vec<RangeRequirement>,
    pub tips: Vec<TipRequirement>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamReport {
    pub scope_id: ScopeId,
    pub checkpoints: u64,
    pub first_block: Option<u64>,
    pub last_block: Option<u64>,
    pub tip: Option<CheckpointId>,
    pub head: HeadStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    pub config_id: String,
    pub chunks: u64,
    pub artifacts: u64,
    pub logical_bytes: u64,
    pub stored_bytes: u64,
    pub orphan_chunks: u64,
    pub orphan_artifacts: u64,
    pub streams: Vec<StreamReport>,
    pub abandoned_registrations: u64,
    pub staging_files: u64,
    /// Commitment to the policy and every stream tip; independent of staging
    /// leftovers, orphans and the HEAD caches.
    pub evidence_root: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyFailure {
    /// Path relative to the store root (empty for the root itself).
    pub path: PathBuf,
    pub error: StoreError,
}

impl Display for VerifyFailure {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "code={} path={} reason={}",
            self.error.code(),
            self.path.display(),
            self.error
        )
    }
}

impl std::error::Error for VerifyFailure {}

struct Verifier<'a> {
    root: &'a Path,
    store: Store,
}

type Checked<T> = Result<T, VerifyFailure>;

impl Verifier<'_> {
    fn fail(&self, path: &Path, error: StoreError) -> VerifyFailure {
        VerifyFailure {
            path: path.strip_prefix(self.root).unwrap_or(path).to_path_buf(),
            error,
        }
    }

    fn at<T>(&self, path: &Path, result: Result<T, StoreError>) -> Checked<T> {
        result.map_err(|error| self.fail(path, error))
    }

    fn names(&self, dir: &Path) -> Checked<Vec<String>> {
        self.at(dir, entry_names(dir))
    }

    fn dir(&self, dir: &Path) -> Checked<()> {
        let device = self.at(self.root, crate::durable::root_device(self.root))?;
        self.at(dir, require_dir(dir, device))
    }

    fn exact_entries(&self, dir: &Path, expected: &[&str]) -> Checked<()> {
        let names = self.names(dir)?;
        for name in &names {
            if !expected.contains(&name.as_str()) {
                return Err(self.fail(&dir.join(name), StoreError::UnexpectedEntry(dir.join(name))));
            }
        }
        for name in expected {
            if !names.iter().any(|found| found == name) {
                return Err(self.fail(
                    &dir.join(name),
                    StoreError::io(
                        "stat",
                        &dir.join(name),
                        &std::io::Error::from(std::io::ErrorKind::NotFound),
                    ),
                ));
            }
        }
        Ok(())
    }

    /// Yields `(id, path)` for every object in a two-level fan-out directory,
    /// rejecting any name that is not the canonical rendering of its id.
    fn fanout_objects(&self, kind_dir: &Path) -> Checked<Vec<([u8; 32], PathBuf)>> {
        let mut out = Vec::new();
        for fan in self.names(kind_dir)? {
            let fan_dir = kind_dir.join(&fan);
            let canonical_fan = fan.len() == 2
                && fan
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
            if !canonical_fan {
                return Err(self.fail(&fan_dir, StoreError::InvalidObjectName(fan_dir.clone())));
            }
            self.dir(&fan_dir)?;
            for name in self.names(&fan_dir)? {
                let path = fan_dir.join(&name);
                let id = canonical::parse_hex32(&name)
                    .filter(|id| canonical::hex(&id[..1]) == fan)
                    .ok_or_else(|| self.fail(&path, StoreError::InvalidObjectName(path.clone())))?;
                out.push((id, path));
            }
        }
        Ok(out)
    }

    fn run(&self, request: &VerifyRequest) -> Checked<VerifyReport> {
        let root = self.root;
        let config = *self.store.config();
        self.exact_entries(root, &[OBJECTS_DIR, STORE_FILE, STREAMS_DIR, STAGING_DIR])?;
        let objects = root.join(OBJECTS_DIR);
        self.exact_entries(&objects, &[ARTIFACTS_DIR, CHUNKS_DIR])?;

        // Chunk frames: name = logical chunk id; bytes = canonical frame.
        let mut chunks = BTreeMap::<ChunkId, [u8; 32]>::new();
        let mut stored_bytes = 0_u64;
        for (id, path) in self.fanout_objects(&objects.join(CHUNKS_DIR))? {
            let frame = self
                .at(
                    &path,
                    read_bounded(&path, config.max_frame_bytes(), "chunk frame"),
                )?
                .ok_or_else(|| self.fail(&path, StoreError::ChunkMissing(canonical::hex(&id))))?;
            let raw = self.at(&path, object::decode_frame_standalone(&frame, &config))?;
            if *ChunkId::of(&raw).as_bytes() != id {
                return Err(self.fail(&path, StoreError::DigestMismatch { object: "chunk" }));
            }
            if self.at(&path, object::encode_frame(&raw, &config))? != frame {
                return Err(self.fail(
                    &path,
                    StoreError::NonCanonical {
                        object: "chunk frame",
                    },
                ));
            }
            stored_bytes = stored_bytes.saturating_add(u64::try_from(frame.len()).unwrap_or(0));
            chunks.insert(ChunkId::from_bytes(id), object::frame_digest(&frame));
        }

        // Manifests: name = artifact id = sha256(logical bytes); canonical.
        let mut artifacts = BTreeSet::<ArtifactId>::new();
        let mut referenced_chunks = BTreeSet::<ChunkId>::new();
        let mut logical_bytes = 0_u64;
        for (id, path) in self.fanout_objects(&objects.join(ARTIFACTS_DIR))? {
            let artifact = ArtifactId::from_bytes(id);
            let (logical, manifest_bytes, manifest) =
                self.at(&path, self.store.read_artifact(&artifact))?;
            self.at(
                &path,
                self.store
                    .require_canonical_manifest(&logical, &manifest_bytes),
            )?;
            for entry in &manifest.chunks {
                if chunks.get(&entry.id) != Some(&entry.frame_digest) {
                    return Err(self.fail(&path, StoreError::ChunkMissing(entry.id.to_hex())));
                }
                referenced_chunks.insert(entry.id);
            }
            logical_bytes = logical_bytes.saturating_add(u64::try_from(logical.len()).unwrap_or(0));
            artifacts.insert(artifact);
        }

        // Streams: every link re-proven from sequence 0.
        let streams_dir = root.join(STREAMS_DIR);
        let mut streams = Vec::new();
        let mut referenced_artifacts = BTreeSet::<ArtifactId>::new();
        let mut abandoned = 0_u64;
        for name in self.names(&streams_dir)? {
            let stream = streams_dir.join(&name);
            self.dir(&stream)?;
            let scope_id = ScopeId(canonical::parse_hex32(&name).ok_or_else(|| {
                self.fail(&stream, StoreError::InvalidObjectName(stream.clone()))
            })?);
            let entries = self.names(&stream)?;
            for entry in &entries {
                if ![CHECKPOINTS_DIR, HEAD_FILE, SCOPE_FILE].contains(&entry.as_str()) {
                    let path = stream.join(entry);
                    return Err(self.fail(&path, StoreError::UnexpectedEntry(path.clone())));
                }
            }
            if !entries.iter().any(|entry| entry == SCOPE_FILE) {
                if self.is_abandoned_registration(&stream, &entries)? {
                    abandoned += 1;
                    continue;
                }
                return Err(self.fail(&stream, StoreError::StreamNotRegistered(name.clone())));
            }
            let report =
                self.verify_stream(&stream, scope_id, &artifacts, &mut referenced_artifacts)?;
            streams.push(report);
        }

        for requirement in &request.tips {
            let stream = streams
                .iter()
                .find(|report| report.scope_id == requirement.scope_id)
                .ok_or_else(|| {
                    self.fail(
                        &streams_dir.join(requirement.scope_id.to_hex()),
                        StoreError::StreamNotRegistered(requirement.scope_id.to_hex()),
                    )
                })?;
            if stream.tip != Some(requirement.tip) {
                return Err(self.fail(
                    &streams_dir.join(requirement.scope_id.to_hex()),
                    StoreError::TipMismatch,
                ));
            }
        }
        for requirement in &request.ranges {
            self.check_range(&streams_dir, &streams, requirement)?;
        }

        let staging = root.join(STAGING_DIR);
        self.dir(&staging)?;
        let mut staging_files = 0_u64;
        for name in self.names(&staging)? {
            let path = staging.join(&name);
            let metadata = self.at(
                &path,
                fs::symlink_metadata(&path).map_err(|error| StoreError::io("stat", &path, &error)),
            )?;
            if !metadata.file_type().is_file() {
                return Err(self.fail(&path, StoreError::UnexpectedEntry(path.clone())));
            }
            staging_files += 1;
        }

        let mut root_payload = self.store.config_id().as_bytes().to_vec();
        for stream in &streams {
            root_payload.extend_from_slice(stream.scope_id.as_bytes());
            root_payload.extend_from_slice(&stream.checkpoints.to_be_bytes());
            let tip = stream.tip.map_or([0; 32], |tip| *tip.as_bytes());
            root_payload.extend_from_slice(&tip);
        }

        Ok(VerifyReport {
            config_id: self.store.config_id().to_hex(),
            chunks: count(chunks.len()),
            artifacts: count(artifacts.len()),
            logical_bytes,
            stored_bytes,
            orphan_chunks: count(
                chunks
                    .keys()
                    .filter(|id| !referenced_chunks.contains(id))
                    .count(),
            ),
            orphan_artifacts: count(
                artifacts
                    .iter()
                    .filter(|id| !referenced_artifacts.contains(id))
                    .count(),
            ),
            streams,
            abandoned_registrations: abandoned,
            staging_files,
            evidence_root: canonical::hex(&canonical::domain_digest(
                EVIDENCE_ROOT_DOMAIN,
                &root_payload,
            )),
        })
    }

    /// A writer that crashed while registering can leave a stream directory
    /// without `SCOPE`. That state carries no authority and is accepted only
    /// when it holds nothing but an empty checkpoint directory.
    fn is_abandoned_registration(&self, stream: &Path, entries: &[String]) -> Checked<bool> {
        match entries {
            [] => Ok(true),
            [only] if only == CHECKPOINTS_DIR => {
                let catalog = stream.join(CHECKPOINTS_DIR);
                self.dir(&catalog)?;
                Ok(self.names(&catalog)?.is_empty())
            }
            _ => Ok(false),
        }
    }

    fn verify_stream(
        &self,
        stream: &Path,
        scope_id: ScopeId,
        artifacts: &BTreeSet<ArtifactId>,
        referenced: &mut BTreeSet<ArtifactId>,
    ) -> Checked<StreamReport> {
        let scope_path = stream.join(SCOPE_FILE);
        let scope_bytes = self
            .at(
                &scope_path,
                read_bounded(&scope_path, SMALL_OBJECT_LIMIT, "stream scope"),
            )?
            .ok_or_else(|| {
                self.fail(
                    &scope_path,
                    StoreError::StreamNotRegistered(scope_id.to_hex()),
                )
            })?;
        let scope = self.at(&scope_path, StreamScope::decode(&scope_bytes))?;
        if self.at(&scope_path, scope.id())? != scope_id {
            return Err(self.fail(
                &scope_path,
                StoreError::DigestMismatch {
                    object: "stream scope",
                },
            ));
        }

        let catalog = stream.join(CHECKPOINTS_DIR);
        self.dir(&catalog)?;
        let mut sequences = Vec::new();
        for name in self.names(&catalog)? {
            let path = catalog.join(&name);
            let sequence = parse_checkpoint_name(&name)
                .ok_or_else(|| self.fail(&path, StoreError::InvalidObjectName(path.clone())))?;
            sequences.push(sequence);
        }
        sequences.sort_unstable();
        for (expected, found) in (0_u64..).zip(&sequences) {
            if *found != expected {
                return Err(self.fail(&catalog, StoreError::CatalogGap { missing: expected }));
            }
        }

        let head_path = stream.join(HEAD_FILE);
        let head = match read_bounded(&head_path, SMALL_OBJECT_LIMIT, "HEAD cache") {
            Ok(None) => None,
            Ok(Some(bytes)) => Some(self.at(&head_path, HeadRecord::decode(&bytes))?),
            Err(StoreError::ObjectTooLarge { .. }) => {
                return Err(self.fail(&head_path, StoreError::HeadCorrupt))
            }
            Err(error) => return Err(self.fail(&head_path, error)),
        };
        if let Some(record) = &head {
            if record.scope_id != scope_id {
                return Err(self.fail(&head_path, StoreError::HeadConflictsWithAuthority));
            }
        }

        let mut previous: Option<Checkpoint> = None;
        let mut first_block = None;
        for sequence in &sequences {
            let path = catalog.join(crate::store::checkpoint_name(*sequence));
            let checkpoint = self
                .at(&path, Store::read_checkpoint(stream, &scope, *sequence))?
                .ok_or_else(|| self.fail(&path, StoreError::CatalogGap { missing: *sequence }))?;
            if let Some(previous) = &previous {
                self.at(&path, previous.check_successor(&checkpoint))?;
            }
            for artifact in checkpoint.evidence() {
                if !artifacts.contains(artifact) {
                    return Err(self.fail(&path, StoreError::ArtifactMissing(artifact.to_hex())));
                }
                referenced.insert(*artifact);
            }
            if let Some(record) = &head {
                if record.sequence == *sequence
                    && record.checkpoint_id != self.at(&path, checkpoint.id())?
                {
                    return Err(self.fail(&head_path, StoreError::HeadConflictsWithAuthority));
                }
            }
            first_block.get_or_insert(checkpoint.first_block());
            previous = Some(checkpoint);
        }

        let tip = match &previous {
            Some(checkpoint) => Some(self.at(&catalog, checkpoint.id())?),
            None => None,
        };
        let head_status = match (&head, &previous) {
            (None, _) => HeadStatus::Absent,
            (Some(record), Some(tip)) if record.sequence == tip.sequence() => {
                HeadStatus::Consistent
            }
            (Some(record), Some(tip)) if record.sequence < tip.sequence() => HeadStatus::Stale {
                head_sequence: record.sequence,
            },
            (Some(record), _) => {
                return Err(self.fail(
                    &head_path,
                    StoreError::HeadAheadOfAuthority {
                        head_sequence: record.sequence,
                    },
                ))
            }
        };
        Ok(StreamReport {
            scope_id,
            checkpoints: count(sequences.len()),
            first_block,
            last_block: previous.as_ref().map(Checkpoint::last_block),
            tip,
            head: head_status,
        })
    }

    fn check_range(
        &self,
        streams_dir: &Path,
        streams: &[StreamReport],
        requirement: &RangeRequirement,
    ) -> Checked<()> {
        let path = streams_dir.join(requirement.scope_id.to_hex());
        if requirement.first > requirement.last {
            return Err(self.fail(&path, StoreError::RangeInvalid));
        }
        let stream = streams
            .iter()
            .find(|report| report.scope_id == requirement.scope_id)
            .ok_or_else(|| {
                self.fail(
                    &path,
                    StoreError::StreamNotRegistered(requirement.scope_id.to_hex()),
                )
            })?;
        let scope_bytes = self
            .at(
                &path,
                read_bounded(&path.join(SCOPE_FILE), SMALL_OBJECT_LIMIT, "stream scope"),
            )?
            .ok_or_else(|| {
                self.fail(
                    &path,
                    StoreError::StreamNotRegistered(requirement.scope_id.to_hex()),
                )
            })?;
        let origin = self
            .at(&path, StreamScope::decode(&scope_bytes))?
            .origin_block();
        if requirement.first < origin {
            return Err(self.fail(
                &path,
                StoreError::RangeBeforeOrigin {
                    requested_first: requirement.first,
                    origin,
                },
            ));
        }
        match stream.last_block {
            Some(last) if last >= requirement.last => Ok(()),
            covered_last => Err(self.fail(
                &path,
                StoreError::RangeIncomplete {
                    requested_last: requirement.last,
                    covered_last,
                },
            )),
        }
    }
}

fn count(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

/// Verifies the complete evidence graph under `root`. See the module docs.
pub fn verify_store(root: &Path, request: &VerifyRequest) -> Result<VerifyReport, VerifyFailure> {
    let store = Store::open_existing(root).map_err(|error| VerifyFailure {
        path: PathBuf::new(),
        error,
    })?;
    Verifier { root, store }.run(request)
}
