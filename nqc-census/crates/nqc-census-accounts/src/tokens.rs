//! `ACCOUNT_TOKENS`: every admitted token's supply at the anchor.
//!
//! For each D06 initialization: the aToken and variable debt token
//! `scaledTotalSupply()` (the right-hand side of the conservation identity)
//! and the stable debt token's `totalSupply()`; for current reserves also
//! `getReserveData(asset)`, whose aToken and variable debt token must be the
//! D06 ones.
//!
//! Stable rate borrowing is deprecated in Aave V3. At the census anchor
//! `getReserveData` names one stable debt token for all 67 mainnet reserves
//! (WETH's, `0x1026…949a`), not the one each reserve was initialized with
//! (probe run 36712062094). Both are read: the initialization token and the
//! reported token each must hold no supply, and the divergence is recorded.
//!
//! Aave V3 does not refuse the zero address as an aToken recipient: a
//! transfer to it, or a supply on its behalf, credits it a scaled balance
//! that no key can ever move. The zero address is not a typed account, so it
//! never enters the account universe; its `scaledBalanceOf(0x0)` is read here
//! for every aToken and variable debt token, whether or not any log names it,
//! and is a term of the conservation identity.

use crate::plan::AccountPlan;
use crate::stage::record;
use nqc_census_chain::{
    abi,
    acquire::{anchor_record, Acquisition},
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::{Address, CallOutcome};
use nqc_census_state::stage::{outcome_json, stage_anchor};
use nqc_census_state::v2_stage::uint_field;

const TOKENS_NAMESPACE: u16 = 0x0902;
const TOKENS_FAMILY: &str = "rmc009-aave-token-supply";
/// Version 2 adds each token's zero-address scaled balance; version 3 the
/// stable debt token `getReserveData` reports and its supply.
const TOKENS_VERSION: u16 = 3;

/// Distinct requests in first-occurrence order, and each request's position
/// among them. A JSON-RPC batch may not hold one call twice (responses match
/// by position) and reserves share contracts; a read pinned to one block is
/// deterministic, so each distinct read is made once and fanned back out.
fn distinct<K: Clone + Ord>(requests: &[K]) -> (Vec<K>, Vec<usize>) {
    let mut index: std::collections::BTreeMap<&K, usize> = std::collections::BTreeMap::new();
    let mut unique = Vec::new();
    let mut positions = Vec::with_capacity(requests.len());
    for request in requests {
        let position = *index.entry(request).or_insert_with(|| {
            unique.push(request.clone());
            unique.len() - 1
        });
        positions.push(position);
    }
    (unique, positions)
}

/// The stable debt token address word 9 of a `getReserveData` reply names.
fn reported_stable(outcome: &CallOutcome) -> Option<Address> {
    match outcome {
        CallOutcome::Returned(bytes) if bytes.len() >= 11 * 32 => {
            let word = &bytes[9 * 32..10 * 32];
            if word[..12].iter().any(|byte| *byte != 0) {
                return None;
            }
            let mut raw = [0_u8; 20];
            raw.copy_from_slice(&word[12..]);
            Address::new(raw).ok()
        }
        _ => None,
    }
}

pub fn account_tokens_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AccountPlan,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let spec = JobSpec::new(
        TOKENS_FAMILY,
        TOKENS_VERSION,
        TOKENS_NAMESPACE,
        Json::object([
            ("pool", Json::string(plan.pool.to_hex())),
            ("tokens_sha256", Json::string(plan.tokens_digest())),
            ("anchor", Json::uint(plan.anchor.number)),
        ]),
    )?;
    let scaled_total = abi::selector("scaledTotalSupply()");
    let total = abi::selector("totalSupply()");
    let reserve_data = abi::selector("getReserveData(address)");
    let scaled_balance = abi::selector("scaledBalanceOf(address)");
    let zero_address = abi::address_word(&[0_u8; 20]);
    let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let mut requests = Vec::new();
        for reserve in &plan.reserves {
            if reserve.reserve_id.is_some() {
                requests.push((
                    plan.pool,
                    abi::encode_call(reserve_data, &[abi::address_word(reserve.asset.as_bytes())]),
                ));
            }
            requests.push((reserve.a_token, abi::encode_call(scaled_total, &[])));
            requests.push((
                reserve.variable_debt_token,
                abi::encode_call(scaled_total, &[]),
            ));
            requests.push((
                reserve.a_token,
                abi::encode_call(scaled_balance, &[zero_address]),
            ));
            requests.push((
                reserve.variable_debt_token,
                abi::encode_call(scaled_balance, &[zero_address]),
            ));
            if let Some(stable) = reserve.stable_debt_token {
                requests.push((stable, abi::encode_call(total, &[])));
            }
        }
        let (unique, positions) = distinct(&requests);
        let calls = ctx.calls(&unique, &anchor, semantics)?;
        let replies: Vec<CallOutcome> = calls
            .iter()
            .map(|call| call.payload().outcome().clone())
            .collect();
        let fanned: Vec<&CallOutcome> = positions
            .iter()
            .map(|position| {
                replies.get(*position).ok_or_else(|| {
                    ChainError::Evidence("token supply batch returned fewer replies".into())
                })
            })
            .collect::<Result<_, _>>()?;
        // The stable debt token each current reserve's data reports, and its
        // supply, read once per distinct token.
        let mut reported = Vec::with_capacity(plan.reserves.len());
        let mut cursor = 0;
        for reserve in &plan.reserves {
            if reserve.reserve_id.is_some() {
                reported.push(reported_stable(fanned[cursor]));
                cursor += 1;
            } else {
                reported.push(None);
            }
            cursor += if reserve.stable_debt_token.is_some() {
                5
            } else {
                4
            };
        }
        let stable_requests: Vec<(Address, Vec<u8>)> = reported
            .iter()
            .flatten()
            .map(|token| (*token, abi::encode_call(total, &[])))
            .collect();
        let (stable_unique, stable_positions) = distinct(&stable_requests);
        let stable_replies: Vec<CallOutcome> = if stable_unique.is_empty() {
            Vec::new()
        } else {
            ctx.calls(&stable_unique, &anchor, semantics)?
                .iter()
                .map(|call| call.payload().outcome().clone())
                .collect()
        };
        let mut stable_totals = stable_positions
            .iter()
            .map(|position| stable_replies.get(*position));
        let mut outcomes = fanned.into_iter();
        let mut next = || {
            outcomes
                .next()
                .ok_or_else(|| ChainError::Evidence("token supply reply missing".into()))
        };
        let mut rows = Vec::with_capacity(plan.reserves.len());
        for reserve in &plan.reserves {
            let data = match reserve.reserve_id {
                Some(_) => outcome_json(next()?),
                None => Json::Null,
            };
            let a_total = uint_field(next()?);
            let v_total = uint_field(next()?);
            let a_zero = uint_field(next()?);
            let v_zero = uint_field(next()?);
            let stable_total = match reserve.stable_debt_token {
                Some(_) => uint_field(next()?),
                None => Json::Null,
            };
            let reported_token = reported[rows.len()];
            let reported_total = match reported_token {
                Some(_) => uint_field(stable_totals.next().flatten().ok_or_else(|| {
                    ChainError::Evidence("reported stable debt supply reply missing".into())
                })?),
                None => Json::Null,
            };
            rows.push(Json::object([
                ("asset", Json::string(reserve.asset.to_hex())),
                ("market_id", Json::string(reserve.market_id.clone())),
                (
                    "reserve_id",
                    reserve
                        .reserve_id
                        .map_or(Json::Null, |id| Json::uint(u64::from(id))),
                ),
                ("a_token", Json::string(reserve.a_token.to_hex())),
                (
                    "variable_debt_token",
                    Json::string(reserve.variable_debt_token.to_hex()),
                ),
                (
                    "stable_debt_token",
                    reserve
                        .stable_debt_token
                        .map_or(Json::Null, |token| Json::string(token.to_hex())),
                ),
                ("reserve_data", data),
                ("a_token_scaled_total_supply", a_total),
                ("variable_debt_scaled_total_supply", v_total),
                ("a_token_zero_address_scaled_balance", a_zero),
                ("variable_debt_zero_address_scaled_balance", v_zero),
                ("stable_debt_total_supply", stable_total),
                (
                    "reported_stable_debt_token",
                    reported_token.map_or(Json::Null, |token| Json::string(token.to_hex())),
                ),
                ("reported_stable_debt_total_supply", reported_total),
            ]));
        }
        Ok(Json::object([("rows", Json::Array(rows))]))
    })?;
    manifests.push(output.manifest_id().to_hex());
    let rows = output
        .result_json()?
        .get("rows")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("token supply job without rows".into()))?
        .to_vec();
    let parameters = Json::object([
        ("pool", Json::string(plan.pool.to_hex())),
        ("tokens_sha256", Json::string(plan.tokens_digest())),
        ("anchor", Json::uint(plan.anchor.number)),
        ("anchor_block", anchor_record(&anchor)),
    ]);
    Ok((
        record("ACCOUNT_TOKENS", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
