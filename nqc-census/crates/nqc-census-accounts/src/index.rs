//! `ACCOUNT_INDEX`: candidate (token, account) pairs from the token logs.
//!
//! One provider, one contiguous range of the global job grid. Each job asks
//! for every `Mint` and `BalanceTransfer` log of every admitted token over
//! its block range and keeps the receiving account of each. The logs are
//! recorded RMC-004 exchanges, so replay retraces the same requests, and a
//! digest over every log lets the reconciler require two providers to have
//! returned identical logs. The logs are hints: they are not bound to
//! headers because nothing is concluded from them; completeness is proven
//! later by conservation at the anchor.
//!
//! A provider may refuse a range because it would return more logs than the
//! provider's result cap (MEV Blocker: 10,000, Tenderly: 20,000). That is a
//! property of the range's log density, not an outage, and retrying the same
//! request can never succeed. An index job therefore runs over a fixed,
//! declared ladder of log windows: the provider's declared window, then its
//! successive halvings. Each rung is its own RMC-004 stream, because the
//! provider descriptor (window included) is part of the job's stream kind.
//! Only a rung whose every sub-range was answered commits. A refused rung
//! commits nothing, and a refusal at the last rung fails the job closed:
//! never empty, never partial. Rows carry only economic content (range, log
//! counts, log digest, pairs), so providers that answered on different rungs
//! still reconcile exactly.

