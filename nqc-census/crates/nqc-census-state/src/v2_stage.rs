//! Uniswap V2 acquisition stages of RMC-008.
//!
//! - `V2_FACTORY`: the factory runtime (which embeds the pair init code),
//!   `feeTo`/`feeToSetter`, `allPairsLength`, and the runtime of sample pairs.
//! - `V2_STATE`: for an index partition of the admitted D07 pair manifest,
//!   every pair's `getReserves`, `totalSupply`, `kLast`, `factory`, both
//!   tokens' `balanceOf(pair)` and each distinct token's `decimals()`.
//!
//! Token calls are untrusted: they run under a fixed gas bound and every
//! outcome — value, revert, empty return, non-canonical data — is kept as an
//! explicit status. Nothing is assumed about a token that did not answer.

use crate::stage::{
    address_json, index_partition, record, sha256_plain, stage_anchor, untrusted_call,
    untrusted_calls, AnchorPlan, Untrusted,
};
use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::{Address, CallOutcome};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::Path;

const V2_STATE_NAMESPACE: u16 = 0x0803;
const V2_FACTORY_NAMESPACE: u16 = 0x0804;
const V2_STATE_FAMILY: &str = "rmc008-v2-pair-state";
const V2_FACTORY_FAMILY: &str = "rmc008-v2-factory";

#[derive(Debug, Clone, Copy)]
pub struct V2Interface {
    pub get_reserves: [u8; 4],
    pub total_supply: [u8; 4],
    pub k_last: [u8; 4],
    pub factory: [u8; 4],
    pub balance_of: [u8; 4],
    pub decimals: [u8; 4],
    pub fee_to: [u8; 4],
    pub fee_to_setter: [u8; 4],
    pub all_pairs_length: [u8; 4],
}

pub fn v2_interface() -> V2Interface {
    V2Interface {
        get_reserves: abi::selector("getReserves()"),
        total_supply: abi::selector("totalSupply()"),
        k_last: abi::selector("kLast()"),
        factory: abi::selector("factory()"),
        balance_of: abi::selector("balanceOf(address)"),
        decimals: abi::selector("decimals()"),
        fee_to: abi::selector("feeTo()"),
        fee_to_setter: abi::selector("feeToSetter()"),
        all_pairs_length: abi::selector("allPairsLength()"),
    }
}

#[derive(Debug, Clone)]
pub struct V2Plan {
    pub anchor: AnchorPlan,
    pub factory: Address,
    /// Pairs per resumable point job.
    pub job_size: usize,
}

impl V2Plan {
    pub fn mainnet() -> Result<Self, ChainError> {
        Ok(Self {
            anchor: AnchorPlan::mainnet()?,
            factory: Address::parse_hex("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f")?,
            job_size: 2_000,
        })
    }
}

/// One admitted pair from the D07 manifest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairInput {
    pub index: u64,
    pub market_id: String,
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
}

/// Digest binding a stage to the exact admitted pair list it read.
pub fn pairs_digest(pairs: &[PairInput]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC008-V2-PAIR-INPUT-V1");
    for pair in pairs {
        digest.update(pair.index.to_be_bytes());
        digest.update(pair.pair.as_bytes());
        digest.update(pair.token0.as_bytes());
        digest.update(pair.token1.as_bytes());
        digest.update((pair.market_id.len() as u64).to_be_bytes());
        digest.update(pair.market_id.as_bytes());
    }
    hex::plain(&digest.finalize())
}

/// Current pairs of a D07 `v2-pair-manifest.jsonl`, which must enumerate
/// indices `0..N` exactly once each.
pub fn read_pair_manifest(path: &Path) -> Result<Vec<PairInput>, ChainError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| ChainError::Config(format!("{}: {error}", path.display())))?;
    let mut pairs = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let index = match row.get("index") {
            Some(Json::Null) | None => continue,
            Some(value) => value
                .as_i64()
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| ChainError::Evidence("pair index is not an integer".into()))?,
        };
        pairs.push(PairInput {
            index,
            market_id: row.str_field("market_id")?.to_owned(),
            pair: Address::parse_hex(row.str_field("pair")?)?,
            token0: Address::parse_hex(row.str_field("token0")?)?,
            token1: Address::parse_hex(row.str_field("token1")?)?,
        });
    }
    pairs.sort_by_key(|pair| pair.index);
    if pairs
        .iter()
        .enumerate()
        .any(|(position, pair)| pair.index != position as u64)
    {
        return Err(ChainError::Evidence(
            "D07 pair manifest does not enumerate 0..N exactly".into(),
        ));
    }
    Ok(pairs)
}

fn status(name: &str, bytes: &[u8]) -> Json {
    if bytes.is_empty() {
        Json::object([("status", Json::string(name))])
    } else {
        Json::object([
            ("status", Json::string(name)),
            ("data", Json::string(hex::encode(bytes))),
        ])
    }
}

