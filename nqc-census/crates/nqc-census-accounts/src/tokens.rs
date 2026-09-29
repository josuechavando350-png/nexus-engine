//! `ACCOUNT_TOKENS`: every admitted token's supply at the anchor.
//!
//! For each D06 initialization: the aToken and variable debt token
//! `scaledTotalSupply()` (the right-hand side of the conservation identity)
//! and the stable debt token's `totalSupply()`; for current reserves also
//! `getReserveData(asset)`, whose token addresses must be the D06 ones.

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
use nqc_census_state::stage::{outcome_json, stage_anchor};
use nqc_census_state::v2_stage::uint_field;

const TOKENS_NAMESPACE: u16 = 0x0902;
const TOKENS_FAMILY: &str = "rmc009-aave-token-supply";

pub fn account_tokens_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AccountPlan,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let spec = JobSpec::new(
        TOKENS_FAMILY,
        1,
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
            if let Some(stable) = reserve.stable_debt_token {
                requests.push((stable, abi::encode_call(total, &[])));
            }
        }
        let calls = ctx.calls(&requests, &anchor, semantics)?;
        let mut outcomes = calls.iter().map(|call| call.payload().outcome());
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
            let stable_total = match reserve.stable_debt_token {
                Some(_) => uint_field(next()?),
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
                ("stable_debt_total_supply", stable_total),
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
