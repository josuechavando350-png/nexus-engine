//! Offline RMC-007 closeout: replay every live report and stage record,
//! reconcile, admit, and write deterministic artifacts.
//!
//! Stage records are replayed either here, from one store holding every
//! stage's evidence (`reconcile_offline`), or beforehand, one stage per store,
//! into extracts (`verify::stage_extract`) that `reconcile_extracts` checks
//! and binds to the current-surface anchor. Both paths reconcile the same
//! replayed data with the same checks.

use crate::boundary::factory_boundary_with;
use crate::live::current_surface_with;
use crate::stage::{canonical_sha256, V2Plan};
use crate::verify::{admit, extract_stages, reconcile_surfaces, replay_stage, surfaces};
use nqc_census_chain::{
    acquire::Acquisition,
    job::JOB_MANIFEST_SCHEMA,
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{HttpReply, RetryPolicy, Transport},
    ChainError,
};
use nqc_census_core::EvidenceRef;
use nqc_census_store::{ArtifactId, Store};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::Path;
use std::sync::Mutex;

const SCHEMA_VERSION: u64 = 1;
const SCOPE: &str = "ETHEREUM_MAINNET_UNISWAP_V2_DECLARED_FACTORY_ONLY";
const STORE_SEGMENT_TARGET_BYTES: usize = 64 * 1024 * 1024;
const STORE_ENCODING_SINGLE: &str = "RMC004_SINGLE_ARTIFACT_V1";
const STORE_ENCODING_SEGMENTED: &str = "RMC004_ORDERED_SEGMENTS_V1";

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    value
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("missing field {key}")))
}

/// RFC 3339 UTC time of a Unix timestamp (proleptic Gregorian calendar).
fn rfc3339(timestamp: u64) -> String {
    let days = timestamp / 86_400;
    let seconds = timestamp % 86_400;
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds / 3_600,
        (seconds % 3_600) / 60,
        seconds % 60
    )
}

/// Every manifest a multi-provider live report names.
fn report_manifests(report: &Json, keys: &[&str]) -> Result<Vec<ArtifactId>, ChainError> {
    let mut out = Vec::new();
    for record in required(required(report, "bootstrap")?, "providers")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("bootstrap providers are not an array".into()))?
    {
        for key in ["bootstrap_manifest", "anchor_manifest"] {
            out.push(ArtifactId::parse_hex(record.str_field(key)?)?);
        }
    }
    for key in keys {
        for row in required(report, key)?
            .as_array()
            .ok_or_else(|| ChainError::Evidence(format!("{key} is not an array")))?
        {
            out.push(ArtifactId::parse_hex(row.str_field("manifest")?)?);
        }
    }
    Ok(out)
}

/// Recorded response bytes keyed by provider namespace and request digest.
///
/// A public RPC may answer the same JSON-RPC request with different bytes that
/// parse to the same JSON value (for example key order or trailing whitespace).
/// A map that keeps only one response per request therefore cannot reproduce
/// every job manifest byte-for-byte. Preserve every recorded occurrence in the
/// order the report executed its jobs, just as RMC-006 does for history replay.
type Occurrences = BTreeMap<(u16, [u8; 32]), VecDeque<Vec<u8>>>;

struct SequencedReplay {
    queues: Mutex<Occurrences>,
}

impl Transport for SequencedReplay {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let key = (provider.namespace(), Sha256::digest(body).into());
        let mut queues = self
            .queues
            .lock()
            .map_err(|_| ChainError::Replay("replay state is poisoned"))?;
        queues
            .get_mut(&key)
            .and_then(VecDeque::pop_front)
            .map(|body| HttpReply { status: 200, body })
            .ok_or(ChainError::Replay(
                "request was never recorded, or not that many times",
            ))
    }
}

