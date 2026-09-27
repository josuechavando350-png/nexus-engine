use alloy::primitives::{Address, B256};
use nqc_aave_events::{AaveEventDecoder, DecodeError};
use nqc_aave_market::{AaveMarketBootstrap, MarketError};
use nqc_aave_reader::{AaveLocalReader, ReaderError};
use nqc_aave_sync::{RefreshRequest, SyncError};
use nqc_hot_state::{AaveHotState, HotStateError};
use nqc_state::{CanonicalBlock, RethIpcSource, StateError};
use std::collections::BTreeSet;
use thiserror::Error;

/// NEW T39 repair source. This is not recovered historical source.
///
/// The reconciler deliberately rebuilds a fresh hot state from block-hash-pinned
/// canonical reads. It never attempts to reverse orphaned branch arithmetic.
#[derive(Clone)]
pub struct AaveCanonicalReconciler {
    source: RethIpcSource,
    pool: Address,
    chain_id: u64,
    tracked_users: BTreeSet<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileReport {
    pub anchor: CanonicalBlock,
    pub tracked_users: usize,
    pub market_reserves: usize,
    pub market_snapshot_hash: B256,
    pub account_snapshot_hashes: Vec<(Address, Option<B256>)>,
}

impl AaveCanonicalReconciler {
    pub async fn from_reth(
        source: &RethIpcSource,
        pool: Address,
        expected_chain_id: u64,
    ) -> Result<Self, ReconcileError> {
        if pool == Address::ZERO {
            return Err(ReconcileError::ZeroPoolAddress);
        }
        let actual_chain_id = source.chain_id().await?;
        if actual_chain_id != expected_chain_id {
            return Err(ReconcileError::ChainIdMismatch {
                expected: expected_chain_id,
                actual: actual_chain_id,
            });
        }
        Ok(Self {
            source: source.clone(),
            pool,
            chain_id: expected_chain_id,
            tracked_users: BTreeSet::new(),
        })
    }

    pub fn track_user(&mut self, user: Address) -> Result<bool, ReconcileError> {
        if user == Address::ZERO {
            return Err(ReconcileError::ZeroUserAddress);
        }
        Ok(self.tracked_users.insert(user))
    }

    pub fn untrack_user(&mut self, user: Address) -> bool {
        self.tracked_users.remove(&user)
    }

    #[must_use]
    pub fn tracked_users(&self) -> usize {
        self.tracked_users.len()
    }

