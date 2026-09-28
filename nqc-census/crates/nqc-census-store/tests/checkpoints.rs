//! Append-only range chain: continuity, lineage, scope isolation, idempotent
//! retry, conflicting retry and range completion proofs.

mod support;

use nqc_census_store::verify::{verify_store, RangeRequirement, VerifyRequest};
use nqc_census_store::{Checkpoint, CommitOutcome, Store, StoreError, StreamScope};
use std::fs;
use support::{
    anchor, anchor_on, block_hash, chain_domain, commit_through, default_scope, deployment,
    files_under, next_checkpoint, put, range_payload, scope_on, small_config, stream_kind, TempDir,
    TestResult, ORIGIN,
};

fn open(label: &str) -> Result<(TempDir, Store, StreamScope), Box<dyn std::error::Error>> {
    let dir = TempDir::new(label)?;
    let store = Store::create(dir.path(), small_config()?)?;
    Ok((dir, store, default_scope()?))
}

#[test]
fn contiguous_checkpoints_commit_resume_and_certify() -> TestResult {
    let (dir, store, scope) = open("chain-ok")?;
    let ids = commit_through(&store, &scope, &[104, 109, 120, 121])?;
    let resume = store.resume(&scope)?;
    assert_eq!(resume.next_sequence, 4);
    assert_eq!(resume.next_first_block, 122);
    assert_eq!(resume.durable_through, Some(121));
    assert_eq!(resume.predecessor, ids.last().copied());
    assert_eq!(resume.expected_parent_hash, block_hash(0, 121)?);

    let certificate = store.certify_range(&scope, 100, 121)?;
    assert_eq!(certificate.first_sequence, 0);
    assert_eq!(certificate.last_sequence, 3);
    assert_eq!(Some(certificate.commitment), ids.last().copied());
    let inner = store.certify_range(&scope, 106, 110)?;
    assert_eq!((inner.first_sequence, inner.last_sequence), (1, 2));

    verify_store(
        dir.path(),
        &VerifyRequest {
            ranges: vec![RangeRequirement {
                scope_id: scope.id()?,
                first: 100,
                last: 121,
            }],
            tips: Vec::new(),
        },
    )?;
    Ok(())
}

#[test]
fn gap_after_predecessor_is_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-gap")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let evidence = put(&store, &range_payload(111, 115))?;
    // Starts at 111: block 110 would be silently skipped.
    let gapped = Checkpoint::next(
        &scope,
        &resume,
        anchor(&scope, 111)?,
        anchor(&scope, 115)?,
        vec![evidence],
    )?;
    assert!(matches!(
        store.commit(&scope, &gapped),
        Err(StoreError::Discontinuity {
            sequence: 1,
            reason: "range leaves a gap after predecessor"
        })
    ));
    assert_eq!(store.resume(&scope)?.next_sequence, 1);
    Ok(())
}

#[test]
fn overlap_with_predecessor_is_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-overlap")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let evidence = put(&store, &range_payload(109, 115))?;
    let overlapping = Checkpoint::next(
        &scope,
        &resume,
        anchor(&scope, 109)?,
        anchor(&scope, 115)?,
        vec![evidence],
    )?;
    assert!(matches!(
        store.commit(&scope, &overlapping),
        Err(StoreError::Discontinuity {
            reason: "range overlaps predecessor",
            ..
        })
    ));
    Ok(())
}

#[test]
fn sequence_jump_is_a_gap() -> TestResult {
    let (_dir, store, scope) = open("chain-jump")?;
    let ids = commit_through(&store, &scope, &[109])?;
    let evidence = put(&store, &range_payload(110, 119))?;
    let jumped = Checkpoint::new(
        &scope,
        2,
        ids.first().copied(),
        anchor(&scope, 110)?,
        anchor(&scope, 119)?,
        vec![evidence],
    )?;
    assert_eq!(
        store.commit(&scope, &jumped),
        Err(StoreError::SequenceGap { requested: 2 })
    );
    Ok(())
}

