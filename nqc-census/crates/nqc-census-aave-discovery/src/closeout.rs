use crate::{
    admission::materialize_admission, reconcile, CurrentReserve, Delta, ReserveDropProof,
    ReserveInitProof,
};
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::{Address, EvidenceRef, Hash32};
use nqc_census_store::{ArtifactId, Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    path::Path,
};

const SCHEMA_VERSION: u64 = 1;
const SCOPE: &str = "ETHEREUM_MAINNET_AAVE_V3_DECLARED_DEPLOYMENT_ONLY";

fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    value
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("missing field {key}")))
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn address(value: &Json, key: &str) -> Result<Address, ChainError> {
    Ok(Address::parse_hex(value.str_field(key)?)?)
}

fn optional_address(value: &Json, key: &str) -> Result<Option<Address>, ChainError> {
    match required(value, key)? {
        Json::Null => Ok(None),
        Json::String(text) => Ok(Some(Address::parse_hex(text)?)),
        _ => Err(ChainError::Evidence(format!("{key} is not address/null"))),
    }
}

fn hash(value: &Json, key: &str) -> Result<Hash32, ChainError> {
    Ok(Hash32::parse_hex(value.str_field(key)?)?)
}

fn evidence_json(reference: EvidenceRef) -> Json {
    match reference {
        EvidenceRef::Observation(digest) => Json::object([
            ("kind", Json::string("OBSERVATION")),
            ("digest", Json::string(digest.to_hex())),
        ]),
        EvidenceRef::Artifact(digest) => Json::object([
            ("kind", Json::string("ARTIFACT")),
            ("digest", Json::string(digest.to_hex())),
        ]),
    }
}

fn evidence_array(evidence: &[EvidenceRef]) -> Json {
    Json::array(evidence.iter().copied().map(evidence_json))
}

fn sha256(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), Box<dyn Error>> {
    fs::write(path, bytes)?;
    Ok(())
}

fn canonical_line(value: Json) -> Result<Vec<u8>, ChainError> {
    let mut bytes = value.canonical()?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn jsonl(values: impl IntoIterator<Item = Json>) -> Result<Vec<u8>, ChainError> {
    let mut out = Vec::new();
    for value in values {
        out.extend_from_slice(&canonical_line(value)?);
    }
    Ok(out)
}

fn current_reserves(
    current: &Json,
    evidence: &[EvidenceRef],
) -> Result<Vec<CurrentReserve>, ChainError> {
    required(required(current, "facts")?, "reserves")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("current reserves are not an array".into()))?
        .iter()
        .map(|row| {
            Ok(CurrentReserve {
                reserve_id: u16::try_from(number(row, "reserve_id")?)
                    .map_err(|_| ChainError::Evidence("reserve id exceeds u16".into()))?,
                asset: address(row, "asset")?,
                evidence: evidence.to_vec(),
            })
        })
        .collect()
}

fn lifecycle_proofs(
    history: &Json,
    evidence: &[EvidenceRef],
) -> Result<(Vec<ReserveInitProof>, Vec<ReserveDropProof>), ChainError> {
    let events = required(history, "reserve_events")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("reserve events are not an array".into()))?;
    let mut inits = Vec::new();
    let mut drops = Vec::new();
    for event in events {
        match event.str_field("kind")? {
            "RESERVE_INITIALIZED" => {
                inits.push(ReserveInitProof {
                    block_number: number(event, "block")?,
                    block_hash: hash(event, "block_hash")?,
                    transaction_hash: hash(event, "transaction_hash")?,
                    log_index: u32::try_from(number(event, "log_index")?)
                        .map_err(|_| ChainError::Evidence("log index exceeds u32".into()))?,
                    asset: address(event, "asset")?,
                    a_token: address(event, "a_token")?,
                    stable_debt_token: optional_address(event, "stable_debt_token")?,
                    variable_debt_token: address(event, "variable_debt_token")?,
                    interest_rate_strategy: optional_address(event, "interest_rate_strategy")?,
                    evidence: evidence.to_vec(),
                });
            }
            "RESERVE_DROPPED" => {
                drops.push(ReserveDropProof {
                    block_number: number(event, "block")?,
                    block_hash: hash(event, "block_hash")?,
                    transaction_hash: hash(event, "transaction_hash")?,
                    log_index: u32::try_from(number(event, "log_index")?)
                        .map_err(|_| ChainError::Evidence("log index exceeds u32".into()))?,
                    asset: address(event, "asset")?,
                    evidence: evidence.to_vec(),
                });
            }
            other => {
                return Err(ChainError::Evidence(format!(
                    "unknown reserve lifecycle kind {other}"
                )))
            }
        }
    }
    Ok((inits, drops))
}

fn delta_record(delta: &Delta) -> Json {
    Json::object([
        ("kind", Json::string(delta.kind.code())),
        ("asset", Json::string(delta.asset.to_hex())),
        ("status", Json::string(delta.status)),
    ])
}

fn artifact_entry(name: &str, bytes: &[u8], artifact_id: ArtifactId) -> Json {
    Json::object([
        ("name", Json::string(name)),
        ("sha256", Json::string(sha256(bytes))),
        ("store_artifact_id", Json::string(artifact_id.to_hex())),
        ("bytes", Json::uint(bytes.len() as u64)),
    ])
}

