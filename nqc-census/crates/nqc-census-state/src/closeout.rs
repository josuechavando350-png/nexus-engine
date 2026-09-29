//! RMC-008 offline reconciliation and deterministic closeout.
//!
//! Replays every stage record from the merged RMC-004 store, verifies the
//! Aave and V2 adapters, and writes content-addressed artifacts. Artifacts are
//! dated by the observation anchor's block timestamp, never the wall clock,
//! so a rerun on the same evidence is byte-identical.

use crate::aave_verify::{verify_aave, AaveInputs, AaveOutcome};
use crate::extract::extract_stages;
use crate::inputs::{D06Inputs, D07Inputs, PinnedFile};
use crate::model::{MismatchLedger, StateAdmission, TokenAdmission};
use crate::replay::{replay_stage, StagePlans};
use crate::stage::{observation_anchor, sha256_plain, AnchorPlan};
use crate::v2_verify::{verify_v2, ReplayedStage, V2Inputs, V2Outcome};
use nqc_census_chain::{json::Json, provider::ProviderSpec, ChainError};
use nqc_census_core::{CensusStage, EvidenceRef, RejectionRecord, StageDomain, StageLedger};
use nqc_census_store::Store;
use std::collections::BTreeMap;
use std::path::Path;

pub const SCHEMA_VERSION: u64 = 1;
pub const SCOPE: &str =
    "ETHEREUM_MAINNET_AAVE_V3_CORE_POOL_AND_UNISWAP_V2_FACTORY_ADMITTED_BY_D06_D07";

/// Canonical Uniswap V2 pair init-code hash: only the search key for the
/// init code embedded in the admitted factory runtime.
pub const UNISWAP_V2_INIT_CODE_HASH: &str =
    "96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

