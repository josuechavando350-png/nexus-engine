use nqc_census_aave_discovery::history::{run_history, HistoryPlan};
use nqc_census_aave_discovery::live::anchor_from_flags;
use std::{env, error::Error, fs, path::PathBuf};

type Args = (
    PathBuf,
    PathBuf,
    PathBuf,
    PathBuf,
    Option<String>,
    Option<String>,
);

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut providers = None;
    let mut current = None;
    let mut store = None;
    let mut out = None;
    let mut anchor_number = None;
    let mut anchor_hash = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--providers" => providers = Some(PathBuf::from(value)),
            "--current" => current = Some(PathBuf::from(value)),
            "--store" => store = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--anchor-number" => anchor_number = Some(value),
            "--anchor-hash" => anchor_hash = Some(value),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok((
        providers.ok_or("--providers is required")?,
        current.ok_or("--current is required")?,
        store.ok_or("--store is required")?,
        out.ok_or("--out is required")?,
        anchor_number,
        anchor_hash,
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (providers, current, store, out, anchor_number, anchor_hash) = parse_args()?;
    let plan = HistoryPlan::mainnet_at(anchor_from_flags(
        anchor_number.as_deref(),
        anchor_hash.as_deref(),
    )?)?;
    let report = run_history(&providers, &current, &store, &plan)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out, report.canonical()?)?;
    let summary = report
        .get("summary")
        .ok_or("history report missing summary")?;
    let providers = summary
        .get("provider_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("history report missing provider_count")?;
    let current = summary
        .get("current_reserve_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("history report missing current_reserve_count")?;
    let initialized = summary
        .get("reserve_initialized_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("history report missing reserve_initialized_count")?;
    let dropped = summary
        .get("reserve_dropped_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("history report missing reserve_dropped_count")?;
    println!(
        "RMC006_HISTORY_RECONCILIATION_PASS providers={providers} current={current} initialized={initialized} dropped={dropped}"
    );
    Ok(())
}
