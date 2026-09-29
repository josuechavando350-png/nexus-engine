//! Offline verification of RMC-008 Uniswap V2 state.
//!
//! Works only on replayed stage data. Both providers must return identical
//! factory and pair-state rows (no voting); partitions must tile `0..N`.
//! Then, for every admitted pair:
//!
//! - market identity is recomputed through D01 and must equal the D07 id;
//! - the pair address must be the CREATE2 derivation from the init code found
//!   inside the admitted factory runtime (runtime identity for every pair);
//! - `factory()` must name the admitted factory;
//! - `getReserves`, `totalSupply` and `kLast` must be canonical;
//! - each token's `balanceOf(pair)` must be canonical and not below the
//!   pair's reserve (a lower balance is concrete evidence of non-standard
//!   token behavior and rejects the market).
//!
//! Stage decisions go to the core `StageLedger`.

use crate::model::{
    Decimals, MismatchLedger, ProxyFact, RuntimeIdentity, StateAdmission, TokenAdmission,
    TokenBehavior, Tri,
};
use crate::uint::U256;
use crate::v2_math::{create2_address, locate_init_code, pair_salt, runtime_from_init_code};
use crate::v2_stage::PairInput;
use nqc_census_chain::{hex, json::Json, ChainError};
use nqc_census_core::{
    Address, CanonicalMarketKey, CensusStage, CensusUnitId, CensusUnitKind, DeploymentKey,
    EvidenceBasis, EvidenceRef, Hash32, RejectionReason, StageDecision, StageDomain, StageEvidence,
    StageLedger, StageRecord,
};
use std::collections::{BTreeMap, BTreeSet};

/// A replayed stage belonging to one provider.
#[derive(Debug, Clone)]
pub struct ReplayedStage {
    pub provider: String,
    pub parameters: Json,
    pub manifests: Vec<String>,
    pub rows: Vec<Json>,
}

pub struct V2Inputs<'a> {
    pub deployment: DeploymentKey,
    /// sha256 of the factory runtime admitted by D07/D05.
    pub admitted_factory_sha256: String,
    /// Search key for the embedded pair init code.
    pub declared_init_code_hash: [u8; 32],
    pub pairs: &'a [PairInput],
    pub factory: Vec<ReplayedStage>,
    pub state: Vec<ReplayedStage>,
}

pub struct V2Outcome {
    pub state_rows: Vec<Json>,
    pub tokens: Vec<TokenAdmission>,
    pub mismatches: MismatchLedger,
    pub ledger: StageLedger,
    pub domain: StageDomain,
    pub factory_facts: Json,
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn text<'a>(value: &'a Json, key: &str) -> Result<&'a str, ChainError> {
    value.str_field(key)
}

fn artifact(id: &str) -> Result<EvidenceRef, ChainError> {
    Ok(EvidenceRef::Artifact(Hash32::parse_hex(&format!(
        "0x{}",
        id.trim_start_matches("0x")
    ))?))
}

/// A decimal-string field, or `None` for a status object.
fn value(row: &Json, key: &str) -> Result<Option<U256>, ChainError> {
    match row.get(key) {
        Some(Json::String(text)) => {
            Ok(Some(U256::parse_decimal(text).map_err(|error| {
                ChainError::Evidence(format!("{key}: {error}"))
            })?))
        }
        Some(Json::Object(_)) => Ok(None),
        _ => Err(ChainError::Evidence(format!(
            "{key} is neither value nor status"
        ))),
    }
}

fn field_status(row: &Json, key: &str) -> String {
    match row.get(key) {
        Some(Json::Object(_)) => row
            .get(key)
            .and_then(|status| status.get("status"))
            .and_then(Json::as_str)
            .unwrap_or("MALFORMED")
            .to_owned(),
        Some(Json::String(_)) | Some(Json::Array(_)) | Some(Json::Null) => "VALUE".into(),
        _ => "MISSING".into(),
    }
}

fn agree_rows(stages: &[&ReplayedStage]) -> Result<(), ChainError> {
    let Some(first) = stages.first() else {
        return Err(ChainError::Consensus("no stage to compare"));
    };
    let providers: BTreeSet<&str> = stages.iter().map(|stage| stage.provider.as_str()).collect();
    if providers.len() < 2 || providers.len() != stages.len() {
        return Err(ChainError::Consensus(
            "agreement requires one stage from each of at least two providers",
        ));
    }
    for other in &stages[1..] {
        if other.rows.len() != first.rows.len() {
            return Err(ChainError::Consensus(
                "providers returned different row counts",
            ));
        }
        for (left, right) in first.rows.iter().zip(&other.rows) {
            if !left.same_as(right)? {
                return Err(ChainError::Consensus("providers returned different state"));
            }
        }
    }
    Ok(())
}

