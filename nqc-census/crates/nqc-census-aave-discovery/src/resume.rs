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
        return Err(ChainError::Evidence(
            "offline replay does not reproduce the live history report".into(),
        ));
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