#[test]
fn wrong_predecessor_identity_is_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-wrong-pred")?;
    let ids = commit_through(&store, &scope, &[104, 109])?;
    let evidence = put(&store, &range_payload(110, 119))?;
    // Correct sequence and range, but names checkpoint 0 as predecessor.
    let wrong = Checkpoint::new(
        &scope,
        2,
        ids.first().copied(),
        anchor(&scope, 110)?,
        anchor(&scope, 119)?,
        vec![evidence],
    )?;
    assert_eq!(
        store.commit(&scope, &wrong),
        Err(StoreError::PredecessorMismatch { sequence: 2 })
    );
    Ok(())
}

#[test]
fn wrong_parent_lineage_is_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-fork")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let evidence = put(&store, &range_payload(110, 119))?;
    // Block 110 of a different fork: right number, wrong parent hash.
    let forked = Checkpoint::next(
        &scope,
        &resume,
        anchor_on(&scope, 1, 110)?,
        anchor_on(&scope, 1, 119)?,
        vec![evidence],
    )?;
    assert!(matches!(
        store.commit(&scope, &forked),
        Err(StoreError::Discontinuity {
            reason: "first parent hash does not extend predecessor last block",
            ..
        })
    ));
    Ok(())
}

#[test]
fn timestamp_regression_is_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-time")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let good = anchor(&scope, 110)?;
    let early = nqc_census_core::StateAnchor::new(
        scope.chain().clone(),
        110,
        good.block_hash(),
        good.parent_hash(),
        1,
        good.state_root(),
    )?;
    let evidence = put(&store, &range_payload(110, 110))?;
    let checkpoint = Checkpoint::next(&scope, &resume, early.clone(), early, vec![evidence])?;
    assert!(matches!(
        store.commit(&scope, &checkpoint),
        Err(StoreError::Discontinuity {
            reason: "timestamp regresses across checkpoints",
            ..
        })
    ));
    Ok(())
}

#[test]
fn genesis_must_start_at_scope_origin_and_parent() -> TestResult {
    let (_dir, store, scope) = open("chain-origin")?;
    let evidence = put(&store, &range_payload(101, 109))?;
    assert_eq!(
        Checkpoint::new(
            &scope,
            0,
            None,
            anchor(&scope, 101)?,
            anchor(&scope, 109)?,
            vec![evidence]
        ),
        Err(StoreError::InvalidCheckpoint(
            "sequence 0 must begin at the scope origin block and parent"
        ))
    );
    // Right block number, wrong lineage at the origin.
    let foreign_origin = nqc_census_core::StateAnchor::new(
        scope.chain().clone(),
        ORIGIN,
        block_hash(0, ORIGIN)?,
        block_hash(9, ORIGIN - 1)?,
        1_700_000_000,
        block_hash(0, 1)?,
    )?;
    assert!(Checkpoint::new(
        &scope,
        0,
        None,
        foreign_origin,
        anchor(&scope, 109)?,
        vec![evidence]
    )
    .is_err());
    Ok(())
}

#[test]
fn internally_inconsistent_ranges_are_rejected() -> TestResult {
    let (_dir, store, scope) = open("chain-internal")?;
    let evidence = put(&store, &range_payload(100, 101))?;
    // inverted
    assert!(Checkpoint::new(
        &scope,
        0,
        None,
        anchor(&scope, 100)?,
        anchor(&scope, 99)?,
        vec![evidence]
    )
    .is_err());
    // adjacent anchors that do not link parent to child
    assert_eq!(
        Checkpoint::new(
            &scope,
            0,
            None,
            anchor(&scope, 100)?,
            anchor_on(&scope, 3, 101)?,
            vec![evidence]
        ),
        Err(StoreError::InvalidCheckpoint(
            "adjacent anchors do not link parent to child"
        ))
    );
    // single-block range whose two anchors disagree
    assert!(Checkpoint::new(
        &scope,
        0,
        None,
        anchor(&scope, 100)?,
        anchor_on(&scope, 3, 100)?,
        vec![evidence]
    )
    .is_err());
    // no evidence, and predecessor presence must match sequence 0
    assert!(Checkpoint::new(
        &scope,
        0,
        None,
        anchor(&scope, 100)?,
        anchor(&scope, 101)?,
        vec![]
    )
    .is_err());
    assert!(Checkpoint::new(
        &scope,
        1,
        None,
        anchor(&scope, 100)?,
        anchor(&scope, 101)?,
        vec![evidence]
    )
    .is_err());
    Ok(())
}