pub fn rfc3339(timestamp: u64) -> String {
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

/// Basis of every field the D08 manifests carry. Nothing is guessed: a value
/// is read from a protocol getter, storage slot or oracle, derived exactly
/// from such reads, or a declared constant; what is not supported says so.
pub const FIELD_BASIS: &[(&str, &str, &str)] = &[
    ("aave", "configuration.raw", "AUTHORITATIVE_GETTER"),
    ("aave", "configuration.<fields>", "DERIVED_EXACT"),
    ("aave", "reserve_id", "AUTHORITATIVE_GETTER"),
    ("aave", "indexes.liquidity_index", "AUTHORITATIVE_GETTER"),
    (
        "aave",
        "indexes.variable_borrow_index",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "indexes.current_liquidity_rate",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "indexes.current_variable_borrow_rate",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "indexes.last_update_timestamp",
        "AUTHORITATIVE_GETTER",
    ),
    ("aave", "indexes.normalized_income", "AUTHORITATIVE_GETTER"),
    (
        "aave",
        "indexes.normalized_income.recomputation",
        "DERIVED_EXACT",
    ),
    (
        "aave",
        "indexes.normalized_variable_debt",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "indexes.normalized_variable_debt.recomputation",
        "UNSUPPORTED",
    ),
    (
        "aave",
        "liquidity.a_token_scaled_total_supply",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.a_token_total_supply",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.a_token_total_supply.recomputation",
        "DERIVED_EXACT",
    ),
    (
        "aave",
        "liquidity.variable_debt_scaled_total_supply",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.variable_debt_total_supply",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.variable_debt_total_supply.recomputation",
        "DERIVED_EXACT",
    ),
    (
        "aave",
        "liquidity.stable_debt_total_supply",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.underlying_balance_of_a_token",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.virtual_underlying_balance",
        "AUTHORITATIVE_GETTER",
    ),
    (
        "aave",
        "liquidity.accrued_to_treasury_scaled",
        "AUTHORITATIVE_GETTER",
    ),
    ("aave", "liquidity.unbacked", "AUTHORITATIVE_GETTER"),
    (
        "aave",
        "liquidity.isolation_mode_total_debt",
        "AUTHORITATIVE_GETTER",
    ),
    ("aave", "liquidity.deficit", "AUTHORITATIVE_GETTER"),
    (
        "aave",
        "liquidation_grace_period_until",
        "AUTHORITATIVE_GETTER",
    ),
    ("aave", "tokens.<addresses>", "AUTHORITATIVE_GETTER"),
    ("aave", "protocol_facts.<flags>", "DERIVED_EXACT"),
    (
        "aave",
        "protocol_facts.available_liquidity",
        "DERIVED_EXACT",
    ),
    ("aave", "protocol_facts.<cap_reached>", "DERIVED_EXACT"),
    ("aave", "emode.<category>", "AUTHORITATIVE_GETTER"),
    (
        "aave",
        "proxy.<eip1967|beacon|zeppelinos>",
        "AUTHORITATIVE_STORAGE",
    ),
    ("aave", "runtime.code_sha256", "DERIVED_EXACT"),
    ("aave", "oracle.price", "AUTHORITATIVE_ORACLE"),
    ("aave", "oracle.latest_answer", "AUTHORITATIVE_ORACLE"),
    ("aave", "oracle.base_currency_unit", "AUTHORITATIVE_ORACLE"),
    ("aave", "oracle.price_path", "DERIVED_EXACT"),
    ("aave", "oracle.round_updated_at", "AUTHORITATIVE_ORACLE"),
    ("aave", "oracle.age_seconds_at_anchor", "DERIVED_EXACT"),
    ("aave", "oracle.freshness_policy", "UNSUPPORTED"),
    ("v2", "reserves", "AUTHORITATIVE_GETTER"),
    ("v2", "total_supply", "AUTHORITATIVE_GETTER"),
    ("v2", "k_last", "AUTHORITATIVE_GETTER"),
    ("v2", "factory_membership", "AUTHORITATIVE_GETTER"),
    ("v2", "balance0|balance1", "AUTHORITATIVE_GETTER"),
    ("v2", "balance_minus_reserve", "DERIVED_EXACT"),
    ("v2", "runtime.create2_derivation", "DERIVED_EXACT"),
    ("v2", "runtime.pair_runtime_sha256", "DERIVED_EXACT"),
    ("v2", "fee_semantics.swap_fee_bps", "DECLARED_CONSTANT"),
    (
        "v2",
        "fee_semantics.protocol_fee_enabled",
        "AUTHORITATIVE_GETTER",
    ),
    ("v2", "liquidity_state", "DERIVED_EXACT"),
    ("token", "decimals", "AUTHORITATIVE_GETTER"),
    ("token", "runtime.v2_code_identity", "UNSUPPORTED"),
    ("token", "behavior.fee_on_transfer", "UNSUPPORTED"),
    ("token", "behavior.transfer_hooks", "UNSUPPORTED"),
    ("token", "behavior.rebasing_present", "DERIVED_EXACT"),
    (
        "token",
        "behavior.upgradeable_present",
        "AUTHORITATIVE_STORAGE",
    ),
    ("token", "state_admission.rejected", "REJECTED"),
];

pub fn field_basis() -> Json {
    Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        (
            "fields",
            Json::array(FIELD_BASIS.iter().map(|(domain, field, basis)| {
                Json::object([
                    ("domain", Json::string(*domain)),
                    ("field", Json::string(*field)),
                    ("basis", Json::string(*basis)),
                ])
            })),
        ),
    ])
}

pub fn init_code_hash() -> Result<[u8; 32], ChainError> {
    nqc_census_chain::hex::decode_fixed::<32>(&format!("0x{UNISWAP_V2_INIT_CODE_HASH}"))
}

pub struct Verified {
    pub aave: AaveOutcome,
    pub v2: V2Outcome,
    pub records: usize,
    pub anchor_timestamp: u64,
    /// The one canonical anchor every replayed stage was pinned to.
    pub observation_anchor: Json,
}

