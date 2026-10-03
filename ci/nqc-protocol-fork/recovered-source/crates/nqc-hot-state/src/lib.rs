use alloy::primitives::{keccak256, Address, B256, U256};
use nqc_aave_math::{
    is_liquidatable, normalized_income, normalized_variable_debt, AccountRisk,
    AccountRiskAccumulator, AaveMathError, CollateralPosition, DebtPosition,
};
use nqc_core::{ray_mul_half_up, MathError};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveConfig {
    pub reserve_id: u16,
    pub token_unit: U256,
    pub liquidation_threshold_bps: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveRuntime {
    pub price_usd_wad: U256,
    pub liquidity_index_ray: U256,
    pub variable_borrow_index_ray: U256,
    pub liquidity_rate_ray: U256,
    pub variable_borrow_rate_ray: U256,
    pub last_update_timestamp: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EModeCategory {
    pub liquidation_threshold_bps: u32,
    pub liquidation_bonus_bps: u32,
    pub collateral_bitmap: u128,
    pub borrowable_bitmap: u128,
    pub ltvzero_bitmap: u128,
    pub isolated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct AccountReservePosition {
    pub scaled_atoken_balance: U256,
    pub scaled_variable_debt: U256,
    pub collateral_enabled: bool,
}

impl AccountReservePosition {
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.scaled_atoken_balance == U256::ZERO && self.scaled_variable_debt == U256::ZERO
    }
}

#[derive(Debug, Clone, Default)]
struct AccountState {
    e_mode_category: u8,
    reserves: HashMap<Address, AccountReservePosition>,
}


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountReserveExposure {
    pub asset: Address,
    pub reserve_id: u16,
    pub token_unit: U256,
    pub price_usd_wad: U256,
    pub atoken_balance: U256,
    pub variable_debt: U256,
    pub collateral_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSnapshot {
    pub user: Address,
    pub valuation_timestamp: u64,
    pub e_mode_category: u8,
    pub risk: AccountRisk,
    pub reserves: Vec<AccountReserveExposure>,
}


impl AccountSnapshot {
    #[must_use]
    pub fn snapshot_hash(&self) -> B256 {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"NQC_AAVE_ACCOUNT_SNAPSHOT_V1");
        bytes.extend_from_slice(self.user.as_slice());
        bytes.extend_from_slice(&self.valuation_timestamp.to_be_bytes());
        bytes.push(self.e_mode_category);
        for value in [
            self.risk.collateral_usd_wad,
            self.risk.weighted_collateral_usd_wad,
            self.risk.debt_usd_wad,
        ] {
            bytes.extend_from_slice(&value.to_be_bytes::<32>());
        }
        match self.risk.health_factor_wad {
            Some(value) => {
                bytes.push(1);
                bytes.extend_from_slice(&value.to_be_bytes::<32>());
            }
            None => {
                bytes.push(0);
                bytes.extend_from_slice(&U256::ZERO.to_be_bytes::<32>());
            }
        }

        let mut reserves: Vec<&AccountReserveExposure> = self.reserves.iter().collect();
        reserves.sort_unstable_by_key(|reserve| (reserve.reserve_id, reserve.asset));
        bytes.extend_from_slice(&(reserves.len() as u64).to_be_bytes());
        for reserve in reserves {
            bytes.extend_from_slice(reserve.asset.as_slice());
            bytes.extend_from_slice(&reserve.reserve_id.to_be_bytes());
            for value in [
                reserve.token_unit,
                reserve.price_usd_wad,
                reserve.atoken_balance,
                reserve.variable_debt,
            ] {
                bytes.extend_from_slice(&value.to_be_bytes::<32>());
            }
            bytes.push(u8::from(reserve.collateral_enabled));
        }
        keccak256(bytes)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LiquidationCandidate {
    pub user: Address,
    pub risk: AccountRisk,
}

#[derive(Debug, Error)]
pub enum HotStateError {
    #[error("reserve is not configured: {0}")]
    UnknownReserve(Address),
    #[error("reserve runtime is unavailable: {0}")]
    MissingReserveRuntime(Address),
    #[error("reserve token unit cannot be zero: {0}")]
    ZeroTokenUnit(Address),
    #[error("reserve liquidity index cannot be zero: {0}")]
    ZeroLiquidityIndex(Address),
    #[error("reserve variable borrow index cannot be zero: {0}")]
    ZeroVariableBorrowIndex(Address),
    #[error("liquidation threshold exceeds 10,000 bps")]
    InvalidLiquidationThreshold,
    #[error("eMode category is not configured: {0}")]
    UnknownEModeCategory(u8),
    #[error("eMode liquidation bonus must be at least 10,000 bps")]
    InvalidEModeLiquidationBonus,
    #[error("position is not tracked for user {user} and reserve {asset}")]
    MissingPosition { user: Address, asset: Address },
    #[error(transparent)]
    Math(#[from] MathError),
    #[error(transparent)]
    AaveMath(#[from] AaveMathError),
}

#[derive(Debug, Clone, Default)]
pub struct AaveHotState {
    reserve_configs: HashMap<Address, ReserveConfig>,
    reserve_runtime: HashMap<Address, ReserveRuntime>,
    e_mode_categories: HashMap<u8, EModeCategory>,
    accounts: HashMap<Address, AccountState>,
    asset_users: HashMap<Address, HashSet<Address>>,
    e_mode_users: HashMap<u8, HashSet<Address>>,
    dirty_users: HashSet<Address>,
    borrowers: HashSet<Address>,
}

impl AaveHotState {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn configure_reserve(
        &mut self,
        asset: Address,
        config: ReserveConfig,
        runtime: ReserveRuntime,
    ) -> Result<(), HotStateError> {
        validate_reserve(asset, config, runtime)?;
        self.reserve_configs.insert(asset, config);
        self.reserve_runtime.insert(asset, runtime);
        self.mark_asset_users_dirty(asset);
        Ok(())
    }

    pub fn configure_emode_category(
        &mut self,
        category_id: u8,
        category: EModeCategory,
    ) -> Result<(), HotStateError> {
        if category_id == 0 {
            return Err(HotStateError::UnknownEModeCategory(0));
        }
        if category.liquidation_threshold_bps > 10_000 {
            return Err(HotStateError::InvalidLiquidationThreshold);
        }
        if category.liquidation_bonus_bps < 10_000 {
            return Err(HotStateError::InvalidEModeLiquidationBonus);
        }
        self.e_mode_categories.insert(category_id, category);
        if let Some(users) = self.e_mode_users.get(&category_id) {
            self.dirty_users.extend(users.iter().copied());
        }
        Ok(())
    }

    pub fn set_user_emode(&mut self, user: Address, category_id: u8) -> Result<(), HotStateError> {
        if category_id != 0 && !self.e_mode_categories.contains_key(&category_id) {
            return Err(HotStateError::UnknownEModeCategory(category_id));
        }

        let account = self.accounts.entry(user).or_default();
        let previous = account.e_mode_category;
        if previous == category_id {
            return Ok(());
        }
        account.e_mode_category = category_id;

        if previous != 0 {
            remove_user_from_index(&mut self.e_mode_users, previous, user);
        }
        if category_id != 0 {
            self.e_mode_users.entry(category_id).or_default().insert(user);
        }
        self.remove_account_if_empty(user);
        self.dirty_users.insert(user);
        Ok(())
    }

    pub fn update_price(&mut self, asset: Address, price_usd_wad: U256) -> Result<(), HotStateError> {
        let runtime = self
            .reserve_runtime
            .get_mut(&asset)
            .ok_or(HotStateError::MissingReserveRuntime(asset))?;
        runtime.price_usd_wad = price_usd_wad;
        self.mark_asset_users_dirty(asset);
        Ok(())
    }

    pub fn update_reserve_state(
        &mut self,
        asset: Address,
        liquidity_rate_ray: U256,
        variable_borrow_rate_ray: U256,
        liquidity_index_ray: U256,
        variable_borrow_index_ray: U256,
        update_timestamp: u64,
    ) -> Result<(), HotStateError> {
        if liquidity_index_ray == U256::ZERO {
            return Err(HotStateError::ZeroLiquidityIndex(asset));
        }
        if variable_borrow_index_ray == U256::ZERO {
            return Err(HotStateError::ZeroVariableBorrowIndex(asset));
        }

        let runtime = self
            .reserve_runtime
            .get_mut(&asset)
            .ok_or(HotStateError::MissingReserveRuntime(asset))?;
        runtime.liquidity_rate_ray = liquidity_rate_ray;
        runtime.variable_borrow_rate_ray = variable_borrow_rate_ray;
        runtime.liquidity_index_ray = liquidity_index_ray;
        runtime.variable_borrow_index_ray = variable_borrow_index_ray;
        runtime.last_update_timestamp = update_timestamp;
        self.mark_asset_users_dirty(asset);
        Ok(())
    }

    pub fn set_position(
        &mut self,
        user: Address,
        asset: Address,
        position: AccountReservePosition,
    ) -> Result<(), HotStateError> {
        self.ensure_reserve(asset)?;

        if position.is_empty() {
            if let Some(account) = self.accounts.get_mut(&user) {
                account.reserves.remove(&asset);
            }
            remove_user_from_index(&mut self.asset_users, asset, user);
            self.remove_account_if_empty(user);
        } else {
            self.accounts
                .entry(user)
                .or_default()
                .reserves
                .insert(asset, position);
            self.asset_users.entry(asset).or_default().insert(user);
        }

        self.refresh_borrower_membership(user);
        self.dirty_users.insert(user);
        Ok(())
    }

    pub fn set_collateral_enabled(
        &mut self,
        user: Address,
        asset: Address,
        enabled: bool,
    ) -> Result<(), HotStateError> {
        self.ensure_reserve(asset)?;
        let account = self
            .accounts
            .get_mut(&user)
            .ok_or(HotStateError::MissingPosition { user, asset })?;
        let position = account
            .reserves
            .get_mut(&asset)
            .ok_or(HotStateError::MissingPosition { user, asset })?;
        position.collateral_enabled = enabled;
        self.dirty_users.insert(user);
        Ok(())
    }

    pub fn mark_all_borrowers_dirty(&mut self) {
        self.dirty_users.extend(self.borrowers.iter().copied());
    }

    #[must_use]
    pub fn tracked_borrowers(&self) -> usize {
        self.borrowers.len()
    }

    pub fn account_risk_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<AccountRisk, HotStateError> {
        let Some(account) = self.accounts.get(&user) else {
            return Ok(empty_risk());
        };

        let mut accumulator = AccountRiskAccumulator::default();
        for (asset, position) in &account.reserves {
            let config = self
                .reserve_configs
                .get(asset)
                .ok_or(HotStateError::UnknownReserve(*asset))?;
            let runtime = self
                .reserve_runtime
                .get(asset)
                .ok_or(HotStateError::MissingReserveRuntime(*asset))?;

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
                let amount = ray_mul_half_up(position.scaled_atoken_balance, normalized_income_ray)?;
                accumulator.add_collateral(CollateralPosition {
                    amount,
                    price_usd_wad: runtime.price_usd_wad,
                    token_unit: config.token_unit,
                    liquidation_threshold_bps: self.effective_liquidation_threshold(
                        account.e_mode_category,
                        *config,
                    )?,
                })?;
            }

            if position.scaled_variable_debt != U256::ZERO {
                let normalized_debt_ray = normalized_variable_debt(
                    runtime.variable_borrow_index_ray,
                    runtime.variable_borrow_rate_ray,
                    runtime.last_update_timestamp,
                    current_timestamp,
                )?;
                let amount = ray_mul_half_up(position.scaled_variable_debt, normalized_debt_ray)?;
                accumulator.add_debt(DebtPosition {
                    amount,
                    price_usd_wad: runtime.price_usd_wad,
                    token_unit: config.token_unit,
                })?;
            }
        }

        Ok(accumulator.finish()?)
    }

    pub fn account_snapshot_at(
        &self,
        user: Address,
        current_timestamp: u64,
    ) -> Result<Option<AccountSnapshot>, HotStateError> {
        let Some(account) = self.accounts.get(&user) else {
            return Ok(None);
        };
        let risk = self.account_risk_at(user, current_timestamp)?;
        let mut reserves = Vec::with_capacity(account.reserves.len());
        for (asset, position) in &account.reserves {
            let config = self
                .reserve_configs
                .get(asset)
                .ok_or(HotStateError::UnknownReserve(*asset))?;
            let runtime = self
                .reserve_runtime
                .get(asset)
                .ok_or(HotStateError::MissingReserveRuntime(*asset))?;
            if current_timestamp < runtime.last_update_timestamp {
                return Err(HotStateError::Math(MathError::Underflow));
            }
            let atoken_balance = if position.scaled_atoken_balance == U256::ZERO {
                U256::ZERO
            } else {
                let index = normalized_income(
                    runtime.liquidity_index_ray,
                    runtime.liquidity_rate_ray,
                    runtime.last_update_timestamp,
                    current_timestamp,
                )?;
                ray_mul_half_up(position.scaled_atoken_balance, index)?
            };
            let variable_debt = if position.scaled_variable_debt == U256::ZERO {
                U256::ZERO
            } else {
                let index = normalized_variable_debt(
                    runtime.variable_borrow_index_ray,
                    runtime.variable_borrow_rate_ray,
                    runtime.last_update_timestamp,
                    current_timestamp,
                )?;
                ray_mul_half_up(position.scaled_variable_debt, index)?
            };
            reserves.push(AccountReserveExposure {
                asset: *asset,
                reserve_id: config.reserve_id,
                token_unit: config.token_unit,
                price_usd_wad: runtime.price_usd_wad,
                atoken_balance,
                variable_debt,
                collateral_enabled: position.collateral_enabled,
            });
        }
        reserves.sort_unstable_by_key(|reserve| reserve.reserve_id);
        Ok(Some(AccountSnapshot {
            user,
            valuation_timestamp: current_timestamp,
            e_mode_category: account.e_mode_category,
            risk,
            reserves,
        }))
    }

    pub fn drain_liquidation_candidates_at(
        &mut self,
        current_timestamp: u64,
    ) -> Result<Vec<LiquidationCandidate>, HotStateError> {
        let mut dirty: Vec<Address> = self.dirty_users.drain().collect();
        dirty.sort_unstable();

        let mut candidates = Vec::new();
        for user in dirty {
            let risk = self.account_risk_at(user, current_timestamp)?;
            if is_liquidatable(risk.health_factor_wad) {
                candidates.push(LiquidationCandidate { user, risk });
            }
        }

        candidates.sort_unstable_by(|left, right| {
            left.risk
                .health_factor_wad
                .cmp(&right.risk.health_factor_wad)
                .then_with(|| left.user.cmp(&right.user))
        });
        Ok(candidates)
    }

    #[must_use]
    pub fn tracked_accounts(&self) -> usize {
        self.accounts.len()
    }

    #[must_use]
    pub fn tracked_reserves(&self) -> usize {
        self.reserve_configs.len()
    }

    #[must_use]
    pub fn dirty_accounts(&self) -> usize {
        self.dirty_users.len()
    }

    fn effective_liquidation_threshold(
        &self,
        e_mode_category: u8,
        reserve: ReserveConfig,
    ) -> Result<u32, HotStateError> {
        if e_mode_category == 0 {
            return Ok(reserve.liquidation_threshold_bps);
        }
        let category = self
            .e_mode_categories
            .get(&e_mode_category)
            .ok_or(HotStateError::UnknownEModeCategory(e_mode_category))?;
        if reserve.reserve_id < 128
            && category.collateral_bitmap & (1u128 << reserve.reserve_id) != 0
        {
            Ok(category.liquidation_threshold_bps)
        } else {
            Ok(reserve.liquidation_threshold_bps)
        }
    }

    fn ensure_reserve(&self, asset: Address) -> Result<(), HotStateError> {
        if !self.reserve_configs.contains_key(&asset) {
            return Err(HotStateError::UnknownReserve(asset));
        }
        if !self.reserve_runtime.contains_key(&asset) {
            return Err(HotStateError::MissingReserveRuntime(asset));
        }
        Ok(())
    }

    fn mark_asset_users_dirty(&mut self, asset: Address) {
        if let Some(users) = self.asset_users.get(&asset) {
            self.dirty_users.extend(users.iter().copied());
        }
    }

    fn refresh_borrower_membership(&mut self, user: Address) {
        let has_debt = self.accounts.get(&user).is_some_and(|account| {
            account
                .reserves
                .values()
                .any(|position| position.scaled_variable_debt != U256::ZERO)
        });
        if has_debt {
            self.borrowers.insert(user);
        } else {
            self.borrowers.remove(&user);
        }
    }

    fn remove_account_if_empty(&mut self, user: Address) {
        let should_remove = self
            .accounts
            .get(&user)
            .is_some_and(|account| account.reserves.is_empty() && account.e_mode_category == 0);
        if should_remove {
            self.accounts.remove(&user);
        }
    }
}

fn empty_risk() -> AccountRisk {
    AccountRisk {
        collateral_usd_wad: U256::ZERO,
        weighted_collateral_usd_wad: U256::ZERO,
        debt_usd_wad: U256::ZERO,
        health_factor_wad: None,
    }
}

fn validate_reserve(
    asset: Address,
    config: ReserveConfig,
    runtime: ReserveRuntime,
) -> Result<(), HotStateError> {
    if config.token_unit == U256::ZERO {
        return Err(HotStateError::ZeroTokenUnit(asset));
    }
    if config.liquidation_threshold_bps > 10_000 {
        return Err(HotStateError::InvalidLiquidationThreshold);
    }
    if runtime.liquidity_index_ray == U256::ZERO {
        return Err(HotStateError::ZeroLiquidityIndex(asset));
    }
    if runtime.variable_borrow_index_ray == U256::ZERO {
        return Err(HotStateError::ZeroVariableBorrowIndex(asset));
    }
    Ok(())
}

fn remove_user_from_index<K>(index: &mut HashMap<K, HashSet<Address>>, key: K, user: Address)
where
    K: std::hash::Hash + Eq + Copy,
{
    if let Some(users) = index.get_mut(&key) {
        users.remove(&user);
        if users.is_empty() {
            index.remove(&key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_core::{ray, wad};

    fn addr(last: u8) -> Address {
        Address::from([last; 20])
    }

    fn usd(amount: u64) -> U256 {
        U256::from(amount) * wad()
    }

    fn reserve(
        reserve_id: u16,
        price: u64,
        liquidation_threshold_bps: u32,
    ) -> (ReserveConfig, ReserveRuntime) {
        (
            ReserveConfig {
                reserve_id,
                token_unit: wad(),
                liquidation_threshold_bps,
            },
            ReserveRuntime {
                price_usd_wad: usd(price),
                liquidity_index_ray: ray(),
                variable_borrow_index_ray: ray(),
                liquidity_rate_ray: U256::ZERO,
                variable_borrow_rate_ray: U256::ZERO,
                last_update_timestamp: 100,
            },
        )
    }

    #[test]
    fn price_shock_marks_only_exposed_accounts_and_emits_candidate() -> Result<(), HotStateError> {
        let weth = addr(1);
        let usdc = addr(2);
        let user = addr(9);
        let unrelated = addr(8);
        let mut state = AaveHotState::new();

        let (weth_config, weth_runtime) = reserve(0, 2_000, 8_000);
        let (usdc_config, usdc_runtime) = reserve(1, 1, 0);
        state.configure_reserve(weth, weth_config, weth_runtime)?;
        state.configure_reserve(usdc, usdc_config, usdc_runtime)?;

        state.set_position(
            user,
            weth,
            AccountReservePosition {
                scaled_atoken_balance: U256::from(10u64) * wad(),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;
        state.set_position(
            user,
            usdc,
            AccountReservePosition {
                scaled_atoken_balance: U256::ZERO,
                scaled_variable_debt: usd(15_000),
                collateral_enabled: false,
            },
        )?;
        state.set_position(
            unrelated,
            usdc,
            AccountReservePosition {
                scaled_atoken_balance: usd(1_000),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;

        let initial = state.drain_liquidation_candidates_at(100)?;
        assert!(initial.is_empty());

        state.update_price(weth, usd(1_800))?;
        assert_eq!(state.dirty_accounts(), 1);
        let candidates = state.drain_liquidation_candidates_at(100)?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].user, user);
        Ok(())
    }

    #[test]
    fn interest_accrual_can_cross_liquidation_boundary_without_new_reserve_event(
    ) -> Result<(), HotStateError> {
        let collateral = addr(1);
        let debt = addr(2);
        let user = addr(3);
        let mut state = AaveHotState::new();
        let (collateral_config, collateral_runtime) = reserve(0, 1, 8_000);
        let (debt_config, mut debt_runtime) = reserve(1, 1, 0);
        debt_runtime.variable_borrow_rate_ray = ray();
        state.configure_reserve(collateral, collateral_config, collateral_runtime)?;
        state.configure_reserve(debt, debt_config, debt_runtime)?;
        state.set_position(
            user,
            collateral,
            AccountReservePosition {
                scaled_atoken_balance: usd(10_000),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;
        state.set_position(
            user,
            debt,
            AccountReservePosition {
                scaled_atoken_balance: U256::ZERO,
                scaled_variable_debt: usd(7_900),
                collateral_enabled: false,
            },
        )?;
        assert!(state.drain_liquidation_candidates_at(100)?.is_empty());

        state.mark_all_borrowers_dirty();
        assert_eq!(state.tracked_borrowers(), 1);
        let one_week_later = 100 + 7 * 24 * 60 * 60;
        let candidates = state.drain_liquidation_candidates_at(one_week_later)?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].user, user);
        Ok(())
    }

    #[test]
    fn emode_threshold_is_applied_only_to_category_collateral() -> Result<(), HotStateError> {
        let collateral = addr(1);
        let debt = addr(2);
        let user = addr(3);
        let mut state = AaveHotState::new();
        let (collateral_config, collateral_runtime) = reserve(5, 1, 8_000);
        let (debt_config, debt_runtime) = reserve(6, 1, 0);
        state.configure_reserve(collateral, collateral_config, collateral_runtime)?;
        state.configure_reserve(debt, debt_config, debt_runtime)?;
        state.configure_emode_category(
            1,
            EModeCategory {
                liquidation_threshold_bps: 9_500,
                liquidation_bonus_bps: 10_100,
                collateral_bitmap: 1u128 << 5,
                borrowable_bitmap: 1u128 << 6,
                ltvzero_bitmap: 0,
                isolated: false,
            },
        )?;
        state.set_position(
            user,
            collateral,
            AccountReservePosition {
                scaled_atoken_balance: usd(10_000),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;
        state.set_position(
            user,
            debt,
            AccountReservePosition {
                scaled_atoken_balance: U256::ZERO,
                scaled_variable_debt: usd(9_000),
                collateral_enabled: false,
            },
        )?;
        state.set_user_emode(user, 1)?;
        assert!(state.drain_liquidation_candidates_at(100)?.is_empty());

        state.set_user_emode(user, 0)?;
        let candidates = state.drain_liquidation_candidates_at(100)?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].user, user);
        Ok(())
    }

    #[test]
    fn disabling_collateral_recalculates_account_immediately() -> Result<(), HotStateError> {
        let asset_a = addr(1);
        let asset_b = addr(2);
        let user = addr(3);
        let mut state = AaveHotState::new();
        let (a_config, a_runtime) = reserve(0, 1, 8_000);
        let (b_config, b_runtime) = reserve(1, 1, 8_000);
        state.configure_reserve(asset_a, a_config, a_runtime)?;
        state.configure_reserve(asset_b, b_config, b_runtime)?;

        state.set_position(
            user,
            asset_a,
            AccountReservePosition {
                scaled_atoken_balance: usd(5_000),
                scaled_variable_debt: usd(6_000),
                collateral_enabled: true,
            },
        )?;
        state.set_position(
            user,
            asset_b,
            AccountReservePosition {
                scaled_atoken_balance: usd(5_000),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;
        assert!(state.drain_liquidation_candidates_at(100)?.is_empty());

        state.set_collateral_enabled(user, asset_b, false)?;
        let candidates = state.drain_liquidation_candidates_at(100)?;
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].user, user);
        Ok(())
    }


    #[test]
    fn account_snapshot_hash_is_order_independent_and_value_sensitive() {
        let exposure_a = AccountReserveExposure {
            asset: addr(1),
            reserve_id: 0,
            token_unit: wad(),
            price_usd_wad: usd(2_000),
            atoken_balance: U256::from(5u64) * wad(),
            variable_debt: U256::ZERO,
            collateral_enabled: true,
        };
        let exposure_b = AccountReserveExposure {
            asset: addr(2),
            reserve_id: 1,
            token_unit: wad(),
            price_usd_wad: usd(1),
            atoken_balance: U256::ZERO,
            variable_debt: usd(7_500),
            collateral_enabled: false,
        };
        let risk = AccountRisk {
            collateral_usd_wad: usd(10_000),
            weighted_collateral_usd_wad: usd(8_000),
            debt_usd_wad: usd(7_500),
            health_factor_wad: Some(U256::from(1_066_666_666_666_666_666u128)),
        };
        let left = AccountSnapshot {
            user: addr(9),
            valuation_timestamp: 100,
            e_mode_category: 0,
            risk,
            reserves: vec![exposure_a, exposure_b],
        };
        let right = AccountSnapshot {
            reserves: vec![exposure_b, exposure_a],
            ..left.clone()
        };
        assert_eq!(left.snapshot_hash(), right.snapshot_hash());

        let mut drifted = right.clone();
        drifted.reserves[0].variable_debt += U256::from(1u8);
        assert_ne!(left.snapshot_hash(), drifted.snapshot_hash());
    }

    #[test]
    fn clearing_last_position_removes_account_from_tracking() -> Result<(), HotStateError> {
        let asset = addr(1);
        let user = addr(2);
        let mut state = AaveHotState::new();
        let (config, runtime) = reserve(0, 1, 8_000);
        state.configure_reserve(asset, config, runtime)?;
        state.set_position(
            user,
            asset,
            AccountReservePosition {
                scaled_atoken_balance: wad(),
                scaled_variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
        )?;
        assert_eq!(state.tracked_accounts(), 1);

        state.set_position(user, asset, AccountReservePosition::default())?;
        assert_eq!(state.tracked_accounts(), 0);
        Ok(())
    }
}
