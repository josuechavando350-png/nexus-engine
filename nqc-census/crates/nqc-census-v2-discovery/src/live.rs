use crate::{factory_interface, verify_factory_runtime};
use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    bootstrap::run_bootstrap,
    consensus::{agree, ProviderResult},
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, CallOutcome, CensusObservation, ContractCallEnvelope, StateAnchor,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::Path};

const ANCHOR_NUMBER: u64 = 25_437_474;
const ANCHOR_HASH: &str = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const CURRENT_NAMESPACE: u16 = 0x0701;

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn returned(observation: &CensusObservation<ContractCallEnvelope>) -> Result<&[u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(
            "required V2 current-surface call reverted".into(),
        )),
    }
}

fn required_address(bytes: &[u8], label: &'static str) -> Result<Address, ChainError> {
    let word = abi::single_word(bytes)?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} returned zero address")))?;
    Ok(Address::new(raw)?)
}

fn required_u64(bytes: &[u8], label: &'static str) -> Result<u64, ChainError> {
    let word = abi::single_word(bytes)?;
    abi::decode_u64(&word)
        .map_err(|error| ChainError::Evidence(format!("{label} decode failed: {error}")))
}

fn pair_endpoint(
    ctx: &mut nqc_census_chain::job::JobContext<'_>,
    pair: Address,
    factory: Address,
    anchor: &StateAnchor,
) -> Result<Json, ChainError> {
    let interface = factory_interface();
    let semantics = chain_read_semantics()?;
    let calls = ctx.calls(
        &[
            (pair, abi::encode_call(interface.token0, &[])),
            (pair, abi::encode_call(interface.token1, &[])),
        ],
        anchor,
        semantics,
    )?;
    if calls.len() != 2 {
        return Err(ChainError::Evidence(
            "V2 endpoint token call count differs".into(),
        ));
    }
    let token0 = required_address(returned(&calls[0])?, "token0")?;
    let token1 = required_address(returned(&calls[1])?, "token1")?;
    if token0 >= token1 {
        return Err(ChainError::Evidence(
            "V2 pair token ordering is not canonical".into(),
        ));
    }
    let membership = ctx.call(
        factory,
        abi::encode_call(
            interface.get_pair,
            &[
                abi::address_word(token0.as_bytes()),
                abi::address_word(token1.as_bytes()),
            ],
        ),
        anchor,
        semantics,
    )?;
    let rebound = required_address(returned(&membership)?, "getPair")?;
    if rebound != pair {
        return Err(ChainError::Evidence(
            "V2 endpoint does not round-trip through factory getPair".into(),
        ));
    }
    let code = ctx.code(pair, anchor, semantics)?;
    if code.payload().is_absent() {
        return Err(ChainError::Evidence(
            "V2 endpoint pair has no runtime code".into(),
        ));
    }
    Ok(Json::object([
        ("pair", Json::string(pair.to_hex())),
        ("token0", Json::string(token0.to_hex())),
        ("token1", Json::string(token1.to_hex())),
        (
            "runtime_sha256",
            Json::string(sha256_plain(code.payload().code())),
        ),
    ]))
}

fn provider_current_facts(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &nqc_census_core::ChainDomain,
    anchor: &StateAnchor,
) -> Result<ProviderResult, ChainError> {
    let factory = Address::parse_hex(FACTORY)?;
    let interface = factory_interface();
    let spec = JobSpec::new(
        "rmc007-v2-current-surface",
        1,
        CURRENT_NAMESPACE,
        Json::object([
            ("anchor", Json::uint(anchor.block_number())),
            ("factory", Json::string(factory.to_hex())),
        ]),
    )?;
    let output = acquisition.point(provider, chain, None, &spec, anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let factory_code = ctx.code(factory, anchor, semantics)?;
        verify_factory_runtime(factory_code.payload().code())
            .map_err(|error| ChainError::Evidence(error.to_string()))?;
        let factory_runtime_sha256 = sha256_plain(factory_code.payload().code());

        let count_call = ctx.call(
            factory,
            abi::encode_call(interface.all_pairs_length, &[]),
            anchor,
            semantics,
        )?;
        let pair_count = required_u64(returned(&count_call)?, "allPairsLength")?;
        if pair_count == 0 {
            return Err(ChainError::Evidence(
                "Uniswap V2 factory reports zero pairs".into(),
            ));
        }

        let last_index = pair_count - 1;
        let endpoints = ctx.calls(
            &[
                (
                    factory,
                    abi::encode_call(interface.all_pairs, &[abi::uint_word(0)]),
                ),
                (
                    factory,
                    abi::encode_call(interface.all_pairs, &[abi::uint_word(last_index)]),
                ),
            ],
            anchor,
            semantics,
        )?;
        if endpoints.len() != 2 {
            return Err(ChainError::Evidence(
                "V2 endpoint enumeration call count differs".into(),
            ));
        }
        let first_pair = required_address(returned(&endpoints[0])?, "allPairs(0)")?;
        let last_pair = required_address(returned(&endpoints[1])?, "allPairs(last)")?;
        if pair_count > 1 && first_pair == last_pair {
            return Err(ChainError::Evidence(
                "V2 first and last factory pair unexpectedly collide".into(),
            ));
        }
        let first = pair_endpoint(ctx, first_pair, factory, anchor)?;
        let last = pair_endpoint(ctx, last_pair, factory, anchor)?;

        Ok(Json::object([
            ("factory", Json::string(factory.to_hex())),
            (
                "factory_runtime_sha256",
                Json::string(factory_runtime_sha256),
            ),
            ("pair_count", Json::uint(pair_count)),
            ("first_index", Json::uint(0)),
            ("first_pair", first),
            ("last_index", Json::uint(last_index)),
            ("last_pair", last),
        ]))
    })?;
    Ok(ProviderResult {
        provider: provider.label().to_owned(),
        manifest: output.manifest_id().to_hex(),
        result: output.result_json()?,
    })
}

pub fn run_current_surface(
    providers_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let store = Store::create(store_path, StoreConfig::standard())?;
    let transport = CurlTransport::new(60, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(&acquisition, &providers, &profile, ANCHOR_NUMBER)?;
    if anchor.block_hash().to_hex() != ANCHOR_HASH {
        return Err(ChainError::Evidence("D07 observation anchor hash differs".into()).into());
    }

    let mut results = Vec::new();
    for provider in providers.iter() {
        results.push(provider_current_facts(
            &acquisition,
            provider,
            &chain,
            &anchor,
        )?);
    }
    let agreement = agree("rmc007-v2-current-surface", &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;

    Ok(Json::object([
        ("schema", Json::string("nqc-rmc-007-v2-current-surface-v1")),
        ("status", Json::string("CURRENT_SURFACE_PASS")),
        ("bootstrap", bootstrap),
        ("facts", agreement.result),
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
                Json::string("FULL_FACTORY_ENUMERATION_NOT_YET_CERTIFIED"),
                Json::string("PAIR_CREATED_HISTORY_NOT_YET_CERTIFIED"),
                Json::string("D05_ADMISSION_NOT_YET_MATERIALIZED"),
                Json::string("RMC007_NOT_YET_PASS"),
            ]),
        ),
    ]))
}
