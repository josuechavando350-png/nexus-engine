//! `ACCOUNT_STATE`: every candidate position at the anchor.
//!
//! One provider, one contiguous partition of the candidate accounts. For
//! every (account, token) candidate: `scaledBalanceOf(account)` (the
//! conservation term) and `balanceOf(account)` (the protocol's own
//! index-adjusted amount); for every account `getUserConfiguration`. For
//! every account that holds anything or has a configuration bit set:
//! `getUserEMode` and `getUserAccountData`. `getUserAccountData` consults
//! oracle sources the census does not trust, so it runs under the fixed gas
//! bound and a revert or halt is kept as an explicit status.

use crate::candidates::Candidates;
use crate::stage::record;
use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::{Address, CallOutcome};
use nqc_census_state::stage::{
    index_partition, stage_anchor, untrusted_call, untrusted_calls, Untrusted,
};
use nqc_census_state::uint::U256;
use nqc_census_state::v2_stage::uint_field;

use crate::plan::AccountPlan;

const STATE_NAMESPACE: u16 = 0x0903;
const STATE_FAMILY: &str = "rmc009-aave-account-state";

fn status(name: &str) -> Json {
    Json::object([("status", Json::string(name))])
}

/// `getUserAccountData` as six decimal strings (total collateral base, total
/// debt base, available borrows base, liquidation threshold, LTV, health
/// factor), or an explicit status.
pub fn account_data_field(outcome: &Untrusted) -> Json {
    match outcome {
        Untrusted::Call(CallOutcome::Returned(bytes)) if bytes.len() == 192 => {
            Json::array(bytes.chunks(32).map(|word| {
                let mut buffer = [0_u8; 32];
                buffer.copy_from_slice(word);
                Json::string(U256::from_word(&buffer).to_decimal())
            }))
        }
        Untrusted::Call(CallOutcome::Returned(bytes)) if bytes.is_empty() => status("EMPTY"),
        Untrusted::Call(CallOutcome::Returned(_)) => status("NON_CANONICAL"),
        Untrusted::Call(CallOutcome::Reverted(_)) | Untrusted::RevertedWithoutData => {
            status("REVERTED")
        }
        Untrusted::Halted => status("HALTED"),
    }
}

fn nonzero(field: &Json) -> bool {
    field.as_str().is_some_and(|value| value != "0")
}

