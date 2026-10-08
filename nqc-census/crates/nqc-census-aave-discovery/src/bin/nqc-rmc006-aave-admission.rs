use nqc_census_aave_discovery::admission::run_admission;
use std::{env, error::Error, fs, path::PathBuf};

fn parse_args() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), Box<dyn Error>> {
    let mut current = None;
    let mut history = None;
    let mut store = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--current" => current = Some(PathBuf::from(value)),
            "--history" => history = Some(PathBuf::from(value)),
            "--store" => store = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok((
        current.ok_or("--current is required")?,
        history.ok_or("--history is required")?,
        store.ok_or("--store is required")?,
        out.ok_or("--out is required")?,
    ))
}

fn main() -> Result<(), Box<dyn Error>> {
    let (current, history, store, out) = parse_args()?;
    let report = run_admission(&current, &history, &store)?;
    if let Some(parent) = out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&out, report.canonical()?)?;
    println!(
        "RMC006_D05_ADMISSION_PASS admission_id={} evidence_refs={}",
        report.str_field("admission_id")?,
        report
            .get("evidence_ref_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("admission report missing evidence_ref_count")?
    );
    Ok(())
}
