use alloy::{
    eips::BlockId,
    primitives::{Address, B256, Bytes, U256},
};
use nqc_executor::{AtomicLiquidationPlan, ExecutorPlanError};
use nqc_state::{CanonicalBlock, RethIpcSource, StateError};
use revm::{
    context::TxEnv,
    database::{AlloyDB, AsyncDb, CacheDB},
    primitives::{hardfork::SpecId, TxKind},
    Context, ExecuteEvm, MainBuilder, MainContext,
};
use thiserror::Error;

/// Complete EVM environment assumptions for the target block. Nothing is silently
/// borrowed from `latest`: the database is pinned to `anchor.hash`, while these
/// fields define the exact block in which the candidate is evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SimulationBlockContext {
    pub anchor: CanonicalBlock,
    pub target_number: u64,
    pub target_timestamp: u64,
    pub beneficiary: Address,
    pub gas_limit: u64,
    pub base_fee_per_gas: u64,
    pub difficulty: U256,
    pub prevrandao: Option<B256>,
    pub blob_excess_gas: Option<u64>,
    pub spec_id: SpecId,
}

impl SimulationBlockContext {
    pub fn validate(self) -> Result<Self, SimulationError> {
        let expected = self
            .anchor
            .number
            .checked_add(1)
            .ok_or(SimulationError::BlockOverflow)?;
        if self.target_number != expected {
            return Err(SimulationError::NonAdjacentTargetBlock {
                anchor: self.anchor.number,
                target: self.target_number,
            });
        }
        if self.target_timestamp <= self.anchor.timestamp {
            return Err(SimulationError::NonIncreasingTimestamp {
                anchor_timestamp: self.anchor.timestamp,
                target_timestamp: self.target_timestamp,
            });
        }
        if self.gas_limit == 0 {
            return Err(SimulationError::ZeroBlockGasLimit);
        }
        Ok(self)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SimulationTx {
    pub chain_id: u64,
    pub caller: Address,
    pub executor: Address,
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub calldata: Bytes,
}

impl SimulationTx {
    pub fn validate(&self, block: SimulationBlockContext) -> Result<(), SimulationError> {
        if self.chain_id == 0 {
            return Err(SimulationError::ZeroChainId);
        }
        if self.caller == Address::ZERO || self.executor == Address::ZERO {
            return Err(SimulationError::ZeroAddress);
        }
        if self.gas_limit == 0 || self.gas_limit > block.gas_limit {
            return Err(SimulationError::InvalidTransactionGasLimit {
                transaction: self.gas_limit,
                block: block.gas_limit,
            });
        }
        if self.max_priority_fee_per_gas > self.max_fee_per_gas {
            return Err(SimulationError::PriorityFeeAboveMaxFee);
        }
        if self.max_fee_per_gas < u128::from(block.base_fee_per_gas) {
            return Err(SimulationError::MaxFeeBelowBaseFee {
                max_fee_per_gas: self.max_fee_per_gas,
                base_fee_per_gas: block.base_fee_per_gas,
            });
        }
        if self.calldata.is_empty() {
            return Err(SimulationError::EmptyCalldata);
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct SimulationReceipt {
    anchor: CanonicalBlock,
    target_number: u64,
    success: bool,
    gas_used: u64,
    output: Bytes,
    realized_profit_debt_asset: Option<U256>,
}

impl SimulationReceipt {
    #[must_use]
    pub const fn anchor(&self) -> CanonicalBlock { self.anchor }
    #[must_use]
    pub const fn target_number(&self) -> u64 { self.target_number }
    #[must_use]
    pub const fn success(&self) -> bool { self.success }
    #[must_use]
    pub const fn gas_used(&self) -> u64 { self.gas_used }
    #[must_use]
    pub fn output(&self) -> &Bytes { &self.output }
    #[must_use]
    pub const fn realized_profit_debt_asset(&self) -> Option<U256> { self.realized_profit_debt_asset }
    #[must_use]
    pub const fn economic_success(&self) -> bool {
        self.success && self.realized_profit_debt_asset.is_some()
    }
}

#[derive(Clone)]
pub struct LocalEvmSimulator {
    source: RethIpcSource,
}

impl LocalEvmSimulator {
    #[must_use]
    pub const fn new(source: RethIpcSource) -> Self {
        Self { source }
    }

    pub async fn simulate_atomic_liquidation(
        &self,
        plan: &AtomicLiquidationPlan,
        block: SimulationBlockContext,
        tx: &SimulationTx,
    ) -> Result<SimulationReceipt, SimulationError> {
        plan.validate()?;
        let block = block.validate()?;
        tx.validate(block)?;

        if plan.anchor != block.anchor {
            return Err(SimulationError::PlanAnchorMismatch {
                plan: plan.anchor,
                simulation: block.anchor,
            });
        }
        if plan.chain_id != tx.chain_id {
            return Err(SimulationError::ChainIdMismatch {
                plan: plan.chain_id,
                transaction: tx.chain_id,
            });
        }
        if plan.valid_through_block < block.target_number {
            return Err(SimulationError::PlanExpiredForTarget {
                valid_through: plan.valid_through_block,
                target: block.target_number,
            });
        }
        let encoded = plan.encode_execute_calldata()?;
        if encoded != tx.calldata {
            return Err(SimulationError::CalldataMismatch);
        }

        // Guard both sides of the simulation. A reorg that occurs while REVM is reading
        // state invalidates the result even if the EVM execution itself succeeded.
        self.source.ensure_canonical(block.anchor).await?;

        let provider = self.source.provider();
        let block_id = BlockId::hash_canonical(block.anchor.hash);
        let remote = AlloyDB::new(provider, block_id);
        let async_db = AsyncDb::new(remote);
        let cache_db = CacheDB::new(async_db);

        let ctx = Context::mainnet()
            .with_db(cache_db)
            .modify_block_chained(|env| {
                env.number = U256::from(block.target_number);
                env.beneficiary = block.beneficiary;
                env.timestamp = U256::from(block.target_timestamp);
                env.difficulty = block.difficulty;
                env.gas_limit = block.gas_limit;
                env.basefee = block.base_fee_per_gas;
                env.prevrandao = block.prevrandao;
                if let Some(excess) = block.blob_excess_gas {
                    env.set_blob_excess_gas_and_price(excess);
                }
            })
            .modify_cfg_chained(|cfg| {
                cfg.chain_id = tx.chain_id;
                cfg.set_spec_and_mainnet_gas_params(block.spec_id);
            });
        let mut evm = ctx.build_mainnet();

        let tx_env = TxEnv::builder()
            .caller(tx.caller)
            .gas_limit(tx.gas_limit)
            .gas_price(tx.max_fee_per_gas)
            .gas_priority_fee(Some(tx.max_priority_fee_per_gas))
            .value(U256::ZERO)
            .data(tx.calldata.clone())
            .chain_id(Some(tx.chain_id))
            .nonce(tx.nonce)
            .kind(TxKind::Call(tx.executor))
            .build()
            .map_err(|error| SimulationError::InvalidTxEnv(error.to_string()))?;

        let result = evm
            .transact_one(tx_env)
            .map_err(|error| SimulationError::Evm(error.to_string()))?;
        let success = result.is_success();
        let gas_used = result.tx_gas_used();
        let output = result.output().cloned().unwrap_or_default();
        let realized_profit_debt_asset = if success {
            Some(AtomicLiquidationPlan::decode_realized_profit(&output)?)
        } else {
            None
        };

        self.source.ensure_canonical(block.anchor).await?;

        Ok(SimulationReceipt {
            anchor: block.anchor,
            target_number: block.target_number,
            success,
            gas_used,
            output,
            realized_profit_debt_asset,
        })
    }
}

#[derive(Debug, Error)]
pub enum SimulationError {
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Executor(#[from] ExecutorPlanError),
    #[error("block number overflow while deriving simulation target")]
    BlockOverflow,
    #[error("simulation target {target} is not immediately after anchor {anchor}")]
    NonAdjacentTargetBlock { anchor: u64, target: u64 },
    #[error("target timestamp {target_timestamp} must be greater than anchor timestamp {anchor_timestamp}")]
    NonIncreasingTimestamp {
        anchor_timestamp: u64,
        target_timestamp: u64,
    },
    #[error("simulation block gas limit cannot be zero")]
    ZeroBlockGasLimit,
    #[error("chain id cannot be zero")]
    ZeroChainId,
    #[error("simulation caller and executor must be non-zero")]
    ZeroAddress,
    #[error("transaction gas limit {transaction} is invalid for block gas limit {block}")]
    InvalidTransactionGasLimit { transaction: u64, block: u64 },
    #[error("priority fee exceeds max fee")]
    PriorityFeeAboveMaxFee,
    #[error("max fee {max_fee_per_gas} is below block base fee {base_fee_per_gas}")]
    MaxFeeBelowBaseFee {
        max_fee_per_gas: u128,
        base_fee_per_gas: u64,
    },
    #[error("simulation calldata cannot be empty")]
    EmptyCalldata,
    #[error("execution plan anchor differs from simulation anchor: plan {plan:?}, simulation {simulation:?}")]
    PlanAnchorMismatch {
        plan: CanonicalBlock,
        simulation: CanonicalBlock,
    },
    #[error("execution plan chain id {plan} differs from transaction chain id {transaction}")]
    ChainIdMismatch { plan: u64, transaction: u64 },
    #[error("execution plan expires at {valid_through}, before target block {target}")]
    PlanExpiredForTarget { valid_through: u64, target: u64 },
    #[error("transaction calldata is not the exact encoding of the authorized plan")]
    CalldataMismatch,
    #[error("invalid REVM transaction environment: {0}")]
    InvalidTxEnv(String),
    #[error("REVM execution failed: {0}")]
    Evm(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anchor() -> CanonicalBlock {
        CanonicalBlock {
            number: 100,
            hash: B256::repeat_byte(0x11),
            timestamp: 1_700_000_000,
            base_fee_per_gas: Some(20_000_000_000),
        }
    }

    fn block() -> SimulationBlockContext {
        SimulationBlockContext {
            anchor: anchor(),
            target_number: 101,
            target_timestamp: 1_700_000_012,
            beneficiary: Address::repeat_byte(0x22),
            gas_limit: 30_000_000,
            base_fee_per_gas: 21_000_000_000,
            difficulty: U256::ZERO,
            prevrandao: Some(B256::repeat_byte(0x33)),
            blob_excess_gas: Some(0),
            spec_id: SpecId::PRAGUE,
        }
    }

    #[test]
    fn target_must_be_adjacent_to_anchor() {
        let mut context = block();
        context.target_number = 102;
        assert!(matches!(
            context.validate(),
            Err(SimulationError::NonAdjacentTargetBlock { .. })
        ));
    }

    #[test]
    fn fee_envelope_is_checked_before_revm() {
        let transaction = SimulationTx {
            chain_id: 1,
            caller: Address::repeat_byte(1),
            executor: Address::repeat_byte(2),
            nonce: 0,
            gas_limit: 1_000_000,
            max_fee_per_gas: 20_000_000_000,
            max_priority_fee_per_gas: 1_000_000_000,
            calldata: Bytes::from_static(&[1, 2, 3, 4]),
        };
        assert!(matches!(
            transaction.validate(block()),
            Err(SimulationError::MaxFeeBelowBaseFee { .. })
        ));
    }
}