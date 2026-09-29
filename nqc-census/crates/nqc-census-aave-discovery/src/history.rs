use crate::{
    aave_interface, decode_reserve_dropped, decode_reserve_initialized,
    lineage::discover_configurator_lineage,
};
use nqc_census_chain::{
    acquire::{anchor_from_result, raw_log_semantics, Acquisition, ScanOutcome},
    bootstrap::run_bootstrap,
    boundary::earliest_code_body,
    consensus::{agree, agree_logs, ProviderResult},
    ethereum::ChainProfile,
    hex,
    job::{JobSpec, LogFilter},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, DeploymentKey, Hash32, ProtocolFamily, RawLogEnvelope, StateAnchor,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::Path,
};

const ANCHOR_NUMBER: u64 = 25_437_474;
const ANCHOR_HASH: &str = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
const POOL: &str = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const CURRENT_CONFIGURATOR: &str = "0x64b761d848206f447fe2dd461b0c635ec39ebb27";
const BOUNDARY_NAMESPACE: u16 = 0x0602;
const RESERVE_INIT_NAMESPACE: u16 = 0x0605;
const RESERVE_DROP_NAMESPACE: u16 = 0x0606;
const CHECKPOINT_SPAN: u64 = 1_000_000;

#[derive(Debug, Clone)]
struct CurrentReserve {
    reserve_id: u16,
    asset: Address,
    a_token: Address,
    variable_debt_token: Address,
}

#[derive(Debug, Clone)]
struct LatestInit {
    a_token: Address,
    variable_debt_token: Address,
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn address_field(value: &Json, key: &str) -> Result<Address, ChainError> {
    Ok(Address::parse_hex(value.str_field(key)?)?)
}

fn current_report(path: &Path) -> Result<(Address, Vec<CurrentReserve>), ChainError> {
    let bytes = fs::read(path)
        .map_err(|error| ChainError::Config(format!("read current report: {error}")))?;
    let report = Json::parse(&bytes)?;
    if report.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS") {
        return Err(ChainError::Evidence(
            "current-surface report is not PASS".into(),
        ));
    }
    let facts = report
        .get("facts")
        .ok_or_else(|| ChainError::Evidence("current report has no facts".into()))?;
    if facts.str_field("pool")? != POOL {
        return Err(ChainError::Evidence(
            "current report Pool differs from declared Pool".into(),
        ));
    }
    let configurator = address_field(facts, "pool_configurator")?;
    if configurator != Address::parse_hex(CURRENT_CONFIGURATOR)? {
        return Err(ChainError::Evidence(
            "current PoolConfigurator differs from declared exact-anchor value".into(),
        ));
    }
    let rows = facts
        .get("reserves")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("current report has no reserves".into()))?;
    let mut reserves = Vec::with_capacity(rows.len());
    for row in rows {
        reserves.push(CurrentReserve {
            reserve_id: u16::try_from(number(row, "reserve_id")?)
                .map_err(|_| ChainError::Evidence("reserve id exceeds u16".into()))?,
            asset: address_field(row, "asset")?,
            a_token: address_field(row, "a_token")?,
            variable_debt_token: address_field(row, "variable_debt_token")?,
        });
    }
    reserves.sort_by_key(|reserve| reserve.reserve_id);
    if reserves
        .iter()
        .enumerate()
        .any(|(index, reserve)| usize::from(reserve.reserve_id) != index)
    {
        return Err(ChainError::Evidence(
            "current reserve ids are not contiguous".into(),
        ));
    }
    Ok((configurator, reserves))
}

