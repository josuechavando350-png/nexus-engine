//! Aave V3 acquisition stage of RMC-008.
//!
//! One provider, one anchor, one resumable point job. Which getters exist is
//! read from the observed Pool implementation runtime (a selector push is a
//! necessary condition for a dispatcher entry), so the job never calls an
//! entry point the deployed version does not have; every present getter is
//! called and kept as an exact outcome.

use crate::stage::{
    address_json, chain_json, record, sha256_plain, stage_anchor, untrusted_call, AnchorPlan,
};
use crate::stage::{untrusted_calls, Untrusted};
use crate::v2_stage::{
    address_field, decimals_field, uint_field, untrusted_decimals_field, untrusted_uint_field,
};
use nqc_census_chain::{
    abi,
    acquire::{anchor_record, Acquisition},
    evm::CodeScan,
    hex,
    job::{chain_read_semantics, JobContext, JobSpec},
    json::Json,
    provider::ProviderSpec,
    rpc::RpcCall,
    ChainError,
};
use nqc_census_core::{Address, CallContext, CallOutcome, ObservationSemantics, StateAnchor};

const AAVE_STATE_NAMESPACE: u16 = 0x0801;
const AAVE_STATE_FAMILY: &str = "rmc008-aave-state";

pub const EIP1967_IMPLEMENTATION_SLOT: &str =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
pub const EIP1967_BEACON_SLOT: &str =
    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
pub const ZEPPELINOS_IMPLEMENTATION_SLOT: &str =
    "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

/// Pool-level getters, called when present in the implementation.
pub const POOL_SCALARS: [&str; 6] = [
    "FLASHLOAN_PREMIUM_TOTAL()",
    "FLASHLOAN_PREMIUM_TO_PROTOCOL()",
    "MAX_NUMBER_RESERVES()",
    "BRIDGE_PROTOCOL_FEE()",
    "POOL_REVISION()",
    "getReservesCount()",
];

/// Per-reserve getters. The first four are required.
pub const RESERVE_GETTERS: [&str; 9] = [
    "getReserveData(address)",
    "getConfiguration(address)",
    "getReserveNormalizedIncome(address)",
    "getReserveNormalizedVariableDebt(address)",
    "getVirtualUnderlyingBalance(address)",
    "getLiquidationGracePeriod(address)",
    "getReserveDeficit(address)",
    "getReserveAToken(address)",
    "getReserveVariableDebtToken(address)",
];

pub const EMODE_GETTERS: [&str; 6] = [
    "getEModeCategoryCollateralConfig(uint8)",
    "getEModeCategoryLabel(uint8)",
    "getEModeCategoryCollateralBitmap(uint8)",
    "getEModeCategoryBorrowableBitmap(uint8)",
    "getEModeCategoryLtvzeroBitmap(uint8)",
    "getEModeCategoryData(uint8)",
];

