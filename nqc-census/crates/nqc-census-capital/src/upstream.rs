//! Strict bridge from admitted RMC-008 state artifacts into RMC-011 capital sources.
//!
//! This module does not perform RPC calls and does not trust "latest" artifacts.
//! Its caller must bind the input bytes to admitted upstream authority. The importer
//! only accepts state rows that are reconstructable and tokens whose D08 execution
//! compatibility is explicitly proven.

use crate::{
    adapters::{AaveV3FlashObservation, UniswapV2FlashSwapObservation},
    Amount256, CapitalAsset, CapitalError, CapitalEvidenceRef, CapitalSource,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum CapitalImportRejectionReason {
    HistoricalNoActiveState,
    StateNotReconstructable,
    TokenExecutionCompatibilityBlocked,
    FlashLoanDisabled,
    FlashSwapReserveUnavailable,
}

impl CapitalImportRejectionReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::HistoricalNoActiveState => "HISTORICAL_NO_ACTIVE_STATE",
            Self::StateNotReconstructable => "STATE_NOT_RECONSTRUCTABLE",
            Self::TokenExecutionCompatibilityBlocked => "TOKEN_EXECUTION_COMPATIBILITY_BLOCKED",
            Self::FlashLoanDisabled => "FLASH_LOAN_DISABLED",
            Self::FlashSwapReserveUnavailable => "FLASH_SWAP_RESERVE_UNAVAILABLE",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalImportRejection {
    pub protocol: String,
    pub market_id: String,
    pub asset: CapitalAsset,
    pub reason: CapitalImportRejectionReason,
}

#[derive(Debug, Clone)]
pub struct D08CapitalImportContext {
    pub anchor: StateAnchor,
    pub aave_pool: Address,
    pub aave_premium_total_bps: u16,
    pub aave_provider_locator_hash: Hash32,
    pub uniswap_v2_provider_locator_hash: Hash32,
    pub evidence: Vec<CapitalEvidenceRef>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct D08CapitalImport {
    pub candidate_count: usize,
    pub admitted_count: usize,
    pub rejected_count: usize,
    pub coverage_commitment: Hash32,
    pub sources: Vec<CapitalSource>,
    pub rejections: Vec<CapitalImportRejection>,
}

impl D08CapitalImport {
    pub const fn is_conserved(&self) -> bool {
        self.candidate_count == self.admitted_count + self.rejected_count
            && self.admitted_count == self.sources.len()
            && self.rejected_count == self.rejections.len()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ImportOutcome {
    protocol: String,
    market_id: String,
    asset: CapitalAsset,
    result: ImportOutcomeResult,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum ImportOutcomeResult {
    Admitted([u8; 32]),
    Rejected(CapitalImportRejectionReason),
}

fn field<'a>(row: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    row.get(key)
        .ok_or(CapitalError::InvalidCanonical("missing D08 field"))
}

fn text<'a>(row: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    field(row, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not text"))
}

fn bool_field(row: &Json, key: &'static str) -> Result<bool, CapitalError> {
    field(row, key)?
        .as_bool()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not boolean"))
}

fn array<'a>(row: &'a Json, key: &'static str) -> Result<&'a [Json], CapitalError> {
    field(row, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical("D08 field is not array"))
}

fn parse_jsonl(bytes: &[u8]) -> Result<Vec<Json>, CapitalError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("D08 JSONL is not UTF-8"))?;
    let mut rows = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        rows.push(
            Json::parse(line.as_bytes())
                .map_err(|_| CapitalError::InvalidCanonical("D08 JSONL parse failed"))?,
        );
    }
    Ok(rows)
}

