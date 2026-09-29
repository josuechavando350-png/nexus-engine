use nqc_census_chain::{
    acquire::Acquisition,
    bootstrap::run_bootstrap,
    boundary::earliest_code_body,
    consensus::{agree, ProviderResult},
    ethereum::ChainProfile,
    job::JobSpec,
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::Address;
use nqc_census_store::{Store, StoreConfig};
use std::{error::Error, fs, path::Path};

const ANCHOR_NUMBER: u64 = 25_437_474;
const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const BOUNDARY_NAMESPACE: u16 = 0x0702;

fn provider_boundary(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &nqc_census_core::ChainDomain,
    factory: Address,
) -> Result<ProviderResult, ChainError> {
    let spec = JobSpec::new(
        "rmc007-v2-factory-boundary",
        1,
        BOUNDARY_NAMESPACE,
        Json::object([
            ("factory", Json::string(factory.to_hex())),
            ("lo", Json::uint(1)),
            ("hi", Json::uint(ANCHOR_NUMBER)),
        ]),
    )?;
    let output = acquisition.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
        earliest_code_body(ctx, factory, 1, ANCHOR_NUMBER)
    })?;
    Ok(ProviderResult {
        provider: provider.label().to_owned(),
        manifest: output.manifest_id().to_hex(),
        result: output.result_json()?,
    })
}

pub fn run_factory_boundary(
    providers_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let store = Store::open(store_path, &StoreConfig::standard())?;
    let transport = CurlTransport::new(60, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    Ok(factory_boundary_with(&acquisition, &providers)?)
}

/// The factory's earliest-code boundary through `acquisition` (live or replay).
pub fn factory_boundary_with(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
) -> Result<Json, ChainError> {
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, _) = run_bootstrap(acquisition, providers, &profile, ANCHOR_NUMBER)?;
    let factory = Address::parse_hex(FACTORY)?;

    let mut results = Vec::new();
    for provider in providers.iter() {
        results.push(provider_boundary(acquisition, provider, &chain, factory)?);
    }
    let agreement = agree("rmc007-v2-factory-boundary", &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let first_code_block = agreement
        .result
        .get("first_code_block")
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence("factory boundary has no block".into()))?;
    let predecessor = first_code_block
        .checked_sub(1)
        .ok_or_else(|| ChainError::Evidence("factory boundary underflow".into()))?;

    Ok(Json::object([
        ("schema", Json::string("nqc-rmc-007-v2-factory-boundary-v1")),
        ("status", Json::string("FACTORY_BOUNDARY_PASS")),
        ("bootstrap", bootstrap),
        ("factory", Json::string(factory.to_hex())),
        ("first_code_block", Json::uint(first_code_block)),
        ("predecessor_block", Json::uint(predecessor)),
        ("proof", agreement.result),
        (
            "provider_manifests",
            Json::array(results.iter().map(|result| {
                Json::object([
                    ("provider", Json::string(result.provider.clone())),
                    ("manifest", Json::string(result.manifest.clone())),
                ])
            })),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("PAIR_CREATED_HISTORY_NOT_YET_CERTIFIED"),
                Json::string("FULL_FACTORY_ENUMERATION_NOT_YET_CERTIFIED"),
                Json::string("RMC007_NOT_YET_PASS"),
            ]),
        ),
    ]))
}
