//! Offline verification of RMC-008 Aave V3 state.
//!
//! Works only on replayed `AAVE_STATE` rows; both providers must return
//! byte-identical rows. For every admitted current reserve the verifier
//! reconciles, integer-exactly:
//!
//! - `getConfiguration` against the configuration word of `getReserveData`;
//! - the reserve id against the D06 admitted id;
//! - configuration decimals against the underlying, aToken and debt token;
//! - aToken / debt-token `UNDERLYING_ASSET_ADDRESS` and `POOL`;
//! - `getReserveNormalizedIncome` / `...VariableDebt` against their
//!   recomputation from stored indexes, rates and the anchor timestamp;
//! - aToken `totalSupply` = `rayMul`-floor(scaled, income) and debt-token
//!   `totalSupply` = `rayMul`-ceil(scaled, debt index) (PFT-COMPAT-008);
//! - the oracle price path: `getAssetPrice` equals the source's
//!   `latestAnswer` when the source is set and answers a positive value.
//!
//! Oracle freshness is recorded (update time and age when the source exposes
//! them); Aave V3 does not enforce staleness, so none is assumed.

use crate::aave_config::ReserveConfiguration;
use crate::aave_math::{normalized_income, ray_mul_ceil, ray_mul_floor};
use crate::model::{
    Decimals, MismatchLedger, ProxyFact, RuntimeIdentity, StateAdmission, TokenAdmission,
    TokenBehavior, Tri,
};
use crate::stage::outcome_parts;
use crate::uint::U256;
use crate::v2_verify::ReplayedStage;
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::{
    Address, CanonicalMarketKey, CensusStage, CensusUnitId, CensusUnitKind, DeploymentKey,
    EvidenceBasis, EvidenceRef, Hash32, RejectionReason, StageDecision, StageDomain, StageEvidence,
    StageLedger, StageRecord,
};
use std::collections::{BTreeMap, BTreeSet};

/// A reserve admitted by D06, current or historical.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdmittedReserve {
    pub asset: Address,
    pub market_id: String,
    /// `None` for a dropped (historical) reserve.
    pub reserve_id: Option<u16>,
}

pub struct AaveInputs<'a> {
    pub deployment: DeploymentKey,
    pub pool: Address,
    pub reserves: &'a [AdmittedReserve],
    pub anchor_timestamp: u64,
    pub stages: Vec<ReplayedStage>,
}

pub struct AaveOutcome {
    pub state_rows: Vec<Json>,
    pub oracle_rows: Vec<Json>,
    pub emode_rows: Vec<Json>,
    pub tokens: Vec<TokenAdmission>,
    pub mismatches: MismatchLedger,
    pub ledger: StageLedger,
    pub domain: StageDomain,
    pub pool_facts: Json,
}

fn text<'a>(value: &'a Json, key: &str) -> Result<&'a str, ChainError> {
    value.str_field(key)
}

fn getter(row: &Json, signature: &str) -> Result<Option<(bool, Vec<u8>)>, ChainError> {
    match row
        .get("getters")
        .and_then(|getters| getters.get(signature))
    {
        Some(outcome) => Ok(Some(outcome_parts(outcome)?)),
        None => Ok(None),
    }
}

fn scalar(row: &Json, signature: &str) -> Result<Option<(bool, Vec<u8>)>, ChainError> {
    match row
        .get("scalars")
        .and_then(|scalars| scalars.get(signature))
    {
        Some(outcome) => Ok(Some(outcome_parts(outcome)?)),
        None => Ok(None),
    }
}

fn word(bytes: &[u8], index: usize) -> Option<U256> {
    let slice = bytes.get(32 * index..32 * (index + 1))?;
    let mut out = [0u8; 32];
    out.copy_from_slice(slice);
    Some(U256::from_word(&out))
}

fn one_word(outcome: Option<(bool, Vec<u8>)>) -> Option<U256> {
    match outcome {
        Some((true, bytes)) if bytes.len() == 32 => word(&bytes, 0),
        _ => None,
    }
}

fn field_value(value: Option<&Json>) -> Option<U256> {
    match value {
        Some(Json::String(text)) => U256::parse_decimal(text).ok(),
        _ => None,
    }
}

fn field_address(value: Option<&Json>) -> Option<Address> {
    match value {
        Some(Json::String(text)) => Address::parse_hex(text).ok(),
        _ => None,
    }
}

