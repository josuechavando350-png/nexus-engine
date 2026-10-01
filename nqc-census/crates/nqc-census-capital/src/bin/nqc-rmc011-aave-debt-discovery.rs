use nqc_census_capital::{
    aave_debt_discovery::build_aave_debt_discovery_artifact,
    replay::UpstreamAuthorityLock,
    upstream::D08CapitalImportContext,
    CapitalEvidenceRef, UpstreamCensusStage, UpstreamStageAuthority, UpstreamStageAuthoritySpec,
};
use nqc_census_chain::json::Json;
use std::{env, error::Error, fs, path::PathBuf};

struct Args {
    market_state: PathBuf,
    token_admission: PathBuf,
    pool_facts: PathBuf,
    evidence_manifest: PathBuf,
    authority_lock: PathBuf,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut market_state = None;
    let mut token_admission = None;
    let mut pool_facts = None;
    let mut evidence_manifest = None;
    let mut authority_lock = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--d08-market-state" => market_state = Some(PathBuf::from(value)),
            "--d08-token-admission" => token_admission = Some(PathBuf::from(value)),
            "--d08-pool-and-factory-facts" => pool_facts = Some(PathBuf::from(value)),
            "--d08-evidence-manifest" => evidence_manifest = Some(PathBuf::from(value)),
            "--authority-lock" => authority_lock = Some(PathBuf::from(value)),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    Ok(Args {
        market_state: market_state.ok_or("--d08-market-state is required")?,
        token_admission: token_admission.ok_or("--d08-token-admission is required")?,
        pool_facts: pool_facts.ok_or("--d08-pool-and-factory-facts is required")?,
        evidence_manifest: evidence_manifest.ok_or("--d08-evidence-manifest is required")?,
        authority_lock: authority_lock.ok_or("--authority-lock is required")?,
        out: out.ok_or("--out is required")?,
    })
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let lock_bytes = fs::read(&args.authority_lock)?;
    let lock = UpstreamAuthorityLock::parse_json(&lock_bytes)?;
    let entry = lock
        .entries()
        .iter()
        .find(|entry| entry.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("authority lock lacks RMC-008")?;
    let authority = UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
        stage: entry.stage,
        code_commit: entry.code_commit,
        code_tree: entry.code_tree,
        artifact_sha256: entry.artifact_sha256,
        observation_anchor: entry.observation_anchor.clone(),
        unresolved_mismatch_count: entry.unresolved_mismatch_count,
        unknown_failure_count: entry.unknown_failure_count,
        coverage_complete: entry.coverage_complete,
        admitted: entry.admitted,
    })?;
    let context = D08CapitalImportContext {
        anchor: entry.observation_anchor.clone(),
        evidence: vec![CapitalEvidenceRef::Artifact(entry.artifact_sha256)],
    };

    let artifact = build_aave_debt_discovery_artifact(
        &fs::read(&args.market_state)?,
        &fs::read(&args.token_admission)?,
        &fs::read(&args.pool_facts)?,
        &fs::read(&args.evidence_manifest)?,
        &authority,
        &context,
    )?;
    let parsed = Json::parse(&artifact)?;
    if parsed.get("capital_source_count").and_then(Json::as_i64) != Some(0)
        || parsed
            .get("nqc_borrowing_capacity_claimed")
            .and_then(Json::as_bool)
            != Some(false)
    {
        return Err("Aave debt discovery artifact crossed the non-terminal capacity boundary".into());
    }

    if let Some(parent) = args.out.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)?;
        }
    }
    fs::write(&args.out, &artifact)?;

    println!(
        "RMC011_AAVE_DEBT_DISCOVERY_PASS candidates={} facilities={} rejected={} coverage_commitment={} capital_source_count=0 nqc_borrowing_capacity_claimed=false",
        parsed
            .get("candidate_count")
            .and_then(Json::as_i64)
            .ok_or("candidate_count missing")?,
        parsed
            .get("facility_count")
            .and_then(Json::as_i64)
            .ok_or("facility_count missing")?,
        parsed
            .get("rejected_count")
            .and_then(Json::as_i64)
            .ok_or("rejected_count missing")?,
        parsed.str_field("coverage_commitment")?,
    );
    Ok(())
}
