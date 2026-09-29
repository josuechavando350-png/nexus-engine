//! Offline crash/resume equivalence of the history reconstruction.
//!
//! The replay transport is rebuilt only from the job manifests the live run
//! recorded; nothing else can answer. The whole reconstruction then runs into
//! a fresh RMC-004 store, and again into fresh stores that are crashed after a
//! fixed number of requests and resumed. Every run must reproduce the live
//! report byte-for-byte and the same store evidence root.

use crate::history::{history_with, HistoryPlan};
use nqc_census_chain::{
    acquire::Acquisition,
    job::add_manifest_exchanges,
    json::Json,
    provider::ProviderSet,
    transport::{InterruptAfter, ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_store::{verify, ArtifactId, Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;

pub const RESUME_SCHEMA: &str = "nqc-rmc-006-aave-resume-equivalence-v1";

/// Replay transport over exactly the exchanges `history` names.
pub fn replay_transport(
    store: &Store,
    providers: &ProviderSet,
    history: &Json,
) -> Result<(ReplayTransport, u64), ChainError> {
    let mut replay = ReplayTransport::new();
    let mut manifests = 0_u64;
    for id in history
        .get("replay_manifests")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("history report lists no replay manifests".into()))?
    {
        let id = ArtifactId::parse_hex(
            id.as_str()
                .ok_or_else(|| ChainError::Evidence("replay manifest id is not text".into()))?,
        )?;
        let bytes = store.get_artifact(&id)?;
        let manifest = Json::parse(&bytes)?;
        let descriptor = manifest
            .get("job")
            .and_then(|job| job.get("provider"))
            .ok_or_else(|| ChainError::Evidence("manifest names no provider".into()))?;
        let mut owner = None;
        for provider in providers.iter() {
            if provider.descriptor().same_as(descriptor)? {
                owner = Some(provider);
            }
        }
        let provider = owner.ok_or_else(|| {
            ChainError::Evidence("manifest provider is not in the declared provider set".into())
        })?;
        add_manifest_exchanges(&mut replay, store, &bytes, provider)?;
        manifests += 1;
    }
    Ok((replay, manifests))
}

/// A request the live run recorded more than once with different response
/// bytes. A replay transport keyed by request can serve only one of them, so
/// the job that saw the other cannot be reproduced from a whole-run replay.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExchangeConflict {
    pub namespace: u16,
    pub method: String,
    pub manifests: [String; 2],
    pub lengths: [usize; 2],
    pub first_difference: usize,
    pub excerpts: [String; 2],
}

impl ExchangeConflict {
    pub fn json(&self) -> Json {
        Json::object([
            ("namespace", Json::uint(u64::from(self.namespace))),
            ("method", Json::string(self.method.clone())),
            (
                "manifests",
                Json::array(self.manifests.iter().map(|m| Json::string(m.clone()))),
            ),
            (
                "lengths",
                Json::array(self.lengths.iter().map(|l| Json::uint(*l as u64))),
            ),
            ("first_difference", Json::uint(self.first_difference as u64)),
            (
                "excerpts",
                Json::array(self.excerpts.iter().map(|e| Json::string(e.clone()))),
            ),
        ])
    }
}

fn methods(request: &[u8]) -> String {
    let Ok(value) = Json::parse(request) else {
        return "UNPARSEABLE".into();
    };
    let items = match &value {
        Json::Array(items) => items.clone(),
        other => vec![other.clone()],
    };
    let mut names: Vec<String> = items
        .iter()
        .filter_map(|item| item.get("method").and_then(Json::as_str).map(str::to_owned))
        .collect();
    names.sort();
    names.dedup();
    format!("{}x{}", items.len(), names.join("+"))
}

fn excerpt(bytes: &[u8], at: usize) -> String {
    let start = at.saturating_sub(60);
    let end = (at + 60).min(bytes.len());
    String::from_utf8_lossy(&bytes[start..end]).into_owned()
}

/// Every request `history`'s manifests recorded more than once with
/// different responses, per provider namespace.
pub fn exchange_conflicts(
    store: &Store,
    providers: &ProviderSet,
    history: &Json,
) -> Result<Vec<ExchangeConflict>, ChainError> {
    let mut seen: BTreeMap<(u16, [u8; 32]), (Vec<u8>, String)> = BTreeMap::new();
    let mut conflicts = Vec::new();
    for id in history
        .get("replay_manifests")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("history report lists no replay manifests".into()))?
    {
        let id = id
            .as_str()
            .ok_or_else(|| ChainError::Evidence("replay manifest id is not text".into()))?;
        let manifest = Json::parse(&store.get_artifact(&ArtifactId::parse_hex(id)?)?)?;
        let descriptor = manifest
            .get("job")
            .and_then(|job| job.get("provider"))
            .ok_or_else(|| ChainError::Evidence("manifest names no provider".into()))?;
        let mut namespace = None;
        for provider in providers.iter() {
            if provider.descriptor().same_as(descriptor)? {
                namespace = Some(provider.namespace());
            }
        }
        let namespace = namespace.ok_or_else(|| {
            ChainError::Evidence("manifest provider is not in the declared provider set".into())
        })?;
        for exchange in manifest
            .get("exchanges")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("manifest without exchanges".into()))?
        {
            let fetch = |key: &str| -> Result<Vec<u8>, ChainError> {
                Ok(store.get_artifact(&ArtifactId::parse_hex(exchange.str_field(key)?)?)?)
            };
            let (request, response) = (fetch("request")?, fetch("response")?);
            let key = (namespace, Sha256::digest(&request).into());
            match seen.get(&key) {
                None => {
                    seen.insert(key, (response, id.to_owned()));
                }
                Some((earlier, _)) if *earlier == response => {}
                Some((earlier, earlier_manifest)) => {
                    let first_difference = earlier
                        .iter()
                        .zip(&response)
                        .position(|(a, b)| a != b)
                        .unwrap_or_else(|| earlier.len().min(response.len()));
                    conflicts.push(ExchangeConflict {
                        namespace,
                        method: methods(&request),
                        manifests: [earlier_manifest.clone(), id.to_owned()],
                        lengths: [earlier.len(), response.len()],
                        first_difference,
                        excerpts: [
                            excerpt(earlier, first_difference),
                            excerpt(&response, first_difference),
                        ],
                    });
                }
            }
        }
    }
    Ok(conflicts)
}