fn replay_transport(
    store: &Store,
    providers: &[ProviderSpec],
    manifests: &[ArtifactId],
) -> Result<SequencedReplay, ChainError> {
    let mut queues = Occurrences::new();
    for id in manifests {
        let bytes = store.get_artifact(id)?;
        let manifest = Json::parse(&bytes)?;
        if manifest.get("schema").and_then(Json::as_str) != Some(JOB_MANIFEST_SCHEMA) {
            return Err(ChainError::Evidence(format!(
                "{} is not a job manifest",
                id.to_hex()
            )));
        }
        let descriptor = manifest
            .get("job")
            .and_then(|job| job.get("provider"))
            .ok_or_else(|| ChainError::Evidence("manifest names no provider".into()))?;
        let mut owner = None;
        for provider in providers {
            if provider.descriptor().same_as(descriptor)? {
                owner = Some(provider);
            }
        }
        let owner = owner.ok_or_else(|| {
            ChainError::Evidence("manifest provider is not a declared provider".into())
        })?;
        for exchange in manifest
            .get("exchanges")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("manifest without exchanges".into()))?
        {
            let request =
                store.get_artifact(&ArtifactId::parse_hex(exchange.str_field("request")?)?)?;
            let response =
                store.get_artifact(&ArtifactId::parse_hex(exchange.str_field("response")?)?)?;
            queues
                .entry((owner.namespace(), Sha256::digest(&request).into()))
                .or_default()
                .push_back(response);
        }
    }
    Ok(SequencedReplay {
        queues: Mutex::new(queues),
    })
}

/// Inputs of the offline closeout.
pub struct Inputs<'a> {
    pub store: &'a Store,
    pub plan: &'a V2Plan,
    /// Providers of the current-surface and boundary runs.
    pub surface_providers: &'a ProviderSet,
    /// Providers of the partitioned stages.
    pub stage_providers: &'a [ProviderSpec],
    pub current: &'a Json,
    pub boundary: &'a Json,
    pub records: &'a [Json],
    /// RMC-004 verification summary of each stage's own store, in record
    /// order, when stages were replayed one store at a time; empty otherwise.
    pub stage_stores: &'a [Json],
}

/// Replays the current-surface and boundary reports; returns their manifests.
fn replay_reports(inputs: &Inputs<'_>) -> Result<Vec<ArtifactId>, ChainError> {
    let surface_specs: Vec<ProviderSpec> = inputs.surface_providers.iter().cloned().collect();
    let current_manifests = report_manifests(inputs.current, &["provider_manifests"])?;
    let replay = replay_transport(inputs.store, &surface_specs, &current_manifests)?;
    let replayed = current_surface_with(
        &Acquisition::new(inputs.store, &replay, RetryPolicy::none()),
        inputs.surface_providers,
    )?;
    if !replayed.same_as(inputs.current)? {
        return Err(ChainError::Evidence(
            "current-surface report does not reproduce".into(),
        ));
    }
    let boundary_manifests = report_manifests(inputs.boundary, &["provider_manifests"])?;
    let replay = replay_transport(inputs.store, &surface_specs, &boundary_manifests)?;
    let replayed = factory_boundary_with(
        &Acquisition::new(inputs.store, &replay, RetryPolicy::none()),
        inputs.surface_providers,
    )?;
    if !replayed.same_as(inputs.boundary)? {
        return Err(ChainError::Evidence(
            "factory boundary report does not reproduce".into(),
        ));
    }

    Ok(current_manifests
        .into_iter()
        .chain(boundary_manifests)
        .collect())
}

/// Replays, agrees, reconciles and admits. Fails closed on any provider
/// mismatch, finding or unexplained delta.
pub fn reconcile_offline(
    inputs: &Inputs<'_>,
) -> Result<(crate::Reconciliation, Json, Json), ChainError> {
    let report_manifests = replay_reports(inputs)?;
    let mut stages = Vec::with_capacity(inputs.records.len());
    for record in inputs.records {
        let rows = replay_stage(inputs.store, inputs.stage_providers, inputs.plan, record)?;
        stages.push((record.clone(), rows));
    }
    reconcile_stages(inputs, &report_manifests, stages)
}

/// As `reconcile_offline`, from stages already replayed one store at a time.
/// `extracts` must be in the order of `inputs.records`, each naming exactly
/// its record, and every extract must carry the current-surface chain domain
/// and observation anchor.
pub fn reconcile_extracts(
    inputs: &Inputs<'_>,
    extracts: Vec<Json>,
) -> Result<(crate::Reconciliation, Json, Json), ChainError> {
    let report_manifests = replay_reports(inputs)?;
    let stages = extract_stages(inputs.current, inputs.stage_providers, extracts)?;
    if stages.len() != inputs.records.len() {
        return Err(ChainError::Evidence(
            "extracts and records differ in number".into(),
        ));
    }
    for ((record, _), expected) in stages.iter().zip(inputs.records) {
        if !record.same_as(expected)? {
            return Err(ChainError::Evidence(
                "an extract names another record".into(),
            ));
        }
    }
    reconcile_stages(inputs, &report_manifests, stages)
}

