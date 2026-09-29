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

use crate::plan::{balance_transfer_topic, mint_topic, AccountPlan, TokenKind, TokenRef};
use crate::stage::record;
use nqc_census_chain::{
    acquire::Acquisition,
    hex,
    job::{ClaimedLog, JobSpec},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::Address;
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
            let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
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
        ("anchor", Json::uint(plan.anchor.number)),
        ("job_span", Json::uint(plan.job_span)),
        ("jobs", Json::uint(jobs.len() as u64)),
        ("partition", Json::uint(partition)),
        ("partitions", Json::uint(partitions)),
        ("filter", filter.descriptor()),
    ]);
    Ok((
        record("ACCOUNT_INDEX", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
