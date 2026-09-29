//! Cross-provider reconstruction of the complete reserve lifecycle history
//! and its reconciliation with the exact-anchor current surface.

use crate::{
    aave_interface, decode_reserve_dropped, decode_reserve_initialized,
    lineage::{coordinate, discover_lineage, raw_log, Coordinate, Lineage, LineageExpectation},
};
use nqc_census_chain::{
    acquire::{anchor_from_result, raw_log_semantics, Acquisition, ScanOutcome},
    bootstrap::run_bootstrap,
    boundary::earliest_code_body,
    consensus::{agree, agree_logs, ProviderResult},
    ethereum::ChainProfile,
    job::{JobSpec, LogFilter},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{Address, ChainDomain, DeploymentKey, Hash32, ProtocolFamily, StateAnchor};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    fs,
    path::Path,
};

const BOUNDARY_NAMESPACE: u16 = 0x0602;
const RESERVE_INIT_NAMESPACE: u16 = 0x0605;
const RESERVE_DROP_NAMESPACE: u16 = 0x0606;
pub const HISTORY_SCHEMA: &str = "nqc-rmc-006-aave-history-reconciliation-v2";

/// What the history reconstruction is bound to. `mainnet()` is the declared
/// RMC-006 deployment; tests bind a synthetic chain.
#[derive(Debug, Clone)]
pub struct HistoryPlan {
    pub profile: ChainProfile,
    pub anchor_number: u64,
    pub anchor_hash: Hash32,
    pub addresses_provider: Address,
    pub pool: Address,
    /// Lower bound of every earliest-code search.
    pub boundary_floor: u64,
    pub checkpoint_span: u64,
}

impl HistoryPlan {
    pub fn mainnet() -> Result<Self, ChainError> {
        Self::mainnet_at(crate::live::anchor_from_flags(None, None)?)
    }

    /// The declared deployment observed at another anchor.
    pub fn mainnet_at((anchor_number, anchor_hash): (u64, Hash32)) -> Result<Self, ChainError> {
        Ok(Self {
            profile: ChainProfile::mainnet()?,
            anchor_number,
            anchor_hash,
            addresses_provider: Address::parse_hex("0x2f39d218133afab8f2b819b1066c7e434ad94e9e")?,
            pool: Address::parse_hex("0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2")?,
            boundary_floor: 1,
            checkpoint_span: 1_000_000,
        })
    }
}

