//! Racing writers. Each thread opens its own `Store` instance, as a separate
//! process would; all of them start together on a barrier. Correctness comes
//! from no-replace `link(2)` publication, not from locks.

mod support;

use nqc_census_store::verify::{verify_store, VerifyRequest};
use nqc_census_store::{Checkpoint, CommitOutcome, Store, StoreError, StreamScope};
use std::sync::{Arc, Barrier};
use std::thread;
use support::{
    abi_like, anchor, commit_through, default_scope, files_under, next_checkpoint, noise, put,
    range_payload, small_config, TempDir, TestResult,
};

const WRITERS: usize = 8;
const ROUNDS: usize = 5;

fn race<T, F>(
    root: &std::path::Path,
    work: F,
) -> Result<Vec<Result<T, StoreError>>, Box<dyn std::error::Error>>
where
    T: Send + 'static,
    F: Fn(usize, &Store) -> Result<T, StoreError> + Send + Sync + 'static,
{
    let barrier = Arc::new(Barrier::new(WRITERS));
    let work = Arc::new(work);
    let mut handles = Vec::new();
    for writer in 0..WRITERS {
        let store = Store::open(root, &small_config()?)?;
        let barrier = Arc::clone(&barrier);
        let work = Arc::clone(&work);
        handles.push(thread::spawn(move || {
            barrier.wait();
            work(writer, &store)
        }));
    }
    let mut results = Vec::new();
    for handle in handles {
        results.push(handle.join().map_err(|_| "writer thread panicked")?);
    }
    Ok(results)
}

#[test]
fn same_artifact_writers_converge_on_one_object_set() -> TestResult {
    for round in 0..ROUNDS {
        let dir = TempDir::new(&format!("race-artifact-{round}"))?;
        Store::create(dir.path(), small_config()?)?;
        let bytes = Arc::new(abi_like(40_000, round as u64));
        let shared = Arc::clone(&bytes);
        let results = race(dir.path(), move |_, store| {
            store.put_artifact(&shared).map(|report| report.id)
        })?;
        let ids: Vec<_> = results.into_iter().collect::<Result<_, _>>()?;
        assert!(ids.windows(2).all(|pair| pair[0] == pair[1]));
        let store = Store::open(dir.path(), &small_config()?)?;
        assert_eq!(store.get_artifact(&ids[0])?, *bytes);
        assert_eq!(files_under(&dir.join("objects/artifacts"))?.len(), 1);
        let report = verify_store(dir.path(), &VerifyRequest::default())?;
        assert_eq!(
            report.staging_files, 0,
            "a racing writer leaked staging files"
        );
    }
    Ok(())
}

