//! RMC-009 inputs: the admitted D06 outputs, pinned by sha256.
//!
//! Besides the deployment and reserve manifests (read through RMC-008's D06
//! reader), RMC-009 reads the D06 history report: its `ReserveInitialized`
//! records are the only source of token addresses and index start blocks.

use crate::plan::{AccountPlan, ReserveTokens};
use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::Address;
use nqc_census_state::inputs::{require_anchor, D06Inputs};
use nqc_census_state::stage::AnchorPlan;
use std::collections::BTreeMap;
use std::path::Path;

pub const D06_HISTORY_SCHEMA: &str = "nqc-rmc-006-aave-history-reconciliation-v2";

fn address(value: &Json, key: &str) -> Result<Address, ChainError> {
    Ok(Address::parse_hex(value.str_field(key)?)?)
}

fn optional_address(value: &Json, key: &str) -> Result<Option<Address>, ChainError> {
    match value.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(text)) => Ok(Some(Address::parse_hex(text)?)),
        Some(_) => Err(ChainError::Evidence(format!("{key} is not an address"))),
    }
}

/// Admitted D06 deployment plus the reserve token lifecycle.
#[derive(Debug, Clone)]
pub struct AccountInputs {
    pub d06: D06Inputs,
    pub reserves: Vec<ReserveTokens>,
}

impl AccountInputs {
    pub fn read(
        current_surface: &Path,
        deployment_manifest: &Path,
        reserve_manifest: &Path,
        history: &Path,
        anchor: &AnchorPlan,
    ) -> Result<Self, ChainError> {
        let d06 = D06Inputs::read(
            current_surface,
            deployment_manifest,
            reserve_manifest,
            anchor,
        )?;
        let bytes = std::fs::read(history)
            .map_err(|error| ChainError::Config(format!("{}: {error}", history.display())))?;
        let report = Json::parse(&bytes)?;
        Self::from_history(d06, &report, anchor)
    }

    pub fn from_history(
        d06: D06Inputs,
        report: &Json,
        anchor: &AnchorPlan,
    ) -> Result<Self, ChainError> {
        if report.get("schema").and_then(Json::as_str) != Some(D06_HISTORY_SCHEMA) {
            return Err(ChainError::Evidence(format!(
                "D06 history schema is not {D06_HISTORY_SCHEMA}"
            )));
        }
        if report.get("status").and_then(Json::as_str) != Some("HISTORY_RECONCILIATION_PASS") {
            return Err(ChainError::Evidence(
                "D06 history reconciliation did not pass".into(),
            ));
        }
        require_anchor(report, anchor, "D06 history")?;
        let summary = report
            .get("summary")
            .ok_or_else(|| ChainError::Evidence("D06 history without summary".into()))?;
        for key in ["unexplained_delta_count", "provider_mismatch_count"] {
            if summary.get(key).and_then(Json::as_i64) != Some(0) {
                return Err(ChainError::Evidence(format!("D06 history {key} is not 0")));
            }
        }
        let admitted: BTreeMap<Address, (String, Option<u16>)> = d06
            .reserves
            .iter()
            .map(|reserve| {
                (
                    reserve.asset,
                    (reserve.market_id.clone(), reserve.reserve_id),
                )
            })
            .collect();
        let events = report
            .get("reserve_events")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("D06 history without reserve events".into()))?;
        let mut initializations: Vec<ReserveTokens> = Vec::new();
        for event in events {
            if event.str_field("kind")? != "RESERVE_INITIALIZED" {
                continue;
            }
            let asset = address(event, "asset")?;
            let (market_id, _) = admitted.get(&asset).ok_or_else(|| {
                ChainError::Evidence(format!(
                    "initialized reserve {} is not admitted by D06",
                    asset.to_hex()
                ))
            })?;
            let block = event
                .get("block")
                .and_then(Json::as_i64)
                .and_then(|value| u64::try_from(value).ok())
                .ok_or_else(|| ChainError::Evidence("reserve event block missing".into()))?;
            initializations.push(ReserveTokens {
                asset,
                market_id: market_id.clone(),
                reserve_id: None,
                a_token: address(event, "a_token")?,
                variable_debt_token: address(event, "variable_debt_token")?,
                stable_debt_token: optional_address(event, "stable_debt_token")?,
                initialized_block: block,
            });
        }
        // The latest initialization of a current reserve carries its id;
        // every other initialization is historical.
        for (asset, (_, reserve_id)) in &admitted {
            let Some(id) = reserve_id else { continue };
            let latest = initializations
                .iter_mut()
                .rev()
                .find(|reserve| reserve.asset == *asset)
                .ok_or_else(|| {
                    ChainError::Evidence(format!(
                        "current reserve {} has no initialization event",
                        asset.to_hex()
                    ))
                })?;
            latest.reserve_id = Some(*id);
        }
        Ok(Self {
            d06,
            reserves: initializations,
        })
    }

    pub fn plan(
        &self,
        anchor: AnchorPlan,
        job_span: u64,
        job_accounts: usize,
    ) -> Result<AccountPlan, ChainError> {
        AccountPlan::new(
            anchor,
            self.d06.deployment.address(),
            self.reserves.clone(),
            job_span,
            job_accounts,
        )
    }
}