fn reconcile_stages(
    inputs: &Inputs<'_>,
    report_manifests: &[ArtifactId],
    stages: Vec<(Json, Vec<Json>)>,
) -> Result<(crate::Reconciliation, Json, Json), ChainError> {
    let facts = required(inputs.current, "facts")?;
    let pair_count = number(facts, "pair_count")?;
    let first_block = number(inputs.boundary, "first_code_block")?;
    let mut evidence: BTreeSet<EvidenceRef> = BTreeSet::new();
    for id in report_manifests {
        evidence.insert(id.evidence_ref()?);
    }
    for (record, _) in &stages {
        for id in record
            .get("manifests")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("record lists no manifests".into()))?
        {
            evidence.insert(
                ArtifactId::parse_hex(
                    id.as_str()
                        .ok_or_else(|| ChainError::Evidence("manifest id is not text".into()))?,
                )?
                .evidence_ref()?,
            );
        }
    }
    let agreed = surfaces(inputs.plan, pair_count, first_block, stages)?;
    let agreement = agreed.agreement.clone();
    let (record, admission_report) = admit(
        inputs.plan.factory,
        inputs.current,
        inputs.boundary,
        evidence.into_iter().collect(),
    )?;
    let (reconciliation, findings) = reconcile_surfaces(&record, agreed)?;
    if !findings.is_empty() {
        return Err(ChainError::Evidence(format!(
            "surface findings: {}",
            Json::Array(findings).canonical_string()?
        )));
    }
    if !reconciliation.certifiable() {
        let deltas: Vec<Json> = reconciliation
            .deltas
            .iter()
            .take(20)
            .map(|delta| {
                Json::object([
                    ("kind", Json::string(delta.kind.code())),
                    ("pair", Json::string(delta.pair.to_hex())),
                ])
            })
            .collect();
        return Err(ChainError::Evidence(format!(
            "reconciliation has {} unexplained deltas, first: {}",
            reconciliation.summary.unexplained_delta_count,
            Json::Array(deltas).canonical_string()?
        )));
    }
    let counts = &reconciliation.summary;
    if counts.source_a_count as u64 != pair_count
        || counts.source_b_count as u64 != pair_count
        || counts.source_c_count as u64 != pair_count
        || counts.union_count as u64 != pair_count
        || counts.intersection_count as u64 != pair_count
    {
        return Err(ChainError::Evidence(
            "surface counts differ from allPairsLength".into(),
        ));
    }
    Ok((reconciliation, admission_report, agreement))
}

fn jsonl(values: impl IntoIterator<Item = Json>) -> Result<Vec<u8>, ChainError> {
    let mut out = Vec::new();
    for value in values {
        out.extend_from_slice(&value.canonical()?);
        out.push(b'\n');
    }
    Ok(out)
}

