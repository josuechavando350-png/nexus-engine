//! Derive the incremental candidate universe from certified base + delta extracts.
//!
//! --index-providers F --pins F --pin-root DIR --base DIR
//! --anchor-number N --anchor-hash H --extracts DIR --out F

use nqc_census_accounts::candidates::derive_candidates;
use nqc_census_accounts::extract::extract_stages;
use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_refresh::base::read_base;
use nqc_census_refresh::refresh::{delta_plan, refreshed_candidates};
use nqc_census_state::inputs::verify_pins;
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
    let index_providers: Vec<_> = ProviderSet::parse(&fs::read(flag("--index-providers")?)?)?
        .iter()
        .cloned()
        .collect();
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
    let extracts = json_files(&flag("--extracts")?)?;
    let staged = extract_stages(&index_providers, &index_providers, &delta, extracts)?;
    let mut index = Vec::with_capacity(staged.len());
    for (record, stage) in staged {
        if record.str_field("stage")? != "ACCOUNT_INDEX" {
            return Err("delta extract contains a non-index stage".into());
        }
        index.push(stage);
    }
    let (delta_candidates, facts) = derive_candidates(&index, &delta)?;
    let refreshed = refreshed_candidates(&base.candidates, &delta_candidates);
    fs::write(flag("--out")?, refreshed.to_jsonl()?)?;
    println!(
        "RMC010_REFRESH_CANDIDATES_PASS base_accounts={} delta_accounts={} refreshed_accounts={} index_start={} logs={} digest={}",
        base.candidates.accounts.len(),
        delta_candidates.accounts.len(),
        refreshed.accounts.len(),
        delta.index_start,
        facts.logs,
        refreshed.digest()
    );
    Ok(())
}
