use nqc_census_chain::{
    abi,
    bootstrap::run_bootstrap,
    consensus::{agree, ProviderResult},
    evm::CodeScan,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    Acquisition, ChainError, ChainProfile,
};
use nqc_census_core::{
    Address, CallOutcome, CensusObservation, ContractCallEnvelope, DeploymentKey, Hash32,
    ObservationSemantics, ProtocolFamily,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::Path};

use crate::{aave_interface, verify_pool_runtime};

const ANCHOR_NUMBER: u64 = 25_437_474;
const ANCHOR_HASH: &str = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
const ADDRESSES_PROVIDER: &str = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e";
const POOL: &str = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const POOL_IMPLEMENTATION: &str = "0x728a138a4823392c2efa55e028d434f526fe03cf";

const PROVIDER_CODE_SHA256: &str =
    "e5416052b67aa0475bffe5707510a1981ffcc131d9b49066d51f6e25eb6c5c9f";
const POOL_PROXY_CODE_SHA256: &str =
    "bf8a408a1f5440c167d91fa2d972deb23bb4d809e8dd089009885ec88a826f88";
const POOL_IMPLEMENTATION_CODE_SHA256: &str =
    "fbd5bf315821d290d18b3a06cafb2f69457075388eae50b6134f490cf83cb049";

const CURRENT_NAMESPACE: u16 = 0x0601;

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn require_sha256(label: &'static str, bytes: &[u8], expected: &str) -> Result<String, ChainError> {
    let actual = sha256_plain(bytes);
    if actual != expected {
        return Err(ChainError::Evidence(format!(
            "{label} runtime sha256 differs: expected {expected}, got {actual}"
        )));
    }
    Ok(actual)
}

fn returned(observation: &CensusObservation<ContractCallEnvelope>) -> Result<&[u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(
            "required current-surface getter reverted".into(),
        )),
    }
}

fn required_address(bytes: &[u8], label: &'static str) -> Result<Address, ChainError> {
    let word = abi::single_word(bytes)?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} returned zero address")))?;
    Ok(Address::new(raw)?)
}

fn optional_address(word: &[u8; 32]) -> Result<Json, ChainError> {
    Ok(match abi::decode_address(word)? {
        Some(raw) => Json::string(Address::new(raw)?.to_hex()),
        None => Json::Null,
    })
}

fn uint16(bytes: &[u8], label: &'static str) -> Result<u16, ChainError> {
    let word = abi::single_word(bytes)?;
    let value = abi::decode_u64(&word)?;
    u16::try_from(value).map_err(|_| ChainError::Evidence(format!("{label} exceeds uint16")))
}

fn reserve_record(
    reserve_id: u16,
    asset: Address,
    reserve_data: &[u8],
) -> Result<Json, ChainError> {
    let words = abi::words(reserve_data)?;
    if words.len() != 15 {
        return Err(ChainError::Evidence(format!(
            "getReserveData for {} returned {} words, expected 15",
            asset.to_hex(),
            words.len()
        )));
    }
    let observed_id = abi::decode_u64(&words[7])?;
    if observed_id != u64::from(reserve_id) {
        return Err(ChainError::Evidence(format!(
            "reserve {} id mismatch: expected {}, got {}",
            asset.to_hex(),
            reserve_id,
            observed_id
        )));
    }
    let a_token = abi::decode_address(&words[8])?
        .ok_or_else(|| ChainError::Evidence("reserve has zero aToken".into()))?;
    let variable_debt = abi::decode_address(&words[10])?
        .ok_or_else(|| ChainError::Evidence("reserve has zero variable debt token".into()))?;
    Ok(Json::object([
        ("reserve_id", Json::uint(u64::from(reserve_id))),
        ("asset", Json::string(asset.to_hex())),
        ("a_token", Json::string(Address::new(a_token)?.to_hex())),
        ("stable_debt_token", optional_address(&words[9])?),
        (
            "variable_debt_token",
            Json::string(Address::new(variable_debt)?.to_hex()),
        ),
        ("interest_rate_strategy", optional_address(&words[11])?),
    ]))
}

fn current_semantics() -> Result<ObservationSemantics, ChainError> {
    Ok(ObservationSemantics::new(
        Hash32::parse_hex(&format!("0x{POOL_IMPLEMENTATION_CODE_SHA256}"))?,
        Hash32::parse_hex(&format!("0x{POOL_PROXY_CODE_SHA256}"))?,
    ))
}

