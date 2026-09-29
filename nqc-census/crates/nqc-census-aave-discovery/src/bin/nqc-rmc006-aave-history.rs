use nqc_census_aave_discovery::history::run_history;
use std::{env, error::Error, fs, path::PathBuf};

fn parse_args() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), Box<dyn Error>> {
    let mut providers = None;
    let mut current = None;
    let mut store = None;
    let mut out = None;
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
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok((
        providers.ok_or("--providers is required")?,
        current.ok_or("--current is required")?,
        store.ok_or("--store is required")?,
        out.ok_or("--out is required")?,
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (providers, current, store, out) = parse_args()?;
    let report = run_history(&providers, &current, &store)?;
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
