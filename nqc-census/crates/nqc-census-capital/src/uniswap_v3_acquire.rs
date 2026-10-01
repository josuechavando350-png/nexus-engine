//! Live dual-provider acquisition for the RMC-011 Uniswap V3 flash family.
//!
//! The provider capture proves the complete factory PoolCreated history through
//! the certified D08 anchor, intersects that universe with D08 execution-
//! compatible assets, verifies direct factory membership plus pool runtime
//! identity at the exact anchor, and records the exact pool token balances that
//! bound flash capacity. A separate reconciler requires two independent
//! provider captures to agree byte-canonically on every semantic field.

use crate::{
    uniswap_v3_live::{
        decode_uniswap_v3_pool_created, uniswap_v3_factory_interface,
        verify_uniswap_v3_factory_runtime, verify_uniswap_v3_pool_runtime, UniswapV3PoolIdentity,
        UNISWAP_V3_DEPLOYMENT_BLOB, UNISWAP_V3_DEPLOYMENT_COMMIT, UNISWAP_V3_DEPLOYMENT_PATH,
        UNISWAP_V3_DEPLOYMENT_REPOSITORY, UNISWAP_V3_FACTORY,
    },
    Amount256,
};
use nqc_census_chain::{
    abi,
    acquire::{raw_log_semantics, Acquisition},
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec, LogFilter},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, CallOutcome, CensusObservation, ChainDomain, ContractCallEnvelope, Hash32, LogTopic,
    RawLogEnvelope, StateAnchor,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::Path,
};

const FACTORY_NAMESPACE: u16 = 0x0b31;
const POOL_STATE_NAMESPACE: u16 = 0x0b32;
const POOL_CREATED_FAMILY: &str = "rmc011-uniswap-v3-pool-created";
const LOG_SPAN: u64 = 250_000;
const POOL_JOB_SIZE: usize = 64;

#[derive(Debug, Clone, Copy)]
struct PoolSeed {
    identity: UniswapV3PoolIdentity,
    block_number: u64,
    block_hash: Hash32,
    transaction_hash: Hash32,
    transaction_index: u32,
    log_index: u32,
}

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn parse_full_anchor(value: &Json) -> Result<StateAnchor, ChainError> {
    let chain = ChainDomain::new(
        number(value, "chain_id")?,
        Hash32::parse_hex(value.str_field("genesis_hash")?)?,
        Hash32::parse_hex(value.str_field("fork_lineage")?)?,
    )?;
    Ok(StateAnchor::new(
        chain,
        number(value, "block_number")?,
        Hash32::parse_hex(value.str_field("block_hash")?)?,
        Hash32::parse_hex(value.str_field("parent_hash")?)?,
        number(value, "timestamp")?,
        Hash32::parse_hex(value.str_field("state_root")?)?,
    )?)
}

fn authority_lock_anchor(authority: &Json) -> Result<StateAnchor, ChainError> {
    let stages = authority
        .get("stages")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("D11 authority lock has no stages array".into()))?;
    if stages.len() != 5 {
        return Err(ChainError::Evidence(
            "D11 authority lock must contain exactly RMC-006 through RMC-010".into(),
        ));
    }
    let mut observed: Option<StateAnchor> = None;
    let mut stage_names = BTreeSet::new();
    for row in stages {
        let stage = row.str_field("stage")?.to_owned();
        if !stage_names.insert(stage) {
            return Err(ChainError::Evidence(
                "D11 authority lock repeats an upstream stage".into(),
            ));
        }
        let anchor = parse_full_anchor(row.get("observation_anchor").ok_or_else(|| {
            ChainError::Evidence("D11 authority stage lacks observation_anchor".into())
        })?)?;
        if let Some(first) = &observed {
            if first != &anchor {
                return Err(ChainError::Evidence(
                    "D11 authority stages do not share one exact anchor".into(),
                ));
            }
        } else {
            observed = Some(anchor);
        }
    }
    let expected = BTreeSet::from([
        "RMC-006".to_owned(),
        "RMC-007".to_owned(),
        "RMC-008".to_owned(),
        "RMC-009".to_owned(),
        "RMC-010".to_owned(),
    ]);
    if stage_names != expected {
        return Err(ChainError::Evidence(
            "D11 authority lock stage set differs from RMC-006 through RMC-010".into(),
        ));
    }
    observed.ok_or_else(|| ChainError::Evidence("D11 authority lock is empty".into()))
}