/// A uint word as a decimal string, or an explicit status object.
pub fn uint_field(outcome: &CallOutcome) -> Json {
    match outcome {
        CallOutcome::Returned(bytes) if bytes.is_empty() => status("EMPTY", bytes),
        CallOutcome::Returned(bytes) => match crate::v2_math::uint_word(bytes) {
            Some(value) => Json::string(value.to_decimal()),
            None => status("NON_CANONICAL", bytes),
        },
        CallOutcome::Reverted(bytes) => status("REVERTED", bytes),
    }
}

/// An address word as hex (zero as `null`), or an explicit status object.
pub fn address_field(outcome: &CallOutcome) -> Json {
    match outcome {
        CallOutcome::Returned(bytes) if bytes.is_empty() => status("EMPTY", bytes),
        CallOutcome::Returned(bytes) => match crate::v2_math::address_word(bytes) {
            Some(Some(address)) => address_json(address),
            Some(None) => Json::Null,
            None => status("NON_CANONICAL", bytes),
        },
        CallOutcome::Reverted(bytes) => status("REVERTED", bytes),
    }
}

/// `getReserves()` as three decimal strings, or an explicit status object.
pub fn reserves_field(outcome: &CallOutcome) -> Json {
    match outcome {
        CallOutcome::Returned(bytes) if bytes.is_empty() => status("EMPTY", bytes),
        CallOutcome::Returned(bytes) => match crate::v2_math::Reserves::decode(bytes) {
            Some(reserves) => Json::array([
                Json::string(reserves.reserve0.to_decimal()),
                Json::string(reserves.reserve1.to_decimal()),
                Json::uint(reserves.block_timestamp_last),
            ]),
            None => status("NON_CANONICAL", bytes),
        },
        CallOutcome::Reverted(bytes) => status("REVERTED", bytes),
    }
}

/// `decimals()` as an integer, or an explicit status object.
pub fn decimals_field(outcome: &CallOutcome) -> Json {
    match crate::model::Decimals::decode(outcome) {
        crate::model::Decimals::Value(value) => Json::uint(u64::from(value)),
        crate::model::Decimals::Reverted => status("REVERTED", outcome.output()),
        crate::model::Decimals::Halted => status("HALTED", &[]),
        crate::model::Decimals::Empty => status("EMPTY", &[]),
        crate::model::Decimals::NonCanonical => status("NON_CANONICAL", outcome.output()),
    }
}

/// Untrusted-call status shared by all outcomes that did not return: revert
/// data is not material to the census and one provider may omit it, so the
/// row records only that the call reverted or halted.
fn untrusted_status(outcome: &Untrusted) -> Option<Json> {
    match outcome {
        Untrusted::Call(CallOutcome::Reverted(_)) | Untrusted::RevertedWithoutData => {
            Some(status("REVERTED", &[]))
        }
        Untrusted::Halted => Some(status("HALTED", &[])),
        Untrusted::Call(CallOutcome::Returned(_)) => None,
    }
}

pub fn untrusted_uint_field(outcome: &Untrusted) -> Json {
    match (untrusted_status(outcome), outcome) {
        (Some(status), _) => status,
        (None, Untrusted::Call(call)) => uint_field(call),
        (None, _) => status("REVERTED", &[]),
    }
}

pub fn untrusted_decimals_field(outcome: &Untrusted) -> Json {
    match (untrusted_status(outcome), outcome) {
        (Some(status), _) => status,
        (None, Untrusted::Call(call)) => decimals_field(call),
        (None, _) => status("REVERTED", &[]),
    }
}

