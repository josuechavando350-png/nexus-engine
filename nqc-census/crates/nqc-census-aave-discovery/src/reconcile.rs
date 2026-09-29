use crate::DiscoveryError;
use nqc_census_chain::json::Json;
use nqc_census_core::{
    AdapterCapability, Address, AdmissionRecord, CanonicalMarketKey, DiscoveryRootKind,
    EvidenceRef, Hash32, MarketId, ProtocolFamily,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentReserve {
    pub reserve_id: u16,
    pub asset: Address,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReserveInitProof {
    pub block_number: u64,
    pub block_hash: Hash32,
    pub transaction_hash: Hash32,
    pub log_index: u32,
    pub asset: Address,
    pub a_token: Address,
    pub stable_debt_token: Address,
    pub variable_debt_token: Address,
    pub interest_rate_strategy: Address,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct ReserveDropProof {
    pub block_number: u64,
    pub block_hash: Hash32,
    pub transaction_hash: Hash32,
    pub log_index: u32,
    pub asset: Address,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeltaKind {
    GetterOnly,
    HistoricalOnlyDropped,
    HistoricalOnlyUnexplained,
}

impl DeltaKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::GetterOnly => "GETTER_ONLY",
            Self::HistoricalOnlyDropped => "HISTORICAL_ONLY_DROPPED",
            Self::HistoricalOnlyUnexplained => "HISTORICAL_ONLY_UNEXPLAINED",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Delta {
    pub kind: DeltaKind,
    pub asset: Address,
    pub status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReserveManifest {
    pub market_id: MarketId,
    pub asset: Address,
    pub current_reserve_id: Option<u16>,
    pub initialized: ReserveInitProof,
    pub dropped: Option<ReserveDropProof>,
    pub current: bool,
    pub sources: BTreeSet<&'static str>,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationSummary {
    pub source_a_count: usize,
    pub source_b_count: usize,
    pub union_count: usize,
    pub intersection_count: usize,
    pub getter_only_count: usize,
    pub event_only_count: usize,
    pub duplicate_observations: usize,
    pub historical_only_count: usize,
    pub currently_enumerated_count: usize,
    pub deprecated_or_removed_count: usize,
    pub explained_delta_count: usize,
    pub unexplained_delta_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub admission_id: String,
    pub reserves: Vec<ReserveManifest>,
    pub deltas: Vec<Delta>,
    pub summary: ReconciliationSummary,
}

fn merge_evidence(target: &mut Vec<EvidenceRef>, source: &[EvidenceRef]) {
    target.extend_from_slice(source);
    target.sort_unstable();
    target.dedup();
}

impl Reconciliation {
    pub fn certifiable(&self) -> bool {
        self.summary.unexplained_delta_count == 0
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, DiscoveryError> {
        let reserves = self.reserves.iter().map(|reserve| {
            Json::object([
                ("market_id", Json::string(reserve.market_id.to_hex())),
                ("asset", Json::string(reserve.asset.to_hex())),
                (
                    "current_reserve_id",
                    reserve
                        .current_reserve_id
                        .map_or(Json::Null, |id| Json::uint(u64::from(id))),
                ),
                ("current", Json::Bool(reserve.current)),
                (
                    "first_init_block",
                    Json::uint(reserve.initialized.block_number),
                ),
                (
                    "drop_block",
                    reserve
                        .dropped
                        .as_ref()
                        .map_or(Json::Null, |drop| Json::uint(drop.block_number)),
                ),
                (
                    "sources",
                    Json::array(reserve.sources.iter().map(|source| Json::string(*source))),
                ),
            ])
        });
        let deltas = self.deltas.iter().map(|delta| {
            Json::object([
                ("kind", Json::string(delta.kind.code())),
                ("asset", Json::string(delta.asset.to_hex())),
                ("status", Json::string(delta.status)),
            ])
        });
        Json::object([
            ("schema", Json::string("nqc-rmc-006-aave-reconciliation-v1")),
            ("admission_id", Json::string(self.admission_id.clone())),
            ("reserves", Json::array(reserves)),
            ("deltas", Json::array(deltas)),
            (
                "summary",
                Json::object([
                    (
                        "source_A_count",
                        Json::uint(self.summary.source_a_count as u64),
                    ),
                    (
                        "source_B_count",
                        Json::uint(self.summary.source_b_count as u64),
                    ),
                    ("union_count", Json::uint(self.summary.union_count as u64)),
                    (
                        "intersection_count",
                        Json::uint(self.summary.intersection_count as u64),
                    ),
                    (
                        "getter_only_count",
                        Json::uint(self.summary.getter_only_count as u64),
                    ),
                    (
                        "event_only_count",
                        Json::uint(self.summary.event_only_count as u64),
                    ),
                    (
                        "duplicate_observations",
                        Json::uint(self.summary.duplicate_observations as u64),
                    ),
                    (
                        "historical_only_count",
                        Json::uint(self.summary.historical_only_count as u64),
                    ),
                    (
                        "currently_enumerated_count",
                        Json::uint(self.summary.currently_enumerated_count as u64),
                    ),
                    (
                        "deprecated_or_removed_count",
                        Json::uint(self.summary.deprecated_or_removed_count as u64),
                    ),
                    (
                        "explained_delta_count",
                        Json::uint(self.summary.explained_delta_count as u64),
                    ),
                    (
                        "unexplained_delta_count",
                        Json::uint(self.summary.unexplained_delta_count as u64),
                    ),
                ]),
            ),
        ])
        .canonical()
        .map_err(DiscoveryError::from)
    }
}

pub fn reconcile(
    admission: &AdmissionRecord,
    current: Vec<CurrentReserve>,
    init_events: Vec<ReserveInitProof>,
    drop_events: Vec<ReserveDropProof>,
) -> Result<Reconciliation, DiscoveryError> {
    let binding = admission.binding();
    if binding.deployment().protocol() != ProtocolFamily::AaveV3 {
        return Err(DiscoveryError::Admission("not an Aave V3 deployment"));
    }
    if binding.discovery_root().kind() != DiscoveryRootKind::AaveAddressesProvider {
        return Err(DiscoveryError::Admission(
            "discovery root is not an Aave AddressesProvider",
        ));
    }
    if !binding
        .capabilities()
        .supports(AdapterCapability::MarketDiscovery)
    {
        return Err(DiscoveryError::Admission(
            "deployment is not admitted for market discovery",
        ));
    }

    let mut current_by_asset = BTreeMap::<Address, CurrentReserve>::new();
    let mut asset_by_id = BTreeMap::<u16, Address>::new();
    for reserve in current {
        if let Some(existing) = asset_by_id.insert(reserve.reserve_id, reserve.asset) {
            if existing != reserve.asset {
                return Err(DiscoveryError::ConflictingReserveId);
            }
        }
        if let Some(existing) = current_by_asset.insert(reserve.asset, reserve.clone()) {
            if existing.reserve_id != reserve.reserve_id {
                return Err(DiscoveryError::ConflictingReserveIdentity);
            }
        }
    }

    let mut inits = BTreeMap::<Address, ReserveInitProof>::new();
    let mut seen_init_logs = BTreeSet::<(Hash32, Hash32, u32)>::new();
    let mut duplicate_observations = 0_usize;
    for init in init_events {
        let coordinate = (init.block_hash, init.transaction_hash, init.log_index);
        if !seen_init_logs.insert(coordinate) {
            duplicate_observations += 1;
            continue;
        }
        match inits.get(&init.asset) {
            None => {
                inits.insert(init.asset, init);
            }
            Some(existing) if existing == &init => {
                duplicate_observations += 1;
            }
            Some(_) => return Err(DiscoveryError::ConflictingLifecycle),
        }
    }

    let mut drops = BTreeMap::<Address, ReserveDropProof>::new();
    let mut seen_drop_logs = BTreeSet::<(Hash32, Hash32, u32)>::new();
    for drop in drop_events {
        let coordinate = (drop.block_hash, drop.transaction_hash, drop.log_index);
        if !seen_drop_logs.insert(coordinate) {
            duplicate_observations += 1;
            continue;
        }
        if let Some(init) = inits.get(&drop.asset) {
            if drop.block_number <= init.block_number {
                return Err(DiscoveryError::ConflictingLifecycle);
            }
        } else {
            return Err(DiscoveryError::ConflictingLifecycle);
        }
        if drops.insert(drop.asset, drop).is_some() {
            return Err(DiscoveryError::ConflictingLifecycle);
        }
    }

    let mut assets = BTreeSet::new();
    assets.extend(current_by_asset.keys().copied());
    assets.extend(inits.keys().copied());

    let deployment = binding.deployment().clone();
    let union_count = assets.len();
    let mut reserves = Vec::new();
    let mut deltas = Vec::new();
    for asset in assets {
        let current = current_by_asset.get(&asset);
        let init = inits.get(&asset);
        let drop = drops.get(&asset);
        match (current, init, drop) {
            (Some(_), None, _) => {
                deltas.push(Delta {
                    kind: DeltaKind::GetterOnly,
                    asset,
                    status: "UNEXPLAINED",
                });
                continue;
            }
            (None, Some(initialized), Some(dropped)) => {
                let market = CanonicalMarketKey::aave_reserve(deployment.clone(), asset)?;
                let mut evidence = initialized.evidence.clone();
                merge_evidence(&mut evidence, &dropped.evidence);
                reserves.push(ReserveManifest {
                    market_id: market.id()?,
                    asset,
                    current_reserve_id: None,
                    initialized: initialized.clone(),
                    dropped: Some(dropped.clone()),
                    current: false,
                    sources: ["RESERVE_INITIALIZED_HISTORY", "RESERVE_DROPPED_HISTORY"]
                        .into_iter()
                        .collect(),
                    evidence,
                });
                deltas.push(Delta {
                    kind: DeltaKind::HistoricalOnlyDropped,
                    asset,
                    status: "EXPLAINED",
                });
            }
            (None, Some(initialized), None) => {
                let market = CanonicalMarketKey::aave_reserve(deployment.clone(), asset)?;
                reserves.push(ReserveManifest {
                    market_id: market.id()?,
                    asset,
                    current_reserve_id: None,
                    initialized: initialized.clone(),
                    dropped: None,
                    current: false,
                    sources: ["RESERVE_INITIALIZED_HISTORY"].into_iter().collect(),
                    evidence: initialized.evidence.clone(),
                });
                deltas.push(Delta {
                    kind: DeltaKind::HistoricalOnlyUnexplained,
                    asset,
                    status: "UNEXPLAINED",
                });
            }
            (Some(current), Some(initialized), None) => {
                let market = CanonicalMarketKey::aave_reserve(deployment.clone(), asset)?;
                let mut evidence = initialized.evidence.clone();
                merge_evidence(&mut evidence, &current.evidence);
                reserves.push(ReserveManifest {
                    market_id: market.id()?,
                    asset,
                    current_reserve_id: Some(current.reserve_id),
                    initialized: initialized.clone(),
                    dropped: None,
                    current: true,
                    sources: ["CURRENT_GETTER", "RESERVE_INITIALIZED_HISTORY"]
                        .into_iter()
                        .collect(),
                    evidence,
                });
            }
            (Some(_), Some(_), Some(_)) => return Err(DiscoveryError::ConflictingLifecycle),
            (None, None, _) => unreachable!("asset set requires current or init evidence"),
        }
    }
    reserves.sort_by_key(|reserve| reserve.asset);
    deltas.sort();

    let getter_only_count = deltas
        .iter()
        .filter(|delta| delta.kind == DeltaKind::GetterOnly)
        .count();
    let event_only_count = deltas
        .iter()
        .filter(|delta| {
            matches!(
                delta.kind,
                DeltaKind::HistoricalOnlyDropped | DeltaKind::HistoricalOnlyUnexplained
            )
        })
        .count();
    let explained_delta_count = deltas
        .iter()
        .filter(|delta| delta.status == "EXPLAINED")
        .count();
    let unexplained_delta_count = deltas.len() - explained_delta_count;
    let source_a_count = current_by_asset.len();
    let source_b_count = inits.len();
    let intersection_count = current_by_asset
        .keys()
        .filter(|asset| inits.contains_key(asset))
        .count();
    let currently_enumerated_count = reserves.iter().filter(|reserve| reserve.current).count();
    let deprecated_or_removed_count = reserves.iter().filter(|reserve| !reserve.current).count();

    Ok(Reconciliation {
        admission_id: admission.id().to_hex(),
        summary: ReconciliationSummary {
            source_a_count,
            source_b_count,
            union_count,
            intersection_count,
            getter_only_count,
            event_only_count,
            duplicate_observations,
            historical_only_count: event_only_count,
            currently_enumerated_count,
            deprecated_or_removed_count,
            explained_delta_count,
            unexplained_delta_count,
        },
        reserves,
        deltas,
    })
}
