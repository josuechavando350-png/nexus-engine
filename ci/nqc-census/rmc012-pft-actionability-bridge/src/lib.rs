//! RMC-012 isolated bridge to immutable Protocol/Fork Truth Aave liquidation math.
//!
//! This package deliberately lives outside the nqc-census workspace. It lets
//! RMC-012 execute the certified PFT math without importing the recovered PFT
//! dependency graph into the Census workspace or copying liquidation formulas.

use alloy::primitives::U256;
use pft_nqc_aave_math::{
    calculate_available_collateral_to_liquidate, max_liquidatable_debt, AvailableCollateralInput,
    LiquidationSizingInput, LIQUIDATION_HF_WAD,
};
use sha2::{Digest, Sha256};
use std::fmt::{Display, Formatter};

pub const PFT_CERTIFIED_COMMIT: &str = "5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf";
pub const PFT_CERTIFIED_TREE: &str = "ef3498da528f85cdb9fdd82222d64773a557f853";
const RESULT_DOMAIN: &[u8] = b"NQC-RMC012-PFT-ACTIONABILITY-RESULT-V1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BridgeError {
    ZeroSnapshotCommitment,
    InvalidLiquidationParameters,
    PftMath,
}

impl Display for BridgeError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroSnapshotCommitment => {
                f.write_str("PFT actionability input has a zero snapshot commitment")
            }
            Self::InvalidLiquidationParameters => {
                f.write_str("PFT actionability input has invalid liquidation parameters")
            }
            Self::PftMath => f.write_str("certified PFT liquidation math rejected the input"),
        }
    }
}

impl std::error::Error for BridgeError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairRejection {
    HealthFactorNotBelowOne,
    CollateralNotEnabled,
    CollateralReserveIneligible,
    DebtReserveIneligible,
    UnknownEmodeCategory,
    SnapshotMismatch,
    UnsupportedPosition,
    PftMathRejected,
}