#[test]
fn same_checkpoint_same_bytes_has_one_creator_and_idempotent_rest() -> TestResult {
    for round in 0..ROUNDS {
        let dir = TempDir::new(&format!("race-same-cp-{round}"))?;
        let store = Store::create(dir.path(), small_config()?)?;
        let scope = default_scope()?;
        commit_through(&store, &scope, &[109])?;
        let resume = store.resume(&scope)?;
        let checkpoint = Arc::new(next_checkpoint(&store, &scope, &resume, 119)?);
        let shared = Arc::clone(&checkpoint);
        let shared_scope = scope.clone();
        let results = race(dir.path(), move |_, store| {
            store.commit(&shared_scope, &shared)
        })?;
        let outcomes: Vec<_> = results.into_iter().collect::<Result<_, _>>()?;
        let expected = checkpoint.id()?;
        let created = outcomes
            .iter()
            .filter(|outcome| matches!(outcome, CommitOutcome::Created(_)))
            .count();
        assert_eq!(created, 1, "exactly one writer creates the checkpoint");
        assert!(outcomes.iter().all(|outcome| outcome.id() == expected));
        assert_eq!(store.resume(&scope)?.next_sequence, 2);
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn same_sequence_different_bytes_has_exactly_one_winner() -> TestResult {
    for round in 0..ROUNDS {
        let dir = TempDir::new(&format!("race-conflict-{round}"))?;
        let store = Store::create(dir.path(), small_config()?)?;
        let scope = default_scope()?;
        commit_through(&store, &scope, &[109])?;
        let resume = store.resume(&scope)?;
        // Every writer proposes a different sequence-1 checkpoint.
        let mut proposals = Vec::new();
        for writer in 0..WRITERS {
            proposals.push(next_checkpoint(
                &store,
                &scope,
                &resume,
                111 + writer as u64,
            )?);
        }
        let proposals = Arc::new(proposals);
        let shared = Arc::clone(&proposals);
        let shared_scope = scope.clone();
        let results = race(dir.path(), move |writer, store| {
            store.commit(&shared_scope, &shared[writer])
        })?;
        let mut winners = Vec::new();
        for (writer, result) in results.iter().enumerate() {
            match result {
                Ok(CommitOutcome::Created(_)) => winners.push(writer),
                Err(StoreError::SequenceConflict { sequence: 1 }) => {}
                other => return Err(format!("writer {writer}: unexpected {other:?}").into()),
            }
        }
        assert_eq!(winners.len(), 1, "round {round}: winners {winners:?}");
        let winner = &proposals[winners[0]];
        let recovered = store.resume(&scope)?;
        assert_eq!(recovered.predecessor, Some(winner.id()?));
        assert_eq!(recovered.durable_through, Some(winner.last_block()));
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn adjacent_sequence_races_never_fork_or_skip() -> TestResult {
    for round in 0..ROUNDS {
        let dir = TempDir::new(&format!("race-adjacent-{round}"))?;
        let store = Store::create(dir.path(), small_config()?)?;
        let scope = default_scope()?;
        commit_through(&store, &scope, &[109])?;
        let resume = store.resume(&scope)?;
        // Two competing lineages for sequences 1 and 2: A = (110..=114, 115..=119)
        // and B = (110..=116, 117..=119). Half the writers push A, half push B,
        // each committing its sequence 1 then its sequence 2.
        let a1 = next_checkpoint(&store, &scope, &resume, 114)?;
        let b1 = next_checkpoint(&store, &scope, &resume, 116)?;
        let second = |first: &Checkpoint| -> Result<Checkpoint, Box<dyn std::error::Error>> {
            let after = nqc_census_store::ResumePoint {
                scope_id: scope.id()?,
                next_sequence: 2,
                predecessor: Some(first.id()?),
                next_first_block: first.last_block() + 1,
                expected_parent_hash: first.last().block_hash(),
                min_timestamp: first.last().timestamp(),
                durable_through: Some(first.last_block()),
            };
            let evidence = put(&store, &range_payload(after.next_first_block, 119))?;
            Ok(Checkpoint::next(
                &scope,
                &after,
                anchor(&scope, after.next_first_block)?,
                anchor(&scope, 119)?,
                vec![evidence],
            )?)
        };
        let lineages = Arc::new([(a1.clone(), second(&a1)?), (b1.clone(), second(&b1)?)]);
        let shared = Arc::clone(&lineages);
        let shared_scope: StreamScope = scope.clone();
        let results = race(dir.path(), move |writer, store| {
            let (first, next) = &shared[writer % 2];
            let one = store.commit(&shared_scope, first);
            let two = store.commit(&shared_scope, next);
            Ok((one, two))
        })?;
        for result in results {
            let (one, two) = result?;
            match (one, two) {
                (Ok(_), Ok(_)) => {}
                (Err(StoreError::SequenceConflict { sequence: 1 }), Err(error)) => {
                    // The losing lineage can never attach its sequence 2.
                    assert!(
                        matches!(
                            error,
                            StoreError::PredecessorMismatch { sequence: 2 }
                                | StoreError::SequenceConflict { sequence: 2 }
                        ),
                        "unexpected {error:?}"
                    );
                }
                other => return Err(format!("unexpected outcome {other:?}").into()),
            }
        }
        let recovered = store.recover(&scope, nqc_census_store::RecoveryMode::Full)?;
        assert_eq!(recovered.resume.next_sequence, 3);
        assert_eq!(recovered.resume.durable_through, Some(119));
        store.certify_range(&scope, 100, 119)?;
        verify_store(dir.path(), &VerifyRequest::default())?;
    }
    Ok(())
}

#[test]
fn distinct_artifacts_race_without_interference() -> TestResult {
    let dir = TempDir::new("race-distinct")?;
    Store::create(dir.path(), small_config()?)?;
    let results = race(dir.path(), |writer, store| {
        let bytes = noise(20_000, 1000 + writer as u64);
        let report = store.put_artifact(&bytes)?;
        let back = store.get_artifact(&report.id)?;
        Ok(back == bytes)
    })?;
    for result in results {
        assert!(result?);
    }
    let report = verify_store(dir.path(), &VerifyRequest::default())?;
    assert_eq!(report.artifacts, WRITERS as u64);
    Ok(())
}
