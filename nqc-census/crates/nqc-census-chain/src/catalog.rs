//! Read access to committed RMC-004 checkpoints.
//!
//! RMC-004 exposes certification (`certify_range`) but no public reader for a
//! committed checkpoint's evidence. This module reads the catalog through its
//! documented on-disk layout (`streams/<scope>/checkpoints/<20-digit seq>`,
//! STORE_CONTRACT.md) and decodes each file with the public
//! `Checkpoint::decode`. It never writes, and it trusts nothing it reads until
//! the store itself has certified the whole chain and the decoded tip equals
//! the certificate's commitment.

use crate::error::ChainError;
use crate::job::JOB_MANIFEST_SCHEMA;
use crate::json::Json;
use nqc_census_store::{ArtifactId, Checkpoint, Store, StreamScope};

fn checkpoint_path(
    store: &Store,
    scope: &StreamScope,
    sequence: u64,
) -> Result<std::path::PathBuf, ChainError> {
    Ok(store
        .root()
        .join("streams")
        .join(scope.id()?.to_hex())
        .join("checkpoints")
        .join(format!("{sequence:020}")))
}

/// Every committed checkpoint of `scope`, in sequence order, certified by the
/// store. An unregistered or empty stream yields an empty list.
pub fn committed_checkpoints(
    store: &Store,
    scope: &StreamScope,
) -> Result<Vec<Checkpoint>, ChainError> {
    store.register_stream(scope)?;
    let resume = store.resume(scope)?;
    let Some(durable_through) = resume.durable_through else {
        return Ok(Vec::new());
    };
    let certificate = store.certify_range(scope, scope.origin_block(), durable_through)?;
    let mut checkpoints = Vec::new();
    for sequence in 0..resume.next_sequence {
        let path = checkpoint_path(store, scope, sequence)?;
        let bytes = std::fs::read(&path)
            .map_err(|error| ChainError::Evidence(format!("read {}: {error}", path.display())))?;
        let checkpoint = Checkpoint::decode(&bytes, scope)?;
        if checkpoint.sequence() != sequence {
            return Err(ChainError::Evidence("catalog sequence mismatch".into()));
        }
        checkpoints.push(checkpoint);
    }
    let tip = checkpoints
        .last()
        .ok_or_else(|| ChainError::Evidence("certified stream without checkpoints".into()))?;
    if tip.id()? != certificate.commitment {
        return Err(ChainError::Evidence(
            "decoded catalog tip differs from the certified commitment".into(),
        ));
    }
    Ok(checkpoints)
}

/// The job manifest among a checkpoint's evidence whose job descriptor equals
/// `descriptor`. Exactly one must exist.
pub fn manifest_of(
    store: &Store,
    checkpoint: &Checkpoint,
    descriptor: &Json,
) -> Result<ArtifactId, ChainError> {
    let expected = descriptor.canonical()?;
    let mut found = None;
    for artifact in checkpoint.evidence() {
        let bytes = store.get_artifact(artifact)?;
        if !bytes.starts_with(b"{\"exchanges\":[") {
            continue;
        }
        let Ok(document) = Json::parse(&bytes) else {
            continue;
        };
        if document.get("schema").and_then(Json::as_str) != Some(JOB_MANIFEST_SCHEMA) {
            continue;
        }
        match document.get("job").map(Json::canonical).transpose()? {
            Some(job) if job == expected => {}
            _ => continue,
        }
        if found.replace(*artifact).is_some() {
            return Err(ChainError::Evidence(
                "checkpoint names two manifests for one job".into(),
            ));
        }
    }
    found.ok_or_else(|| ChainError::Evidence("checkpoint has no manifest for this job".into()))
}
