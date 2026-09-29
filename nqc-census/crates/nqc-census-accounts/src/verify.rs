//! Offline verification of the RMC-009 account universe.
//!
//! Inputs are replayed stages only. Two providers must agree on every token
//! supply and every account row (any difference fails closed). Then, per
//! token, the indexed scaled balances must sum exactly to
//! `scaledTotalSupply()`: that identity is what proves no holder is missing.

use crate::candidates::{Candidates, IndexFacts};
use crate::plan::{AccountPlan, TokenKind};
use crate::stage::number;
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::Address;
use nqc_census_state::aave_config::UserConfiguration;
use nqc_census_state::model::{Mismatch, MismatchLedger};
use nqc_census_state::stage::outcome_parts;
use nqc_census_state::uint::{wad, U256};
use nqc_census_state::v2_verify::ReplayedStage;
use std::collections::{BTreeMap, BTreeSet};

pub struct VerifyInputs<'a> {
    pub plan: &'a AccountPlan,
    pub candidates: &'a Candidates,
    pub index: &'a IndexFacts,
    pub tokens: Vec<ReplayedStage>,
    pub state: Vec<ReplayedStage>,
}

#[derive(Debug, Clone)]
pub struct AccountOutcome {
    pub accounts: Vec<Json>,
    pub conservation: Vec<Json>,
    pub divergences: Vec<Json>,
    pub reserves: Vec<Json>,
    pub mismatches: MismatchLedger,
    /// Blocking findings that are not a disagreement between two views
    /// (for example stable debt the universe does not cover).
    pub findings: Vec<String>,
    pub metrics: Json,
    pub anchor_timestamp: u64,
    pub conserved: bool,
}

fn decimal(field: &Json) -> Option<U256> {
    field
        .as_str()
        .and_then(|text| U256::parse_decimal(text).ok())
}

fn describe(field: &Json) -> String {
    field
        .canonical_string()
        .unwrap_or_else(|_| "<unprintable>".into())
}

/// Rows of the single stage each provider ran; all providers must return
/// identical rows.
fn agreed_single(stages: &[ReplayedStage], what: &str) -> Result<Vec<Json>, ChainError> {
    let mut by_provider: BTreeMap<&str, &ReplayedStage> = BTreeMap::new();
    for stage in stages {
        if by_provider.insert(stage.provider.as_str(), stage).is_some() {
            return Err(ChainError::Evidence(format!(
                "{what} stage repeated for provider {}",
                stage.provider
            )));
        }
    }
    if by_provider.len() < 2 {
        return Err(ChainError::Evidence(format!("{what} needs two providers")));
    }
    let mut views = by_provider.into_iter();
    let (reference_provider, reference) = views
        .next()
        .ok_or_else(|| ChainError::Evidence(format!("{what} has no stage")))?;
    for (provider, stage) in views {
        if stage.rows.len() != reference.rows.len()
            || !Json::Array(stage.rows.clone()).same_as(&Json::Array(reference.rows.clone()))?
        {
            return Err(ChainError::Evidence(format!(
                "providers {reference_provider} and {provider} disagree on {what}: fail closed"
            )));
        }
    }
    Ok(reference.rows.clone())
}