fn full_anchor_json(anchor: &StateAnchor) -> Json {
    Json::object([
        ("chain_id", Json::uint(anchor.chain().chain_id())),
        (
            "genesis_hash",
            Json::string(anchor.chain().genesis_hash().to_hex()),
        ),
        (
            "fork_lineage",
            Json::string(anchor.chain().fork_lineage().to_hex()),
        ),
        ("block_number", Json::uint(anchor.block_number())),
        ("block_hash", Json::string(anchor.block_hash().to_hex())),
        ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
        ("timestamp", Json::uint(anchor.timestamp())),
        ("state_root", Json::string(anchor.state_root().to_hex())),
    ])
}

fn returned<'a>(
    observation: &'a CensusObservation<ContractCallEnvelope>,
    label: &'static str,
) -> Result<&'a [u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(format!(
            "required Uniswap V3 call reverted: {label}"
        ))),
    }
}

fn returned_address(
    observation: &CensusObservation<ContractCallEnvelope>,
    label: &'static str,
) -> Result<Address, ChainError> {
    let word = abi::single_word(returned(observation, label)?)?;
    let address = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} returned zero address")))?;
    Address::new(address).map_err(ChainError::from)
}

fn returned_u64(
    observation: &CensusObservation<ContractCallEnvelope>,
    label: &'static str,
) -> Result<u64, ChainError> {
    let word = abi::single_word(returned(observation, label)?)?;
    abi::decode_u64(&word)
        .map_err(|error| ChainError::Evidence(format!("{label} decode failed: {error}")))
}

fn returned_amount(
    observation: &CensusObservation<ContractCallEnvelope>,
    label: &'static str,
) -> Result<Amount256, ChainError> {
    let word = abi::single_word(returned(observation, label)?)
        .map_err(|error| ChainError::Evidence(format!("{label} decode failed: {error}")))?;
    Ok(Amount256::from_be_bytes(word))
}

fn amount_decimal(mut bytes: [u8; 32]) -> String {
    if bytes.iter().all(|byte| *byte == 0) {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while bytes.iter().any(|byte| *byte != 0) {
        let mut carry = 0_u16;
        for byte in &mut bytes {
            let expanded = (carry << 8) | u16::from(*byte);
            *byte = u8::try_from(expanded / 10).unwrap_or(0);
            carry = expanded % 10;
        }
        digits.push(char::from(b'0' + u8::try_from(carry).unwrap_or(0)));
    }
    digits.iter().rev().collect()
}

fn verify_d08_artifact(manifest: &Json, name: &str, bytes: &[u8]) -> Result<String, ChainError> {
    let expected = manifest
        .get("artifacts")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("D08 evidence manifest has no artifacts".into()))?
        .iter()
        .find(|row| row.get("path").and_then(Json::as_str) == Some(name))
        .ok_or_else(|| ChainError::Evidence(format!("D08 manifest does not bind {name}")))?
        .str_field("sha256")?;
    let actual = sha256_plain(bytes);
    if actual != expected {
        return Err(ChainError::Evidence(format!(
            "D08 artifact digest mismatch for {name}: {actual} != {expected}"
        )));
    }
    Ok(actual)
}

