use alloy::primitives::{Address, U256};
use nqc_aave_market::{AaveMarketSnapshot, MarketEModeCategory, MarketReserve};
use nqc_aave_math::{
    calculate_available_collateral_to_liquidate, max_liquidatable_debt, AaveMathError,
    AvailableCollateralInput, LiquidationSizingInput, LIQUIDATION_HF_WAD,
};
use nqc_core::{
    checked_add, checked_sub, mul_div_ceil, mul_div_floor, percent_mul_half_up, wad, MathError,
};
use nqc_hot_state::{AccountReserveExposure, AccountSnapshot};
use nqc_state::CanonicalBlock;
use thiserror::Error;

pub const AAVE_V3_MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD_USD: u64 = 2_000;
pub const AAVE_V3_MIN_LEFTOVER_BASE_USD: u64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationOpportunityPolicy {
    pub min_oracle_edge_usd_wad: U256,
    pub min_base_max_close_factor_threshold_usd_wad: U256,
    pub min_leftover_base_usd_wad: U256,
}

impl LiquidationOpportunityPolicy {
    #[must_use]
    pub fn aave_v3(min_oracle_edge_usd_wad: U256) -> Self {
        Self {
            min_oracle_edge_usd_wad,
            min_base_max_close_factor_threshold_usd_wad: U256::from(
                AAVE_V3_MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD_USD,
            ) * wad(),
            min_leftover_base_usd_wad: U256::from(AAVE_V3_MIN_LEFTOVER_BASE_USD) * wad(),
        }
    }

