use nqc_census_capital::balancer_live::reconcile_balancer_captures;
use nqc_census_chain::{hex, json::Json};
use sha2::{Digest, Sha256};
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

fn sha256_hex(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let first_bytes = fs::read(&args.first)?;
    let second_bytes = fs::read(&args.second)?;
    let first = Json::parse(&first_bytes)?;
    let second = Json::parse(&second_bytes)?;
    let sources = reconcile_balancer_captures(&first, &second)?;

    let mut rows = Vec::with_capacity(sources.len());
    for source in &sources {
        rows.push(Json::object([
            ("source_id", Json::string(source.id().to_hex())),
            ("source_key_id", Json::string(source.key_id().to_hex())),
            ("capital_class", Json::string(source.class().code())),
            ("asset", Json::string(source.asset().code())),
            (
                "maximum_available",
                Json::string(source.maximum_available().to_hex()),
            ),
            (
                "executable_capacity",
                Json::string(source.executable_capacity()?.to_hex()),
            ),
            (
                "execution_eligible",
                Json::Bool(source.execution_eligible()),
            ),
            (
                "execution_blockers",
                Json::array(
                    source
                        .execution_blockers()
                        .iter()
                        .cloned()
                        .map(Json::string),
                ),
            ),
            (
                "canonical_record",
                Json::string(hex::plain(&source.canonical_encode())),
            ),
        ]));
    }

    let report = Json::object([
        ("schema_version", Json::uint(1)),
        ("stage", Json::string("RMC-011")),
        ("family", Json::string("BALANCER_V2_FLASH_LOAN")),
        (
            "status",
            Json::string("RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED"),
        ),
        ("provider_count", Json::uint(2)),
        (
            "first_capture_sha256",
            Json::string(sha256_hex(&first_bytes)),
        ),
        (
            "second_capture_sha256",
            Json::string(sha256_hex(&second_bytes)),
        ),
        (
            "source_count",
            Json::uint(u64::try_from(sources.len())?),
        ),
        ("sources", Json::Array(rows)),
    ]);

    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, report.canonical()?)?;
    println!(
        "RMC011_BALANCER_V2_RUST_RECONCILE_PASS sources={} first_sha256={} second_sha256={}",
        sources.len(),
        sha256_hex(&first_bytes),
        sha256_hex(&second_bytes),
    );
    Ok(())
}
