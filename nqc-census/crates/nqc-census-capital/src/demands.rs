//! Strict RMC-009 borrower-demand boundary for RMC-011.
//!
//! RMC-009 proves the account/position universe and exposes borrowers and the
//! protocol-reported health factor, but its own contract explicitly does NOT
//! certify liquidatability. This module preserves that boundary: it imports
//! exact positions and identifies below-one-health-factor accounts, while
//! refusing to fabricate a liquidation capital requirement until exact
//! liquidation sizing semantics are certified downstream.

use crate::{Amount256, CapitalError};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum DemandBlockerReason {
    AccountDataUnavailable,
    HealthFactorNotBelowOne,
    LiquidatabilityNotCertifiedByRmc009,
}

impl DemandBlockerReason {
    pub const fn code(self) -> &'static str {
        match self {
            Self::AccountDataUnavailable => "ACCOUNT_DATA_UNAVAILABLE",
            Self::HealthFactorNotBelowOne => "HEALTH_FACTOR_NOT_BELOW_ONE",
            Self::LiquidatabilityNotCertifiedByRmc009 => "LIQUIDATABILITY_NOT_CERTIFIED_BY_RMC009",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PositionAmount {
    pub market_id: String,
    pub asset: Address,
    pub token: Address,
    pub scaled: Amount256,
    pub balance: Amount256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BorrowerDemandCandidate {
    pub account: Address,
    pub supply_positions: Vec<PositionAmount>,
    pub debt_positions: Vec<PositionAmount>,
    pub health_factor_below_one: Option<bool>,
    pub blocker: Option<DemandBlockerReason>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct D09DemandImport {
    pub borrowers: Vec<BorrowerDemandCandidate>,
    pub borrower_count: usize,
    pub below_one_count: usize,
    pub not_below_one_count: usize,
    pub unavailable_count: usize,
    pub blocked_count: usize,
    pub requirements_certified: usize,
    pub coverage_commitment: Hash32,
}

impl D09DemandImport {
    pub const fn is_conserved(&self) -> bool {
        self.borrower_count
            == self.below_one_count + self.not_below_one_count + self.unavailable_count
            && self.blocked_count == self.borrower_count
            && self.requirements_certified == 0
    }
}

fn required<'a>(value: &'a Json, key: &'static str) -> Result<&'a Json, CapitalError> {
    value
        .get(key)
        .ok_or(CapitalError::InvalidCanonical("missing RMC-009 field"))
}

fn text<'a>(value: &'a Json, key: &'static str) -> Result<&'a str, CapitalError> {
    required(value, key)?
        .as_str()
        .ok_or(CapitalError::InvalidCanonical("RMC-009 field is not text"))
}

fn number(value: &Json, key: &'static str) -> Result<u64, CapitalError> {
    required(value, key)?
        .as_i64()
        .and_then(|number| u64::try_from(number).ok())
        .ok_or(CapitalError::InvalidCanonical(
            "RMC-009 field is not nonnegative integer",
        ))
}

fn parse_jsonl(bytes: &[u8]) -> Result<Vec<Json>, CapitalError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("RMC-009 JSONL is not UTF-8"))?;
    let mut rows = Vec::new();
    for line in text.lines() {
        if line.is_empty() {
            continue;
        }
        rows.push(
            Json::parse(line.as_bytes())
                .map_err(|_| CapitalError::InvalidCanonical("RMC-009 JSONL parse failed"))?,
        );
    }
    Ok(rows)
}

fn parse_position(row: &Json) -> Result<PositionAmount, CapitalError> {
    Ok(PositionAmount {
        market_id: text(row, "market_id")?.to_owned(),
        asset: Address::parse_hex(text(row, "asset")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid RMC-009 position asset"))?,
        token: Address::parse_hex(text(row, "token")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid RMC-009 position token"))?,
        scaled: Amount256::parse_decimal(text(row, "scaled")?)?,
        balance: Amount256::parse_decimal(text(row, "balance")?)?,
    })
}

fn parse_positions(account: &Json, key: &'static str) -> Result<Vec<PositionAmount>, CapitalError> {
    let rows = required(account, key)?
        .as_array()
        .ok_or(CapitalError::InvalidCanonical(
            "RMC-009 positions field is not array",
        ))?;
    let mut positions = rows
        .iter()
        .map(parse_position)
        .collect::<Result<Vec<_>, _>>()?;
    positions.sort_by(|left, right| {
        (
            left.market_id.as_str(),
            left.asset,
            left.token,
            left.scaled,
            left.balance,
        )
            .cmp(&(
                right.market_id.as_str(),
                right.asset,
                right.token,
                right.scaled,
                right.balance,
            ))
    });
    if positions.windows(2).any(|pair| {
        pair[0].market_id == pair[1].market_id
            && pair[0].asset == pair[1].asset
            && pair[0].token == pair[1].token
    }) {
        return Err(CapitalError::InvalidCanonical(
            "duplicate RMC-009 position identity",
        ));
    }
    Ok(positions)
}

fn verify_summary(summary: &Json, anchor: &StateAnchor) -> Result<(), CapitalError> {
    if text(summary, "status")? != "RMC_009_PASS_CANDIDATE" {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 summary is not PASS candidate",
        ));
    }
    if required(summary, "all_tokens_conserved")?.as_bool() != Some(true) {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 token universe is not conserved",
        ));
    }
    if number(summary, "unexplained_mismatches")? != 0 {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 has unexplained mismatches",
        ));
    }
    let findings = required(summary, "blocking_findings")?.as_array().ok_or(
        CapitalError::InvalidCanonical("RMC-009 blocking findings are not array"),
    )?;
    if !findings.is_empty() {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 has blocking findings",
        ));
    }
    let summary_anchor = required(summary, "anchor")?;
    if number(summary_anchor, "number")? != anchor.block_number()
        || text(summary_anchor, "hash")? != anchor.block_hash().to_hex()
    {
        return Err(CapitalError::AnchorMismatch);
    }
    let non_claims =
        required(summary, "non_claims")?
            .as_array()
            .ok_or(CapitalError::InvalidCanonical(
                "RMC-009 non-claims are not array",
            ))?;
    if !non_claims
        .iter()
        .any(|value| value.as_str() == Some("LIQUIDATABILITY_NOT_CLAIMED"))
    {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 liquidatability boundary disappeared",
        ));
    }
    Ok(())
}