struct FactoryFacts {
    init_code_hash: [u8; 32],
    pair_runtime_sha256: String,
    fee_to: Json,
    json: Json,
}

fn factory_facts(inputs: &V2Inputs<'_>) -> Result<FactoryFacts, ChainError> {
    agree_rows(&inputs.factory.iter().collect::<Vec<_>>())?;
    let row = inputs
        .factory
        .first()
        .and_then(|stage| stage.rows.first())
        .ok_or_else(|| ChainError::Evidence("factory stage without a row".into()))?;
    let factory_code = row
        .get("factory_code")
        .ok_or_else(|| ChainError::Evidence("factory code missing".into()))?;
    if text(factory_code, "sha256")? != inputs.admitted_factory_sha256.trim_start_matches("0x") {
        return Err(ChainError::Evidence(
            "factory runtime differs from the D07-admitted runtime".into(),
        ));
    }
    let code = hex::decode_data(text(factory_code, "code")?)?;
    let located = locate_init_code(&code, inputs.declared_init_code_hash);
    if located.len() != 1 {
        return Err(ChainError::Evidence(format!(
            "pair init code located {} times in the factory runtime",
            located.len()
        )));
    }
    let embedded = &located[0];
    let init_code = &code[embedded.offset..embedded.offset + embedded.length];
    let samples = row
        .get("samples")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("sample pair runtimes missing".into()))?;
    if samples.is_empty() {
        return Err(ChainError::Evidence("no sample pair runtime".into()));
    }
    let mut runtime_sha = BTreeSet::new();
    for sample in samples {
        let runtime = hex::decode_data(text(sample, "code")?)?;
        if !runtime_from_init_code(init_code, &runtime) {
            return Err(ChainError::Evidence(
                "sample pair runtime is not produced by the embedded init code".into(),
            ));
        }
        runtime_sha.insert(text(sample, "sha256")?.to_owned());
    }
    if runtime_sha.len() != 1 {
        return Err(ChainError::Evidence("sample pair runtimes differ".into()));
    }
    let pair_runtime_sha256 = runtime_sha.into_iter().next().unwrap_or_default();
    let pair_count = value(row, "all_pairs_length")?
        .and_then(U256::to_u64)
        .ok_or_else(|| ChainError::Evidence("allPairsLength is not canonical".into()))?;
    if pair_count != inputs.pairs.len() as u64 {
        return Err(ChainError::Evidence(format!(
            "allPairsLength {pair_count} differs from the {} admitted pairs",
            inputs.pairs.len()
        )));
    }
    let fee_to = row.get("fee_to").cloned().unwrap_or(Json::Null);
    let json = Json::object([
        (
            "factory",
            Json::string(inputs.deployment.address().to_hex()),
        ),
        (
            "factory_runtime_sha256",
            Json::string(text(factory_code, "sha256")?),
        ),
        (
            "embedded_init_code",
            Json::object([
                ("offset", Json::uint(embedded.offset as u64)),
                ("length", Json::uint(embedded.length as u64)),
                ("keccak256", Json::string(hex::encode(&embedded.hash))),
            ]),
        ),
        (
            "pair_runtime_sha256",
            Json::string(pair_runtime_sha256.clone()),
        ),
        ("pair_runtime_selfdestruct", Json::Bool(false)),
        ("all_pairs_length", Json::uint(pair_count)),
        ("fee_to", fee_to.clone()),
        (
            "fee_to_setter",
            row.get("fee_to_setter").cloned().unwrap_or(Json::Null),
        ),
    ]);
    Ok(FactoryFacts {
        init_code_hash: embedded.hash,
        pair_runtime_sha256,
        fee_to,
        json,
    })
}

type AgreedState = (
    BTreeMap<u64, Json>,
    BTreeMap<Address, Json>,
    BTreeMap<u64, Vec<String>>,
);