/// JSON paths where `live` and `replayed` differ (at most `limit`).
pub fn json_differences(live: &Json, replayed: &Json, limit: usize) -> Vec<String> {
    fn short(value: &Json) -> String {
        let text = value.canonical_string().unwrap_or_default();
        if text.len() > 120 {
            format!("{}...", &text[..120])
        } else {
            text
        }
    }
    fn walk(a: &Json, b: &Json, path: &str, out: &mut Vec<String>, limit: usize) {
        if out.len() >= limit || a == b {
            return;
        }
        match (a, b) {
            (Json::Object(x), Json::Object(y)) => {
                let keys: std::collections::BTreeSet<&str> = x
                    .iter()
                    .chain(y.iter())
                    .map(|(key, _)| key.as_str())
                    .collect();
                for key in keys {
                    let child = format!("{path}.{key}");
                    match (a.get(key), b.get(key)) {
                        (Some(left), Some(right)) => walk(left, right, &child, out, limit),
                        (Some(_), None) => out.push(format!("{child}: only live")),
                        (None, Some(_)) => out.push(format!("{child}: only replayed")),
                        (None, None) => {}
                    }
                    if out.len() >= limit {
                        return;
                    }
                }
            }
            (Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
                for (index, (left, right)) in x.iter().zip(y).enumerate() {
                    walk(left, right, &format!("{path}[{index}]"), out, limit);
                }
            }
            _ => out.push(format!("{path}: live={} replayed={}", short(a), short(b))),
        }
    }
    let mut out = Vec::new();
    walk(live, replayed, "$", &mut out, limit);
    out
}

fn evidence_root(path: &Path) -> Result<String, ChainError> {
    let report = verify::verify_store(
        path,
        &verify::VerifyRequest {
            ranges: Vec::new(),
            tips: Vec::new(),
        },
    )
    .map_err(|failure| ChainError::Evidence(format!("store verification failed: {failure:?}")))?;
    Ok(report.evidence_root)
}

fn replay_run(
    path: &Path,
    transport: &dyn nqc_census_chain::transport::Transport,
    providers: &ProviderSet,
    plan: &HistoryPlan,
    current: &Json,
) -> Result<Json, ChainError> {
    let store = Store::create(path, StoreConfig::standard())?;
    history_with(
        &Acquisition::new(&store, transport, RetryPolicy::none()),
        providers,
        plan,
        current,
    )
}

