//! Incremental refresh of the RMC-009 account universe.

use crate::base::BaseCensus;
use crate::canonical::{replay_canonicality, verify_canonicality};
use nqc_census_accounts::candidates::{derive_candidates, Candidates};
use nqc_census_accounts::closeout::Reconciled;
use nqc_census_accounts::plan::AccountPlan;
use nqc_census_accounts::replay::replay_account_stage;
use nqc_census_accounts::verify::{verify_accounts, VerifyInputs};
use nqc_census_chain::{json::Json, provider::ProviderSpec, ChainError};
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::Store;
use std::collections::BTreeSet;

/// The target plan indexing only `(base anchor, target anchor]`. Every base
/// token must still be in the target plan with the same initialization
/// block, and every target token the base lacks must have been initialized
/// after the base anchor (otherwise the base cannot vouch for its history).
pub fn delta_plan(target: &AccountPlan, base: &BaseCensus) -> Result<AccountPlan, ChainError> {
    if target.anchor.number < base.anchor_number {
        return Err(ChainError::Config(
            "the target anchor precedes the base anchor".into(),
        ));
    }
    let mut planned = BTreeSet::new();
    for reserve in &target.reserves {
        for token in [reserve.a_token, reserve.variable_debt_token] {
            planned.insert(token);
            match base.tokens.get(&token) {
                Some(block) if *block == reserve.initialized_block => {}
                Some(_) => {
                    return Err(ChainError::Evidence(format!(
                        "token {} has another initialization block in the base",
                        token.to_hex()
                    )))
                }
                None if reserve.initialized_block <= base.anchor_number => {
                    return Err(ChainError::Evidence(format!(
                        "token {} was initialized at or before the base anchor but the base does not index it",
                        token.to_hex()
                    )))
                }
                None => {}
            }
        }
    }
    if let Some(token) = base.tokens.keys().find(|token| !planned.contains(*token)) {
        return Err(ChainError::Evidence(format!(
            "base token {} is absent from the target plan",
            token.to_hex()
        )));
    }
    target.clone().with_index_start(base.anchor_number + 1)
}

/// Base candidates united with the delta candidates.
pub fn refreshed_candidates(base: &Candidates, delta: &Candidates) -> Candidates {
    let mut pairs = BTreeSet::new();
    for candidates in [base, delta] {
        for (account, tokens) in &candidates.accounts {
            for token in tokens {
                pairs.insert((*token, *account));
            }
        }
    }
    Candidates::from_pairs(&pairs)
}

pub struct Providers<'a> {
    pub canonicality: &'a [ProviderSpec],
    pub index: &'a [ProviderSpec],
    pub state: &'a [ProviderSpec],
}

/// Replays every record of an incremental refresh and verifies the universe
/// at the target anchor. Returns the reconciled universe and the provenance
/// `mode` for the closeout.
pub fn reconcile_incremental(
    store: &Store,
    providers: &Providers<'_>,
    target: &AccountPlan,
    base: &BaseCensus,
    candidates: &Candidates,
    records: &[Json],
) -> Result<(Reconciled, Json), ChainError> {
    let delta = delta_plan(target, base)?;
    let (mut canonical, mut index, mut tokens, mut state) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for record in records {
        match record.str_field("stage")? {
            "BASE_CANONICALITY" => canonical.push(replay_canonicality(
                store,
                providers.canonicality,
                &target.anchor,
                base,
                record,
            )?),
            "ACCOUNT_INDEX" => index.push(replay_account_stage(
                store,
                providers.index,
                &delta,
                None,
                record,
            )?),
            "ACCOUNT_TOKENS" => tokens.push(replay_account_stage(
                store,
                providers.state,
                target,
                None,
                record,
            )?),
            "ACCOUNT_STATE" => state.push(replay_account_stage(
                store,
                providers.state,
                target,
                Some(candidates),
                record,
            )?),
            other => return Err(ChainError::Evidence(format!("unexpected stage {other}"))),
        }
    }
    reconcile_incremental_replayed(
        target,
        base,
        candidates,
        canonical,
        index,
        tokens,
        state,
        records.len(),
    )
}

/// Reconciles stages that have already been replayed and independently bound
/// to the target plan. This is the live-CI path when each stage store is
/// verified in isolation and only compact replay extracts meet on the
/// reconciler runner.
#[allow(clippy::too_many_arguments)]
pub fn reconcile_incremental_replayed(
    target: &AccountPlan,
    base: &BaseCensus,
    candidates: &Candidates,
    canonical: Vec<ReplayedStage>,
    index: Vec<ReplayedStage>,
    tokens: Vec<ReplayedStage>,
    state: Vec<ReplayedStage>,
    records: usize,
) -> Result<(Reconciled, Json), ChainError> {
    let delta = delta_plan(target, base)?;
    let canonicality = verify_canonicality(&canonical, base)?;
    let (delta_candidates, facts) = derive_candidates(&index, &delta)?;
    let refreshed = refreshed_candidates(&base.candidates, &delta_candidates);
    if refreshed != *candidates {
        return Err(ChainError::Evidence(
            "candidates differ from the certified base united with the replayed delta".into(),
        ));
    }
    let outcome = verify_accounts(VerifyInputs {
        plan: target,
        candidates,
        index: &facts,
        tokens,
        state,
    })?;
    let mode = Json::object([
        ("mode", Json::string("INCREMENTAL_REFRESH")),
        (
            "base",
            Json::object([
                ("anchor_number", Json::uint(base.anchor_number)),
                ("anchor_hash", Json::string(base.anchor_hash.to_hex())),
                ("candidates_sha256", Json::string(base.candidates.digest())),
                (
                    "accounts",
                    Json::uint(base.candidates.accounts.len() as u64),
                ),
            ]),
        ),
        ("base_canonicality", canonicality),
        ("index_start", Json::uint(delta.index_start)),
        ("delta_index", facts.json()),
        (
            "delta_accounts",
            Json::uint(delta_candidates.accounts.len() as u64),
        ),
    ]);
    Ok((
        Reconciled {
            candidates: refreshed,
            index: facts,
            outcome,
            records,
        },
        mode,
    ))