fn decimals_of(value: Option<&Json>) -> Decimals {
    match value {
        Some(Json::Number(_)) => value
            .and_then(Json::as_i64)
            .and_then(|value| u8::try_from(value).ok())
            .map_or(Decimals::NonCanonical, Decimals::Value),
        Some(Json::Object(_)) => match value.and_then(|v| v.get("status")).and_then(Json::as_str) {
            Some("REVERTED") => Decimals::Reverted,
            Some("HALTED") => Decimals::Halted,
            Some("EMPTY") => Decimals::Empty,
            _ => Decimals::NonCanonical,
        },
        _ => Decimals::NonCanonical,
    }
}

fn show(value: Option<U256>) -> String {
    value.map_or_else(|| "UNAVAILABLE".into(), |value| value.to_decimal())
}

fn artifact(id: &str) -> Result<EvidenceRef, ChainError> {
    Ok(EvidenceRef::Artifact(Hash32::parse_hex(&format!(
        "0x{}",
        id.trim_start_matches("0x")
    ))?))
}

fn record(
    ledger: &mut StageLedger,
    domain: &StageDomain,
    unit: CensusUnitId,
    stage: CensusStage,
    decision: StageDecision,
    refs: &[EvidenceRef],
) -> Result<(), ChainError> {
    let evidence = StageEvidence::new(stage, EvidenceBasis::Proven, decision, refs.to_vec())
        .map_err(|error| ChainError::Evidence(format!("{error:?}")))?;
    ledger
        .record(StageRecord::new(domain.clone(), unit, evidence))
        .map_err(|error| ChainError::Evidence(format!("{error:?}")))
}

fn decision_code(decision: &StageDecision) -> String {
    match decision {
        StageDecision::Advance => "ADVANCE".into(),
        StageDecision::Reject(reason) => format!("REJECT:{}", reason.code()),
        StageDecision::Unknown { .. } => "UNKNOWN".into(),
    }
}

fn code_sha(row: &Json, account: Address) -> Option<(String, u64)> {
    row.get("codes")?.as_array()?.iter().find_map(|code| {
        (code.str_field("account").ok()? == account.to_hex()).then(|| {
            (
                code.str_field("sha256").unwrap_or_default().to_owned(),
                code.get("size")
                    .and_then(Json::as_i64)
                    .and_then(|size| u64::try_from(size).ok())
                    .unwrap_or(0),
            )
        })
    })
}

fn proxy_fact(row: &Json, prefix: &str) -> ProxyFact {
    let slot = |name: &str| {
        row.get("proxy_slots")
            .and_then(|slots| slots.get(&format!("{prefix}_{name}")))
            .and_then(|value| field_address(Some(value)))
    };
    if let Some(implementation) = slot("eip1967_implementation") {
        ProxyFact::Eip1967 {
            implementation,
            implementation_sha256: code_sha(row, implementation).map(|(sha, _)| sha),
        }
    } else if let Some(beacon) = slot("eip1967_beacon") {
        ProxyFact::Eip1967Beacon { beacon }
    } else if let Some(implementation) = slot("zeppelinos_implementation") {
        ProxyFact::ZeppelinOs { implementation }
    } else if prefix == "underlying" {
        ProxyFact::NoStandardSlot
    } else {
        ProxyFact::NotRead
    }
}

fn runtime(row: &Json, account: Address) -> RuntimeIdentity {
    match code_sha(row, account) {
        Some((_, 0)) => RuntimeIdentity::Absent,
        Some((sha256, size)) => RuntimeIdentity::Code { sha256, size },
        None => RuntimeIdentity::PresenceByCall,
    }
}

fn agree(stages: &[ReplayedStage]) -> Result<&ReplayedStage, ChainError> {
    let providers: BTreeSet<&str> = stages.iter().map(|stage| stage.provider.as_str()).collect();
    if providers.len() < 2 || providers.len() != stages.len() {
        return Err(ChainError::Consensus(
            "Aave state requires one stage from each of at least two providers",
        ));
    }
    let first = &stages[0];
    for other in &stages[1..] {
        if other.rows.len() != first.rows.len() {
            return Err(ChainError::Consensus(
                "providers returned different Aave rows",
            ));
        }
        for (left, right) in first.rows.iter().zip(&other.rows) {
            if !left.same_as(right)? {
                return Err(ChainError::Consensus(
                    "providers returned different Aave state",
                ));
            }
        }
    }
    Ok(first)
}