fn provider_current_facts(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &nqc_census_core::ChainDomain,
    anchor: &nqc_census_core::StateAnchor,
) -> Result<ProviderResult, ChainError> {
    let addresses_provider = Address::parse_hex(ADDRESSES_PROVIDER)?;
    let pool = Address::parse_hex(POOL)?;
    let implementation = Address::parse_hex(POOL_IMPLEMENTATION)?;
    let deployment = DeploymentKey::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        pool,
        Hash32::parse_hex(&format!("0x{POOL_IMPLEMENTATION_CODE_SHA256}"))?,
    );
    let interface = aave_interface();
    let spec = JobSpec::new(
        "rmc006-aave-current-surface",
        1,
        CURRENT_NAMESPACE,
        Json::object([
            ("anchor", Json::uint(anchor.block_number())),
            ("pool", Json::string(pool.to_hex())),
            (
                "addresses_provider",
                Json::string(addresses_provider.to_hex()),
            ),
        ]),
    )?;
    let output = acquisition.point(provider, chain, Some(deployment), &spec, anchor, |ctx| {
        let chain_semantics = chain_read_semantics()?;
        let code = ctx.codes(
            &[addresses_provider, pool, implementation],
            anchor,
            chain_semantics,
        )?;
        let provider_code = code
            .first()
            .ok_or_else(|| ChainError::Evidence("provider code observation missing".into()))?;
        let pool_code = code
            .get(1)
            .ok_or_else(|| ChainError::Evidence("pool code observation missing".into()))?;
        let implementation_code = code.get(2).ok_or_else(|| {
            ChainError::Evidence("pool implementation code observation missing".into())
        })?;
        let provider_hash = require_sha256(
            "addresses provider",
            provider_code.payload().code(),
            PROVIDER_CODE_SHA256,
        )?;
        let pool_hash = require_sha256(
            "pool proxy",
            pool_code.payload().code(),
            POOL_PROXY_CODE_SHA256,
        )?;
        let implementation_hash = require_sha256(
            "pool implementation",
            implementation_code.payload().code(),
            POOL_IMPLEMENTATION_CODE_SHA256,
        )?;
        verify_pool_runtime(implementation_code.payload().code())
            .map_err(|error| ChainError::Evidence(error.to_string()))?;

        let provider_scan = CodeScan::new(provider_code.payload().code());
        for selector in [interface.get_pool, interface.get_pool_configurator] {
            if !provider_scan.has_selector(selector) {
                return Err(ChainError::Evidence(
                    "AddressesProvider runtime lacks required selector".into(),
                ));
            }
        }

        let semantics = current_semantics()?;
        let calls = ctx.calls(
            &[
                (
                    addresses_provider,
                    abi::encode_call(interface.get_pool, &[]),
                ),
                (
                    addresses_provider,
                    abi::encode_call(interface.get_pool_configurator, &[]),
                ),
                (pool, abi::encode_call(interface.addresses_provider, &[])),
                (pool, abi::encode_call(interface.reserves_count, &[])),
            ],
            anchor,
            semantics,
        )?;
        if calls.len() != 4 {
            return Err(ChainError::Evidence(
                "current-surface base call count differs".into(),
            ));
        }
        let observed_pool = required_address(returned(&calls[0])?, "getPool")?;
        if observed_pool != pool {
            return Err(ChainError::Evidence(
                "AddressesProvider getPool differs from certified Pool".into(),
            ));
        }
        let configurator = required_address(returned(&calls[1])?, "getPoolConfigurator")?;
        let observed_provider = required_address(returned(&calls[2])?, "ADDRESSES_PROVIDER")?;
        if observed_provider != addresses_provider {
            return Err(ChainError::Evidence(
                "Pool ADDRESSES_PROVIDER differs from declared root".into(),
            ));
        }
        let reserve_count = uint16(returned(&calls[3])?, "getReservesCount")?;

        let configurator_code = ctx.code(configurator, anchor, chain_semantics)?;
        if configurator_code.payload().is_absent() {
            return Err(ChainError::Evidence(
                "PoolConfigurator has no runtime code".into(),
            ));
        }
        let configurator_hash = sha256_plain(configurator_code.payload().code());

        let mut address_requests = Vec::with_capacity(usize::from(reserve_count));
        for reserve_id in 0..reserve_count {
            address_requests.push((
                pool,
                abi::encode_call(
                    interface.reserve_by_id,
                    &[abi::uint_word(u64::from(reserve_id))],
                ),
            ));
        }
        let address_calls = ctx.calls(&address_requests, anchor, semantics)?;
        let mut assets = Vec::with_capacity(address_calls.len());
        for call in &address_calls {
            assets.push(required_address(returned(call)?, "getReserveAddressById")?);
        }
        if assets
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != assets.len()
        {
            return Err(ChainError::Evidence(
                "duplicate reserve address in current enumeration".into(),
            ));
        }

        let data_requests: Vec<_> = assets
            .iter()
            .map(|asset| {
                (
                    pool,
                    abi::encode_call(
                        interface.reserve_data,
                        &[abi::address_word(asset.as_bytes())],
                    ),
                )
            })
            .collect();
        let data_calls = ctx.calls(&data_requests, anchor, semantics)?;
        let mut reserves = Vec::with_capacity(data_calls.len());
        for (index, (asset, call)) in assets.iter().zip(&data_calls).enumerate() {
            let reserve_id = u16::try_from(index)
                .map_err(|_| ChainError::Evidence("reserve index exceeds uint16".into()))?;
            reserves.push(reserve_record(reserve_id, *asset, returned(call)?)?);
        }

        Ok(Json::object([
            ("pool", Json::string(pool.to_hex())),
            (
                "addresses_provider",
                Json::string(addresses_provider.to_hex()),
            ),
            ("pool_configurator", Json::string(configurator.to_hex())),
            ("reserve_count", Json::uint(u64::from(reserve_count))),
            ("reserves", Json::Array(reserves)),
            (
                "runtime_sha256",
                Json::object([
                    ("addresses_provider", Json::string(provider_hash)),
                    ("pool_proxy", Json::string(pool_hash)),
                    ("pool_implementation", Json::string(implementation_hash)),
                    ("pool_configurator", Json::string(configurator_hash)),
                ]),
            ),
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
    if anchor.block_hash() != Hash32::parse_hex(ANCHOR_HASH)? {
        return Err(ChainError::Evidence("D06 observation anchor hash differs".into()).into());
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
    let agreement = agree("rmc006-aave-current-surface", &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-006-aave-current-surface-v1"),
        ),
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
            "infrastructure_independence",
            Json::string("NOT_PROVEN_DISTINCT_DECLARED_OPERATORS"),
        ),
    ]))
}
