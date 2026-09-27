use alloy::primitives::{Address, U256};
use nqc_hot_state::{AccountReservePosition, AaveHotState, HotStateError};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

pub const AAVE_V3_MAX_RESERVES: u16 = 128;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveConfigurationBits(pub U256);

impl ReserveConfigurationBits {
    #[must_use]
    pub fn liquidation_threshold_bps(self) -> u32 {
        low_u32((self.0 >> 16) & U256::from(0xffffu32))
    }

    #[must_use]
    pub fn liquidation_bonus_bps(self) -> u32 {
        low_u32((self.0 >> 32) & U256::from(0xffffu32))
    }

    #[must_use]
    pub fn decimals(self) -> u8 {
        low_u8((self.0 >> 48) & U256::from(0xffu16))
    }

    #[must_use]
    pub fn is_active(self) -> bool {
        bit(self.0, 56)
    }

    #[must_use]
    pub fn is_frozen(self) -> bool {
        bit(self.0, 57)
    }

    #[must_use]
    pub fn borrowing_enabled(self) -> bool {
        bit(self.0, 58)
    }

    #[must_use]
    pub fn is_paused(self) -> bool {
        bit(self.0, 60)
    }

    #[must_use]
    pub fn flash_loan_enabled(self) -> bool {
        bit(self.0, 63)
    }

    #[must_use]
    pub fn liquidation_protocol_fee_bps(self) -> u32 {
        low_u32((self.0 >> 152) & U256::from(0xffffu32))
    }

