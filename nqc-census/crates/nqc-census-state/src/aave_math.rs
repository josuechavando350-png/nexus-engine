//! Aave V3 index and balance arithmetic, integer-exact.
//!
//! Only arithmetic whose deployed semantics are measured exactly is kept:
//!
//! - normalized income: linear interest then `rayMul` half-up (the formula
//!   of `recovered-source/crates/nqc-aave-math`, PFT-SRC-003); measured
//!   exact on all 67 reserves at the anchor;
//! - token balances: aToken `rayMul` floor, variable-debt `rayMul` ceil
//!   (PFT-COMPAT-008); measured exact on all 67 reserves.
//!
//! The variable-debt compounding formula of the deployed pool (revision 11)
//! differs from the PFT-recovered three-term binomial, so it is not
//! reimplemented here: the census uses the protocol's own getter for it.
//! These functions only cross-check the protocol's getters; a disagreement
//! is a mismatch, never a correction.

use crate::uint::{ray, MathError, U256};

pub const SECONDS_PER_YEAR: u64 = 365 * 24 * 60 * 60;

pub fn ray_mul_half_up(a: U256, b: U256) -> Result<U256, MathError> {
    U256::mul_div_half_up(a, b, ray())
}

pub fn ray_mul_floor(a: U256, b: U256) -> Result<U256, MathError> {
    U256::mul_div_floor(a, b, ray())
}

pub fn ray_mul_ceil(a: U256, b: U256) -> Result<U256, MathError> {
    U256::mul_div_ceil(a, b, ray())
}

pub fn linear_interest(rate: U256, last: u64, now: u64) -> Result<U256, MathError> {
    let elapsed = now.checked_sub(last).ok_or(MathError::Underflow)?;
    let accrued = rate
        .checked_mul(U256::from_u64(elapsed))?
        .checked_div(U256::from_u64(SECONDS_PER_YEAR))?;
    ray().checked_add(accrued)
}

/// `getReserveNormalizedIncome` recomputed from stored reserve data.
pub fn normalized_income(
    liquidity_index: U256,
    liquidity_rate: U256,
    last_update: u64,
    now: u64,
) -> Result<U256, MathError> {
    if now == last_update {
        return Ok(liquidity_index);
    }
    ray_mul_half_up(
        linear_interest(liquidity_rate, last_update, now)?,
        liquidity_index,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(text: &str) -> Result<U256, MathError> {
        U256::parse_decimal(text)
    }

    #[test]
    fn zero_elapsed_keeps_the_index() -> Result<(), MathError> {
        let index = dec("1034567890123456789012345678")?;
        assert_eq!(
            normalized_income(index, dec("50000000000000000000000000")?, 7, 7)?,
            index
        );
        assert_eq!(
            linear_interest(U256::from_u64(5), 9, 8),
            Err(MathError::Underflow)
        );
        Ok(())
    }

    #[test]
    fn income_matches_a_live_reserve_exactly() -> Result<(), MathError> {
        // WETH reserve at anchor 25,437,474 (probe v5, both providers): the
        // stored index and rate, 12 s after the last update, reproduce
        // getReserveNormalizedIncome exactly.
        let income = normalized_income(
            dec("1067536594946887619941860510")?,
            dec("14350199782030829271363414")?,
            1_782_906_575,
            1_782_906_587,
        )?;
        assert_eq!(income.to_decimal(), "1067536600776173545404859139");
        let rate = dec("50000000000000000000000000")?;
        assert_eq!(
            linear_interest(rate, 0, SECONDS_PER_YEAR)?.to_decimal(),
            "1050000000000000000000000000"
        );
        Ok(())
    }

    #[test]
    fn balance_rounding_modes_differ_only_by_remainder() -> Result<(), MathError> {
        let scaled = dec("123456789")?;
        let index = dec("1500000000000000000000000001")?;
        assert_eq!(ray_mul_floor(scaled, index)?.to_decimal(), "185185183");
        assert_eq!(ray_mul_ceil(scaled, index)?.to_decimal(), "185185184");
        assert_eq!(ray_mul_half_up(scaled, index)?.to_decimal(), "185185184");
        Ok(())
    }
}
