use alloy::{
    eips::BlockId,
    primitives::{keccak256, Address, B256, U256},
    providers::{DynProvider, Provider},
    sol,
};
use nqc_core::BPS_DENOMINATOR;
use nqc_state::{CanonicalBlock, RethIpcSource, StateError};
use nqc_v2_router::{RouterError, V2GraphSnapshot, V2PoolSnapshot};
use std::collections::HashSet;
use thiserror::Error;

sol! {
    #[sol(rpc)]
    interface IV2FactoryView {
        function allPairsLength() external view returns (uint256);
        function allPairs(uint256 index) external view returns (address);
        function getPair(address tokenA, address tokenB) external view returns (address);
    }

    #[sol(rpc)]
    interface IV2PairView {
        function token0() external view returns (address);
        function token1() external view returns (address);
        function getReserves()
            external
            view
            returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    }
}

/// Explicit configuration is required because V2-compatible factories can use
/// different swap fees. No fee is inferred from bytecode or brand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2FactorySpec {
    pub factory: Address,
    pub fee_bps: u32,
    pub max_pairs: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2PairState {
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
    pub reserve0: U256,
    pub reserve1: U256,
    pub block_timestamp_last: u32,
}

impl V2PairState {
    #[must_use]
    pub fn has_live_liquidity(self) -> bool {
        self.reserve0 != U256::ZERO && self.reserve1 != U256::ZERO
    }

    pub fn as_routable(
        self,
        anchor: CanonicalBlock,
        fee_bps: u32,
    ) -> Result<Option<V2PoolSnapshot>, V2StateError> {
        if !self.has_live_liquidity() {
            return Ok(None);
        }
        Ok(Some(
            V2PoolSnapshot {
                anchor,
                pair: self.pair,
                token0: self.token0,
                token1: self.token1,
                reserve0: self.reserve0,
                reserve1: self.reserve1,
                fee_bps,
            }
            .validate()?,
        ))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2CanonicalSnapshot {
    pub chain_id: u64,
    pub anchor: CanonicalBlock,
    pub factory: Address,
    pub fee_bps: u32,
    pub pairs: Vec<V2PairState>,
}

impl V2CanonicalSnapshot {
    #[must_use]
    pub fn snapshot_hash(&self) -> B256 {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"NQC_V2_CANONICAL_STATE_REIMPLEMENTATION_V1");
        bytes.extend_from_slice(&self.chain_id.to_be_bytes());
        bytes.extend_from_slice(&self.anchor.number.to_be_bytes());
        bytes.extend_from_slice(self.anchor.hash.as_slice());
        bytes.extend_from_slice(&self.anchor.timestamp.to_be_bytes());
        match self.anchor.base_fee_per_gas {
            Some(value) => {
                bytes.push(1);
                bytes.extend_from_slice(&value.to_be_bytes());
            }
            None => {
                bytes.push(0);
                bytes.extend_from_slice(&0u64.to_be_bytes());
            }
        }
        bytes.extend_from_slice(self.factory.as_slice());
        bytes.extend_from_slice(&self.fee_bps.to_be_bytes());

        let mut pairs = self.pairs.clone();
        pairs.sort_unstable_by_key(|pair| pair.pair);
        bytes.extend_from_slice(&(pairs.len() as u64).to_be_bytes());
        for pair in pairs {
            bytes.extend_from_slice(pair.pair.as_slice());
            bytes.extend_from_slice(pair.token0.as_slice());
            bytes.extend_from_slice(pair.token1.as_slice());
            bytes.extend_from_slice(&pair.reserve0.to_be_bytes::<32>());
            bytes.extend_from_slice(&pair.reserve1.to_be_bytes::<32>());
            bytes.extend_from_slice(&pair.block_timestamp_last.to_be_bytes());
        }
        keccak256(bytes)
    }

    pub fn routable_graph(&self) -> Result<V2GraphSnapshot, V2StateError> {
        let pools = self
            .pairs
            .iter()
            .copied()
            .filter_map(|pair| pair.as_routable(self.anchor, self.fee_bps).transpose())
            .collect::<Result<Vec<_>, _>>()?;
        Ok(V2GraphSnapshot::new(self.anchor, pools)?)
    }
}

/// NEW T39 repair source. This is not recovered historical source.
#[derive(Clone)]
pub struct V2CanonicalReader {
    source: RethIpcSource,
    provider: DynProvider,
    chain_id: u64,
}

impl V2CanonicalReader {
    pub async fn from_reth(
        source: &RethIpcSource,
        expected_chain_id: u64,
    ) -> Result<Self, V2StateError> {
        let actual = source.chain_id().await?;
        if actual != expected_chain_id {
            return Err(V2StateError::ChainIdMismatch {
                expected: expected_chain_id,
                actual,
            });
        }
        Ok(Self {
            source: source.clone(),
            provider: source.provider(),
            chain_id: expected_chain_id,
        })
    }