fn census_assets(
    market_state: &[u8],
    token_admission: &[u8],
) -> Result<BTreeMap<Address, Vec<String>>, ChainError> {
    let mut token_blockers = BTreeMap::new();
    let token_text = std::str::from_utf8(token_admission)
        .map_err(|_| ChainError::Evidence("D08 token admission is not UTF-8".into()))?;
    for line in token_text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let token = Address::parse_hex(row.str_field("token")?)?;
        let execution = row.get("execution_compatibility").ok_or_else(|| {
            ChainError::Evidence("D08 token row has no execution_compatibility".into())
        })?;
        let blocker_rows = execution
            .get("blockers")
            .and_then(Json::as_array)
            .ok_or_else(|| {
                ChainError::Evidence("D08 token execution blockers are not an array".into())
            })?;
        let mut blockers = blocker_rows
            .iter()
            .map(|value| {
                value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
                    ChainError::Evidence("D08 token execution blocker is not text".into())
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        blockers.sort();
        if blockers.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(ChainError::Evidence(
                "D08 token execution blockers contain duplicates".into(),
            ));
        }
        match execution.str_field("status")? {
            "PROVEN_COMPATIBLE" if blockers.is_empty() => {}
            "BLOCKED" if !blockers.is_empty() => {}
            "PROVEN_COMPATIBLE" | "BLOCKED" => {
                return Err(ChainError::Evidence(
                    "D08 token compatibility status contradicts blockers".into(),
                ))
            }
            _ => {
                return Err(ChainError::Evidence(
                    "D08 token compatibility status is unknown".into(),
                ))
            }
        }
        if token_blockers.insert(token, blockers).is_some() {
            return Err(ChainError::Evidence(
                "D08 token admission repeats token".into(),
            ));
        }
    }

    let mut assets = BTreeMap::new();
    let state_text = std::str::from_utf8(market_state)
        .map_err(|_| ChainError::Evidence("D08 market state is not UTF-8".into()))?;
    for line in state_text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        if row.get("protocol").and_then(Json::as_str) != Some("AAVE_V3")
            || row.get("lifecycle").and_then(Json::as_str) != Some("CURRENT")
        {
            continue;
        }
        let asset = Address::parse_hex(row.str_field("asset")?)?;
        let blockers = token_blockers
            .get(&asset)
            .ok_or_else(|| {
                ChainError::Evidence("D08 current Aave asset has no token-admission row".into())
            })?
            .clone();
        if let Some(existing) = assets.insert(asset, blockers.clone()) {
            if existing != blockers {
                return Err(ChainError::Evidence(
                    "D08 token blockers disagree across current Aave markets".into(),
                ));
            }
        }
    }
    if assets.is_empty() {
        return Err(ChainError::Evidence(
            "D08 yields no current Aave assets for UniV3 capital census".into(),
        ));
    }
    Ok(assets)
}

fn verify_deployment_document(bytes: &[u8]) -> Result<(), ChainError> {
    let doc = Json::parse(bytes)?;
    if number(&doc, "schema_version")? != 1
        || doc.str_field("family")? != "UNISWAP_V3_FLASH"
        || number(&doc, "chain_id")? != 1
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 deployment document identity mismatch".into(),
        ));
    }
    let root = doc
        .get("deployment_root")
        .ok_or_else(|| ChainError::Evidence("deployment_root missing".into()))?;
    if root.str_field("contract")? != "UniswapV3Factory"
        || root.str_field("address")? != UNISWAP_V3_FACTORY
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 deployment root differs".into(),
        ));
    }
    let provenance = root
        .get("provenance")
        .ok_or_else(|| ChainError::Evidence("deployment provenance missing".into()))?;
    if provenance.str_field("kind")? != "OFFICIAL_UPSTREAM_GIT_BLOB"
        || provenance.str_field("repository")? != UNISWAP_V3_DEPLOYMENT_REPOSITORY
        || provenance.str_field("path")? != UNISWAP_V3_DEPLOYMENT_PATH
        || provenance.str_field("commit")? != UNISWAP_V3_DEPLOYMENT_COMMIT
        || provenance.str_field("blob_sha")? != UNISWAP_V3_DEPLOYMENT_BLOB
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 deployment provenance differs".into(),
        ));
    }
    let requirements = doc
        .get("runtime_requirements")
        .ok_or_else(|| ChainError::Evidence("runtime_requirements missing".into()))?;
    for key in [
        "exact_anchor_code_required",
        "dual_provider_required",
        "full_log_history_through_anchor_required",
        "factory_runtime_code_agreement_required",
        "pool_runtime_code_required",
        "d08_token_admission_intersection_required",
    ] {
        if requirements.get(key).and_then(Json::as_bool) != Some(true) {
            return Err(ChainError::Evidence(format!(
                "Uniswap V3 deployment requirement {key} is not true"
            )));
        }
    }
    if requirements.str_field("pool_universe_source")? != "FACTORY_POOLCREATED_LOGS"
        || requirements
            .get("terminal_resolution_claimed")
            .and_then(Json::as_bool)
            != Some(false)
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 deployment runtime contract differs".into(),
        ));
    }
    Ok(())
}

