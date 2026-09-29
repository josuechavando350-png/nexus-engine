use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    bootstrap::run_bootstrap,
    consensus::{agree, ProviderResult},
    ethereum::ChainProfile,
    evm::CodeScan,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    rpc::RpcCall,
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, CallOutcome, CensusObservation, ContractCallEnvelope, Hash32, ObservationSemantics,
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
const PRICE_ORACLE: &str = "0x54586be62e3c3580375ae3723c145253060ca0c2";
const IMPLEMENTATION_SLOT: &str =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const PROVIDER_CODE_SHA256: &str =
    "e5416052b67aa0475bffe5707510a1981ffcc131d9b49066d51f6e25eb6c5c9f";
const POOL_PROXY_CODE_SHA256: &str =
    "bf8a408a1f5440c167d91fa2d972deb23bb4d809e8dd089009885ec88a826f88";
const POOL_IMPLEMENTATION_CODE_SHA256: &str =
    "fbd5bf315821d290d18b3a06cafb2f69457075388eae50b6134f490cf83cb049";
const PRICE_ORACLE_CODE_SHA256: &str =
    "dc8079e555204e0b2d7dc8382d6ebd71901f0b43e5940463e22b75b810a37728";

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

fn storage_address(value: &Json, label: &'static str) -> Result<Address, ChainError> {
    let encoded = value
        .as_str()
        .ok_or_else(|| ChainError::Evidence(format!("{label} storage value is not hex")))?;
    let bytes = hex::decode_data(encoded)?;
    let word = <[u8; 32]>::try_from(bytes.as_slice())
        .map_err(|_| ChainError::Evidence(format!("{label} storage value is not one word")))?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} storage address is zero")))?;
    Ok(Address::new(raw)?)
}

fn guarded_storage_address(
    ctx: &mut nqc_census_chain::job::JobContext<'_>,
    target: Address,
    anchor: &nqc_census_core::StateAnchor,
    label: &'static str,
) -> Result<Address, ChainError> {
    let before = ctx.header_by_number(anchor.block_number())?;
    if before.envelope().anchor().block_hash() != anchor.block_hash() {
        return Err(ChainError::Evidence(format!(
            "{label} pre-guard anchor changed"
        )));
    }
    let value = ctx.raw_result(&RpcCall::new(
        "eth_getStorageAt",
        Json::array([
            Json::string(target.to_hex()),
            Json::string(IMPLEMENTATION_SLOT),
            Json::string(hex::quantity(anchor.block_number())),
        ]),
    ))?;
    let observed = storage_address(&value, label)?;
    let after = ctx.header_by_number(anchor.block_number())?;
    if after.envelope().anchor().block_hash() != anchor.block_hash() {
        return Err(ChainError::Evidence(format!(
            "{label} post-guard anchor changed"
        )));
    }
    Ok(observed)
}

