use nqc_census_capital::{
    artifacts::{
        decode_upstream_authority_artifact, verify_capital_artifact_bundle, CapitalArtifactBundle,
        CapitalArtifactFile, CAPITAL_EVIDENCE_MANIFEST_FILE, CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE, CAPITAL_REQUIREMENTS_FILE, CAPITAL_SOURCES_FILE,
        CAPITAL_SUMMARY_FILE, CAPITAL_UPSTREAM_AUTHORITY_FILE,
    },
    balancer_live::source_authority_from_balancer_reconcile_artifact,
    source_authority::{certify_with_d11_source_authorities, D11SourceAuthoritySet},
    uniswap_v3_live::source_authority_from_uniswap_v3_reconcile_artifact,
    CapitalCensusLedger, CapitalRequirement, CapitalSource,
};
use nqc_census_chain::{hex, json::Json};
use nqc_census_core::StateAnchor;
use sha2::{Digest, Sha256};
use std::{
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

struct Args {
    legacy_dir: PathBuf,
    balancer_reconcile: PathBuf,
    uniswap_v3_reconcile: PathBuf,
    code_commit: String,
    code_tree: String,
    out: PathBuf,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let mut legacy_dir = None;
    let mut balancer_reconcile = None;
    let mut uniswap_v3_reconcile = None;
    let mut code_commit = None;
    let mut code_tree = None;
    let mut out = None;
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        match flag.as_str() {
            "--legacy-dir" => legacy_dir = Some(PathBuf::from(value)),
            "--balancer-reconcile" => balancer_reconcile = Some(PathBuf::from(value)),
            "--uniswap-v3-reconcile" => uniswap_v3_reconcile = Some(PathBuf::from(value)),
            "--code-commit" => code_commit = Some(value),
            "--code-tree" => code_tree = Some(value),
            "--out" => out = Some(PathBuf::from(value)),
            _ => return Err(format!("unknown argument {flag}").into()),
        }
    }
    let code_commit = code_commit.ok_or("--code-commit is required")?;
    let code_tree = code_tree.ok_or("--code-tree is required")?;
    for (name, value) in [("code commit", &code_commit), ("code tree", &code_tree)] {
        if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(format!("{name} is not a 40-hex Git object id").into());
        }
    }
    Ok(Args {
        legacy_dir: legacy_dir.ok_or("--legacy-dir is required")?,
        balancer_reconcile: balancer_reconcile.ok_or("--balancer-reconcile is required")?,
        uniswap_v3_reconcile: uniswap_v3_reconcile.ok_or("--uniswap-v3-reconcile is required")?,
        code_commit,
        code_tree,
        out: out.ok_or("--out is required")?,
    })
}

fn read_required(dir: &Path, name: &'static str) -> Result<CapitalArtifactFile, Box<dyn Error>> {
    Ok(CapitalArtifactFile::from_bytes(
        name,
        fs::read(dir.join(name))?,
    ))
}

fn load_legacy_bundle(dir: &Path) -> Result<CapitalArtifactBundle, Box<dyn Error>> {
    Ok(CapitalArtifactBundle {
        files: vec![
            read_required(dir, CAPITAL_SOURCES_FILE)?,
            read_required(dir, CAPITAL_REQUIREMENTS_FILE)?,
            read_required(dir, CAPITAL_FEASIBILITY_FILE)?,
            read_required(dir, CAPITAL_REJECTION_LEDGER_FILE)?,
            read_required(dir, CAPITAL_SUMMARY_FILE)?,
            read_required(dir, CAPITAL_UPSTREAM_AUTHORITY_FILE)?,
            read_required(dir, CAPITAL_EVIDENCE_MANIFEST_FILE)?,
        ],
    })
}

fn decode_sources(bytes: &[u8]) -> Result<Vec<CapitalSource>, Box<dyn Error>> {
    let text = std::str::from_utf8(bytes)?;
    let mut out = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let encoded = hex::decode_data(&format!("0x{}", row.str_field("canonical_record")?))?;
        out.push(CapitalSource::decode_canonical(&encoded)?);
    }
    Ok(out)
}