    /// Reads an explicit fixture/route pair set from one exact canonical anchor.
    ///
    /// Every requested pair is re-bound to the configured factory through
    /// getPair(token0, token1). This is intentionally separate from full
    /// factory enumeration so historical route parity does not need to scan
    /// the entire production factory.
    pub async fn read_pairs_at(
        &self,
        spec: V2FactorySpec,
        pair_addresses: &[Address],
        anchor: CanonicalBlock,
    ) -> Result<V2CanonicalSnapshot, V2StateError> {
        validate_spec(spec)?;
        if pair_addresses.is_empty() {
            return Err(V2StateError::EmptyPairSelection);
        }
        if pair_addresses.len() as u64 > spec.max_pairs {
            return Err(V2StateError::SelectedPairLimitExceeded {
                observed: pair_addresses.len() as u64,
                maximum: spec.max_pairs,
            });
        }

        self.source.ensure_canonical(anchor).await?;
        let block = BlockId::hash_canonical(anchor.hash);
        let factory = IV2FactoryView::new(spec.factory, &self.provider);
        let mut seen = HashSet::with_capacity(pair_addresses.len());
        let mut pairs = Vec::with_capacity(pair_addresses.len());

        for pair in pair_addresses.iter().copied() {
            if pair == Address::ZERO {
                return Err(V2StateError::ZeroSelectedPair);
            }
            if !seen.insert(pair) {
                return Err(V2StateError::DuplicatePair(pair));
            }

            let contract = IV2PairView::new(pair, &self.provider);
            let token0 = contract
                .token0()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            let token1 = contract
                .token1()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if token0 == Address::ZERO || token1 == Address::ZERO || token0 == token1 {
                return Err(V2StateError::InvalidPairIdentity(pair));
            }

            let canonical_pair = factory
                .getPair(token0, token1)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if canonical_pair != pair {
                return Err(V2StateError::PairNotFactoryMember {
                    pair,
                    factory: spec.factory,
                    canonical_pair,
                });
            }

            let reserves = contract
                .getReserves()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            pairs.push(V2PairState {
                pair,
                token0,
                token1,
                reserve0: U256::from(reserves.reserve0.to::<u128>()),
                reserve1: U256::from(reserves.reserve1.to::<u128>()),
                block_timestamp_last: reserves.blockTimestampLast,
            });
        }

        pairs.sort_unstable_by_key(|pair| pair.pair);
        let observed = self.source.canonical_block_at(anchor.number).await?;
        if observed != anchor {
            return Err(V2StateError::CanonicalChanged {
                expected: anchor,
                observed,
            });
        }

        Ok(V2CanonicalSnapshot {
            chain_id: self.chain_id,
            anchor,
            factory: spec.factory,
            fee_bps: spec.fee_bps,
            pairs,
        })
    }

