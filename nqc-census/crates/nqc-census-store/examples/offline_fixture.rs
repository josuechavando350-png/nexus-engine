use nqc_census_core::{ChainDomain, Hash32};
use nqc_census_store::{CensusStore, RangeCheckpoint, RangeScope};
use std::path::PathBuf;
use std::process::ExitCode;

fn hash(byte: u8) -> Result<Hash32, String> {
    Hash32::new([byte; 32]).map_err(|error| error.to_string())
}

fn run() -> Result<(), String> {
    let mut args = std::env::args_os();
    let _program = args.next();
    let root = args
        .next()
        .map(PathBuf::from)
        .ok_or_else(|| "missing fixture root".to_owned())?;
    if args.next().is_some() {
        return Err("unexpected extra arguments".to_owned());
    }

    let chain = ChainDomain::new(1, hash(0x11)?, hash(0x12)?).map_err(|error| error.to_string())?;
    let scope = RangeScope::new(chain, hash(0x21)?, 1).map_err(|error| error.to_string())?;
    let store = CensusStore::create(&root, 64).map_err(|error| error.to_string())?;

    let first_artifact = store
        .put_artifact(b"fixture blocks 100 through 109")
        .map_err(|error| error.to_string())?;
    let first = RangeCheckpoint::new(
        scope.clone(),
        1,
        100,
        109,
        hash(0x30)?,
        hash(0x31)?,
        first_artifact,
        None,
    )
    .map_err(|error| error.to_string())?;
    let first_commit = store
        .commit_checkpoint(&first)
        .map_err(|error| error.to_string())?;

    let second_artifact = store
        .put_artifact(b"fixture blocks 110 through 119")
        .map_err(|error| error.to_string())?;
    let second = RangeCheckpoint::new(
        scope.clone(),
        2,
        110,
        119,
        hash(0x31)?,
        hash(0x32)?,
        second_artifact,
        Some(first_commit.checkpoint_digest),
    )
    .map_err(|error| error.to_string())?;
    store
        .commit_checkpoint(&second)
        .map_err(|error| error.to_string())?;

    println!(
        "RMC_STORE_FIXTURE_PASS scope={} from=100 to=119",
        scope.id().to_hex()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("RMC_STORE_FIXTURE_FAIL {error}");
            ExitCode::FAILURE
        }
    }
}
