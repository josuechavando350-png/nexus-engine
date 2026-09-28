use nqc_census_core::{ChainDomain, Hash32, IdentityError};
use nqc_census_store::{
    CensusStore, ChunkCodec, CommitFault, RangeCheckpoint, RangeScope, StoreError,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

type TestResult = Result<(), Box<dyn std::error::Error>>;

static TEST_COUNTER: AtomicU64 = AtomicU64::new(1);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new(label: &str) -> Result<Self, std::io::Error> {
        let sequence = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "nqc-census-store-{label}-{}-{sequence}",
            std::process::id()
        ));
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn hash(byte: u8) -> Result<Hash32, IdentityError> {
    Hash32::new([byte; 32])
}

fn chain() -> Result<ChainDomain, IdentityError> {
    ChainDomain::new(1, hash(0x11)?, hash(0x12)?)
}

fn scope() -> Result<RangeScope, Box<dyn std::error::Error>> {
    Ok(RangeScope::new(chain()?, hash(0x21)?, 1)?)
}

fn count_files(path: &Path) -> Result<usize, std::io::Error> {
    let mut count = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            count += count_files(&entry.path())?;
        } else {
            count += 1;
        }
    }
    Ok(count)
}

#[test]
fn artifact_roundtrip_compresses_and_deduplicates() -> TestResult {
    let temp = TestDir::new("artifact-rle")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let bytes = vec![0xab; 512];

    let first = store.put_artifact(&bytes)?;
    let object_count = count_files(&temp.path().join("objects"))?;
    let second = store.put_artifact(&bytes)?;

    assert_eq!(first, second);
    assert_eq!(count_files(&temp.path().join("objects"))?, object_count);
    assert_eq!(store.read_artifact(first)?, bytes);
    assert!(store
        .artifact_chunk_codecs(first)?
        .iter()
        .all(|codec| *codec == ChunkCodec::RunLength));

    let reopened = CensusStore::open(temp.path())?;
    assert_eq!(reopened.read_artifact(first)?, bytes);
    Ok(())
}

#[test]
fn incompressible_chunks_are_stored_raw_without_loss() -> TestResult {
    let temp = TestDir::new("artifact-raw")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let bytes = (0_u8..=127).collect::<Vec<_>>();
    let artifact = store.put_artifact(&bytes)?;

    assert_eq!(artifact.chunk_count(), 2);
    assert_eq!(
        store.artifact_chunk_codecs(artifact)?,
        vec![ChunkCodec::Raw, ChunkCodec::Raw]
    );
    assert_eq!(store.read_artifact(artifact)?, bytes);
    Ok(())
}

#[test]
fn store_config_persists_chunking_across_restart() -> TestResult {
    let temp = TestDir::new("config")?;
    let store = CensusStore::create(temp.path(), 128)?;
    drop(store);

    let reopened = CensusStore::open(temp.path())?;
    let artifact = reopened.put_artifact(&vec![0x44; 256])?;
    assert_eq!(artifact.chunk_count(), 2);
    Ok(())
}

#[test]
fn tampered_cas_object_fails_closed() -> TestResult {
    let temp = TestDir::new("tamper")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let artifact = store.put_artifact(&[0x55; 128])?;
    fs::write(store.object_path(artifact.manifest_digest()), b"tampered")?;

    assert!(matches!(
        store.verify_artifact(artifact),
        Err(StoreError::CorruptObject(_))
    ));
    Ok(())
}

#[test]
fn contiguous_checkpoint_chain_survives_restart_and_verifies_range() -> TestResult {
    let temp = TestDir::new("checkpoint-chain")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;

    let first_artifact = store.put_artifact(b"blocks 100 through 109")?;
    let first = RangeCheckpoint::new(
        scope.clone(),
        1,
        100,
        109,
        hash(0x30)?,
        hash(0x31)?,
        first_artifact,
        None,
    )?;
    let first_commit = store.commit_checkpoint(&first)?;

    let second_artifact = store.put_artifact(b"blocks 110 through 119")?;
    let second = RangeCheckpoint::new(
        scope.clone(),
        2,
        110,
        119,
        hash(0x31)?,
        hash(0x32)?,
        second_artifact,
        Some(first_commit.checkpoint_digest),
    )?;
    let second_commit = store.commit_checkpoint(&second)?;

    let verified = store.verify_range(scope.id(), 100, 119)?;
    assert_eq!(verified.checkpoint_count, 2);
    assert_eq!(verified.head_digest, second_commit.checkpoint_digest);

    let reopened = CensusStore::open(temp.path())?;
    let verified_again = reopened.verify_range(scope.id(), 100, 119)?;
    assert_eq!(verified_again, verified);
    Ok(())
}