    /// Re-enumerates the factory and pair reserves from exact canonical state.
    /// No previous branch delta is inverted or carried forward.
    pub async fn read_factory_at(
        &self,
        spec: V2FactorySpec,
        anchor: CanonicalBlock,
    ) -> Result<V2CanonicalSnapshot, V2StateError> {
        validate_spec(spec)?;
        self.source.ensure_canonical(anchor).await?;
        let block = BlockId::hash_canonical(anchor.hash);
        let factory = IV2FactoryView::new(spec.factory, &self.provider);
        let count_raw = factory
            .allPairsLength()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        if count_raw > U256::from(spec.max_pairs) {
            return Err(V2StateError::PairLimitExceeded {
                observed: count_raw,
                maximum: spec.max_pairs,
            });
        }
        let count = count_raw.as_limbs()[0];

        let mut pairs = Vec::with_capacity(count as usize);
        let mut seen = HashSet::with_capacity(count as usize);
        for index in 0..count {
            let pair = factory
                .allPairs(U256::from(index))
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if pair == Address::ZERO {
                return Err(V2StateError::ZeroPair(index));
            }
            if !seen.insert(pair) {
                return Err(V2StateError::DuplicatePair(pair));
            }

            let contract = IV2PairView::new(pair, &self.provider);
            let token0 = contract
                .token0()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            let token1 = contract
                .token1()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if token0 == Address::ZERO || token1 == Address::ZERO || token0 == token1 {
                return Err(V2StateError::InvalidPairIdentity(pair));
            }
            let reserves = contract
                .getReserves()
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            pairs.push(V2PairState {
                pair,
                token0,
                token1,
                reserve0: U256::from(reserves.reserve0.to::<u128>()),
                reserve1: U256::from(reserves.reserve1.to::<u128>()),
                block_timestamp_last: reserves.blockTimestampLast,
            });
        }
        pairs.sort_unstable_by_key(|pair| pair.pair);

        let observed = self.source.canonical_block_at(anchor.number).await?;
        if observed != anchor {
            return Err(V2StateError::CanonicalChanged {
                expected: anchor,
                observed,
            });
        }

        Ok(V2CanonicalSnapshot {
            chain_id: self.chain_id,
            anchor,
            factory: spec.factory,
            fee_bps: spec.fee_bps,
            pairs,
        })
    }
}

/// Atomic replacement boundary used after a canonical refresh. A reorg never
/// patches an old snapshot in place.
pub fn commit_snapshot(
    current: &mut Option<V2CanonicalSnapshot>,
    rebuilt: V2CanonicalSnapshot,
    expected: CanonicalBlock,
    observed: CanonicalBlock,
) -> Result<(), V2StateError> {
    if rebuilt.anchor != expected || observed != expected {
        return Err(V2StateError::CanonicalChanged { expected, observed });
    }
    *current = Some(rebuilt);
    Ok(())
}

fn validate_spec(spec: V2FactorySpec) -> Result<(), V2StateError> {
    if spec.factory == Address::ZERO {
        return Err(V2StateError::ZeroFactory);
    }
    if spec.fee_bps >= BPS_DENOMINATOR as u32 {
        return Err(V2StateError::InvalidFeeBps(spec.fee_bps));
    }
    if spec.max_pairs == 0 {
        return Err(V2StateError::ZeroPairLimit);
    }
    Ok(())
}

fn contract_error(error: impl core::fmt::Display) -> V2StateError {
    V2StateError::Contract(error.to_string())
}

#[derive(Debug, Error)]
pub enum V2StateError {
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Router(#[from] RouterError),
    #[error("V2 factory address cannot be zero")]
    ZeroFactory,
    #[error("V2 pair limit cannot be zero")]
    ZeroPairLimit,
    #[error("invalid V2 fee {0} bps")]
    InvalidFeeBps(u32),
    #[error("expected chain id {expected}, connected source reports {actual}")]
    ChainIdMismatch { expected: u64, actual: u64 },
    #[error("explicit V2 pair selection cannot be empty")]
    EmptyPairSelection,
    #[error("explicit V2 pair selection contains zero address")]
    ZeroSelectedPair,
    #[error("selected pair count {observed} exceeds configured maximum {maximum}")]
    SelectedPairLimitExceeded { observed: u64, maximum: u64 },
    #[error("pair {pair} is not bound to factory {factory}; getPair returned {canonical_pair}")]
    PairNotFactoryMember {
        pair: Address,
        factory: Address,
        canonical_pair: Address,
    },
    #[error("factory returned zero pair at index {0}")]
    ZeroPair(u64),
    #[error("factory returned duplicate pair {0}")]
    DuplicatePair(Address),
    #[error("invalid token identity for pair {0}")]
    InvalidPairIdentity(Address),
    #[error("pair count {observed} exceeds configured maximum {maximum}")]
    PairLimitExceeded { observed: U256, maximum: u64 },
    #[error("V2 canonical anchor changed during refresh: expected {expected:?}, observed {observed:?}")]
    CanonicalChanged {
        expected: CanonicalBlock,
        observed: CanonicalBlock,
    },
    #[error("V2 contract read failed: {0}")]
    Contract(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(byte: u8) -> Address {
        Address::from([byte; 20])
    }

    fn anchor(hash: u8, number: u64) -> CanonicalBlock {
        CanonicalBlock {
            number,
            hash: B256::with_last_byte(hash),
            timestamp: 1_800_000_000 + number,
            base_fee_per_gas: Some(1_000_000_000),
        }
    }

    fn snapshot(anchor: CanonicalBlock, pairs: Vec<V2PairState>) -> V2CanonicalSnapshot {
        V2CanonicalSnapshot {
            chain_id: 1,
            anchor,
            factory: addr(90),
            fee_bps: 30,
            pairs,
        }
    }

    fn pair(id: u8, reserve0: u64, reserve1: u64) -> V2PairState {
        V2PairState {
            pair: addr(id),
            token0: addr(id.wrapping_add(20)),
            token1: addr(id.wrapping_add(40)),
            reserve0: U256::from(reserve0),
            reserve1: U256::from(reserve1),
            block_timestamp_last: 7,
        }
    }

    #[test]
    fn zero_liquidity_pair_remains_in_canonical_state_but_not_router() {
        let a = anchor(1, 100);
        let state = snapshot(a, vec![pair(1, 0, 10), pair(2, 100, 200)]);
        assert_eq!(state.pairs.len(), 2);
        let graph = state.routable_graph();
        assert!(graph.is_ok());
        assert_eq!(graph.ok().map(|g| g.pools().len()), Some(1));
    }

    #[test]
    fn liquidity_death_and_revival_change_snapshot_identity() {
        let a = anchor(1, 100);
        let dead = snapshot(a, vec![pair(1, 0, 0)]);
        let live = snapshot(a, vec![pair(1, 100, 200)]);
        assert_ne!(dead.snapshot_hash(), live.snapshot_hash());
        assert_eq!(dead.routable_graph().ok().map(|g| g.pools().len()), Some(0));
        assert_eq!(live.routable_graph().ok().map(|g| g.pools().len()), Some(1));
    }

    #[test]
    fn replacement_branch_atomically_drops_orphan_pairs() {
        let branch_a = anchor(1, 100);
        let branch_b = anchor(2, 100);
        let mut current = Some(snapshot(branch_a, vec![pair(1, 100, 200)]));
        let rebuilt = snapshot(branch_b, vec![pair(2, 300, 400)]);
        let result = commit_snapshot(&mut current, rebuilt, branch_b, branch_b);
        assert!(result.is_ok());
        let pairs = current.map(|s| s.pairs).unwrap_or_default();
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].pair, addr(2));
    }