pub const ORACLE_SOURCE_GETTERS: [&str; 4] = [
    "latestAnswer()",
    "latestRoundData()",
    "decimals()",
    "latestTimestamp()",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AaveReserveInput {
    pub asset: Address,
    pub reserve_id: u16,
}

#[derive(Debug, Clone)]
pub struct AavePlan {
    pub anchor: AnchorPlan,
    pub pool: Address,
    pub pool_implementation: Address,
    pub addresses_provider: Address,
    pub oracle: Address,
    pub reserves: Vec<AaveReserveInput>,
}

fn selector_word(signature: &str) -> [u8; 4] {
    abi::selector(signature)
}

fn outcome_row(signature: &str, outcome: &CallOutcome) -> (String, Json) {
    let raw = match outcome {
        CallOutcome::Returned(bytes) => Json::object([
            ("status", Json::string("RETURNED")),
            ("data", Json::string(hex::encode(bytes))),
        ]),
        CallOutcome::Reverted(bytes) => Json::object([
            ("status", Json::string("REVERTED")),
            ("data", Json::string(hex::encode(bytes))),
        ]),
    };
    (signature.to_owned(), raw)
}

/// One storage word read through a block-hash pinned `eth_getStorageAt`.
/// The exchange is recorded, so offline replay reproduces it.
pub fn storage_word(
    ctx: &mut JobContext<'_>,
    account: Address,
    slot: &str,
    anchor: &StateAnchor,
) -> Result<[u8; 32], ChainError> {
    let value = ctx.raw_result(&RpcCall::new(
        "eth_getStorageAt",
        Json::array([
            Json::string(account.to_hex()),
            Json::string(slot),
            Json::object([
                ("blockHash", Json::string(anchor.block_hash().to_hex())),
                ("requireCanonical", Json::Bool(true)),
            ]),
        ]),
    ))?;
    let bytes = hex::decode_data(
        value
            .as_str()
            .ok_or_else(|| ChainError::Evidence("storage value is not text".into()))?,
    )?;
    if bytes.len() > 32 {
        return Err(ChainError::Evidence(
            "storage value exceeds one word".into(),
        ));
    }
    let mut word = [0u8; 32];
    word[32 - bytes.len()..].copy_from_slice(&bytes);
    Ok(word)
}

fn slot_address(word: &[u8; 32]) -> Json {
    if word[..12].iter().any(|byte| *byte != 0) {
        return Json::object([
            ("status", Json::string("NON_ADDRESS_WORD")),
            ("data", Json::string(hex::encode(word))),
        ]);
    }
    let mut raw = [0u8; 20];
    raw.copy_from_slice(&word[12..]);
    Address::new(raw).map_or(Json::Null, address_json)
}

fn code_json(account: Address, code: &[u8]) -> Json {
    Json::object([
        ("account", address_json(account)),
        ("size", Json::uint(code.len() as u64)),
        ("sha256", Json::string(sha256_plain(code))),
    ])
}

fn returned_address(outcome: &CallOutcome) -> Option<Address> {
    match outcome {
        CallOutcome::Returned(bytes) => {
            crate::v2_math::address_word(bytes).and_then(|address| address)
        }
        CallOutcome::Reverted(_) => None,
    }
}

fn reserve_words(outcome: &CallOutcome) -> Result<Vec<[u8; 32]>, ChainError> {
    match outcome {
        CallOutcome::Returned(bytes) => abi::words(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence("getReserveData reverted".into())),
    }
}

fn word_address(word: &[u8; 32]) -> Result<Option<Address>, ChainError> {
    Ok(match abi::decode_address(word)? {
        Some(raw) => Some(Address::new(raw)?),
        None => None,
    })
}

/// Distinct requests in first-occurrence order, and for every request the
/// position of its distinct copy.
///
/// The chain layer refuses a JSON-RPC batch that holds one call twice
/// (responses are matched by position). Mainnet reserves share addresses, so
/// live run 36682467619 failed every AAVE_STATE attempt on both providers with
/// `duplicate call in batch`. A call or code read pinned to one block is
/// deterministic, so each distinct request is made once and its outcome is
/// fanned back out to every request that named it; no row changes.
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

fn fan_out<T: Clone>(outcomes: &[T], positions: &[usize]) -> Result<Vec<T>, ChainError> {
    positions
        .iter()
        .map(|position| {
            outcomes.get(*position).cloned().ok_or_else(|| {
                ChainError::Evidence("batch returned fewer outcomes than requested".into())
            })
        })
        .collect()
}

struct Calls<'c, 'a> {
    ctx: &'c mut JobContext<'a>,
    anchor: &'c StateAnchor,
    semantics: ObservationSemantics,
}

impl Calls<'_, '_> {
    fn run(
        &mut self,
        requests: &[(Address, Vec<u8>)],
        context: CallContext,
    ) -> Result<Vec<CallOutcome>, ChainError> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let (unique, positions) = distinct(requests);
        let outcomes: Vec<CallOutcome> = self
            .ctx
            .calls_in_context(&unique, context, self.anchor, self.semantics)?
            .into_iter()
            .map(|call| call.payload().outcome().clone())
            .collect();
        fan_out(&outcomes, &positions)
    }

    fn run_untrusted(
        &mut self,
        requests: &[(Address, Vec<u8>)],
    ) -> Result<Vec<Untrusted>, ChainError> {
        if requests.is_empty() {
            return Ok(Vec::new());
        }
        let (unique, positions) = distinct(requests);
        let outcomes = untrusted_calls(self.ctx, &unique, self.anchor, self.semantics)?;
        fan_out(&outcomes, &positions)
    }
}