/// Rows of every state partition, per provider concatenated in partition
/// order; providers must agree row for row, and the rows must be exactly
/// the candidate accounts and their candidate tokens.
fn agreed_state(
    stages: &[ReplayedStage],
    plan: &AccountPlan,
    candidates: &Candidates,
) -> Result<Vec<Json>, ChainError> {
    let digest = candidates.digest();
    let mut by_provider: BTreeMap<&str, BTreeMap<u64, &ReplayedStage>> = BTreeMap::new();
    for stage in stages {
        if stage.parameters.str_field("candidates_sha256")? != digest
            || stage.parameters.str_field("tokens_sha256")? != plan.tokens_digest()
            || number(&stage.parameters, "anchor")? != plan.anchor.number
        {
            return Err(ChainError::Evidence(
                "state stage was run for other candidates, tokens or anchor".into(),
            ));
        }
        if by_provider
            .entry(stage.provider.as_str())
            .or_default()
            .insert(number(&stage.parameters, "partition")?, stage)
            .is_some()
        {
            return Err(ChainError::Evidence("duplicate state partition".into()));
        }
    }
    if by_provider.len() < 2 {
        return Err(ChainError::Evidence(
            "account state needs two providers".into(),
        ));
    }
    let mut views = Vec::new();
    for (provider, partitions) in &by_provider {
        let counts: BTreeSet<u64> = partitions
            .values()
            .map(|stage| number(&stage.parameters, "partitions"))
            .collect::<Result<_, _>>()?;
        let count = counts.iter().next().copied().unwrap_or(0);
        if counts.len() != 1 || count == 0 || partitions.keys().copied().ne(0..count) {
            return Err(ChainError::Evidence(format!(
                "state partitions of {provider} are not exactly 0..P"
            )));
        }
        let rows: Vec<&Json> = partitions
            .values()
            .flat_map(|stage| stage.rows.iter())
            .collect();
        views.push((*provider, rows));
    }
    let (reference_provider, reference) = &views[0];
    for (provider, rows) in &views[1..] {
        if rows.len() != reference.len() {
            return Err(ChainError::Evidence(format!(
                "providers {reference_provider} and {provider} read different account counts"
            )));
        }
        for (left, right) in reference.iter().zip(rows) {
            if !left.same_as(right)? {
                return Err(ChainError::Evidence(format!(
                    "providers {reference_provider} and {provider} disagree on account {}: fail closed",
                    left.str_field("account").unwrap_or("?")
                )));
            }
        }
    }
    if reference.len() != candidates.accounts.len() {
        return Err(ChainError::Evidence(
            "state rows do not cover the candidate accounts".into(),
        ));
    }
    for (row, (account, tokens)) in reference.iter().zip(&candidates.accounts) {
        if Address::parse_hex(row.str_field("account")?)? != *account {
            return Err(ChainError::Evidence(
                "state rows are not in candidate order".into(),
            ));
        }
        let read: Vec<Address> = row
            .get("positions")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("account row without positions".into()))?
            .iter()
            .map(|position| Ok(Address::parse_hex(position.str_field("token")?)?))
            .collect::<Result<_, ChainError>>()?;
        if read != *tokens {
            return Err(ChainError::Evidence(format!(
                "account {} was read on other tokens than its candidates",
                account.to_hex()
            )));
        }
    }
    Ok(reference.iter().map(|row| (*row).clone()).collect())
}

fn anchor_timestamp(stages: &[ReplayedStage]) -> Result<u64, ChainError> {
    let mut timestamps = BTreeSet::new();
    for stage in stages {
        timestamps.insert(number(
            stage
                .parameters
                .get("anchor_block")
                .ok_or_else(|| ChainError::Evidence("token stage without anchor".into()))?,
            "timestamp",
        )?);
    }
    match timestamps.len() {
        1 => Ok(timestamps.into_iter().next().unwrap_or(0)),
        _ => Err(ChainError::Evidence(
            "token stages disagree on the anchor timestamp".into(),
        )),
    }
}

struct Supply {
    total: Option<U256>,
    sum: U256,
    holders: u64,
}

