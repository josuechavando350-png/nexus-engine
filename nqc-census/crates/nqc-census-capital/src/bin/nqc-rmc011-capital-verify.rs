use nqc_census_capital::artifacts::{
    verify_capital_artifact_bundle, CapitalArtifactBundle, CapitalArtifactFile,
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

fn parse_dir() -> Result<PathBuf, Box<dyn Error>> {
    let mut args = env::args().skip(1);
    match (args.next().as_deref(), args.next(), args.next()) {
        (Some("--dir"), Some(path), None) => Ok(PathBuf::from(path)),
        _ => Err("usage: nqc-rmc011-capital-verify --dir <artifact-directory>".into()),
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(bytes);
    let mut out = [0_u8; 32];
    out.copy_from_slice(&digest);
    out
}

fn main() -> Result<(), Box<dyn Error>> {
    let directory = parse_dir()?;
    let mut files = Vec::with_capacity(FILES.len());
    for name in FILES {
        let bytes = fs::read(directory.join(name))?;
        files.push(CapitalArtifactFile {
            name,
            sha256: sha256(&bytes),
            bytes,
        });
    }

    let verified = verify_capital_artifact_bundle(&CapitalArtifactBundle { files })?;
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