/// An untrusted getter outcome; revert data is dropped because providers
/// differ on whether they transport it.
fn untrusted_row(signature: &str, outcome: &Untrusted) -> (String, Json) {
    let failed = |status: &str| {
        (
            signature.to_owned(),
            Json::object([
                ("status", Json::string(status)),
                ("data", Json::string("0x")),
            ]),
        )
    };
    match outcome {
        Untrusted::Call(call @ CallOutcome::Returned(_)) => outcome_row(signature, call),
        Untrusted::Call(CallOutcome::Reverted(_)) | Untrusted::RevertedWithoutData => {
            failed("REVERTED")
        }
        Untrusted::Halted => failed("HALTED"),
    }
}

/// The reserves an `AAVE_STATE` record names: asset and reserve id, in plan
/// order.
pub fn reserves_json(plan: &AavePlan) -> Json {
    Json::array(plan.reserves.iter().map(|reserve| {
        Json::object([
            ("asset", address_json(reserve.asset)),
            ("reserve_id", Json::uint(u64::from(reserve.reserve_id))),
        ])
    }))
}

/// Every state fact the D08 Aave adapter needs, from one provider.
pub fn aave_state_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &AavePlan,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, &plan.anchor)?;
    let reserves_json = reserves_json(plan);
    let spec = JobSpec::new(
        AAVE_STATE_FAMILY,
        1,
        AAVE_STATE_NAMESPACE,
        Json::object([
            ("pool", address_json(plan.pool)),
            (
                "pool_implementation",
                address_json(plan.pool_implementation),
            ),
            ("oracle", address_json(plan.oracle)),
            ("anchor", Json::uint(plan.anchor.number)),
            ("reserves", reserves_json.clone()),
        ]),
    )?;
    let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let base_codes = ctx.codes(
            &[plan.pool, plan.pool_implementation, plan.oracle],
            &anchor,
            semantics,
        )?;
        let implementation_scan = CodeScan::new(base_codes[1].payload().code());
        let present = |signature: &str| implementation_scan.has_selector(selector_word(signature));
        let implementation_word =
            storage_word(ctx, plan.pool, EIP1967_IMPLEMENTATION_SLOT, &anchor)?;
        let mut calls = Calls {
            ctx,
            anchor: &anchor,
            semantics,
        };
        let static_read = CallContext::static_read();

        // Pool scalars and the reserve list.
        let scalar_signatures: Vec<&str> = POOL_SCALARS
            .iter()
            .copied()
            .filter(|signature| present(signature))
            .chain(std::iter::once("getReservesList()"))
            .collect();
        let scalar_outcomes = calls.run(
            &scalar_signatures
                .iter()
                .map(|signature| (plan.pool, abi::encode_call(selector_word(signature), &[])))
                .collect::<Vec<_>>(),
            static_read,
        )?;
        let pool_row = Json::object([
            ("kind", Json::string("POOL")),
            ("pool", address_json(plan.pool)),
            (
                "pool_code",
                code_json(plan.pool, base_codes[0].payload().code()),
            ),
            (
                "pool_eip1967_implementation",
                slot_address(&implementation_word),
            ),
            (
                "pool_implementation_code",
                code_json(plan.pool_implementation, base_codes[1].payload().code()),
            ),
            (
                "oracle_code",
                code_json(plan.oracle, base_codes[2].payload().code()),
            ),
            (
                "getters_present",
                Json::array(
                    POOL_SCALARS
                        .iter()
                        .chain(RESERVE_GETTERS.iter())
                        .chain(EMODE_GETTERS.iter())
                        .copied()
                        .filter(|signature| present(signature))
                        .map(Json::string),
                ),
            ),
            (
                "scalars",
                Json::object(
                    scalar_signatures
                        .iter()
                        .zip(&scalar_outcomes)
                        .map(|(signature, outcome)| outcome_row(signature, outcome)),
                ),
            ),
        ]);

        // Per-reserve getters.
        let reserve_signatures: Vec<&str> = RESERVE_GETTERS
            .iter()
            .copied()
            .enumerate()
            .filter(|(index, signature)| *index < 4 || present(signature))
            .map(|(_, signature)| signature)
            .collect();
        let reserve_outcomes = calls.run(
            &plan
                .reserves
                .iter()
                .flat_map(|reserve| {
                    reserve_signatures.iter().map(move |signature| {
                        (
                            plan.pool,
                            abi::encode_call(
                                selector_word(signature),
                                &[abi::address_word(reserve.asset.as_bytes())],
                            ),
                        )
                    })
                })
                .collect::<Vec<_>>(),
            static_read,
        )?;
        let width = reserve_signatures.len();
        let mut token_sets = Vec::with_capacity(plan.reserves.len());
        for (position, reserve) in plan.reserves.iter().enumerate() {
            let words = reserve_words(&reserve_outcomes[position * width])?;
            if words.len() < 12 {
                return Err(ChainError::Evidence(format!(
                    "getReserveData for {} returned {} words",
                    reserve.asset.to_hex(),
                    words.len()
                )));
            }
            let a_token = word_address(&words[8])?
                .ok_or_else(|| ChainError::Evidence("reserve without aToken".into()))?;
            let stable = word_address(&words[9])?;
            let variable = word_address(&words[10])?
                .ok_or_else(|| ChainError::Evidence("reserve without debt token".into()))?;
            let strategy = word_address(&words[11])?;
            token_sets.push((a_token, stable, variable, strategy));
        }

        // Token facts.
        let mut aave_token_requests = Vec::new();
        let mut underlying_requests = Vec::new();
        for (reserve, (a_token, stable, variable, _)) in plan.reserves.iter().zip(&token_sets) {
            for signature in [
                "UNDERLYING_ASSET_ADDRESS()",
                "POOL()",
                "RESERVE_TREASURY_ADDRESS()",
                "scaledTotalSupply()",
                "totalSupply()",
                "decimals()",
            ] {
                aave_token_requests
                    .push((*a_token, abi::encode_call(selector_word(signature), &[])));
            }
            for signature in [
                "UNDERLYING_ASSET_ADDRESS()",
                "POOL()",
                "scaledTotalSupply()",
                "totalSupply()",
                "decimals()",
            ] {
                aave_token_requests
                    .push((*variable, abi::encode_call(selector_word(signature), &[])));
            }
            if let Some(stable) = stable {
                aave_token_requests.push((
                    *stable,
                    abi::encode_call(selector_word("totalSupply()"), &[]),
                ));
            }
            underlying_requests.push((
                reserve.asset,
                abi::encode_call(selector_word("decimals()"), &[]),
            ));
            underlying_requests.push((
                reserve.asset,
                abi::encode_call(selector_word("totalSupply()"), &[]),
            ));
            underlying_requests.push((
                reserve.asset,
                abi::encode_call(
                    selector_word("balanceOf(address)"),
                    &[abi::address_word(a_token.as_bytes())],
                ),
            ));
        }
        let aave_token_outcomes = calls.run(&aave_token_requests, static_read)?;
        let underlying_outcomes = calls.run_untrusted(&underlying_requests)?;

        // Proxy slots and runtimes of every token.
        let mut reserve_rows = Vec::with_capacity(plan.reserves.len());
        let mut cursor = 0;
        for (position, (reserve, (a_token, stable, variable, strategy))) in
            plan.reserves.iter().zip(&token_sets).enumerate()
        {
            let getters = &reserve_outcomes[position * width..(position + 1) * width];
            let a = &aave_token_outcomes[cursor..cursor + 6];
            let v = &aave_token_outcomes[cursor + 6..cursor + 11];
            cursor += 11;
            let stable_total = match stable {
                Some(_) => {
                    let outcome = &aave_token_outcomes[cursor];
                    cursor += 1;
                    uint_field(outcome)
                }
                None => Json::Null,
            };
            let u = &underlying_outcomes[3 * position..3 * position + 3];
            let mut slots = Vec::new();
            for (label, account, slot) in [
                (
                    "underlying_eip1967_implementation",
                    reserve.asset,
                    EIP1967_IMPLEMENTATION_SLOT,
                ),
                (
                    "underlying_eip1967_beacon",
                    reserve.asset,
                    EIP1967_BEACON_SLOT,
                ),
                (
                    "underlying_zeppelinos_implementation",
                    reserve.asset,
                    ZEPPELINOS_IMPLEMENTATION_SLOT,
                ),
                (
                    "a_token_eip1967_implementation",
                    *a_token,
                    EIP1967_IMPLEMENTATION_SLOT,
                ),
                (
                    "variable_debt_eip1967_implementation",
                    *variable,
                    EIP1967_IMPLEMENTATION_SLOT,
                ),
            ] {
                let word = storage_word(calls.ctx, account, slot, &anchor)?;
                slots.push((label, word));
            }
            let mut code_accounts = vec![reserve.asset, *a_token, *variable];
            for (_, word) in &slots {
                if word[..12].iter().all(|byte| *byte == 0) {
                    let mut raw = [0u8; 20];
                    raw.copy_from_slice(&word[12..]);
                    if let Ok(address) = Address::new(raw) {
                        if !code_accounts.contains(&address) {
                            code_accounts.push(address);
                        }
                    }
                }
            }
            if let Some(strategy) = strategy {
                code_accounts.push(*strategy);
            }
            let (distinct_accounts, positions) = distinct(&code_accounts);
            let codes = fan_out(
                &calls.ctx.codes(&distinct_accounts, &anchor, semantics)?,
                &positions,
            )?;
            reserve_rows.push(Json::object([
                ("kind", Json::string("RESERVE")),
                ("asset", address_json(reserve.asset)),
                ("reserve_id", Json::uint(u64::from(reserve.reserve_id))),
                (
                    "getters",
                    Json::object(
                        reserve_signatures
                            .iter()
                            .zip(getters)
                            .map(|(signature, outcome)| outcome_row(signature, outcome)),
                    ),
                ),
                ("a_token", address_json(*a_token)),
                ("variable_debt_token", address_json(*variable)),
                ("stable_debt_token", stable.map_or(Json::Null, address_json)),
                (
                    "interest_rate_strategy",
                    strategy.map_or(Json::Null, address_json),
                ),
                (
                    "a_token_facts",
                    Json::object([
                        ("underlying", address_field(&a[0])),
                        ("pool", address_field(&a[1])),
                        ("treasury", address_field(&a[2])),
                        ("scaled_total_supply", uint_field(&a[3])),
                        ("total_supply", uint_field(&a[4])),
                        ("decimals", decimals_field(&a[5])),
                    ]),
                ),
                (
                    "variable_debt_facts",
                    Json::object([
                        ("underlying", address_field(&v[0])),
                        ("pool", address_field(&v[1])),
                        ("scaled_total_supply", uint_field(&v[2])),
                        ("total_supply", uint_field(&v[3])),
                        ("decimals", decimals_field(&v[4])),
                    ]),
                ),
                ("stable_debt_total_supply", stable_total),
                (
                    "underlying_facts",
                    Json::object([
                        ("decimals", untrusted_decimals_field(&u[0])),
                        ("total_supply", untrusted_uint_field(&u[1])),
                        ("balance_of_a_token", untrusted_uint_field(&u[2])),
                    ]),
                ),
                (
                    "proxy_slots",
                    Json::object(
                        slots
                            .iter()
                            .map(|(label, word)| ((*label).to_owned(), slot_address(word))),
                    ),
                ),
                (
                    "codes",
                    Json::array(
                        code_accounts
                            .iter()
                            .zip(&codes)
                            .map(|(account, code)| code_json(*account, code.payload().code())),
                    ),
                ),
            ]));
        }

        // eMode categories 1..=255.
        let emode_signatures: Vec<&str> = EMODE_GETTERS
            .iter()
            .copied()
            .filter(|signature| present(signature))
            .collect();
        let emode_outcomes = calls.run(
            &(1u64..=255)
                .flat_map(|id| {
                    emode_signatures.iter().map(move |signature| {
                        (
                            plan.pool,
                            abi::encode_call(selector_word(signature), &[abi::uint_word(id)]),
                        )
                    })
                })
                .collect::<Vec<_>>(),
            static_read,
        )?;
        let emode_rows = (1u64..=255).enumerate().map(|(position, id)| {
            let outcomes = &emode_outcomes
                [position * emode_signatures.len()..(position + 1) * emode_signatures.len()];
            Json::object([
                ("kind", Json::string("EMODE")),
                ("id", Json::uint(id)),
                (
                    "getters",
                    Json::object(
                        emode_signatures
                            .iter()
                            .zip(outcomes)
                            .map(|(signature, outcome)| outcome_row(signature, outcome)),
                    ),
                ),
            ])
        });
        let emode_rows: Vec<Json> = emode_rows.collect();

        // Oracle.
        let oracle_scan = CodeScan::new(base_codes[2].payload().code());
        let oracle_signatures: Vec<&str> = [
            "BASE_CURRENCY()",
            "BASE_CURRENCY_UNIT()",
            "getFallbackOracle()",
        ]
        .into_iter()
        .filter(|signature| oracle_scan.has_selector(selector_word(signature)))
        .collect();
        let oracle_scalars = calls.run(
            &oracle_signatures
                .iter()
                .map(|signature| (plan.oracle, abi::encode_call(selector_word(signature), &[])))
                .collect::<Vec<_>>(),
            static_read,
        )?;
        let asset_outcomes = calls.run(
            &plan
                .reserves
                .iter()
                .flat_map(|reserve| {
                    ["getSourceOfAsset(address)", "getAssetPrice(address)"]
                        .into_iter()
                        .map(move |signature| {
                            (
                                plan.oracle,
                                abi::encode_call(
                                    selector_word(signature),
                                    &[abi::address_word(reserve.asset.as_bytes())],
                                ),
                            )
                        })
                })
                .collect::<Vec<_>>(),
            static_read,
        )?;
        let sources: Vec<Option<Address>> = (0..plan.reserves.len())
            .map(|position| returned_address(&asset_outcomes[2 * position]))
            .collect();
        let mut distinct_sources: Vec<Address> = sources.iter().flatten().copied().collect();
        distinct_sources.sort();
        distinct_sources.dedup();
        let source_codes = calls.ctx.codes(&distinct_sources, &anchor, semantics)?;
        let mut source_rows = Vec::with_capacity(distinct_sources.len());
        for (source, code) in distinct_sources.iter().zip(&source_codes) {
            let scan = CodeScan::new(code.payload().code());
            let signatures: Vec<&str> = ORACLE_SOURCE_GETTERS
                .iter()
                .copied()
                .filter(|signature| scan.has_selector(selector_word(signature)))
                .collect();
            let outcomes = calls.run_untrusted(
                &signatures
                    .iter()
                    .map(|signature| (*source, abi::encode_call(selector_word(signature), &[])))
                    .collect::<Vec<_>>(),
            )?;
            let slot = storage_word(calls.ctx, *source, EIP1967_IMPLEMENTATION_SLOT, &anchor)?;
            source_rows.push(Json::object([
                ("source", address_json(*source)),
                ("code", code_json(*source, code.payload().code())),
                ("eip1967_implementation", slot_address(&slot)),
                (
                    "getters",
                    Json::object(
                        signatures
                            .iter()
                            .zip(&outcomes)
                            .map(|(signature, outcome)| untrusted_row(signature, outcome)),
                    ),
                ),
            ]));
        }
        let oracle_row = Json::object([
            ("kind", Json::string("ORACLE")),
            ("oracle", address_json(plan.oracle)),
            (
                "scalars",
                Json::object(
                    oracle_signatures
                        .iter()
                        .zip(&oracle_scalars)
                        .map(|(signature, outcome)| outcome_row(signature, outcome)),
                ),
            ),
            (
                "assets",
                Json::array(plan.reserves.iter().enumerate().map(|(position, reserve)| {
                    Json::object([
                        ("asset", address_json(reserve.asset)),
                        ("source", address_field(&asset_outcomes[2 * position])),
                        ("price", uint_field(&asset_outcomes[2 * position + 1])),
                    ])
                })),
            ),
            ("sources", Json::Array(source_rows)),
        ]);

        let mut rows = vec![pool_row];
        rows.extend(reserve_rows);
        rows.extend(emode_rows);
        rows.push(oracle_row);
        Ok(Json::object([("rows", Json::Array(rows))]))
    })?;
    manifests.push(output.manifest_id().to_hex());
    let rows = output
        .result_json()?
        .get("rows")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("Aave state job without rows".into()))?
        .to_vec();
    let parameters = Json::object([
        ("pool", address_json(plan.pool)),
        (
            "pool_implementation",
            address_json(plan.pool_implementation),
        ),
        ("addresses_provider", address_json(plan.addresses_provider)),
        ("oracle", address_json(plan.oracle)),
        ("anchor", Json::uint(plan.anchor.number)),
        ("anchor_block", anchor_record(&anchor)),
        ("chain_domain", chain_json(&chain)),
        ("reserves", reserves_json),
        (
            "gas_bound",
            Json::uint(untrusted_call().gas_limit().unwrap_or(0)),
        ),
    ]);
    Ok((
        record("AAVE_STATE", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}
