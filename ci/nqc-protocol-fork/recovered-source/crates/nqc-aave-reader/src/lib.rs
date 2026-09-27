use alloy::{
    eips::BlockId,
    primitives::{Address, U256},
    providers::{DynProvider, Provider},
    sol,
};
use nqc_aave_sync::{RefreshRequest, ReservePositionSnapshot, UserConfigurationBits, UserPositionSnapshot};
use nqc_hot_state::AaveHotState;
use nqc_state::{CanonicalBlock, RethIpcSource, StateError};
use std::collections::HashMap;
use thiserror::Error;

sol! {
    #[sol(rpc)]
    interface IAavePoolView {
        function getUserConfiguration(address user) external view returns (uint256);
        function getUserEMode(address user) external view returns (uint256);
    }

    #[sol(rpc)]
    interface IScaledBalanceTokenView {
        function scaledBalanceOf(address user) external view returns (uint256);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ReserveReadTarget {
    pub asset: Address,
    pub reserve_id: u16,
    pub a_token: Address,
    pub variable_debt_token: Address,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockPinnedSnapshot {
    pub anchor: CanonicalBlock,
    pub snapshot: UserPositionSnapshot,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UserMetaSnapshot {
    pub user: Address,
    pub user_configuration: UserConfigurationBits,
    pub e_mode_category: u8,
}

#[derive(Clone)]
pub struct AaveLocalReader {
    provider: DynProvider,
    pool: Address,
    chain_id: u64,
    targets: HashMap<Address, ReserveReadTarget>,
}

impl AaveLocalReader {
    pub async fn from_reth(
        source: &RethIpcSource,
        pool: Address,
        expected_chain_id: u64,
    ) -> Result<Self, ReaderError> {
        if pool == Address::ZERO {
            return Err(ReaderError::ZeroPoolAddress);
        }
        let actual_chain_id = source.chain_id().await?;
        if actual_chain_id != expected_chain_id {
            return Err(ReaderError::ChainIdMismatch {
                expected: expected_chain_id,
                actual: actual_chain_id,
            });
        }
        Ok(Self {
            provider: source.provider(),
            pool,
            chain_id: actual_chain_id,
            targets: HashMap::new(),
        })
    }

    #[must_use]
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    #[must_use]
    pub fn pool(&self) -> Address {
        self.pool
    }

    #[must_use]
    pub fn registered_reserves(&self) -> usize {
        self.targets.len()
    }

    pub fn register_reserve(&mut self, target: ReserveReadTarget) -> Result<(), ReaderError> {
        validate_target(target)?;
        if let Some(existing) = self.targets.get(&target.asset) {
            if *existing != target {
                return Err(ReaderError::ReserveTargetChanged {
                    asset: target.asset,
                });
            }
            return Ok(());
        }
        if self
            .targets
            .values()
            .any(|existing| existing.reserve_id == target.reserve_id && existing.asset != target.asset)
        {
            return Err(ReaderError::ReserveIdCollision(target.reserve_id));
        }
        self.targets.insert(target.asset, target);
        Ok(())
    }

    pub async fn read_refresh(
        &self,
        request: &RefreshRequest,
    ) -> Result<BlockPinnedSnapshot, ReaderError> {
        let block_number = self
            .provider
            .get_block_number()
            .await
            .map_err(|error| ReaderError::Contract(error.to_string()))?;
        let anchor = self.anchor_at(block_number).await?;
        self.read_refresh_at(request, anchor).await
    }

    pub async fn read_user_meta_at(
        &self,
        user: Address,
        anchor: CanonicalBlock,
    ) -> Result<UserMetaSnapshot, ReaderError> {
        let block = BlockId::hash_canonical(anchor.hash);
        let pool = IAavePoolView::new(self.pool, &self.provider);
        let configuration_call = pool.getUserConfiguration(user).block(block);
        let emode_call = pool.getUserEMode(user).block(block);
        let (configuration, emode) = tokio::try_join!(
            async {
                configuration_call
                    .call()
                    .await
                    .map_err(|error| ReaderError::Contract(error.to_string()))
            },
            async {
                emode_call
                    .call()
                    .await
                    .map_err(|error| ReaderError::Contract(error.to_string()))
            }
        )?;

        Ok(UserMetaSnapshot {
            user,
            user_configuration: UserConfigurationBits(configuration),
            e_mode_category: u256_to_u8(emode)?,
        })
    }

    pub fn assets_for_configuration(
        &self,
        configuration: UserConfigurationBits,
    ) -> Result<Vec<Address>, ReaderError> {
        let mut targets: Vec<ReserveReadTarget> = self.targets.values().copied().collect();
        targets.sort_unstable_by_key(|target| target.reserve_id);
        let mut assets = Vec::new();
        for target in targets {
            if configuration.is_borrowing(target.reserve_id)?
                || configuration.is_using_as_collateral(target.reserve_id)?
            {
                assets.push(target.asset);
            }
        }
        Ok(assets)
    }

    pub async fn read_refresh_at(
        &self,
        request: &RefreshRequest,
        anchor: CanonicalBlock,
    ) -> Result<BlockPinnedSnapshot, ReaderError> {
        let meta = self.read_user_meta_at(request.user, anchor).await?;
        let block = BlockId::hash_canonical(anchor.hash);
        let mut reserves = Vec::with_capacity(request.assets.len());
        for asset in &request.assets {
            let target = self
                .targets
                .get(asset)
                .copied()
                .ok_or(ReaderError::UnknownReserve(*asset))?;
            let a_token = IScaledBalanceTokenView::new(target.a_token, &self.provider);
            let variable_debt =
                IScaledBalanceTokenView::new(target.variable_debt_token, &self.provider);
            let a_call = a_token.scaledBalanceOf(request.user).block(block);
            let debt_call = variable_debt.scaledBalanceOf(request.user).block(block);
            let (scaled_atoken_balance, scaled_variable_debt) = tokio::try_join!(
                async {
                    a_call
                        .call()
                        .await
                        .map_err(|error| ReaderError::Contract(error.to_string()))
                },
                async {
                    debt_call
                        .call()
                        .await
                        .map_err(|error| ReaderError::Contract(error.to_string()))
                }
            )?;
            reserves.push(ReservePositionSnapshot {
                asset: target.asset,
                reserve_id: target.reserve_id,
                scaled_atoken_balance,
                scaled_variable_debt,
            });
        }

        Ok(BlockPinnedSnapshot {
            anchor,
            snapshot: UserPositionSnapshot {
                user: request.user,
                user_configuration: meta.user_configuration,
                e_mode_category: meta.e_mode_category,
                reserves,
            },
        })
    }

    async fn anchor_at(&self, block_number: u64) -> Result<CanonicalBlock, ReaderError> {
        let block = self
            .provider
            .get_block(BlockId::number(block_number))
            .await
            .map_err(|error| ReaderError::Contract(error.to_string()))?
            .ok_or(ReaderError::BlockUnavailable(block_number))?;
        if block.number() != block_number {
            return Err(ReaderError::BlockNumberMismatch {
                requested: block_number,
                actual: block.number(),
            });
        }
        Ok(CanonicalBlock {
            number: block_number,
            hash: block.hash(),
            timestamp: block.header.inner.timestamp,
            base_fee_per_gas: block.header.inner.base_fee_per_gas,
        })
    }

    pub async fn refresh_and_apply(
        &self,
        request: &RefreshRequest,
        hot_state: &mut AaveHotState,
    ) -> Result<(), ReaderError> {
        self.read_refresh(request).await?.snapshot.apply(hot_state)?;
        Ok(())
    }
}

fn validate_target(target: ReserveReadTarget) -> Result<(), ReaderError> {
    if target.asset == Address::ZERO {
        return Err(ReaderError::ZeroAssetAddress);
    }
    if target.a_token == Address::ZERO {
        return Err(ReaderError::ZeroATokenAddress(target.asset));
    }
    if target.variable_debt_token == Address::ZERO {
        return Err(ReaderError::ZeroVariableDebtTokenAddress(target.asset));
    }
    if target.a_token == target.variable_debt_token {
        return Err(ReaderError::AliasedReserveTokens(target.asset));
    }
    Ok(())
}

fn u256_to_u8(value: U256) -> Result<u8, ReaderError> {
    if value > U256::from(u8::MAX) {
        return Err(ReaderError::InvalidEModeCategory(value));
    }
    Ok(value.as_limbs()[0] as u8)
}

#[derive(Debug, Error)]
pub enum ReaderError {
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Sync(#[from] nqc_aave_sync::SyncError),
    #[error("configured Aave pool address is zero")]
    ZeroPoolAddress,
    #[error("expected chain id {expected}, connected Reth reports {actual}")]
    ChainIdMismatch { expected: u64, actual: u64 },
    #[error("unknown Aave reserve {0}")]
    UnknownReserve(Address),
    #[error("reserve target for asset {asset} changed after registration")]
    ReserveTargetChanged { asset: Address },
    #[error("multiple assets attempted to use reserve id {0}")]
    ReserveIdCollision(u16),
    #[error("reserve asset address cannot be zero")]
    ZeroAssetAddress,
    #[error("aToken address cannot be zero for reserve {0}")]
    ZeroATokenAddress(Address),
    #[error("variable debt token address cannot be zero for reserve {0}")]
    ZeroVariableDebtTokenAddress(Address),
    #[error("aToken and variable debt token cannot alias for reserve {0}")]
    AliasedReserveTokens(Address),
    #[error("Aave contract read failed over local IPC: {0}")]
    Contract(String),
    #[error("canonical block {0} is unavailable from local Reth")]
    BlockUnavailable(u64),
    #[error("Reth returned block {actual} for requested block {requested}")]
    BlockNumberMismatch { requested: u64, actual: u64 },
    #[error("Aave returned invalid eMode category {0}")]
    InvalidEModeCategory(U256),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    #[test]
    fn reserve_target_rejects_zero_and_aliases() {
        let valid = ReserveReadTarget {
            asset: addr(1),
            reserve_id: 0,
            a_token: addr(2),
            variable_debt_token: addr(3),
        };
        assert!(validate_target(valid).is_ok());
        assert!(matches!(
            validate_target(ReserveReadTarget {
                a_token: addr(2),
                variable_debt_token: addr(2),
                ..valid
            }),
            Err(ReaderError::AliasedReserveTokens(_))
        ));
        assert!(matches!(
            validate_target(ReserveReadTarget {
                asset: Address::ZERO,
                ..valid
            }),
            Err(ReaderError::ZeroAssetAddress)
        ));
    }

    #[test]
    fn emode_conversion_is_range_checked() {
        assert_eq!(u256_to_u8(U256::from(255u16)).ok(), Some(255));
        assert!(matches!(
            u256_to_u8(U256::from(256u16)),
            Err(ReaderError::InvalidEModeCategory(_))
        ));
    }
}