    #[must_use]
    pub fn token_unit(self) -> U256 {
        U256::from(10u8).pow(U256::from(self.decimals()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserConfigurationBits(pub U256);

impl UserConfigurationBits {
    #[must_use]
    pub fn is_borrowing_any(self) -> bool {
        let borrow_mask = U256::from_limbs([0x5555_5555_5555_5555u64; 4]);
        (self.0 & borrow_mask) != U256::ZERO
    }

    #[must_use]
    pub fn is_using_any_as_collateral(self) -> bool {
        let collateral_mask = U256::from_limbs([0xAAAA_AAAA_AAAA_AAAAu64; 4]);
        (self.0 & collateral_mask) != U256::ZERO
    }

    pub fn is_borrowing(self, reserve_id: u16) -> Result<bool, SyncError> {
        validate_reserve_id(reserve_id)?;
        Ok(bit(self.0, u32::from(reserve_id) * 2))
    }

    pub fn is_using_as_collateral(self, reserve_id: u16) -> Result<bool, SyncError> {
        validate_reserve_id(reserve_id)?;
        Ok(bit(self.0, u32::from(reserve_id) * 2 + 1))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReservePositionSnapshot {
    pub asset: Address,
    pub reserve_id: u16,
    pub scaled_atoken_balance: U256,
    pub scaled_variable_debt: U256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserPositionSnapshot {
    pub user: Address,
    pub user_configuration: UserConfigurationBits,
    pub e_mode_category: u8,
    pub reserves: Vec<ReservePositionSnapshot>,
}

impl UserPositionSnapshot {
    pub fn apply(self, hot_state: &mut AaveHotState) -> Result<(), SyncError> {
        hot_state.set_user_emode(self.user, self.e_mode_category)?;
        for reserve in self.reserves {
            validate_reserve_id(reserve.reserve_id)?;
            let collateral_enabled = self
                .user_configuration
                .is_using_as_collateral(reserve.reserve_id)?;
            hot_state.set_position(
                self.user,
                reserve.asset,
                AccountReservePosition {
                    scaled_atoken_balance: reserve.scaled_atoken_balance,
                    scaled_variable_debt: reserve.scaled_variable_debt,
                    collateral_enabled,
                },
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AaveImpact {
    Supply {
        asset: Address,
        on_behalf_of: Address,
    },
    Withdraw {
        asset: Address,
        user: Address,
    },
    Borrow {
        asset: Address,
        on_behalf_of: Address,
    },
    Repay {
        asset: Address,
        user: Address,
    },
    Liquidation {
        collateral_asset: Address,
        debt_asset: Address,
        borrower: Address,
    },
    CollateralEnabled {
        asset: Address,
        user: Address,
    },
    CollateralDisabled {
        asset: Address,
        user: Address,
    },
    UserEModeChanged {
        user: Address,
    },
    ATokenBalanceTransfer {
        asset: Address,
        from: Address,
        to: Address,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshRequest {
    pub user: Address,
    pub assets: Vec<Address>,
    pub refresh_user_configuration: bool,
    pub refresh_emode: bool,
}

#[derive(Debug, Default)]
struct PendingRefresh {
    assets: HashSet<Address>,
    refresh_user_configuration: bool,
    refresh_emode: bool,
}

#[derive(Debug, Default)]
pub struct RefreshPlanner {
    users: HashMap<Address, PendingRefresh>,
}

impl RefreshPlanner {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn observe(&mut self, impact: AaveImpact) {
        match impact {
            AaveImpact::Supply {
                asset,
                on_behalf_of,
            }
            | AaveImpact::Borrow {
                asset,
                on_behalf_of,
            } => self.mark(on_behalf_of, [asset], true, false),
            AaveImpact::Withdraw { asset, user } | AaveImpact::Repay { asset, user } => {
                self.mark(user, [asset], true, false);
            }
            AaveImpact::Liquidation {
                collateral_asset,
                debt_asset,
                borrower,
            } => self.mark(
                borrower,
                [collateral_asset, debt_asset],
                true,
                false,
            ),
            AaveImpact::CollateralEnabled { asset, user }
            | AaveImpact::CollateralDisabled { asset, user } => {
                self.mark(user, [asset], true, false);
            }
            AaveImpact::UserEModeChanged { user } => self.mark(user, [], false, true),
            AaveImpact::ATokenBalanceTransfer { asset, from, to } => {
                if from != Address::ZERO {
                    self.mark(from, [asset], true, false);
                }
                if to != Address::ZERO {
                    self.mark(to, [asset], true, false);
                }
            }
        }
    }

    #[must_use]
    pub fn pending_users(&self) -> usize {
        self.users.len()
    }

    pub fn drain(&mut self) -> Vec<RefreshRequest> {
        let mut entries: Vec<(Address, PendingRefresh)> = self.users.drain().collect();
        entries.sort_unstable_by_key(|(user, _)| *user);
        entries
            .into_iter()
            .map(|(user, pending)| {
                let mut assets: Vec<Address> = pending.assets.into_iter().collect();
                assets.sort_unstable();
                RefreshRequest {
                    user,
                    assets,
                    refresh_user_configuration: pending.refresh_user_configuration,
                    refresh_emode: pending.refresh_emode,
                }
            })
            .collect()
    }

    fn mark<const N: usize>(
        &mut self,
        user: Address,
        assets: [Address; N],
        refresh_user_configuration: bool,
        refresh_emode: bool,
    ) {
        let pending = self.users.entry(user).or_default();
        pending.assets.extend(assets);
        pending.refresh_user_configuration |= refresh_user_configuration;
        pending.refresh_emode |= refresh_emode;
    }
}

#[derive(Debug, Default)]
pub struct ReserveRegistry {
    by_asset: HashMap<Address, u16>,
    by_id: HashMap<u16, Address>,
}

impl ReserveRegistry {
    pub fn insert(&mut self, asset: Address, reserve_id: u16) -> Result<(), SyncError> {
        validate_reserve_id(reserve_id)?;
        if let Some(existing_asset) = self.by_id.get(&reserve_id) {
            if *existing_asset != asset {
                return Err(SyncError::DuplicateReserveId {
                    reserve_id,
                    existing_asset: *existing_asset,
                    new_asset: asset,
                });
            }
        }
        if let Some(existing_id) = self.by_asset.get(&asset) {
            if *existing_id != reserve_id {
                return Err(SyncError::AssetReserveIdChanged {
                    asset,
                    existing_id: *existing_id,
                    new_id: reserve_id,
                });
            }
        }
        self.by_asset.insert(asset, reserve_id);
        self.by_id.insert(reserve_id, asset);
        Ok(())
    }

    #[must_use]
    pub fn reserve_id(&self, asset: Address) -> Option<u16> {
        self.by_asset.get(&asset).copied()
    }

    #[must_use]
    pub fn asset(&self, reserve_id: u16) -> Option<Address> {
        self.by_id.get(&reserve_id).copied()
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.by_asset.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_asset.is_empty()
    }
}

#[derive(Debug, Error)]
pub enum SyncError {
    #[error("Aave V3 reserve id {0} exceeds the 128-reserve user bitmap")]
    InvalidReserveId(u16),
    #[error(
        "reserve id {reserve_id} is already assigned to {existing_asset}, cannot assign {new_asset}"
    )]
    DuplicateReserveId {
        reserve_id: u16,
        existing_asset: Address,
        new_asset: Address,
    },
    #[error("asset {asset} changed reserve id from {existing_id} to {new_id}")]
    AssetReserveIdChanged {
        asset: Address,
        existing_id: u16,
        new_id: u16,
    },
    #[error(transparent)]
    HotState(#[from] HotStateError),
}

fn validate_reserve_id(reserve_id: u16) -> Result<(), SyncError> {
    if reserve_id >= AAVE_V3_MAX_RESERVES {
        return Err(SyncError::InvalidReserveId(reserve_id));
    }
    Ok(())
}

fn bit(value: U256, position: u32) -> bool {
    ((value >> position) & U256::from(1u8)) != U256::ZERO
}

fn low_u32(value: U256) -> u32 {
    value.as_limbs()[0] as u32
}

fn low_u8(value: U256) -> u8 {
    value.as_limbs()[0] as u8
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_core::{ray, wad};
    use nqc_hot_state::{ReserveConfig, ReserveRuntime};

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn usd(amount: u64) -> U256 {
        U256::from(amount) * wad()
    }

    fn configure_two_reserves(state: &mut AaveHotState) -> Result<(), HotStateError> {
        for (asset, reserve_id, threshold) in [(addr(1), 0u16, 8_000u32), (addr(2), 1u16, 0u32)] {
            state.configure_reserve(
                asset,
                ReserveConfig {
                    reserve_id,
                    token_unit: wad(),
                    liquidation_threshold_bps: threshold,
                },
                ReserveRuntime {
                    price_usd_wad: wad(),
                    liquidity_index_ray: ray(),
                    variable_borrow_index_ray: ray(),
                    liquidity_rate_ray: U256::ZERO,
                    variable_borrow_rate_ray: U256::ZERO,
                    last_update_timestamp: 0,
                },
            )?;
        }
        Ok(())
    }

    #[test]
    fn parses_reserve_configuration_layout() {
        let mut raw = U256::ZERO;
        raw |= U256::from(8_250u32) << 16;
        raw |= U256::from(10_500u32) << 32;
        raw |= U256::from(6u8) << 48;
        raw |= U256::from(1u8) << 56;
        raw |= U256::from(1u8) << 58;
        raw |= U256::from(1u8) << 63;
        let config = ReserveConfigurationBits(raw);
        assert_eq!(config.liquidation_threshold_bps(), 8_250);
        assert_eq!(config.liquidation_bonus_bps(), 10_500);
        assert_eq!(config.decimals(), 6);
        assert!(config.is_active());
        assert!(!config.is_frozen());
        assert!(config.borrowing_enabled());
        assert!(!config.is_paused());
        assert!(config.flash_loan_enabled());
        assert_eq!(config.token_unit(), U256::from(1_000_000u64));
    }

    #[test]
    fn parses_user_configuration_pair_bits() -> Result<(), SyncError> {
        let raw = (U256::from(1u8) << 2) | (U256::from(1u8) << 5);
        let config = UserConfigurationBits(raw);
        assert!(config.is_borrowing(1)?);
        assert!(!config.is_using_as_collateral(1)?);
        assert!(!config.is_borrowing(2)?);
        assert!(config.is_using_as_collateral(2)?);
        Ok(())
    }

    #[test]
    fn snapshot_applies_authoritative_scaled_balances() -> Result<(), SyncError> {
        let user = addr(9);
        let mut state = AaveHotState::new();
        configure_two_reserves(&mut state)?;
        let user_config = UserConfigurationBits(
            (U256::from(1u8) << 1) | (U256::from(1u8) << 2),
        );
        UserPositionSnapshot {
            user,
            user_configuration: user_config,
            e_mode_category: 0,
            reserves: vec![
                ReservePositionSnapshot {
                    asset: addr(1),
                    reserve_id: 0,
                    scaled_atoken_balance: usd(10_000),
                    scaled_variable_debt: U256::ZERO,
                },
                ReservePositionSnapshot {
                    asset: addr(2),
                    reserve_id: 1,
                    scaled_atoken_balance: U256::ZERO,
                    scaled_variable_debt: usd(7_000),
                },
            ],
        }
        .apply(&mut state)?;

        let risk = state.account_risk_at(user, 0)?;
        assert_eq!(risk.collateral_usd_wad, usd(10_000));
        assert_eq!(risk.debt_usd_wad, usd(7_000));
        assert!(risk.health_factor_wad.is_some());
        Ok(())
    }

    #[test]
    fn refresh_planner_deduplicates_users_and_assets() {
        let user = addr(1);
        let other = addr(2);
        let asset_a = addr(10);
        let asset_b = addr(11);
        let mut planner = RefreshPlanner::new();
        planner.observe(AaveImpact::Supply {
            asset: asset_a,
            on_behalf_of: user,
        });
        planner.observe(AaveImpact::Borrow {
            asset: asset_b,
            on_behalf_of: user,
        });
        planner.observe(AaveImpact::ATokenBalanceTransfer {
            asset: asset_a,
            from: user,
            to: other,
        });
        assert_eq!(planner.pending_users(), 2);

        let requests = planner.drain();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].user, user);
        assert_eq!(requests[0].assets, vec![asset_a, asset_b]);
        assert!(requests[0].refresh_user_configuration);
        assert!(!requests[0].refresh_emode);
        assert_eq!(requests[1].user, other);
        assert_eq!(requests[1].assets, vec![asset_a]);
        assert_eq!(planner.pending_users(), 0);
    }

    #[test]
    fn registry_rejects_id_aliasing() -> Result<(), SyncError> {
        let mut registry = ReserveRegistry::default();
        registry.insert(addr(1), 3)?;
        assert!(matches!(
            registry.insert(addr(2), 3),
            Err(SyncError::DuplicateReserveId { .. })
        ));
        Ok(())
    }
}
