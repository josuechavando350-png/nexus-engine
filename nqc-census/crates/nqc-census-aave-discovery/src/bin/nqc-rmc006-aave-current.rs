use nqc_census_aave_discovery::live::{anchor_from_flags, run_current_surface};
use std::{env, error::Error, fs, path::PathBuf};

type Args = (PathBuf, PathBuf, PathBuf, Option<String>, Option<String>);

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut providers = None;
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
            "--store" => store = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            "--anchor-number" => anchor_number = Some(value),
            "--anchor-hash" => anchor_hash = Some(value),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok((
        providers.ok_or("--providers is required")?,
        store.ok_or("--store is required")?,
        out.ok_or("--out is required")?,
        anchor_number,
        anchor_hash,
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (providers, store, out, anchor_number, anchor_hash) = parse_args()?;
    let anchor = anchor_from_flags(anchor_number.as_deref(), anchor_hash.as_deref())?;
    let report = run_current_surface(&providers, &store, anchor)?;
    let bytes = report.canonical()?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out, bytes)?;
    let facts = report.get("facts").ok_or("current report missing facts")?;
    let reserves = facts
        .get("reserve_count")
        .and_then(nqc_census_chain::json::Json::as_i64)
        .ok_or("current report missing reserve count")?;
    let configurator = facts.str_field("pool_configurator")?;
    println!(
        "RMC006_CURRENT_SURFACE_PASS providers=3 reserves={reserves} configurator={configurator} anchor={}",
        anchor.0
    );
    Ok(())
}
