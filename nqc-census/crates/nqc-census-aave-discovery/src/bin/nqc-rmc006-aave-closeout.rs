use nqc_census_aave_discovery::closeout::run_closeout;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    current: PathBuf,
    history: PathBuf,
    store: PathBuf,
    out_dir: PathBuf,
    code_commit: String,
    code_tree: String,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut current = None;
    let mut history = None;
    let mut store = None;
    let mut out_dir = None;
    let mut code_commit = None;
    let mut code_tree = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--current" => current = Some(PathBuf::from(value)),
            "--history" => history = Some(PathBuf::from(value)),
            "--store" => store = Some(PathBuf::from(value)),
            "--out-dir" => out_dir = Some(PathBuf::from(value)),
            "--code-commit" => code_commit = Some(value),
            "--code-tree" => code_tree = Some(value),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok(Args {
        current: current.ok_or("--current is required")?,
        history: history.ok_or("--history is required")?,
        store: store.ok_or("--store is required")?,
        out_dir: out_dir.ok_or("--out-dir is required")?,
        code_commit: code_commit.ok_or("--code-commit is required")?,
        code_tree: code_tree.ok_or("--code-tree is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let report = run_closeout(
        &args.current,
        &args.history,
        &args.store,
        &args.out_dir,
        &args.code_commit,
        &args.code_tree,
    )?;
    fs::write(
        args.out_dir.join("closeout-report.json"),
        report.canonical()?,
    )?;
    println!(
        "RMC006_CLOSEOUT_PASS reserves={} unexplained={} mismatches={} artifacts={}",
        report
            .get("reserve_union_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("missing reserve_union_count")?,
        report
            .get("unexplained_delta_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("missing unexplained_delta_count")?,
        report
            .get("provider_mismatch_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("missing provider_mismatch_count")?,
        report
            .get("artifact_count")
            .and_then(nqc_census_chain::json::Json::as_i64)
            .ok_or("missing artifact_count")?,
    );
    Ok(())
}