#[test]
fn checkpoint_gap_and_parent_drift_fail_closed() -> TestResult {
    let temp = TestDir::new("gap-parent")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;
    let artifact = store.put_artifact(b"first")?;
    let first = RangeCheckpoint::new(
        scope.clone(),
        1,
        100,
        109,
        hash(0x40)?,
        hash(0x41)?,
        artifact,
        None,
    )?;
    let committed = store.commit_checkpoint(&first)?;

    let gap_artifact = store.put_artifact(b"gap")?;
    let gap = RangeCheckpoint::new(
        scope.clone(),
        2,
        111,
        119,
        hash(0x41)?,
        hash(0x42)?,
        gap_artifact,
        Some(committed.checkpoint_digest),
    )?;
    assert!(matches!(
        store.commit_checkpoint(&gap),
        Err(StoreError::RangeGap {
            expected_from: 110,
            actual_from: 111
        })
    ));

    let drift_artifact = store.put_artifact(b"parent drift")?;
    let drift = RangeCheckpoint::new(
        scope,
        2,
        110,
        119,
        hash(0x49)?,
        hash(0x42)?,
        drift_artifact,
        Some(committed.checkpoint_digest),
    )?;
    assert!(matches!(
        store.commit_checkpoint(&drift),
        Err(StoreError::ParentHashMismatch)
    ));
    Ok(())
}

#[test]
fn crash_after_checkpoint_object_leaves_no_committed_range_and_retry_succeeds() -> TestResult {
    let temp = TestDir::new("crash-object")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;
    let artifact = store.put_artifact(b"range")?;
    let checkpoint = RangeCheckpoint::new(
        scope.clone(),
        1,
        200,
        209,
        hash(0x50)?,
        hash(0x51)?,
        artifact,
        None,
    )?;

    assert!(matches!(
        store.commit_checkpoint_with_fault(&checkpoint, CommitFault::AfterCheckpointObject),
        Err(StoreError::InjectedCrash(
            CommitFault::AfterCheckpointObject
        ))
    ));
    assert!(store.load_scope_checkpoints(scope.id())?.is_empty());

    let committed = store.commit_checkpoint(&checkpoint)?;
    assert_eq!(committed.sequence, 1);
    assert_eq!(
        store.verify_range(scope.id(), 200, 209)?.checkpoint_count,
        1
    );
    Ok(())
}

#[test]
fn crash_after_durable_reference_is_recovered_idempotently() -> TestResult {
    let temp = TestDir::new("crash-reference")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;
    let artifact = store.put_artifact(b"range")?;
    let checkpoint = RangeCheckpoint::new(
        scope.clone(),
        1,
        300,
        309,
        hash(0x60)?,
        hash(0x61)?,
        artifact,
        None,
    )?;

    assert!(matches!(
        store.commit_checkpoint_with_fault(&checkpoint, CommitFault::AfterDurableReference),
        Err(StoreError::InjectedCrash(
            CommitFault::AfterDurableReference
        ))
    ));
    assert_eq!(store.load_scope_checkpoints(scope.id())?.len(), 1);
    assert_eq!(store.cached_head(scope.id())?, None);

    let retried = store.commit_checkpoint(&checkpoint)?;
    assert_eq!(
        store.cached_head(scope.id())?,
        Some(retried.checkpoint_digest)
    );
    assert_eq!(store.rebuild_head(scope.id())?, retried.checkpoint_digest);
    Ok(())
}

#[test]
fn same_sequence_with_different_content_is_not_idempotent() -> TestResult {
    let temp = TestDir::new("conflict")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;

    let first = RangeCheckpoint::new(
        scope.clone(),
        1,
        400,
        409,
        hash(0x70)?,
        hash(0x71)?,
        store.put_artifact(b"first")?,
        None,
    )?;
    store.commit_checkpoint(&first)?;

    let conflicting = RangeCheckpoint::new(
        scope,
        1,
        400,
        409,
        hash(0x70)?,
        hash(0x72)?,
        store.put_artifact(b"different")?,
        None,
    )?;
    assert!(matches!(
        store.commit_checkpoint(&conflicting),
        Err(StoreError::CheckpointConflict(1))
    ));
    Ok(())
}

#[test]
fn boundary_mismatch_prevents_false_completion_claim() -> TestResult {
    let temp = TestDir::new("boundary")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;
    let checkpoint = RangeCheckpoint::new(
        scope.clone(),
        1,
        500,
        509,
        hash(0x80)?,
        hash(0x81)?,
        store.put_artifact(b"partial")?,
        None,
    )?;
    store.commit_checkpoint(&checkpoint)?;

    assert!(matches!(
        store.verify_range(scope.id(), 500, 510),
        Err(StoreError::RangeBoundaryMismatch {
            expected_from: 500,
            expected_to: 510,
            actual_from: 500,
            actual_to: 509
        })
    ));
    Ok(())
}

#[test]
fn tampered_reference_is_detected_before_resume() -> TestResult {
    let temp = TestDir::new("reference-tamper")?;
    let store = CensusStore::create(temp.path(), 64)?;
    let scope = scope()?;
    let checkpoint = RangeCheckpoint::new(
        scope.clone(),
        1,
        600,
        609,
        hash(0x90)?,
        hash(0x91)?,
        store.put_artifact(b"range")?,
        None,
    )?;
    store.commit_checkpoint(&checkpoint)?;

    let reference = temp
        .path()
        .join("checkpoints")
        .join(scope.id().to_hex())
        .join("00000000000000000001.ref");
    fs::write(reference, b"not-a-digest\n")?;

    assert!(matches!(
        store.load_scope_checkpoints(scope.id()),
        Err(StoreError::InvalidHex)
    ));
    Ok(())
}
