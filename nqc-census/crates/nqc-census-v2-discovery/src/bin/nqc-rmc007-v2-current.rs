use nqc_census_v2_discovery::live::run_current_surface;
use std::{env, error::Error, fs, path::PathBuf};

fn parse_args() -> Result<(PathBuf, PathBuf, PathBuf), Box<dyn Error>> {
    let mut providers = None;
    let mut store = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--providers" => providers = Some(PathBuf::from(value)),
            "--store" => store = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok((
        providers.ok_or("--providers is required")?,
        store.ok_or("--store is required")?,
        out.ok_or("--out is required")?,
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (providers, store, out) = parse_args()?;
    let report = run_current_surface(&providers, &store)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out, report.canonical()?)?;
    let facts = report.get("facts").ok_or("current report missing facts")?;
    let count = facts
        .get("pair_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("current report missing pair_count")?;
    println!(
        "RMC007_CURRENT_SURFACE_PASS providers=3 pairs={count} factory={}",
        facts.str_field("factory")?
    );
    Ok(())
}
