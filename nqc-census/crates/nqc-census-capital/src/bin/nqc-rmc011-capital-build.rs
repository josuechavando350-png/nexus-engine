use nqc_census_capital::{
    artifacts::{export_capital_artifacts, ArtifactProvenance},
    demands::import_d09_borrower_demands,
    replay::{
        verify_real_source_closeout_for_code, D08ReplayInputs, D09ReplayInputs,
        UpstreamAuthorityLock,
    },
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCensusLedger, CapitalEvidenceRef, UpstreamCensusStage,
};
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs, path::PathBuf};

const AUTHORITY_LOCK_ARCHIVE_FILE: &str = "capital-upstream-authority-lock.json";
const REAL_SOURCE_CLOSEOUT_FILE: &str = "capital-real-source-closeout.json";

struct Args {
    d08_dir: PathBuf,
    d09_dir: PathBuf,
    authority_lock: PathBuf,
    output_dir: PathBuf,
    code_commit: String,
    code_tree: String,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 12
        || args[0] != "--d08-dir"
        || args[2] != "--d09-dir"
        || args[4] != "--authority-lock"
        || args[6] != "--output-dir"
        || args[8] != "--code-commit"
        || args[10] != "--code-tree"
    {
        return Err(
            "usage: nqc-rmc011-capital-build --d08-dir <dir> --d09-dir <dir> --authority-lock <json> --output-dir <dir> --code-commit <sha> --code-tree <sha>"
                .into(),
        );
    }
    Ok(Args {
        d08_dir: PathBuf::from(&args[1]),
        d09_dir: PathBuf::from(&args[3]),
        authority_lock: PathBuf::from(&args[5]),
        output_dir: PathBuf::from(&args[7]),
        code_commit: args[9].clone(),
        code_tree: args[11].clone(),
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;

    let lock_bytes = fs::read(&args.authority_lock)?;
    let authority_lock = UpstreamAuthorityLock::parse_json(&lock_bytes)?;
    let context_without_receipts = authority_lock.certification_context()?;

    let d08_authority = context_without_receipts
        .stages()
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("authority lock lacks RMC-008")?
        .clone();
    let d09_authority = context_without_receipts
        .stages()
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or("authority lock lacks RMC-009")?
        .clone();

    let d08_state = fs::read(args.d08_dir.join("market-state-manifest.jsonl"))?;
    let d08_tokens = fs::read(args.d08_dir.join("token-admission.jsonl"))?;
    let d08_facts = fs::read(args.d08_dir.join("pool-and-factory-facts.json"))?;
    let d08_manifest = fs::read(args.d08_dir.join("evidence-manifest.json"))?;

    let d09_accounts = fs::read(args.d09_dir.join("account-manifest.jsonl"))?;
    let d09_summary = fs::read(args.d09_dir.join("account-summary.json"))?;
    let d09_manifest = fs::read(args.d09_dir.join("evidence-manifest.json"))?;

    let d08_context = D08CapitalImportContext {
        anchor: context_without_receipts.observation_anchor().clone(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08_authority.artifact_sha256)],
    };
    let d08_import = import_d08_capital_sources(
        &d08_state,
        &d08_tokens,
        &d08_facts,
        &d08_manifest,
        &d08_authority,
        &d08_context,
    )?;
    if !d08_import.is_conserved() {
        return Err("RMC-008 capital import is not conserved".into());
    }

    let d09_import = import_d09_borrower_demands(
        &d09_accounts,
        &d09_summary,
        &d09_manifest,
        &d09_authority,
        context_without_receipts.observation_anchor(),
    )?;
    if !d09_import.is_conserved() {
        return Err("RMC-009 demand import is not conserved".into());
    }

    let d08_receipt = d08_import.consumption_receipt()?;
    let d09_receipt = d09_import.consumption_receipt()?;
    let context =
        context_without_receipts.with_consumption_receipts(vec![d08_receipt, d09_receipt])?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    for source in d08_import.sources {
        ledger.register_source(source)?;
    }
    for requirement in d09_import.requirements {
        ledger.register_requirement(requirement)?;
    }
    ledger.evaluate_all()?;

    let provenance = ArtifactProvenance::for_anchor(
        context.observation_anchor(),
        &args.code_commit,
        &args.code_tree,
    )?;
    let bundle = export_capital_artifacts(&ledger, &context, &provenance)?;
    // The canonical artifact bundle is now owned and self-contained.
    // Release the large per-source/per-requirement graph before running the
    // independent upstream replay, which creates its own verification state.
    // This changes only the peak live allocation, never the serialized bytes.
    drop(ledger);

    let d08_replay = D08ReplayInputs {
        state_manifest_jsonl: &d08_state,
        token_admission_jsonl: &d08_tokens,
        pool_and_factory_facts_json: &d08_facts,
        evidence_manifest_json: &d08_manifest,
    };
    let d09_replay = D09ReplayInputs {
        account_manifest_jsonl: &d09_accounts,
        account_summary_json: &d09_summary,
        evidence_manifest_json: &d09_manifest,
    };
    let closeout = verify_real_source_closeout_for_code(
        &bundle,
        &args.code_commit,
        &args.code_tree,
        &authority_lock,
        d08_replay,
        d09_replay,
    )?;
    // verify_real_source_closeout_for_code already performs the independent
    // D08/D09 replay and exact code/authority validation. canonical_json()
    // re-validates the closeout commitment. Replaying the same upstream bytes
    // again here is redundant and materially increases terminal closeout time.
    let closeout_bytes = closeout.canonical_json()?;

    fs::create_dir_all(&args.output_dir)?;
    for file in &bundle.files {
        fs::write(args.output_dir.join(file.name), &file.bytes)?;
    }
    fs::write(
        args.output_dir.join(AUTHORITY_LOCK_ARCHIVE_FILE),
        authority_lock.canonical_json()?,
    )?;
    fs::write(
        args.output_dir.join(REAL_SOURCE_CLOSEOUT_FILE),
        &closeout_bytes,
    )?;

    println!(
        "RMC_011_CAPITAL_BUILD=PASS sources={} requirements={} feasible={} rejected={} d08_candidates={} d08_admitted={} d08_rejected={} d09_borrowers={} d09_below_one={} d09_blocked={} zero_own_capital_proven={} capital_commitment={} upstream_authority_commitment={} upstream_authority_lock_commitment={} closeout_commitment={} closeout_sha256={} output_dir={}",
        closeout.source_count,
        closeout.requirement_count,
        closeout.feasible_count,
        closeout.rejected_count,
        closeout.d08_candidate_count,
        closeout.d08_source_count,
        closeout.d08_rejected_count,
        closeout.d09_borrower_count,
        closeout.d09_below_one_count,
        closeout.d09_blocked_count,
        closeout.zero_own_capital_proven,
        closeout.capital_commitment,
        closeout.upstream_authority_commitment,
        closeout.upstream_authority_lock_commitment.to_hex(),
        closeout.closeout_commitment.to_hex(),
        sha256_hex(&closeout_bytes),
        args.output_dir.display(),
    );
    Ok(())
}