/// Replays every record from one store holding all their evidence, then
/// verifies (`reconcile_replayed`).
pub fn reconcile_offline(
    store: &Store,
    providers: &[ProviderSpec],
    anchor: &AnchorPlan,
    d06: &D06Inputs,
    d07: &D07Inputs,
    v2_job_size: usize,
    records: &[Json],
) -> Result<Verified, ChainError> {
    let aave_plan = d06.plan(anchor.clone());
    let v2_plan = d07.plan(anchor.clone(), v2_job_size);
    let plans = StagePlans {
        v2: Some(&v2_plan),
        pairs: &d07.pairs,
        aave: Some(&aave_plan),
    };
    let mut stages = Vec::with_capacity(records.len());
    for record in records {
        stages.push((
            record.str_field("stage")?.to_owned(),
            replay_stage(store, providers, &plans, record)?,
        ));
    }
    reconcile_replayed(anchor, d06, d07, stages)
}

/// As `reconcile_offline`, from stages replayed one store at a time
/// (`extract::stage_extract`). Returns the extracts' records too.
pub fn reconcile_extracts(
    providers: &[ProviderSpec],
    anchor: &AnchorPlan,
    d06: &D06Inputs,
    d07: &D07Inputs,
    v2_job_size: usize,
    extracts: Vec<Json>,
) -> Result<(Verified, Vec<Json>), ChainError> {
    let aave_plan = d06.plan(anchor.clone());
    let v2_plan = d07.plan(anchor.clone(), v2_job_size);
    let plans = StagePlans {
        v2: Some(&v2_plan),
        pairs: &d07.pairs,
        aave: Some(&aave_plan),
    };
    let mut stages = Vec::with_capacity(extracts.len());
    let mut records = Vec::with_capacity(extracts.len());
    for (record, stage) in extract_stages(providers, &plans, anchor, extracts)? {
        stages.push((record.str_field("stage")?.to_owned(), stage));
        records.push(record);
    }
    Ok((reconcile_replayed(anchor, d06, d07, stages)?, records))
}

fn reconcile_replayed(
    anchor: &AnchorPlan,
    d06: &D06Inputs,
    d07: &D07Inputs,
    stages: Vec<(String, ReplayedStage)>,
) -> Result<Verified, ChainError> {
    let records = stages.len();
    let mut by_stage: BTreeMap<String, Vec<ReplayedStage>> = BTreeMap::new();
    for (name, stage) in stages {
        by_stage.entry(name).or_default().push(stage);
    }
    let take = |stage: &str, by_stage: &mut BTreeMap<String, Vec<ReplayedStage>>| {
        by_stage.remove(stage).unwrap_or_default()
    };
    let aave_stages = take("AAVE_STATE", &mut by_stage);
    let factory = take("V2_FACTORY", &mut by_stage);
    let state = take("V2_STATE", &mut by_stage);
    if let Some(stage) = by_stage.keys().next() {
        return Err(ChainError::Evidence(format!("unexpected stage {stage}")));
    }
    // Every stage is pinned to the same verified anchor; its timestamp comes
    // from the replayed header, never from configuration.
    let anchor_timestamp = anchor_timestamp(&aave_stages)?;
    let parameters: Vec<&Json> = aave_stages
        .iter()
        .chain(&factory)
        .chain(&state)
        .map(|stage| &stage.parameters)
        .collect();
    let observation_anchor = observation_anchor(&parameters, anchor)?;
    let aave = verify_aave(&AaveInputs {
        deployment: d06.deployment.clone(),
        pool: d06.deployment.address(),
        reserves: &d06.reserves,
        anchor_timestamp,
        stages: aave_stages,
    })?;
    let v2 = verify_v2(&V2Inputs {
        deployment: d07.deployment.clone(),
        admitted_factory_sha256: d07.factory_runtime_sha256.clone(),
        declared_init_code_hash: init_code_hash()?,
        pairs: &d07.pairs,
        factory,
        state,
    })?;
    Ok(Verified {
        aave,
        v2,
        records,
        anchor_timestamp,
        observation_anchor,
    })
}