fn token_compatibility(bytes: &[u8]) -> Result<BTreeMap<Address, bool>, CapitalError> {
    let mut tokens = BTreeMap::new();
    for row in parse_jsonl(bytes)? {
        let token = Address::parse_hex(text(&row, "token")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid D08 token address"))?;
        let execution = field(&row, "execution_compatibility")?;
        let compatible = text(execution, "status")? == "PROVEN_COMPATIBLE";
        if tokens.insert(token, compatible).is_some() {
            return Err(CapitalError::InvalidCanonical(
                "duplicate D08 token admission",
            ));
        }
    }
    Ok(tokens)
}

fn compatible(tokens: &BTreeMap<Address, bool>, token: Address) -> Result<bool, CapitalError> {
    tokens
        .get(&token)
        .copied()
        .ok_or(CapitalError::InvalidCanonical(
            "D08 state row references token without admission record",
        ))
}

fn push_rejection(
    rejections: &mut Vec<CapitalImportRejection>,
    outcomes: &mut Vec<ImportOutcome>,
    protocol: &str,
    market_id: &str,
    asset: CapitalAsset,
    reason: CapitalImportRejectionReason,
) {
    rejections.push(CapitalImportRejection {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        reason,
    });
    outcomes.push(ImportOutcome {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        result: ImportOutcomeResult::Rejected(reason),
    });
}

fn push_source(
    sources: &mut Vec<CapitalSource>,
    outcomes: &mut Vec<ImportOutcome>,
    protocol: &str,
    market_id: &str,
    asset: CapitalAsset,
    source: CapitalSource,
) {
    outcomes.push(ImportOutcome {
        protocol: protocol.to_owned(),
        market_id: market_id.to_owned(),
        asset,
        result: ImportOutcomeResult::Admitted(*source.id().as_bytes()),
    });
    sources.push(source);
}

fn write_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(
        u64::try_from(value.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    hasher.update(value);
}

fn coverage_commitment(outcomes: &mut [ImportOutcome]) -> Result<Hash32, CapitalError> {
    outcomes.sort();
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-D08-CAPITAL-IMPORT-COVERAGE-V1");
    hasher.update([0]);
    hasher.update(
        u64::try_from(outcomes.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    for outcome in outcomes {
        write_len_prefixed(&mut hasher, outcome.protocol.as_bytes());
        write_len_prefixed(&mut hasher, outcome.market_id.as_bytes());
        match outcome.asset {
            CapitalAsset::NativeGas => hasher.update([0]),
            CapitalAsset::Token(address) => {
                hasher.update([1]);
                hasher.update(address.as_bytes());
            }
        }
        match outcome.result {
            ImportOutcomeResult::Admitted(source_id) => {
                hasher.update([1]);
                hasher.update(source_id);
            }
            ImportOutcomeResult::Rejected(reason) => {
                hasher.update([2]);
                write_len_prefixed(&mut hasher, reason.code().as_bytes());
            }
        }
    }
    let digest = hasher.finalize();
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&digest);
    Hash32::new(bytes).map_err(|_| CapitalError::InvalidCanonical("zero D08 coverage commitment"))
}

pub fn import_d08_capital_sources(
    state_manifest_jsonl: &[u8],
    token_admission_jsonl: &[u8],
    context: &D08CapitalImportContext,
) -> Result<D08CapitalImport, CapitalError> {
    if context.evidence.is_empty() {
        return Err(CapitalError::MissingEvidence);
    }
    let tokens = token_compatibility(token_admission_jsonl)?;
    let mut sources = Vec::new();
    let mut rejections = Vec::new();
    let mut outcomes = Vec::new();
    let mut candidate_keys = BTreeSet::new();

    for row in parse_jsonl(state_manifest_jsonl)? {
        let protocol = text(&row, "protocol")?;
        let market_id = text(&row, "market_id")?.to_owned();
        match protocol {
            "AAVE_V3" => {
                let asset_address = Address::parse_hex(text(&row, "asset")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid Aave asset"))?;
                let asset = CapitalAsset::Token(asset_address);
                if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                    return Err(CapitalError::InvalidCanonical(
                        "duplicate D08 capital source candidate",
                    ));
                }
                if text(&row, "lifecycle")? != "CURRENT" {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::HistoricalNoActiveState,
                    );
                    continue;
                }
                if text(&row, "stage_state_reconstructable")? != "ADVANCE" {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::StateNotReconstructable,
                    );
                    continue;
                }
                if !compatible(&tokens, asset_address)? {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::TokenExecutionCompatibilityBlocked,
                    );
                    continue;
                }

                let facts = field(&row, "protocol_facts")?;
                if !bool_field(facts, "flash_loan_enabled")? {
                    push_rejection(
                        &mut rejections,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        CapitalImportRejectionReason::FlashLoanDisabled,
                    );
                    continue;
                }
                let available = Amount256::parse_decimal(text(facts, "available_liquidity")?)?;
                let source = AaveV3FlashObservation {
                    anchor: context.anchor.clone(),
                    pool: context.aave_pool,
                    asset: asset_address,
                    available_underlying: available,
                    premium_total_bps: context.aave_premium_total_bps,
                    flash_loan_enabled: true,
                    provider_locator_hash: context.aave_provider_locator_hash,
                    evidence: context.evidence.clone(),
                }
                .into_capital_source()?;
                push_source(
                    &mut sources,
                    &mut outcomes,
                    protocol,
                    &market_id,
                    asset,
                    source,
                );
            }
            "UNISWAP_V2" => {
                let pair = Address::parse_hex(text(&row, "pair")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 pair"))?;
                let token0 = Address::parse_hex(text(&row, "token0")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 token0"))?;
                let token1 = Address::parse_hex(text(&row, "token1")?)
                    .map_err(|_| CapitalError::InvalidCanonical("invalid V2 token1"))?;
                if text(&row, "stage_state_reconstructable")? != "ADVANCE"
                    || !bool_field(&row, "factory_membership")?
                {
                    for token in [token0, token1] {
                        let asset = CapitalAsset::Token(token);
                        if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                            return Err(CapitalError::InvalidCanonical(
                                "duplicate D08 capital source candidate",
                            ));
                        }
                        push_rejection(
                            &mut rejections,
                            &mut outcomes,
                            protocol,
                            &market_id,
                            asset,
                            CapitalImportRejectionReason::StateNotReconstructable,
                        );
                    }
                    continue;
                }
                let reserves = array(&row, "reserves")?;
                if reserves.len() != 3 {
                    return Err(CapitalError::InvalidCanonical(
                        "V2 reserve row is not three fields",
                    ));
                }

                for (token, reserve) in [(token0, &reserves[0]), (token1, &reserves[1])] {
                    let asset = CapitalAsset::Token(token);
                    if !candidate_keys.insert((protocol.to_owned(), market_id.clone(), asset)) {
                        return Err(CapitalError::InvalidCanonical(
                            "duplicate D08 capital source candidate",
                        ));
                    }
                    if !compatible(&tokens, token)? {
                        push_rejection(
                            &mut rejections,
                            &mut outcomes,
                            protocol,
                            &market_id,
                            asset,
                            CapitalImportRejectionReason::TokenExecutionCompatibilityBlocked,
                        );
                        continue;
                    }
                    let reserve_text = reserve.as_str().ok_or(CapitalError::InvalidCanonical(
                        "V2 reserve amount is not decimal text",
                    ))?;
                    let reserve_amount = Amount256::parse_decimal(reserve_text)?;
                    if reserve_amount <= Amount256::from_u128(1) {
                        push_rejection(
                            &mut rejections,
                            &mut outcomes,
                            protocol,
                            &market_id,
                            asset,
                            CapitalImportRejectionReason::FlashSwapReserveUnavailable,
                        );
                        continue;
                    }
                    let source = UniswapV2FlashSwapObservation {
                        anchor: context.anchor.clone(),
                        pair,
                        asset: token,
                        reserve: reserve_amount,
                        provider_locator_hash: context.uniswap_v2_provider_locator_hash,
                        evidence: context.evidence.clone(),
                    }
                    .into_capital_source()?;
                    push_source(
                        &mut sources,
                        &mut outcomes,
                        protocol,
                        &market_id,
                        asset,
                        source,
                    );
                }
            }
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "unsupported D08 protocol in capital import",
                ))
            }
        }
    }

    rejections.sort_by(|left, right| {
        (
            left.protocol.as_str(),
            left.market_id.as_str(),
            left.asset,
            left.reason,
        )
            .cmp(&(
                right.protocol.as_str(),
                right.market_id.as_str(),
                right.asset,
                right.reason,
            ))
    });
    sources.sort_by_key(CapitalSource::id);
    let candidate_count = candidate_keys.len();
    let admitted_count = sources.len();
    let rejected_count = rejections.len();
    if outcomes.len() != candidate_count || candidate_count != admitted_count + rejected_count {
        return Err(CapitalError::InvalidCanonical(
            "D08 capital source classification is not conserved",
        ));
    }
    let coverage_commitment = coverage_commitment(&mut outcomes)?;
    Ok(D08CapitalImport {
        candidate_count,
        admitted_count,
        rejected_count,
        coverage_commitment,
        sources,
        rejections,
    })
}
