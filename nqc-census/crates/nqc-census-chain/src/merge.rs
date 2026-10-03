//! Merging RMC-004 stores produced by parallel acquisition partitions.
//!
//! Nothing is copied at the file level. Every stream of the source store is
//! certified by the source store, then its scope is registered and each
//! checkpoint is re-committed through the destination store's own `commit`,
//! after every evidence artifact has been re-put (content-addressed, so ids are
//! unchanged). Extra roots (unanchored job manifests) are copied with every
//! artifact they name. The destination therefore applies all RMC-004 checks
//! exactly as if it had acquired the data itself.

use crate::catalog::committed_checkpoints;
use crate::error::ChainError;
use crate::job::JOB_MANIFEST_SCHEMA;
use crate::json::Json;
use nqc_census_store::{ArtifactId, Store, StreamScope};

/// Counters of one merge; runtime metadata.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MergeReport {
    pub streams: u64,
    pub checkpoints: u64,
    pub artifacts: u64,
}

fn copy_artifact(source: &Store, destination: &Store, id: &ArtifactId) -> Result<(), ChainError> {
    let bytes = source.get_artifact(id)?;
    let put = destination.put_artifact(&bytes)?;
    if put.id != *id {
        return Err(ChainError::Evidence(
            "artifact identity changed while merging".into(),
        ));
    }
    Ok(())
}

fn source_scopes(source: &Store) -> Result<Vec<StreamScope>, ChainError> {
    let streams = source.root().join("streams");
    let mut scopes = Vec::new();
    let entries = match std::fs::read_dir(&streams) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(scopes),
        Err(error) => return Err(ChainError::Evidence(format!("list streams: {error}"))),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| ChainError::Evidence(format!("list streams: {error}")))?;
        names.push(entry.path());
    }
    names.sort();
    for path in names {
        let bytes = std::fs::read(path.join("SCOPE"))
            .map_err(|error| ChainError::Evidence(format!("{}: {error}", path.display())))?;
        let scope = StreamScope::decode(&bytes)?;
        if path.file_name().and_then(|name| name.to_str()) != Some(scope.id()?.to_hex().as_str()) {
            return Err(ChainError::Evidence(
                "stream directory does not match its scope".into(),
            ));
        }
        scopes.push(scope);
    }
    Ok(scopes)
}

/// Merges every certified stream of `source`, plus the job manifests in
/// `roots` and everything they reference, into `destination`.
pub fn merge_store(
    source: &Store,
    destination: &Store,
    roots: &[ArtifactId],
) -> Result<MergeReport, ChainError> {
    let mut report = MergeReport::default();
    for scope in source_scopes(source)? {
        let checkpoints = committed_checkpoints(source, &scope)?;
        destination.register_stream(&scope)?;
        let existing = committed_checkpoints(destination, &scope)?;
        for (index, checkpoint) in checkpoints.iter().enumerate() {
            for artifact in checkpoint.evidence() {
                copy_artifact(source, destination, artifact)?;
                report.artifacts += 1;
            }
            match existing.get(index) {
                Some(present) if present == checkpoint => {}
                Some(_) => {
                    return Err(ChainError::Evidence(
                        "destination holds a different checkpoint at this sequence".into(),
                    ))
                }
                None => {
                    destination.commit(&scope, checkpoint)?;
                }
            }
            report.checkpoints += 1;
        }
        report.streams += 1;
    }
    for root in roots {
        let manifest = source.get_artifact(root)?;
        let document = Json::parse(&manifest)?;
        if document.get("schema").and_then(Json::as_str) != Some(JOB_MANIFEST_SCHEMA) {
            return Err(ChainError::Evidence(
                "merge root is not a job manifest".into(),
            ));
        }
        let mut named = Vec::new();
        for exchange in document
            .get("exchanges")
            .and_then(Json::as_array)
            .unwrap_or_default()
        {
            named.push(exchange.str_field("request")?.to_owned());
            named.push(exchange.str_field("response")?.to_owned());
        }
        for observation in document
            .get("observations")
            .and_then(Json::as_array)
            .unwrap_or_default()
        {
            named.push(
                observation
                    .as_str()
                    .ok_or_else(|| ChainError::Evidence("observation ref".into()))?
                    .to_owned(),
            );
        }
        named.push(document.str_field("result")?.to_owned());
        for id in named {
            copy_artifact(source, destination, &ArtifactId::parse_hex(&id)?)?;
            report.artifacts += 1;
        }
        copy_artifact(source, destination, root)?;
        report.artifacts += 1;
    }
    Ok(report)
}
