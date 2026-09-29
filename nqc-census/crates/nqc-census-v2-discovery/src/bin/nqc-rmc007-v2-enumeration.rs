use nqc_census_v2_discovery::enumeration::run_enumeration;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    providers: PathBuf,
    current: PathBuf,
    store: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
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
    Ok(Args {
        providers: providers.ok_or("--providers is required")?,
        current: current.ok_or("--current is required")?,
        store: store.ok_or("--store is required")?,
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let report = run_enumeration(&args.providers, &args.current, &args.store)?;
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, report.canonical()?)?;
    let count = report
        .get("pair_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("enumeration report missing pair_count")?;
    println!(
        "RMC007_FULL_ENUMERATION_PASS provider={} pairs={count} partitions={} digest={}",
        report.str_field("provider")?,
        report
            .get("partition_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("enumeration report missing partition_count")?,
        report.str_field("pair_sequence_sha256")?
    );
    Ok(())
}
