use nqc_census_capital::uniswap_v3_live::{
    build_uniswap_v3_reconciliation_artifact,
    source_authority_from_uniswap_v3_reconcile_artifact,
};
use nqc_census_chain::json::Json;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    first: PathBuf,
    second: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut first = None;
    let mut second = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--first" => first = Some(PathBuf::from(value)),
            "--second" => second = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok(Args {
        first: first.ok_or("--first is required")?,
        second: second.ok_or("--second is required")?,
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let first = fs::read(&args.first)?;
    let second = fs::read(&args.second)?;
    let artifact = build_uniswap_v3_reconciliation_artifact(&first, &second)?;
    let report = Json::parse(&artifact)?;
    let (authority, sources) =
        source_authority_from_uniswap_v3_reconcile_artifact(&artifact)?;

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, &artifact)?;

    println!(
        "RMC011_UNISWAP_V3_RUST_RECONCILE_PASS sources={} first_sha256={} second_sha256={} source_authority_commitment={}",
        sources.len(),
        report.str_field("first_capture_sha256")?,
        report.str_field("second_capture_sha256")?,
        authority.commitment().to_hex(),
    );
    Ok(())
}
