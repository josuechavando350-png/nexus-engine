//! RMC-009 offline reconciliation and deterministic closeout.

use crate::candidates::{derive_candidates, Candidates, IndexFacts};
use crate::extract::extract_stages;
use crate::plan::AccountPlan;
use crate::replay::replay_account_stage;
use crate::verify::{verify_accounts, AccountOutcome, VerifyInputs};
use nqc_census_chain::{json::Json, provider::ProviderSpec, ChainError};
use nqc_census_state::closeout::rfc3339;
use nqc_census_state::inputs::PinnedFile;
use nqc_census_state::stage::sha256_plain;
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::Store;
use std::collections::BTreeMap;
use std::path::Path;

pub const SCHEMA_VERSION: u64 = 1;
pub const SCOPE: &str = "ETHEREUM_MAINNET_AAVE_V3_CORE_POOL_ACCOUNTS_ADMITTED_BY_D06";

pub struct Reconciled {
    pub candidates: Candidates,
    pub index: IndexFacts,
    pub outcome: AccountOutcome,
    pub records: usize,
}

/// Replays every record, re-derives the candidates from the replayed index
/// (which must equal the candidates the state stages were run for) and
/// verifies the universe.
pub fn reconcile_offline(
    store: &Store,
    index_providers: &[ProviderSpec],
    state_providers: &[ProviderSpec],
    plan: &AccountPlan,
    candidates: &Candidates,
    records: &[Json],
) -> Result<Reconciled, ChainError> {
    let mut by_stage: BTreeMap<String, Vec<&Json>> = BTreeMap::new();
    for record in records {
        by_stage
            .entry(record.str_field("stage")?.to_owned())
            .or_default()
            .push(record);
    }
    let mut take = |stage: &str| by_stage.remove(stage).unwrap_or_default();
    let index_records = take("ACCOUNT_INDEX");
    let token_records = take("ACCOUNT_TOKENS");
    let state_records = take("ACCOUNT_STATE");
    if let Some(stage) = by_stage.keys().next() {
        return Err(ChainError::Evidence(format!("unexpected stage {stage}")));
    }
    let replay = |providers: &[ProviderSpec], records: &[&Json], with: Option<&Candidates>| {
        records
            .iter()
            .map(|record| replay_account_stage(store, providers, plan, with, record))
            .collect::<Result<Vec<ReplayedStage>, ChainError>>()
    };
    let index = replay(index_providers, &index_records, None)?;
    let tokens = replay(state_providers, &token_records, None)?;
    let state = replay(state_providers, &state_records, Some(candidates))?;
    reconcile_replayed(plan, candidates, index, tokens, state, records.len())
}

/// As `reconcile_offline`, from stages replayed one store at a time
/// (`extract::stage_extract`). Returns the extracts' records too.
pub fn reconcile_extracts(
    index_providers: &[ProviderSpec],
    state_providers: &[ProviderSpec],
    plan: &AccountPlan,
    candidates: &Candidates,
    extracts: Vec<Json>,
) -> Result<(Reconciled, Vec<Json>), ChainError> {
    let (mut index, mut tokens, mut state, mut records) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (record, stage) in extract_stages(index_providers, state_providers, plan, extracts)? {
        match record.str_field("stage")? {
            "ACCOUNT_INDEX" => index.push(stage),
            "ACCOUNT_TOKENS" => tokens.push(stage),
            "ACCOUNT_STATE" => state.push(stage),
            other => return Err(ChainError::Evidence(format!("unexpected stage {other}"))),
        }
        records.push(record);
    }
    let count = records.len();
    Ok((
        reconcile_replayed(plan, candidates, index, tokens, state, count)?,
        records,
    ))
}

fn reconcile_replayed(
    plan: &AccountPlan,
    candidates: &Candidates,
    index: Vec<ReplayedStage>,
    tokens: Vec<ReplayedStage>,
    state: Vec<ReplayedStage>,
    records: usize,
) -> Result<Reconciled, ChainError> {
    let (derived, facts) = derive_candidates(&index, plan)?;
    if derived != *candidates {
        return Err(ChainError::Evidence(
            "candidates differ from the replayed index".into(),
        ));
    }
    let outcome = verify_accounts(VerifyInputs {
        plan,
        candidates,
        index: &facts,
        tokens,
        state,
    })?;
    Ok(Reconciled {
        candidates: derived,
        index: facts,
        outcome,
        records,
    })
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
    /// How this census was acquired (`FULL_CENSUS` or an incremental
    /// refresh and its base). Kept out of the census artifacts, which must be
    /// byte-identical whichever way the same anchor was reached.
    pub mode: Json,
}

/// `mode` of a full census from `index`.
pub fn full_census_mode(index: &IndexFacts) -> Json {
    Json::object([
        ("mode", Json::string("FULL_CENSUS")),
        ("index", index.json()),
    ])
}