/// Replayed state rows for index `0..N`, both providers agreeing per
/// partition, plus the covering job manifest of every pair index.
fn agreed_state(inputs: &V2Inputs<'_>) -> Result<AgreedState, ChainError> {
    let mut by_partition: BTreeMap<(u64, u64), Vec<&ReplayedStage>> = BTreeMap::new();
    for stage in &inputs.state {
        by_partition
            .entry((
                number(&stage.parameters, "partition")?,
                number(&stage.parameters, "partitions")?,
            ))
            .or_default()
            .push(stage);
    }
    let partitions: BTreeSet<u64> = by_partition.keys().map(|(_, total)| *total).collect();
    if partitions.len() != 1 {
        return Err(ChainError::Evidence(
            "stages disagree on the partition count".into(),
        ));
    }
    let total = partitions.into_iter().next().unwrap_or(0);
    if by_partition.len() as u64 != total {
        return Err(ChainError::Evidence(
            "a V2 state partition is missing".into(),
        ));
    }
    let mut pairs = BTreeMap::new();
    let mut tokens: BTreeMap<Address, Json> = BTreeMap::new();
    let mut evidence: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    for stages in by_partition.values() {
        agree_rows(stages)?;
        let job_size = number(&stages[0].parameters, "job_size")?.max(1);
        for stage in stages {
            let mut first_index = None;
            for row in &stage.rows {
                if text(row, "kind")? == "PAIR" {
                    let index = number(row, "index")?;
                    let first = *first_index.get_or_insert(index);
                    let job = ((index - first) / job_size) as usize;
                    let manifest = stage
                        .manifests
                        .get(2 + job)
                        .ok_or_else(|| ChainError::Evidence("pair job manifest missing".into()))?;
                    let refs = evidence.entry(index).or_default();
                    refs.push(stage.manifests[0].clone());
                    refs.push(stage.manifests[1].clone());
                    refs.push(manifest.clone());
                }
            }
        }
        for row in &stages[0].rows {
            match text(row, "kind")? {
                "PAIR" => {
                    let index = number(row, "index")?;
                    if pairs.insert(index, row.clone()).is_some() {
                        return Err(ChainError::Evidence(format!("pair index {index} twice")));
                    }
                }
                "TOKEN" => {
                    let token = Address::parse_hex(text(row, "token")?)?;
                    let decimals = row.get("decimals").cloned().unwrap_or(Json::Null);
                    if let Some(previous) = tokens.get(&token) {
                        if !previous.same_as(&decimals)? {
                            return Err(ChainError::Evidence(format!(
                                "token {} answered decimals differently across partitions",
                                token.to_hex()
                            )));
                        }
                    }
                    tokens.insert(token, decimals);
                }
                other => return Err(ChainError::Evidence(format!("unknown row kind {other}"))),
            }
        }
    }
    if pairs.len() != inputs.pairs.len()
        || pairs
            .keys()
            .enumerate()
            .any(|(position, index)| *index != position as u64)
    {
        return Err(ChainError::Evidence(
            "V2 state rows do not cover the admitted pairs exactly".into(),
        ));
    }
    Ok((pairs, tokens, evidence))
}

#[derive(Default)]
struct TokenObservations {
    roles: BTreeSet<String>,
    answered: bool,
    empty: bool,
    below_reserve: u64,
    above_reserve: u64,
    equal_reserve: u64,
    balance_failed: u64,
}