fn evidence_json(reference: &EvidenceRef) -> Json {
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

fn validate_closeout_pass_candidate(
    summary: &crate::ReconciliationSummary,
    delta_count: usize,
    pair_rows: usize,
    agreement: &Json,
    expected_pair_count: u64,
) -> Result<(), ChainError> {
    let provider_mismatches = number(agreement, "provider_mismatch_count")?;
    let counts_match = summary.source_a_count as u64 == expected_pair_count
        && summary.source_b_count as u64 == expected_pair_count
        && summary.source_c_count as u64 == expected_pair_count
        && summary.union_count as u64 == expected_pair_count
        && summary.intersection_count as u64 == expected_pair_count
        && pair_rows as u64 == expected_pair_count;
    let ledgers_empty = delta_count == 0
        && summary.enumeration_only_count == 0
        && summary.event_only_count == 0
        && summary.unexplained_delta_count == 0
        && provider_mismatches == 0;
    if expected_pair_count == 0 || !counts_match || !ledgers_empty {
        return Err(ChainError::Evidence(format!(
            "refusing RMC-007 PASS closeout: expected_pairs={expected_pair_count} pair_rows={pair_rows} A={} B={} C={} union={} intersection={} enumeration_only={} event_only={} unexplained={} deltas={delta_count} provider_mismatches={provider_mismatches}",
            summary.source_a_count,
            summary.source_b_count,
            summary.source_c_count,
            summary.union_count,
            summary.intersection_count,
            summary.enumeration_only_count,
            summary.event_only_count,
            summary.unexplained_delta_count,
        )));
    }
    Ok(())
}

fn store_evidence_entry(store: &Store, name: &str, bytes: &[u8]) -> Result<Json, ChainError> {
    let logical_sha256 = nqc_census_chain::hex::plain(&sha2_digest(bytes));
    let logical_bytes = u64::try_from(bytes.len())
        .map_err(|_| ChainError::Evidence(format!("{name} length exceeds u64")))?;

    if logical_bytes <= store.config().max_artifact_bytes() {
        let put = store.put_artifact(bytes)?;
        if put.id.to_hex() != logical_sha256 {
            return Err(ChainError::Evidence(format!(
                "{name} store identity differs from its sha256"
            )));
        }
        return Ok(Json::object([
            ("name", Json::string(name)),
            ("sha256", Json::string(logical_sha256)),
            ("bytes", Json::uint(logical_bytes)),
            ("store_encoding", Json::string(STORE_ENCODING_SINGLE)),
            ("store_artifact_id", Json::string(put.id.to_hex())),
        ]));
    }

    let store_limit = usize::try_from(store.config().max_artifact_bytes())
        .map_err(|_| ChainError::Evidence("store artifact bound exceeds usize".into()))?;
    let target = STORE_SEGMENT_TARGET_BYTES.min(store_limit);
    if target == 0 {
        return Err(ChainError::Evidence(
            "store artifact bound does not permit segmentation".into(),
        ));
    }

    let mut segments = Vec::new();
    let mut offset = 0_usize;
    while offset < bytes.len() {
        let end = offset.saturating_add(target).min(bytes.len());
        if end <= offset {
            return Err(ChainError::Evidence(
                "segmented artifact made no forward progress".into(),
            ));
        }
        let segment = &bytes[offset..end];
        let put = store.put_artifact(segment)?;
        let segment_sha256 = nqc_census_chain::hex::plain(&sha2_digest(segment));
        if put.id.to_hex() != segment_sha256 {
            return Err(ChainError::Evidence(format!(
                "{name} segment store identity differs from its sha256"
            )));
        }
        segments.push(Json::object([
            (
                "sequence",
                Json::uint(
                    u64::try_from(segments.len())
                        .map_err(|_| ChainError::Evidence("segment count exceeds u64".into()))?,
                ),
            ),
            (
                "offset",
                Json::uint(
                    u64::try_from(offset)
                        .map_err(|_| ChainError::Evidence("segment offset exceeds u64".into()))?,
                ),
            ),
            (
                "bytes",
                Json::uint(
                    u64::try_from(segment.len())
                        .map_err(|_| ChainError::Evidence("segment length exceeds u64".into()))?,
                ),
            ),
            ("sha256", Json::string(segment_sha256)),
            ("store_artifact_id", Json::string(put.id.to_hex())),
        ]));
        offset = end;
    }

    Ok(Json::object([
        ("name", Json::string(name)),
        ("sha256", Json::string(logical_sha256)),
        ("bytes", Json::uint(logical_bytes)),
        ("store_encoding", Json::string(STORE_ENCODING_SEGMENTED)),
        (
            "segment_target_bytes",
            Json::uint(
                u64::try_from(target)
                    .map_err(|_| ChainError::Evidence("segment target exceeds u64".into()))?,
            ),
        ),
        (
            "segment_count",
            Json::uint(
                u64::try_from(segments.len())
                    .map_err(|_| ChainError::Evidence("segment count exceeds u64".into()))?,
            ),
        ),
        ("store_segments", Json::Array(segments)),
    ]))
}

/// Writes the deterministic closeout artifacts and returns the report.
#[allow(clippy::too_many_arguments)]
pub fn write_closeout(
    inputs: &Inputs<'_>,
    reconciliation: &crate::Reconciliation,
    admission: &Json,
    agreement: &Json,
    out_dir: &Path,
    code_commit: &str,
    code_tree: &str,
) -> Result<Json, ChainError> {
    let hex40 =
        |value: &str| value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if !hex40(code_commit) || !hex40(code_tree) {
        return Err(ChainError::Config(
            "commit/tree must be 40 hex characters".into(),
        ));
    }
    let expected_pair_count = number(required(inputs.current, "facts")?, "pair_count")?;
    validate_closeout_pass_candidate(
        &reconciliation.summary,
        reconciliation.deltas.len(),
        reconciliation.pairs.len(),
        agreement,
        expected_pair_count,
    )?;
    std::fs::create_dir_all(out_dir)
        .map_err(|error| ChainError::Config(format!("{}: {error}", out_dir.display())))?;
    let bootstrap = required(inputs.current, "bootstrap")?;
    let anchor = required(required(bootstrap, "anchor")?, "anchor")?;
    let generated_at = rfc3339(number(anchor, "timestamp")?);
    let header = |artifact: &str| {
        vec![
            ("schema_version", Json::uint(SCHEMA_VERSION)),
            ("artifact", Json::string(artifact)),
            ("generated_at", Json::string(generated_at.clone())),
            (
                "generated_at_basis",
                Json::string("OBSERVATION_ANCHOR_BLOCK_TIMESTAMP"),
            ),
            ("code_commit", Json::string(code_commit)),
            ("code_tree", Json::string(code_tree)),
            (
                "declared_universe_id",
                Json::string(admission.str_field("universe_id").unwrap_or("")),
            ),
            (
                "admission_id",
                Json::string(admission.str_field("admission_id").unwrap_or("")),
            ),
            ("scope", Json::string(SCOPE)),
        ]
    };
    let with_header = |artifact: &str, fields: Vec<(&str, Json)>| {
        let mut members = header(artifact);
        members.extend(fields);
        Json::object(members)
    };
    let first_block = number(inputs.boundary, "first_code_block")?;
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();

    if !inputs.stage_stores.is_empty() && inputs.stage_stores.len() != inputs.records.len() {
        return Err(ChainError::Evidence(
            "stage store summaries do not match the records".into(),
        ));
    }
    let stage_rows: Vec<Json> = inputs
        .records
        .iter()
        .enumerate()
        .map(|(position, record)| {
            let parameters = record.get("parameters").cloned().unwrap_or(Json::Null);
            Ok(Json::object([
                ("stage", Json::string(record.str_field("stage")?)),
                (
                    "provider",
                    Json::string(required(record, "provider")?.str_field("label")?),
                ),
                ("parameters", parameters),
                (
                    "data_sha256",
                    Json::string(record.str_field("data_sha256")?),
                ),
                ("record_sha256", Json::string(canonical_sha256(record)?)),
                (
                    "stage_store",
                    inputs
                        .stage_stores
                        .get(position)
                        .cloned()
                        .unwrap_or(Json::Null),
                ),
            ]))
        })
        .collect::<Result<_, ChainError>>()?;
    files.push((
        "v2-discovery-run.json".into(),
        with_header(
            "RMC007_DISCOVERY_RUN",
            vec![
                ("status", Json::string("RMC_007_PASS_CANDIDATE")),
                ("chain_domain", required(bootstrap, "chain_domain")?.clone()),
                ("observation_anchor", anchor.clone()),
                (
                    "history_range",
                    Json::array([
                        Json::uint(first_block),
                        Json::uint(number(anchor, "number")?),
                    ]),
                ),
                ("factory", Json::string(inputs.plan.factory.to_hex())),
                ("stage_records", Json::Array(stage_rows)),
                ("provider_agreement", agreement.clone()),
                (
                    "non_claims",
                    Json::array([
                        Json::string("ALL_V2_FORKS_NOT_CLAIMED"),
                        Json::string("STATE_AND_LIQUIDITY_NOT_PROVEN"),
                        Json::string("TOKEN_BEHAVIOR_NOT_PROVEN"),
                        Json::string("ROUTING_NOT_PROVEN"),
                        Json::string("PROFITABILITY_NOT_PROVEN"),
                    ]),
                ),
            ],
        )
        .canonical()?,
    ));

    let pairs = reconciliation.pairs.iter().map(|pair| {
        let creation = pair.creation.as_ref().map_or(Json::Null, |created| {
            Json::object([
                ("block_number", Json::uint(created.block_number)),
                ("block_hash", Json::string(created.block_hash.to_hex())),
                (
                    "transaction_hash",
                    Json::string(created.transaction_hash.to_hex()),
                ),
                ("log_index", Json::uint(u64::from(created.log_index))),
                ("ordinal", Json::uint(created.ordinal)),
            ])
        });
        Json::object([
            ("schema_version", Json::uint(SCHEMA_VERSION)),
            ("market_id", Json::string(pair.market_id.to_hex())),
            ("pair", Json::string(pair.pair.to_hex())),
            ("token0", Json::string(pair.token0.to_hex())),
            ("token1", Json::string(pair.token1.to_hex())),
            ("index", pair.current_index.map_or(Json::Null, Json::uint)),
            ("creation", creation),
            ("runtime_verified", Json::Bool(pair.runtime_verified)),
            (
                "direct_lookup_verified",
                Json::Bool(pair.direct_lookup_verified),
            ),
            (
                "sources",
                Json::array(pair.sources.iter().map(|source| Json::string(*source))),
            ),
            (
                "evidence_refs",
                Json::array(pair.evidence.iter().map(evidence_json)),
            ),
        ])
    });
    files.push(("v2-pair-manifest.jsonl".into(), jsonl(pairs)?));

    let summary = &reconciliation.summary;
    let counts = vec![
        ("pair_count", Json::uint(summary.union_count as u64)),
        (
            "source_A_enumeration_count",
            Json::uint(summary.source_a_count as u64),
        ),
        (
            "source_B_pair_created_count",
            Json::uint(summary.source_b_count as u64),
        ),
        (
            "source_C_direct_lookup_count",
            Json::uint(summary.source_c_count as u64),
        ),
        (
            "intersection_count",
            Json::uint(summary.intersection_count as u64),
        ),
        (
            "enumeration_only_count",
            Json::uint(summary.enumeration_only_count as u64),
        ),
        (
            "event_only_count",
            Json::uint(summary.event_only_count as u64),
        ),
        (
            "duplicate_observations",
            Json::uint(summary.duplicate_observations as u64),
        ),
        (
            "explained_delta_count",
            Json::uint(summary.explained_delta_count as u64),
        ),
        (
            "unexplained_delta_count",
            Json::uint(summary.unexplained_delta_count as u64),
        ),
        (
            "provider_mismatch_count",
            required(agreement, "provider_mismatch_count")?.clone(),
        ),
    ];
    files.push((
        "v2-deltas.jsonl".into(),
        jsonl([with_header(
            "RMC007_DELTAS",
            vec![
                ("status", Json::string("EMPTY")),
                ("unexplained_delta_count", Json::uint(0)),
            ],
        )])?,
    ));
    files.push((
        "v2-mismatch-ledger.jsonl".into(),
        jsonl([with_header(
            "RMC007_MISMATCH_LEDGER",
            vec![
                ("status", Json::string("EMPTY")),
                ("provider_mismatch_count", Json::uint(0)),
            ],
        )])?,
    ));
    files.push((
        "v2-deployment-admission.json".into(),
        admission.canonical()?,
    ));
    let mut summary_fields = vec![("status", Json::string("RMC_007_PASS_CANDIDATE"))];
    summary_fields.extend(counts);
    files.push((
        "v2-discovery-summary.json".into(),
        with_header("RMC007_SUMMARY", summary_fields).canonical()?,
    ));

    let mut entries = Vec::with_capacity(files.len());
    for (name, bytes) in &files {
        let entry = store_evidence_entry(inputs.store, name, bytes)?;
        std::fs::write(out_dir.join(name), bytes)
            .map_err(|error| ChainError::Config(format!("{name}: {error}")))?;
        entries.push(entry);
    }
    let manifest = with_header(
        "RMC007_EVIDENCE_MANIFEST",
        vec![
            ("status", Json::string("CONTENT_ADDRESSED")),
            ("artifacts", Json::Array(entries)),
        ],
    )
    .canonical()?;
    let put = inputs.store.put_artifact(&manifest)?;
    std::fs::write(out_dir.join("evidence-manifest.json"), &manifest)
        .map_err(|error| ChainError::Config(format!("evidence manifest: {error}")))?;
    Ok(Json::object([
        ("status", Json::string("RMC_007_CLOSEOUT_PASS")),
        ("pair_count", Json::uint(summary.union_count as u64)),
        (
            "unexplained_delta_count",
            Json::uint(summary.unexplained_delta_count as u64),
        ),
        (
            "provider_mismatch_count",
            required(agreement, "provider_mismatch_count")?.clone(),
        ),
        (
            "evidence_manifest_sha256",
            Json::string(nqc_census_chain::hex::plain(&sha2_digest(&manifest))),
        ),
        (
            "evidence_manifest_store_artifact_id",
            Json::string(put.id.to_hex()),
        ),
    ]))
}

fn sha2_digest(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes).into()
}