    pub fn validate(self) -> Result<Self, OpportunityError> {
        if self.min_base_max_close_factor_threshold_usd_wad == U256::ZERO
            || self.min_leftover_base_usd_wad == U256::ZERO
            || self.min_leftover_base_usd_wad
                > self.min_base_max_close_factor_threshold_usd_wad
        {
            return Err(OpportunityError::InvalidPolicy);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationOpportunity {
    pub anchor: CanonicalBlock,
    pub borrower: Address,
    pub health_factor_wad: U256,
    pub collateral_asset: Address,
    pub collateral_reserve_id: u16,
    pub debt_asset: Address,
    pub debt_reserve_id: u16,
    pub debt_to_liquidate: U256,
    pub collateral_to_liquidator: U256,
    pub liquidation_protocol_fee_collateral: U256,
    pub flash_loan_premium: U256,
    pub flash_loan_repayment: U256,
    pub liquidation_bonus_bps: u32,
    pub oracle_collateral_value_usd_wad: U256,
    pub oracle_repayment_value_usd_wad: U256,
    pub oracle_edge_usd_wad: U256,
}

pub fn generate_liquidation_opportunities(
    market: &AaveMarketSnapshot,
    account: &AccountSnapshot,
    policy: LiquidationOpportunityPolicy,
) -> Result<Vec<LiquidationOpportunity>, OpportunityError> {
    let policy = policy.validate()?;
    if account.valuation_timestamp != market.anchor.timestamp {
        return Err(OpportunityError::ValuationTimestampMismatch {
            expected: market.anchor.timestamp,
            actual: account.valuation_timestamp,
        });
    }

    let health_factor_wad = account
        .risk
        .health_factor_wad
        .ok_or(OpportunityError::AccountHasNoDebt)?;
    if health_factor_wad >= U256::from(LIQUIDATION_HF_WAD) {
        return Ok(Vec::new());
    }

    let emode = if account.e_mode_category == 0 {
        None
    } else {
        Some(
            market
                .emode_category(account.e_mode_category)
                .ok_or(OpportunityError::UnknownEModeCategory(
                    account.e_mode_category,
                ))?,
        )
    };

    let mut output = Vec::new();
    for collateral in account.reserves.iter().filter(|reserve| {
        reserve.collateral_enabled && reserve.atoken_balance != U256::ZERO
    }) {
        let collateral_market = checked_market_reserve(market, collateral)?;
        if !liquidation_reserve_eligible(collateral_market, market.anchor.timestamp) {
            continue;
        }

        for debt in account
            .reserves
            .iter()
            .filter(|reserve| reserve.variable_debt != U256::ZERO)
        {
            let debt_market = checked_market_reserve(market, debt)?;
            if !liquidation_reserve_eligible(debt_market, market.anchor.timestamp)
                || !debt_market.flash_loan_enabled
            {
                continue;
            }

            let reserve_collateral_base_wad = mul_div_floor(
                collateral.atoken_balance,
                collateral_market.price_usd_wad,
                collateral.token_unit,
            )?;
            let reserve_debt_base_wad = mul_div_ceil(
                debt.variable_debt,
                debt_market.price_usd_wad,
                debt.token_unit,
            )?;

            let max_debt_to_cover = max_liquidatable_debt(LiquidationSizingInput {
                health_factor_wad,
                total_debt_base_wad: account.risk.debt_usd_wad,
                reserve_debt_amount: debt.variable_debt,
                reserve_debt_base_wad,
                reserve_collateral_base_wad,
                debt_asset_price_base_wad: debt_market.price_usd_wad,
                debt_asset_unit: debt.token_unit,
                min_base_max_close_factor_threshold_wad: policy
                    .min_base_max_close_factor_threshold_usd_wad,
            })?;
            if max_debt_to_cover == U256::ZERO {
                continue;
            }

            let liquidation_bonus_bps = effective_liquidation_bonus(
                emode,
                collateral.reserve_id,
                collateral_market.liquidation_bonus_bps,
            );
            let available = calculate_available_collateral_to_liquidate(
                AvailableCollateralInput {
                    collateral_price_base_wad: collateral_market.price_usd_wad,
                    collateral_asset_unit: collateral.token_unit,
                    debt_price_base_wad: debt_market.price_usd_wad,
                    debt_asset_unit: debt.token_unit,
                    debt_to_cover: max_debt_to_cover,
                    borrower_collateral_balance: collateral.atoken_balance,
                    liquidation_bonus_bps,
                    liquidation_protocol_fee_bps: collateral_market
                        .liquidation_protocol_fee_bps,
                },
            )?;
            if available.debt_to_liquidate == U256::ZERO
                || available.collateral_to_liquidator == U256::ZERO
            {
                continue;
            }

            if leaves_forbidden_dust(
                collateral,
                collateral_market,
                debt,
                debt_market,
                available.debt_to_liquidate,
                available.collateral_to_liquidator,
                available.liquidation_protocol_fee_collateral,
                policy.min_leftover_base_usd_wad,
            )? {
                continue;
            }

            let flash_loan_premium = percent_mul_half_up(
                available.debt_to_liquidate,
                market.flash_loan_premium_bps,
            )?;
            let flash_loan_repayment =
                checked_add(available.debt_to_liquidate, flash_loan_premium)?;
            let collateral_value = mul_div_floor(
                available.collateral_to_liquidator,
                collateral_market.price_usd_wad,
                collateral.token_unit,
            )?;
            let repayment_value = mul_div_ceil(
                flash_loan_repayment,
                debt_market.price_usd_wad,
                debt.token_unit,
            )?;
            if collateral_value <= repayment_value {
                continue;
            }
            let oracle_edge_usd_wad = checked_sub(collateral_value, repayment_value)?;
            if oracle_edge_usd_wad < policy.min_oracle_edge_usd_wad {
                continue;
            }

            output.push(LiquidationOpportunity {
                anchor: market.anchor,
                borrower: account.user,
                health_factor_wad,
                collateral_asset: collateral.asset,
                collateral_reserve_id: collateral.reserve_id,
                debt_asset: debt.asset,
                debt_reserve_id: debt.reserve_id,
                debt_to_liquidate: available.debt_to_liquidate,
                collateral_to_liquidator: available.collateral_to_liquidator,
                liquidation_protocol_fee_collateral: available
                    .liquidation_protocol_fee_collateral,
                flash_loan_premium,
                flash_loan_repayment,
                liquidation_bonus_bps,
                oracle_collateral_value_usd_wad: collateral_value,
                oracle_repayment_value_usd_wad: repayment_value,
                oracle_edge_usd_wad,
            });
        }
    }

    output.sort_unstable_by(|left, right| {
        right
            .oracle_edge_usd_wad
            .cmp(&left.oracle_edge_usd_wad)
            .then_with(|| left.health_factor_wad.cmp(&right.health_factor_wad))
            .then_with(|| left.borrower.cmp(&right.borrower))
            .then_with(|| left.collateral_reserve_id.cmp(&right.collateral_reserve_id))
            .then_with(|| left.debt_reserve_id.cmp(&right.debt_reserve_id))
    });
    Ok(output)
}

fn checked_market_reserve<'a>(
    market: &'a AaveMarketSnapshot,
    exposure: &AccountReserveExposure,
) -> Result<&'a MarketReserve, OpportunityError> {
    let reserve = market
        .reserve(exposure.asset)
        .ok_or(OpportunityError::UnknownMarketReserve(exposure.asset))?;
    if reserve.reserve_id != exposure.reserve_id
        || reserve.configuration.token_unit() != exposure.token_unit
        || reserve.price_usd_wad != exposure.price_usd_wad
    {
        return Err(OpportunityError::SnapshotMismatch(exposure.asset));
    }
    Ok(reserve)
}

fn liquidation_reserve_eligible(reserve: &MarketReserve, block_timestamp: u64) -> bool {
    reserve.configuration.is_active()
        && !reserve.configuration.is_paused()
        && reserve.liquidation_grace_period_until < block_timestamp
}

fn effective_liquidation_bonus(
    emode: Option<&MarketEModeCategory>,
    collateral_reserve_id: u16,
    reserve_bonus_bps: u32,
) -> u32 {
    let Some(category) = emode else {
        return reserve_bonus_bps;
    };
    if collateral_reserve_id < 128
        && category.collateral_bitmap & (1u128 << collateral_reserve_id) != 0
    {
        category.liquidation_bonus_bps
    } else {
        reserve_bonus_bps
    }
}

#[allow(clippy::too_many_arguments)]
fn leaves_forbidden_dust(
    collateral: &AccountReserveExposure,
    collateral_market: &MarketReserve,
    debt: &AccountReserveExposure,
    debt_market: &MarketReserve,
    actual_debt_to_liquidate: U256,
    collateral_to_liquidator: U256,
    liquidation_protocol_fee_collateral: U256,
    min_leftover_base_usd_wad: U256,
) -> Result<bool, OpportunityError> {
    let collateral_consumed = checked_add(
        collateral_to_liquidator,
        liquidation_protocol_fee_collateral,
    )?;
    if actual_debt_to_liquidate >= debt.variable_debt
        || collateral_consumed >= collateral.atoken_balance
    {
        return Ok(false);
    }

    let remaining_debt = checked_sub(debt.variable_debt, actual_debt_to_liquidate)?;
    let remaining_collateral = checked_sub(collateral.atoken_balance, collateral_consumed)?;
    let remaining_debt_base = mul_div_ceil(
        remaining_debt,
        debt_market.price_usd_wad,
        debt.token_unit,
    )?;
    let remaining_collateral_base = mul_div_floor(
        remaining_collateral,
        collateral_market.price_usd_wad,
        collateral.token_unit,
    )?;
    Ok(remaining_debt_base < min_leftover_base_usd_wad
        || remaining_collateral_base < min_leftover_base_usd_wad)
}

#[derive(Debug, Error)]
pub enum OpportunityError {
    #[error(transparent)]
    Math(#[from] MathError),
    #[error(transparent)]
    AaveMath(#[from] AaveMathError),
    #[error("invalid liquidation opportunity policy")]
    InvalidPolicy,
    #[error("account snapshot contains no debt")]
    AccountHasNoDebt,
    #[error("account valuation timestamp mismatch: expected {expected}, got {actual}")]
    ValuationTimestampMismatch { expected: u64, actual: u64 },
    #[error("market snapshot is missing reserve {0}")]
    UnknownMarketReserve(Address),
    #[error("account/market snapshot mismatch for reserve {0}")]
    SnapshotMismatch(Address),
    #[error("account references unknown eMode category {0}")]
    UnknownEModeCategory(u8),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::B256;
    use nqc_aave_sync::ReserveConfigurationBits;

    fn usd(value: u64) -> U256 {
        U256::from(value) * wad()
    }

    fn config(decimals: u8, bonus_bps: u32, protocol_fee_bps: u32, flash: bool) -> ReserveConfigurationBits {
        let mut raw = U256::from(bonus_bps) << 32;
        raw |= U256::from(decimals) << 48;
        raw |= U256::from(1u8) << 56;
        if flash {
            raw |= U256::from(1u8) << 63;
        }
        raw |= U256::from(protocol_fee_bps) << 152;
        ReserveConfigurationBits(raw)
    }

    fn market_reserve(asset: Address, reserve_id: u16, price: U256, bonus: u32, protocol_fee: u32, flash: bool) -> MarketReserve {
        let configuration = config(18, bonus, protocol_fee, flash);
        MarketReserve {
            asset,
            reserve_id,
            configuration,
            a_token: Address::repeat_byte((reserve_id as u8).saturating_add(10)),
            variable_debt_token: Address::repeat_byte((reserve_id as u8).saturating_add(20)),
            price_oracle_units: price,
            price_usd_wad: price,
            liquidity_index_ray: U256::ZERO,
            variable_borrow_index_ray: U256::ZERO,
            liquidity_rate_ray: U256::ZERO,
            variable_borrow_rate_ray: U256::ZERO,
            last_update_timestamp: 0,
            liquidation_bonus_bps: bonus,
            liquidation_protocol_fee_bps: protocol_fee,
            flash_loan_enabled: flash,
            liquidation_grace_period_until: 0,
        }
    }

    #[test]
    fn profitable_pair_is_sized_with_protocol_fee_and_flash_premium() -> Result<(), OpportunityError> {
        let collateral_asset = Address::repeat_byte(1);
        let debt_asset = Address::repeat_byte(2);
        let anchor = CanonicalBlock {
            number: 100,
            hash: B256::repeat_byte(0x44),
            timestamp: 1_700_000_000,
            base_fee_per_gas: Some(20_000_000_000),
        };
        let market = AaveMarketSnapshot {
            chain_id: 1,
            pool: Address::repeat_byte(3),
            addresses_provider: Address::repeat_byte(4),
            price_oracle: Address::repeat_byte(5),
            anchor,
            oracle_base_currency: Address::ZERO,
            oracle_base_unit: wad(),
            flash_loan_premium_bps: 5,
            reserves: vec![
                market_reserve(collateral_asset, 0, usd(2_000), 10_500, 1_000, false),
                market_reserve(debt_asset, 1, wad(), 10_500, 0, true),
            ],
            emode_categories: Vec::new(),
        };
        let account = AccountSnapshot {
            user: Address::repeat_byte(9),
            valuation_timestamp: anchor.timestamp,
            e_mode_category: 0,
            risk: nqc_aave_math::AccountRisk {
                collateral_usd_wad: usd(20_000),
                weighted_collateral_usd_wad: usd(8_000),
                debt_usd_wad: usd(10_000),
                health_factor_wad: Some(U256::from(800_000_000_000_000_000u64)),
            },
            reserves: vec![
                AccountReserveExposure {
                    asset: collateral_asset,
                    reserve_id: 0,
                    token_unit: wad(),
                    price_usd_wad: usd(2_000),
                    atoken_balance: U256::from(10u8) * wad(),
                    variable_debt: U256::ZERO,
                    collateral_enabled: true,
                },
                AccountReserveExposure {
                    asset: debt_asset,
                    reserve_id: 1,
                    token_unit: wad(),
                    price_usd_wad: wad(),
                    atoken_balance: U256::ZERO,
                    variable_debt: usd(10_000),
                    collateral_enabled: false,
                },
            ],
        };

        let opportunities = generate_liquidation_opportunities(
            &market,
            &account,
            LiquidationOpportunityPolicy::aave_v3(U256::ZERO),
        )?;
        assert_eq!(opportunities.len(), 1);
        let opportunity = opportunities[0];
        assert_eq!(opportunity.debt_to_liquidate, usd(10_000));
        assert_eq!(opportunity.liquidation_bonus_bps, 10_500);
        assert!(opportunity.liquidation_protocol_fee_collateral != U256::ZERO);
        assert!(opportunity.flash_loan_premium != U256::ZERO);
        assert!(opportunity.oracle_edge_usd_wad > U256::ZERO);
        Ok(())
    }

    #[test]
    fn grace_period_equal_to_block_timestamp_is_not_liquidatable() -> Result<(), OpportunityError> {
        let asset = Address::repeat_byte(1);
        let mut reserve = market_reserve(asset, 0, wad(), 10_500, 0, true);
        reserve.liquidation_grace_period_until = 100;
        assert!(!liquidation_reserve_eligible(&reserve, 100));
        assert!(liquidation_reserve_eligible(&reserve, 101));
        Ok(())
    }

    #[test]
    fn emode_bonus_only_applies_when_collateral_is_in_category_bitmap() {
        let category = MarketEModeCategory {
            category_id: 1,
            liquidation_threshold_bps: 9_000,
            liquidation_bonus_bps: 10_100,
            collateral_bitmap: 1u128 << 7,
            borrowable_bitmap: 0,
            ltvzero_bitmap: 0,
            isolated: false,
        };
        assert_eq!(effective_liquidation_bonus(Some(&category), 7, 10_500), 10_100);
        assert_eq!(effective_liquidation_bonus(Some(&category), 6, 10_500), 10_500);
    }
}
