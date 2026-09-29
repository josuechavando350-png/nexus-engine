//! Agreed candidate accounts from replayed `ACCOUNT_INDEX` records.
//!
//! `--providers F --pins F --pin-root DIR --records DIR --store DIR --out F`
//!
//! `--anchor-number N --anchor-hash H` select another anchor than the
//! declared one (the D06 inputs must be at it); `--index-start S` indexes only
//! `[S, anchor]`.
//!
//! Performs no network access: every record is replayed from the store and
//! the providers must have returned identical logs.

use nqc_census_accounts::candidates::derive_candidates;
use nqc_census_accounts::inputs::{anchor_from_flags, plan_at};
use nqc_census_accounts::replay::replay_account_stage;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_state::inputs::verify_pins;
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
    let providers: Vec<_> = ProviderSet::parse(&fs::read(flag("--providers")?)?)?
        .iter()
        .cloned()
        .collect();
    let pins = verify_pins(
        &PathBuf::from(flag("--pins")?),
        &PathBuf::from(flag("--pin-root")?),
    )?;
    let mut plan = plan_at(
        &pins,
        anchor_from_flags(
            flags.get("--anchor-number").map(String::as_str),
            flags.get("--anchor-hash").map(String::as_str),
        )?,
    )?;
    if let Some(start) = flags.get("--index-start") {
        plan = plan.with_index_start(start.parse()?)?;
    }
    let store = Store::open(&PathBuf::from(flag("--store")?), &StoreConfig::standard())?;
    let mut paths: Vec<PathBuf> = fs::read_dir(flag("--records")?)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()?;
    paths.sort();
    let mut stages = Vec::new();
    for path in &paths {
        let record = Json::parse(&fs::read(path)?)?;
        stages.push(replay_account_stage(
            &store, &providers, &plan, None, &record,
        )?);
    }
    let (candidates, facts) = derive_candidates(&stages, &plan)?;
    fs::write(PathBuf::from(flag("--out")?), candidates.to_jsonl()?)?;
    println!(
        "RMC009_CANDIDATES_PASS records={} jobs={} logs={} accounts={} pairs={} zero_account_logs={} sha256={}",
        stages.len(),
        facts.jobs,
        facts.logs,
        candidates.accounts.len(),
        candidates.pair_count(),
        facts.zero_account_logs,
        candidates.digest()
    );
    Ok(())
}
