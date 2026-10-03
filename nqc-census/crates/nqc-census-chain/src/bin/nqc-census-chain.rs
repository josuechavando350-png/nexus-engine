//! `nqc-census-chain bootstrap --providers FILE --store DIR --anchor N --out FILE`
//!     Establishes the chain domain and the verified anchor of block N on every
//!     declared provider, persists every exchange in the RMC-004 store, and
//!     writes a canonical report. Fails closed unless all providers agree.
//!
//! `nqc-census-chain verify --providers FILE --store DIR --report FILE`
//!     Offline: replays every recorded bootstrap and anchor job from the store
//!     and requires the report to reproduce byte-for-byte.

use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::bootstrap::{run_bootstrap, verify_bootstrap};
use nqc_census_chain::ethereum::ChainProfile;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_chain::ChainError;
use nqc_census_store::{Store, StoreConfig};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

struct Args {
    command: String,
    providers: PathBuf,
    store: PathBuf,
    anchor: Option<u64>,
    out: Option<PathBuf>,
    report: Option<PathBuf>,
}

fn parse() -> Result<Args, ChainError> {
    let mut items = std::env::args().skip(1);
    let command = items
        .next()
        .ok_or_else(|| ChainError::Config("missing command".into()))?;
    let mut args = Args {
        command,
        providers: PathBuf::new(),
        store: PathBuf::new(),
        anchor: None,
        out: None,
        report: None,
    };
    while let Some(flag) = items.next() {
        let value = items
            .next()
            .ok_or_else(|| ChainError::Config(format!("{flag} needs a value")))?;
        match flag.as_str() {
            "--providers" => args.providers = PathBuf::from(value),
            "--store" => args.store = PathBuf::from(value),
            "--anchor" => {
                args.anchor = Some(
                    value
                        .parse()
                        .map_err(|_| ChainError::Config("anchor must be a block number".into()))?,
                );
            }
            "--out" => args.out = Some(PathBuf::from(value)),
            "--report" => args.report = Some(PathBuf::from(value)),
            other => return Err(ChainError::Config(format!("unknown flag {other}"))),
        }
    }
    Ok(args)
}

fn read(path: &Path) -> Result<Vec<u8>, ChainError> {
    std::fs::read(path).map_err(|error| ChainError::Config(format!("{}: {error}", path.display())))
}

fn bootstrap(args: &Args) -> Result<(), ChainError> {
    let providers = ProviderSet::parse(&read(&args.providers)?)?;
    let anchor_number = args
        .anchor
        .ok_or_else(|| ChainError::Config("--anchor is required".into()))?;
    let profile = ChainProfile::mainnet()?;
    let store = if args.store.exists() {
        Store::open(&args.store, &StoreConfig::standard())?
    } else {
        Store::create(&args.store, StoreConfig::standard())?
    };
    let transport = CurlTransport::new(120, 20);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());

    let (report, chain, anchor) = run_bootstrap(&acquisition, &providers, &profile, anchor_number)?;
    for record in report
        .get("providers")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("report without providers".into()))?
    {
        println!(
            "CHAIN_BOOTSTRAP provider={} client={:?} fork_lineage={} anchor={} hash={}",
            record
                .get("provider")
                .ok_or_else(|| ChainError::Evidence("record without provider".into()))?
                .str_field("label")?,
            record.str_field("client_version")?,
            chain.fork_lineage().to_hex(),
            anchor.block_number(),
            anchor.block_hash().to_hex()
        );
    }
    let out = args
        .out
        .as_ref()
        .ok_or_else(|| ChainError::Config("--out is required".into()))?;
    std::fs::write(out, report.canonical()?)
        .map_err(|error| ChainError::Config(format!("{}: {error}", out.display())))?;
    println!("CHAIN_BOOTSTRAP_PASS providers={}", providers.len());
    Ok(())
}

fn verify(args: &Args) -> Result<(), ChainError> {
    let providers = ProviderSet::parse(&read(&args.providers)?)?;
    let report_path = args
        .report
        .as_ref()
        .ok_or_else(|| ChainError::Config("--report is required".into()))?;
    let report = Json::parse(&read(report_path)?)?;
    let store = Store::open_existing(&args.store)?;
    let profile = ChainProfile::mainnet()?;
    let (chain, anchor) = verify_bootstrap(&store, &providers, &profile, &report)?;
    for provider in providers.iter() {
        println!("CHAIN_REPLAY_PASS provider={}", provider.label());
    }
    println!(
        "CHAIN_REPLAYED_ANCHOR fork_lineage={} anchor={} hash={}",
        chain.fork_lineage().to_hex(),
        anchor.block_number(),
        anchor.block_hash().to_hex()
    );
    println!("CHAIN_OFFLINE_VERIFY_PASS providers={}", providers.len());
    Ok(())
}

fn main() -> ExitCode {
    let result = parse().and_then(|args| match args.command.as_str() {
        "bootstrap" => bootstrap(&args),
        "verify" => verify(&args),
        other => Err(ChainError::Config(format!("unknown command {other}"))),
    });
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("CHAIN_FAIL code={} reason={error}", error.code());
            ExitCode::FAILURE
        }
    }
}