/// Factory runtime, fee configuration and sample pair runtimes.
pub fn v2_factory_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &V2Plan,
    samples: &[Address],
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let interface = v2_interface();
    let spec = JobSpec::new(
        V2_FACTORY_FAMILY,
        1,
        V2_FACTORY_NAMESPACE,
        Json::object([
            ("factory", address_json(plan.factory)),
            ("anchor", Json::uint(plan.anchor.number)),
            (
                "samples",
                Json::array(samples.iter().map(|pair| address_json(*pair))),
            ),
        ]),
    )?;
    let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let mut accounts = vec![plan.factory];
        accounts.extend_from_slice(samples);
        let codes = ctx.codes(&accounts, &anchor, semantics)?;
        let calls = ctx.calls(
            &[
                (plan.factory, abi::encode_call(interface.fee_to, &[])),
                (plan.factory, abi::encode_call(interface.fee_to_setter, &[])),
                (
                    plan.factory,
                    abi::encode_call(interface.all_pairs_length, &[]),
                ),
            ],
            &anchor,
            semantics,
        )?;
        let code_json = |index: usize| {
            let code = codes[index].payload().code();
            Json::object([
                ("account", address_json(accounts[index])),
                ("size", Json::uint(code.len() as u64)),
                ("sha256", Json::string(sha256_plain(code))),
                ("code", Json::string(hex::encode(code))),
            ])
        };
        Ok(Json::object([
            ("factory_code", code_json(0)),
            ("fee_to", address_field(calls[0].payload().outcome())),
            ("fee_to_setter", address_field(calls[1].payload().outcome())),
            ("all_pairs_length", uint_field(calls[2].payload().outcome())),
            ("samples", Json::array((1..accounts.len()).map(code_json))),
        ]))
    })?;
    manifests.push(output.manifest_id().to_hex());
    let row = output.result_json()?;
    let parameters = Json::object([
        ("factory", address_json(plan.factory)),
        ("anchor", Json::uint(plan.anchor.number)),
        (
            "samples",
            Json::array(samples.iter().map(|pair| address_json(*pair))),
        ),
    ]);
    let rows = vec![row];
    Ok((
        record("V2_FACTORY", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}

/// Pair and token state for index partition `partition` of `partitions`.
pub fn v2_state_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &V2Plan,
    pairs: &[PairInput],
    partition: u64,
    partitions: u64,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let interface = v2_interface();
    let mut rows = Vec::new();
    let bounds = index_partition(pairs.len() as u64, partition, partitions)?;
    if let Some((first, last)) = bounds {
        let slice = &pairs[first as usize..=last as usize];
        for chunk in slice.chunks(plan.job_size.max(1)) {
            let spec = JobSpec::new(
                V2_STATE_FAMILY,
                1,
                V2_STATE_NAMESPACE,
                Json::object([
                    ("factory", address_json(plan.factory)),
                    ("first_index", Json::uint(chunk[0].index)),
                    ("last_index", Json::uint(chunk[chunk.len() - 1].index)),
                    ("anchor", Json::uint(plan.anchor.number)),
                ]),
            )?;
            let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
                let semantics = chain_read_semantics()?;
                let pair_calls = ctx.calls(
                    &chunk
                        .iter()
                        .flat_map(|input| {
                            [
                                (input.pair, abi::encode_call(interface.get_reserves, &[])),
                                (input.pair, abi::encode_call(interface.total_supply, &[])),
                                (input.pair, abi::encode_call(interface.k_last, &[])),
                                (input.pair, abi::encode_call(interface.factory, &[])),
                            ]
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let balance_calls = untrusted_calls(
                    ctx,
                    &chunk
                        .iter()
                        .flat_map(|input| {
                            let holder = abi::address_word(input.pair.as_bytes());
                            [
                                (
                                    input.token0,
                                    abi::encode_call(interface.balance_of, &[holder]),
                                ),
                                (
                                    input.token1,
                                    abi::encode_call(interface.balance_of, &[holder]),
                                ),
                            ]
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let tokens: BTreeSet<Address> = chunk
                    .iter()
                    .flat_map(|input| [input.token0, input.token1])
                    .collect();
                let tokens: Vec<Address> = tokens.into_iter().collect();
                let decimal_calls = untrusted_calls(
                    ctx,
                    &tokens
                        .iter()
                        .map(|token| (*token, abi::encode_call(interface.decimals, &[])))
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let mut out = Vec::with_capacity(chunk.len() + tokens.len());
                for (position, input) in chunk.iter().enumerate() {
                    let pair = &pair_calls[4 * position..4 * position + 4];
                    let balances = &balance_calls[2 * position..2 * position + 2];
                    out.push(Json::object([
                        ("kind", Json::string("PAIR")),
                        ("index", Json::uint(input.index)),
                        ("pair", address_json(input.pair)),
                        ("token0", address_json(input.token0)),
                        ("token1", address_json(input.token1)),
                        ("reserves", reserves_field(pair[0].payload().outcome())),
                        ("total_supply", uint_field(pair[1].payload().outcome())),
                        ("k_last", uint_field(pair[2].payload().outcome())),
                        ("factory", address_field(pair[3].payload().outcome())),
                        ("balance0", untrusted_uint_field(&balances[0])),
                        ("balance1", untrusted_uint_field(&balances[1])),
                    ]));
                }
                for (token, call) in tokens.iter().zip(&decimal_calls) {
                    out.push(Json::object([
                        ("kind", Json::string("TOKEN")),
                        ("token", address_json(*token)),
                        ("decimals", untrusted_decimals_field(call)),
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
                    .ok_or_else(|| ChainError::Evidence("V2 state job without rows".into()))?
                    .iter()
                    .cloned(),
            );
        }
    }
    let parameters = Json::object([
        ("factory", address_json(plan.factory)),
        ("pair_count", Json::uint(pairs.len() as u64)),
        ("pair_input_sha256", Json::string(pairs_digest(pairs))),
        ("partition", Json::uint(partition)),
        ("partitions", Json::uint(partitions)),
        ("job_size", Json::uint(plan.job_size as u64)),
        ("anchor", Json::uint(plan.anchor.number)),
        (
            "gas_bound",
            Json::uint(untrusted_call().gas_limit().unwrap_or(0)),
        ),
    ]);
    Ok((
        record("V2_STATE", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