#[cfg(test)]
mod tests {
    use super::{
        rfc3339, store_evidence_entry, validate_closeout_pass_candidate, Occurrences,
        SequencedReplay, STORE_ENCODING_SEGMENTED,
    };
    use nqc_census_chain::{
        provider::{PinningMode, ProviderSpec},
        transport::Transport,
    };
    use sha2::{Digest, Sha256};
    use std::{collections::VecDeque, sync::Mutex};

    #[test]
    fn rfc3339_matches_independent_reference_values() {
        for (timestamp, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_782_906_587, "2026-07-01T11:49:47Z"),
        ] {
            assert_eq!(rfc3339(timestamp), expected);
        }
    }

    #[test]
    fn pass_closeout_writer_rejects_non_empty_or_incomplete_ledgers() {
        let summary = |count: usize| crate::ReconciliationSummary {
            source_a_count: count,
            source_b_count: count,
            source_c_count: count,
            union_count: count,
            intersection_count: count,
            enumeration_only_count: 0,
            event_only_count: 0,
            duplicate_observations: 0,
            historical_only_count: 0,
            explained_delta_count: 0,
            unexplained_delta_count: 0,
        };
        let clean = nqc_census_chain::json::Json::object([(
            "provider_mismatch_count",
            nqc_census_chain::json::Json::uint(0),
        )]);
        assert!(validate_closeout_pass_candidate(&summary(3), 0, 3, &clean, 3).is_ok());

        let mismatched = nqc_census_chain::json::Json::object([(
            "provider_mismatch_count",
            nqc_census_chain::json::Json::uint(1),
        )]);
        assert!(validate_closeout_pass_candidate(&summary(3), 0, 3, &mismatched, 3).is_err());

        let mut delta = summary(3);
        delta.unexplained_delta_count = 1;
        assert!(validate_closeout_pass_candidate(&delta, 1, 3, &clean, 3).is_err());

        let incomplete = summary(2);
        assert!(validate_closeout_pass_candidate(&incomplete, 0, 2, &clean, 3).is_err());
    }

    #[test]
    fn oversized_closeout_artifact_is_losslessly_segmented_in_the_store(
    ) -> Result<(), Box<dyn std::error::Error>> {
        use nqc_census_store::{CompressionPolicy, StoreConfig};

        let root = std::env::temp_dir().join(format!(
            "nqc-rmc007-segment-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        ));
        let config = StoreConfig::new(64, 4, 128, CompressionPolicy::RawOnly, 128)?;
        let store = Store::create(&root, config)?;
        let bytes = vec![b'x'; 300];
        let entry = store_evidence_entry(&store, "oversized.bin", &bytes)?;
        assert_eq!(
            entry.str_field("store_encoding")?,
            STORE_ENCODING_SEGMENTED
        );
        assert_eq!(entry.get("segment_count").and_then(Json::as_i64), Some(3));

        let mut reconstructed = Vec::new();
        for segment in entry
            .get("store_segments")
            .and_then(Json::as_array)
            .ok_or("missing store segments")?
        {
            let id = ArtifactId::parse_hex(segment.str_field("store_artifact_id")?)?;
            reconstructed.extend(store.get_artifact(&id)?);
        }
        assert_eq!(reconstructed, bytes);
        assert_eq!(
            entry.str_field("sha256")?,
            nqc_census_chain::hex::plain(&sha2_digest(&reconstructed))
        );

        std::fs::remove_dir_all(root)?;
        Ok(())
    }

    #[test]
    fn repeated_request_responses_are_replayed_in_recorded_byte_order(
    ) -> Result<(), nqc_census_chain::ChainError> {
        let provider = ProviderSpec::new(
            0x0777,
            "replay-provider",
            "replay://provider",
            "independent-operator",
            0,
            1,
            1,
            PinningMode::Eip1898,
        )?;
        let request = br#"{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}"#;
        let first = br#"{"jsonrpc":"2.0","id":1,"result":"0x1"}"#.to_vec();
        let second = b"{\"result\":\"0x1\",\"id\":1,\"jsonrpc\":\"2.0\"}\n".to_vec();

        let key = (provider.namespace(), Sha256::digest(request).into());
        let mut queues = Occurrences::new();
        queues.insert(key, VecDeque::from([first.clone(), second.clone()]));
        let replay = SequencedReplay {
            queues: Mutex::new(queues),
        };

        assert_eq!(replay.post(&provider, request)?.body, first);
        assert_eq!(replay.post(&provider, request)?.body, second);
        assert!(replay.post(&provider, request).is_err());
        Ok(())
    }
}