fn decimals_from(value: &Json) -> Decimals {
    match value {
        Json::Number(_) => value
            .as_i64()
            .and_then(|value| u8::try_from(value).ok())
            .map_or(Decimals::NonCanonical, Decimals::Value),
        Json::Object(_) => match value.get("status").and_then(Json::as_str) {
            Some("REVERTED") => Decimals::Reverted,
            Some("HALTED") => Decimals::Halted,
            Some("EMPTY") => Decimals::Empty,
            _ => Decimals::NonCanonical,
        },
        _ => Decimals::NonCanonical,
    }
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

pub fn verify_v2(inputs: &V2Inputs<'_>) -> Result<V2Outcome, ChainError> {
    let facts = factory_facts(inputs)?;
    let (pair_rows, token_decimals, pair_evidence) = agreed_state(inputs)?;
    let factory_refs: Vec<EvidenceRef> = inputs
        .factory
        .iter()
        .flat_map(|stage| stage.manifests.iter())
        .map(|id| artifact(id))
        .collect::<Result<_, _>>()?;
    let domain = StageDomain::new(
        inputs.deployment.chain().clone(),
        inputs.deployment.protocol(),
        CensusUnitKind::Market,
    );
    let mut ledger = StageLedger::default();
    let mut mismatches = MismatchLedger::default();
    let mut observations: BTreeMap<Address, TokenObservations> = BTreeMap::new();
    let mut state_rows = Vec::with_capacity(inputs.pairs.len());
    let factory = inputs.deployment.address();
    for input in inputs.pairs {
        let row = pair_rows
            .get(&input.index)
            .ok_or_else(|| ChainError::Evidence("pair state row missing".into()))?;
        let unit_label = format!("V2_PAIR:{}", input.pair.to_hex());
        if Address::parse_hex(text(row, "pair")?)? != input.pair
            || Address::parse_hex(text(row, "token0")?)? != input.token0
            || Address::parse_hex(text(row, "token1")?)? != input.token1
        {
            return Err(ChainError::Evidence(format!(
                "state row {} names another pair",
                input.index
            )));
        }
        let key = CanonicalMarketKey::v2_pair(
            inputs.deployment.clone(),
            input.pair,
            input.token0,
            input.token1,
        )?;
        let market_id = key.id()?;
        mismatches.check(
            &unit_label,
            "D01_MARKET_ID",
            &input.market_id,
            market_id.to_hex(),
        );
        let derived = create2_address(
            factory,
            pair_salt(input.token0, input.token1),
            facts.init_code_hash,
        );
        let create2 = derived == *input.pair.as_bytes();
        mismatches.check(
            &unit_label,
            "PAIR_CREATE2_DERIVATION",
            input.pair.to_hex(),
            Address::new(derived).map_or_else(|_| "ZERO".into(), |address| address.to_hex()),
        );
        let observed_factory = row.get("factory").and_then(Json::as_str).unwrap_or("");
        let factory_ok = observed_factory == factory.to_hex();
        mismatches.check(
            &unit_label,
            "PAIR_FACTORY",
            factory.to_hex(),
            observed_factory,
        );
        let reserves = match row.get("reserves") {
            Some(Json::Array(items)) if items.len() == 3 => {
                let parse = |item: &Json| -> Result<U256, ChainError> {
                    match item {
                        Json::String(text) => U256::parse_decimal(text)
                            .map_err(|error| ChainError::Evidence(error.to_string())),
                        Json::Number(_) => item
                            .as_i64()
                            .and_then(|value| u64::try_from(value).ok())
                            .map(U256::from_u64)
                            .ok_or_else(|| ChainError::Evidence("reserve timestamp".into())),
                        _ => Err(ChainError::Evidence("reserve item".into())),
                    }
                };
                Some((parse(&items[0])?, parse(&items[1])?, parse(&items[2])?))
            }
            _ => None,
        };
        let total_supply = value(row, "total_supply")?;
        let k_last = value(row, "k_last")?;
        let balances = [value(row, "balance0")?, value(row, "balance1")?];
        let tokens = [input.token0, input.token1];
        let mut behavior_reject = false;
        let mut signals = Vec::new();
        for (side, token) in tokens.iter().enumerate() {
            let entry = observations.entry(*token).or_default();
            entry.roles.insert(format!("V2_TOKEN{side}"));
            match (&balances[side], &reserves) {
                (Some(balance), Some((r0, r1, _))) => {
                    entry.answered = true;
                    let reserve = if side == 0 { r0 } else { r1 };
                    match balance.cmp(reserve) {
                        std::cmp::Ordering::Less => {
                            entry.below_reserve += 1;
                            behavior_reject = true;
                            signals.push(format!("TOKEN{side}_BALANCE_BELOW_RESERVE"));
                        }
                        std::cmp::Ordering::Greater => entry.above_reserve += 1,
                        std::cmp::Ordering::Equal => entry.equal_reserve += 1,
                    }
                }
                (None, _) => {
                    entry.balance_failed += 1;
                    if field_status(row, if side == 0 { "balance0" } else { "balance1" }) == "EMPTY"
                    {
                        entry.empty = true;
                    }
                    behavior_reject = true;
                    signals.push(format!(
                        "TOKEN{side}_BALANCE_OF_{}",
                        field_status(row, if side == 0 { "balance0" } else { "balance1" })
                    ));
                }
                (Some(_), None) => entry.answered = true,
            }
        }
        let canonical_pair = reserves.is_some() && total_supply.is_some() && k_last.is_some();
        let refs: Vec<EvidenceRef> = pair_evidence
            .get(&input.index)
            .into_iter()
            .flatten()
            .map(|id| artifact(id))
            .chain(factory_refs.iter().cloned().map(Ok))
            .collect::<Result<_, _>>()?;
        let unit = CensusUnitId::from_market(market_id);
        let reconstructable = if !create2 || !factory_ok || !canonical_pair {
            StageDecision::Reject(RejectionReason::StateUnreconstructable)
        } else if behavior_reject {
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
        // Non-zero reserves are a recorded fact; whether a market is
        // economically active is a later classification, not this node's.
        let liquid = reserves
            .as_ref()
            .is_some_and(|(r0, r1, _)| !r0.is_zero() && !r1.is_zero())
            && total_supply.is_some_and(|supply| !supply.is_zero());
        let excess = |side: usize| -> Json {
            match (&balances[side], &reserves) {
                (Some(balance), Some((r0, r1, _))) => {
                    let reserve = if side == 0 { r0 } else { r1 };
                    balance
                        .checked_sub(*reserve)
                        .map_or(Json::Null, |excess| Json::string(excess.to_decimal()))
                }
                _ => Json::Null,
            }
        };
        state_rows.push(Json::object([
            ("schema_version", Json::uint(1)),
            ("protocol", Json::string("UNISWAP_V2")),
            ("market_id", Json::string(market_id.to_hex())),
            ("index", Json::uint(input.index)),
            ("pair", Json::string(input.pair.to_hex())),
            ("token0", Json::string(input.token0.to_hex())),
            ("token1", Json::string(input.token1.to_hex())),
            (
                "runtime",
                Json::object([
                    (
                        "kind",
                        Json::string("CREATE2_DERIVED_FROM_ADMITTED_FACTORY"),
                    ),
                    ("derivation_matches", Json::Bool(create2)),
                    (
                        "runtime_sha256",
                        Json::string(facts.pair_runtime_sha256.clone()),
                    ),
                ]),
            ),
            ("factory_membership", Json::Bool(factory_ok)),
            (
                "reserves",
                row.get("reserves").cloned().unwrap_or(Json::Null),
            ),
            (
                "total_supply",
                row.get("total_supply").cloned().unwrap_or(Json::Null),
            ),
            ("k_last", row.get("k_last").cloned().unwrap_or(Json::Null)),
            (
                "balance0",
                row.get("balance0").cloned().unwrap_or(Json::Null),
            ),
            (
                "balance1",
                row.get("balance1").cloned().unwrap_or(Json::Null),
            ),
            ("balance0_minus_reserve0", excess(0)),
            ("balance1_minus_reserve1", excess(1)),
            (
                "fee_semantics",
                Json::object([
                    ("swap_fee_bps", Json::uint(30)),
                    (
                        "basis",
                        Json::string("EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME"),
                    ),
                    (
                        "protocol_fee_enabled",
                        Json::Bool(!matches!(facts.fee_to, Json::Null)),
                    ),
                ]),
            ),
            (
                "liquidity_state",
                Json::string(if liquid {
                    "LIQUID"
                } else {
                    "ZERO_LIQUIDITY_NOT_ROUTABLE"
                }),
            ),
            (
                "behavior_signals",
                Json::array(signals.into_iter().map(Json::string)),
            ),
            (
                "stage_state_reconstructable",
                Json::string(match &reconstructable {
                    StageDecision::Advance => "ADVANCE".to_owned(),
                    StageDecision::Reject(reason) => format!("REJECT:{}", reason.code()),
                    StageDecision::Unknown { .. } => "UNKNOWN".to_owned(),
                }),
            ),
        ]));
    }
    let mut tokens = Vec::with_capacity(observations.len());
    for (token, seen) in observations {
        let decimals = token_decimals
            .get(&token)
            .map_or(Decimals::NonCanonical, decimals_from);
        let runtime = if seen.answered || decimals.value().is_some() {
            RuntimeIdentity::PresenceByCall
        } else if seen.empty {
            RuntimeIdentity::Absent
        } else {
            RuntimeIdentity::PresenceByCall
        };
        let mut behavior = TokenBehavior::unproven();
        for (name, count) in [
            ("PAIRS_BALANCE_BELOW_RESERVE", seen.below_reserve),
            ("PAIRS_BALANCE_ABOVE_RESERVE", seen.above_reserve),
            ("PAIRS_BALANCE_EQUAL_RESERVE", seen.equal_reserve),
            ("PAIRS_BALANCE_OF_FAILED", seen.balance_failed),
        ] {
            if count > 0 {
                behavior.signals.push((name.into(), count.to_string()));
            }
        }
        if seen.below_reserve > 0 {
            // A holder balance below the protocol-accounted reserve is only
            // possible if the token changes balances outside transfers.
            behavior.rebasing = Tri::Present;
        }
        let state = if seen.balance_failed > 0 {
            StateAdmission::Rejected("BALANCE_OF_UNAVAILABLE".into())
        } else if seen.below_reserve > 0 {
            StateAdmission::Rejected("BALANCE_BELOW_PAIR_RESERVE".into())
        } else {
            StateAdmission::Admitted
        };
        tokens.push(TokenAdmission {
            token,
            roles: seen.roles,
            runtime,
            proxy: ProxyFact::NotRead,
            decimals,
            behavior,
            state,
        });
    }
    Ok(V2Outcome {
        state_rows,
        tokens,
        mismatches,
        ledger,
        domain,
        factory_facts: facts.json,
    })
}
