use nqc_census_v2_discovery::membership::run_membership;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    providers: PathBuf,
    current: PathBuf,
    boundary: PathBuf,
    history: PathBuf,
    enumeration: PathBuf,
    store: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut providers = None;
    let mut current = None;
    let mut boundary = None;
    let mut history = None;
    let mut enumeration = None;
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
            "--boundary" => boundary = Some(PathBuf::from(value)),
            "--history" => history = Some(PathBuf::from(value)),
            "--enumeration" => enumeration = Some(PathBuf::from(value)),
            "--store" => store = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok(Args {
        providers: providers.ok_or("--providers is required")?,
        current: current.ok_or("--current is required")?,
        boundary: boundary.ok_or("--boundary is required")?,
        history: history.ok_or("--history is required")?,
        enumeration: enumeration.ok_or("--enumeration is required")?,
        store: store.ok_or("--store is required")?,
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let report = run_membership(
        &args.providers,
        &args.current,
        &args.boundary,
        &args.history,
        &args.enumeration,
        &args.store,
    )?;
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, report.canonical()?)?;
    let count = report
        .get("pair_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("membership report missing pair_count")?;
    println!(
        "RMC007_DIRECT_MEMBERSHIP_RUNTIME_PASS provider={} pairs={count} partitions={}",
        report.str_field("provider")?,
        report
            .get("partition_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("membership report missing partition_count")?
    );
    Ok(())
}