#[test]
fn checkpoint_for_another_scope_cannot_be_committed() -> TestResult {
    let (_dir, store, scope) = open("chain-scope")?;
    let other = scope_on(chain_domain(0x22)?, 7)?;
    let resume = store.resume(&other)?;
    let checkpoint = next_checkpoint(&store, &other, &resume, 109)?;
    assert_eq!(
        store.commit(&scope, &checkpoint),
        Err(StoreError::ScopeMismatch)
    );
    // Anchors on a different chain domain than the scope are rejected too.
    let foreign_chain = scope_on(chain_domain(0x23)?, 1)?;
    let evidence = put(&store, &range_payload(100, 109))?;
    assert_eq!(
        Checkpoint::new(
            &scope,
            0,
            None,
            anchor(&foreign_chain, 100)?,
            anchor(&foreign_chain, 109)?,
            vec![evidence]
        ),
        Err(StoreError::ScopeMismatch)
    );
    Ok(())
}

#[test]
fn scope_identity_separates_every_lineage_dimension() -> TestResult {
    let chain = chain_domain(0x22)?;
    let base = StreamScope::new(
        chain.clone(),
        None,
        stream_kind(1)?,
        ORIGIN,
        block_hash(0, ORIGIN - 1)?,
    )?;
    let variants = [
        // other fork lineage, same chain id and genesis
        StreamScope::new(
            chain_domain(0x23)?,
            None,
            stream_kind(1)?,
            ORIGIN,
            block_hash(0, ORIGIN - 1)?,
        )?,
        // deployment-scoped, and two different deployment instances
        StreamScope::new(
            chain.clone(),
            Some(deployment(&chain, 0x52)?),
            stream_kind(1)?,
            ORIGIN,
            block_hash(0, ORIGIN - 1)?,
        )?,
        StreamScope::new(
            chain.clone(),
            Some(deployment(&chain, 0x53)?),
            stream_kind(1)?,
            ORIGIN,
            block_hash(0, ORIGIN - 1)?,
        )?,
        // other stream semantics
        StreamScope::new(
            chain.clone(),
            None,
            stream_kind(2)?,
            ORIGIN,
            block_hash(0, ORIGIN - 1)?,
        )?,
        // other origin block / origin parent
        StreamScope::new(
            chain.clone(),
            None,
            stream_kind(1)?,
            ORIGIN + 1,
            block_hash(0, ORIGIN)?,
        )?,
        StreamScope::new(
            chain.clone(),
            None,
            stream_kind(1)?,
            ORIGIN,
            block_hash(5, ORIGIN - 1)?,
        )?,
    ];
    let mut ids = vec![base.id()?];
    for variant in &variants {
        ids.push(variant.id()?);
        assert_eq!(StreamScope::decode(&variant.canonical_bytes()?)?, *variant);
    }
    let unique: std::collections::BTreeSet<_> = ids.iter().collect();
    assert_eq!(unique.len(), ids.len(), "scope identities collide");

    // A deployment on another chain domain cannot be scoped to this chain.
    let other_chain = chain_domain(0x24)?;
    assert!(StreamScope::new(
        chain,
        Some(deployment(&other_chain, 0x52)?),
        stream_kind(1)?,
        ORIGIN,
        block_hash(0, ORIGIN - 1)?,
    )
    .is_err());
    Ok(())
}

#[test]
fn exact_retry_is_idempotent() -> TestResult {
    let (dir, store, scope) = open("retry-exact")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let checkpoint = next_checkpoint(&store, &scope, &resume, 119)?;
    let created = store.commit(&scope, &checkpoint)?;
    assert!(matches!(created, CommitOutcome::Created(_)));
    let files = files_under(dir.path())?;
    for _ in 0..3 {
        assert_eq!(
            store.commit(&scope, &checkpoint)?,
            CommitOutcome::AlreadyCommitted(created.id())
        );
    }
    assert_eq!(files_under(dir.path())?, files);
    assert_eq!(store.resume(&scope)?.next_sequence, 2);
    Ok(())
}

