//! `nqc-census-chain bootstrap --providers FILE --store DIR --anchor N --out FILE`
//!     Establishes the chain domain and the verified anchor of block N on every
//!     declared provider, persists every exchange in the RMC-004 store, and
//!     writes a canonical report. Fails closed unless all providers agree.
//!
//! `nqc-census-chain verify --providers FILE --store DIR --report FILE`
//!     Offline: replays every recorded bootstrap and anchor job from the store
//!     and requires the report to reproduce byte-for-byte.

use nqc_census_chain::acquire::{
    anchor_body, anchor_from_result, anchor_record, anchor_spec, bootstrap_spec, Acquisition,
};
use nqc_census_chain::consensus::{agree, ProviderResult};
use nqc_census_chain::ethereum::ChainProfile;
use nqc_census_chain::job::verify_job_replay;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSet;
use nqc_census_chain::transport::{CurlTransport, RetryPolicy};
use nqc_census_chain::ChainError;
use nqc_census_core::{ChainDomain, Hash32};
use nqc_census_store::{ArtifactId, Store, StoreConfig};
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

    let mut domains = Vec::new();
    let mut anchors = Vec::new();
    let mut records = Vec::new();
    for provider in providers.iter() {
        let (facts, bootstrap_output) = acquisition.bootstrap(provider, &profile)?;
        let (anchor, anchor_output) =
            acquisition.resolve_anchor(provider, &facts.chain, anchor_number)?;
        println!(
            "CHAIN_BOOTSTRAP provider={} client={:?} fork_lineage={} anchor={} hash={}",
            provider.label(),
            facts.client_version,
            facts.chain.fork_lineage().to_hex(),
            anchor.block_number(),
            anchor.block_hash().to_hex()
        );
        domains.push(ProviderResult {
            provider: provider.label().to_owned(),
            manifest: bootstrap_output.manifest_id().to_hex(),
            result: bootstrap_output.result_json()?,
        });
        anchors.push(ProviderResult {
            provider: provider.label().to_owned(),
            manifest: anchor_output.manifest_id().to_hex(),
            result: anchor_output.result_json()?,
        });
        records.push(Json::object([
            ("provider", provider.descriptor()),
            ("client_version", Json::string(facts.client_version)),
            (
                "bootstrap_manifest",
                Json::string(bootstrap_output.manifest_id().to_hex()),
            ),
            (
                "anchor_manifest",
                Json::string(anchor_output.manifest_id().to_hex()),
            ),
        ]));
    }
    let domain = agree("chain_domain", &domains)?
        .map_err(|_| ChainError::Consensus("providers disagree on the chain domain"))?;
    let anchor = agree("anchor", &anchors)?
        .map_err(|_| ChainError::Consensus("providers disagree on the anchor"))?;
    let report = Json::object([
        (
            "schema",
            Json::string("nqc-census-chain-bootstrap-report-v1"),
        ),
        ("chain_domain", domain.result),
        ("anchor", anchor.result),
        ("providers", Json::Array(records)),
        ("provider_count", Json::uint(providers.len() as u64)),
        (
            "infrastructure_independence",
            Json::string("NOT_PROVEN_DISTINCT_DECLARED_OPERATORS"),
        ),
    ]);
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
    let domain_json = report
        .get("chain_domain")
        .ok_or_else(|| ChainError::Evidence("report without chain domain".into()))?;
    let chain = ChainDomain::new(
        profile.chain_id(),
        Hash32::parse_hex(domain_json.str_field("genesis_hash")?)?,
        Hash32::parse_hex(domain_json.str_field("fork_lineage")?)?,
    )?;
    let anchor_number = report
        .get("anchor")
        .and_then(|a| a.get("anchor"))
        .and_then(|a| a.get("number"))
        .and_then(Json::as_i64)
        .and_then(|n| u64::try_from(n).ok())
        .ok_or_else(|| ChainError::Evidence("report without anchor number".into()))?;
    let records = report
        .get("providers")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("report without providers".into()))?;
    if records.len() != providers.len() {
        return Err(ChainError::Evidence(
            "report and provider set differ".into(),
        ));
    }
    for (provider, record) in providers.iter().zip(records) {
        let bootstrap_manifest = ArtifactId::parse_hex(record.str_field("bootstrap_manifest")?)?;
        let output = verify_job_replay(
            &store,
            &bootstrap_manifest,
            provider,
            None,
            &bootstrap_spec(&profile)?,
            |ctx| nqc_census_chain::acquire::replay_bootstrap(ctx, &profile),
        )?;
        if output.result_json()? != *domain_json {
            return Err(ChainError::Evidence("replayed chain domain differs".into()));
        }
        let anchor_manifest = ArtifactId::parse_hex(record.str_field("anchor_manifest")?)?;
        let output = verify_job_replay(
            &store,
            &anchor_manifest,
            provider,
            Some(chain.clone()),
            &anchor_spec(anchor_number)?,
            |ctx| anchor_body(ctx, anchor_number),
        )?;
        let anchor = anchor_from_result(&chain, &output.result_json()?, "anchor")?;
        if Json::object([("anchor", anchor_record(&anchor))])
            != *report
                .get("anchor")
                .ok_or_else(|| ChainError::Evidence("anchor".into()))?
        {
            return Err(ChainError::Evidence("replayed anchor differs".into()));
        }
        println!("CHAIN_REPLAY_PASS provider={}", provider.label());
    }
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