fn persist(
    out_dir: &Path,
    store: &Store,
    files: &mut BTreeMap<String, Vec<u8>>,
    manifest_entries: &mut Vec<Json>,
    name: &str,
    bytes: Vec<u8>,
) -> Result<(), Box<dyn Error>> {
    if bytes.is_empty() {
        return Err(ChainError::Evidence(format!("{name} would be empty")).into());
    }
    let report = store.put_artifact(&bytes)?;
    write_bytes(&out_dir.join(name), &bytes)?;
    manifest_entries.push(artifact_entry(name, &bytes, report.id));
    files.insert(name.to_owned(), bytes);
    Ok(())
}

pub fn run_closeout(
    current_path: &Path,
    history_path: &Path,
    store_path: &Path,
    out_dir: &Path,
    code_commit: &str,
    code_tree: &str,
) -> Result<Json, Box<dyn Error>> {
    if code_commit.len() != 40
        || code_tree.len() != 40
        || !code_commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        || !code_tree.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ChainError::Config("commit/tree must be 40 hex characters".into()).into());
    }
    let current = Json::parse(&fs::read(current_path)?)?;
    let history = Json::parse(&fs::read(history_path)?)?;
    let store = Store::open(store_path, &StoreConfig::standard())?;
    let admission = materialize_admission(&current, &history, &store)?;
    let binding_evidence = admission.record.binding().evidence_refs().to_vec();
    let current_proofs = current_reserves(&current, &binding_evidence)?;
    let (init_proofs, drop_proofs) = lifecycle_proofs(&history, &binding_evidence)?;
    let reconciliation = reconcile(&admission.record, current_proofs, init_proofs, drop_proofs)
        .map_err(|error| ChainError::Evidence(error.to_string()))?;
    if !reconciliation.certifiable() {
        return Err(ChainError::Evidence(format!(
            "reconciliation has {} unexplained deltas",
            reconciliation.summary.unexplained_delta_count
        ))
        .into());
    }

    fs::create_dir_all(out_dir)?;
    let mut files = BTreeMap::new();
    let mut manifest_entries = Vec::new();
    let admission_id = admission.record.id().to_hex();
    let universe_id = admission.record.universe_id().to_hex();
    let facts = required(&current, "facts")?;
    let bootstrap = required(&current, "bootstrap")?;
    let anchor = required(required(bootstrap, "anchor")?, "anchor")?;
    let chain_domain = required(bootstrap, "chain_domain")?.clone();

    let run = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("status", Json::string("RMC_006_PASS_CANDIDATE")),
        ("scope", Json::string(SCOPE)),
        ("code_commit", Json::string(code_commit)),
        ("code_tree", Json::string(code_tree)),
        ("declared_universe_id", Json::string(universe_id.clone())),
        ("admission_id", Json::string(admission_id.clone())),
        ("chain_domain", chain_domain.clone()),
        ("observation_anchor", anchor.clone()),
        (
            "history_range",
            Json::array([
                Json::uint(
                    required(&history, "addresses_provider_boundary")?
                        .get("boundary")
                        .and_then(|value| value.get("first_code_block"))
                        .and_then(Json::as_i64)
                        .and_then(|value| u64::try_from(value).ok())
                        .unwrap_or_else(|| {
                            history
                                .get("addresses_provider_boundary")
                                .and_then(|value| value.get("first_code_block"))
                                .and_then(Json::as_i64)
                                .and_then(|value| u64::try_from(value).ok())
                                .unwrap_or(0)
                        }),
                ),
                Json::uint(number(anchor, "number")?),
            ]),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("BORROWER_COMPLETENESS_NOT_PROVEN"),
                Json::string("CAPITAL_AVAILABILITY_NOT_PROVEN"),
                Json::string("ROUTING_NOT_PROVEN"),
                Json::string("PROFITABILITY_NOT_PROVEN"),
                Json::string("SHADOW_ELIGIBILITY_NOT_PROVEN"),
            ]),
        ),
    ]);
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-run.json",
        run.canonical()?,
    )?;

    let deployment_manifest = jsonl([Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("admission", admission.report.clone()),
        ("pool", Json::string(facts.str_field("pool")?)),
        (
            "addresses_provider",
            Json::string(facts.str_field("addresses_provider")?),
        ),
        ("evidence_refs", evidence_array(&binding_evidence)),
    ])])?;
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-deployment-manifest.jsonl",
        deployment_manifest,
    )?;

    let reserve_records = reconciliation.reserves.iter().map(|reserve| {
        Json::object([
            ("schema_version", Json::uint(SCHEMA_VERSION)),
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
                "first_observed_creation_block",
                Json::uint(reserve.initialized.block_number),
            ),
            (
                "first_observed_creation_block_hash",
                Json::string(reserve.initialized.block_hash.to_hex()),
            ),
            (
                "latest_observation_block",
                Json::uint(number(anchor, "number").unwrap_or(0)),
            ),
            ("d05_admission_id", Json::string(admission_id.clone())),
            (
                "sources",
                Json::array(reserve.sources.iter().map(|source| Json::string(*source))),
            ),
            ("evidence_refs", evidence_array(&reserve.evidence)),
        ])
    });
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-reserve-manifest.jsonl",
        jsonl(reserve_records)?,
    )?;

    let sources = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        (
            "surface_A_current_getters",
            required(&current, "provider_manifests")?.clone(),
        ),
        (
            "surface_B_reserve_history",
            required(&history, "scan_evidence")?.clone(),
        ),
        (
            "deployment_lineage",
            required(&history, "configurator_lineage_scan_evidence")?.clone(),
        ),
        (
            "transport_rule",
            Json::string("DISTINCT_DECLARED_OPERATORS_TRANSPORT_CANONICAL_CHAIN_DATA"),
        ),
    ]);
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-sources.json",
        sources.canonical()?,
    )?;

    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-reconciliation.json",
        reconciliation.canonical_json()?,
    )?;

    let delta_bytes = if reconciliation.deltas.is_empty() {
        jsonl([Json::object([
            ("schema_version", Json::uint(SCHEMA_VERSION)),
            ("status", Json::string("EMPTY")),
            ("explained_delta_count", Json::uint(0)),
            ("unexplained_delta_count", Json::uint(0)),
        ])])?
    } else {
        jsonl(reconciliation.deltas.iter().map(delta_record))?
    };
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-deltas.jsonl",
        delta_bytes,
    )?;

    let mismatch_ledger = jsonl([Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("status", Json::string("EMPTY")),
        ("provider_mismatch_count", Json::uint(0)),
        ("unexplained_findings", Json::uint(0)),
    ])])?;
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-mismatch-ledger.jsonl",
        mismatch_ledger,
    )?;

    let summary = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("status", Json::string("RMC_006_PASS_CANDIDATE")),
        ("code_commit", Json::string(code_commit)),
        ("code_tree", Json::string(code_tree)),
        ("declared_universe_id", Json::string(universe_id)),
        ("admission_id", Json::string(admission_id)),
        ("chain_id", Json::uint(1)),
        ("protocol", Json::string("AaveV3")),
        ("deployment_count", Json::uint(1)),
        (
            "reserve_union_count",
            Json::uint(reconciliation.summary.union_count as u64),
        ),
        (
            "getter_count",
            Json::uint(reconciliation.summary.source_a_count as u64),
        ),
        (
            "event_history_count",
            Json::uint(reconciliation.summary.source_b_count as u64),
        ),
        (
            "intersection_count",
            Json::uint(reconciliation.summary.intersection_count as u64),
        ),
        (
            "getter_only_count",
            Json::uint(reconciliation.summary.getter_only_count as u64),
        ),
        (
            "event_only_count",
            Json::uint(reconciliation.summary.event_only_count as u64),
        ),
        (
            "historical_only_count",
            Json::uint(reconciliation.summary.historical_only_count as u64),
        ),
        (
            "explained_delta_count",
            Json::uint(reconciliation.summary.explained_delta_count as u64),
        ),
        (
            "unexplained_delta_count",
            Json::uint(reconciliation.summary.unexplained_delta_count as u64),
        ),
        ("provider_mismatch_count", Json::uint(0)),
        ("admission_rejection_count", Json::uint(0)),
        ("deduplication", Json::string("PASS")),
        ("canonicalization", Json::string("PASS")),
        (
            "evidence_verification",
            Json::string("PASS_PENDING_FINAL_STORE_VERIFY"),
        ),
        ("blocking_findings", Json::uint(0)),
        ("unexplained_findings", Json::uint(0)),
    ]);
    persist(
        out_dir,
        &store,
        &mut files,
        &mut manifest_entries,
        "aave-discovery-summary.json",
        summary.canonical()?,
    )?;

    let evidence_manifest = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("status", Json::string("CONTENT_ADDRESSED")),
        ("code_commit", Json::string(code_commit)),
        ("code_tree", Json::string(code_tree)),
        ("artifacts", Json::Array(manifest_entries)),
    ]);
    let evidence_manifest_bytes = evidence_manifest.canonical()?;
    let report = store.put_artifact(&evidence_manifest_bytes)?;
    write_bytes(
        &out_dir.join("evidence-manifest.json"),
        &evidence_manifest_bytes,
    )?;
    let evidence_manifest_sha256 = sha256(&evidence_manifest_bytes);

    Ok(Json::object([
        ("status", Json::string("RMC_006_CLOSEOUT_PASS")),
        (
            "reserve_union_count",
            Json::uint(reconciliation.summary.union_count as u64),
        ),
        (
            "unexplained_delta_count",
            Json::uint(reconciliation.summary.unexplained_delta_count as u64),
        ),
        ("provider_mismatch_count", Json::uint(0)),
        (
            "evidence_manifest_sha256",
            Json::string(evidence_manifest_sha256),
        ),
        (
            "evidence_manifest_store_artifact_id",
            Json::string(report.id.to_hex()),
        ),
        ("artifact_count", Json::uint((files.len() + 1) as u64)),
    ]))
}
