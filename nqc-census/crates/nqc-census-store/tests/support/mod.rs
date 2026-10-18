//! Shared helpers for the RMC-004 adversarial suite and the fixture example.
//!
//! All data here is SYNTHETIC and exists only to exercise storage semantics. It
//! is never market, liquidity, capital or profitability evidence.
#![allow(dead_code)]

use nqc_census_core::{Address, ChainDomain, DeploymentKey, Hash32, ProtocolFamily, StateAnchor};
use nqc_census_store::{
    ArtifactId, Checkpoint, CheckpointId, CommitOutcome, CompressionPolicy, ResumePoint, Store,
    StoreConfig, StreamKind, StreamScope,
};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

pub type TestResult = Result<(), Box<dyn Error>>;
pub type Res<T> = Result<T, Box<dyn Error>>;

pub type Edit = fn(&mut Vec<u8>);
pub type Damage = fn(&Path) -> TestResult;
pub type Listing = Vec<(PathBuf, Vec<u8>)>;

pub const ORIGIN: u64 = 100;
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A temporary directory outside the repository, removed on drop.
pub struct TempDir(PathBuf);

impl TempDir {
    pub fn new(label: &str) -> Res<Self> {
        let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "nqc-rmc004-{label}-{}-{counter}",
            std::process::id()
        ));
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
        fs::create_dir_all(&path)?;
        Ok(Self(path))
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

pub fn digest(parts: &[&[u8]]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    let mut out = [0_u8; 32];
    out.copy_from_slice(&hasher.finalize());
    out
}

pub fn hash(byte: u8) -> Res<Hash32> {
    Ok(Hash32::new([byte; 32])?)
}

/// Deterministic SHA-256 counter-mode bytes (incompressible in practice).
pub fn noise(len: usize, seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut counter = 0_u64;
    while out.len() < len {
        out.extend_from_slice(&digest(&[
            b"NQC-RMC004-TEST-NOISE",
            &seed.to_be_bytes(),
            &counter.to_be_bytes(),
        ]));
        counter += 1;
    }
    out.truncate(len);
    out
}

/// Deterministic, highly compressible bytes shaped like ABI words.
pub fn abi_like(len: usize, seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(len + 32);
    let mut word = 0_u64;
    while out.len() < len {
        out.extend_from_slice(&[0_u8; 24]);
        out.extend_from_slice(&(seed.wrapping_mul(31).wrapping_add(word % 7)).to_be_bytes());
        word += 1;
    }
    out.truncate(len);
    out
}

/// Small chunks so that multi-chunk, deduplication and CDC behaviour are
/// exercised by kilobyte-sized inputs.
pub fn small_config() -> Res<StoreConfig> {
    Ok(StoreConfig::new(
        256,
        8,
        2048,
        CompressionPolicy::NqcLzV1WhenSmaller,
        1 << 20,
    )?)
}

pub fn chain_domain(lineage: u8) -> Res<ChainDomain> {
    Ok(ChainDomain::new(1, hash(0x11)?, hash(lineage)?)?)
}

pub fn stream_kind(namespace: u16) -> Res<StreamKind> {
    Ok(StreamKind::new(namespace, 1, hash(0x33)?)?)
}

pub fn deployment(chain: &ChainDomain, instance: u8) -> Res<DeploymentKey> {
    Ok(DeploymentKey::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        Address::new([0x51; 20])?,
        hash(instance)?,
    ))
}

/// Canonical synthetic lineage `fork` (0 = main line). Block hashes are
/// `sha256("NQC-RMC004-BLOCK" || fork || n)`.
pub fn block_hash(fork: u8, number: u64) -> Res<Hash32> {
    Ok(Hash32::new(digest(&[
        b"NQC-RMC004-BLOCK",
        &[fork],
        &number.to_be_bytes(),
    ]))?)
}

pub fn scope_on(chain: ChainDomain, namespace: u16) -> Res<StreamScope> {
    Ok(StreamScope::new(
        chain,
        None,
        stream_kind(namespace)?,
        ORIGIN,
        block_hash(0, ORIGIN - 1)?,
    )?)
}

pub fn default_scope() -> Res<StreamScope> {
    scope_on(chain_domain(0x22)?, 1)
}

pub fn anchor_on(scope: &StreamScope, fork: u8, number: u64) -> Res<StateAnchor> {
    let parent = if fork != 0 && number == ORIGIN {
        block_hash(0, number - 1)?
    } else {
        block_hash(fork, number - 1)?
    };
    Ok(StateAnchor::new(
        scope.chain().clone(),
        number,
        block_hash(fork, number)?,
        parent,
        1_700_000_000 + 12 * number,
        Hash32::new(digest(&[
            b"NQC-RMC004-ROOT",
            &[fork],
            &number.to_be_bytes(),
        ]))?,
    )?)
}

pub fn anchor(scope: &StreamScope, number: u64) -> Res<StateAnchor> {
    anchor_on(scope, 0, number)
}

/// Synthetic evidence for a block range.
pub fn range_payload(first: u64, last: u64) -> Vec<u8> {
    let mut bytes = format!("SYNTHETIC-RMC004-EVIDENCE {first}..={last}\n").into_bytes();
    bytes.extend_from_slice(&abi_like(600, first));
    bytes.extend_from_slice(&noise(300, last));
    bytes
}

