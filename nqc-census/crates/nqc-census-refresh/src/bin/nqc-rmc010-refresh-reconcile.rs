//! Offline live RMC-010 reconciliation and full/incremental parity.
//!
//! --index-providers F --state-providers F --pins F --pin-root DIR --base DIR
//! --anchor-number N --anchor-hash H --candidates F
//! --canonical-extracts DIR --delta-extracts DIR --state-extracts DIR
//! --full-closeout DIR --out-dir DIR --parity-out F
//! --code-commit SHA --code-tree SHA

use nqc_census_accounts::candidates::Candidates;
use nqc_census_accounts::closeout::{write_closeout, CloseoutContext};
use nqc_census_accounts::extract::extract_stages;
use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_refresh::base::read_base;
use nqc_census_refresh::canonical_extract::verify_extract as verify_canonical_extract;
use nqc_census_refresh::parity::census_parity;
use nqc_census_refresh::refresh::{delta_plan, reconcile_incremental_replayed};
use nqc_census_state::inputs::verify_pins;
use nqc_census_state::replay::manifests;
use std::collections::BTreeMap;
use std::{env, error::Error, fs, path::PathBuf};

fn json_files(dir: &str) -> Result<Vec<Json>, Box<dyn Error>> {
    let mut paths: Vec<PathBuf> = fs::read_dir(dir)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()?;
    paths.sort();
    paths
        .iter()
        .map(|path| Ok(Json::parse(&fs::read(path)?)?))
        .collect()
}

fn store_rows(extracts: &[Json]) -> Result<Vec<Json>, Box<dyn Error>> {
    extracts
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
        .collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let mut flags = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if flags.insert(flag.clone(), value).is_some() {
            return Err(format!("{flag} given twice").into());
        }
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
    let anchor = anchor_from_flags(
        flags.get("--anchor-number").map(String::as_str),
        flags.get("--anchor-hash").map(String::as_str),
    )?;
    let target = plan_at(&pins, anchor)?;
    let base = read_base(&PathBuf::from(flag("--base")?))?;
    let delta = delta_plan(&target, &base)?;
    let candidates = Candidates::from_jsonl(&fs::read(flag("--candidates")?)?)?;

    let canonical_extracts = json_files(&flag("--canonical-extracts")?)?;
    let delta_extracts = json_files(&flag("--delta-extracts")?)?;
    let state_extracts = json_files(&flag("--state-extracts")?)?;
    let mut stage_stores = store_rows(&canonical_extracts)?;
    stage_stores.extend(store_rows(&delta_extracts)?);
    stage_stores.extend(store_rows(&state_extracts)?);

    let mut canonical = Vec::new();
    let mut records = Vec::new();
    for extract in canonical_extracts {
        let (record, stage) =
            verify_canonical_extract(&state_providers, &target.anchor, &base, extract)?;
        records.push(record);
        canonical.push(stage);
    }

    let delta_staged = extract_stages(
        &index_providers,
        &state_providers,
        &delta,
        delta_extracts,
    )?;
    let mut index = Vec::new();
    for (record, stage) in delta_staged {
        if record.str_field("stage")? != "ACCOUNT_INDEX" {
            return Err("delta extracts contain a non-index stage".into());
        }
        records.push(record);
        index.push(stage);
    }

    let state_staged = extract_stages(
        &index_providers,
        &state_providers,
        &target,
        state_extracts,
    )?;
    let mut tokens = Vec::new();
    let mut state = Vec::new();
    for (record, replayed) in state_staged {
        match record.str_field("stage")? {
            "ACCOUNT_TOKENS" => tokens.push(replayed),
            "ACCOUNT_STATE" => state.push(replayed),
            other => return Err(format!("state extracts contain {other}").into()),
        }
        records.push(record);
    }

    let (reconciled, mode) = reconcile_incremental_replayed(
        &target,
        &base,
        &candidates,
        canonical,
        index,
        tokens,
        state,
        records.len(),
    )?;

    let mut record_manifests = Vec::new();
    for record in &records {
        record_manifests.extend(manifests(record)?);
    }
    record_manifests.sort();
    record_manifests.dedup();

    let out_dir = PathBuf::from(flag("--out-dir")?);
    let summary = write_closeout(
        &out_dir,
        &CloseoutContext {
            code_commit: &flag("--code-commit")?,
            code_tree: &flag("--code-tree")?,
            pins: &pins,
            store_evidence_root: "NOT_MERGED_EACH_STAGE_STORE_IN_STAGE_STORES",
            stage_stores,
            record_manifests,
            mode,
        },
        &reconciled,
    )?;
    if summary.str_field("status")? != "RMC_009_PASS_CANDIDATE" {
        return Err("incremental closeout did not pass".into());
    }

    let parity = census_parity(&PathBuf::from(flag("--full-closeout")?), &out_dir)?;
    fs::write(flag("--parity-out")?, parity.canonical()?)?;
    println!(
        "RMC010_LIVE_PARITY_PASS base={} target={} candidates={} records={} parity_status={}",
        base.anchor_number,
        target.anchor.number,
        candidates.accounts.len(),
        reconciled.records,
        parity.str_field("status")?
    );
    Ok(())
}