#[allow(clippy::too_many_lines)]
pub fn verify_aave(inputs: &AaveInputs<'_>) -> Result<AaveOutcome, ChainError> {
    let stage = agree(&inputs.stages)?;
    let refs: Vec<EvidenceRef> = inputs
        .stages
        .iter()
        .flat_map(|stage| stage.manifests.iter())
        .map(|id| artifact(id))
        .collect::<Result<_, _>>()?;
    let rows_of = |kind: &str| -> Vec<&Json> {
        stage
            .rows
            .iter()
            .filter(|row| row.get("kind").and_then(Json::as_str) == Some(kind))
            .collect()
    };
    let pool_row = *rows_of("POOL")
        .first()
        .ok_or_else(|| ChainError::Evidence("Aave stage without POOL row".into()))?;
    let oracle_row = *rows_of("ORACLE")
        .first()
        .ok_or_else(|| ChainError::Evidence("Aave stage without ORACLE row".into()))?;
    let reserve_rows: BTreeMap<Address, &Json> = rows_of("RESERVE")
        .into_iter()
        .map(|row| Ok((Address::parse_hex(text(row, "asset")?)?, row)))
        .collect::<Result<_, ChainError>>()?;
    let mut mismatches = MismatchLedger::default();

    // The live reserve list must be exactly D06's current set, in id order.
    let listed = scalar(pool_row, "getReservesList()")?
        .filter(|(ok, _)| *ok)
        .ok_or_else(|| ChainError::Evidence("getReservesList unavailable".into()))?
        .1;
    let listed_words = nqc_census_chain::abi::decode_address_array(&listed)?;
    let listed: Vec<String> = listed_words
        .iter()
        .map(|raw| {
            raw.map_or_else(
                || "ZERO".into(),
                |raw| Address::new(raw).map_or_else(|_| "ZERO".into(), |address| address.to_hex()),
            )
        })
        .collect();
    let mut current: Vec<&AdmittedReserve> = inputs
        .reserves
        .iter()
        .filter(|reserve| reserve.reserve_id.is_some())
        .collect();
    current.sort_by_key(|reserve| reserve.reserve_id);
    let admitted: Vec<String> = current
        .iter()
        .map(|reserve| reserve.asset.to_hex())
        .collect();
    mismatches.check(
        "AAVE_POOL",
        "RESERVE_LIST_EQUALS_D06_CURRENT",
        admitted.join(","),
        listed.join(","),
    );

    let base_unit = one_word(scalar(oracle_row, "BASE_CURRENCY_UNIT()")?);
    let base_currency = scalar(oracle_row, "BASE_CURRENCY()")?
        .and_then(|(ok, bytes)| ok.then(|| crate::v2_math::address_word(&bytes)).flatten())
        .flatten();
    let oracle_assets: BTreeMap<String, &Json> = oracle_row
        .get("assets")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("oracle assets missing".into()))?
        .iter()
        .map(|asset| Ok((text(asset, "asset")?.to_owned(), asset)))
        .collect::<Result<_, ChainError>>()?;
    let sources: BTreeMap<String, &Json> = oracle_row
        .get("sources")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("oracle sources missing".into()))?
        .iter()
        .map(|source| Ok((text(source, "source")?.to_owned(), source)))
        .collect::<Result<_, ChainError>>()?;

    let domain = StageDomain::new(
        inputs.deployment.chain().clone(),
        inputs.deployment.protocol(),
        CensusUnitKind::Market,
    );
    let mut ledger = StageLedger::default();
    let mut state_rows = Vec::new();
    let mut oracle_rows = Vec::new();
    let mut tokens: BTreeMap<Address, TokenAdmission> = BTreeMap::new();
    let now = inputs.anchor_timestamp;

    for reserve in inputs.reserves {
        let unit_label = format!("AAVE_RESERVE:{}", reserve.asset.to_hex());
        let key = CanonicalMarketKey::aave_reserve(inputs.deployment.clone(), reserve.asset)?;
        let market_id = key.id()?;
        mismatches.check(
            &unit_label,
            "D01_MARKET_ID",
            &reserve.market_id,
            market_id.to_hex(),
        );
        let unit = CensusUnitId::from_market(market_id);
        let Some(reserve_id) = reserve.reserve_id else {
            // Historical reserve, preserved by D06: no active state to read.
            record(
                &mut ledger,
                &domain,
                unit,
                CensusStage::MarketsStateReconstructable,
                StageDecision::Reject(RejectionReason::NoActiveState),
                &refs,
            )?;
            state_rows.push(Json::object([
                ("schema_version", Json::uint(1)),
                ("protocol", Json::string("AAVE_V3")),
                ("market_id", Json::string(market_id.to_hex())),
                ("asset", Json::string(reserve.asset.to_hex())),
                ("lifecycle", Json::string("DROPPED_HISTORICAL")),
                (
                    "stage_state_reconstructable",
                    Json::string("REJECT:NO_ACTIVE_STATE"),
                ),
            ]));
            continue;
        };
        let row = *reserve_rows.get(&reserve.asset).ok_or_else(|| {
            ChainError::Evidence(format!("no state row for {}", reserve.asset.to_hex()))
        })?;
        let data = getter(row, "getReserveData(address)")?
            .filter(|(ok, _)| *ok)
            .map(|(_, bytes)| bytes)
            .ok_or_else(|| ChainError::Evidence("getReserveData missing".into()))?;
        let words = data.len() / 32;
        let w = |index: usize| word(&data, index);
        let configuration_word = w(0).unwrap_or(U256::ZERO);
        let configuration = ReserveConfiguration::decode(configuration_word);
        let liquidity_index = w(1);
        let liquidity_rate = w(2);
        let variable_index = w(3);
        let variable_rate = w(4);
        let stable_rate = w(5);
        let last_update = w(6).and_then(U256::to_u64);
        let observed_id = w(7).and_then(U256::to_u64);
        let accrued_to_treasury = if words >= 13 { w(12) } else { None };
        let unbacked = if words >= 14 { w(13) } else { None };
        let isolation_debt = if words >= 15 { w(14) } else { None };
        mismatches.check(
            &unit_label,
            "GET_CONFIGURATION_EQUALS_RESERVE_DATA",
            configuration_word.to_decimal(),
            show(one_word(getter(row, "getConfiguration(address)")?)),
        );
        mismatches.check(
            &unit_label,
            "RESERVE_ID",
            reserve_id,
            observed_id.map_or(-1, |id| id as i64),
        );
        let unknown_bits = configuration.unused_high_bits != 0;

        let a_token = Address::parse_hex(text(row, "a_token")?)?;
        let variable_token = Address::parse_hex(text(row, "variable_debt_token")?)?;
        let a = row
            .get("a_token_facts")
            .ok_or_else(|| ChainError::Evidence("a facts".into()))?;
        let v = row
            .get("variable_debt_facts")
            .ok_or_else(|| ChainError::Evidence("v facts".into()))?;
        let u = row
            .get("underlying_facts")
            .ok_or_else(|| ChainError::Evidence("u facts".into()))?;
        let underlying_decimals = decimals_of(u.get("decimals"));
        let a_decimals = decimals_of(a.get("decimals"));
        let v_decimals = decimals_of(v.get("decimals"));
        for (label, decimals) in [
            ("UNDERLYING_DECIMALS", underlying_decimals),
            ("ATOKEN_DECIMALS", a_decimals),
            ("VARIABLE_DEBT_DECIMALS", v_decimals),
        ] {
            mismatches.check(
                &unit_label,
                label,
                configuration.decimals,
                decimals.value().map_or(-1, i64::from),
            );
        }
        for (label, facts) in [("ATOKEN", a), ("VARIABLE_DEBT", v)] {
            mismatches.check(
                &unit_label,
                &format!("{label}_UNDERLYING"),
                reserve.asset.to_hex(),
                field_address(facts.get("underlying"))
                    .map_or_else(|| "UNAVAILABLE".into(), |a| a.to_hex()),
            );
            mismatches.check(
                &unit_label,
                &format!("{label}_POOL"),
                inputs.pool.to_hex(),
                field_address(facts.get("pool"))
                    .map_or_else(|| "UNAVAILABLE".into(), |a| a.to_hex()),
            );
        }

        let income = one_word(getter(row, "getReserveNormalizedIncome(address)")?);
        let debt_index = one_word(getter(row, "getReserveNormalizedVariableDebt(address)")?);
        let recomputed_income = match (liquidity_index, liquidity_rate, last_update) {
            (Some(index), Some(rate), Some(last)) => normalized_income(index, rate, last, now).ok(),
            _ => None,
        };
        mismatches.check(
            &unit_label,
            "NORMALIZED_INCOME_RECOMPUTED",
            show(recomputed_income),
            show(income),
        );
        // The normalized variable debt is taken from the protocol getter
        // only: the deployed compounding formula differs from the
        // PFT-recovered one, so no recomputation is claimed for it.
        let a_scaled = field_value(a.get("scaled_total_supply"));
        let a_total = field_value(a.get("total_supply"));
        let v_scaled = field_value(v.get("scaled_total_supply"));
        let v_total = field_value(v.get("total_supply"));
        let expected_a_total = match (a_scaled, income) {
            (Some(scaled), Some(income)) => ray_mul_floor(scaled, income).ok(),
            _ => None,
        };
        let expected_v_total = match (v_scaled, debt_index) {
            (Some(scaled), Some(index)) => ray_mul_ceil(scaled, index).ok(),
            _ => None,
        };
        mismatches.check(
            &unit_label,
            "ATOKEN_TOTAL_SUPPLY_RAYMUL_FLOOR",
            show(expected_a_total),
            show(a_total),
        );
        mismatches.check(
            &unit_label,
            "VARIABLE_DEBT_TOTAL_SUPPLY_RAYMUL_CEIL",
            show(expected_v_total),
            show(v_total),
        );
        let stable_total = field_value(row.get("stable_debt_total_supply"));

        let balance = field_value(u.get("balance_of_a_token"));
        let virtual_balance = one_word(getter(row, "getVirtualUnderlyingBalance(address)")?);
        let mut behavior = TokenBehavior::unproven();
        let mut balance_below_accounted = false;
        if let (Some(balance), Some(virtual_balance)) = (balance, virtual_balance) {
            if configuration.virtual_accounting_enabled {
                if balance < virtual_balance {
                    balance_below_accounted = true;
                    behavior.rebasing = Tri::Present;
                    behavior.signals.push((
                        "ATOKEN_HOLDER_BALANCE_BELOW_VIRTUAL_BALANCE".into(),
                        "true".into(),
                    ));
                } else {
                    behavior.signals.push((
                        "ATOKEN_HOLDER_BALANCE_MINUS_VIRTUAL_BALANCE".into(),
                        balance
                            .checked_sub(virtual_balance)
                            .map_or_else(|_| "0".into(), |d| d.to_decimal()),
                    ));
                }
            }
        }
        let proxy = proxy_fact(row, "underlying");
        behavior.upgradeable = proxy.upgradeable();

        // Oracle price path.
        let oracle_asset = oracle_assets
            .get(&reserve.asset.to_hex())
            .ok_or_else(|| ChainError::Evidence("oracle row for asset missing".into()))?;
        let price = field_value(oracle_asset.get("price"));
        let source = field_address(oracle_asset.get("source"));
        let source_row = source.and_then(|source| sources.get(&source.to_hex()).copied());
        let latest_answer =
            source_row.and_then(|row| one_word(getter(row, "latestAnswer()").ok().flatten()));
        let round = source_row.and_then(|row| {
            getter(row, "latestRoundData()")
                .ok()
                .flatten()
                .filter(|(ok, bytes)| *ok && bytes.len() == 160)
                .map(|(_, bytes)| bytes)
        });
        let updated_at = round
            .as_ref()
            .and_then(|bytes| word(bytes, 3))
            .and_then(U256::to_u64);
        let is_base = base_currency == Some(reserve.asset);
        let expected_price = if is_base {
            base_unit
        } else {
            // A negative int256 answer reads as a huge uint256 and is not
            // "positive"; Aave then falls back, which this census does not
            // assume.
            latest_answer.filter(|answer| !answer.is_zero() && !answer.bit(255))
        };
        let price_path = if is_base {
            "BASE_CURRENCY_UNIT"
        } else if source.is_none() {
            "FALLBACK_ORACLE_SOURCE_UNSET"
        } else if expected_price.is_some() {
            "SOURCE_LATEST_ANSWER"
        } else {
            "FALLBACK_ORACLE_NON_POSITIVE_ANSWER"
        };
        mismatches.check(
            &unit_label,
            "ORACLE_PRICE_PATH",
            show(expected_price),
            show(price),
        );
        oracle_rows.push(Json::object([
            ("schema_version", Json::uint(1)),
            ("market_id", Json::string(market_id.to_hex())),
            ("asset", Json::string(reserve.asset.to_hex())),
            ("oracle", Json::string(text(oracle_row, "oracle")?)),
            (
                "source",
                source.map_or(Json::Null, |source| Json::string(source.to_hex())),
            ),
            (
                "source_code_sha256",
                source_row
                    .and_then(|row| row.get("code"))
                    .and_then(|code| code.get("sha256"))
                    .cloned()
                    .unwrap_or(Json::Null),
            ),
            ("price", Json::string(show(price))),
            ("price_path", Json::string(price_path)),
            ("latest_answer", Json::string(show(latest_answer))),
            ("base_currency_unit", Json::string(show(base_unit))),
            (
                "round_updated_at",
                updated_at.map_or(Json::Null, Json::uint),
            ),
            (
                "age_seconds_at_anchor",
                updated_at
                    .and_then(|at| now.checked_sub(at))
                    .map_or(Json::Null, Json::uint),
            ),
            (
                "freshness",
                Json::string(if round.is_some() {
                    "UPDATE_TIME_OBSERVED_NOT_ENFORCED_BY_PROTOCOL"
                } else {
                    "UPDATE_TIME_NOT_EXPOSED_BY_SOURCE_NOT_ENFORCED_BY_PROTOCOL"
                }),
            ),
        ]));

        // Stage decisions.
        let reserve_mismatch = mismatches
            .sorted()
            .iter()
            .any(|entry| entry.unit == unit_label && entry.explanation.is_none());
        let reconstructable = if unknown_bits {
            StageDecision::Reject(RejectionReason::UnsupportedProtocolVersion)
        } else if reserve_mismatch {
            StageDecision::Reject(RejectionReason::StateUnreconstructable)
        } else if balance_below_accounted {
            StageDecision::Reject(RejectionReason::UnsupportedTokenBehavior)
        } else {
            StageDecision::Advance
        };
        record(
            &mut ledger,
            &domain,
            unit,
            CensusStage::MarketsStateReconstructable,
            reconstructable.clone(),
            &refs,
        )?;
        // Liquidity and borrowability are recorded as exact facts; the
        // economic classification of a market is not this node's decision.
        let available = match (virtual_balance, balance) {
            (Some(virtual_balance), _) if configuration.virtual_accounting_enabled => {
                Some(virtual_balance)
            }
            (_, balance) => balance,
        };
        let total_debt = match (v_total, stable_total) {
            (Some(variable), stable) => variable.checked_add(stable.unwrap_or(U256::ZERO)).ok(),
            _ => None,
        };
        let cap_amount = |whole: u64| {
            U256::pow10(configuration.decimals as u32)
                .and_then(|unit| U256::from_u64(whole).checked_mul(unit))
                .ok()
        };
        let borrow_cap_reached = match (configuration.borrow_cap_whole_tokens, total_debt) {
            (0, _) => Json::Bool(false),
            (whole, Some(debt)) => {
                cap_amount(whole).map_or(Json::Null, |cap| Json::Bool(debt >= cap))
            }
            _ => Json::Null,
        };
        let supply_cap_reached = match (configuration.supply_cap_whole_tokens, a_total) {
            (0, _) => Json::Bool(false),
            (whole, Some(supply)) => {
                cap_amount(whole).map_or(Json::Null, |cap| Json::Bool(supply >= cap))
            }
            _ => Json::Null,
        };
        let protocol_facts = Json::object([
            ("active", Json::Bool(configuration.active)),
            ("paused", Json::Bool(configuration.paused)),
            ("frozen", Json::Bool(configuration.frozen)),
            (
                "borrowing_enabled",
                Json::Bool(configuration.borrowing_enabled),
            ),
            (
                "flash_loan_enabled",
                Json::Bool(configuration.flash_loan_enabled),
            ),
            ("available_liquidity", Json::string(show(available))),
            (
                "total_variable_and_stable_debt",
                Json::string(show(total_debt)),
            ),
            ("borrow_cap_reached", borrow_cap_reached),
            ("supply_cap_reached", supply_cap_reached),
        ]);

        state_rows.push(Json::object([
            ("schema_version", Json::uint(1)),
            ("protocol", Json::string("AAVE_V3")),
            ("market_id", Json::string(market_id.to_hex())),
            ("asset", Json::string(reserve.asset.to_hex())),
            ("reserve_id", Json::uint(u64::from(reserve_id))),
            ("lifecycle", Json::string("CURRENT")),
            ("configuration", configuration.json()),
            (
                "indexes",
                Json::object([
                    ("liquidity_index", Json::string(show(liquidity_index))),
                    ("current_liquidity_rate", Json::string(show(liquidity_rate))),
                    ("variable_borrow_index", Json::string(show(variable_index))),
                    (
                        "current_variable_borrow_rate",
                        Json::string(show(variable_rate)),
                    ),
                    (
                        "current_stable_borrow_rate_word",
                        Json::string(show(stable_rate)),
                    ),
                    (
                        "last_update_timestamp",
                        last_update.map_or(Json::Null, Json::uint),
                    ),
                    ("anchor_timestamp", Json::uint(now)),
                    ("normalized_income", Json::string(show(income))),
                    ("normalized_variable_debt", Json::string(show(debt_index))),
                    (
                        "normalized_income_basis",
                        Json::string("PROTOCOL_GETTER_RECOMPUTED_EXACT"),
                    ),
                    (
                        "normalized_variable_debt_basis",
                        Json::string("PROTOCOL_GETTER_ONLY"),
                    ),
                ]),
            ),
            (
                "liquidity",
                Json::object([
                    ("a_token_scaled_total_supply", Json::string(show(a_scaled))),
                    ("a_token_total_supply", Json::string(show(a_total))),
                    (
                        "variable_debt_scaled_total_supply",
                        Json::string(show(v_scaled)),
                    ),
                    ("variable_debt_total_supply", Json::string(show(v_total))),
                    ("stable_debt_total_supply", Json::string(show(stable_total))),
                    ("underlying_balance_of_a_token", Json::string(show(balance))),
                    (
                        "virtual_underlying_balance",
                        Json::string(show(virtual_balance)),
                    ),
                    (
                        "accrued_to_treasury_scaled",
                        Json::string(show(accrued_to_treasury)),
                    ),
                    ("unbacked", Json::string(show(unbacked))),
                    (
                        "isolation_mode_total_debt",
                        Json::string(show(isolation_debt)),
                    ),
                    (
                        "deficit",
                        Json::string(show(one_word(getter(row, "getReserveDeficit(address)")?))),
                    ),
                ]),
            ),
            (
                "liquidation_grace_period_until",
                Json::string(show(one_word(getter(
                    row,
                    "getLiquidationGracePeriod(address)",
                )?))),
            ),
            (
                "tokens",
                Json::object([
                    ("underlying", Json::string(reserve.asset.to_hex())),
                    ("a_token", Json::string(a_token.to_hex())),
                    ("variable_debt_token", Json::string(variable_token.to_hex())),
                    (
                        "stable_debt_token",
                        row.get("stable_debt_token").cloned().unwrap_or(Json::Null),
                    ),
                    (
                        "interest_rate_strategy",
                        row.get("interest_rate_strategy")
                            .cloned()
                            .unwrap_or(Json::Null),
                    ),
                    ("treasury", a.get("treasury").cloned().unwrap_or(Json::Null)),
                ]),
            ),
            (
                "stage_state_reconstructable",
                Json::string(decision_code(&reconstructable)),
            ),
            ("protocol_facts", protocol_facts),
        ]));

        // Token admission records.
        let state = if balance_below_accounted {
            StateAdmission::Rejected("HOLDER_BALANCE_BELOW_PROTOCOL_ACCOUNTED_BALANCE".into())
        } else if underlying_decimals.value().is_none() {
            StateAdmission::Rejected("DECIMALS_UNAVAILABLE".into())
        } else {
            StateAdmission::Admitted
        };
        let entry = tokens
            .entry(reserve.asset)
            .or_insert_with(|| TokenAdmission {
                token: reserve.asset,
                roles: BTreeSet::new(),
                runtime: runtime(row, reserve.asset),
                proxy: proxy.clone(),
                decimals: underlying_decimals,
                behavior: behavior.clone(),
                state: state.clone(),
            });
        entry.roles.insert("AAVE_RESERVE_UNDERLYING".into());
        for (token, role, prefix, decimals) in [
            (a_token, "AAVE_ATOKEN", "a_token", a_decimals),
            (
                variable_token,
                "AAVE_VARIABLE_DEBT_TOKEN",
                "variable_debt",
                v_decimals,
            ),
        ] {
            let proxy = proxy_fact(row, prefix);
            let mut behavior = TokenBehavior::unproven();
            behavior.upgradeable = proxy.upgradeable();
            let entry = tokens.entry(token).or_insert_with(|| TokenAdmission {
                token,
                roles: BTreeSet::new(),
                runtime: runtime(row, token),
                proxy,
                decimals,
                behavior,
                state: StateAdmission::Admitted,
            });
            entry.roles.insert(role.into());
        }
    }

    let emode_rows = verify_emode(stage, &mut mismatches)?;
    let pool_facts = Json::object([
        ("pool", Json::string(inputs.pool.to_hex())),
        (
            "pool_implementation_code",
            pool_row
                .get("pool_implementation_code")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "getters_present",
            pool_row
                .get("getters_present")
                .cloned()
                .unwrap_or(Json::Null),
        ),
        (
            "scalars",
            pool_row.get("scalars").cloned().unwrap_or(Json::Null),
        ),
        // The raw authoritative getter, named explicitly for downstream
        // capital accounting: never inferred, never defaulted.
        (
            "flashloan_premium_total",
            pool_row
                .get("scalars")
                .and_then(|scalars| scalars.get("FLASHLOAN_PREMIUM_TOTAL()"))
                .cloned()
                .unwrap_or_else(|| {
                    Json::object([("status", Json::string("NOT_EXPOSED_BY_IMPLEMENTATION"))])
                }),
        ),
    ]);
    Ok(AaveOutcome {
        state_rows,
        oracle_rows,
        emode_rows,
        tokens: tokens.into_values().collect(),
        mismatches,
        ledger,
        domain,
        pool_facts,
    })
}

