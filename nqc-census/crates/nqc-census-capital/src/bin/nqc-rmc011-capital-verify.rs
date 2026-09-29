use nqc_census_capital::artifacts::{
    verify_capital_artifact_bundle_for_code, CapitalArtifactBundle, CapitalArtifactFile,
    CAPITAL_EVIDENCE_MANIFEST_FILE, CAPITAL_FEASIBILITY_FILE, CAPITAL_REJECTION_LEDGER_FILE,
    CAPITAL_REQUIREMENTS_FILE, CAPITAL_SOURCES_FILE, CAPITAL_SUMMARY_FILE,
    CAPITAL_UPSTREAM_AUTHORITY_FILE,
};
use sha2::{Digest, Sha256};
use std::{env, error::Error, fs, path::PathBuf};

const FILES: [&str; 7] = [
    CAPITAL_SOURCES_FILE,
    CAPITAL_REQUIREMENTS_FILE,
    CAPITAL_FEASIBILITY_FILE,
    CAPITAL_REJECTION_LEDGER_FILE,
    CAPITAL_SUMMARY_FILE,
    CAPITAL_UPSTREAM_AUTHORITY_FILE,
    CAPITAL_EVIDENCE_MANIFEST_FILE,
];

struct Args {
    directory: PathBuf,
    expected_code_commit: String,
    expected_code_tree: String,
}

fn parse_args() -> Result<Args, Box<dyn Error>> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.len() != 6
        || args[0] != "--dir"
        || args[2] != "--expected-code-commit"
        || args[4] != "--expected-code-tree"
    {
        return Err(
            "usage: nqc-rmc011-capital-verify --dir <artifact-directory> --expected-code-commit <sha> --expected-code-tree <sha>"
                .into(),
        );
    }
    Ok(Args {
        directory: PathBuf::from(&args[1]),
        expected_code_commit: args[3].clone(),
        expected_code_tree: args[5].clone(),
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
    let mut files = Vec::with_capacity(FILES.len());
    for name in FILES {
        let bytes = fs::read(args.directory.join(name))?;
        files.push(CapitalArtifactFile {
            name,
            sha256: sha256(&bytes),
            bytes,
        });
    }

    let verified = verify_capital_artifact_bundle_for_code(
        &CapitalArtifactBundle { files },
        &args.expected_code_commit,
        &args.expected_code_tree,
    )?;
    println!(
        "RMC_011_OFFLINE_VERIFY=PASS sources={} requirements={} feasible={} rejected={} commitment={} upstream={}",
        verified.source_count,
        verified.requirement_count,
        verified.feasibility_count,
        verified.rejection_count,
        verified.capital_commitment,
        verified.upstream_authority_commitment,
    );
    Ok(())
}
