#!/usr/bin/env python3
"""Apply PFT-COMPAT-008 to an isolated recovered-source copy.

This does not modify the committed recovered source bytes. It repairs one measured
semantic defect: Aave account data must be accumulated in the oracle's native
base unit with collateral floor, debt ceil, and HF from the undivided weighted
liquidation-threshold numerator.
"""
from pathlib import Path
import argparse

def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected one exact anchor, found {count}")
    return text.replace(old, new, 1)

def patch_hot_state(root: Path):
    path = root / "crates/nqc-hot-state/src/lib.rs"
    text = path.read_text()

    text = replace_once(
        text,
        "use nqc_core::{ray_mul_half_up, MathError};",
        "use nqc_core::{checked_add, checked_mul, mul_div_ceil, mul_div_floor, ray_mul_half_up, wad, wad_div_half_up, MathError};",
        "hot-state imports",
    )

    text = replace_once(
        text,
        """#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationCandidate {
    pub user: Address,
    pub risk: AccountRisk,
}
""",
        """#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationCandidate {
    pub user: Address,
    pub risk: AccountRisk,
}

/// Exact Aave protocol-accounting view in the oracle's native base unit.
///
/// This exists alongside the legacy WAD-normalized economic view because Aave's
/// getUserAccountData semantics round each reserve in oracle-base units before
/// aggregation and compute HF from the undivided weighted threshold numerator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProtocolAccountRisk {
    pub oracle_base_unit: U256,
    pub collateral_base: U256,
    pub debt_base: U256,
    pub weighted_liquidation_threshold_numerator: U256,
    pub average_liquidation_threshold_bps: U256,
    pub health_factor_wad: Option<U256>,
}
""",
        "protocol risk type",
    )

    text = replace_once(
        text,
        """    #[error("position is not tracked for user {user} and reserve {asset}")]
    MissingPosition { user: Address, asset: Address },
""",
        """    #[error("position is not tracked for user {user} and reserve {asset}")]
    MissingPosition { user: Address, asset: Address },
    #[error("Aave oracle base unit is not configured")]
    MissingOracleBaseUnit,
    #[error("Aave oracle base unit cannot be zero")]
    ZeroOracleBaseUnit,
    #[error("Aave oracle base unit changed from {expected} to {actual}")]
    OracleBaseUnitMismatch { expected: U256, actual: U256 },
    #[error("Aave oracle-native price is not configured for reserve {0}")]
    MissingProtocolPrice(Address),
""",
        "protocol accounting errors",
    )

    text = replace_once(
        text,
        """pub struct AaveHotState {
    reserve_configs: HashMap<Address, ReserveConfig>,
    reserve_runtime: HashMap<Address, ReserveRuntime>,
""",
        """pub struct AaveHotState {
    reserve_configs: HashMap<Address, ReserveConfig>,
    reserve_runtime: HashMap<Address, ReserveRuntime>,
    oracle_base_unit: Option<U256>,
    reserve_price_oracle_units: HashMap<Address, U256>,
""",
        "hot-state protocol accounting fields",
    )

    configure_anchor = """    pub fn configure_emode_category(
        &mut self,
        category_id: u8,
"""
    configure_method = """    /// Binds the raw oracle price and base unit used by deployed Aave accounting.
    ///
    /// Repeated calls must use the identical base unit. This prevents mixing
    /// normalized WAD prices with a different protocol base-currency domain.
    pub fn configure_protocol_price(
        &mut self,
        asset: Address,
        price_oracle_units: U256,
        oracle_base_unit: U256,
    ) -> Result<(), HotStateError> {
        self.ensure_reserve(asset)?;
        if oracle_base_unit == U256::ZERO {
            return Err(HotStateError::ZeroOracleBaseUnit);
        }
        if let Some(expected) = self.oracle_base_unit {
            if expected != oracle_base_unit {
                return Err(HotStateError::OracleBaseUnitMismatch {
                    expected,
                    actual: oracle_base_unit,
                });
            }
        } else {
            self.oracle_base_unit = Some(oracle_base_unit);
        }
        self.reserve_price_oracle_units
            .insert(asset, price_oracle_units);
        self.mark_asset_users_dirty(asset);
        Ok(())
    }

"""
    text = replace_once(
        text,
        configure_anchor,
        configure_method + configure_anchor,
        "configure protocol price insertion",
    )

    account_anchor = """    pub fn account_risk_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<AccountRisk, HotStateError> {
"""
    exact_method = """    /// Reproduces deployed Aave getUserAccountData integer semantics.
    pub fn account_protocol_risk_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<ProtocolAccountRisk, HotStateError> {
        let oracle_base_unit = self
            .oracle_base_unit
            .ok_or(HotStateError::MissingOracleBaseUnit)?;
        let Some(account) = self.accounts.get(&user) else {
            return Ok(ProtocolAccountRisk {
                oracle_base_unit,
                collateral_base: U256::ZERO,
                debt_base: U256::ZERO,
                weighted_liquidation_threshold_numerator: U256::ZERO,
                average_liquidation_threshold_bps: U256::ZERO,
                health_factor_wad: None,
            });
        };

        let mut collateral_base = U256::ZERO;
        let mut debt_base = U256::ZERO;
        let mut weighted_threshold = U256::ZERO;

        for (asset, position) in &account.reserves {
            let config = self
                .reserve_configs
                .get(asset)
                .ok_or(HotStateError::UnknownReserve(*asset))?;
            let runtime = self
                .reserve_runtime
                .get(asset)
                .ok_or(HotStateError::MissingReserveRuntime(*asset))?;
            let price = *self
                .reserve_price_oracle_units
                .get(asset)
                .ok_or(HotStateError::MissingProtocolPrice(*asset))?;

            if current_timestamp < runtime.last_update_timestamp {
                return Err(HotStateError::Math(MathError::Underflow));
            }

            if position.collateral_enabled && position.scaled_atoken_balance != U256::ZERO {
                let normalized_income_ray = normalized_income(
                    runtime.liquidity_index_ray,
                    runtime.liquidity_rate_ray,
                    runtime.last_update_timestamp,
                    current_timestamp,
                )?;
                let amount =
                    ray_mul_half_up(position.scaled_atoken_balance, normalized_income_ray)?;
                // GenericLogic::_getUserBalanceInBaseCurrency: floor.
                let value_base = mul_div_floor(amount, price, config.token_unit)?;
                collateral_base = checked_add(collateral_base, value_base)?;
                let threshold = self.effective_liquidation_threshold(
                    account.e_mode_category,
                    *config,
                )?;
                weighted_threshold = checked_add(
                    weighted_threshold,
                    checked_mul(value_base, U256::from(threshold))?,
                )?;
            }

            if position.scaled_variable_debt != U256::ZERO {
                let normalized_debt_ray = normalized_variable_debt(
                    runtime.variable_borrow_index_ray,
                    runtime.variable_borrow_rate_ray,
                    runtime.last_update_timestamp,
                    current_timestamp,
                )?;
                let amount =
                    ray_mul_half_up(position.scaled_variable_debt, normalized_debt_ray)?;
                // GenericLogic::_getUserDebtInBaseCurrency: mulDivCeil.
                let value_base = mul_div_ceil(amount, price, config.token_unit)?;
                debt_base = checked_add(debt_base, value_base)?;
            }
        }

        let average_liquidation_threshold_bps = if collateral_base == U256::ZERO {
            U256::ZERO
        } else {
            weighted_threshold / collateral_base
        };
        let health_factor_wad = if debt_base == U256::ZERO {
            None
        } else {
            // GenericLogic: avgLiquidationThreshold.wadDiv(totalDebt) / 100_00.
            Some(wad_div_half_up(weighted_threshold, debt_base)? / U256::from(10_000u64))
        };

        Ok(ProtocolAccountRisk {
            oracle_base_unit,
            collateral_base,
            debt_base,
            weighted_liquidation_threshold_numerator: weighted_threshold,
            average_liquidation_threshold_bps,
            health_factor_wad,
        })
    }

"""
    text = replace_once(
        text,
        account_anchor,
        exact_method + account_anchor,
        "exact protocol risk insertion",
    )

    old_start = """    pub fn account_risk_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<AccountRisk, HotStateError> {
        let Some(account) = self.accounts.get(&user) else {
            return Ok(empty_risk());
        };

        let mut accumulator = AccountRiskAccumulator::default();
"""
    new_start = """    pub fn account_risk_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<AccountRisk, HotStateError> {
        if let Some(oracle_base_unit) = self.oracle_base_unit {
            let protocol = self.account_protocol_risk_at(user, current_timestamp)?;
            let weighted_denominator =
                checked_mul(oracle_base_unit, U256::from(10_000u64))?;
            return Ok(AccountRisk {
                collateral_usd_wad: mul_div_floor(
                    protocol.collateral_base,
                    wad(),
                    oracle_base_unit,
                )?,
                weighted_collateral_usd_wad: mul_div_floor(
                    protocol.weighted_liquidation_threshold_numerator,
                    wad(),
                    weighted_denominator,
                )?,
                debt_usd_wad: mul_div_floor(
                    protocol.debt_base,
                    wad(),
                    oracle_base_unit,
                )?,
                health_factor_wad: protocol.health_factor_wad,
            });
        }

        let Some(account) = self.accounts.get(&user) else {
            return Ok(empty_risk());
        };

        let mut accumulator = AccountRiskAccumulator::default();
"""
    text = replace_once(text, old_start, new_start, "account risk exact branch")

    path.write_text(text)

def patch_market(root: Path):
    path = root / "crates/nqc-aave-market/src/lib.rs"
    text = path.read_text()
    anchor = """            )?;
            reader.register_reserve(ReserveReadTarget {
                asset: reserve.asset,
"""
    replacement = """            )?;
            hot_state.configure_protocol_price(
                reserve.asset,
                reserve.price_oracle_units,
                self.oracle_base_unit,
            )?;
            reader.register_reserve(ReserveReadTarget {
                asset: reserve.asset,
"""
    text = replace_once(text, anchor, replacement, "market protocol price binding")
    path.write_text(text)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("root", type=Path)
    args = parser.parse_args()
    patch_hot_state(args.root)
    patch_market(args.root)

if __name__ == "__main__":
    main()
