use alloy::primitives::U256;
use nqc_core::{checked_add, checked_mul, checked_sub, mul_div_floor, wad, MathError};
use nqc_edge::EdgeEconomics;
use nqc_sim::SimulationReceipt;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementPolicy {
    /// Additional gas units reserved above the measured REVM receipt.
    pub gas_buffer: u64,
    /// Minimum safe profit after all explicit reserves.
    pub min_safe_profit_usd_wad: U256,
    /// Fixed reserve for state/order drift not represented by gas.
    pub state_drift_reserve_usd_wad: U256,
    /// Fixed reserve for any offchain/relay uncertainty.
    pub execution_reserve_usd_wad: U256,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementPrices {
    /// USD WAD price for one whole debt token.
    pub debt_asset_price_usd_wad: U256,
    /// Native gas token USD WAD price (ETH for Ethereum mainnet).
    pub native_asset_price_usd_wad: U256,
    /// 10^decimals of the debt token.
    pub debt_asset_unit: U256,
}

impl SettlementPrices {
    pub fn validate(self) -> Result<Self, SettlementError> {
        if self.debt_asset_price_usd_wad == U256::ZERO
            || self.native_asset_price_usd_wad == U256::ZERO
            || self.debt_asset_unit == U256::ZERO
        {
            return Err(SettlementError::InvalidPriceInput);
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GasSettlement {
    pub base_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    /// Optional direct builder/coinbase payment outside ordinary transaction gas.
    pub external_builder_payment_wei: U256,
}

impl GasSettlement {
    pub fn effective_gas_price(self) -> Result<u128, SettlementError> {
        if self.max_priority_fee_per_gas > self.max_fee_per_gas {
            return Err(SettlementError::PriorityFeeAboveMaxFee);
        }
        let base_plus_priority = self
            .base_fee_per_gas
            .checked_add(self.max_priority_fee_per_gas)
            .ok_or(SettlementError::FeeOverflow)?;
        Ok(self.max_fee_per_gas.min(base_plus_priority))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SettlementReport {
    realized_profit_debt_asset: U256,
    realized_profit_usd_wad: U256,
    measured_gas_used: u64,
    reserved_gas_used: u64,
    effective_gas_price_wei: u128,
    measured_gas_cost_usd_wad: U256,
    reserved_gas_cost_usd_wad: U256,
    external_builder_payment_usd_wad: U256,
    total_non_trade_cost_usd_wad: U256,
    safe_profit_usd_wad: U256,
}

impl SettlementReport {
    #[must_use]
    pub const fn realized_profit_debt_asset(self) -> U256 { self.realized_profit_debt_asset }
    #[must_use]
    pub const fn realized_profit_usd_wad(self) -> U256 { self.realized_profit_usd_wad }
    #[must_use]
    pub const fn measured_gas_used(self) -> u64 { self.measured_gas_used }
    #[must_use]
    pub const fn reserved_gas_used(self) -> u64 { self.reserved_gas_used }
    #[must_use]
    pub const fn effective_gas_price_wei(self) -> u128 { self.effective_gas_price_wei }
    #[must_use]
    pub const fn measured_gas_cost_usd_wad(self) -> U256 { self.measured_gas_cost_usd_wad }
    #[must_use]
    pub const fn reserved_gas_cost_usd_wad(self) -> U256 { self.reserved_gas_cost_usd_wad }
    #[must_use]
    pub const fn external_builder_payment_usd_wad(self) -> U256 { self.external_builder_payment_usd_wad }
    #[must_use]
    pub const fn total_non_trade_cost_usd_wad(self) -> U256 { self.total_non_trade_cost_usd_wad }
    #[must_use]
    pub const fn safe_profit_usd_wad(self) -> U256 { self.safe_profit_usd_wad }

    #[must_use]
    pub fn as_edge_economics(self, opportunity_cost_usd_wad: U256) -> EdgeEconomics {
        EdgeEconomics {
            safe_profit_usd_wad: self.safe_profit_usd_wad,
            // Atomic executor failure is handled before settlement. This field is intentionally
            // zero here; a separate empirical adverse-loss model may add non-atomic operational
            // exposure later without double-counting transaction economics.
            loss_if_adverse_usd_wad: U256::ZERO,
            opportunity_cost_usd_wad,
        }
    }
}

pub fn settle_atomic_simulation(
    receipt: &SimulationReceipt,
    prices: SettlementPrices,
    gas: GasSettlement,
    policy: SettlementPolicy,
) -> Result<SettlementReport, SettlementError> {
    if !receipt.success() {
        return Err(SettlementError::SimulationNotSuccessful);
    }
    let realized_profit_debt_asset = receipt
        .realized_profit_debt_asset()
        .ok_or(SettlementError::MissingRealizedProfit)?;
    settle_components(
        realized_profit_debt_asset,
        receipt.gas_used(),
        prices,
        gas,
        policy,
    )
}

fn settle_components(
    realized_profit_debt_asset: U256,
    measured_gas_used: u64,
    prices: SettlementPrices,
    gas: GasSettlement,
    policy: SettlementPolicy,
) -> Result<SettlementReport, SettlementError> {
    let prices = prices.validate()?;
    let effective_gas_price_wei = gas.effective_gas_price()?;
    let reserved_gas_used = measured_gas_used
        .checked_add(policy.gas_buffer)
        .ok_or(SettlementError::GasOverflow)?;

    let realized_profit_usd_wad = mul_div_floor(
        realized_profit_debt_asset,
        prices.debt_asset_price_usd_wad,
        prices.debt_asset_unit,
    )?;
    let measured_gas_cost_wei = checked_mul(
        U256::from(measured_gas_used),
        U256::from(effective_gas_price_wei),
    )?;
    let reserved_gas_cost_wei = checked_mul(
        U256::from(reserved_gas_used),
        U256::from(effective_gas_price_wei),
    )?;
    let measured_gas_cost_usd_wad = wei_to_usd_wad(
        measured_gas_cost_wei,
        prices.native_asset_price_usd_wad,
    )?;
    let reserved_gas_cost_usd_wad = wei_to_usd_wad(
        reserved_gas_cost_wei,
        prices.native_asset_price_usd_wad,
    )?;
    let external_builder_payment_usd_wad = wei_to_usd_wad(
        gas.external_builder_payment_wei,
        prices.native_asset_price_usd_wad,
    )?;

    let total_non_trade_cost_usd_wad = [
        reserved_gas_cost_usd_wad,
        external_builder_payment_usd_wad,
        policy.state_drift_reserve_usd_wad,
        policy.execution_reserve_usd_wad,
    ]
    .into_iter()
    .try_fold(U256::ZERO, checked_add)?;

    if total_non_trade_cost_usd_wad >= realized_profit_usd_wad {
        return Err(SettlementError::NoSafeProfit {
            realized_profit_usd_wad,
            total_non_trade_cost_usd_wad,
        });
    }
    let safe_profit_usd_wad = checked_sub(
        realized_profit_usd_wad,
        total_non_trade_cost_usd_wad,
    )?;
    if safe_profit_usd_wad < policy.min_safe_profit_usd_wad {
        return Err(SettlementError::SafeProfitBelowFloor {
            actual: safe_profit_usd_wad,
            required: policy.min_safe_profit_usd_wad,
        });
    }

    Ok(SettlementReport {
        realized_profit_debt_asset,
        realized_profit_usd_wad,
        measured_gas_used,
        reserved_gas_used,
        effective_gas_price_wei,
        measured_gas_cost_usd_wad,
        reserved_gas_cost_usd_wad,
        external_builder_payment_usd_wad,
        total_non_trade_cost_usd_wad,
        safe_profit_usd_wad,
    })
}

fn wei_to_usd_wad(
    amount_wei: U256,
    native_asset_price_usd_wad: U256,
) -> Result<U256, SettlementError> {
    Ok(mul_div_floor(
        amount_wei,
        native_asset_price_usd_wad,
        wad(),
    )?)
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum SettlementError {
    #[error(transparent)]
    Math(#[from] MathError),
    #[error("simulation must succeed before settlement")]
    SimulationNotSuccessful,
    #[error("successful simulation did not return realized executor profit")]
    MissingRealizedProfit,
    #[error("settlement prices and token units must be non-zero")]
    InvalidPriceInput,
    #[error("priority fee exceeds max fee")]
    PriorityFeeAboveMaxFee,
    #[error("fee arithmetic overflow")]
    FeeOverflow,
    #[error("gas buffer overflow")]
    GasOverflow,
    #[error("realized profit {realized_profit_usd_wad} does not cover conservative non-trade costs {total_non_trade_cost_usd_wad}")]
    NoSafeProfit {
        realized_profit_usd_wad: U256,
        total_non_trade_cost_usd_wad: U256,
    },
    #[error("safe profit {actual} is below required floor {required}")]
    SafeProfitBelowFloor { actual: U256, required: U256 },
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usd(value: u64) -> U256 {
        U256::from(value) * wad()
    }

    fn prices() -> SettlementPrices {
        SettlementPrices {
            debt_asset_price_usd_wad: usd(1),
            native_asset_price_usd_wad: usd(4_000),
            debt_asset_unit: U256::from(1_000_000u64),
        }
    }

    fn gas() -> GasSettlement {
        GasSettlement {
            base_fee_per_gas: 20_000_000_000,
            max_priority_fee_per_gas: 2_000_000_000,
            max_fee_per_gas: 30_000_000_000,
            external_builder_payment_wei: U256::ZERO,
        }
    }

    #[test]
    fn realized_profit_is_not_charged_flashloan_or_dex_fees_twice() -> Result<(), SettlementError> {
        let report = settle_components(
            U256::from(1_000_000_000u64),
            500_000,
            prices(),
            gas(),
            SettlementPolicy {
                gas_buffer: 50_000,
                min_safe_profit_usd_wad: usd(900),
                state_drift_reserve_usd_wad: usd(1),
                execution_reserve_usd_wad: usd(1),
            },
        )?;
        assert_eq!(report.realized_profit_usd_wad(), usd(1_000));
        // 550k * 22 gwei * $4k/ETH = $48.40, plus $2 reserves.
        assert_eq!(
            report.reserved_gas_cost_usd_wad(),
            U256::from(48_400_000_000_000_000_000u128)
        );
        assert!(report.safe_profit_usd_wad() > usd(949));
        Ok(())
    }

    #[test]
    fn settlement_fails_closed_when_costs_consume_profit() {
        let result = settle_components(
            U256::from(1_000_000_000u64),
            500_000,
            prices(),
            gas(),
            SettlementPolicy {
                gas_buffer: 50_000,
                min_safe_profit_usd_wad: U256::ZERO,
                state_drift_reserve_usd_wad: usd(2_000),
                execution_reserve_usd_wad: U256::ZERO,
            },
        );
        assert!(matches!(result, Err(SettlementError::NoSafeProfit { .. })));
    }
}
