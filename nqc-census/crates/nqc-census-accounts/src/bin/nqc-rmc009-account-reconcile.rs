//! Offline RMC-009 reconciliation and closeout.
//!
//! `--index-providers F --state-providers F --pins F --pin-root DIR
//!  --candidates F (--records DIR --store DIR | --extracts DIR) --out-dir DIR
//!  --code-commit SHA --code-tree SHA`
//!
//! `--records` replays every record from one store holding all their
//! evidence; `--extracts` takes stages already replayed one store at a time
//! by `nqc-rmc009-account-replay`.
//!
//! `--anchor-number N --anchor-hash H` select another anchor than the
//! declared one.
//!
//! Performs no network access.

use nqc_census_accounts::candidates::Candidates;
use nqc_census_accounts::closeout::{
    full_census_mode, reconcile_extracts, reconcile_offline, write_closeout, CloseoutContext,
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
    let json_files = |dir: String| -> Result<Vec<Json>, Box<dyn Error>> {
        let mut paths: Vec<PathBuf> = fs::read_dir(dir)?
            .map(|entry| entry.map(|entry| entry.path()))
            .collect::<Result<_, _>>()?;
        paths.sort();
        paths
            .iter()
            .map(|path| Ok(Json::parse(&fs::read(path)?)?))
            .collect()
    };
    let (reconciled, records, store_evidence_root, stage_stores) = match (
        flags.contains_key("--records"),
        flags.contains_key("--extracts"),
    ) {
        (true, false) => {
            let records = json_files(flag("--records")?)?;
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
            (reconciled, records, report.evidence_root, Vec::new())
        }
        (false, true) => {
            let extracts = json_files(flag("--extracts")?)?;
            let stage_stores = extracts
                .iter()
                .map(|extract| {
                    Ok(Json::object([
                        (
                            "record_sha256",
                            Json::string(extract.str_field("record_sha256")?),
                        ),
                        (
                            "store",
                            extract
                                .get("store")
                                .cloned()
                                .ok_or("extract without store")?,
                        ),
                    ]))
                })
                .collect::<Result<Vec<_>, Box<dyn Error>>>()?;
            let (reconciled, records) = reconcile_extracts(
                &index_providers,
                &state_providers,
                &plan,
                &candidates,
                extracts,
            )?;
            (
                reconciled,
                records,
                "NOT_MERGED_EACH_STAGE_STORE_IN_STAGE_STORES".to_owned(),
                stage_stores,
            )
        }
        _ => return Err("exactly one of --records and --extracts is required".into()),
    };
    let mut record_manifests = Vec::new();
    for record in &records {
        record_manifests.extend(manifests(record)?);
    }
    record_manifests.sort();
    record_manifests.dedup();
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
            store_evidence_root: &store_evidence_root,
            stage_stores,
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