    /// Rebuilds all tracked Aave state from canonical truth at one exact anchor.
    ///
    /// Commit is atomic: the caller's current state is replaced only after the
    /// complete rebuild succeeds and the exact canonical snapshot is re-read.
    pub async fn reconcile_at(
        &self,
        current: &mut AaveHotState,
        anchor: CanonicalBlock,
    ) -> Result<ReconcileReport, ReconcileError> {
        self.source.ensure_canonical(anchor).await?;

        let bootstrap =
            AaveMarketBootstrap::from_reth(&self.source, self.pool, self.chain_id).await?;
        let market = bootstrap.bootstrap_at(anchor).await?;
        if market.anchor != anchor {
            return Err(ReconcileError::CanonicalChanged {
                expected: anchor,
                observed: market.anchor,
            });
        }

        let mut next = AaveHotState::new();
        let mut reader =
            AaveLocalReader::from_reth(&self.source, self.pool, self.chain_id).await?;
        let mut decoder = AaveEventDecoder::new(self.pool)?;
        market.apply(&mut next, &mut reader, &mut decoder)?;

        for user in &self.tracked_users {
            let meta = reader.read_user_meta_at(*user, anchor).await?;
            let assets = reader.assets_for_configuration(meta.user_configuration)?;
            let request = RefreshRequest {
                user: *user,
                assets,
                refresh_user_configuration: true,
                refresh_emode: true,
            };
            let canonical = reader.read_refresh_at(&request, anchor).await?;
            if canonical.anchor != anchor {
                return Err(ReconcileError::CanonicalChanged {
                    expected: anchor,
                    observed: canonical.anchor,
                });
            }
            canonical.snapshot.apply(&mut next)?;
        }

        let observed = self.source.canonical_block_at(anchor.number).await?;
        commit_rebuild(current, next, anchor, observed)?;

        let mut account_snapshot_hashes = Vec::with_capacity(self.tracked_users.len());
        for user in &self.tracked_users {
            let digest = current
                .account_snapshot_at(*user, anchor.timestamp)?
                .map(|snapshot| snapshot.snapshot_hash());
            account_snapshot_hashes.push((*user, digest));
        }

        Ok(ReconcileReport {
            anchor,
            tracked_users: self.tracked_users.len(),
            market_reserves: market.reserves.len(),
            market_snapshot_hash: market.snapshot_hash(),
            account_snapshot_hashes,
        })
    }
}

/// The only mutation boundary: install the rebuilt state iff the canonical
/// anchor remained byte-for-byte identical through the refresh.
pub fn commit_rebuild(
    current: &mut AaveHotState,
    rebuilt: AaveHotState,
    expected: CanonicalBlock,
    observed: CanonicalBlock,
) -> Result<(), ReconcileError> {
    if observed != expected {
        return Err(ReconcileError::CanonicalChanged { expected, observed });
    }
    *current = rebuilt;
    Ok(())
}

#[derive(Debug, Error)]
pub enum ReconcileError {
    #[error("Aave pool address cannot be zero")]
    ZeroPoolAddress,
    #[error("tracked Aave user address cannot be zero")]
    ZeroUserAddress,
    #[error("expected chain id {expected}, connected source reports {actual}")]
    ChainIdMismatch { expected: u64, actual: u64 },
    #[error("canonical anchor changed during rebuild: expected {expected:?}, observed {observed:?}")]
    CanonicalChanged {
        expected: CanonicalBlock,
        observed: CanonicalBlock,
    },
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Market(#[from] MarketError),
    #[error(transparent)]
    Reader(#[from] ReaderError),
    #[error(transparent)]
    Decode(#[from] DecodeError),
    #[error(transparent)]
    Sync(#[from] SyncError),
    #[error(transparent)]
    HotState(#[from] HotStateError),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::U256;
    use nqc_core::{ray, wad};
    use nqc_hot_state::{AccountReservePosition, ReserveConfig, ReserveRuntime};
    use nqc_replay::{ReplayContext, ReplayError, StrategyKind};

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn anchor(hash_byte: u8, number: u64) -> CanonicalBlock {
        CanonicalBlock {
            number,
            hash: B256::with_last_byte(hash_byte),
            timestamp: 1_800_000_000 + number,
            base_fee_per_gas: Some(1_000_000_000),
        }
    }

    fn configure(state: &mut AaveHotState, asset: Address, reserve_id: u16) {
        let result = state.configure_reserve(
            asset,
            ReserveConfig {
                reserve_id,
                token_unit: wad(),
                liquidation_threshold_bps: 8_000,
            },
            ReserveRuntime {
                price_usd_wad: wad(),
                liquidity_index_ray: ray(),
                variable_borrow_index_ray: ray(),
                liquidity_rate_ray: U256::ZERO,
                variable_borrow_rate_ray: U256::ZERO,
                last_update_timestamp: 0,
            },
        );
        assert!(result.is_ok());
    }

    fn set_position(
        state: &mut AaveHotState,
        user: Address,
        asset: Address,
        collateral: u64,
        debt: u64,
    ) {
        let result = state.set_position(
            user,
            asset,
            AccountReservePosition {
                scaled_atoken_balance: U256::from(collateral) * wad(),
                scaled_variable_debt: U256::from(debt) * wad(),
                collateral_enabled: collateral != 0,
            },
        );
        assert!(result.is_ok());
    }

    #[test]
    fn canonical_rebuild_removes_orphan_branch_positions() {
        let user = addr(10);
        let orphan_asset = addr(1);
        let canonical_asset = addr(2);

        let mut current = AaveHotState::new();
        configure(&mut current, orphan_asset, 0);
        set_position(&mut current, user, orphan_asset, 10, 4);

        let mut rebuilt = AaveHotState::new();
        configure(&mut rebuilt, canonical_asset, 1);
        set_position(&mut rebuilt, user, canonical_asset, 20, 5);

        let canonical = anchor(2, 100);
        let committed = commit_rebuild(&mut current, rebuilt, canonical, canonical);
        assert!(committed.is_ok());

        let snapshot = current.account_snapshot_at(user, canonical.timestamp);
        assert!(snapshot.is_ok());
        let snapshot = snapshot.ok().flatten();
        assert!(snapshot.is_some());
        let reserves = snapshot.map(|value| value.reserves).unwrap_or_default();
        assert_eq!(reserves.len(), 1);
        assert_eq!(reserves[0].asset, canonical_asset);
        assert_eq!(reserves[0].reserve_id, 1);
    }

    #[test]
    fn same_height_hash_change_fails_closed_and_preserves_current_state() {
        let user = addr(10);
        let asset = addr(1);

        let mut current = AaveHotState::new();
        configure(&mut current, asset, 0);
        set_position(&mut current, user, asset, 10, 4);

        let rebuilt = AaveHotState::new();
        let branch_b = anchor(2, 100);
        let moved_again = anchor(3, 100);
        let result = commit_rebuild(&mut current, rebuilt, branch_b, moved_again);
        assert!(matches!(result, Err(ReconcileError::CanonicalChanged { .. })));

        let snapshot = current.account_snapshot_at(user, branch_b.timestamp);
        assert!(snapshot.is_ok());
        assert!(snapshot.ok().flatten().is_some());
    }

    #[test]
    fn full_snapshot_identity_change_is_rejected_not_only_hash_change() {
        let mut current = AaveHotState::new();
        let expected = anchor(2, 100);
        let mut observed = expected;
        observed.timestamp += 1;
        let result = commit_rebuild(&mut current, AaveHotState::new(), expected, observed);
        assert!(matches!(result, Err(ReconcileError::CanonicalChanged { .. })));
    }

    #[test]
    fn old_replay_capsule_rejects_replacement_branch() {
        let branch_a = anchor(1, 100);
        let branch_b = anchor(2, 100);
        let context = ReplayContext {
            chain_id: 1,
            anchor: branch_a,
            target_block: 101,
            strategy: StrategyKind::AaveLiquidation,
            subject: addr(10),
            market_snapshot_hash: B256::with_last_byte(10),
            state_snapshot_hash: B256::with_last_byte(11),
            execution_plan_hash: B256::with_last_byte(12),
            transaction_intent_hash: B256::with_last_byte(13),
            simulation_environment_hash: B256::with_last_byte(14),
            simulation_result_hash: B256::with_last_byte(15),
            settlement_result_hash: B256::with_last_byte(16),
            edge_assessment_hash: B256::with_last_byte(17),
            fee_envelope_hash: B256::with_last_byte(18),
            risk_policy_hash: B256::with_last_byte(19),
        };
        assert!(matches!(
            context.seal().require_anchor(branch_b),
            Err(ReplayError::AnchorMismatch { .. })
        ));
    }
}