fn raw_log(value: &Json) -> Result<RawLogEnvelope, ChainError> {
    let emitter = address_field(value, "emitter")?;
    let transaction_hash = Hash32::parse_hex(value.str_field("transaction_hash")?)?;
    let transaction_index = u32::try_from(number(value, "transaction_index")?)
        .map_err(|_| ChainError::Evidence("transaction index exceeds u32".into()))?;
    let log_index = u32::try_from(number(value, "log_index")?)
        .map_err(|_| ChainError::Evidence("log index exceeds u32".into()))?;
    let topics = value
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("log topics missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .ok_or_else(|| ChainError::Evidence("log topic is not a string".into()))
                .and_then(|text| Hash32::parse_hex(text).map_err(ChainError::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let data = hex::decode_data(value.str_field("data")?)?;
    Ok(RawLogEnvelope::new(
        emitter,
        transaction_hash,
        transaction_index,
        log_index,
        topics,
        data,
        false,
    )?)
}

fn boundary_result(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &nqc_census_core::ChainDomain,
    account: Address,
    label: &str,
) -> Result<ProviderResult, ChainError> {
    let spec = JobSpec::new(
        "rmc006-aave-earliest-code",
        1,
        BOUNDARY_NAMESPACE,
        Json::object([
            ("account", Json::string(account.to_hex())),
            ("label", Json::string(label)),
            ("lo", Json::uint(1)),
            ("hi", Json::uint(ANCHOR_NUMBER)),
        ]),
    )?;
    let output = acquisition.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
        earliest_code_body(ctx, account, 1, ANCHOR_NUMBER)
    })?;
    Ok(ProviderResult {
        provider: provider.label().to_owned(),
        manifest: output.manifest_id().to_hex(),
        result: output.result_json()?,
    })
}

fn agreed_boundary(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    chain: &nqc_census_core::ChainDomain,
    account: Address,
    label: &str,
) -> Result<(StateAnchor, Json, Vec<String>), ChainError> {
    let mut results = Vec::new();
    for provider in providers.iter() {
        results.push(boundary_result(
            acquisition,
            provider,
            chain,
            account,
            label,
        )?);
    }
    let agreement = agree(&format!("rmc006-{label}-earliest-code"), &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let boundary = agreement
        .result
        .get("boundary")
        .ok_or_else(|| ChainError::Evidence("earliest-code boundary missing".into()))?;
    let anchor = anchor_from_result(chain, boundary, "anchor")?;
    Ok((anchor, agreement.result, agreement.manifests))
}

fn stable_deployment_instance(pool: Address, creation: &StateAnchor) -> Result<Hash32, ChainError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC006-AAVE-DEPLOYMENT-INSTANCE-V1");
    hasher.update([0]);
    hasher.update(pool.as_bytes());
    hasher.update(creation.block_number().to_be_bytes());
    hasher.update(creation.block_hash().as_bytes());
    Ok(Hash32::new(hasher.finalize().into())?)
}

fn scan_history(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &nqc_census_core::ChainDomain,
    deployment: &DeploymentKey,
    configurators: &[Address],
    origin: &StateAnchor,
    topic: [u8; 32],
    family: &'static str,
    namespace: u16,
) -> Result<ScanOutcome, ChainError> {
    let filter = LogFilter::new(configurators.to_vec(), vec![topic])?;
    acquisition.scan(
        provider,
        chain,
        Some(deployment.clone()),
        family,
        1,
        namespace,
        &filter,
        origin,
        ANCHOR_NUMBER,
        CHECKPOINT_SPAN,
        |claimed| raw_log_semantics(&claimed.log.emitter(), family),
    )
}

fn scan_record(provider: &str, kind: &str, scan: &ScanOutcome) -> Result<Json, ChainError> {
    let mut windows = Vec::with_capacity(scan.windows.len());
    for window in &scan.windows {
        let result = window.result_json()?;
        windows.push(Json::object([
            (
                "window",
                result
                    .get("window")
                    .cloned()
                    .ok_or_else(|| ChainError::Evidence("scan window missing".into()))?,
            ),
            ("manifest", Json::string(window.manifest_id().to_hex())),
        ]));
    }
    Ok(Json::object([
        ("provider", Json::string(provider)),
        ("kind", Json::string(kind)),
        ("certified_first", Json::uint(scan.certified_first)),
        ("certified_last", Json::uint(scan.certified_last)),
        ("commitment", Json::string(scan.commitment.clone())),
        ("windows", Json::Array(windows)),
    ]))
}

pub fn run_history(
    providers_path: &Path,
    current_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let (configurator, current_reserves) = current_report(current_path)?;
    let store = Store::create(store_path, StoreConfig::standard())?;
    let transport = CurlTransport::new(90, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(&acquisition, &providers, &profile, ANCHOR_NUMBER)?;
    if anchor.block_hash() != Hash32::parse_hex(ANCHOR_HASH)? {
        return Err(ChainError::Evidence("D06 history anchor hash differs".into()).into());
    }

    let pool = Address::parse_hex(POOL)?;
    let addresses_provider = Address::parse_hex("0x2f39d218133afab8f2b819b1066c7e434ad94e9e")?;
    let (provider_creation, provider_boundary, provider_boundary_manifests) = agreed_boundary(
        &acquisition,
        &providers,
        &chain,
        addresses_provider,
        "addresses-provider",
    )?;
    let (pool_creation, pool_boundary, pool_boundary_manifests) =
        agreed_boundary(&acquisition, &providers, &chain, pool, "pool")?;
    let (configurator_creation, configurator_boundary, configurator_boundary_manifests) =
        agreed_boundary(
            &acquisition,
            &providers,
            &chain,
            configurator,
            "pool-configurator",
        )?;
    if configurator_creation.block_number() < pool_creation.block_number() {
        return Err(
            ChainError::Evidence("PoolConfigurator code predates Pool proxy code".into()).into(),
        );
    }

    let lineage = discover_configurator_lineage(
        &acquisition,
        &providers,
        &chain,
        addresses_provider,
        &provider_creation,
        &anchor,
        configurator,
    )?;
    if !lineage.configurators.contains(&configurator) {
        return Err(ChainError::Evidence(
            "current configurator is absent from certified lineage".into(),
        )
        .into());
    }

    let deployment = DeploymentKey::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        pool,
        stable_deployment_instance(pool, &pool_creation)?,
    );
    let interface = aave_interface();
    let mut scans = Vec::new();
    let mut per_provider = Vec::new();
    for provider in providers.iter() {
        let initialized = scan_history(
            &acquisition,
            provider,
            &chain,
            &deployment,
            &lineage.configurators,
            &provider_creation,
            interface.reserve_initialized_topic,
            "rmc006-aave-reserve-initialized",
            RESERVE_INIT_NAMESPACE,
        )?;
        let dropped = scan_history(
            &acquisition,
            provider,
            &chain,
            &deployment,
            &lineage.configurators,
            &provider_creation,
            interface.reserve_dropped_topic,
            "rmc006-aave-reserve-dropped",
            RESERVE_DROP_NAMESPACE,
        )?;
        let mut combined = initialized.logs()?;
        combined.extend(dropped.logs()?);
        combined.sort_by_key(|record| {
            (
                record.get("block").and_then(Json::as_i64).unwrap_or(-1),
                record.get("log_index").and_then(Json::as_i64).unwrap_or(-1),
            )
        });
        if combined.windows(2).any(|pair| {
            pair[0].get("block") == pair[1].get("block")
                && pair[0].get("log_index") == pair[1].get("log_index")
        }) {
            return Err(ChainError::Evidence(
                "duplicate reserve-event coordinates after topic merge".into(),
            )
            .into());
        }
        per_provider.push((provider.label().to_owned(), combined));
        scans.push((
            provider.label().to_owned(),
            "RESERVE_INITIALIZED".to_owned(),
            initialized,
        ));
        scans.push((
            provider.label().to_owned(),
            "RESERVE_DROPPED".to_owned(),
            dropped,
        ));
    }
    let logs = agree_logs("rmc006-aave-reserve-lifecycle", &per_provider)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;

    let interface = aave_interface();

    let interface = aave_interface();
    let mut lifecycle = BTreeMap::<Address, &'static str>::new();
    let mut latest_init = BTreeMap::<Address, LatestInit>::new();
    let mut event_records = Vec::with_capacity(logs.len());
    let mut init_count = 0_u64;
    let mut drop_count = 0_u64;
    for record in &logs {
        let raw = raw_log(record)?;
        let topic0 = raw
            .topics()
            .first()
            .ok_or_else(|| ChainError::Evidence("reserve lifecycle log has no topic0".into()))?;
        let mut output = Json::object([
            ("block", Json::uint(number(record, "block")?)),
            ("block_hash", Json::string(record.str_field("block_hash")?)),
            (
                "transaction_hash",
                Json::string(record.str_field("transaction_hash")?),
            ),
            ("log_index", Json::uint(number(record, "log_index")?)),
        ]);
        if topic0.as_bytes() == &interface.reserve_initialized_topic {
            let decoded = decode_reserve_initialized(configurator, &raw)
                .map_err(|error| ChainError::Evidence(error.to_string()))?;
            if lifecycle.get(&decoded.asset) == Some(&"ACTIVE") {
                return Err(ChainError::Evidence(format!(
                    "reserve {} initialized while already active",
                    decoded.asset.to_hex()
                ))
                .into());
            }
            lifecycle.insert(decoded.asset, "ACTIVE");
            latest_init.insert(
                decoded.asset,
                LatestInit {
                    a_token: decoded.a_token,
                    variable_debt_token: decoded.variable_debt_token,
                },
            );
            init_count += 1;
            if let Json::Object(ref mut members) = output {
                members.push(("kind".into(), Json::string("RESERVE_INITIALIZED")));
                members.push(("asset".into(), Json::string(decoded.asset.to_hex())));
                members.push(("a_token".into(), Json::string(decoded.a_token.to_hex())));
                members.push((
                    "variable_debt_token".into(),
                    Json::string(decoded.variable_debt_token.to_hex()),
                ));
            }
        } else if topic0.as_bytes() == &interface.reserve_dropped_topic {
            let decoded = decode_reserve_dropped(configurator, &raw)
                .map_err(|error| ChainError::Evidence(error.to_string()))?;
            if lifecycle.get(&decoded.asset) != Some(&"ACTIVE") {
                return Err(ChainError::Evidence(format!(
                    "reserve {} dropped without active predecessor",
                    decoded.asset.to_hex()
                ))
                .into());
            }
            lifecycle.insert(decoded.asset, "DROPPED");
            drop_count += 1;
            if let Json::Object(ref mut members) = output {
                members.push(("kind".into(), Json::string("RESERVE_DROPPED")));
                members.push(("asset".into(), Json::string(decoded.asset.to_hex())));
            }
        } else {
            return Err(ChainError::Evidence(
                "reserve lifecycle scan returned undeclared topic".into(),
            )
            .into());
        }
        event_records.push(output);
    }

    let current_by_asset: BTreeMap<_, _> = current_reserves
        .iter()
        .map(|reserve| (reserve.asset, reserve))
        .collect();
    let current_set: BTreeSet<_> = current_by_asset.keys().copied().collect();
    let event_active: BTreeSet<_> = lifecycle
        .iter()
        .filter_map(|(asset, state)| (*state == "ACTIVE").then_some(*asset))
        .collect();
    let historical_union: BTreeSet<_> = lifecycle.keys().copied().collect();
    let historical_dropped: BTreeSet<_> = lifecycle
        .iter()
        .filter_map(|(asset, state)| (*state == "DROPPED").then_some(*asset))
        .collect();

    let mut mismatches = Vec::new();
    for asset in current_set.difference(&event_active) {
        mismatches.push(Json::object([
            ("class", Json::string("CURRENT_ONLY")),
            ("asset", Json::string(asset.to_hex())),
        ]));
    }
    for asset in event_active.difference(&current_set) {
        mismatches.push(Json::object([
            ("class", Json::string("EVENT_ACTIVE_ONLY")),
            ("asset", Json::string(asset.to_hex())),
        ]));
    }
    for (asset, current) in &current_by_asset {
        if let Some(initialized) = latest_init.get(asset) {
            if current.a_token != initialized.a_token
                || current.variable_debt_token != initialized.variable_debt_token
            {
                mismatches.push(Json::object([
                    ("class", Json::string("TOKEN_IDENTITY_MISMATCH")),
                    ("asset", Json::string(asset.to_hex())),
                ]));
            }
        }
    }
    if !mismatches.is_empty() {
        return Err(ChainError::Evidence(format!(
            "history/current reconciliation has {} unexplained mismatches",
            mismatches.len()
        ))
        .into());
    }

    let scan_records = scans
        .iter()
        .map(|(provider, kind, scan)| scan_record(provider, kind, scan))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-006-aave-history-reconciliation-v1"),
        ),
        ("status", Json::string("HISTORY_RECONCILIATION_PASS")),
        ("bootstrap", bootstrap),
        ("addresses_provider_boundary", provider_boundary),
        (
            "addresses_provider_boundary_manifests",
            Json::array(
                provider_boundary_manifests
                    .iter()
                    .map(|manifest| Json::string(manifest.clone())),
            ),
        ),
        ("pool_boundary", pool_boundary),
        (
            "pool_boundary_manifests",
            Json::array(
                pool_boundary_manifests
                    .iter()
                    .map(|manifest| Json::string(manifest.clone())),
            ),
        ),
        ("pool_configurator_boundary", configurator_boundary),
        (
            "pool_configurator_boundary_manifests",
            Json::array(
                configurator_boundary_manifests
                    .iter()
                    .map(|manifest| Json::string(manifest.clone())),
            ),
        ),
        (
            "deployment_instance",
            Json::string(deployment.deployment_instance().to_hex()),
        ),
        (
            "configurators",
            Json::array(
                lineage
                    .configurators
                    .iter()
                    .map(|address| Json::string(address.to_hex())),
            ),
        ),
        ("configurator_updates", Json::Array(lineage.updates.clone())),
        (
            "configurator_lineage_manifests",
            Json::array(
                lineage
                    .manifests
                    .iter()
                    .map(|manifest| Json::string(manifest.clone())),
            ),
        ),
        ("reserve_events", Json::Array(event_records)),
        (
            "event_active",
            Json::array(
                event_active
                    .iter()
                    .map(|asset| Json::string(asset.to_hex())),
            ),
        ),
        (
            "historical_dropped",
            Json::array(
                historical_dropped
                    .iter()
                    .map(|asset| Json::string(asset.to_hex())),
            ),
        ),
        (
            "summary",
            Json::object([
                ("provider_count", Json::uint(providers.len() as u64)),
                (
                    "current_reserve_count",
                    Json::uint(current_reserves.len() as u64),
                ),
                ("reserve_initialized_count", Json::uint(init_count)),
                ("reserve_dropped_count", Json::uint(drop_count)),
                (
                    "historical_market_count",
                    Json::uint(historical_union.len() as u64),
                ),
                ("active_event_count", Json::uint(event_active.len() as u64)),
                (
                    "configurator_count",
                    Json::uint(lineage.configurators.len() as u64),
                ),
                (
                    "configurator_update_count",
                    Json::uint(lineage.updates.len() as u64),
                ),
                ("unexplained_delta_count", Json::uint(0)),
            ]),
        ),
        ("scan_evidence", Json::Array(scan_records)),
        (
            "open_blockers",
            Json::array([Json::string("D05_ADMISSION_NOT_YET_MATERIALIZED")]),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("GLOBAL_AAVE_COMPLETENESS_NOT_PROVEN"),
                Json::string("STATE_RECONSTRUCTION_NOT_TESTED"),
                Json::string("POSITIONS_NOT_TESTED"),
                Json::string("ECONOMICS_NOT_TESTED"),
            ]),
        ),
    ]))
}