/// Configured eMode categories (non-zero liquidation threshold) with exact
/// collateral / borrowable / LTV-zero membership bitmaps.
fn verify_emode(
    stage: &ReplayedStage,
    mismatches: &mut MismatchLedger,
) -> Result<Vec<Json>, ChainError> {
    let mut out = Vec::new();
    for row in stage
        .rows
        .iter()
        .filter(|row| row.get("kind").and_then(Json::as_str) == Some("EMODE"))
    {
        let id = row
            .get("id")
            .and_then(Json::as_i64)
            .ok_or_else(|| ChainError::Evidence("eMode id".into()))?;
        let collateral = getter(row, "getEModeCategoryCollateralConfig(uint8)")?;
        let legacy = getter(row, "getEModeCategoryData(uint8)")?;
        let (ltv, threshold, bonus) = match (&collateral, &legacy) {
            (Some((true, bytes)), _) if bytes.len() >= 96 => {
                (word(bytes, 0), word(bytes, 1), word(bytes, 2))
            }
            (_, Some((true, bytes))) if bytes.len() >= 128 => {
                // Legacy struct is ABI-encoded behind an offset word.
                (word(bytes, 1), word(bytes, 2), word(bytes, 3))
            }
            _ => (None, None, None),
        };
        if threshold.is_none_or(|value| value.is_zero()) {
            continue;
        }
        let bitmap = |signature: &str| -> Result<Json, ChainError> {
            Ok(one_word(getter(row, signature)?)
                .map_or(Json::Null, |value| Json::string(value.to_decimal())))
        };
        let label = getter(row, "getEModeCategoryLabel(uint8)")?
            .filter(|(ok, _)| *ok)
            .map(|(_, bytes)| nqc_census_chain::hex::encode(&bytes));
        if ltv
            .zip(threshold)
            .is_some_and(|(ltv, threshold)| ltv > threshold)
        {
            mismatches.check(
                &format!("AAVE_EMODE:{id}"),
                "LTV_NOT_ABOVE_THRESHOLD",
                "ltv<=threshold",
                "ltv>threshold",
            );
        }
        out.push(Json::object([
            ("schema_version", Json::uint(1)),
            ("category_id", Json::int(id)),
            ("ltv_bps", Json::string(show(ltv))),
            ("liquidation_threshold_bps", Json::string(show(threshold))),
            ("liquidation_bonus_bps", Json::string(show(bonus))),
            ("label_abi", label.map_or(Json::Null, Json::string)),
            (
                "collateral_bitmap",
                bitmap("getEModeCategoryCollateralBitmap(uint8)")?,
            ),
            (
                "borrowable_bitmap",
                bitmap("getEModeCategoryBorrowableBitmap(uint8)")?,
            ),
            (
                "ltvzero_bitmap",
                bitmap("getEModeCategoryLtvzeroBitmap(uint8)")?,
            ),
        ]));
    }
    Ok(out)
}
