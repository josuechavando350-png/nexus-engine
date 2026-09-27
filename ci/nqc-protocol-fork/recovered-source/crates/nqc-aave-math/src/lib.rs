use alloy::primitives::U256;
use nqc_core::{
    checked_add, checked_mul, mul_div_floor, percent_div_ceil, percent_div_floor,
    percent_mul_ceil_unbounded, percent_mul_floor_unbounded, percent_mul_half_up, ray,
    ray_mul_half_up, token_value_wad, wad_div_half_up, MathError,
};
use thiserror::Error;

pub const LIQUIDATION_HF_WAD: u64 = 1_000_000_000_000_000_000;
pub const FULL_CLOSE_HF_WAD: u64 = 950_000_000_000_000_000;
pub const DEFAULT_CLOSE_FACTOR_BPS: u32 = 5_000;
pub const MAX_CLOSE_FACTOR_BPS: u32 = 10_000;
pub const SECONDS_PER_YEAR: u64 = 365 * 24 * 60 * 60;


pub fn calculate_linear_interest(
    rate_ray: U256,
    last_update_timestamp: u64,
    current_timestamp: u64,
) -> Result<U256, AaveMathError> {
    let elapsed = current_timestamp
        .checked_sub(last_update_timestamp)
        .ok_or(MathError::Underflow)?;
    let accrued = checked_mul(rate_ray, U256::from(elapsed))? / U256::from(SECONDS_PER_YEAR);
    Ok(checked_add(ray(), accrued)?)
}

pub fn calculate_compounded_interest(
    rate_ray: U256,
    last_update_timestamp: u64,
    current_timestamp: u64,
) -> Result<U256, AaveMathError> {
    let elapsed = current_timestamp
        .checked_sub(last_update_timestamp)
        .ok_or(MathError::Underflow)?;
    if elapsed == 0 {
        return Ok(ray());
    }

    let exp = U256::from(elapsed);
    let exp_minus_one = U256::from(elapsed - 1);
    let exp_minus_two = U256::from(elapsed.saturating_sub(2));
    let year = U256::from(SECONDS_PER_YEAR);
    let year_squared = checked_mul(year, year)?;

    let base_power_two = ray_mul_half_up(rate_ray, rate_ray)? / year_squared;
    let base_power_three = ray_mul_half_up(base_power_two, rate_ray)? / year;

    let second_term = checked_mul(checked_mul(exp, exp_minus_one)?, base_power_two)?
        / U256::from(2u8);
    let third_term = checked_mul(
        checked_mul(checked_mul(exp, exp_minus_one)?, exp_minus_two)?,
        base_power_three,
    )? / U256::from(6u8);
    let first_term = checked_mul(rate_ray, exp)? / year;

    Ok(checked_add(
        checked_add(checked_add(ray(), first_term)?, second_term)?,
        third_term,
    )?)
}

pub fn normalized_income(
    stored_liquidity_index_ray: U256,
    liquidity_rate_ray: U256,
    last_update_timestamp: u64,
    current_timestamp: u64,
) -> Result<U256, AaveMathError> {
    if current_timestamp == last_update_timestamp {
        return Ok(stored_liquidity_index_ray);
    }
    Ok(ray_mul_half_up(
        calculate_linear_interest(liquidity_rate_ray, last_update_timestamp, current_timestamp)?,
        stored_liquidity_index_ray,
    )?)
}

