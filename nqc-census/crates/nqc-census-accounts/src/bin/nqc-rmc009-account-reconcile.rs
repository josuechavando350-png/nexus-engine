//! Offline RMC-009 reconciliation and closeout.
//!
//! `--index-providers F --state-providers F --pins F --pin-root DIR
//!  --candidates F --records DIR --store DIR --out-dir DIR
//!  --code-commit SHA --code-tree SHA`
//!
//! `--anchor-number N --anchor-hash H` select another anchor than the
//! declared one.
//!
//! Performs no network access: every record is replayed from the store.

use nqc_census_accounts::candidates::Candidates;
use nqc_census_accounts::closeout::{
    full_census_mode, reconcile_offline, write_closeout, CloseoutContext,
};
use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_state::inputs::verify_pins;
use nqc_census_state::replay::manifests;
use nqc_census_store::{Store, StoreConfig};
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        flags.insert(
            flag.clone(),
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))?,
        );
    }
    let flag = |name: &str| -> Result<String, Box<dyn Error>> {
        Ok(flags
            .get(name)
            .cloned()
            .ok_or_else(|| format!("{name} is required"))?)
    };
    let providers = |name: &str| -> Result<Vec<_>, Box<dyn Error>> {
        Ok(ProviderSet::parse(&fs::read(flag(name)?)?)?
            .iter()
            .cloned()
            .collect())
    };
    let index_providers = providers("--index-providers")?;
    let state_providers = providers("--state-providers")?;
    let pins = verify_pins(
        &PathBuf::from(flag("--pins")?),
        &PathBuf::from(flag("--pin-root")?),
    )?;
    let plan = plan_at(
        &pins,
        anchor_from_flags(
            flags.get("--anchor-number").map(String::as_str),
            flags.get("--anchor-hash").map(String::as_str),
        )?,
    )?;
    let candidates = Candidates::from_jsonl(&fs::read(flag("--candidates")?)?)?;
    let mut paths: Vec<PathBuf> = fs::read_dir(flag("--records")?)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()?;
    paths.sort();
    let records = paths
        .iter()
        .map(|path| Ok(Json::parse(&fs::read(path)?)?))
        .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
    let mut record_manifests = Vec::new();
    for record in &records {
        record_manifests.extend(manifests(record)?);
    }
    record_manifests.sort();
    record_manifests.dedup();
    let store_path = PathBuf::from(flag("--store")?);
    let store = Store::open(&store_path, &StoreConfig::standard())?;
    let reconciled = reconcile_offline(
        &store,
        &index_providers,
        &state_providers,
        &plan,
        &candidates,
        &records,
    )?;
    let report = nqc_census_store::verify::verify_store(
        &store_path,
        &nqc_census_store::verify::VerifyRequest {
            ranges: Vec::new(),
            tips: Vec::new(),
        },
    )
    .map_err(|failure| format!("store verification failed: {failure:?}"))?;
    let metric = |name: &str| {
        reconciled
            .outcome
            .metrics
            .get(name)
            .and_then(Json::as_i64)
            .unwrap_or(-1)
    };
    let summary = write_closeout(
        &PathBuf::from(flag("--out-dir")?),
        &CloseoutContext {
            code_commit: &flag("--code-commit")?,
            code_tree: &flag("--code-tree")?,
            pins: &pins,
            store_evidence_root: &report.evidence_root,
            record_manifests,
            mode: full_census_mode(&reconciled.index),
        },
        &reconciled,
    )?;
    println!(
        "RMC009_CLOSEOUT_PASS indexed={} state_verified={} missing_holder_tokens={} extra={} mismatched={} actionable={} unexplained={} records={} status={}",
        metric("indexed_accounts"),
        metric("state_verified_accounts"),
        metric("missing_holder_tokens"),
        metric("extra_accounts"),
        metric("mismatched_accounts"),
        metric("actionable_accounts"),
        summary
            .get("unexplained_mismatches")
            .and_then(Json::as_i64)
            .unwrap_or(-1),
        reconciled.records,
        summary.str_field("status")?
    );
    Ok(())
}