/// Runs the equivalence matrix under `work`, which must not exist.
pub fn resume_check(
    live_store: &Store,
    providers: &ProviderSet,
    plan: &HistoryPlan,
    current: &Json,
    history: &Json,
    work: &Path,
) -> Result<Json, ChainError> {
    let (replay, manifests) = replay_transport(live_store, providers, history)?;
    let exchanges = replay.len() as u64;
    if exchanges < 3 {
        return Err(ChainError::Evidence(
            "too few recorded exchanges to interrupt".into(),
        ));
    }
    std::fs::create_dir(work)
        .map_err(|error| ChainError::Config(format!("{}: {error}", work.display())))?;

    let clean = work.join("clean");
    let replayed = replay_run(&clean, &replay, providers, plan, current)?;
    if !replayed.same_as(history)? {
        // Say exactly why: requests recorded with conflicting responses (a
        // provider answering the same request differently in two jobs), and
        // where the reports differ. The detail is also kept on disk.
        let conflicts = exchange_conflicts(live_store, providers, history)?;
        let differences = json_differences(history, &replayed, 40);
        let diagnostics = Json::object([
            (
                "exchange_conflicts",
                Json::array(conflicts.iter().map(ExchangeConflict::json)),
            ),
            (
                "report_differences",
                Json::array(differences.iter().map(|d| Json::string(d.clone()))),
            ),
            ("replayed_report", replayed.clone()),
        ]);
        let _ = std::fs::write(
            work.join("replay-diagnostics.json"),
            diagnostics.canonical()?,
        );
        let sample: Vec<String> = conflicts
            .iter()
            .take(5)
            .map(|conflict| conflict.json().canonical_string().unwrap_or_default())
            .collect();
        return Err(ChainError::Evidence(format!(
            "offline replay does not reproduce the live history report; conflicting recorded exchanges={} sample={sample:?}; differing paths ({}): {}",
            conflicts.len(),
            differences.len(),
            differences.join(" | ")
        )));
    }
    let clean_root = evidence_root(&clean)?;

    let mut cuts = vec![
        1,
        exchanges / 3,
        exchanges / 2,
        (2 * exchanges) / 3,
        exchanges - 1,
    ];
    cuts.sort_unstable();
    cuts.dedup();
    let mut interruptions = Vec::with_capacity(cuts.len());
    for cut in cuts {
        let path = work.join(format!("interrupted-{cut}"));
        let crashed = InterruptAfter::new(&replay, cut);
        if replay_run(&path, &crashed, providers, plan, current).is_ok() {
            return Err(ChainError::Evidence(format!(
                "a run interrupted after {cut} requests still completed"
            )));
        }
        let resumed = replay_run(&path, &replay, providers, plan, current)?;
        if !resumed.same_as(history)? {
            return Err(ChainError::Evidence(format!(
                "resume after interruption at {cut} differs from the live report"
            )));
        }
        let root = evidence_root(&path)?;
        if root != clean_root {
            return Err(ChainError::Evidence(format!(
                "resume after interruption at {cut} produced a different evidence root"
            )));
        }
        interruptions.push(Json::object([
            ("interrupted_after_requests", Json::uint(cut)),
            ("resumed_report_identical", Json::Bool(true)),
            ("evidence_root", Json::string(root)),
        ]));
    }
    Ok(Json::object([
        ("schema", Json::string(RESUME_SCHEMA)),
        ("status", Json::string("RESUME_EQUIVALENCE_PASS")),
        ("replay_manifests", Json::uint(manifests)),
        ("recorded_exchanges", Json::uint(exchanges)),
        ("clean_replay_report_identical", Json::Bool(true)),
        ("clean_evidence_root", Json::string(clean_root)),
        ("interruptions", Json::Array(interruptions)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn differences_name_the_paths_that_differ() -> Result<(), ChainError> {
        let live = Json::parse(br#"{"a":1,"b":[1,2,3],"c":{"d":"x"},"e":true}"#)?;
        let replayed = Json::parse(br#"{"a":1,"b":[1,5,3],"c":{"d":"y","f":0}}"#)?;
        assert_eq!(
            json_differences(&live, &replayed, 10),
            vec![
                "$.b[1]: live=2 replayed=5".to_owned(),
                "$.c.d: live=\"x\" replayed=\"y\"".to_owned(),
                "$.c.f: only replayed".to_owned(),
                "$.e: only live".to_owned(),
            ]
        );
        assert!(json_differences(&live, &live, 10).is_empty());
        assert_eq!(json_differences(&live, &replayed, 1).len(), 1);
        Ok(())
    }

    #[test]
    fn request_methods_are_summarized() {
        assert_eq!(
            methods(br#"[{"id":1,"method":"eth_getLogs"},{"id":2,"method":"eth_getLogs"}]"#),
            "2xeth_getLogs"
        );
        assert_eq!(
            methods(br#"{"id":1,"method":"eth_chainId"}"#),
            "1xeth_chainId"
        );
        assert_eq!(methods(b"not json"), "UNPARSEABLE");
    }
}