    #[test]
    fn same_height_hash_drift_rejects_commit_and_preserves_old_snapshot() {
        let branch_a = anchor(1, 100);
        let branch_b = anchor(2, 100);
        let moved_again = anchor(3, 100);
        let old = snapshot(branch_a, vec![pair(1, 100, 200)]);
        let old_hash = old.snapshot_hash();
        let mut current = Some(old);
        let rebuilt = snapshot(branch_b, vec![pair(2, 300, 400)]);
        let result = commit_snapshot(&mut current, rebuilt, branch_b, moved_again);
        assert!(matches!(result, Err(V2StateError::CanonicalChanged { .. })));
        assert_eq!(current.as_ref().map(V2CanonicalSnapshot::snapshot_hash), Some(old_hash));
    }

    #[test]
    fn explicit_fee_is_part_of_snapshot_and_quote_semantics() {
        let a = anchor(1, 100);
        let mut state = snapshot(a, vec![pair(1, 1_000_000, 2_000_000)]);
        let quote_30 = state
            .routable_graph()
            .and_then(|g| g.pools()[0].quote_exact_in(state.pairs[0].token0, U256::from(10_000u64)).map_err(V2StateError::from));
        assert!(quote_30.is_ok());
        state.fee_bps = 25;
        let quote_25 = state
            .routable_graph()
            .and_then(|g| g.pools()[0].quote_exact_in(state.pairs[0].token0, U256::from(10_000u64)).map_err(V2StateError::from));
        assert!(quote_25.is_ok());
        assert_ne!(quote_30.ok(), quote_25.ok());
    }
}