fn jsonl(rows: impl IntoIterator<Item = Json>) -> Result<Vec<u8>, ChainError> {
    let mut out = Vec::new();
    for row in rows {
        out.extend(row.canonical()?);
        out.push(b'\n');
    }
    Ok(out)
}

/// Writes the closeout and returns its summary; fails (after writing, so the
/// evidence is kept) unless every token is conserved and nothing is
/// unexplained or blocking.
pub fn write_closeout(
    out_dir: &Path,
    context: &CloseoutContext<'_>,
    reconciled: &Reconciled,
) -> Result<Json, Box<dyn std::error::Error>> {
    for value in [context.code_commit, context.code_tree] {
        if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(ChainError::Config("commit/tree must be 40 hex characters".into()).into());
        }
    }
    std::fs::create_dir_all(out_dir)?;
    let outcome = &reconciled.outcome;
    let generated_at = rfc3339(outcome.anchor_timestamp);
    let pass =
        outcome.conserved && outcome.mismatches.unexplained() == 0 && outcome.findings.is_empty();
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (
            "account-manifest.jsonl".into(),
            jsonl(outcome.accounts.iter().cloned())?,
        ),
        (
            "token-conservation.jsonl".into(),
            jsonl(outcome.conservation.iter().cloned())?,
        ),
        (
            "reserve-tokens.jsonl".into(),
            jsonl(outcome.reserves.iter().cloned())?,
        ),
        (
            "configuration-divergences.jsonl".into(),
            jsonl(outcome.divergences.iter().cloned())?,
        ),
        (
            "mismatch-ledger.jsonl".into(),
            jsonl(outcome.mismatches.sorted().iter().map(|entry| entry.json()))?,
        ),
        (
            "candidate-accounts.jsonl".into(),
            reconciled.candidates.to_jsonl()?,
        ),
        ("account-metrics.json".into(), outcome.metrics.canonical()?),
    ];
    let summary = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        (
            "status",
            Json::string(if pass {
                "RMC_009_PASS_CANDIDATE"
            } else {
                "RMC_009_BLOCKED"
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
        (
            "anchor",
            Json::object([
                ("number", Json::uint(outcome.anchor_number)),
                ("hash", Json::string(outcome.anchor_hash.clone())),
            ]),
        ),
        ("anchor_timestamp", Json::uint(outcome.anchor_timestamp)),
        (
            "candidates_sha256",
            Json::string(reconciled.candidates.digest()),
        ),
        ("all_tokens_conserved", Json::Bool(outcome.conserved)),
        ("mismatches", Json::uint(outcome.mismatches.len() as u64)),
        (
            "unexplained_mismatches",
            Json::uint(outcome.mismatches.unexplained() as u64),
        ),
        (
            "blocking_findings",
            Json::array(outcome.findings.iter().map(|f| Json::string(f.clone()))),
        ),
        ("metrics", outcome.metrics.clone()),
        (
            "completeness_basis",
            Json::string(
                "PER_TOKEN_SCALED_SUPPLY_CONSERVATION: sum of indexed scaledBalanceOf equals scaledTotalSupply at the anchor for every aToken and variable debt token",
            ),
        ),
        (
            "uniswap_v2",
            Json::object([
                ("status", Json::string("NOT_APPLICABLE")),
                (
                    "reason",
                    Json::string(
                        "Uniswap V2 pairs carry no borrower, debt or collateral positions; no account universe is claimed or fabricated for them",
                    ),
                ),
            ]),
        ),
        (
            "non_claims",
            Json::array(
                [
                    "LIQUIDATABILITY_NOT_CLAIMED",
                    "PROFITABILITY_NOT_CLAIMED",
                    "EXECUTION_NOT_CLAIMED",
                    "ORACLE_FRESHNESS_NOT_ASSUMED",
                    "POSITIONS_OUTSIDE_D06_NOT_CLAIMED",
                ]
                .into_iter()
                .map(Json::string),
            ),
        ),
    ]);
    files.push(("account-summary.json".into(), summary.canonical()?));
    // Provenance: how the anchor was reached. Not a census artifact.
    let provenance = Json::object([
        ("schema_version", Json::uint(SCHEMA_VERSION)),
        ("acquisition", context.mode.clone()),
        ("stage_records", Json::uint(reconciled.records as u64)),
    ]);
    files.push((
        "acquisition-provenance.json".into(),
        provenance.canonical()?,
    ));
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
        (
            "store_evidence_root",
            Json::string(context.store_evidence_root),
        ),
        (
            "inputs",
            Json::array(context.pins.iter().map(|pin| {
                Json::object([
                    ("role", Json::string(pin.role.clone())),
                    ("sha256", Json::string(pin.sha256.clone())),
                ])
            })),
        ),
        ("stage_stores", Json::Array(context.stage_stores.clone())),
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
            "RMC-009 blocked: conserved={}, {} unexplained mismatches, findings={:?}",
            outcome.conserved,
            outcome.mismatches.unexplained(),
            outcome.findings
        ))
        .into());
    }
    Ok(summary)
}
