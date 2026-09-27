use alloy::{
    primitives::{keccak256, Address, B256, Bytes, U256},
    sol,
    sol_types::{SolCall, SolValue},
};
use nqc_aave_opportunity::LiquidationOpportunity;
use nqc_state::CanonicalBlock;
use thiserror::Error;

pub const MAX_V2_HOPS: usize = 4;

sol! {
    struct V2HopAbi {
        address pair;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
    }

    struct ExecutionPlanAbi {
        uint256 chainId;
        uint256 validThroughBlock;
        address borrower;
        address collateralAsset;
        address debtAsset;
        uint256 debtToCover;
        uint256 minProfitDebtAsset;
        V2HopAbi[] hops;
    }

    interface INqcAaveV3Executor {
        function execute(ExecutionPlanAbi plan) external returns (uint256 realizedProfitDebtAsset);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2HopPlan {
    pub pair: Address,
    pub token_in: Address,
    pub token_out: Address,
    pub amount_in: U256,
    pub amount_out: U256,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtomicLiquidationPlan {
    pub anchor: CanonicalBlock,
    pub chain_id: u64,
    pub valid_through_block: u64,
    pub borrower: Address,
    pub collateral_asset: Address,
    pub debt_asset: Address,
    pub debt_to_cover: U256,
    pub min_profit_debt_asset: U256,
    pub hops: Vec<V2HopPlan>,
}

impl AtomicLiquidationPlan {
    pub fn from_opportunity(
        opportunity: LiquidationOpportunity,
        chain_id: u64,
        min_profit_debt_asset: U256,
        hops: Vec<V2HopPlan>,
    ) -> Result<Self, ExecutorPlanError> {
        let valid_through_block = opportunity
            .anchor
            .number
            .checked_add(1)
            .ok_or(ExecutorPlanError::BlockOverflow)?;
        let plan = Self {
            anchor: opportunity.anchor,
            chain_id,
            valid_through_block,
            borrower: opportunity.borrower,
            collateral_asset: opportunity.collateral_asset,
            debt_asset: opportunity.debt_asset,
            debt_to_cover: opportunity.debt_to_liquidate,
            min_profit_debt_asset,
            hops,
        };
        plan.validate()?;
        Ok(plan)
    }

    pub fn validate(&self) -> Result<(), ExecutorPlanError> {
        if self.chain_id == 0 {
            return Err(ExecutorPlanError::ZeroChainId);
        }
        if self.valid_through_block < self.anchor.number {
            return Err(ExecutorPlanError::ExpiredAtConstruction);
        }
        if self.borrower == Address::ZERO
            || self.collateral_asset == Address::ZERO
            || self.debt_asset == Address::ZERO
        {
            return Err(ExecutorPlanError::ZeroAddress);
        }
        if self.collateral_asset == self.debt_asset {
            return Err(ExecutorPlanError::IdenticalCollateralAndDebt);
        }
        if self.debt_to_cover == U256::ZERO {
            return Err(ExecutorPlanError::ZeroDebtToCover);
        }
        if self.hops.is_empty() {
            return Err(ExecutorPlanError::EmptyRoute);
        }
        if self.hops.len() > MAX_V2_HOPS {
            return Err(ExecutorPlanError::RouteTooLong(self.hops.len()));
        }
        if self.hops[0].token_in != self.collateral_asset {
            return Err(ExecutorPlanError::RouteDoesNotStartWithCollateral);
        }
        if self.hops[self.hops.len() - 1].token_out != self.debt_asset {
            return Err(ExecutorPlanError::RouteDoesNotEndWithDebt);
        }
        for (index, hop) in self.hops.iter().enumerate() {
            if hop.pair == Address::ZERO || hop.token_in == Address::ZERO || hop.token_out == Address::ZERO {
                return Err(ExecutorPlanError::ZeroRouteAddress(index));
            }
            if hop.token_in == hop.token_out {
                return Err(ExecutorPlanError::IdenticalHopTokens(index));
            }
            if hop.amount_in == U256::ZERO || hop.amount_out == U256::ZERO {
                return Err(ExecutorPlanError::ZeroHopAmount(index));
            }
            if index != 0 {
                let previous = self.hops[index - 1];
                if previous.token_out != hop.token_in || previous.amount_out != hop.amount_in {
                    return Err(ExecutorPlanError::DiscontinuousRoute(index));
                }
            }
        }
        Ok(())
    }


    pub fn plan_hash(&self) -> Result<B256, ExecutorPlanError> {
        self.validate()?;
        Ok(keccak256(self.to_abi().abi_encode()))
    }

    pub fn decode_realized_profit(output: &[u8]) -> Result<U256, ExecutorPlanError> {
        let decoded = INqcAaveV3Executor::executeCall::abi_decode_returns_validate(output)
            .map_err(|error| ExecutorPlanError::AbiDecode(error.to_string()))?;
        Ok(decoded.realizedProfitDebtAsset)
    }

    pub fn encode_execute_calldata(&self) -> Result<Bytes, ExecutorPlanError> {
        self.validate()?;
        let call = INqcAaveV3Executor::executeCall {
            plan: self.to_abi(),
        };
        Ok(Bytes::from(call.abi_encode()))
    }

    #[must_use]
    pub fn to_abi(&self) -> ExecutionPlanAbi {
        ExecutionPlanAbi {
            chainId: U256::from(self.chain_id),
            validThroughBlock: U256::from(self.valid_through_block),
            borrower: self.borrower,
            collateralAsset: self.collateral_asset,
            debtAsset: self.debt_asset,
            debtToCover: self.debt_to_cover,
            minProfitDebtAsset: self.min_profit_debt_asset,
            hops: self
                .hops
                .iter()
                .map(|hop| V2HopAbi {
                    pair: hop.pair,
                    tokenIn: hop.token_in,
                    tokenOut: hop.token_out,
                    amountIn: hop.amount_in,
                    amountOut: hop.amount_out,
                })
                .collect(),
        }
    }
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ExecutorPlanError {
    #[error("chain id cannot be zero")]
    ZeroChainId,
    #[error("block number overflow while constructing validity window")]
    BlockOverflow,
    #[error("execution plan is already expired at construction")]
    ExpiredAtConstruction,
    #[error("execution plan contains a zero address")]
    ZeroAddress,
    #[error("collateral and debt assets must differ")]
    IdenticalCollateralAndDebt,
    #[error("debt to cover cannot be zero")]
    ZeroDebtToCover,
    #[error("route cannot be empty")]
    EmptyRoute,
    #[error("route length {0} exceeds maximum")]
    RouteTooLong(usize),
    #[error("route does not start with the liquidation collateral")]
    RouteDoesNotStartWithCollateral,
    #[error("route does not end in the flash-loan debt asset")]
    RouteDoesNotEndWithDebt,
    #[error("route hop {0} contains a zero address")]
    ZeroRouteAddress(usize),
    #[error("route hop {0} has identical input and output tokens")]
    IdenticalHopTokens(usize),
    #[error("route hop {0} contains a zero amount")]
    ZeroHopAmount(usize),
    #[error("route hop {0} is not continuous with the previous hop")]
    DiscontinuousRoute(usize),
    #[error("failed to decode executor return data: {0}")]
    AbiDecode(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::B256;

    fn plan() -> AtomicLiquidationPlan {
        AtomicLiquidationPlan {
            anchor: CanonicalBlock {
                number: 100,
                hash: B256::with_last_byte(1),
                timestamp: 1_700_000_000,
                base_fee_per_gas: Some(20_000_000_000),
            },
            chain_id: 1,
            valid_through_block: 101,
            borrower: Address::repeat_byte(1),
            collateral_asset: Address::repeat_byte(2),
            debt_asset: Address::repeat_byte(3),
            debt_to_cover: U256::from(1_000u64),
            min_profit_debt_asset: U256::from(10u64),
            hops: vec![V2HopPlan {
                pair: Address::repeat_byte(4),
                token_in: Address::repeat_byte(2),
                token_out: Address::repeat_byte(3),
                amount_in: U256::from(900u64),
                amount_out: U256::from(1_020u64),
            }],
        }
    }

    #[test]
    fn plan_is_strictly_linear() {
        let mut broken = plan();
        broken.hops.push(V2HopPlan {
            pair: Address::repeat_byte(5),
            token_in: Address::repeat_byte(8),
            token_out: Address::repeat_byte(3),
            amount_in: U256::from(1_020u64),
            amount_out: U256::from(1_030u64),
        });
        assert!(matches!(broken.validate(), Err(ExecutorPlanError::DiscontinuousRoute(1))));
    }

    #[test]
    fn calldata_encoding_is_deterministic() -> Result<(), ExecutorPlanError> {
        let first = plan().encode_execute_calldata()?;
        let second = plan().encode_execute_calldata()?;
        assert_eq!(first, second);
        assert!(first.len() > 4);
        assert_eq!(plan().plan_hash()?, plan().plan_hash()?);
        Ok(())
    }
}