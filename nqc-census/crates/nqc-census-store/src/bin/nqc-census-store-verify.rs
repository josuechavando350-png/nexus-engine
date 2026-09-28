use nqc_census_store::{CensusStore, ScopeId};
use std::path::PathBuf;
use std::process::ExitCode;

fn usage() {
    eprintln!(
        "usage: nqc-census-store-verify <store-root> <scope-id-hex> <expected-from> <expected-to>"
    );
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os();
    let _program = args.next();
    let root = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "missing store root".to_owned())?;
    let scope = args
        .next()
        .ok_or_else(|| "missing scope id".to_owned())?
        .into_string()
        .map_err(|_| "scope id must be UTF-8".to_owned())?;
    let expected_from = args
        .next()
        .ok_or_else(|| "missing expected-from".to_owned())?
        .into_string()
        .map_err(|_| "expected-from must be UTF-8".to_owned())?
        .parse::<u64>()
        .map_err(|_| "expected-from must be u64".to_owned())?;
    let expected_to = args
        .next()
        .ok_or_else(|| "missing expected-to".to_owned())?
        .into_string()
        .map_err(|_| "expected-to must be UTF-8".to_owned())?
        .parse::<u64>()
        .map_err(|_| "expected-to must be u64".to_owned())?;
    if args.next().is_some() {
        return Err("unexpected extra arguments".to_owned());
    }

    let scope = ScopeId::parse_hex(&scope).map_err(|error| error.to_string())?;
    let store = CensusStore::open(root).map_err(|error| error.to_string())?;
    let verified = store
        .verify_range(scope, expected_from, expected_to)
        .map_err(|error| error.to_string())?;

    println!(
        "RMC_STORE_VERIFY_PASS scope={} checkpoints={} range={}..={} head={}",
        verified.scope_id.to_hex(),
        verified.checkpoint_count,
        verified.from_block,
        verified.to_block,
        verified.head_digest.to_hex()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            usage();
            eprintln!("RMC_STORE_VERIFY_FAIL {error}");
            ExitCode::FAILURE
        }
    }
}
