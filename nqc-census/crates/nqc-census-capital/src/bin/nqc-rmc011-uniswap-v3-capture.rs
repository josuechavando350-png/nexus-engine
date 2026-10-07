use nqc_census_capital::uniswap_v3_acquire::run_uniswap_v3_capture;
use nqc_census_chain::json::Json;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    providers: PathBuf,
    label: String,
    store: PathBuf,
    d08_market_state: PathBuf,
    d08_token_admission: PathBuf,
    d08_evidence_manifest: PathBuf,
    authority_lock: PathBuf,
    deployment: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut providers = None;
    let mut label = None;
    let mut store = None;
    let mut d08_market_state = None;
    let mut d08_token_admission = None;
    let mut d08_evidence_manifest = None;
    let mut authority_lock = None;
    let mut deployment = None;
    let mut out = None;

    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--providers" => providers = Some(PathBuf::from(value)),
            "--label" => label = Some(value),
            "--store" => store = Some(PathBuf::from(value)),
            "--d08-market-state" => d08_market_state = Some(PathBuf::from(value)),
            "--d08-token-admission" => d08_token_admission = Some(PathBuf::from(value)),
            "--d08-evidence-manifest" => d08_evidence_manifest = Some(PathBuf::from(value)),
            "--authority-lock" => authority_lock = Some(PathBuf::from(value)),
            "--deployment" => deployment = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }

    Ok(Args {
        providers: providers.ok_or("--providers is required")?,
        label: label.ok_or("--label is required")?,
        store: store.ok_or("--store is required")?,
        d08_market_state: d08_market_state.ok_or("--d08-market-state is required")?,
        d08_token_admission: d08_token_admission.ok_or("--d08-token-admission is required")?,
        d08_evidence_manifest: d08_evidence_manifest
            .ok_or("--d08-evidence-manifest is required")?,
        authority_lock: authority_lock.ok_or("--authority-lock is required")?,
        deployment: deployment.ok_or("--deployment is required")?,
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let report = run_uniswap_v3_capture(
        &args.providers,
        &args.label,
        &args.store,
        &args.d08_market_state,
        &args.d08_token_admission,
        &args.d08_evidence_manifest,
        &args.authority_lock,
        &args.deployment,
    )?;
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, report.canonical()?)?;
    let pools = report
        .get("pools")
        .and_then(Json::as_array)
        .ok_or("Uniswap V3 capture has no pools")?;
    println!(
        "RMC011_UNISWAP_V3_PROVIDER_CAPTURE_PASS provider={} pools={} pool_universe_sha256={} evidence_manifests={}",
        args.label,
        pools.len(),
        report.str_field("pool_universe_sha256")?,
        report
            .get("evidence_manifests")
            .and_then(Json::as_array)
            .ok_or("Uniswap V3 capture has no evidence_manifests")?
            .len(),
    );
    Ok(())
}