use crate::plan::{balance_transfer_topic, mint_topic, AccountPlan, TokenKind, TokenRef};
use crate::stage::record;
use nqc_census_chain::{
    acquire::Acquisition,
    hex,
    job::{ClaimedLog, JobContext, JobOutput, JobSpec},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::{Address, ChainDomain, StateAnchor};
use nqc_census_state::stage::{index_partition, stage_anchor};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const INDEX_NAMESPACE: u16 = 0x0901;
const INDEX_FAMILY: &str = "rmc009-aave-account-index";

fn shape(detail: impl Into<String>) -> ChainError {
    ChainError::Evidence(format!("undeclared account log shape: {}", detail.into()))
}

/// Candidate pairs and the log digest of one job window.
pub fn index_window(
    logs: &[ClaimedLog],
    tokens: &BTreeMap<Address, TokenRef>,
    first: u64,
    last: u64,
) -> Result<Json, ChainError> {
    let (mint, transfer) = (mint_topic(), balance_transfer_topic());
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC009-INDEX-LOGS-V1");
    let mut pairs = BTreeSet::new();
    let (mut mints, mut transfers, mut zero) = (0_u64, 0_u64, 0_u64);
    for log in logs {
        let raw = &log.log;
        let token = tokens
            .get(&raw.emitter())
            .ok_or_else(|| shape(format!("emitter {}", raw.emitter().to_hex())))?;
        let topics = raw.topics();
        if raw.removed() || topics.len() != 3 {
            return Err(shape(format!(
                "{} topics (removed={})",
                topics.len(),
                raw.removed()
            )));
        }
        let topic0 = *topics[0].as_bytes();
        let data_len = if topic0 == mint {
            mints += 1;
            96
        } else if topic0 == transfer && token.kind == TokenKind::AToken {
            transfers += 1;
            64
        } else {
            return Err(shape("topic0 outside the declared events for this token"));
        };
        if raw.data().len() != data_len {
            return Err(shape(format!("{} data bytes", raw.data().len())));
        }
        let word = topics[2].as_bytes();
        if word[..12].iter().any(|byte| *byte != 0) {
            return Err(shape("non-canonical account word"));
        }
        let mut account = [0_u8; 20];
        account.copy_from_slice(&word[12..]);
        match Address::new(account) {
            Ok(account) => {
                pairs.insert((raw.emitter(), account));
            }
            // The zero address cannot be read as a typed account; it is
            // counted so the reconciler can refuse to certify around it.
            Err(_) => zero += 1,
        }
        digest.update(log.block_number.to_be_bytes());
        digest.update(log.block_hash.as_bytes());
        digest.update(raw.transaction_hash().as_bytes());
        digest.update(raw.transaction_index().to_be_bytes());
        digest.update(raw.log_index().to_be_bytes());
        digest.update(raw.emitter().as_bytes());
        for topic in topics {
            digest.update(topic.as_bytes());
        }
        digest.update((raw.data().len() as u64).to_be_bytes());
        digest.update(raw.data());
    }
    Ok(Json::object([
        ("first", Json::uint(first)),
        ("last", Json::uint(last)),
        ("log_count", Json::uint(logs.len() as u64)),
        ("mint_logs", Json::uint(mints)),
        ("balance_transfer_logs", Json::uint(transfers)),
        ("zero_account_logs", Json::uint(zero)),
        ("logs_sha256", Json::string(hex::plain(&digest.finalize()))),
        (
            "pairs",
            Json::array(pairs.into_iter().map(|(token, account)| {
                Json::array([Json::string(token.to_hex()), Json::string(account.to_hex())])
            })),
        ),
    ]))
}

/// Halvings an index job may descend below the provider's declared log
/// window after a result-cap refusal. Live run 36648778677 and probe run
/// 36656954422 measured more than 10,000 logs in 2,350 blocks near block
/// 24,911,792; the last rung (1/32 of the declared window: 78 blocks on MEV
/// Blocker, 156 on Tenderly) holds densities roughly thirty times that.
pub const RESULT_CAP_DESCENTS: u32 = 5;

/// The declared provider followed by its halved-window rungs, stopping at a
/// one-block window.
pub fn log_window_ladder(provider: &ProviderSpec) -> Result<Vec<ProviderSpec>, ChainError> {
    let mut ladder = vec![provider.clone()];
    let mut window = provider.log_window();
    for _ in 0..RESULT_CAP_DESCENTS {
        if window <= 1 {
            break;
        }
        window /= 2;
        ladder.push(ProviderSpec::new(
            provider.namespace(),
            provider.label(),
            provider.url(),
            provider.operator(),
            provider.min_interval_ms(),
            provider.max_batch(),
            window,
            provider.pinning(),
        )?);
    }
    Ok(ladder)
}

fn mentions_result_cap(text: &str) -> bool {
    let text = text.to_ascii_lowercase();
    (text.contains("more than") && text.contains("result"))
        || text.contains("too many results")
        || text.contains("response size")
}

/// A refusal based on how many logs a range returns: deterministic for the
/// range and the provider's cap, never a transient outage.
///
/// * The RMC-003.2 chain crate types a result-cap message as
///   `RangeTooLarge`.
/// * MEV Blocker answers `-32005 "query returned more than 10000 results"`.
///   The frozen transport retries `-32005` as a rate limit until its budget
///   is spent, so the refusal arrives as `RetryBudgetExhausted` carrying that
///   message.
/// * Tenderly answers `-32602 "invalid params"` and puts "Query returned
///   more than 20000 results" in `data`, which the typed error does not keep.
///   The filter of an index job is the stage-wide filter the same provider
///   accepts for other ranges, so its `-32602` is the range's result count.
///   A misread costs at most the bounded ladder, whose last rung fails closed
///   with the provider's own error.
pub fn is_result_cap_refusal(error: &ChainError) -> bool {
    match error {
        ChainError::RangeTooLarge { .. } => true,
        ChainError::ProviderError { code, .. } => matches!(code, -32602 | -32005),
        ChainError::RetryBudgetExhausted { last, .. } => mentions_result_cap(last),
        _ => false,
    }
}

/// Runs or resumes one index job on the log-window ladder. Committed work is
/// found read-only on every rung first, so resume and offline replay never
/// issue a request for a rung that did not commit; exactly one rung may hold
/// the job. Otherwise the rungs run in order and the first fully answered
/// one commits.
fn index_job<F>(
    acquisition: &Acquisition<'_>,
    ladder: &[ProviderSpec],
    chain: &ChainDomain,
    spec: &JobSpec,
    anchor: &StateAnchor,
    body: F,
) -> Result<JobOutput, ChainError>
where
    F: Fn(&mut JobContext<'_>) -> Result<Json, ChainError>,
{
    let mut committed = Vec::new();
    for rung in ladder {
        let scope = spec.scope(rung, chain, None, anchor)?;
        if acquisition
            .store()
            .resume(&scope)?
            .durable_through
            .is_some()
        {
            committed.push(rung);
        }
    }
    match committed.as_slice() {
        [rung] => return acquisition.point(rung, chain, None, spec, anchor, &body),
        [] => {}
        _ => {
            return Err(ChainError::Evidence(
                "an index job is committed at more than one log window".into(),
            ))
        }
    }
    let mut refusal = None;
    for rung in ladder {
        match acquisition.point(rung, chain, None, spec, anchor, &body) {
            Err(error) if is_result_cap_refusal(&error) => refusal = Some(error),
            outcome => return outcome,
        }
    }
    let floor = ladder
        .last()
        .ok_or_else(|| ChainError::Config("empty log-window ladder".into()))?;
    Err(ChainError::Evidence(format!(
        "RMC009_RESULT_CAP_FLOOR provider={} job={} window={} refusal={}",
        floor.label(),
        spec.parameters().canonical_string()?,
        floor.log_window(),
        refusal.map_or_else(String::new, |error| error.to_string())
    )))
}

/// Index jobs `partition` of `partitions` of the global job grid.
pub fn account_index_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AccountPlan,
    partition: u64,
    partitions: u64,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let filter = plan.index_filter()?;
    let tokens = plan.tokens();
    let jobs = plan.job_ranges();
    let ladder = log_window_ladder(provider)?;
    let mut rows = Vec::new();
    if let Some((first, last)) = index_partition(jobs.len() as u64, partition, partitions)? {
        for &(from, to) in &jobs[first as usize..=last as usize] {
            let spec = JobSpec::new(
                INDEX_FAMILY,
                1,
                INDEX_NAMESPACE,
                Json::object([
                    ("filter", filter.descriptor()),
                    ("first", Json::uint(from)),
                    ("last", Json::uint(to)),
                    ("anchor", Json::uint(plan.anchor.number)),
                ]),
            )?;
            let output = index_job(acquisition, &ladder, &chain, &spec, &anchor, |ctx| {
                let logs = ctx.logs(&filter, from, to)?;
                index_window(&logs, &tokens, from, to)
            })?;
            manifests.push(output.manifest_id().to_hex());
            rows.push(output.result_json()?);
        }
    }
    let parameters = Json::object([
        ("pool", Json::string(plan.pool.to_hex())),
        ("tokens_sha256", Json::string(plan.tokens_digest())),
        ("first_block", Json::uint(plan.first_block)),
        ("index_start", Json::uint(plan.index_start)),
        ("anchor", Json::uint(plan.anchor.number)),
        ("job_span", Json::uint(plan.job_span)),
        ("jobs", Json::uint(jobs.len() as u64)),
        ("partition", Json::uint(partition)),
        ("partitions", Json::uint(partitions)),
        ("filter", filter.descriptor()),
        (
            "log_window_ladder",
            Json::array(ladder.iter().map(|rung| Json::uint(rung.log_window()))),
        ),
    ]);
    Ok((
        record("ACCOUNT_INDEX", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
