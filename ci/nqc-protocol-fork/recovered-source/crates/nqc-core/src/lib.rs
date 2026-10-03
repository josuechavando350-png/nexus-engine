use alloy::primitives::U256;
use thiserror::Error;

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const WAD_U64: u64 = 1_000_000_000_000_000_000;
pub const RAY_DECIMALS: u32 = 27;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum MathError {
    #[error("division by zero")]
    DivisionByZero,
    #[error("integer overflow")]
    Overflow,
    #[error("integer underflow")]
    Underflow,
    #[error("basis points value exceeds 10,000")]
    InvalidBps,
}

#[must_use]
pub fn wad() -> U256 {
    U256::from(WAD_U64)
}

#[must_use]
pub fn ray() -> U256 {
    U256::from(10u64).pow(U256::from(RAY_DECIMALS))
}

pub fn checked_add(a: U256, b: U256) -> Result<U256, MathError> {
    a.checked_add(b).ok_or(MathError::Overflow)
}

pub fn checked_sub(a: U256, b: U256) -> Result<U256, MathError> {
    a.checked_sub(b).ok_or(MathError::Underflow)
}

pub fn checked_mul(a: U256, b: U256) -> Result<U256, MathError> {
    a.checked_mul(b).ok_or(MathError::Overflow)
}

pub fn mul_div_floor(a: U256, b: U256, denominator: U256) -> Result<U256, MathError> {
    if denominator == U256::ZERO {
        return Err(MathError::DivisionByZero);
    }
    Ok(checked_mul(a, b)? / denominator)
}

pub fn mul_div_ceil(a: U256, b: U256, denominator: U256) -> Result<U256, MathError> {
    if denominator == U256::ZERO {
        return Err(MathError::DivisionByZero);
    }
    let product = checked_mul(a, b)?;
    if product == U256::ZERO {
        return Ok(U256::ZERO);
    }
    Ok(checked_add(product, denominator - U256::from(1u8))? / denominator)
}

pub fn mul_div_half_up(a: U256, b: U256, denominator: U256) -> Result<U256, MathError> {
    if denominator == U256::ZERO {
        return Err(MathError::DivisionByZero);
    }
    let product = checked_mul(a, b)?;
    let rounded = checked_add(product, denominator / U256::from(2u8))?;
    Ok(rounded / denominator)
}

pub fn apply_bps_floor(value: U256, bps: u32) -> Result<U256, MathError> {
    if bps > BPS_DENOMINATOR as u32 {
        return Err(MathError::InvalidBps);
    }
    mul_div_floor(value, U256::from(bps), U256::from(BPS_DENOMINATOR))
}

pub fn percent_mul_half_up(value: U256, bps: u32) -> Result<U256, MathError> {
    if bps > BPS_DENOMINATOR as u32 {
        return Err(MathError::InvalidBps);
    }
    mul_div_half_up(value, U256::from(bps), U256::from(BPS_DENOMINATOR))
}

pub fn percent_mul_floor_unbounded(value: U256, bps: u32) -> Result<U256, MathError> {
    mul_div_floor(value, U256::from(bps), U256::from(BPS_DENOMINATOR))
}

pub fn percent_mul_ceil_unbounded(value: U256, bps: u32) -> Result<U256, MathError> {
    mul_div_ceil(value, U256::from(bps), U256::from(BPS_DENOMINATOR))
}

pub fn percent_div_floor(value: U256, bps: u32) -> Result<U256, MathError> {
    if bps == 0 {
        return Err(MathError::DivisionByZero);
    }
    mul_div_floor(value, U256::from(BPS_DENOMINATOR), U256::from(bps))
}

pub fn percent_div_ceil(value: U256, bps: u32) -> Result<U256, MathError> {
    if bps == 0 {
        return Err(MathError::DivisionByZero);
    }
    mul_div_ceil(value, U256::from(BPS_DENOMINATOR), U256::from(bps))
}

pub fn ray_mul_half_up(a: U256, b: U256) -> Result<U256, MathError> {
    mul_div_half_up(a, b, ray())
}

pub fn wad_div_half_up(a: U256, b: U256) -> Result<U256, MathError> {
    mul_div_half_up(a, wad(), b)
}

pub fn token_value_wad(
    token_amount: U256,
    price_usd_wad: U256,
    token_unit: U256,
) -> Result<U256, MathError> {
    mul_div_floor(token_amount, price_usd_wad, token_unit)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn basis_points_are_applied_without_float_math() -> Result<(), MathError> {
        let value = U256::from(1_000_000u64);
        assert_eq!(apply_bps_floor(value, 250)?, U256::from(25_000u64));
        Ok(())
    }

    #[test]
    fn mul_div_ceil_matches_protocol_style_debt_rounding() -> Result<(), MathError> {
        assert_eq!(
            mul_div_ceil(U256::from(10u8), U256::from(2u8), U256::from(3u8))?,
            U256::from(7u8)
        );
        assert_eq!(
            mul_div_ceil(U256::ZERO, U256::from(2u8), U256::from(3u8))?,
            U256::ZERO
        );
        Ok(())
    }

    #[test]
    fn half_up_percentage_rounds_point_five_up() -> Result<(), MathError> {
        assert_eq!(percent_mul_half_up(U256::from(1u8), 5_000)?, U256::from(1u8));
        Ok(())
    }

    #[test]
    fn token_value_respects_decimals() -> Result<(), MathError> {
        let one_eth = wad();
        let price = U256::from(3_500u64) * wad();
        assert_eq!(token_value_wad(one_eth, price, one_eth)?, price);
        Ok(())
    }

    #[test]
    fn ray_multiplication_preserves_scaled_balances() -> Result<(), MathError> {
        let scaled = U256::from(2_000u64) * wad();
        let index = ray() + ray() / U256::from(10u64);
        assert_eq!(ray_mul_half_up(scaled, index)?, U256::from(2_200u64) * wad());
        Ok(())
    }

    #[test]
    fn wad_division_rounds_half_up() -> Result<(), MathError> {
        assert_eq!(
            wad_div_half_up(U256::from(2u8), U256::from(3u8))?,
            U256::from(666_666_666_666_666_667u64)
        );
        Ok(())
    }

    #[test]
    fn invalid_bps_are_rejected() {
        assert_eq!(apply_bps_floor(U256::from(1u64), 10_001), Err(MathError::InvalidBps));
    }

    #[test]
    fn liquidation_bonus_math_supports_percentages_above_one_hundred_percent() -> Result<(), MathError> {
        let value = U256::from(1_000u64);
        assert_eq!(percent_mul_floor_unbounded(value, 10_500)?, U256::from(1_050u64));
        assert_eq!(percent_div_floor(U256::from(1_050u64), 10_500)?, value);
        Ok(())
    }
}