fn raw_log(value: &Json) -> Result<RawLogEnvelope, ChainError> {
    let topics = value
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("Uniswap V3 log topics missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .ok_or_else(|| ChainError::Evidence("Uniswap V3 topic is not text".into()))
                .and_then(|text| LogTopic::parse_hex(text).map_err(ChainError::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let small = |key: &str| {
        u32::try_from(number(value, key)?)
            .map_err(|_| ChainError::Evidence(format!("{key} exceeds u32")))
    };
    Ok(RawLogEnvelope::with_topics(
        Address::parse_hex(value.str_field("emitter")?)?,
        Hash32::parse_hex(value.str_field("transaction_hash")?)?,
        small("transaction_index")?,
        small("log_index")?,
        topics,
        hex::decode_data(value.str_field("data")?)?,
        false,
    )?)
}

fn digest_rows(domain: &[u8], rows: &[Json]) -> Result<String, ChainError> {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    for row in rows {
        let bytes = row.canonical()?;
        hasher.update(
            u64::try_from(bytes.len())
                .map_err(|_| ChainError::Evidence("Uniswap V3 canonical row length overflow".into()))?
                .to_be_bytes(),
        );
        hasher.update(bytes);
    }
    Ok(hex::plain(&hasher.finalize()))
}

fn event_rows_and_relevant_pools(
    factory: Address,
    logs: &[Json],
    actionable: &BTreeSet<Address>,
) -> Result<(Vec<Json>, Vec<PoolSeed>), ChainError> {
    let mut decoded = Vec::with_capacity(logs.len());
    let mut seen_pools = BTreeSet::new();
    let mut seen_tuples = BTreeSet::new();

    for row in logs {
        let raw = raw_log(row)?;
        let identity = decode_uniswap_v3_pool_created(factory, &raw)?;
        if !seen_pools.insert(identity.pool) {
            return Err(ChainError::Evidence(
                "Uniswap V3 PoolCreated history repeats pool".into(),
            ));
        }
        if !seen_tuples.insert((identity.token0, identity.token1, identity.fee_pips)) {
            return Err(ChainError::Evidence(
                "Uniswap V3 PoolCreated history repeats token/fee tuple".into(),
            ));
        }
        let block_number = number(row, "block")?;
        let block_hash = Hash32::parse_hex(row.str_field("block_hash")?)?;
        let seed = PoolSeed {
            identity,
            block_number,
            block_hash,
            transaction_hash: raw.transaction_hash(),
            transaction_index: raw.transaction_index(),
            log_index: raw.log_index(),
        };
        decoded.push(seed);
    }

    decoded.sort_by_key(|seed| {
        (
            seed.block_number,
            seed.transaction_index,
            seed.log_index,
            seed.identity.pool,
        )
    });

    let event_rows = decoded
        .iter()
        .map(|seed| {
            Json::object([
                ("block", Json::uint(seed.block_number)),
                ("block_hash", Json::string(seed.block_hash.to_hex())),
                (
                    "transaction_hash",
                    Json::string(seed.transaction_hash.to_hex()),
                ),
                (
                    "transaction_index",
                    Json::uint(u64::from(seed.transaction_index)),
                ),
                ("log_index", Json::uint(u64::from(seed.log_index))),
                ("token0", Json::string(seed.identity.token0.to_hex())),
                ("token1", Json::string(seed.identity.token1.to_hex())),
                ("fee_pips", Json::uint(u64::from(seed.identity.fee_pips))),
                (
                    "tick_spacing",
                    Json::string(seed.identity.tick_spacing.to_string()),
                ),
                ("pool", Json::string(seed.identity.pool.to_hex())),
            ])
        })
        .collect::<Vec<_>>();

    let relevant = decoded
        .into_iter()
        .filter(|seed| {
            actionable.contains(&seed.identity.token0) || actionable.contains(&seed.identity.token1)
        })
        .collect::<Vec<_>>();
    if relevant.is_empty() {
        return Err(ChainError::Evidence(
            "Uniswap V3 history has no pools intersecting D08 actionable assets".into(),
        ));
    }
    Ok((event_rows, relevant))
}

fn pool_universe_rows(pools: &[PoolSeed]) -> Vec<Json> {
    pools
        .iter()
        .map(|seed| {
            Json::object([
                ("pool", Json::string(seed.identity.pool.to_hex())),
                ("token0", Json::string(seed.identity.token0.to_hex())),
                ("token1", Json::string(seed.identity.token1.to_hex())),
                ("fee_pips", Json::uint(u64::from(seed.identity.fee_pips))),
                (
                    "tick_spacing",
                    Json::string(seed.identity.tick_spacing.to_string()),
                ),
                ("created_block", Json::uint(seed.block_number)),
                ("created_block_hash", Json::string(seed.block_hash.to_hex())),
                (
                    "created_transaction_hash",
                    Json::string(seed.transaction_hash.to_hex()),
                ),
                (
                    "created_transaction_index",
                    Json::uint(u64::from(seed.transaction_index)),
                ),
                ("created_log_index", Json::uint(u64::from(seed.log_index))),
            ])
        })
        .collect()
}

fn provider_capture(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    expected_anchor: &StateAnchor,
    assets: &BTreeMap<Address, Vec<String>>,
    authority_lock_sha256: &str,
    d08_market_state_sha256: &str,
    d08_token_admission_sha256: &str,
    d08_evidence_manifest_sha256: &str,
    deployment_sha256: &str,
) -> Result<Json, ChainError> {
    let profile = ChainProfile::mainnet()?;
    let (chain_facts, bootstrap) = acquisition.bootstrap(provider, &profile)?;
    if &chain_facts.chain != expected_anchor.chain() {
        return Err(ChainError::Evidence(
            "Uniswap V3 provider chain domain differs from D08 authority".into(),
        ));
    }
    let (anchor, anchor_output) =
        acquisition.resolve_anchor(provider, &chain_facts.chain, expected_anchor.block_number())?;
    if &anchor != expected_anchor {
        return Err(ChainError::Evidence(
            "Uniswap V3 provider anchor differs from D08 authority".into(),
        ));
    }

    let factory = Address::parse_hex(UNISWAP_V3_FACTORY)?;
    let factory_spec = JobSpec::new(
        "rmc011-uniswap-v3-factory-runtime",
        1,
        FACTORY_NAMESPACE,
        Json::object([
            ("factory", Json::string(factory.to_hex())),
            ("anchor", full_anchor_json(&anchor)),
        ]),
    )?;
    let factory_output = acquisition.point(
        provider,
        &chain_facts.chain,
        None,
        &factory_spec,
        &anchor,
        |ctx| {
            let semantics = chain_read_semantics()?;
            let code = ctx.code(factory, &anchor, semantics)?;
            if code.payload().is_absent() {
                return Err(ChainError::Evidence(
                    "canonical Uniswap V3 factory has no runtime code".into(),
                ));
            }
            verify_uniswap_v3_factory_runtime(code.payload().code())?;
            Ok(Json::object([(
                "runtime_sha256",
                Json::string(sha256_plain(code.payload().code())),
            )]))
        },
    )?;
    let factory_runtime_sha256 = factory_output
        .result_json()?
        .str_field("runtime_sha256")?
        .to_owned();

    let (origin, origin_output) = acquisition.resolve_anchor(provider, &chain_facts.chain, 1)?;
    let filter = LogFilter::new(
        vec![factory],
        vec![uniswap_v3_factory_interface().pool_created_topic],
    )?;
    let scan = acquisition.scan(
        provider,
        &chain_facts.chain,
        None,
        POOL_CREATED_FAMILY,
        1,
        FACTORY_NAMESPACE,
        &filter,
        &origin,
        anchor.block_number(),
        LOG_SPAN,
        |claimed| raw_log_semantics(&claimed.log.emitter(), POOL_CREATED_FAMILY),
    )?;
    if scan.certified_first != 1 || scan.certified_last != anchor.block_number() {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated scan does not cover block 1 through anchor".into(),
        ));
    }

    let logs = scan.logs()?;
    let actionable = assets.keys().copied().collect::<BTreeSet<_>>();
    let (event_rows, relevant_pools) = event_rows_and_relevant_pools(factory, &logs, &actionable)?;
    let event_history_sha256 =
        digest_rows(b"NQC-RMC011-UNISWAP-V3-POOL-EVENT-HISTORY-V1", &event_rows)?;
    let universe_rows = pool_universe_rows(&relevant_pools);
    let pool_universe_sha256 =
        digest_rows(b"NQC-RMC011-UNISWAP-V3-POOL-UNIVERSE-V1", &universe_rows)?;

    let mut pool_rows = Vec::with_capacity(relevant_pools.len());
    let mut state_manifests = Vec::new();
    let balance_selector = abi::selector("balanceOf(address)");
    let token0_selector = abi::selector("token0()");
    let token1_selector = abi::selector("token1()");
    let fee_selector = abi::selector("fee()");
    let liquidity_selector = abi::selector("liquidity()");
    let get_pool_selector = uniswap_v3_factory_interface().get_pool;

    for (job_index, chunk) in relevant_pools.chunks(POOL_JOB_SIZE).enumerate() {
        let first_pool = chunk
            .first()
            .ok_or_else(|| ChainError::Evidence("empty Uniswap V3 pool chunk".into()))?;
        let last_pool = chunk
            .last()
            .ok_or_else(|| ChainError::Evidence("empty Uniswap V3 pool chunk".into()))?;
        let job_index = u64::try_from(job_index)
            .map_err(|_| ChainError::Evidence("Uniswap V3 job index overflow".into()))?;
        let pool_count = u64::try_from(chunk.len())
            .map_err(|_| ChainError::Evidence("Uniswap V3 pool chunk count overflow".into()))?;
        let spec = JobSpec::new(
            "rmc011-uniswap-v3-pool-state",
            1,
            POOL_STATE_NAMESPACE,
            Json::object([
                ("job_index", Json::uint(job_index)),
                ("pool_count", Json::uint(pool_count)),
                (
                    "first_pool",
                    Json::string(first_pool.identity.pool.to_hex()),
                ),
                ("last_pool", Json::string(last_pool.identity.pool.to_hex())),
                (
                    "pool_universe_sha256",
                    Json::string(pool_universe_sha256.clone()),
                ),
                ("anchor", full_anchor_json(&anchor)),
            ]),
        )?;

        let output =
            acquisition.point(provider, &chain_facts.chain, None, &spec, &anchor, |ctx| {
                let semantics = chain_read_semantics()?;
                let mut identity_calls = Vec::with_capacity(chunk.len() * 5);
                let mut balance_calls = Vec::new();
                let mut balance_keys = Vec::new();

                for (index, seed) in chunk.iter().enumerate() {
                    identity_calls.extend([
                        (seed.identity.pool, abi::encode_call(token0_selector, &[])),
                        (seed.identity.pool, abi::encode_call(token1_selector, &[])),
                        (seed.identity.pool, abi::encode_call(fee_selector, &[])),
                        (
                            seed.identity.pool,
                            abi::encode_call(liquidity_selector, &[]),
                        ),
                        (
                            factory,
                            abi::encode_call(
                                get_pool_selector,
                                &[
                                    abi::address_word(seed.identity.token0.as_bytes()),
                                    abi::address_word(seed.identity.token1.as_bytes()),
                                    abi::uint_word(u64::from(seed.identity.fee_pips)),
                                ],
                            ),
                        ),
                    ]);
                    for asset in [seed.identity.token0, seed.identity.token1] {
                        if actionable.contains(&asset) {
                            balance_keys.push((index, asset));
                            balance_calls.push((
                                asset,
                                abi::encode_call(
                                    balance_selector,
                                    &[abi::address_word(seed.identity.pool.as_bytes())],
                                ),
                            ));
                        }
                    }
                }

                let identities = ctx.calls(&identity_calls, &anchor, semantics)?;
                if identities.len() != chunk.len() * 5 {
                    return Err(ChainError::Evidence(
                        "Uniswap V3 pool identity call count differs".into(),
                    ));
                }
                let balances = ctx.calls(&balance_calls, &anchor, semantics)?;
                if balances.len() != balance_keys.len() {
                    return Err(ChainError::Evidence(
                        "Uniswap V3 pool balance call count differs".into(),
                    ));
                }

                let mut per_pool_balances = vec![Vec::<Json>::new(); chunk.len()];
                for ((index, asset), response) in balance_keys.iter().zip(&balances) {
                    let amount = returned_amount(response, "balanceOf")?;
                    let blockers = assets.get(asset).ok_or_else(|| {
                        ChainError::Evidence("UniV3 balance asset lacks D08 blocker record".into())
                    })?;
                    per_pool_balances[*index].push(Json::object([
                        ("asset", Json::string(asset.to_hex())),
                        (
                            "balance",
                            Json::string(amount_decimal(*amount.as_be_bytes())),
                        ),
                        (
                            "execution_blockers",
                            Json::array(blockers.iter().cloned().map(Json::string)),
                        ),
                    ]));
                }

                let mut rows = Vec::with_capacity(chunk.len());
                for ((seed, responses), asset_balances) in chunk
                    .iter()
                    .zip(identities.chunks_exact(5))
                    .zip(per_pool_balances.into_iter())
                {
                    let token0 = returned_address(&responses[0], "token0")?;
                    let token1 = returned_address(&responses[1], "token1")?;
                    let fee_raw = returned_u64(&responses[2], "fee")?;
                    let fee_pips = u32::try_from(fee_raw).map_err(|_| {
                        ChainError::Evidence("Uniswap V3 fee exceeds uint32".into())
                    })?;
                    let active_liquidity = returned_amount(&responses[3], "liquidity")?;
                    let rebound = returned_address(&responses[4], "getPool")?;
                    if token0 != seed.identity.token0
                        || token1 != seed.identity.token1
                        || fee_pips != seed.identity.fee_pips
                        || rebound != seed.identity.pool
                    {
                        return Err(ChainError::Evidence(
                            "Uniswap V3 pool state does not round-trip to PoolCreated identity"
                                .into(),
                        ));
                    }
                    let code = ctx.code(seed.identity.pool, &anchor, semantics)?;
                    if code.payload().is_absent() {
                        return Err(ChainError::Evidence(
                            "Uniswap V3 PoolCreated pool has no runtime code at anchor".into(),
                        ));
                    }
                    verify_uniswap_v3_pool_runtime(code.payload().code())?;
                    if asset_balances.is_empty() {
                        return Err(ChainError::Evidence(
                            "Uniswap V3 relevant pool has no D08 asset balance".into(),
                        ));
                    }
                    rows.push(Json::object([
                        ("pool", Json::string(seed.identity.pool.to_hex())),
                        ("token0", Json::string(seed.identity.token0.to_hex())),
                        ("token1", Json::string(seed.identity.token1.to_hex())),
                        ("fee_pips", Json::uint(u64::from(seed.identity.fee_pips))),
                        (
                            "active_liquidity",
                            Json::string(amount_decimal(*active_liquidity.as_be_bytes())),
                        ),
                        (
                            "tick_spacing",
                            Json::string(seed.identity.tick_spacing.to_string()),
                        ),
                        ("created_block", Json::uint(seed.block_number)),
                        ("created_block_hash", Json::string(seed.block_hash.to_hex())),
                        (
                            "created_transaction_hash",
                            Json::string(seed.transaction_hash.to_hex()),
                        ),
                        (
                            "created_transaction_index",
                            Json::uint(u64::from(seed.transaction_index)),
                        ),
                        ("created_log_index", Json::uint(u64::from(seed.log_index))),
                        (
                            "pool_runtime_sha256",
                            Json::string(sha256_plain(code.payload().code())),
                        ),
                        ("asset_balances", Json::Array(asset_balances)),
                    ]));
                }
                Ok(Json::object([("pools", Json::Array(rows))]))
            })?;
        state_manifests.push(output.manifest_id().to_hex());
        pool_rows.extend(
            output
                .result_json()?
                .get("pools")
                .and_then(Json::as_array)
                .ok_or_else(|| ChainError::Evidence("Uniswap V3 pool job has no pools".into()))?
                .iter()
                .cloned(),
        );
    }

    if pool_rows.len() != relevant_pools.len() {
        return Err(ChainError::Evidence(
            "Uniswap V3 pool state coverage differs from relevant pool universe".into(),
        ));
    }

    let mut evidence_manifests = vec![
        bootstrap.manifest_id().to_hex(),
        anchor_output.manifest_id().to_hex(),
        origin_output.manifest_id().to_hex(),
        factory_output.manifest_id().to_hex(),
    ];
    evidence_manifests.extend(
        scan.windows
            .iter()
            .map(|window| window.manifest_id().to_hex()),
    );
    evidence_manifests.extend(state_manifests);

    Ok(Json::object([
        ("schema_version", Json::uint(1)),
        ("stage", Json::string("RMC-011")),
        ("family", Json::string("UNISWAP_V3_FLASH")),
        ("provider_id", Json::string(provider.label().to_owned())),
        (
            "provider_operator",
            Json::string(provider.operator().to_owned()),
        ),
        (
            "rpc_endpoint_hash",
            Json::string(provider.locator_hash()?.to_hex()),
        ),
        ("anchor", full_anchor_json(&anchor)),
        (
            "authority_lock_sha256",
            Json::string(authority_lock_sha256.to_owned()),
        ),
        (
            "d08_market_state_sha256",
            Json::string(d08_market_state_sha256.to_owned()),
        ),
        (
            "d08_token_admission_sha256",
            Json::string(d08_token_admission_sha256.to_owned()),
        ),
        (
            "d08_evidence_manifest_sha256",
            Json::string(d08_evidence_manifest_sha256.to_owned()),
        ),
        (
            "deployment_sha256",
            Json::string(deployment_sha256.to_owned()),
        ),
        (
            "factory",
            Json::object([
                ("address", Json::string(factory.to_hex())),
                ("runtime_sha256", Json::string(factory_runtime_sha256)),
            ]),
        ),
        (
            "pool_event_history_sha256",
            Json::string(event_history_sha256),
        ),
        ("pool_universe_sha256", Json::string(pool_universe_sha256)),
        ("pools", Json::Array(pool_rows)),
        (
            "evidence_manifests",
            Json::array(evidence_manifests.into_iter().map(Json::string)),
        ),
    ]))
}

pub fn run_uniswap_v3_capture(
    providers_path: &Path,
    provider_label: &str,
    store_path: &Path,
    d08_market_state_path: &Path,
    d08_token_admission_path: &Path,
    d08_evidence_manifest_path: &Path,
    authority_lock_path: &Path,
    deployment_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let provider = providers
        .iter()
        .find(|provider| provider.label() == provider_label)
        .cloned()
        .ok_or_else(|| format!("unknown provider label {provider_label}"))?;

    let market_state = fs::read(d08_market_state_path)?;
    let token_admission = fs::read(d08_token_admission_path)?;
    let manifest_bytes = fs::read(d08_evidence_manifest_path)?;
    let authority_bytes = fs::read(authority_lock_path)?;
    let deployment_bytes = fs::read(deployment_path)?;
    verify_deployment_document(&deployment_bytes)?;

    let manifest = Json::parse(&manifest_bytes)?;
    let market_state_sha256 =
        verify_d08_artifact(&manifest, "market-state-manifest.jsonl", &market_state)?;
    let token_admission_sha256 =
        verify_d08_artifact(&manifest, "token-admission.jsonl", &token_admission)?;
    let d08_evidence_manifest_sha256 = sha256_plain(&manifest_bytes);
    let authority_lock_sha256 = sha256_plain(&authority_bytes);
    let deployment_sha256 = sha256_plain(&deployment_bytes);

    let expected_anchor = parse_full_anchor(
        manifest
            .get("observation_anchor")
            .ok_or("D08 evidence manifest has no observation_anchor")?,
    )?;
    let authority = Json::parse(&authority_bytes)?;
    let authority_anchor = authority_lock_anchor(&authority)?;
    if authority_anchor != expected_anchor {
        return Err("D11 authority lock anchor differs from D08 evidence anchor".into());
    }
    let assets = census_assets(&market_state, &token_admission)?;

    let store = Store::create(store_path, StoreConfig::standard())?;
    let transport = CurlTransport::new(60, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());

    Ok(provider_capture(
        &acquisition,
        &provider,
        &expected_anchor,
        &assets,
        &authority_lock_sha256,
        &market_state_sha256,
        &token_admission_sha256,
        &d08_evidence_manifest_sha256,
        &deployment_sha256,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_conversion_handles_uint256_boundaries() {
        assert_eq!(amount_decimal([0; 32]), "0");
        let mut one = [0_u8; 32];
        one[31] = 1;
        assert_eq!(amount_decimal(one), "1");
        assert_eq!(
            amount_decimal([0xff; 32]),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    #[test]
    fn deployment_contract_rejects_runtime_authority_upgrade() -> Result<(), ChainError> {
        let bytes = br#"{
          "schema_version":1,
          "family":"UNISWAP_V3_FLASH",
          "chain_id":1,
          "deployment_root":{
            "contract":"UniswapV3Factory",
            "address":"0x1f98431c8ad98523631ae4a59f267346ea31f984",
            "provenance":{
              "kind":"OFFICIAL_UPSTREAM_GIT_BLOB",
              "repository":"Uniswap/v3-periphery",
              "path":"deploys.md",
              "commit":"0682387198a24c7cd63566a2c58398533860a5d1",
              "blob_sha":"c0af53cb35bdef902965262c23b34f5d39baf343"
            }
          },
          "runtime_requirements":{
            "exact_anchor_code_required":true,
            "dual_provider_required":true,
            "pool_universe_source":"FACTORY_POOLCREATED_LOGS",
            "full_log_history_through_anchor_required":true,
            "factory_runtime_code_agreement_required":true,
            "pool_runtime_code_required":true,
            "d08_token_admission_intersection_required":true,
            "terminal_resolution_claimed":true
          }
        }"#;
        assert!(verify_deployment_document(bytes).is_err());
        Ok(())
    }
}