/// The exact-anchor current surface, as agreed by the current-surface run.
#[derive(Debug, Clone)]
struct CurrentSurface {
    configurator: Address,
    configurator_implementation: Address,
    pool_implementation: Address,
    /// Reserve id slots `0..getReservesCount()`; `None` is a dropped slot.
    slots: Vec<Option<Address>>,
    tokens: BTreeMap<Address, (Address, Address)>,
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

fn current_surface(report: &Json, plan: &HistoryPlan) -> Result<CurrentSurface, ChainError> {
    if report.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS") {
        return Err(ChainError::Evidence(
            "current-surface report is not PASS".into(),
        ));
    }
    let facts = report
        .get("facts")
        .ok_or_else(|| ChainError::Evidence("current report has no facts".into()))?;
    if address_field(facts, "pool")? != plan.pool
        || address_field(facts, "addresses_provider")? != plan.addresses_provider
    {
        return Err(ChainError::Evidence(
            "current report deployment differs from the declared plan".into(),
        ));
    }
    let anchor = report
        .get("bootstrap")
        .and_then(|bootstrap| bootstrap.get("anchor"))
        .and_then(|anchor| anchor.get("anchor"))
        .ok_or_else(|| ChainError::Evidence("current report names no anchor".into()))?;
    if number(anchor, "number")? != plan.anchor_number
        || anchor.str_field("hash")? != plan.anchor_hash.to_hex()
    {
        return Err(ChainError::Evidence(
            "current report was observed at another anchor than the history plan".into(),
        ));
    }
    let count = usize::try_from(number(facts, "reserve_count")?)
        .map_err(|_| ChainError::Evidence("reserve count exceeds usize".into()))?;
    let mut slots: Vec<Option<Option<Address>>> = vec![None; count];
    let mut tokens = BTreeMap::new();
    for row in facts
        .get("reserves")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("current report has no reserves".into()))?
    {
        let id = usize::try_from(number(row, "reserve_id")?)
            .map_err(|_| ChainError::Evidence("reserve id exceeds usize".into()))?;
        let asset = address_field(row, "asset")?;
        let slot = slots
            .get_mut(id)
            .ok_or_else(|| ChainError::Evidence("reserve id beyond getReservesCount".into()))?;
        if slot.replace(Some(asset)).is_some() {
            return Err(ChainError::Evidence("duplicate current reserve id".into()));
        }
        if tokens
            .insert(
                asset,
                (
                    address_field(row, "a_token")?,
                    address_field(row, "variable_debt_token")?,
                ),
            )
            .is_some()
        {
            return Err(ChainError::Evidence(
                "duplicate current reserve asset".into(),
            ));
        }
    }
    for id in facts
        .get("dropped_reserve_ids")
        .and_then(Json::as_array)
        .unwrap_or_default()
    {
        let id = id
            .as_i64()
            .and_then(|id| usize::try_from(id).ok())
            .ok_or_else(|| ChainError::Evidence("dropped reserve id is not an integer".into()))?;
        let slot = slots
            .get_mut(id)
            .ok_or_else(|| ChainError::Evidence("dropped id beyond getReservesCount".into()))?;
        if slot.replace(None).is_some() {
            return Err(ChainError::Evidence(
                "dropped id is also a current reserve".into(),
            ));
        }
    }
    let slots = slots
        .into_iter()
        .map(|slot| {
            slot.ok_or_else(|| ChainError::Evidence("reserve id slot is unaccounted".into()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CurrentSurface {
        configurator: address_field(facts, "pool_configurator")?,
        configurator_implementation: address_field(facts, "pool_configurator_implementation")?,
        pool_implementation: address_field(facts, "pool_implementation")?,
        slots,
        tokens,
    })
}

fn boundary_result(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    plan: &HistoryPlan,
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
            ("lo", Json::uint(plan.boundary_floor)),
            ("hi", Json::uint(plan.anchor_number)),
        ]),
    )?;
    let output = acquisition.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
        earliest_code_body(ctx, account, plan.boundary_floor, plan.anchor_number)
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
    chain: &ChainDomain,
    plan: &HistoryPlan,
    account: Address,
    label: &str,
) -> Result<(StateAnchor, Json, Vec<String>), ChainError> {
    let mut results = Vec::new();
    for provider in providers.iter() {
        results.push(boundary_result(
            acquisition,
            provider,
            chain,
            plan,
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

#[allow(clippy::too_many_arguments)]
fn scan_reserve_events(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    deployment: &DeploymentKey,
    configurators: &[Address],
    origin: &StateAnchor,
    plan: &HistoryPlan,
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
        plan.anchor_number,
        plan.checkpoint_span,
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

fn strings(values: &[String]) -> Json {
    Json::array(values.iter().map(|value| Json::string(value.clone())))
}

fn addresses<'a>(values: impl IntoIterator<Item = &'a Address>) -> Json {
    Json::array(
        values
            .into_iter()
            .map(|address| Json::string(address.to_hex())),
    )
}

/// Replays the agreed lifecycle in canonical order and checks every event
/// against the configurator the Pool trusted at that point. Reserve ids are
/// assigned as Aave V3 `_addReserveToList` does: the first empty slot below
/// the count, otherwise the next id; a drop empties its slot.
struct Lifecycle {
    records: Vec<Json>,
    active: BTreeMap<Address, usize>,
    dropped: BTreeSet<Address>,
    slots: Vec<Option<Address>>,
    latest_init: BTreeMap<Address, (Address, Address)>,
    init_count: u64,
    drop_count: u64,
}

fn replay_lifecycle(logs: &[Json], lineage: &Lineage) -> Result<Lifecycle, ChainError> {
    let interface = aave_interface();
    let mut ordered: Vec<(Coordinate, &Json)> = logs
        .iter()
        .map(|record| Ok((coordinate(record)?, record)))
        .collect::<Result<_, ChainError>>()?;
    ordered.sort_by_key(|(coordinate, _)| *coordinate);
    let mut state = Lifecycle {
        records: Vec::with_capacity(ordered.len()),
        active: BTreeMap::new(),
        dropped: BTreeSet::new(),
        slots: Vec::new(),
        latest_init: BTreeMap::new(),
        init_count: 0,
        drop_count: 0,
    };
    for (position, record) in ordered {
        let raw = raw_log(record)?;
        let configurator = lineage.configurator_at(position).ok_or_else(|| {
            ChainError::Evidence("reserve event outside every configurator window".into())
        })?;
        if raw.emitter() != configurator {
            return Err(ChainError::Evidence(format!(
                "reserve event at block {} emitted by {} while the Pool trusted {}",
                position.0,
                raw.emitter().to_hex(),
                configurator.to_hex()
            )));
        }
        let topic0 = *raw
            .topics()
            .first()
            .ok_or_else(|| ChainError::Evidence("reserve lifecycle log has no topic0".into()))?
            .as_bytes();
        let mut output = vec![
            ("block", Json::uint(position.0)),
            ("block_hash", Json::string(record.str_field("block_hash")?)),
            (
                "transaction_hash",
                Json::string(record.str_field("transaction_hash")?),
            ),
            ("transaction_index", Json::uint(u64::from(position.1))),
            ("log_index", Json::uint(u64::from(position.2))),
            ("configurator", Json::string(configurator.to_hex())),
        ];
        if topic0 == interface.reserve_initialized_topic {
            let decoded = decode_reserve_initialized(configurator, &raw)
                .map_err(|error| ChainError::Evidence(error.to_string()))?;
            if state.active.contains_key(&decoded.asset) {
                return Err(ChainError::Evidence(format!(
                    "reserve {} initialized while already active",
                    decoded.asset.to_hex()
                )));
            }
            let slot = match state.slots.iter().position(Option::is_none) {
                Some(free) => free,
                None => {
                    state.slots.push(None);
                    state.slots.len() - 1
                }
            };
            state.slots[slot] = Some(decoded.asset);
            state.active.insert(decoded.asset, slot);
            state.dropped.remove(&decoded.asset);
            state.latest_init.insert(
                decoded.asset,
                (decoded.a_token, decoded.variable_debt_token),
            );
            state.init_count += 1;
            output.extend([
                ("kind", Json::string("RESERVE_INITIALIZED")),
                ("asset", Json::string(decoded.asset.to_hex())),
                ("simulated_reserve_id", Json::uint(slot as u64)),
                ("a_token", Json::string(decoded.a_token.to_hex())),
                (
                    "stable_debt_token",
                    decoded
                        .stable_debt_token
                        .map_or(Json::Null, |address| Json::string(address.to_hex())),
                ),
                (
                    "variable_debt_token",
                    Json::string(decoded.variable_debt_token.to_hex()),
                ),
                (
                    "interest_rate_strategy",
                    decoded
                        .interest_rate_strategy
                        .map_or(Json::Null, |address| Json::string(address.to_hex())),
                ),
            ]);
        } else if topic0 == interface.reserve_dropped_topic {
            let decoded = decode_reserve_dropped(configurator, &raw)
                .map_err(|error| ChainError::Evidence(error.to_string()))?;
            let slot = state.active.remove(&decoded.asset).ok_or_else(|| {
                ChainError::Evidence(format!(
                    "reserve {} dropped without active predecessor",
                    decoded.asset.to_hex()
                ))
            })?;
            state.slots[slot] = None;
            state.dropped.insert(decoded.asset);
            state.drop_count += 1;
            output.extend([
                ("kind", Json::string("RESERVE_DROPPED")),
                ("asset", Json::string(decoded.asset.to_hex())),
                ("simulated_reserve_id", Json::uint(slot as u64)),
            ]);
        } else {
            return Err(ChainError::Evidence(
                "reserve lifecycle scan returned an undeclared topic".into(),
            ));
        }
        state.records.push(Json::object(output));
    }
    Ok(state)
}

/// Reconciles the replayed lifecycle with the exact-anchor surface. Every
/// difference is an unexplained delta.
fn lifecycle_deltas(lifecycle: &Lifecycle, current: &CurrentSurface) -> Vec<Json> {
    let delta = |class: &str, detail: Vec<(&str, Json)>| {
        let mut members = vec![
            ("class", Json::string(class)),
            ("status", Json::string("UNEXPLAINED")),
        ];
        members.extend(detail);
        Json::object(members)
    };
    let mut deltas = Vec::new();
    let current_assets: BTreeSet<Address> = current.slots.iter().flatten().copied().collect();
    let event_active: BTreeSet<Address> = lifecycle.active.keys().copied().collect();
    for asset in current_assets.difference(&event_active) {
        deltas.push(delta(
            "CURRENT_ONLY",
            vec![("asset", Json::string(asset.to_hex()))],
        ));
    }
    for asset in event_active.difference(&current_assets) {
        deltas.push(delta(
            "EVENT_ACTIVE_ONLY",
            vec![("asset", Json::string(asset.to_hex()))],
        ));
    }
    if lifecycle.slots.len() != current.slots.len() {
        deltas.push(delta(
            "RESERVE_COUNT_MISMATCH",
            vec![
                ("simulated", Json::uint(lifecycle.slots.len() as u64)),
                ("current", Json::uint(current.slots.len() as u64)),
            ],
        ));
    }
    for (id, (simulated, observed)) in lifecycle.slots.iter().zip(&current.slots).enumerate() {
        if simulated != observed {
            let show = |slot: &Option<Address>| {
                slot.map_or(Json::Null, |address| Json::string(address.to_hex()))
            };
            deltas.push(delta(
                "RESERVE_ID_SLOT_MISMATCH",
                vec![
                    ("reserve_id", Json::uint(id as u64)),
                    ("simulated", show(simulated)),
                    ("current", show(observed)),
                ],
            ));
        }
    }
    for (asset, tokens) in &current.tokens {
        if let Some(initialized) = lifecycle.latest_init.get(asset) {
            if initialized != tokens {
                deltas.push(delta(
                    "TOKEN_IDENTITY_MISMATCH",
                    vec![("asset", Json::string(asset.to_hex()))],
                ));
            }
        }
    }
    deltas
}

/// Reconstructs and reconciles the complete history through `acquisition`.
/// Transport-agnostic: live runs use curl, verification replays the store.
pub fn history_with(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    plan: &HistoryPlan,
    current_report: &Json,
) -> Result<Json, ChainError> {
    let current = current_surface(current_report, plan)?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(acquisition, providers, &plan.profile, plan.anchor_number)?;
    if anchor.block_hash() != plan.anchor_hash {
        return Err(ChainError::Evidence(
            "D06 history anchor hash differs".into(),
        ));
    }
    let mut replay_manifests = Vec::new();
    for record in bootstrap
        .get("providers")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("bootstrap report without providers".into()))?
    {
        replay_manifests.push(record.str_field("bootstrap_manifest")?.to_owned());
        replay_manifests.push(record.str_field("anchor_manifest")?.to_owned());
    }

    let (provider_creation, provider_boundary, provider_boundary_manifests) = agreed_boundary(
        acquisition,
        providers,
        &chain,
        plan,
        plan.addresses_provider,
        "addresses-provider",
    )?;
    let (pool_creation, pool_boundary, pool_boundary_manifests) =
        agreed_boundary(acquisition, providers, &chain, plan, plan.pool, "pool")?;
    let (configurator_creation, configurator_boundary, configurator_boundary_manifests) =
        agreed_boundary(
            acquisition,
            providers,
            &chain,
            plan,
            current.configurator,
            "pool-configurator",
        )?;
    if pool_creation.block_number() < provider_creation.block_number()
        || configurator_creation.block_number() < pool_creation.block_number()
    {
        return Err(ChainError::Evidence(
            "Pool or PoolConfigurator code predates its AddressesProvider or Pool".into(),
        ));
    }
    for manifests in [
        &provider_boundary_manifests,
        &pool_boundary_manifests,
        &configurator_boundary_manifests,
    ] {
        replay_manifests.extend(manifests.iter().cloned());
    }

    let lineage = discover_lineage(
        acquisition,
        providers,
        &chain,
        LineageExpectation {
            root: plan.addresses_provider,
            pool: plan.pool,
            pool_implementation: current.pool_implementation,
            pool_creation_block: pool_creation.block_number(),
            configurator: current.configurator,
            configurator_implementation: current.configurator_implementation,
            configurator_creation_block: configurator_creation.block_number(),
        },
        &provider_creation,
        &anchor,
        plan.checkpoint_span,
    )?;
    replay_manifests.extend(lineage.manifests.iter().cloned());

    let deployment = DeploymentKey::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        plan.pool,
        stable_deployment_instance(plan.pool, &pool_creation)?,
    );
    let interface = aave_interface();
    let configurators = lineage.configurator_addresses();
    let mut scans = Vec::new();
    let mut per_provider = Vec::new();
    for provider in providers.iter() {
        let initialized = scan_reserve_events(
            acquisition,
            provider,
            &chain,
            &deployment,
            &configurators,
            &provider_creation,
            plan,
            interface.reserve_initialized_topic,
            "rmc006-aave-reserve-initialized",
            RESERVE_INIT_NAMESPACE,
        )?;
        let dropped = scan_reserve_events(
            acquisition,
            provider,
            &chain,
            &deployment,
            &configurators,
            &provider_creation,
            plan,
            interface.reserve_dropped_topic,
            "rmc006-aave-reserve-dropped",
            RESERVE_DROP_NAMESPACE,
        )?;
        let mut combined = initialized.logs()?;
        combined.extend(dropped.logs()?);
        per_provider.push((provider.label().to_owned(), combined));
        for (kind, scan) in [
            ("RESERVE_INITIALIZED", &initialized),
            ("RESERVE_DROPPED", &dropped),
        ] {
            replay_manifests.extend(
                scan.windows
                    .iter()
                    .map(|window| window.manifest_id().to_hex()),
            );
            scans.push(scan_record(provider.label(), kind, scan)?);
        }
    }
    let logs = agree_logs("rmc006-aave-reserve-lifecycle", &per_provider)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let lifecycle = replay_lifecycle(&logs, &lineage)?;
    let deltas = lifecycle_deltas(&lifecycle, &current);
    if !deltas.is_empty() {
        let detail = Json::Array(deltas).canonical_string()?;
        return Err(ChainError::Evidence(format!(
            "history/current reconciliation has unexplained deltas: {detail}"
        )));
    }

    replay_manifests.sort();
    replay_manifests.dedup();
    let historical: BTreeSet<Address> = lifecycle
        .active
        .keys()
        .chain(&lifecycle.dropped)
        .copied()
        .collect();
    let configurator_lineage_manifests = lineage.manifests.clone();
    Ok(Json::object([
        ("schema", Json::string(HISTORY_SCHEMA)),
        ("status", Json::string("HISTORY_RECONCILIATION_PASS")),
        ("bootstrap", bootstrap),
        ("addresses_provider_boundary", provider_boundary),
        (
            "addresses_provider_boundary_manifests",
            strings(&provider_boundary_manifests),
        ),
        ("pool_boundary", pool_boundary),
        ("pool_boundary_manifests", strings(&pool_boundary_manifests)),
        ("pool_configurator_boundary", configurator_boundary),
        (
            "pool_configurator_boundary_manifests",
            strings(&configurator_boundary_manifests),
        ),
        (
            "deployment_instance",
            Json::string(deployment.deployment_instance().to_hex()),
        ),
        ("configurators", addresses(&configurators)),
        ("lineage", lineage.json()),
        (
            "configurator_lineage_manifests",
            strings(&configurator_lineage_manifests),
        ),
        (
            "configurator_lineage_scan_evidence",
            Json::Array(lineage.scan_evidence.clone()),
        ),
        ("reserve_events", Json::Array(lifecycle.records.clone())),
        ("event_active", addresses(lifecycle.active.keys())),
        ("historical_dropped", addresses(&lifecycle.dropped)),
        (
            "simulated_reserve_slots",
            Json::array(
                lifecycle
                    .slots
                    .iter()
                    .map(|slot| slot.map_or(Json::Null, |address| Json::string(address.to_hex()))),
            ),
        ),
        (
            "summary",
            Json::object([
                ("provider_count", Json::uint(providers.len() as u64)),
                (
                    "current_reserve_count",
                    Json::uint(current.slots.iter().flatten().count() as u64),
                ),
                (
                    "reserve_id_slot_count",
                    Json::uint(current.slots.len() as u64),
                ),
                (
                    "reserve_initialized_count",
                    Json::uint(lifecycle.init_count),
                ),
                ("reserve_dropped_count", Json::uint(lifecycle.drop_count)),
                (
                    "historical_market_count",
                    Json::uint(historical.len() as u64),
                ),
                (
                    "active_event_count",
                    Json::uint(lifecycle.active.len() as u64),
                ),
                ("configurator_count", Json::uint(configurators.len() as u64)),
                (
                    "configurator_replacement_count",
                    Json::uint(lineage.configurator_replacements.len() as u64),
                ),
                (
                    "pool_implementation_update_count",
                    Json::uint(lineage.pool_implementation_updates.len() as u64),
                ),
                (
                    "configurator_implementation_update_count",
                    Json::uint(lineage.configurator_implementation_updates.len() as u64),
                ),
                ("lineage_log_count", Json::uint(lineage.log_count)),
                (
                    "lineage_zero_topic_log_count",
                    Json::uint(lineage.zero_topic_log_count),
                ),
                ("provider_mismatch_count", Json::uint(0)),
                ("unexplained_delta_count", Json::uint(0)),
            ]),
        ),
        ("scan_evidence", Json::Array(scans)),
        ("replay_manifests", strings(&replay_manifests)),
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

/// Live run on the declared deployment at `plan`'s anchor.
pub fn run_history(
    providers_path: &Path,
    current_path: &Path,
    store_path: &Path,
    plan: &HistoryPlan,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let current = Json::parse(&fs::read(current_path)?)?;
    let store = Store::create(store_path, StoreConfig::standard())?;
    let transport = CurlTransport::new(90, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    Ok(history_with(&acquisition, &providers, plan, &current)?)
}
