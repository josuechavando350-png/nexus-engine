//! Crash injection at every publication point, HEAD/catalog reconstruction and
//! reference tampering. A fault leaves the filesystem exactly as a process
//! killed at that instant would (no cleanup runs); one test kills a real child
//! process with `abort()`.

mod support;

use nqc_census_store::verify::{verify_store, TipRequirement, VerifyRequest};
use nqc_census_store::{
    CommitOutcome, FaultHook, FaultPoint, HeadStatus, RecoveryMode, Store, StoreError, StreamScope,
};
use std::fs;
use support::{
    checkpoint_path, commit_through, default_scope, flip_last_byte, head_path, manifest_path,
    next_checkpoint, put, range_payload, small_config, staging_files, tamper, Edit, TempDir,
    TestResult,
};

fn faulty(
    store_root: &std::path::Path,
    point: FaultPoint,
) -> Result<Store, Box<dyn std::error::Error>> {
    Ok(Store::open(store_root, &small_config()?)?.with_fault_hook(FaultHook::at(point)))
}

fn fresh(label: &str) -> Result<(TempDir, StreamScope), Box<dyn std::error::Error>> {
    let dir = TempDir::new(label)?;
    let store = Store::create(dir.path(), small_config()?)?;
    let scope = default_scope()?;
    commit_through(&store, &scope, &[104, 109])?;
    Ok((dir, scope))
}