/// The anchor timestamp every replayed Aave stage was pinned to (from its
/// verified header, reproduced on replay).
fn anchor_timestamp(stages: &[ReplayedStage]) -> Result<u64, ChainError> {
    let mut timestamps = Vec::new();
    for stage in stages {
        timestamps.push(
            stage
                .parameters
                .get("anchor_block")
                .and_then(|anchor| anchor.get("timestamp"))
                .and_then(Json::as_i64)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| ChainError::Evidence("stage anchor timestamp missing".into()))?,
        );
    }
    timestamps.dedup();
    match timestamps.as_slice() {
        [timestamp] => Ok(*timestamp),
        [] => Err(ChainError::Evidence(
            "no Aave stage to date the anchor".into(),
        )),
        _ => Err(ChainError::Consensus(
            "providers disagree on the anchor timestamp",
        )),
    }
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

fn rejection_json(record: &RejectionRecord, protocol: &str) -> Json {
    Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("rejection_id", Json::string(record.id().to_hex())),
        ("protocol", Json::string(protocol)),
        ("unit_id", Json::string(record.unit_id().to_hex())),
        ("stage", Json::string(record.stage().code())),
        ("reason", Json::string(record.reason().code())),
        (
            "blocker",
            record
                .blocker()
                .map_or(Json::Null, |blocker| Json::string(blocker.as_str())),
        ),
        (
            "evidence_refs",
            Json::array(record.evidence_refs().iter().map(evidence_json)),
        ),
    ])
}

fn metrics_json(ledger: &StageLedger, domain: &StageDomain, stages: &[CensusStage]) -> Json {
    Json::array(stages.iter().map(|stage| {
        let metrics = ledger.metrics(domain, *stage);
        Json::object([
            ("stage", Json::string(stage.code())),
            ("input", Json::uint(metrics.input_count as u64)),
            ("advanced", Json::uint(metrics.advanced_count as u64)),
            ("rejected", Json::uint(metrics.rejected_count as u64)),
            ("unknown", Json::uint(metrics.unknown_count as u64)),
            ("proven", Json::uint(metrics.proven_count as u64)),
            ("conserved", Json::Bool(metrics.is_conserved())),
        ])
    }))
}

fn token_counts(tokens: &[TokenAdmission]) -> Json {
    let admitted = tokens
        .iter()
        .filter(|token| token.state == StateAdmission::Admitted)
        .count();
    let compatible = tokens
        .iter()
        .filter(|token| token.execution_blockers().is_empty())
        .count();
    Json::object([
        ("tokens", Json::uint(tokens.len() as u64)),
        ("state_admitted", Json::uint(admitted as u64)),
        (
            "state_rejected",
            Json::uint((tokens.len() - admitted) as u64),
        ),
        ("execution_proven_compatible", Json::uint(compatible as u64)),
        (
            "execution_blocked",
            Json::uint((tokens.len() - compatible) as u64),
        ),
    ])
}

pub struct CloseoutContext<'a> {
    pub code_commit: &'a str,
    pub code_tree: &'a str,
    pub pins: &'a [PinnedFile],
    pub store_evidence_root: &'a str,
    /// RMC-004 summary of each stage's own store, when stages were replayed
    /// one store at a time (then `store_evidence_root` says so); else empty.
    pub stage_stores: Vec<Json>,
    pub record_manifests: Vec<String>,
}