impl PairRejection {
    pub const fn code(self) -> &'static str {
        match self {
            Self::HealthFactorNotBelowOne => "HEALTH_FACTOR_NOT_BELOW_ONE",
            Self::CollateralNotEnabled => "COLLATERAL_NOT_ENABLED",
            Self::CollateralReserveIneligible => "COLLATERAL_RESERVE_INELIGIBLE",
            Self::DebtReserveIneligible => "DEBT_RESERVE_INELIGIBLE",
            Self::UnknownEmodeCategory => "UNKNOWN_EMODE_CATEGORY",
            Self::SnapshotMismatch => "SNAPSHOT_MISMATCH",
            Self::UnsupportedPosition => "UNSUPPORTED_POSITION",
            Self::PftMathRejected => "PFT_MATH_REJECTED",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PairInput {
    pub health_factor_wad: U256,
    pub total_debt_base_wad: U256,
    pub reserve_debt_amount: U256,
    pub reserve_debt_base_wad: U256,
    pub reserve_collateral_base_wad: U256,
    pub borrower_collateral_balance: U256,
    pub collateral_price_base_wad: U256,
    pub collateral_asset_unit: U256,
    pub debt_price_base_wad: U256,
    pub debt_asset_unit: U256,
    pub min_base_max_close_factor_threshold_wad: U256,
    pub liquidation_bonus_bps: u32,
    pub liquidation_protocol_fee_bps: u32,
    pub collateral_enabled: bool,
    pub collateral_reserve_eligible: bool,
    pub debt_reserve_eligible: bool,
    pub emode_resolved: bool,
    pub snapshots_match: bool,
    pub pft_market_snapshot: [u8; 32],
    pub pft_account_snapshot: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SizedLiquidation {
    pub debt_to_liquidate: U256,
    pub collateral_to_liquidator: U256,
    pub liquidation_protocol_fee_collateral: U256,
    pub result_commitment: [u8; 32],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PairDecision {
    Admitted(SizedLiquidation),
    Rejected(PairRejection),
}

fn zero32(value: &[u8; 32]) -> bool {
    value.iter().all(|byte| *byte == 0)
}

/// Execute the immutable certified PFT liquidation sizing for one exact
/// borrower/collateral/debt pair.
///
/// Protocol validity is decided here. Economic policy is intentionally absent:
/// this function does not inspect flash liquidity, gas, routing, oracle edge,
/// MEV, capture probability or profit.
pub fn classify_pair(input: PairInput) -> Result<PairDecision, BridgeError> {
    if zero32(&input.pft_market_snapshot) || zero32(&input.pft_account_snapshot) {
        return Err(BridgeError::ZeroSnapshotCommitment);
    }
    if input.health_factor_wad >= U256::from(LIQUIDATION_HF_WAD) {
        return Ok(PairDecision::Rejected(
            PairRejection::HealthFactorNotBelowOne,
        ));
    }
    if !input.collateral_enabled {
        return Ok(PairDecision::Rejected(PairRejection::CollateralNotEnabled));
    }
    if !input.collateral_reserve_eligible {
        return Ok(PairDecision::Rejected(
            PairRejection::CollateralReserveIneligible,
        ));
    }
    if !input.debt_reserve_eligible {
        return Ok(PairDecision::Rejected(PairRejection::DebtReserveIneligible));
    }
    if !input.emode_resolved {
        return Ok(PairDecision::Rejected(PairRejection::UnknownEmodeCategory));
    }
    if !input.snapshots_match {
        return Ok(PairDecision::Rejected(PairRejection::SnapshotMismatch));
    }
    if input.reserve_debt_amount == U256::ZERO || input.borrower_collateral_balance == U256::ZERO {
        return Ok(PairDecision::Rejected(PairRejection::UnsupportedPosition));
    }
    if input.collateral_price_base_wad == U256::ZERO
        || input.collateral_asset_unit == U256::ZERO
        || input.debt_price_base_wad == U256::ZERO
        || input.debt_asset_unit == U256::ZERO
        || input.liquidation_bonus_bps < 10_000
        || input.liquidation_protocol_fee_bps > 10_000
    {
        return Err(BridgeError::InvalidLiquidationParameters);
    }

    let debt_to_cover = max_liquidatable_debt(LiquidationSizingInput {
        health_factor_wad: input.health_factor_wad,
        total_debt_base_wad: input.total_debt_base_wad,
        reserve_debt_amount: input.reserve_debt_amount,
        reserve_debt_base_wad: input.reserve_debt_base_wad,
        reserve_collateral_base_wad: input.reserve_collateral_base_wad,
        debt_asset_price_base_wad: input.debt_price_base_wad,
        debt_asset_unit: input.debt_asset_unit,
        min_base_max_close_factor_threshold_wad: input.min_base_max_close_factor_threshold_wad,
    })
    .map_err(|_| BridgeError::PftMath)?;

    if debt_to_cover == U256::ZERO {
        return Ok(PairDecision::Rejected(PairRejection::PftMathRejected));
    }

    let sized = calculate_available_collateral_to_liquidate(AvailableCollateralInput {
        collateral_price_base_wad: input.collateral_price_base_wad,
        collateral_asset_unit: input.collateral_asset_unit,
        debt_price_base_wad: input.debt_price_base_wad,
        debt_asset_unit: input.debt_asset_unit,
        debt_to_cover,
        borrower_collateral_balance: input.borrower_collateral_balance,
        liquidation_bonus_bps: input.liquidation_bonus_bps,
        liquidation_protocol_fee_bps: input.liquidation_protocol_fee_bps,
    })
    .map_err(|_| BridgeError::PftMath)?;

    if sized.debt_to_liquidate == U256::ZERO || sized.collateral_to_liquidator == U256::ZERO {
        return Ok(PairDecision::Rejected(PairRejection::PftMathRejected));
    }

    let mut hasher = Sha256::new();
    hasher.update(RESULT_DOMAIN);
    hasher.update([0]);
    for value in [
        input.health_factor_wad,
        input.total_debt_base_wad,
        input.reserve_debt_amount,
        input.reserve_debt_base_wad,
        input.reserve_collateral_base_wad,
        input.borrower_collateral_balance,
        input.collateral_price_base_wad,
        input.collateral_asset_unit,
        input.debt_price_base_wad,
        input.debt_asset_unit,
        input.min_base_max_close_factor_threshold_wad,
        sized.debt_to_liquidate,
        sized.collateral_to_liquidator,
        sized.liquidation_protocol_fee_collateral,
    ] {
        hasher.update(value.to_be_bytes::<32>());
    }
    hasher.update(input.liquidation_bonus_bps.to_be_bytes());
    hasher.update(input.liquidation_protocol_fee_bps.to_be_bytes());
    hasher.update(input.pft_market_snapshot);
    hasher.update(input.pft_account_snapshot);

    Ok(PairDecision::Admitted(SizedLiquidation {
        debt_to_liquidate: sized.debt_to_liquidate,
        collateral_to_liquidator: sized.collateral_to_liquidator,
        liquidation_protocol_fee_collateral: sized.liquidation_protocol_fee_collateral,
        result_commitment: hasher.finalize().into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    type TestResult = Result<(), Box<dyn Error>>;
    const WAD: u64 = 1_000_000_000_000_000_000;

    fn wad(value: u64) -> U256 {
        U256::from(value) * U256::from(WAD)
    }

    fn input(health_factor_wad: u64) -> PairInput {
        PairInput {
            health_factor_wad: U256::from(health_factor_wad),
            total_debt_base_wad: wad(10_000),
            reserve_debt_amount: wad(8_000),
            reserve_debt_base_wad: wad(8_000),
            reserve_collateral_base_wad: wad(10_000),
            borrower_collateral_balance: wad(10),
            collateral_price_base_wad: wad(2_000),
            collateral_asset_unit: wad(1),
            debt_price_base_wad: wad(1),
            debt_asset_unit: wad(1),
            min_base_max_close_factor_threshold_wad: wad(2_000),
            liquidation_bonus_bps: 10_500,
            liquidation_protocol_fee_bps: 1_000,
            collateral_enabled: true,
            collateral_reserve_eligible: true,
            debt_reserve_eligible: true,
            emode_resolved: true,
            snapshots_match: true,
            pft_market_snapshot: [1; 32],
            pft_account_snapshot: [2; 32],
        }
    }

    #[test]
    fn default_close_factor_uses_certified_pft_math() -> TestResult {
        let decision = classify_pair(input(960_000_000_000_000_000))?;
        let PairDecision::Admitted(sized) = decision else {
            return Err("expected admitted liquidation".into());
        };
        assert_eq!(sized.debt_to_liquidate, wad(5_000));
        assert_ne!(sized.result_commitment, [0; 32]);
        Ok(())
    }

    #[test]
    fn full_close_below_point_95_uses_certified_pft_math() -> TestResult {
        let decision = classify_pair(input(940_000_000_000_000_000))?;
        let PairDecision::Admitted(sized) = decision else {
            return Err("expected admitted liquidation".into());
        };
        assert_eq!(sized.debt_to_liquidate, wad(8_000));
        Ok(())
    }

    #[test]
    fn collateral_disabled_is_classified_not_dropped() -> TestResult {
        let mut value = input(940_000_000_000_000_000);
        value.collateral_enabled = false;
        assert_eq!(
            classify_pair(value)?,
            PairDecision::Rejected(PairRejection::CollateralNotEnabled)
        );
        Ok(())
    }

    #[test]
    fn economics_cannot_erase_protocol_actionability() -> TestResult {
        let value = input(940_000_000_000_000_000);
        // PairInput deliberately has no flash-liquidity, gas, route, MEV,
        // capture-probability or profitability fields.
        assert!(matches!(classify_pair(value)?, PairDecision::Admitted(_)));
        Ok(())
    }

    #[test]
    fn zero_snapshot_commitment_fails_closed() {
        let mut value = input(940_000_000_000_000_000);
        value.pft_market_snapshot = [0; 32];
        assert_eq!(
            classify_pair(value),
            Err(BridgeError::ZeroSnapshotCommitment)
        );
    }
}