pub fn put(store: &Store, bytes: &[u8]) -> Res<ArtifactId> {
    Ok(store.put_artifact(bytes)?.id)
}

pub fn next_checkpoint(
    store: &Store,
    scope: &StreamScope,
    resume: &ResumePoint,
    last: u64,
) -> Res<Checkpoint> {
    let first = resume.next_first_block;
    let evidence = put(store, &range_payload(first, last))?;
    Ok(Checkpoint::next(
        scope,
        resume,
        anchor(scope, first)?,
        anchor(scope, last)?,
        vec![evidence],
    )?)
}

/// Commits contiguous checkpoints ending at each of `ends`.
pub fn commit_through(store: &Store, scope: &StreamScope, ends: &[u64]) -> Res<Vec<CheckpointId>> {
    let mut ids = Vec::new();
    for end in ends {
        let resume = store.resume(scope)?;
        let checkpoint = next_checkpoint(store, scope, &resume, *end)?;
        match store.commit(scope, &checkpoint)? {
            CommitOutcome::Created(id) => ids.push(id),
            CommitOutcome::AlreadyCommitted(_) => return Err("unexpected retry".into()),
        }
    }
    Ok(ids)
}

pub fn make_writable(path: &Path) -> Res<()> {
    let mut permissions = fs::metadata(path)?.permissions();
    permissions.set_mode(0o644);
    fs::set_permissions(path, permissions)?;
    Ok(())
}

/// Rewrites a (possibly read-only) store file in place.
pub fn tamper(path: &Path, edit: impl FnOnce(&mut Vec<u8>)) -> Res<()> {
    make_writable(path)?;
    let mut bytes = fs::read(path)?;
    edit(&mut bytes);
    fs::write(path, bytes)?;
    Ok(())
}

pub fn flip_last_byte(path: &Path) -> Res<()> {
    tamper(path, |bytes| {
        if let Some(last) = bytes.last_mut() {
            *last ^= 0x01;
        }
    })
}

pub fn files_under(dir: &Path) -> Res<Vec<PathBuf>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if fs::symlink_metadata(&path)?.is_dir() {
            out.extend(files_under(&path)?);
        } else {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

/// Every file under `root` with its bytes, keyed by path relative to `root`.
pub fn tree_listing(root: &Path) -> Res<Listing> {
    files_under(root)?
        .into_iter()
        .map(|path| {
            let bytes = fs::read(&path)?;
            Ok((path.strip_prefix(root)?.to_path_buf(), bytes))
        })
        .collect()
}

pub fn copy_tree(from: &Path, to: &Path) -> Res<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let target = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

pub fn head_path(store: &Store, scope: &StreamScope) -> Res<PathBuf> {
    Ok(store
        .root()
        .join("streams")
        .join(scope.id()?.to_hex())
        .join("HEAD"))
}

pub fn checkpoint_path(store: &Store, scope: &StreamScope, sequence: u64) -> Res<PathBuf> {
    Ok(store
        .root()
        .join("streams")
        .join(scope.id()?.to_hex())
        .join("checkpoints")
        .join(format!("{sequence:020}")))
}

pub fn manifest_path(store: &Store, id: &ArtifactId) -> PathBuf {
    let hex = id.to_hex();
    store
        .root()
        .join("objects/artifacts")
        .join(&hex[..2])
        .join(hex)
}

pub fn chunk_paths(store: &Store) -> Res<Vec<PathBuf>> {
    files_under(&store.root().join("objects/chunks"))
}

pub fn staging_files(store: &Store) -> Res<usize> {
    Ok(files_under(&store.root().join("tmp"))?.len())
}

/// The deterministic SYNTHETIC fixture used by the offline-verifier tests and
/// by CI's independent verifier: two streams (chain-level and
/// deployment-level), compressible and incompressible evidence, a multi-chunk
/// artifact, a shared (deduplicated) artifact and one orphan artifact.
pub fn build_fixture(root: &Path) -> Res<(Store, Vec<StreamScope>)> {
    let store = Store::create(root, small_config()?)?;
    let chain = chain_domain(0x22)?;
    let chain_scope = scope_on(chain.clone(), 1)?;
    let deployment_scope = StreamScope::new(
        chain.clone(),
        Some(deployment(&chain, 0x52)?),
        stream_kind(2)?,
        ORIGIN,
        block_hash(0, ORIGIN - 1)?,
    )?;
    let shared = put(&store, &abi_like(9000, 7))?;
    for scope in [&chain_scope, &deployment_scope] {
        for end in [109_u64, 119, 124, 139] {
            let resume = store.resume(scope)?;
            let first = resume.next_first_block;
            let mut evidence = vec![put(&store, &range_payload(first, end))?, shared];
            if end == 124 {
                evidence.push(put(&store, &noise(5000, end))?);
            }
            let checkpoint = Checkpoint::next(
                scope,
                &resume,
                anchor(scope, first)?,
                anchor(scope, end)?,
                evidence,
            )?;
            store.commit(scope, &checkpoint)?;
        }
    }
    put(
        &store,
        b"SYNTHETIC-RMC004 orphan artifact: stored, never referenced\n",
    )?;
    Ok((store, vec![chain_scope, deployment_scope]))
}