pub fn normalized_variable_debt(
    stored_variable_borrow_index_ray: U256,
    variable_borrow_rate_ray: U256,
    last_update_timestamp: u64,
    current_timestamp: u64,
) -> Result<U256, AaveMathError> {
    if current_timestamp == last_update_timestamp {
        return Ok(stored_variable_borrow_index_ray);
    }
    Ok(ray_mul_half_up(
        calculate_compounded_interest(
            variable_borrow_rate_ray,
            last_update_timestamp,
            current_timestamp,
        )?,
        stored_variable_borrow_index_ray,
    )?)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollateralPosition {
    pub amount: U256,
    pub price_usd_wad: U256,
    pub token_unit: U256,
    pub liquidation_threshold_bps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DebtPosition {
    pub amount: U256,
    pub price_usd_wad: U256,
    pub token_unit: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountRisk {
    pub collateral_usd_wad: U256,
    pub weighted_collateral_usd_wad: U256,
    pub debt_usd_wad: U256,
    pub health_factor_wad: Option<U256>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccountRiskAccumulator {
    collateral_usd_wad: U256,
    weighted_threshold_numerator: U256,
    debt_usd_wad: U256,
}

impl AccountRiskAccumulator {
    pub fn add_collateral(&mut self, position: CollateralPosition) -> Result<(), AaveMathError> {
        let value = token_value_wad(position.amount, position.price_usd_wad, position.token_unit)?;
        self.collateral_usd_wad = checked_add(self.collateral_usd_wad, value)?;
        self.weighted_threshold_numerator = checked_add(
            self.weighted_threshold_numerator,
            checked_mul(value, U256::from(position.liquidation_threshold_bps))?,
        )?;
        Ok(())
    }

    pub fn add_debt(&mut self, position: DebtPosition) -> Result<(), AaveMathError> {
        let value = token_value_wad(position.amount, position.price_usd_wad, position.token_unit)?;
        self.debt_usd_wad = checked_add(self.debt_usd_wad, value)?;
        Ok(())
    }

    pub fn finish(self) -> Result<AccountRisk, AaveMathError> {
        let average_liquidation_threshold_bps = if self.collateral_usd_wad == U256::ZERO {
            U256::ZERO
        } else {
            self.weighted_threshold_numerator / self.collateral_usd_wad
        };
        let average_liquidation_threshold_bps = u32::try_from(average_liquidation_threshold_bps)
            .map_err(|_| MathError::Overflow)?;
        let weighted_collateral_usd_wad =
            percent_mul_half_up(self.collateral_usd_wad, average_liquidation_threshold_bps)?;

        let health_factor_wad = if self.debt_usd_wad == U256::ZERO {
            None
        } else {
            Some(wad_div_half_up(weighted_collateral_usd_wad, self.debt_usd_wad)?)
        };

        Ok(AccountRisk {
            collateral_usd_wad: self.collateral_usd_wad,
            weighted_collateral_usd_wad,
            debt_usd_wad: self.debt_usd_wad,
            health_factor_wad,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AaveMathError {
    #[error(transparent)]
    Math(#[from] MathError),
    #[error("invalid Aave liquidation parameters")]
    InvalidLiquidationParameters,
}

pub fn account_risk(
    collateral: &[CollateralPosition],
    debt: &[DebtPosition],
) -> Result<AccountRisk, AaveMathError> {
    let mut accumulator = AccountRiskAccumulator::default();

    for position in collateral {
        accumulator.add_collateral(*position)?;
    }

    for position in debt {
        accumulator.add_debt(*position)?;
    }

    accumulator.finish()
}

#[must_use]
pub fn is_liquidatable(health_factor_wad: Option<U256>) -> bool {
    health_factor_wad.is_some_and(|hf| hf < U256::from(LIQUIDATION_HF_WAD))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationSizingInput {
    pub health_factor_wad: U256,
    pub total_debt_base_wad: U256,
    pub reserve_debt_amount: U256,
    pub reserve_debt_base_wad: U256,
    pub reserve_collateral_base_wad: U256,
    pub debt_asset_price_base_wad: U256,
    pub debt_asset_unit: U256,
    pub min_base_max_close_factor_threshold_wad: U256,
}

pub fn max_liquidatable_debt(
    input: LiquidationSizingInput,
) -> Result<U256, AaveMathError> {
    if input.health_factor_wad >= U256::from(LIQUIDATION_HF_WAD)
        || input.reserve_debt_amount == U256::ZERO
    {
        return Ok(U256::ZERO);
    }

    let mut max_liquidatable = input.reserve_debt_amount;
    let applies_default_close_factor = input.health_factor_wad > U256::from(FULL_CLOSE_HF_WAD)
        && input.reserve_collateral_base_wad >= input.min_base_max_close_factor_threshold_wad
        && input.reserve_debt_base_wad >= input.min_base_max_close_factor_threshold_wad;

    if applies_default_close_factor {
        let total_default_liquidatable_base =
            percent_mul_half_up(input.total_debt_base_wad, DEFAULT_CLOSE_FACTOR_BPS)?;
        if input.reserve_debt_base_wad > total_default_liquidatable_base {
            max_liquidatable = mul_div_floor(
                total_default_liquidatable_base,
                input.debt_asset_unit,
                input.debt_asset_price_base_wad,
            )?;
        }
    }

    Ok(max_liquidatable.min(input.reserve_debt_amount))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailableCollateralInput {
    pub collateral_price_base_wad: U256,
    pub collateral_asset_unit: U256,
    pub debt_price_base_wad: U256,
    pub debt_asset_unit: U256,
    pub debt_to_cover: U256,
    pub borrower_collateral_balance: U256,
    pub liquidation_bonus_bps: u32,
    pub liquidation_protocol_fee_bps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AvailableCollateralResult {
    pub collateral_to_liquidator: U256,
    pub debt_to_liquidate: U256,
    pub liquidation_protocol_fee_collateral: U256,
}

pub fn calculate_available_collateral_to_liquidate(
    input: AvailableCollateralInput,
) -> Result<AvailableCollateralResult, AaveMathError> {
    if input.collateral_price_base_wad == U256::ZERO
        || input.collateral_asset_unit == U256::ZERO
        || input.debt_price_base_wad == U256::ZERO
        || input.debt_asset_unit == U256::ZERO
        || input.liquidation_bonus_bps < 10_000
        || input.liquidation_protocol_fee_bps > 10_000
    {
        return Err(AaveMathError::InvalidLiquidationParameters);
    }

    let base_numerator = checked_mul(
        checked_mul(input.debt_price_base_wad, input.debt_to_cover)?,
        input.collateral_asset_unit,
    )?;
    let base_denominator = checked_mul(
        input.collateral_price_base_wad,
        input.debt_asset_unit,
    )?;
    let base_collateral = base_numerator / base_denominator;
    let max_collateral =
        percent_mul_floor_unbounded(base_collateral, input.liquidation_bonus_bps)?;

    let (mut collateral_amount, debt_amount_needed) =
        if max_collateral > input.borrower_collateral_balance {
            let collateral_amount = input.borrower_collateral_balance;
            let debt_numerator = checked_mul(
                checked_mul(input.collateral_price_base_wad, collateral_amount)?,
                input.debt_asset_unit,
            )?;
            let debt_denominator = checked_mul(
                input.debt_price_base_wad,
                input.collateral_asset_unit,
            )?;
            let debt_before_bonus = debt_numerator / debt_denominator;
            (
                collateral_amount,
                percent_div_ceil(debt_before_bonus, input.liquidation_bonus_bps)?,
            )
        } else {
            (max_collateral, input.debt_to_cover)
        };

    let mut protocol_fee = U256::ZERO;
    if input.liquidation_protocol_fee_bps != 0 {
        let base_without_bonus =
            percent_div_floor(collateral_amount, input.liquidation_bonus_bps)?;
        let bonus_collateral = collateral_amount
            .checked_sub(base_without_bonus)
            .ok_or(MathError::Underflow)?;
        protocol_fee = percent_mul_ceil_unbounded(
            bonus_collateral,
            input.liquidation_protocol_fee_bps,
        )?;
        collateral_amount = collateral_amount
            .checked_sub(protocol_fee)
            .ok_or(MathError::Underflow)?;
    }

    Ok(AvailableCollateralResult {
        collateral_to_liquidator: collateral_amount,
        debt_to_liquidate: debt_amount_needed,
        liquidation_protocol_fee_collateral: protocol_fee,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd(amount: u64) -> U256 {
        U256::from(amount) * wad()
    }

    #[test]
    fn computes_aave_style_health_factor() -> Result<(), AaveMathError> {
        let collateral = [CollateralPosition {
            amount: usd(10_000),
            price_usd_wad: wad(),
            token_unit: wad(),
            liquidation_threshold_bps: 8_000,
        }];
        let debt = [DebtPosition {
            amount: usd(6_000),
            price_usd_wad: wad(),
            token_unit: wad(),
        }];

        let risk = account_risk(&collateral, &debt)?;
        assert_eq!(risk.collateral_usd_wad, usd(10_000));
        assert_eq!(risk.weighted_collateral_usd_wad, usd(8_000));
        assert_eq!(risk.debt_usd_wad, usd(6_000));
        assert_eq!(
            risk.health_factor_wad,
            Some(U256::from(1_333_333_333_333_333_333u64))
        );
        assert!(!is_liquidatable(risk.health_factor_wad));
        Ok(())
    }

    #[test]
    fn accumulator_matches_slice_calculation() -> Result<(), AaveMathError> {
        let collateral = CollateralPosition {
            amount: usd(12_500),
            price_usd_wad: wad(),
            token_unit: wad(),
            liquidation_threshold_bps: 8_250,
        };
        let debt = DebtPosition {
            amount: usd(7_500),
            price_usd_wad: wad(),
            token_unit: wad(),
        };

        let expected = account_risk(&[collateral], &[debt])?;
        let mut accumulator = AccountRiskAccumulator::default();
        accumulator.add_collateral(collateral)?;
        accumulator.add_debt(debt)?;
        assert_eq!(accumulator.finish()?, expected);
        Ok(())
    }

    #[test]
    fn zero_rate_keeps_normalized_indexes_constant() -> Result<(), AaveMathError> {
        let index = ray() + U256::from(123u64);
        assert_eq!(normalized_income(index, U256::ZERO, 100, 200)?, index);
        assert_eq!(normalized_variable_debt(index, U256::ZERO, 100, 200)?, index);
        Ok(())
    }

    #[test]
    fn one_year_linear_interest_matches_rate() -> Result<(), AaveMathError> {
        let ten_percent = ray() / U256::from(10u8);
        assert_eq!(
            calculate_linear_interest(ten_percent, 0, SECONDS_PER_YEAR)?,
            ray() + ten_percent
        );
        Ok(())
    }

    #[test]
    fn selected_reserve_is_capped_by_half_of_total_debt_when_large() -> Result<(), AaveMathError> {
        let input = LiquidationSizingInput {
            health_factor_wad: U256::from(960_000_000_000_000_000u64),
            total_debt_base_wad: usd(10_000),
            reserve_debt_amount: usd(8_000),
            reserve_debt_base_wad: usd(8_000),
            reserve_collateral_base_wad: usd(10_000),
            debt_asset_price_base_wad: wad(),
            debt_asset_unit: wad(),
            min_base_max_close_factor_threshold_wad: usd(2_000),
        };
        assert_eq!(max_liquidatable_debt(input)?, usd(5_000));
        Ok(())
    }

    #[test]
    fn selected_reserve_can_clear_when_below_half_of_total_debt() -> Result<(), AaveMathError> {
        let input = LiquidationSizingInput {
            health_factor_wad: U256::from(960_000_000_000_000_000u64),
            total_debt_base_wad: usd(10_000),
            reserve_debt_amount: usd(3_000),
            reserve_debt_base_wad: usd(3_000),
            reserve_collateral_base_wad: usd(10_000),
            debt_asset_price_base_wad: wad(),
            debt_asset_unit: wad(),
            min_base_max_close_factor_threshold_wad: usd(2_000),
        };
        assert_eq!(max_liquidatable_debt(input)?, usd(3_000));
        Ok(())
    }

    #[test]
    fn full_reserve_debt_is_allowed_below_point_95() -> Result<(), AaveMathError> {
        let input = LiquidationSizingInput {
            health_factor_wad: U256::from(940_000_000_000_000_000u64),
            total_debt_base_wad: usd(10_000),
            reserve_debt_amount: usd(8_000),
            reserve_debt_base_wad: usd(8_000),
            reserve_collateral_base_wad: usd(10_000),
            debt_asset_price_base_wad: wad(),
            debt_asset_unit: wad(),
            min_base_max_close_factor_threshold_wad: usd(2_000),
        };
        assert_eq!(max_liquidatable_debt(input)?, usd(8_000));
        Ok(())
    }

    #[test]
    fn small_selected_pair_allows_full_reserve_debt() -> Result<(), AaveMathError> {
        let input = LiquidationSizingInput {
            health_factor_wad: U256::from(960_000_000_000_000_000u64),
            total_debt_base_wad: usd(10_000),
            reserve_debt_amount: usd(1_500),
            reserve_debt_base_wad: usd(1_500),
            reserve_collateral_base_wad: usd(1_900),
            debt_asset_price_base_wad: wad(),
            debt_asset_unit: wad(),
            min_base_max_close_factor_threshold_wad: usd(2_000),
        };
        assert_eq!(max_liquidatable_debt(input)?, usd(1_500));
        Ok(())
    }


    #[test]
    fn available_collateral_matches_bonus_and_protocol_fee_semantics() -> Result<(), AaveMathError> {
        let result = calculate_available_collateral_to_liquidate(AvailableCollateralInput {
            collateral_price_base_wad: usd(2_000),
            collateral_asset_unit: wad(),
            debt_price_base_wad: wad(),
            debt_asset_unit: wad(),
            debt_to_cover: usd(10_000),
            borrower_collateral_balance: U256::from(10u64) * wad(),
            liquidation_bonus_bps: 10_500,
            liquidation_protocol_fee_bps: 1_000,
        })?;
        // $10k debt at $2k/ETH = 5 ETH base; 5% bonus = 5.25 ETH.
        // The protocol takes 10% of the 0.25 ETH bonus = 0.025 ETH.
        assert_eq!(result.debt_to_liquidate, usd(10_000));
        assert_eq!(result.liquidation_protocol_fee_collateral, wad() / U256::from(40u8));
        assert_eq!(result.collateral_to_liquidator, U256::from(5u8) * wad() + (wad() * U256::from(225u16) / U256::from(1000u16)));
        Ok(())
    }

}