/// Writes the RMC-008 closeout and returns its summary. Fails when any
/// mismatch is unexplained, any decision is UNKNOWN, or metrics are not
/// conserved.
pub fn write_closeout(
    out_dir: &Path,
    context: &CloseoutContext<'_>,
    verified: &Verified,
) -> Result<Json, Box<dyn std::error::Error>> {
    for value in [context.code_commit, context.code_tree] {
        if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ChainError::Config("commit/tree must be 40 hex characters".into()).into());
        }
    }
    std::fs::create_dir_all(out_dir)?;
    let generated_at = rfc3339(verified.anchor_timestamp);
    let mut mismatches = MismatchLedger::default();
    mismatches.extend(verified.aave.mismatches.clone());
    mismatches.extend(verified.v2.mismatches.clone());
    let rejections: Vec<Json> = verified
        .aave
        .ledger
        .rejection_records()
        .iter()
        .map(|record| rejection_json(record, "AAVE_V3"))
        .chain(
            verified
                .v2
                .ledger
                .rejection_records()
                .iter()
                .map(|record| rejection_json(record, "UNISWAP_V2")),
        )
        .collect();
    let unknown_rejections = rejections
        .iter()
        .filter(|row| row.get("reason").and_then(Json::as_str) == Some("UNKNOWN"))
        .count();
    // D08 decides state reconstructability only; economic, borrowability and
    // actionability classifications belong to later stages.
    let aave_stages = [CensusStage::MarketsStateReconstructable];
    let v2_stages = [CensusStage::MarketsStateReconstructable];
    let aave_metrics = metrics_json(&verified.aave.ledger, &verified.aave.domain, &aave_stages);
    let v2_metrics = metrics_json(&verified.v2.ledger, &verified.v2.domain, &v2_stages);
    let conserved = [&aave_metrics, &v2_metrics].iter().all(|metrics| {
        metrics.as_array().is_some_and(|rows| {
            rows.iter()
                .all(|row| row.get("conserved").and_then(Json::as_bool) == Some(true))
        })
    });
    let aave_reconstructable = verified.aave.ledger.metrics(
        &verified.aave.domain,
        CensusStage::MarketsStateReconstructable,
    );
    let v2_reconstructable = verified.v2.ledger.metrics(
        &verified.v2.domain,
        CensusStage::MarketsStateReconstructable,
    );
    let every_market_decided = aave_reconstructable.input_count == verified.aave.state_rows.len()
        && v2_reconstructable.input_count == verified.v2.state_rows.len();
    let mut tokens: Vec<&TokenAdmission> = verified
        .aave
        .tokens
        .iter()
        .chain(verified.v2.tokens.iter())
        .collect();
    tokens.sort_by_key(|token| token.token);
    let token_rows: Vec<Json> = tokens.iter().map(|token| token.json()).collect();
    let all_tokens: Vec<TokenAdmission> = tokens.iter().map(|token| (*token).clone()).collect();

    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let state_rows = verified
        .aave
        .state_rows
        .iter()
        .chain(verified.v2.state_rows.iter())
        .cloned();
    files.push(("market-state-manifest.jsonl".into(), jsonl(state_rows)?));
    files.push((
        "oracle-manifest.jsonl".into(),
        jsonl(verified.aave.oracle_rows.iter().cloned())?,
    ));
    files.push((
        "emode-manifest.jsonl".into(),
        jsonl(verified.aave.emode_rows.iter().cloned())?,
    ));
    files.push(("token-admission.jsonl".into(), jsonl(token_rows)?));
    files.push((
        "mismatch-ledger.jsonl".into(),
        jsonl(mismatches.sorted().iter().map(|entry| entry.json()))?,
    ));
    files.push(("rejection-ledger.jsonl".into(), jsonl(rejections.clone())?));
    let metrics = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("aave_v3", aave_metrics.clone()),
        ("uniswap_v2", v2_metrics.clone()),
    ]);
    files.push(("stage-metrics.json".into(), metrics.canonical()?));
    files.push((
        "pool-and-factory-facts.json".into(),
        Json::object([
            ("aave_pool", verified.aave.pool_facts.clone()),
            ("uniswap_v2_factory", verified.v2.factory_facts.clone()),
        ])
        .canonical()?,
    ));
    files.push(("field-basis.json".into(), field_basis().canonical()?));

    let pass = mismatches.unexplained() == 0
        && unknown_rejections == 0
        && conserved
        && every_market_decided;
    let summary = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        (
            "status",
            Json::string(if pass {
                "RMC_008_PASS_CANDIDATE"
            } else {
                "RMC_008_BLOCKED"
            }),
        ),
        ("generated_at", Json::string(generated_at.clone())),
        (
            "generated_at_basis",
            Json::string("OBSERVATION_ANCHOR_BLOCK_TIMESTAMP"),
        ),
        ("scope", Json::string(SCOPE)),
        ("code_commit", Json::string(context.code_commit)),
        ("code_tree", Json::string(context.code_tree)),
        ("anchor_timestamp", Json::uint(verified.anchor_timestamp)),
        ("observation_anchor", verified.observation_anchor.clone()),
        ("stage_records", Json::uint(verified.records as u64)),
        (
            "aave_markets",
            Json::uint(verified.aave.state_rows.len() as u64),
        ),
        (
            "aave_oracle_rows",
            Json::uint(verified.aave.oracle_rows.len() as u64),
        ),
        (
            "aave_emode_categories",
            Json::uint(verified.aave.emode_rows.len() as u64),
        ),
        (
            "v2_markets",
            Json::uint(verified.v2.state_rows.len() as u64),
        ),
        ("token_admission", token_counts(&all_tokens)),
        ("mismatches", Json::uint(mismatches.len() as u64)),
        (
            "unexplained_mismatches",
            Json::uint(mismatches.unexplained() as u64),
        ),
        ("rejections", Json::uint(rejections.len() as u64)),
        ("unknown_rejections", Json::uint(unknown_rejections as u64)),
        ("metrics_conserved", Json::Bool(conserved)),
        ("every_market_decided", Json::Bool(every_market_decided)),
        ("stage_metrics", metrics),
        (
            "non_claims",
            Json::array(
                [
                    "TOKEN_TRANSFER_SEMANTICS_NOT_PROVEN",
                    "ORACLE_FRESHNESS_NOT_ASSUMED",
                    "LIQUIDITY_DEPTH_NOT_CLAIMED_BEYOND_EXACT_STATE",
                    "PROFITABILITY_NOT_CLAIMED",
                    "EXECUTION_NOT_CLAIMED",
                ]
                .into_iter()
                .map(Json::string),
            ),
        ),
    ]);
    files.push(("state-summary.json".into(), summary.canonical()?));

    let mut entries = Vec::new();
    for (name, bytes) in &files {
        std::fs::write(out_dir.join(name), bytes)?;
        entries.push(Json::object([
            ("path", Json::string(name.clone())),
            ("sha256", Json::string(sha256_plain(bytes))),
            ("bytes", Json::uint(bytes.len() as u64)),
        ]));
    }
    let evidence = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("generated_at", Json::string(generated_at)),
        ("code_commit", Json::string(context.code_commit)),
        ("code_tree", Json::string(context.code_tree)),
        ("observation_anchor", verified.observation_anchor.clone()),
        (
            "store_evidence_root",
            Json::string(context.store_evidence_root),
        ),
        ("stage_stores", Json::Array(context.stage_stores.clone())),
        (
            "inputs",
            Json::array(context.pins.iter().map(|pin| {
                Json::object([
                    ("role", Json::string(pin.role.clone())),
                    ("sha256", Json::string(pin.sha256.clone())),
                ])
            })),
        ),
        (
            "stage_manifests",
            Json::array(
                context
                    .record_manifests
                    .iter()
                    .map(|id| Json::string(id.clone())),
            ),
        ),
        ("artifacts", Json::Array(entries)),
    ]);
    std::fs::write(
        out_dir.join("evidence-manifest.json"),
        evidence.canonical()?,
    )?;
    if !pass {
        return Err(ChainError::Evidence(format!(
            "RMC-008 blocked: {} unexplained mismatches, {} UNKNOWN rejections, conserved={conserved}, decided={every_market_decided}",
            mismatches.unexplained(),
            unknown_rejections
        ))
        .into());
    }
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc3339_matches_independent_reference_values() {
        for (timestamp, expected) in [
            (0, "1970-01-01T00:00:00Z"),
            (951_782_400, "2000-02-29T00:00:00Z"),
            (1_782_906_587, "2026-07-01T11:49:47Z"),
            (4_102_444_799, "2099-12-31T23:59:59Z"),
        ] {
            assert_eq!(rfc3339(timestamp), expected);
        }
    }

    #[test]
    fn declared_init_code_hash_parses() -> Result<(), ChainError> {
        assert_eq!(init_code_hash()?[0], 0x96);
        Ok(())
    }
}