#[test]
fn same_sequence_with_different_content_is_a_hard_conflict() -> TestResult {
    let (_dir, store, scope) = open("retry-conflict")?;
    commit_through(&store, &scope, &[109])?;
    let resume = store.resume(&scope)?;
    let committed = next_checkpoint(&store, &scope, &resume, 119)?;
    store.commit(&scope, &committed)?;
    let path = support::checkpoint_path(&store, &scope, 1)?;
    let bytes = fs::read(&path)?;

    // Same sequence and predecessor, different range end and evidence.
    let conflicting = next_checkpoint(&store, &scope, &resume, 118)?;
    for _ in 0..3 {
        assert_eq!(
            store.commit(&scope, &conflicting),
            Err(StoreError::SequenceConflict { sequence: 1 })
        );
    }
    // Same range, different evidence set.
    let extra = put(&store, b"SYNTHETIC-RMC004 extra evidence")?;
    let mut evidence = committed.evidence().to_vec();
    evidence.push(extra);
    let different_evidence = Checkpoint::next(
        &scope,
        &resume,
        committed.first().clone(),
        committed.last().clone(),
        evidence,
    )?;
    assert_eq!(
        store.commit(&scope, &different_evidence),
        Err(StoreError::SequenceConflict { sequence: 1 })
    );
    assert_eq!(fs::read(&path)?, bytes, "committed checkpoint was modified");
    Ok(())
}

#[test]
fn checkpoint_with_absent_evidence_is_refused() -> TestResult {
    let (_dir, store, scope) = open("chain-no-evidence")?;
    let resume = store.resume(&scope)?;
    let phantom = nqc_census_store::ArtifactId::of(b"never stored");
    let checkpoint = Checkpoint::next(
        &scope,
        &resume,
        anchor(&scope, 100)?,
        anchor(&scope, 109)?,
        vec![phantom],
    )?;
    assert!(matches!(
        store.commit(&scope, &checkpoint),
        Err(StoreError::ArtifactMissing(_))
    ));
    assert_eq!(store.resume(&scope)?.next_sequence, 0);
    Ok(())
}

#[test]
fn partial_history_cannot_certify_a_larger_range() -> TestResult {
    let (dir, store, scope) = open("range-partial")?;
    commit_through(&store, &scope, &[104, 109])?;
    // 100..=109 is durable.
    store.certify_range(&scope, 100, 109)?;
    // 100..=110 is not: must fail, never round to "complete".
    assert_eq!(
        store.certify_range(&scope, 100, 110),
        Err(StoreError::RangeIncomplete {
            requested_last: 110,
            covered_last: Some(109)
        })
    );
    assert!(matches!(
        store.certify_range(&scope, 95, 105),
        Err(StoreError::RangeBeforeOrigin { .. })
    ));
    assert_eq!(
        store.certify_range(&scope, 105, 104),
        Err(StoreError::RangeInvalid)
    );
    let unregistered = scope_on(chain_domain(0x22)?, 9)?;
    assert!(matches!(
        store.certify_range(&unregistered, 100, 100),
        Err(StoreError::RangeIncomplete {
            covered_last: None,
            ..
        })
    ));

    let scope_id = scope.id()?;
    let require = |first, last| VerifyRequest {
        ranges: vec![RangeRequirement {
            scope_id,
            first,
            last,
        }],
        tips: Vec::new(),
    };
    verify_store(dir.path(), &require(100, 109))?;
    let failure = verify_store(dir.path(), &require(100, 110))
        .err()
        .ok_or("partial range certified offline")?;
    assert_eq!(
        failure.error,
        StoreError::RangeIncomplete {
            requested_last: 110,
            covered_last: Some(109)
        }
    );
    Ok(())
}
