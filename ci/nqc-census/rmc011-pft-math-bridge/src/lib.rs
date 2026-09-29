//! RMC-011 isolated bridge to the immutable Protocol/Fork Truth Aave math.
//!
//! This crate intentionally lives outside the nqc-census workspace so the
//! certified Census dependency graph and Cargo.lock remain unchanged.

pub use alloy::primitives::U256;
pub use pft_nqc_aave_math::{
    calculate_available_collateral_to_liquidate, max_liquidatable_debt, AvailableCollateralInput,
    AvailableCollateralResult, LiquidationSizingInput, DEFAULT_CLOSE_FACTOR_BPS,
    FULL_CLOSE_HF_WAD, LIQUIDATION_HF_WAD, MAX_CLOSE_FACTOR_BPS,
};

pub const PFT_CERTIFIED_COMMIT: &str = "5b4a0cb778cb4370cd54eb6fcba765dc8d7cecdf";
pub const PFT_CERTIFIED_TREE: &str = "ef3498da528f85cdb9fdd82222d64773a557f853";
pub const WAD: u64 = 1_000_000_000_000_000_000;

#[must_use]
pub fn wad(value: u64) -> U256 {
    U256::from(value) * U256::from(WAD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error;

    type TestResult = Result<(), Box<dyn Error>>;

    #[test]
    fn certified_identity_and_close_factor_constants_are_frozen() {
        assert_eq!(PFT_CERTIFIED_COMMIT.len(), 40);
        assert_eq!(PFT_CERTIFIED_TREE.len(), 40);
        assert_eq!(LIQUIDATION_HF_WAD, WAD);
        assert_eq!(FULL_CLOSE_HF_WAD, 950_000_000_000_000_000);
        assert_eq!(DEFAULT_CLOSE_FACTOR_BPS, 5_000);
        assert_eq!(MAX_CLOSE_FACTOR_BPS, 10_000);
    }

    #[test]
    fn default_close_and_full_close_vectors_are_integer_exact() -> TestResult {
        let default_close = max_liquidatable_debt(LiquidationSizingInput {
            health_factor_wad: U256::from(960_000_000_000_000_000_u64),
            total_debt_base_wad: wad(10_000),
            reserve_debt_amount: wad(8_000),
            reserve_debt_base_wad: wad(8_000),
            reserve_collateral_base_wad: wad(10_000),
            debt_asset_price_base_wad: wad(1),
            debt_asset_unit: wad(1),
            min_base_max_close_factor_threshold_wad: wad(2_000),
        })?;
        assert_eq!(default_close, wad(5_000));

        let full_close = max_liquidatable_debt(LiquidationSizingInput {
            health_factor_wad: U256::from(940_000_000_000_000_000_u64),
            total_debt_base_wad: wad(10_000),
            reserve_debt_amount: wad(8_000),
            reserve_debt_base_wad: wad(8_000),
            reserve_collateral_base_wad: wad(10_000),
            debt_asset_price_base_wad: wad(1),
            debt_asset_unit: wad(1),
            min_base_max_close_factor_threshold_wad: wad(2_000),
        })?;
        assert_eq!(full_close, wad(8_000));
        Ok(())
    }

    #[test]
    fn collateral_bonus_and_protocol_fee_vector_is_integer_exact() -> TestResult {
        let result = calculate_available_collateral_to_liquidate(AvailableCollateralInput {
            collateral_price_base_wad: wad(2_000),
            collateral_asset_unit: wad(1),
            debt_price_base_wad: wad(1),
            debt_asset_unit: wad(1),
            debt_to_cover: wad(10_000),
            borrower_collateral_balance: wad(10),
            liquidation_bonus_bps: 10_500,
            liquidation_protocol_fee_bps: 1_000,
        })?;
        assert_eq!(result.debt_to_liquidate, wad(10_000));
        assert_eq!(
            result.liquidation_protocol_fee_collateral,
            U256::from(WAD) / U256::from(40_u8)
        );
        assert_eq!(
            result.collateral_to_liquidator,
            wad(5) + U256::from(WAD) * U256::from(225_u16) / U256::from(1_000_u16)
        );
        Ok(())
    }
}
