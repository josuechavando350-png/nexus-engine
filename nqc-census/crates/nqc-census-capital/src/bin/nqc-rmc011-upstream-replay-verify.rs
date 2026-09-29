use nqc_census_capital::{
    artifacts::{
        CapitalArtifactBundle, CapitalArtifactFile, CAPITAL_EVIDENCE_MANIFEST_FILE,
        CAPITAL_FEASIBILITY_FILE, CAPITAL_REJECTION_LEDGER_FILE, CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_SOURCES_FILE, CAPITAL_SUMMARY_FILE, CAPITAL_UPSTREAM_AUTHORITY_FILE,
    },
    replay::{
        verify_real_source_closeout_for_code, D08ReplayInputs, D09ReplayInputs,
        UpstreamAuthorityLock,
    },
};
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs, path::PathBuf};

const CAPITAL_FILES: [&str; 7] = [
    CAPITAL_SOURCES_FILE,
    CAPITAL_REQUIREMENTS_FILE,
    CAPITAL_FEASIBILITY_FILE,
    CAPITAL_REJECTION_LEDGER_FILE,
    CAPITAL_SUMMARY_FILE,
    CAPITAL_UPSTREAM_AUTHORITY_FILE,
    CAPITAL_EVIDENCE_MANIFEST_FILE,
];

struct Args {
    capital_dir: PathBuf,
    d08_dir: PathBuf,
    d09_dir: PathBuf,
    authority_lock: PathBuf,
    closeout_path: PathBuf,
    expected_code_commit: String,
    expected_code_tree: String,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 14
        || args[0] != "--capital-dir"
        || args[2] != "--d08-dir"
        || args[4] != "--d09-dir"
        || args[6] != "--authority-lock"
        || args[8] != "--closeout"
        || args[10] != "--expected-code-commit"
        || args[12] != "--expected-code-tree"
    {
        return Err(
            "usage: nqc-rmc011-upstream-replay-verify --capital-dir <dir> --d08-dir <dir> --d09-dir <dir> --authority-lock <json> --closeout <json> --expected-code-commit <sha> --expected-code-tree <sha>"
                .into(),
        );
    }
    Ok(Args {
        capital_dir: PathBuf::from(&args[1]),
        d08_dir: PathBuf::from(&args[3]),
        d09_dir: PathBuf::from(&args[5]),
        authority_lock: PathBuf::from(&args[7]),
        closeout_path: PathBuf::from(&args[9]),
        expected_code_commit: args[11].clone(),
        expected_code_tree: args[13].clone(),
    })
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn main() -> Result<(), Box<dyn Error>> {
    let args = parse_args()?;
    let mut files = Vec::with_capacity(CAPITAL_FILES.len());
    for name in CAPITAL_FILES {
        let bytes = fs::read(args.capital_dir.join(name))?;
        files.push(CapitalArtifactFile {
            name,
            sha256: sha256(&bytes),
            bytes,
        });
    }
    let bundle = CapitalArtifactBundle { files };

    let d08_state = fs::read(args.d08_dir.join("market-state-manifest.jsonl"))?;
    let d08_tokens = fs::read(args.d08_dir.join("token-admission.jsonl"))?;
    let d08_facts = fs::read(args.d08_dir.join("pool-and-factory-facts.json"))?;
    let d08_manifest = fs::read(args.d08_dir.join("evidence-manifest.json"))?;

    let d09_accounts = fs::read(args.d09_dir.join("account-manifest.jsonl"))?;
    let d09_summary = fs::read(args.d09_dir.join("account-summary.json"))?;
    let d09_manifest = fs::read(args.d09_dir.join("evidence-manifest.json"))?;
    let authority_lock = UpstreamAuthorityLock::parse_json(&fs::read(&args.authority_lock)?)?;

    let closeout = verify_real_source_closeout_for_code(
        &bundle,
        &args.expected_code_commit,
        &args.expected_code_tree,
        &authority_lock,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_state,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )?;

    let closeout_bytes = closeout.canonical_json()?;
    fs::write(&args.closeout_path, &closeout_bytes)?;

    println!(
        "RMC_011_REAL_SOURCE_CLOSEOUT=PASS sources={} requirements={} feasible={} rejected={} d08_sources={} d09_requirements={} zero_own_capital_proven={} capital_commitment={} upstream_authority_commitment={} upstream_authority_lock_commitment={} closeout_commitment={} closeout_path={}",
        closeout.source_count,
        closeout.requirement_count,
        closeout.feasible_count,
        closeout.rejected_count,
        closeout.d08_source_count,
        closeout.d09_requirement_count,
        closeout.zero_own_capital_proven,
        closeout.capital_commitment,
        closeout.upstream_authority_commitment,
        closeout.upstream_authority_lock_commitment.to_hex(),
        closeout.closeout_commitment.to_hex(),
        args.closeout_path.display(),
    );
    Ok(())
}