/// State of candidate-account partition `partition` of `partitions`.
pub fn account_state_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AccountPlan,
    candidates: &Candidates,
    partition: u64,
    partitions: u64,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let candidates_sha256 = candidates.digest();
    let scaled_balance = abi::selector("scaledBalanceOf(address)");
    let balance = abi::selector("balanceOf(address)");
    let configuration = abi::selector("getUserConfiguration(address)");
    let emode = abi::selector("getUserEMode(address)");
    let account_data = abi::selector("getUserAccountData(address)");
    let mut rows = Vec::new();
    let bounds = index_partition(candidates.accounts.len() as u64, partition, partitions)?;
    if let Some((first, last)) = bounds {
        let slice = &candidates.accounts[first as usize..=last as usize];
        for (offset, chunk) in slice.chunks(plan.job_accounts).enumerate() {
            let first_index = first + (offset * plan.job_accounts) as u64;
            let spec = JobSpec::new(
                STATE_FAMILY,
                1,
                STATE_NAMESPACE,
                Json::object([
                    ("pool", Json::string(plan.pool.to_hex())),
                    ("candidates_sha256", Json::string(candidates_sha256.clone())),
                    ("first_account_index", Json::uint(first_index)),
                    (
                        "last_account_index",
                        Json::uint(first_index + chunk.len() as u64 - 1),
                    ),
                    ("anchor", Json::uint(plan.anchor.number)),
                ]),
            )?;
            let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
                let semantics = chain_read_semantics()?;
                let holder = |account: &Address| abi::address_word(account.as_bytes());
                let mut requests: Vec<(Address, Vec<u8>)> = Vec::new();
                for (account, tokens) in chunk {
                    for token in tokens {
                        requests
                            .push((*token, abi::encode_call(scaled_balance, &[holder(account)])));
                        requests.push((*token, abi::encode_call(balance, &[holder(account)])));
                    }
                    requests.push((
                        plan.pool,
                        abi::encode_call(configuration, &[holder(account)]),
                    ));
                }
                let calls = ctx.calls(&requests, &anchor, semantics)?;
                let mut outcomes = calls.iter().map(|call| call.payload().outcome());
                let mut next = || {
                    outcomes
                        .next()
                        .ok_or_else(|| ChainError::Evidence("position reply missing".into()))
                };
                let mut partial = Vec::with_capacity(chunk.len());
                for (account, tokens) in chunk {
                    let mut positions = Vec::with_capacity(tokens.len());
                    let mut engaged = false;
                    for token in tokens {
                        let scaled = uint_field(next()?);
                        let amount = uint_field(next()?);
                        engaged |= nonzero(&scaled) || nonzero(&amount);
                        positions.push(Json::object([
                            ("token", Json::string(token.to_hex())),
                            ("scaled", scaled),
                            ("balance", amount),
                        ]));
                    }
                    let config = uint_field(next()?);
                    engaged |= nonzero(&config) || config.as_str().is_none();
                    partial.push((*account, positions, config, engaged));
                }
                let engaged: Vec<Address> = partial
                    .iter()
                    .filter(|(_, _, _, engaged)| *engaged)
                    .map(|(account, _, _, _)| *account)
                    .collect();
                let modes = ctx.calls(
                    &engaged
                        .iter()
                        .map(|account| (plan.pool, abi::encode_call(emode, &[holder(account)])))
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let data = untrusted_calls(
                    ctx,
                    &engaged
                        .iter()
                        .map(|account| {
                            (
                                plan.pool,
                                abi::encode_call(account_data, &[holder(account)]),
                            )
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let mut engaged_facts = engaged.iter().zip(modes.iter().zip(&data));
                let mut out = Vec::with_capacity(partial.len());
                for (account, positions, config, is_engaged) in partial {
                    let (mode, account_facts) = if is_engaged {
                        let (_, (mode, facts)) = engaged_facts.next().ok_or_else(|| {
                            ChainError::Evidence("engaged account reply missing".into())
                        })?;
                        (
                            uint_field(mode.payload().outcome()),
                            account_data_field(facts),
                        )
                    } else {
                        (Json::Null, Json::Null)
                    };
                    out.push(Json::object([
                        ("account", Json::string(account.to_hex())),
                        ("positions", Json::Array(positions)),
                        ("configuration", config),
                        ("emode", mode),
                        ("account_data", account_facts),
                    ]));
                }
                Ok(Json::object([("rows", Json::Array(out))]))
            })?;
            manifests.push(output.manifest_id().to_hex());
            rows.extend(
                output
                    .result_json()?
                    .get("rows")
                    .and_then(Json::as_array)
                    .ok_or_else(|| ChainError::Evidence("state job without rows".into()))?
                    .iter()
                    .cloned(),
            );
        }
    }
    let parameters = Json::object([
        ("pool", Json::string(plan.pool.to_hex())),
        ("tokens_sha256", Json::string(plan.tokens_digest())),
        ("candidates_sha256", Json::string(candidates_sha256)),
        ("accounts", Json::uint(candidates.accounts.len() as u64)),
        ("pairs", Json::uint(candidates.pair_count() as u64)),
        ("partition", Json::uint(partition)),
        ("partitions", Json::uint(partitions)),
        ("job_accounts", Json::uint(plan.job_accounts as u64)),
        ("anchor", Json::uint(plan.anchor.number)),
        (
            "gas_bound",
            Json::uint(untrusted_call().gas_limit().unwrap_or(0)),
        ),
    ]);
    Ok((
        record("ACCOUNT_STATE", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