/// The declared census anchor (the mainnet observation anchor) unless both
/// `--anchor-number` and `--anchor-hash` are given; one without the other is
/// refused.
pub fn anchor_from_flags(
    number: Option<&str>,
    hash: Option<&str>,
) -> Result<AnchorPlan, ChainError> {
    match (number, hash) {
        (None, None) => AnchorPlan::mainnet(),
        (Some(number), Some(hash)) => Ok(AnchorPlan {
            profile: nqc_census_chain::ethereum::ChainProfile::mainnet()?,
            number: number
                .parse()
                .map_err(|_| ChainError::Config("anchor number is not an integer".into()))?,
            hash: nqc_census_core::Hash32::parse_hex(hash)?,
        }),
        _ => Err(ChainError::Config(
            "--anchor-number and --anchor-hash go together".into(),
        )),
    }
}

/// The plan at `anchor` from the pinned D06 inputs (roles
/// `d06_current_surface`, `d06_deployment_manifest`, `d06_reserve_manifest`,
/// `d06_history`), which must have been acquired at that anchor.
pub fn plan_at(
    pins: &[nqc_census_state::inputs::PinnedFile],
    anchor: AnchorPlan,
) -> Result<AccountPlan, ChainError> {
    use nqc_census_state::inputs::pinned;
    let inputs = AccountInputs::read(
        pinned(pins, "d06_current_surface")?,
        pinned(pins, "d06_deployment_manifest")?,
        pinned(pins, "d06_reserve_manifest")?,
        pinned(pins, "d06_history")?,
        &anchor,
    )?;
    inputs.plan(
        anchor,
        crate::plan::MAINNET_JOB_SPAN,
        crate::plan::MAINNET_JOB_ACCOUNTS,
    )
}

/// The plan at the declared mainnet anchor.
pub fn mainnet_plan(
    pins: &[nqc_census_state::inputs::PinnedFile],
) -> Result<AccountPlan, ChainError> {
    plan_at(pins, AnchorPlan::mainnet()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchor_flags_default_to_the_declared_anchor_and_go_together() -> Result<(), ChainError> {
        let declared = AnchorPlan::mainnet()?;
        let default = anchor_from_flags(None, None)?;
        assert_eq!(
            (default.number, default.hash),
            (declared.number, declared.hash)
        );
        let hash = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
        let explicit = anchor_from_flags(Some("25437474"), Some(hash))?;
        assert_eq!(explicit.number, 25_437_474);
        assert!(anchor_from_flags(Some("25437474"), None).is_err());
        assert!(anchor_from_flags(None, Some(hash)).is_err());
        assert!(anchor_from_flags(Some("x"), Some(hash)).is_err());
        Ok(())
    }
}
