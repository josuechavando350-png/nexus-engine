use crate::DiscoveryError;
use nqc_census_chain::json::Json;
use nqc_census_core::{
    AdapterCapability, Address, AdmissionRecord, CanonicalMarketKey, DiscoveryRootKind,
    EvidenceRef, Hash32, MarketId, ProtocolFamily,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CurrentPair {
    pub index: u64,
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct PairCreatedProof {
    pub block_number: u64,
    pub block_hash: Hash32,
    pub transaction_hash: Hash32,
    pub transaction_index: u32,
    pub log_index: u32,
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
    pub ordinal: u64,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectLookupProof {
    pub token0: Address,
    pub token1: Address,
    pub returned_pair: Address,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeCodeProof {
    pub pair: Address,
    pub code_hash: Hash32,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum DeltaKind {
    EnumerationOnly,
    EventOnly,
    DirectLookupMissing,
    RuntimeCodeMissing,
}

impl DeltaKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::EnumerationOnly => "ENUMERATION_ONLY",
            Self::EventOnly => "EVENT_ONLY",
            Self::DirectLookupMissing => "DIRECT_LOOKUP_MISSING",
            Self::RuntimeCodeMissing => "RUNTIME_CODE_MISSING",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Delta {
    pub kind: DeltaKind,
    pub pair: Address,
    pub status: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairManifest {
    pub market_id: MarketId,
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
    pub current_index: Option<u64>,
    pub creation: Option<PairCreatedProof>,
    pub runtime_code_hash: Option<Hash32>,
    pub direct_lookup_verified: bool,
    pub sources: BTreeSet<&'static str>,
    pub evidence: Vec<EvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconciliationSummary {
    pub source_a_count: usize,
    pub source_b_count: usize,
    pub source_c_count: usize,
    pub union_count: usize,
    pub intersection_count: usize,
    pub enumeration_only_count: usize,
    pub event_only_count: usize,
    pub duplicate_observations: usize,
    pub historical_only_count: usize,
    pub explained_delta_count: usize,
    pub unexplained_delta_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reconciliation {
    pub admission_id: String,
    pub pairs: Vec<PairManifest>,
    pub deltas: Vec<Delta>,
    pub summary: ReconciliationSummary,
}

#[derive(Debug, Clone)]
struct BuildPair {
    pair: Address,
    token0: Address,
    token1: Address,
    current_index: Option<u64>,
    creation: Option<PairCreatedProof>,
    runtime_code_hash: Option<Hash32>,
    direct_lookup_verified: bool,
    sources: BTreeSet<&'static str>,
    evidence: Vec<EvidenceRef>,
}

fn validate_pair(
    root: Address,
    pair: Address,
    token0: Address,
    token1: Address,
) -> Result<(), DiscoveryError> {
    if token0 >= token1 {
        return Err(DiscoveryError::InvalidPair(
            "token ordering is not canonical",
        ));
    }
    if pair == root || pair == token0 || pair == token1 {
        return Err(DiscoveryError::InvalidPair(
            "pair collides with root/token address",
        ));
    }
    Ok(())
}

fn merge_evidence(target: &mut Vec<EvidenceRef>, source: &[EvidenceRef]) {
    target.extend_from_slice(source);
    target.sort_unstable();
    target.dedup();
}

fn insert_identity(
    by_pair: &mut BTreeMap<Address, BuildPair>,
    root: Address,
    pair: Address,
    token0: Address,
    token1: Address,
) -> Result<&mut BuildPair, DiscoveryError> {
    validate_pair(root, pair, token0, token1)?;
    let entry = by_pair.entry(pair).or_insert_with(|| BuildPair {
        pair,
        token0,
        token1,
        current_index: None,
        creation: None,
        runtime_code_hash: None,
        direct_lookup_verified: false,
        sources: BTreeSet::new(),
        evidence: Vec::new(),
    });
    if entry.token0 != token0 || entry.token1 != token1 {
        return Err(DiscoveryError::ConflictingPairIdentity);
    }
    Ok(entry)
}

fn token_key(token0: Address, token1: Address) -> Result<(Address, Address), DiscoveryError> {
    if token0 == token1 {
        return Err(DiscoveryError::InvalidPair("identical tokens"));
    }
    Ok(if token0 < token1 {
        (token0, token1)
    } else {
        (token1, token0)
    })
}

fn evidence_json(reference: EvidenceRef) -> Json {
    match reference {
        EvidenceRef::Observation(digest) => Json::object([
            ("kind", Json::string("OBSERVATION")),
            ("id", Json::string(digest.to_hex())),
        ]),
        EvidenceRef::Artifact(hash) => Json::object([
            ("kind", Json::string("ARTIFACT")),
            ("id", Json::string(hash.to_hex())),
        ]),
    }
}

impl Reconciliation {
    pub fn certifiable(&self) -> bool {
        self.summary.unexplained_delta_count == 0
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, DiscoveryError> {
        let pairs = self.pairs.iter().map(|pair| {
            let creation = pair.creation.as_ref().map_or(Json::Null, |created| {
                Json::object([
                    ("block_number", Json::uint(created.block_number)),
                    ("block_hash", Json::string(created.block_hash.to_hex())),
                    (
                        "transaction_hash",
                        Json::string(created.transaction_hash.to_hex()),
                    ),
                    (
                        "transaction_index",
                        Json::uint(u64::from(created.transaction_index)),
                    ),
                    ("log_index", Json::uint(u64::from(created.log_index))),
                    ("ordinal", Json::uint(created.ordinal)),
                ])
            });
            Json::object([
                ("market_id", Json::string(pair.market_id.to_hex())),
                ("pair", Json::string(pair.pair.to_hex())),
                ("token0", Json::string(pair.token0.to_hex())),
                ("token1", Json::string(pair.token1.to_hex())),
                (
                    "current_index",
                    pair.current_index.map_or(Json::Null, Json::uint),
                ),
                ("creation", creation),
                (
                    "runtime_code_hash",
                    pair.runtime_code_hash
                        .map_or(Json::Null, |hash| Json::string(hash.to_hex())),
                ),
                (
                    "direct_lookup_verified",
                    Json::Bool(pair.direct_lookup_verified),
                ),
                (
                    "sources",
                    Json::array(pair.sources.iter().map(|source| Json::string(*source))),
                ),
                (
                    "evidence",
                    Json::array(pair.evidence.iter().copied().map(evidence_json)),
                ),
            ])
        });
        let deltas = self.deltas.iter().map(|delta| {
            Json::object([
                ("kind", Json::string(delta.kind.code())),
                ("pair", Json::string(delta.pair.to_hex())),
                ("status", Json::string(delta.status)),
            ])
        });
        Json::object([
            ("schema", Json::string("nqc-rmc-007-v2-reconciliation-v1")),
            ("admission_id", Json::string(self.admission_id.clone())),
            ("pairs", Json::array(pairs)),
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
                    (
                        "source_C_count",
                        Json::uint(self.summary.source_c_count as u64),
                    ),
                    ("union_count", Json::uint(self.summary.union_count as u64)),
                    (
                        "intersection_count",
                        Json::uint(self.summary.intersection_count as u64),
                    ),
                    (
                        "enumeration_only_count",
                        Json::uint(self.summary.enumeration_only_count as u64),
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
    current: Vec<CurrentPair>,
    events: Vec<PairCreatedProof>,
    lookups: Vec<DirectLookupProof>,
    runtime: Vec<RuntimeCodeProof>,
) -> Result<Reconciliation, DiscoveryError> {
    let binding = admission.binding();
    if binding.deployment().protocol() != ProtocolFamily::UniswapV2 {
        return Err(DiscoveryError::Admission("not a Uniswap V2 deployment"));
    }
    if binding.discovery_root().kind() != DiscoveryRootKind::V2Factory {
        return Err(DiscoveryError::Admission(
            "discovery root is not a V2 factory",
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
    let root = binding.discovery_root().address();
    let deployment = binding.deployment().clone();

    let mut by_pair = BTreeMap::<Address, BuildPair>::new();
    let mut current_indices = BTreeMap::<u64, Address>::new();
    for item in &current {
        if let Some(existing) = current_indices.insert(item.index, item.pair) {
            if existing != item.pair {
                return Err(DiscoveryError::ConflictingEnumerationIndex);
            }
        }
        let entry = insert_identity(&mut by_pair, root, item.pair, item.token0, item.token1)?;
        if entry.current_index.is_some_and(|index| index != item.index) {
            return Err(DiscoveryError::ConflictingEnumerationIndex);
        }
        entry.current_index = Some(item.index);
        entry.sources.insert("CURRENT_ENUMERATION");
        merge_evidence(&mut entry.evidence, &item.evidence);
    }

    let mut seen_logs = BTreeMap::<(Hash32, Hash32, u32), (Address, Address, Address)>::new();
    let mut duplicate_observations = 0_usize;
    for event in &events {
        let coordinate = (event.block_hash, event.transaction_hash, event.log_index);
        let identity = (event.pair, event.token0, event.token1);
        if let Some(existing) = seen_logs.get(&coordinate) {
            if *existing != identity {
                return Err(DiscoveryError::ConflictingCreationLog);
            }
            duplicate_observations += 1;
            continue;
        }
        seen_logs.insert(coordinate, identity);
        let entry = insert_identity(&mut by_pair, root, event.pair, event.token0, event.token1)?;
        if entry.creation.is_some() {
            return Err(DiscoveryError::ConflictingCreationLog);
        }
        if let Some(index) = entry.current_index {
            let expected = index
                .checked_add(1)
                .ok_or(DiscoveryError::InvalidPair("enumeration index overflow"))?;
            if event.ordinal != expected {
                return Err(DiscoveryError::ConflictingEnumerationIndex);
            }
        }
        entry.creation = Some(event.clone());
        entry.sources.insert("PAIR_CREATED_HISTORY");
        merge_evidence(&mut entry.evidence, &event.evidence);
    }

    let mut by_tokens = BTreeMap::<(Address, Address), DirectLookupProof>::new();
    for proof in lookups {
        let key = token_key(proof.token0, proof.token1)?;
        if let Some(existing) = by_tokens.get(&key) {
            if existing.returned_pair != proof.returned_pair {
                return Err(DiscoveryError::ConflictingDirectLookup);
            }
            continue;
        }
        by_tokens.insert(key, proof);
    }

    let mut by_runtime = BTreeMap::<Address, RuntimeCodeProof>::new();
    for proof in runtime {
        if let Some(existing) = by_runtime.insert(proof.pair, proof.clone()) {
            if existing.code_hash != proof.code_hash {
                return Err(DiscoveryError::ConflictingPairIdentity);
            }
        }
    }

    let mut deltas = Vec::new();
    for entry in by_pair.values_mut() {
        let key = (entry.token0, entry.token1);
        if let Some(lookup) = by_tokens.get(&key) {
            if lookup.returned_pair != entry.pair {
                return Err(DiscoveryError::DirectLookupMismatch);
            }
            entry.direct_lookup_verified = true;
            entry.sources.insert("DIRECT_GET_PAIR");
            merge_evidence(&mut entry.evidence, &lookup.evidence);
        } else {
            deltas.push(Delta {
                kind: DeltaKind::DirectLookupMissing,
                pair: entry.pair,
                status: "UNEXPLAINED",
            });
        }
        if let Some(code) = by_runtime.get(&entry.pair) {
            entry.runtime_code_hash = Some(code.code_hash);
            merge_evidence(&mut entry.evidence, &code.evidence);
        } else {
            deltas.push(Delta {
                kind: DeltaKind::RuntimeCodeMissing,
                pair: entry.pair,
                status: "UNEXPLAINED",
            });
        }
        match (entry.current_index, entry.creation.is_some()) {
            (Some(_), false) => deltas.push(Delta {
                kind: DeltaKind::EnumerationOnly,
                pair: entry.pair,
                status: "UNEXPLAINED",
            }),
            (None, true) => deltas.push(Delta {
                kind: DeltaKind::EventOnly,
                pair: entry.pair,
                status: "UNEXPLAINED",
            }),
            _ => {}
        }
    }

    let source_a_count = by_pair
        .values()
        .filter(|pair| pair.current_index.is_some())
        .count();
    let source_b_count = by_pair
        .values()
        .filter(|pair| pair.creation.is_some())
        .count();
    let source_c_count = by_pair
        .values()
        .filter(|pair| pair.direct_lookup_verified)
        .count();
    let intersection_count = by_pair
        .values()
        .filter(|pair| pair.current_index.is_some() && pair.creation.is_some())
        .count();
    let enumeration_only_count = deltas
        .iter()
        .filter(|delta| delta.kind == DeltaKind::EnumerationOnly)
        .count();
    let event_only_count = deltas
        .iter()
        .filter(|delta| delta.kind == DeltaKind::EventOnly)
        .count();

    let mut pairs = Vec::with_capacity(by_pair.len());
    for entry in by_pair.into_values() {
        let market = CanonicalMarketKey::v2_pair(
            deployment.clone(),
            entry.pair,
            entry.token0,
            entry.token1,
        )?;
        pairs.push(PairManifest {
            market_id: market.id()?,
            pair: entry.pair,
            token0: entry.token0,
            token1: entry.token1,
            current_index: entry.current_index,
            creation: entry.creation,
            runtime_code_hash: entry.runtime_code_hash,
            direct_lookup_verified: entry.direct_lookup_verified,
            sources: entry.sources,
            evidence: entry.evidence,
        });
    }
    pairs.sort_by_key(|pair| pair.pair);
    deltas.sort();

    Ok(Reconciliation {
        admission_id: admission.id().to_hex(),
        summary: ReconciliationSummary {
            source_a_count,
            source_b_count,
            source_c_count,
            union_count: pairs.len(),
            intersection_count,
            enumeration_only_count,
            event_only_count,
            duplicate_observations,
            historical_only_count: event_only_count,
            explained_delta_count: 0,
            unexplained_delta_count: deltas.len(),
        },
        pairs,
        deltas,
    })
}