fn decode_requirements(bytes: &[u8]) -> Result<Vec<CapitalRequirement>, Box<dyn Error>> {
    let text = std::str::from_utf8(bytes)?;
    let mut out = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let encoded = hex::decode_data(&format!("0x{}", row.str_field("canonical_record")?))?;
        out.push(CapitalRequirement::decode_canonical(&encoded)?);
    }
    Ok(out)
}

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn anchor_json(anchor: &StateAnchor) -> Json {
    Json::object([
        ("chain_id", Json::uint(anchor.chain().chain_id())),
        (
            "genesis_hash",
            Json::string(anchor.chain().genesis_hash().to_hex()),
        ),
        (
            "fork_lineage",
            Json::string(anchor.chain().fork_lineage().to_hex()),
        ),
        ("block_number", Json::uint(anchor.block_number())),
        ("block_hash", Json::string(anchor.block_hash().to_hex())),
        ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
        ("timestamp", Json::uint(anchor.timestamp())),
        ("state_root", Json::string(anchor.state_root().to_hex())),
    ])
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let legacy = load_legacy_bundle(&args.legacy_dir)?;
    let legacy_verification = verify_capital_artifact_bundle(&legacy)?;

    let upstream_file = legacy
        .file(CAPITAL_UPSTREAM_AUTHORITY_FILE)
        .ok_or("verified legacy bundle has no upstream authority")?;
    let (upstream, _) = decode_upstream_authority_artifact(&upstream_file.bytes)?;

    let source_file = legacy
        .file(CAPITAL_SOURCES_FILE)
        .ok_or("verified legacy bundle has no sources")?;
    let requirement_file = legacy
        .file(CAPITAL_REQUIREMENTS_FILE)
        .ok_or("verified legacy bundle has no requirements")?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    for source in decode_sources(&source_file.bytes)? {
        ledger.register_source(source)?;
    }
    for requirement in decode_requirements(&requirement_file.bytes)? {
        ledger.register_requirement(requirement)?;
    }

    let balancer_bytes = fs::read(&args.balancer_reconcile)?;
    let (balancer_authority, balancer_sources) =
        source_authority_from_balancer_reconcile_artifact(&balancer_bytes)?;
    for source in balancer_sources {
        ledger.register_source(source)?;
    }

    let uniswap_v3_bytes = fs::read(&args.uniswap_v3_reconcile)?;
    let (uniswap_v3_authority, uniswap_v3_sources) =
        source_authority_from_uniswap_v3_reconcile_artifact(&uniswap_v3_bytes)?;
    for source in uniswap_v3_sources {
        ledger.register_source(source)?;
    }
    ledger.evaluate_all()?;

    let native_authorities =
        D11SourceAuthoritySet::new(vec![balancer_authority, uniswap_v3_authority])?;
    let certificate = certify_with_d11_source_authorities(&ledger, &upstream, &native_authorities)?;

    let legacy_manifest = legacy
        .file(CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("verified legacy bundle has no evidence manifest")?;
    let receipt = Json::object([
        ("schema_version", Json::uint(1)),
        ("stage", Json::string("RMC-011")),
        ("status", Json::string("RMC011_EXPANDED_LEDGER_REPLAY_PASS")),
        (
            "claim_scope",
            Json::string("D11_NATIVE_SOURCE_REPLAY_BINDING_ONLY"),
        ),
        ("terminal_d11_closed", Json::Bool(false)),
        ("code_commit", Json::string(args.code_commit)),
        ("code_tree", Json::string(args.code_tree)),
        (
            "observation_anchor",
            anchor_json(upstream.observation_anchor()),
        ),
        (
            "legacy_evidence_manifest_sha256",
            Json::string(sha256_plain(&legacy_manifest.bytes)),
        ),
        (
            "balancer_reconciliation_sha256",
            Json::string(sha256_plain(&balancer_bytes)),
        ),
        (
            "uniswap_v3_reconciliation_sha256",
            Json::string(sha256_plain(&uniswap_v3_bytes)),
        ),
        (
            "upstream_authority_commitment",
            Json::string(certificate.upstream_authority_commitment.to_hex()),
        ),
        (
            "d11_source_authority_set_commitment",
            Json::string(certificate.d11_source_authority_commitment.to_hex()),
        ),
        (
            "expanded_capital_commitment",
            Json::string(certificate.capital_commitment.to_hex()),
        ),
        (
            "legacy_source_count",
            Json::uint(u64::try_from(legacy_verification.source_count)?),
        ),
        (
            "d08_source_count",
            Json::uint(u64::try_from(certificate.d08_source_count)?),
        ),
        (
            "d11_native_source_count",
            Json::uint(u64::try_from(certificate.d11_native_source_count)?),
        ),
        (
            "expanded_source_count",
            Json::uint(u64::try_from(certificate.summary.source_count)?),
        ),
        (
            "requirement_count",
            Json::uint(u64::try_from(certificate.summary.requirement_count)?),
        ),
        (
            "feasible_count",
            Json::uint(u64::try_from(certificate.summary.feasible_count)?),
        ),
        (
            "rejected_count",
            Json::uint(u64::try_from(certificate.summary.rejected_count)?),
        ),
        (
            "zero_own_capital_proven",
            Json::Bool(certificate.summary.proves_zero_own_capital()),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("GLOBAL_CAPITAL_SOURCE_UNIVERSE_NOT_CERTIFIED"),
                Json::string("TERMINAL_D11_NOT_CERTIFIED"),
                Json::string("PROFITABILITY_NOT_CERTIFIED"),
                Json::string("SHADOW_NOT_CERTIFIED"),
                Json::string("CANARY_NOT_CERTIFIED"),
            ]),
        ),
    ]);
    let receipt_bytes = receipt.canonical()?;
    if let Some(parent) = args.out.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&args.out, &receipt_bytes)?;
    println!(
        "RMC011_EXPANDED_LEDGER_REPLAY_PASS legacy_sources={} native_sources={} expanded_sources={} commitment={}",
        legacy_verification.source_count,
        certificate.d11_native_source_count,
        certificate.summary.source_count,
        certificate.capital_commitment.to_hex(),
    );
    Ok(())
}
