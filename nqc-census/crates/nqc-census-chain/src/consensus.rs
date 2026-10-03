//! Cross-provider agreement.
//!
//! Agreement is byte equality of provider-independent canonical results.
//! There is no voting: any disagreement becomes a mismatch-ledger entry and
//! the dependent claim fails closed until it is explained with evidence.

use crate::error::ChainError;
use crate::hex;
use crate::json::Json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

/// One provider's canonical result for a logical read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderResult {
    pub provider: String,
    pub manifest: String,
    pub result: Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Agreement {
    pub subject: String,
    pub result: Json,
    pub result_sha256: String,
    pub providers: Vec<String>,
    pub manifests: Vec<String>,
}

/// Machine-readable disagreement record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub subject: String,
    pub reason: &'static str,
    pub per_provider: BTreeMap<String, String>,
    pub detail: Json,
}

impl Mismatch {
    pub fn record(&self) -> Json {
        Json::object([
            ("category", Json::string("PROVIDER_MISMATCH")),
            ("subject", Json::string(self.subject.clone())),
            ("reason", Json::string(self.reason)),
            (
                "per_provider_sha256",
                Json::object(
                    self.per_provider
                        .iter()
                        .map(|(provider, digest)| (provider.clone(), Json::string(digest.clone()))),
                ),
            ),
            ("detail", self.detail.clone()),
            ("status", Json::string("UNEXPLAINED")),
        ])
    }
}

fn digest(value: &Json) -> Result<String, ChainError> {
    Ok(hex::plain(&Sha256::digest(value.canonical()?)))
}

/// Requires at least two providers and byte-identical canonical results.
pub fn agree(
    subject: &str,
    results: &[ProviderResult],
) -> Result<Result<Agreement, Mismatch>, ChainError> {
    if results.len() < 2 {
        return Err(ChainError::Consensus(
            "agreement requires at least two providers",
        ));
    }
    let mut per_provider = BTreeMap::new();
    for result in results {
        if per_provider
            .insert(result.provider.clone(), digest(&result.result)?)
            .is_some()
        {
            return Err(ChainError::Consensus("a provider answered twice"));
        }
    }
    let distinct: BTreeSet<&String> = per_provider.values().collect();
    if distinct.len() != 1 {
        return Ok(Err(Mismatch {
            subject: subject.to_owned(),
            reason: "RESULTS_DIFFER",
            per_provider,
            detail: Json::Null,
        }));
    }
    let first = &results[0];
    Ok(Ok(Agreement {
        subject: subject.to_owned(),
        result: first.result.clone(),
        result_sha256: digest(&first.result)?,
        providers: results.iter().map(|r| r.provider.clone()).collect(),
        manifests: results.iter().map(|r| r.manifest.clone()).collect(),
    }))
}

/// Compares per-provider log sets keyed by their coordinates. Returns the
/// agreed logs, or the exact coordinates that differ.
pub fn agree_logs(
    subject: &str,
    per_provider: &[(String, Vec<Json>)],
) -> Result<Result<Vec<Json>, Mismatch>, ChainError> {
    if per_provider.len() < 2 {
        return Err(ChainError::Consensus(
            "agreement requires at least two providers",
        ));
    }
    let key = |log: &Json| -> Result<(u64, u64), ChainError> {
        let number = |name: &str| {
            log.get(name)
                .and_then(Json::as_i64)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or(ChainError::Consensus("log without coordinates"))
        };
        Ok((number("block")?, number("log_index")?))
    };
    let mut maps = Vec::with_capacity(per_provider.len());
    for (provider, logs) in per_provider {
        let mut map = BTreeMap::new();
        for log in logs {
            if map.insert(key(log)?, log.clone()).is_some() {
                return Err(ChainError::Consensus(
                    "duplicate log coordinates from one provider",
                ));
            }
        }
        maps.push((provider.clone(), map));
    }
    let coordinates: BTreeSet<(u64, u64)> = maps
        .iter()
        .flat_map(|(_, map)| map.keys().copied())
        .collect();
    let mut differing = Vec::new();
    for coordinate in &coordinates {
        let values: BTreeSet<Option<String>> = maps
            .iter()
            .map(|(_, map)| map.get(coordinate).map(digest).transpose())
            .collect::<Result<_, _>>()?;
        if values.len() != 1 || values.contains(&None) {
            differing.push(Json::object([
                ("block", Json::uint(coordinate.0)),
                ("log_index", Json::uint(coordinate.1)),
                (
                    "present_at",
                    Json::array(
                        maps.iter()
                            .filter(|(_, map)| map.contains_key(coordinate))
                            .map(|(provider, _)| Json::string(provider.clone())),
                    ),
                ),
            ]));
        }
    }
    if !differing.is_empty() {
        let mut summary = BTreeMap::new();
        for (provider, logs) in per_provider {
            summary.insert(provider.clone(), digest(&Json::Array(logs.clone()))?);
        }
        return Ok(Err(Mismatch {
            subject: subject.to_owned(),
            reason: "LOG_SETS_DIFFER",
            per_provider: summary,
            detail: Json::Array(differing),
        }));
    }
    let (_, first) = &maps[0];
    Ok(Ok(first.values().cloned().collect()))
}
