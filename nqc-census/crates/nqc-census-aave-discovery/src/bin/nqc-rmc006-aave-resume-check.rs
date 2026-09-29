//! Offline: rebuilds the history reconstruction from the recorded exchanges
//! only, with and without injected crashes, and requires byte-identical
//! reports and evidence roots. Needs no network.

use nqc_census_aave_discovery::history::HistoryPlan;
use nqc_census_aave_discovery::resume::resume_check;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_store::Store;
use std::{env, error::Error, fs, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let mut providers = None;
    let mut current = None;
    let mut history = None;
    let mut store = None;
    let mut work = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = PathBuf::from(
            args.next()
                .ok_or_else(|| format!("missing value for {flag}"))?,
        );
        match flag.as_str() {
            "--providers" => providers = Some(value),
            "--current" => current = Some(value),
            "--history" => history = Some(value),
            "--store" => store = Some(value),
            "--work" => work = Some(value),
            "--out" => out = Some(value),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    let providers = ProviderSet::parse(&fs::read(providers.ok_or("--providers is required")?)?)?;
    let current = Json::parse(&fs::read(current.ok_or("--current is required")?)?)?;
    let history = Json::parse(&fs::read(history.ok_or("--history is required")?)?)?;
    let store = Store::open_existing(&store.ok_or("--store is required")?)?;
    let report = resume_check(
        &store,
        &providers,
        &HistoryPlan::mainnet()?,
        &current,
        &history,
        &work.ok_or("--work is required")?,
    )?;
    fs::write(out.ok_or("--out is required")?, report.canonical()?)?;
    println!(
        "RMC006_RESUME_EQUIVALENCE_PASS exchanges={} interruptions={} evidence_root={}",
        report
            .get("recorded_exchanges")
            .and_then(Json::as_i64)
            .ok_or("exchanges")?,
        report
            .get("interruptions")
            .and_then(Json::as_array)
            .map_or(0, <[Json]>::len),
        report.str_field("clean_evidence_root")?
    );
    Ok(())
}