fn uint64(bytes: &[u8], label: &'static str) -> Result<u64, ChainError> {
    let word = abi::single_word(bytes)?;
    abi::decode_u64(&word).map_err(|error| {
        ChainError::Evidence(format!("{label} is not a canonical uint64: {error}"))
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
    let expected_oracle = Address::parse_hex(PRICE_ORACLE)?;
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
    let output = acquisition.point(provider, chain, None, &spec, anchor, |ctx| {
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
        for selector in [
            interface.get_pool,
            interface.get_pool_configurator,
            interface.get_price_oracle,
        ] {
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
                (pool, abi::encode_call(interface.reserves_list, &[])),
                (
                    addresses_provider,
                    abi::encode_call(interface.get_price_oracle, &[]),
                ),
                (
                    pool,
                    abi::encode_call(interface.flashloan_premium_total, &[]),
                ),
            ],
            anchor,
            semantics,
        )?;
        if calls.len() != 7 {
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
        let reserves_list = abi::decode_address_array(returned(&calls[4])?)?
            .into_iter()
            .map(|value| {
                value
                    .ok_or_else(|| {
                        ChainError::Evidence("getReservesList returned zero address".into())
                    })
                    .and_then(|bytes| Address::new(bytes).map_err(ChainError::from))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let price_oracle = required_address(returned(&calls[5])?, "getPriceOracle")?;
        if price_oracle != expected_oracle {
            return Err(ChainError::Evidence(
                "AddressesProvider getPriceOracle differs from certified oracle".into(),
            ));
        }
        let flash_loan_premium_bps = uint64(returned(&calls[6])?, "FLASHLOAN_PREMIUM_TOTAL")?;
        if flash_loan_premium_bps != 5 {
            return Err(ChainError::Evidence(format!(
                "FLASHLOAN_PREMIUM_TOTAL changed: expected 5, got {flash_loan_premium_bps}"
            )));
        }

        let observed_implementation =
            guarded_storage_address(ctx, pool, anchor, "Pool EIP-1967 implementation")?;
        if observed_implementation != implementation {
            return Err(ChainError::Evidence(
                "EIP-1967 implementation differs from certified implementation".into(),
            ));
        }

        let configurator_code = ctx.code(configurator, anchor, chain_semantics)?;
        if configurator_code.payload().is_absent() {
            return Err(ChainError::Evidence(
                "PoolConfigurator proxy has no runtime code".into(),
            ));
        }
        let configurator_hash = sha256_plain(configurator_code.payload().code());
        let configurator_implementation = guarded_storage_address(
            ctx,
            configurator,
            anchor,
            "PoolConfigurator EIP-1967 implementation",
        )?;
        let configurator_implementation_code =
            ctx.code(configurator_implementation, anchor, chain_semantics)?;
        if configurator_implementation_code.payload().is_absent() {
            return Err(ChainError::Evidence(
                "PoolConfigurator implementation has no runtime code".into(),
            ));
        }
        let configurator_implementation_hash =
            sha256_plain(configurator_implementation_code.payload().code());

        let oracle_code = ctx.code(price_oracle, anchor, chain_semantics)?;
        let oracle_hash = require_sha256(
            "price oracle",
            oracle_code.payload().code(),
            PRICE_ORACLE_CODE_SHA256,
        )?;
        let oracle_calls = ctx.calls(
            &[
                (price_oracle, abi::encode_call(interface.base_currency, &[])),
                (
                    price_oracle,
                    abi::encode_call(interface.base_currency_unit, &[]),
                ),
            ],
            anchor,
            semantics,
        )?;
        if oracle_calls.len() != 2 {
            return Err(ChainError::Evidence(
                "oracle configuration call count differs".into(),
            ));
        }
        let base_currency_word = abi::single_word(returned(&oracle_calls[0])?)?;
        let base_currency = match abi::decode_address(&base_currency_word)? {
            Some(raw) => Json::string(Address::new(raw)?.to_hex()),
            None => Json::Null,
        };
        let base_currency_unit = uint64(returned(&oracle_calls[1])?, "BASE_CURRENCY_UNIT")?;
        if base_currency_unit == 0 {
            return Err(ChainError::Evidence(
                "oracle BASE_CURRENCY_UNIT is zero".into(),
            ));
        }

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
        // A dropped reserve leaves a zero id slot below getReservesCount;
        // getReservesList skips it. History must explain every such slot.
        let mut slots = Vec::with_capacity(address_calls.len());
        for call in &address_calls {
            let word = abi::single_word(returned(call)?)?;
            slots.push(match abi::decode_address(&word)? {
                Some(raw) => Some(Address::new(raw)?),
                None => None,
            });
        }
        let assets: Vec<(u16, Address)> = slots
            .iter()
            .enumerate()
            .filter_map(|(id, slot)| slot.map(|asset| (id, asset)))
            .map(|(id, asset)| {
                u16::try_from(id)
                    .map(|id| (id, asset))
                    .map_err(|_| ChainError::Evidence("reserve id exceeds uint16".into()))
            })
            .collect::<Result<_, _>>()?;
        let dropped_ids: Vec<u64> = slots
            .iter()
            .enumerate()
            .filter(|(_, slot)| slot.is_none())
            .map(|(id, _)| id as u64)
            .collect();
        let by_id_set = assets
            .iter()
            .map(|(_, asset)| *asset)
            .collect::<std::collections::BTreeSet<_>>();
        if by_id_set.len() != assets.len() {
            return Err(ChainError::Evidence(
                "duplicate reserve address in current enumeration".into(),
            ));
        }
        if reserves_list.len() != assets.len()
            || reserves_list
                .iter()
                .zip(&assets)
                .any(|(listed, (_, slot))| listed != slot)
        {
            return Err(ChainError::Evidence(format!(
                "getReservesList ({} entries) is not the non-empty id slots of getReservesCount {} in id order",
                reserves_list.len(),
                reserve_count
            )));
        }
        let list_set = reserves_list
            .iter()
            .copied()
            .collect::<std::collections::BTreeSet<_>>();
        if list_set.len() != reserves_list.len() {
            return Err(ChainError::Evidence(
                "duplicate reserve address in getReservesList".into(),
            ));
        }
        if by_id_set != list_set {
            return Err(ChainError::Evidence(
                "getReserveAddressById and getReservesList disagree".into(),
            ));
        }

        let data_requests: Vec<_> = assets
            .iter()
            .map(|(_, asset)| {
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
        for ((reserve_id, asset), call) in assets.iter().zip(&data_calls) {
            reserves.push(reserve_record(*reserve_id, *asset, returned(call)?)?);
        }

        Ok(Json::object([
            ("pool", Json::string(pool.to_hex())),
            (
                "addresses_provider",
                Json::string(addresses_provider.to_hex()),
            ),
            ("pool_configurator", Json::string(configurator.to_hex())),
            (
                "pool_configurator_implementation",
                Json::string(configurator_implementation.to_hex()),
            ),
            (
                "pool_implementation",
                Json::string(observed_implementation.to_hex()),
            ),
            (
                "eip1967_implementation_slot",
                Json::string(IMPLEMENTATION_SLOT),
            ),
            ("price_oracle", Json::string(price_oracle.to_hex())),
            ("flash_loan_premium_bps", Json::uint(flash_loan_premium_bps)),
            ("oracle_base_currency", base_currency),
            ("oracle_base_currency_unit", Json::uint(base_currency_unit)),
            ("reserve_count", Json::uint(u64::from(reserve_count))),
            (
                "dropped_reserve_ids",
                Json::array(dropped_ids.iter().map(|id| Json::uint(*id))),
            ),
            (
                "reserves_list",
                Json::array(
                    reserves_list
                        .iter()
                        .map(|asset| Json::string(asset.to_hex())),
                ),
            ),
            ("reserves", Json::Array(reserves)),
            (
                "runtime_sha256",
                Json::object([
                    ("addresses_provider", Json::string(provider_hash)),
                    ("pool_proxy", Json::string(pool_hash)),
                    ("pool_implementation", Json::string(implementation_hash)),
                    ("pool_configurator", Json::string(configurator_hash)),
                    (
                        "pool_configurator_implementation",
                        Json::string(configurator_implementation_hash),
                    ),
                    ("price_oracle", Json::string(oracle_hash)),
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
    let facts = agreement.result;
    let runtime_hashes = facts
        .get("runtime_sha256")
        .ok_or_else(|| ChainError::Evidence("current facts lack runtime hashes".into()))?;
    let interface = aave_interface();
    let configuration_binding = Json::object([
        (
            "addresses_provider",
            Json::string(facts.str_field("addresses_provider")?),
        ),
        ("pool", Json::string(facts.str_field("pool")?)),
        (
            "pool_configurator",
            Json::string(facts.str_field("pool_configurator")?),
        ),
        (
            "pool_implementation",
            Json::string(facts.str_field("pool_implementation")?),
        ),
        (
            "pool_configurator_implementation",
            Json::string(facts.str_field("pool_configurator_implementation")?),
        ),
        (
            "eip1967_implementation_slot",
            Json::string(IMPLEMENTATION_SLOT),
        ),
        ("runtime_sha256", runtime_hashes.clone()),
        (
            "discovery_selectors",
            Json::object([
                (
                    "addresses_provider",
                    Json::string(hex::encode(&interface.addresses_provider)),
                ),
                (
                    "reserves_count",
                    Json::string(hex::encode(&interface.reserves_count)),
                ),
                (
                    "reserve_by_id",
                    Json::string(hex::encode(&interface.reserve_by_id)),
                ),
                (
                    "reserves_list",
                    Json::string(hex::encode(&interface.reserves_list)),
                ),
                (
                    "reserve_data",
                    Json::string(hex::encode(&interface.reserve_data)),
                ),
                ("get_pool", Json::string(hex::encode(&interface.get_pool))),
                (
                    "get_pool_configurator",
                    Json::string(hex::encode(&interface.get_pool_configurator)),
                ),
            ]),
        ),
        (
            "lifecycle_topics",
            Json::object([
                (
                    "proxy_created",
                    Json::string(hex::encode(&interface.proxy_created_topic)),
                ),
                (
                    "pool_configurator_updated",
                    Json::string(hex::encode(&interface.pool_configurator_updated_topic)),
                ),
                (
                    "reserve_initialized",
                    Json::string(hex::encode(&interface.reserve_initialized_topic)),
                ),
                (
                    "reserve_dropped",
                    Json::string(hex::encode(&interface.reserve_dropped_topic)),
                ),
            ]),
        ),
    ]);
    let configuration_sha256 = sha256_plain(&configuration_binding.canonical()?);
    let oracle_configuration = Json::object([
        (
            "price_oracle",
            Json::string(facts.str_field("price_oracle")?),
        ),
        (
            "price_oracle_runtime_sha256",
            Json::string(runtime_hashes.str_field("price_oracle")?),
        ),
        (
            "base_currency",
            facts
                .get("oracle_base_currency")
                .cloned()
                .ok_or_else(|| ChainError::Evidence("oracle base currency missing".into()))?,
        ),
        (
            "base_currency_unit",
            facts
                .get("oracle_base_currency_unit")
                .cloned()
                .ok_or_else(|| ChainError::Evidence("oracle base unit missing".into()))?,
        ),
    ]);
    let oracle_configuration_sha256 = sha256_plain(&oracle_configuration.canonical()?);

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-006-aave-current-surface-v1"),
        ),
        ("status", Json::string("CURRENT_SURFACE_PASS")),
        ("bootstrap", bootstrap),
        ("facts", facts),
        (
            "admission_fingerprint",
            Json::object([
                ("configuration_sha256", Json::string(configuration_sha256)),
                (
                    "oracle_configuration_sha256",
                    Json::string(oracle_configuration_sha256),
                ),
            ]),
        ),
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