fn hash_len_prefixed(hasher: &mut Sha256, value: &[u8]) {
    hasher.update(u64::try_from(value.len()).unwrap_or(u64::MAX).to_be_bytes());
    hasher.update(value);
}

fn hash_position(hasher: &mut Sha256, position: &PositionAmount) {
    hash_len_prefixed(hasher, position.market_id.as_bytes());
    hasher.update(position.asset.as_bytes());
    hasher.update(position.token.as_bytes());
    hasher.update(position.scaled.as_be_bytes());
    hasher.update(position.balance.as_be_bytes());
}

fn demand_coverage_commitment(
    borrowers: &[BorrowerDemandCandidate],
    anchor: &StateAnchor,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-D09-DEMAND-COVERAGE-V1");
    hasher.update([0]);
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
    hasher.update(
        u64::try_from(borrowers.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );

    for borrower in borrowers {
        hasher.update(borrower.account.as_bytes());
        match borrower.health_factor_below_one {
            None => hasher.update([0]),
            Some(false) => hasher.update([1]),
            Some(true) => hasher.update([2]),
        }
        let blocker = borrower.blocker.ok_or(CapitalError::InvalidCanonical(
            "RMC-009 borrower classification lacks blocker",
        ))?;
        hash_len_prefixed(&mut hasher, blocker.code().as_bytes());

        hasher.update(
            u64::try_from(borrower.supply_positions.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for position in &borrower.supply_positions {
            hash_position(&mut hasher, position);
        }
        hasher.update(
            u64::try_from(borrower.debt_positions.len())
                .unwrap_or(u64::MAX)
                .to_be_bytes(),
        );
        for position in &borrower.debt_positions {
            hash_position(&mut hasher, position);
        }
    }

    let digest = hasher.finalize();
    let mut bytes = [0_u8; 32];
    bytes.copy_from_slice(&digest);
    Hash32::new(bytes)
        .map_err(|_| CapitalError::InvalidCanonical("zero RMC-009 demand coverage commitment"))
}

pub fn import_d09_borrower_demands(
    account_manifest_jsonl: &[u8],
    account_summary_json: &[u8],
    anchor: &StateAnchor,
) -> Result<D09DemandImport, CapitalError> {
    let summary = Json::parse(account_summary_json)
        .map_err(|_| CapitalError::InvalidCanonical("RMC-009 summary JSON parse failed"))?;
    verify_summary(&summary, anchor)?;

    let mut borrowers = Vec::new();
    let mut seen_accounts = BTreeSet::new();
    let mut below_one_count = 0_usize;
    let mut not_below_one_count = 0_usize;
    let mut unavailable_count = 0_usize;
    for row in parse_jsonl(account_manifest_jsonl)? {
        let account = Address::parse_hex(text(&row, "account")?)
            .map_err(|_| CapitalError::InvalidCanonical("invalid RMC-009 account"))?;
        if !seen_accounts.insert(account) {
            return Err(CapitalError::InvalidCanonical("duplicate RMC-009 account"));
        }
        let debt_positions = parse_positions(&row, "debt_positions")?;
        if debt_positions.is_empty() {
            continue;
        }
        let supply_positions = parse_positions(&row, "supply_positions")?;
        let below = match required(&row, "health_factor_below_one")? {
            Json::Bool(value) => Some(*value),
            Json::Null => None,
            _ => {
                return Err(CapitalError::InvalidCanonical(
                    "RMC-009 health-factor classification is malformed",
                ))
            }
        };
        let blocker =
            match below {
                None => {
                    unavailable_count =
                        unavailable_count
                            .checked_add(1)
                            .ok_or(CapitalError::InvalidCanonical(
                                "unavailable borrower count overflow",
                            ))?;
                    Some(DemandBlockerReason::AccountDataUnavailable)
                }
                Some(true) => {
                    below_one_count =
                        below_one_count
                            .checked_add(1)
                            .ok_or(CapitalError::InvalidCanonical(
                                "below-one borrower count overflow",
                            ))?;
                    Some(DemandBlockerReason::LiquidatabilityNotCertifiedByRmc009)
                }
                Some(false) => {
                    not_below_one_count = not_below_one_count.checked_add(1).ok_or(
                        CapitalError::InvalidCanonical("not-below-one borrower count overflow"),
                    )?;
                    Some(DemandBlockerReason::HealthFactorNotBelowOne)
                }
            };
        borrowers.push(BorrowerDemandCandidate {
            account,
            supply_positions,
            debt_positions,
            health_factor_below_one: below,
            blocker,
        });
    }
    borrowers.sort_by_key(|candidate| candidate.account);
    let borrower_count = borrowers.len();
    let blocked_count = borrowers
        .iter()
        .filter(|candidate| candidate.blocker.is_some())
        .count();
    if borrower_count != below_one_count + not_below_one_count + unavailable_count
        || blocked_count != borrower_count
    {
        return Err(CapitalError::InvalidCanonical(
            "RMC-009 borrower demand classification is not conserved",
        ));
    }
    let coverage_commitment = demand_coverage_commitment(&borrowers, anchor)?;

    // Deliberately zero: RMC-009 says, in its own closeout contract,
    // LIQUIDATABILITY_NOT_CLAIMED. A later exact liquidation-sizing bridge
    // must remove the blocker before any CapitalRequirement is constructed.
    Ok(D09DemandImport {
        borrowers,
        borrower_count,
        below_one_count,
        not_below_one_count,
        unavailable_count,
        blocked_count,
        requirements_certified: 0,
        coverage_commitment,
    })
}