#[test]
fn crash_during_artifact_publication_never_advances_progress() -> TestResult {
    for point in [
        FaultPoint::ObjectStaged,
        FaultPoint::ObjectLinked,
        FaultPoint::ObjectDurable,
    ] {
        let (dir, scope) = fresh(&format!("crash-object-{point:?}"))?;
        let bytes = range_payload(110, 119);
        let crashed = faulty(dir.path(), point)?;
        assert_eq!(
            crashed.put_artifact(&bytes).err(),
            Some(StoreError::InjectedFault(point))
        );
        // Reopen as a new process: committed progress is unchanged.
        let store = Store::open(dir.path(), &small_config()?)?;
        let resume = store.resume(&scope)?;
        assert_eq!(resume.next_sequence, 2, "{point:?}");
        assert_eq!(resume.durable_through, Some(109));
        // The crash state verifies (it holds no authority) and staging garbage
        // is reported, not trusted.
        let report = verify_store(dir.path(), &VerifyRequest::default())?;
        assert_eq!(report.staging_files, 1, "{point:?}");
        // The interrupted work can simply be redone.
        let id = put(&store, &bytes)?;
        assert_eq!(store.get_artifact(&id)?, bytes);
        store.purge_staging()?;
        assert_eq!(staging_files(&store)?, 0);
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn crash_before_checkpoint_link_does_not_commit() -> TestResult {
    let (dir, scope) = fresh("crash-cp-staged")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let resume = store.resume(&scope)?;
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    let crashed = faulty(dir.path(), FaultPoint::CheckpointStaged)?;
    assert_eq!(
        crashed.commit(&scope, &checkpoint),
        Err(StoreError::InjectedFault(FaultPoint::CheckpointStaged))
    );
    // Evidence objects are durable but unreferenced; progress did not move.
    let recovery = store.recover(&scope, RecoveryMode::Full)?;
    assert_eq!(recovery.resume, resume);
    assert_eq!(recovery.head, HeadStatus::Consistent);
    assert!(!checkpoint_path(&store, &scope, 2)?.exists());
    let report = verify_store(dir.path(), &VerifyRequest::default())?;
    assert_eq!(report.orphan_artifacts, 1);
    // Retry after the crash creates it exactly once.
    assert!(matches!(
        store.commit(&scope, &checkpoint)?,
        CommitOutcome::Created(_)
    ));
    Ok(())
}

#[test]
fn crash_after_checkpoint_authority_recovers_and_repairs_head() -> TestResult {
    for point in [
        FaultPoint::CheckpointLinked,
        FaultPoint::CheckpointDurable,
        FaultPoint::HeadStaged,
    ] {
        let (dir, scope) = fresh(&format!("crash-authority-{point:?}"))?;
        let store = Store::open(dir.path(), &small_config()?)?;
        let resume = store.resume(&scope)?;
        let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
        let crashed = faulty(dir.path(), point)?;
        assert_eq!(
            crashed.commit(&scope, &checkpoint),
            Err(StoreError::InjectedFault(point))
        );
        let head_before = fs::read(head_path(&store, &scope)?)?;

        // The committed checkpoint is found although HEAD still names seq 1.
        let recovery = store.recover(&scope, RecoveryMode::Accelerated)?;
        assert_eq!(recovery.resume.next_sequence, 3, "{point:?}");
        assert_eq!(recovery.resume.durable_through, Some(119));
        assert_eq!(recovery.resume.predecessor, Some(checkpoint.id()?));
        assert_eq!(recovery.head, HeadStatus::Stale { head_sequence: 1 });
        assert!(recovery.head_repaired);
        assert_ne!(fs::read(head_path(&store, &scope)?)?, head_before);

        // Repair is idempotent: a second recovery changes nothing.
        let head_after = fs::read(head_path(&store, &scope)?)?;
        let again = store.recover(&scope, RecoveryMode::Accelerated)?;
        assert_eq!(again.head, HeadStatus::Consistent);
        assert!(!again.head_repaired);
        assert_eq!(fs::read(head_path(&store, &scope)?)?, head_after);

        // The ambiguous retry is safe.
        assert_eq!(
            store.commit(&scope, &checkpoint)?,
            CommitOutcome::AlreadyCommitted(checkpoint.id()?)
        );
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn crash_after_head_rename_is_consistent() -> TestResult {
    let (dir, scope) = fresh("crash-head-renamed")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let resume = store.resume(&scope)?;
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    let crashed = faulty(dir.path(), FaultPoint::HeadRenamed)?;
    assert_eq!(
        crashed.commit(&scope, &checkpoint),
        Err(StoreError::InjectedFault(FaultPoint::HeadRenamed))
    );
    let recovery = store.recover(&scope, RecoveryMode::Full)?;
    assert_eq!(recovery.head, HeadStatus::Consistent);
    assert_eq!(recovery.resume.next_sequence, 3);
    assert!(!recovery.head_repaired);
    Ok(())
}

#[test]
fn every_fault_point_leaves_a_verifiable_store() -> TestResult {
    for point in FaultPoint::ALL {
        let (dir, scope) = fresh(&format!("crash-all-{point:?}"))?;
        let crashed = faulty(dir.path(), point)?;
        let resume = crashed.resume(&scope)?;
        let attempt = next_checkpoint(&crashed, &scope, &resume, 119)
            .and_then(|checkpoint| Ok(crashed.commit(&scope, &checkpoint)?));
        assert!(attempt.is_err(), "{point:?} did not fire");
        let store = Store::open(dir.path(), &small_config()?)?;
        let recovery = store.recover(&scope, RecoveryMode::Full)?;
        assert!(recovery.resume.next_sequence == 2 || recovery.resume.next_sequence == 3);
        verify_store(dir.path(), &VerifyRequest::default())?;
        // Continuing from the recovered point always works.
        commit_through(&store, &scope, &[recovery.resume.next_first_block + 5])?;
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn deleted_head_is_rebuilt_from_the_catalog() -> TestResult {
    let (dir, scope) = fresh("head-deleted")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let expected = store.resume(&scope)?;
    let head = head_path(&store, &scope)?;
    let original = fs::read(&head)?;
    fs::remove_file(&head)?;
    let recovery = store.recover(&scope, RecoveryMode::Accelerated)?;
    assert_eq!(recovery.head, HeadStatus::Absent);
    assert!(recovery.head_repaired);
    assert_eq!(recovery.resume, expected);
    assert_eq!(
        recovery.checkpoints_walked, 2,
        "rebuild must walk from sequence 0"
    );
    assert_eq!(fs::read(&head)?, original, "rebuilt HEAD differs");
    Ok(())
}

#[test]
fn corrupt_head_is_rebuilt_from_the_catalog() -> TestResult {
    let edits: [(&str, Edit); 4] = [
        ("garbage", |bytes| *bytes = b"not a head".to_vec()),
        ("truncated", |bytes| bytes.truncate(bytes.len() / 2)),
        ("bitflip", |bytes| {
            if let Some(byte) = bytes.get_mut(40) {
                *byte ^= 0x01;
            }
        }),
        ("oversized", |bytes| bytes.resize(8192, 0)),
    ];
    for (label, edit) in edits {
        let (dir, scope) = fresh(&format!("head-corrupt-{label}"))?;
        let store = Store::open(dir.path(), &small_config()?)?;
        let expected = store.resume(&scope)?;
        let head = head_path(&store, &scope)?;
        let original = fs::read(&head)?;
        tamper(&head, edit)?;
        // The offline verifier refuses to certify a store with a corrupt cache.
        assert!(
            verify_store(dir.path(), &VerifyRequest::default()).is_err(),
            "{label}"
        );
        let recovery = store.recover(&scope, RecoveryMode::Accelerated)?;
        assert_eq!(recovery.head, HeadStatus::Corrupt, "{label}");
        assert!(recovery.head_repaired);
        assert_eq!(recovery.resume, expected);
        assert_eq!(fs::read(&head)?, original);
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn well_formed_head_contradicting_authority_fails_closed() -> TestResult {
    let (dir, scope) = fresh("head-forged")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let resume = store.resume(&scope)?;
    let head = head_path(&store, &scope)?;
    // Forge a correctly sealed HEAD naming seq 1 with a different checkpoint id.
    let forged = forge_head(scope.id()?.as_bytes(), 1, &[0x5a; 32]);
    tamper(&head, |bytes| *bytes = forged.clone())?;
    for mode in [RecoveryMode::Accelerated, RecoveryMode::Full] {
        assert_eq!(
            store.recover(&scope, mode),
            Err(StoreError::HeadConflictsWithAuthority)
        );
    }
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    // A writer refuses to build new authority on top of tamper evidence and
    // never silently overwrites it.
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    assert_eq!(
        store.commit(&scope, &checkpoint),
        Err(StoreError::HeadConflictsWithAuthority)
    );
    assert!(!checkpoint_path(&store, &scope, 2)?.exists());
    assert_eq!(fs::read(&head)?, forged);
    Ok(())
}

#[test]
fn head_ahead_of_authority_fails_closed() -> TestResult {
    let (dir, scope) = fresh("head-ahead")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let head = head_path(&store, &scope)?;
    let forged = forge_head(scope.id()?.as_bytes(), 9, &[0x5a; 32]);
    tamper(&head, |bytes| *bytes = forged.clone())?;
    for mode in [RecoveryMode::Accelerated, RecoveryMode::Full] {
        assert_eq!(
            store.recover(&scope, mode),
            Err(StoreError::HeadAheadOfAuthority { head_sequence: 9 })
        );
    }
    let failure = verify_store(dir.path(), &VerifyRequest::default())
        .err()
        .ok_or("HEAD ahead verified")?;
    assert_eq!(
        failure.error,
        StoreError::HeadAheadOfAuthority { head_sequence: 9 }
    );
    Ok(())
}

#[test]
fn head_copied_from_another_stream_fails_closed() -> TestResult {
    let (dir, scope) = fresh("head-foreign")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let other = support::scope_on(support::chain_domain(0x22)?, 5)?;
    commit_through(&store, &other, &[103])?;
    fs::copy(head_path(&store, &other)?, head_path(&store, &scope)?)?;
    assert_eq!(
        store.recover(&scope, RecoveryMode::Accelerated),
        Err(StoreError::HeadConflictsWithAuthority)
    );
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    Ok(())
}

#[test]
fn malformed_checkpoint_reference_fails_before_resume() -> TestResult {
    let damage: [(&str, Edit); 3] = [
        ("truncated", |bytes| bytes.truncate(bytes.len() - 7)),
        ("bitflip", |bytes| {
            let middle = bytes.len() / 2;
            if let Some(byte) = bytes.get_mut(middle) {
                *byte ^= 0x10;
            }
        }),
        ("trailing", |bytes| bytes.push(0)),
    ];
    for (label, edit) in damage {
        for sequence in [0_u64, 1] {
            let (dir, scope) = fresh(&format!("ref-{label}-{sequence}"))?;
            let store = Store::open(dir.path(), &small_config()?)?;
            tamper(&checkpoint_path(&store, &scope, sequence)?, edit)?;
            assert!(
                store.recover(&scope, RecoveryMode::Full).is_err(),
                "{label} seq {sequence} resumed"
            );
            let next = store.resume(&scope);
            if sequence == 1 {
                // HEAD names seq 1, whose bytes no longer decode or match.
                assert!(next.is_err(), "{label} accelerated resume accepted damage");
            }
            assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
        }
    }
    Ok(())
}

#[test]
fn renamed_or_missing_checkpoint_breaks_the_catalog() -> TestResult {
    // A checkpoint file moved to another sequence name.
    let (dir, scope) = fresh("ref-renamed")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    fs::rename(
        checkpoint_path(&store, &scope, 1)?,
        checkpoint_path(&store, &scope, 2)?,
    )?;
    assert!(store.recover(&scope, RecoveryMode::Full).is_err());
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());

    // A hole in the middle of the catalog.
    let (dir, scope) = fresh("ref-hole")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    commit_through(&store, &scope, &[119])?;
    fs::remove_file(checkpoint_path(&store, &scope, 1)?)?;
    let failure = verify_store(dir.path(), &VerifyRequest::default())
        .err()
        .ok_or("catalog hole verified")?;
    assert_eq!(failure.error, StoreError::CatalogGap { missing: 1 });
    Ok(())
}

#[test]
fn referenced_evidence_tamper_fails_verification() -> TestResult {
    let (dir, scope) = fresh("ref-evidence")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let resume = store.resume(&scope)?;
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    store.commit(&scope, &checkpoint)?;
    let evidence = checkpoint
        .evidence()
        .first()
        .copied()
        .ok_or("no evidence")?;
    flip_last_byte(&manifest_path(&store, &evidence))?;
    assert!(store.certify_range(&scope, 100, 119).is_err());
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    Ok(())
}

#[test]
fn replaced_tip_is_caught_by_an_external_commitment() -> TestResult {
    let (dir, scope) = fresh("tip-replaced")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    let resume = store.resume(&scope)?;
    let honest = next_checkpoint(&store, &scope, &resume, 119)?;
    store.commit(&scope, &honest)?;
    let recorded_tip = honest.id()?;

    // An attacker with write access deletes HEAD and replaces the newest
    // checkpoint with a different, internally valid successor.
    let forged = next_checkpoint(&store, &scope, &resume, 115)?;
    fs::remove_file(head_path(&store, &scope)?)?;
    let tip_path = checkpoint_path(&store, &scope, 2)?;
    tamper(&tip_path, |bytes| {
        *bytes = forged.canonical_bytes().unwrap_or_default();
    })?;
    // Internally the store is consistent again...
    verify_store(dir.path(), &VerifyRequest::default())?;
    // ...but it no longer matches the commitment recorded before the attack.
    let failure = verify_store(
        dir.path(),
        &VerifyRequest {
            ranges: Vec::new(),
            tips: vec![TipRequirement {
                scope_id: scope.id()?,
                tip: recorded_tip,
            }],
        },
    )
    .err()
    .ok_or("replaced tip matched")?;
    assert_eq!(failure.error, StoreError::TipMismatch);
    Ok(())
}

#[test]
fn staging_files_never_become_authoritative() -> TestResult {
    let (dir, scope) = fresh("staging-garbage")?;
    let store = Store::open(dir.path(), &small_config()?)?;
    // Plant a complete, valid checkpoint only under a staging name.
    let resume = store.resume(&scope)?;
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    fs::write(dir.join("tmp/planted.stage"), checkpoint.canonical_bytes()?)?;
    assert_eq!(store.resume(&scope)?.next_sequence, 2);
    assert_eq!(
        verify_store(dir.path(), &VerifyRequest::default())?.staging_files,
        1
    );
    assert_eq!(store.purge_staging()?, 1);
    Ok(())
}

#[test]
fn real_process_abort_after_checkpoint_durable_recovers() -> TestResult {
    const CHILD_ENV: &str = "NQC_RMC004_ABORT_CHILD_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ENV) {
        // Child: commit sequence 2 and die with SIGABRT the instant the
        // checkpoint is durable, before HEAD is touched. No destructor runs.
        let root = std::path::PathBuf::from(root);
        let scope = default_scope()?;
        let store =
            Store::open(&root, &small_config()?)?.with_fault_hook(FaultHook::new(|point| {
                if point == FaultPoint::CheckpointDurable {
                    std::process::abort();
                }
                false
            }));
        let resume = store.resume(&scope)?;
        let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
        store.commit(&scope, &checkpoint)?;
        return Err("child survived its own crash point".into());
    }

    let (dir, scope) = fresh("real-abort")?;
    // The child's checkpoint is deterministic; the parent derives it too so it
    // can later prove the ambiguous commit landed exactly once.
    let expected = {
        let store = Store::open(dir.path(), &small_config()?)?;
        let resume = store.resume(&scope)?;
        next_checkpoint(&store, &scope, &resume, 119)?
    };
    let status = std::process::Command::new(std::env::current_exe()?)
        .args([
            "real_process_abort_after_checkpoint_durable_recovers",
            "--exact",
            "--test-threads=1",
            "--nocapture",
        ])
        .env(CHILD_ENV, dir.path())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()?;
    assert!(!status.success(), "child must die at the crash point");
    {
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(
            status.signal(),
            Some(6),
            "child must die of SIGABRT: {status:?}"
        );
    }

    let store = Store::open(dir.path(), &small_config()?)?;
    assert_eq!(
        staging_files(&store)?,
        1,
        "crashed writer leaves its staging name"
    );
    let recovery = store.recover(&scope, RecoveryMode::Accelerated)?;
    assert_eq!(recovery.resume.next_sequence, 3);
    assert_eq!(recovery.resume.durable_through, Some(119));
    assert_eq!(recovery.resume.predecessor, Some(expected.id()?));
    assert_eq!(recovery.head, HeadStatus::Stale { head_sequence: 1 });
    assert!(recovery.head_repaired);
    assert_eq!(
        store.commit(&scope, &expected)?,
        CommitOutcome::AlreadyCommitted(expected.id()?)
    );
    let report = verify_store(dir.path(), &VerifyRequest::default())?;
    assert_eq!(report.streams.first().map(|s| s.checkpoints), Some(3));
    assert_eq!(report.staging_files, 1);
    Ok(())
}

/// Builds a correctly sealed HEAD record from raw fields, independently of the
/// crate, following the documented layout.
fn forge_head(scope_id: &[u8; 32], sequence: u64, checkpoint_id: &[u8; 32]) -> Vec<u8> {
    let mut unsealed = b"NQC-CENSUS-STORE".to_vec();
    unsealed.extend_from_slice(&1_u16.to_be_bytes());
    unsealed.push(0x06);
    let field = |out: &mut Vec<u8>, tag: u8, value: &[u8]| {
        out.push(tag);
        out.extend_from_slice(&(value.len() as u32).to_be_bytes());
        out.extend_from_slice(value);
    };
    field(&mut unsealed, 1, scope_id);
    field(&mut unsealed, 2, &sequence.to_be_bytes());
    field(&mut unsealed, 3, checkpoint_id);
    let seal = support::digest(&[b"NQC-CENSUS-STORE-HEAD-SEAL-V1", &[0], &unsealed]);
    let mut sealed = unsealed;
    field(&mut sealed, 4, &seal);
    sealed
}
