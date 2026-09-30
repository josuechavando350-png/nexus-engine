use nqc_census_capital::{
    replay::{UpstreamAuthorityLock, UpstreamAuthorityLockEntry},
    GitObjectId, UpstreamCensusStage,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    input: PathBuf,
    output: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 4 || args[0] != "--input" || args[2] != "--output" {
        return Err(
            "usage: nqc-rmc011-authority-lock-build --input <candidate.json> --output <lock.json>"
                .into(),
        );
    }
    Ok(Args {
        input: PathBuf::from(&args[1]),
        output: PathBuf::from(&args[3]),
    })
}

fn uint(value: &Json, key: &'static str) -> Result<u64, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| format!("missing or invalid nonnegative integer field {key}").into())
}

fn hash(value: &Json, key: &'static str) -> Result<Hash32, Box<dyn Error>> {
    Hash32::parse_hex(value.str_field(key)?)
        .map_err(|_| format!("invalid 32-byte hash field {key}").into())
}

fn anchor(value: &Json) -> Result<StateAnchor, Box<dyn Error>> {
    let chain = ChainDomain::new(
        uint(value, "chain_id")?,
        hash(value, "genesis_hash")?,
        hash(value, "fork_lineage")?,
    )?;
    Ok(StateAnchor::new(
        chain,
        uint(value, "block_number")?,
        hash(value, "block_hash")?,
        hash(value, "parent_hash")?,
        uint(value, "timestamp")?,
        hash(value, "state_root")?,
    )?)
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let input = fs::read(&args.input)?;
    let parsed = Json::parse(&input)?;
    if uint(&parsed, "schema_version")? != 1 {
        return Err("unsupported authority-lock candidate schema".into());
    }

    let observation_anchor = anchor(
        parsed
            .get("observation_anchor")
            .ok_or("authority-lock candidate lacks observation_anchor")?,
    )?;
    let rows = parsed
        .get("stages")
        .and_then(Json::as_array)
        .ok_or("authority-lock candidate lacks stages")?;

    let mut entries = Vec::with_capacity(rows.len());
    for row in rows {
        let stage = UpstreamCensusStage::parse_code(row.str_field("stage")?)?;
        entries.push(UpstreamAuthorityLockEntry {
            stage,
            code_commit: GitObjectId::parse_hex(row.str_field("code_commit")?)?,
            code_tree: GitObjectId::parse_hex(row.str_field("code_tree")?)?,
            artifact_sha256: Hash32::parse_hex(row.str_field("artifact_sha256")?)?,
            observation_anchor: observation_anchor.clone(),
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        });
    }

    let lock = UpstreamAuthorityLock::new(entries)?;
    let bytes = lock.canonical_json()?;
    UpstreamAuthorityLock::parse_json(&bytes)?;

    if let Some(parent) = args.output.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(&args.output, &bytes)?;

    println!(
        "RMC011_AUTHORITY_LOCK_BUILD=PASS commitment={} output={}",
        lock.commitment().to_hex(),
        args.output.display()
    );
    Ok(())
}