pub fn verify_accounts(inputs: VerifyInputs<'_>) -> Result<AccountOutcome, ChainError> {
    let plan = inputs.plan;
    let mut mismatches = MismatchLedger::default();
    let mut findings = Vec::new();
    if inputs.index.zero_account_logs != 0 {
        findings.push(format!(
            "ZERO_ADDRESS_RECEIVED_TOKENS logs={}",
            inputs.index.zero_account_logs
        ));
    }
    let anchor_timestamp = anchor_timestamp(&inputs.tokens)?;
    let token_rows = agreed_single(&inputs.tokens, "token supply")?;
    if token_rows.len() != plan.reserves.len() {
        return Err(ChainError::Evidence(
            "token supply rows do not match the reserve plan".into(),
        ));
    }
    let tokens = plan.tokens();
    let mut supplies: BTreeMap<Address, Supply> = BTreeMap::new();
    let mut reserves = Vec::new();
    for (reserve, row) in plan.reserves.iter().zip(&token_rows) {
        let unit = format!("reserve:{}", reserve.asset.to_hex());
        if Address::parse_hex(row.str_field("asset")?)? != reserve.asset {
            return Err(ChainError::Evidence(
                "token supply rows are not in plan order".into(),
            ));
        }
        if reserve.reserve_id.is_some() {
            let data = row
                .get("reserve_data")
                .ok_or_else(|| ChainError::Evidence("reserve data missing".into()))?;
            let (returned, bytes) = outcome_parts(data)?;
            let word = |index: usize| -> Option<[u8; 32]> {
                let slice = bytes.get(32 * index..32 * index + 32)?;
                let mut buffer = [0_u8; 32];
                buffer.copy_from_slice(slice);
                Some(buffer)
            };
            let address_at = |index: usize| {
                word(index).map(|word| {
                    let mut raw = [0_u8; 20];
                    raw.copy_from_slice(&word[12..]);
                    Address::new(raw)
                        .map(|address| address.to_hex())
                        .unwrap_or_else(|_| "0x0".into())
                })
            };
            let observed = if returned && bytes.len() >= 11 * 32 {
                format!(
                    "{}/{}/{}",
                    address_at(8).unwrap_or_default(),
                    address_at(9).unwrap_or_default(),
                    address_at(10).unwrap_or_default()
                )
            } else {
                "UNREADABLE".into()
            };
            let expected = format!(
                "{}/{}/{}",
                reserve.a_token.to_hex(),
                reserve
                    .stable_debt_token
                    .map_or_else(|| "0x0".into(), |token| token.to_hex()),
                reserve.variable_debt_token.to_hex()
            );
            mismatches.check(&unit, "RESERVE_TOKEN_ADDRESSES", expected, observed);
        }
        for (token, key) in [
            (reserve.a_token, "a_token_scaled_total_supply"),
            (
                reserve.variable_debt_token,
                "variable_debt_scaled_total_supply",
            ),
        ] {
            let field = row
                .get(key)
                .ok_or_else(|| ChainError::Evidence(format!("{key} missing")))?;
            let total = decimal(field);
            if total.is_none() {
                mismatches.check(
                    &unit,
                    "TOKEN_SCALED_TOTAL_SUPPLY",
                    "uint256",
                    describe(field),
                );
            }
            supplies.insert(
                token,
                Supply {
                    total,
                    sum: U256::ZERO,
                    holders: 0,
                },
            );
        }
        let stable = row.get("stable_debt_total_supply").unwrap_or(&Json::Null);
        if reserve.stable_debt_token.is_some() {
            match decimal(stable) {
                Some(value) if value.is_zero() => {}
                Some(value) => findings.push(format!(
                    "STABLE_DEBT_POSITIONS_PRESENT asset={} total={}",
                    reserve.asset.to_hex(),
                    value.to_decimal()
                )),
                None => {
                    mismatches.check(
                        &unit,
                        "STABLE_DEBT_TOTAL_SUPPLY",
                        "uint256",
                        describe(stable),
                    );
                }
            }
        }
        reserves.push(Json::object([
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
            ("initialized_block", Json::uint(reserve.initialized_block)),
            (
                "a_token_scaled_total_supply",
                row.get("a_token_scaled_total_supply")
                    .cloned()
                    .unwrap_or(Json::Null),
            ),
            (
                "variable_debt_scaled_total_supply",
                row.get("variable_debt_scaled_total_supply")
                    .cloned()
                    .unwrap_or(Json::Null),
            ),
            ("stable_debt_total_supply", stable.clone()),
        ]));
    }

    let rows = agreed_state(&inputs.state, plan, inputs.candidates)?;
    let current: BTreeMap<u16, usize> = plan
        .reserves
        .iter()
        .enumerate()
        .filter_map(|(index, reserve)| reserve.reserve_id.map(|id| (id, index)))
        .collect();
    let health_one = wad();
    let mut accounts = Vec::with_capacity(rows.len());
    let mut divergences = Vec::new();
    let mut mismatched_accounts = BTreeSet::new();
    let (mut holders, mut extra, mut borrowers) = (0_u64, 0_u64, 0_u64);
    let (mut supply_positions, mut debt_positions) = (0_u64, 0_u64);
    let (mut below_one, mut data_unavailable) = (0_u64, 0_u64);
    for row in &rows {
        let account = row.str_field("account")?.to_owned();
        let unit = format!("account:{account}");
        let before = mismatches.len();
        let mut supplied: BTreeSet<usize> = BTreeSet::new();
        let mut owed: BTreeSet<usize> = BTreeSet::new();
        let mut supply_rows = Vec::new();
        let mut debt_rows = Vec::new();
        for position in row
            .get("positions")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("account row without positions".into()))?
        {
            let token = Address::parse_hex(position.str_field("token")?)?;
            let reference = tokens
                .get(&token)
                .ok_or_else(|| ChainError::Evidence("position on an undeclared token".into()))?;
            let scaled_field = position
                .get("scaled")
                .ok_or_else(|| ChainError::Evidence("position without scaled".into()))?;
            let balance_field = position
                .get("balance")
                .ok_or_else(|| ChainError::Evidence("position without balance".into()))?;
            let Some(scaled) = decimal(scaled_field) else {
                mismatches.check(&unit, "SCALED_BALANCE", "uint256", describe(scaled_field));
                continue;
            };
            if decimal(balance_field).is_none() {
                mismatches.check(&unit, "BALANCE", "uint256", describe(balance_field));
            }
            if scaled.is_zero() {
                continue;
            }
            let supply = supplies
                .get_mut(&token)
                .ok_or_else(|| ChainError::Evidence("token supply missing".into()))?;
            match supply.sum.checked_add(scaled) {
                Ok(sum) => supply.sum = sum,
                Err(_) => {
                    mismatches.check(&unit, "SCALED_BALANCE_SUM", "no overflow", "overflow");
                }
            }
            supply.holders += 1;
            let reserve = &plan.reserves[reference.reserve];
            let entry = Json::object([
                ("asset", Json::string(reserve.asset.to_hex())),
                ("market_id", Json::string(reserve.market_id.clone())),
                ("token", Json::string(token.to_hex())),
                ("scaled", scaled_field.clone()),
                ("balance", balance_field.clone()),
            ]);
            match reference.kind {
                TokenKind::AToken => {
                    supplied.insert(reference.reserve);
                    supply_rows.push(entry);
                }
                TokenKind::VariableDebt => {
                    owed.insert(reference.reserve);
                    debt_rows.push(entry);
                }
            }
        }
        let config_field = row.get("configuration").unwrap_or(&Json::Null);
        let configuration = decimal(config_field);
        if configuration.is_none() {
            mismatches.check(
                &unit,
                "USER_CONFIGURATION",
                "uint256",
                describe(config_field),
            );
        }
        let configuration = UserConfiguration(configuration.unwrap_or(U256::ZERO));
        let mut codes = Vec::new();
        for id in 0..128_u16 {
            let (borrowing, collateral) =
                (configuration.borrowing(id), configuration.collateral(id));
            match current.get(&id) {
                None if borrowing || collateral => {
                    mismatches.check(
                        &unit,
                        "CONFIGURATION_BIT_FOR_UNKNOWN_RESERVE",
                        "no bit",
                        format!("reserve id {id}"),
                    );
                }
                None => {}
                Some(reserve) => {
                    let debt = owed.contains(reserve);
                    let supply = supplied.contains(reserve);
                    let mut note = |code: &str| {
                        codes.push(Json::string(format!("{code}:{id}")));
                        divergences.push(Json::object([
                            ("account", Json::string(account.clone())),
                            ("reserve_id", Json::uint(u64::from(id))),
                            (
                                "asset",
                                Json::string(plan.reserves[*reserve].asset.to_hex()),
                            ),
                            ("code", Json::string(code)),
                        ]));
                    };
                    if borrowing && !debt {
                        note("BORROWING_FLAG_WITHOUT_DEBT");
                    }
                    if debt && !borrowing {
                        note("DEBT_WITHOUT_BORROWING_FLAG");
                    }
                    if collateral && !supply {
                        note("COLLATERAL_FLAG_WITHOUT_SUPPLY");
                    }
                }
            }
        }
        let holder = !supplied.is_empty() || !owed.is_empty();
        let classification = if holder {
            holders += 1;
            "POSITION_HOLDER"
        } else if configuration.is_empty() {
            extra += 1;
            "NO_POSITION_AT_ANCHOR"
        } else {
            "CONFIGURATION_WITHOUT_POSITION"
        };
        supply_positions += supply_rows.len() as u64;
        debt_positions += debt_rows.len() as u64;
        let account_data = row.get("account_data").cloned().unwrap_or(Json::Null);
        let health_factor = account_data
            .as_array()
            .and_then(|items| items.get(5))
            .and_then(decimal);
        let below = if !owed.is_empty() {
            borrowers += 1;
            match health_factor {
                Some(value) => {
                    let crossed = value.checked_sub(health_one).is_err();
                    below_one += u64::from(crossed);
                    Json::Bool(crossed)
                }
                None => {
                    data_unavailable += 1;
                    Json::Null
                }
            }
        } else {
            Json::Null
        };
        if mismatches.len() != before {
            mismatched_accounts.insert(account.clone());
        }
        accounts.push(Json::object([
            ("account", Json::string(account)),
            ("classification", Json::string(classification)),
            ("supply_positions", Json::Array(supply_rows)),
            ("debt_positions", Json::Array(debt_rows)),
            ("configuration", config_field.clone()),
            ("emode", row.get("emode").cloned().unwrap_or(Json::Null)),
            ("account_data", account_data),
            ("health_factor_below_one", below),
            ("configuration_divergences", Json::Array(codes)),
        ]));
    }

    let mut conservation = Vec::new();
    let mut conserved = true;
    let (mut missing_tokens, mut excess_tokens) = (0_u64, 0_u64);
    for reserve in &plan.reserves {
        for (token, kind) in [
            (reserve.a_token, TokenKind::AToken),
            (reserve.variable_debt_token, TokenKind::VariableDebt),
        ] {
            let supply = supplies
                .get(&token)
                .ok_or_else(|| ChainError::Evidence("token supply missing".into()))?;
            let status = match supply.total {
                None => {
                    conserved = false;
                    "TOTAL_UNREADABLE"
                }
                Some(total) if total == supply.sum => "CONSERVED",
                Some(total) => {
                    conserved = false;
                    let status = if supply.sum.checked_sub(total).is_err() {
                        missing_tokens += 1;
                        "MISSING_HOLDERS"
                    } else {
                        excess_tokens += 1;
                        "EXCESS_OVER_SUPPLY"
                    };
                    mismatches.push(Mismatch {
                        unit: format!("token:{}", token.to_hex()),
                        dimension: format!("SCALED_SUPPLY_CONSERVATION_{status}"),
                        expected: total.to_decimal(),
                        observed: supply.sum.to_decimal(),
                        explanation: None,
                    });
                    status
                }
            };
            conservation.push(Json::object([
                ("token", Json::string(token.to_hex())),
                ("kind", Json::string(kind.code())),
                ("asset", Json::string(reserve.asset.to_hex())),
                ("market_id", Json::string(reserve.market_id.clone())),
                (
                    "scaled_total_supply",
                    supply
                        .total
                        .map_or(Json::Null, |total| Json::string(total.to_decimal())),
                ),
                ("indexed_scaled_sum", Json::string(supply.sum.to_decimal())),
                ("holders", Json::uint(supply.holders)),
                ("status", Json::string(status)),
            ]));
        }
    }
    let stale = inputs
        .state
        .iter()
        .chain(&inputs.tokens)
        .filter(|stage| number(&stage.parameters, "anchor").ok() != Some(plan.anchor.number))
        .count();
    let metrics = Json::object([
        (
            "indexed_accounts",
            Json::uint(inputs.candidates.accounts.len() as u64),
        ),
        (
            "indexed_pairs",
            Json::uint(inputs.candidates.pair_count() as u64),
        ),
        ("state_verified_accounts", Json::uint(rows.len() as u64)),
        (
            "stale_accounts",
            Json::uint(if stale == 0 { 0 } else { rows.len() as u64 }),
        ),
        ("missing_holder_tokens", Json::uint(missing_tokens)),
        ("excess_supply_tokens", Json::uint(excess_tokens)),
        ("extra_accounts", Json::uint(extra)),
        (
            "mismatched_accounts",
            Json::uint(mismatched_accounts.len() as u64),
        ),
        ("actionable_accounts", Json::uint(borrowers)),
        ("position_holders", Json::uint(holders)),
        ("supply_positions", Json::uint(supply_positions)),
        ("debt_positions", Json::uint(debt_positions)),
        ("health_factor_below_one", Json::uint(below_one)),
        (
            "borrower_account_data_unavailable",
            Json::uint(data_unavailable),
        ),
        (
            "configuration_divergences",
            Json::uint(divergences.len() as u64),
        ),
        ("tokens", Json::uint(conservation.len() as u64)),
        (
            "conserved_tokens",
            Json::uint(
                conservation
                    .iter()
                    .filter(|row| row.get("status").and_then(Json::as_str) == Some("CONSERVED"))
                    .count() as u64,
            ),
        ),
    ]);
    Ok(AccountOutcome {
        accounts,
        conservation,
        divergences,
        reserves,
        mismatches,
        findings,
        metrics,
        anchor_timestamp,
        conserved,
    })
}
