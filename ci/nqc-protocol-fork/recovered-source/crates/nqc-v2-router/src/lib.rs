use alloy::primitives::{Address, U256};
use nqc_aave_opportunity::LiquidationOpportunity;
use nqc_core::{checked_add, checked_mul, checked_sub, BPS_DENOMINATOR, MathError};
use nqc_executor::V2HopPlan;
use nqc_state::CanonicalBlock;
use std::collections::{HashMap, HashSet};
use thiserror::Error;

pub const MAX_SEARCH_HOPS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2PoolSnapshot {
    pub anchor: CanonicalBlock,
    pub pair: Address,
    pub token0: Address,
    pub token1: Address,
    pub reserve0: U256,
    pub reserve1: U256,
    pub fee_bps: u32,
}

impl V2PoolSnapshot {
    pub fn validate(self) -> Result<Self, RouterError> {
        if self.pair == Address::ZERO || self.token0 == Address::ZERO || self.token1 == Address::ZERO {
            return Err(RouterError::ZeroAddress);
        }
        if self.token0 == self.token1 {
            return Err(RouterError::IdenticalPoolTokens(self.pair));
        }
        if self.reserve0 == U256::ZERO || self.reserve1 == U256::ZERO {
            return Err(RouterError::EmptyLiquidity(self.pair));
        }
        if self.fee_bps >= BPS_DENOMINATOR as u32 {
            return Err(RouterError::InvalidFeeBps(self.fee_bps));
        }
        Ok(self)
    }

    #[must_use]
    pub fn contains(self, token: Address) -> bool {
        token == self.token0 || token == self.token1
    }

    pub fn quote_exact_in(self, token_in: Address, amount_in: U256) -> Result<(Address, U256), RouterError> {
        self.validate()?;
        self.quote_exact_in_validated(token_in, amount_in)
    }

    fn quote_exact_in_validated(
        self,
        token_in: Address,
        amount_in: U256,
    ) -> Result<(Address, U256), RouterError> {
        if amount_in == U256::ZERO {
            return Err(RouterError::ZeroAmountIn);
        }
        let (token_out, reserve_in, reserve_out) = if token_in == self.token0 {
            (self.token1, self.reserve0, self.reserve1)
        } else if token_in == self.token1 {
            (self.token0, self.reserve1, self.reserve0)
        } else {
            return Err(RouterError::TokenNotInPool {
                token: token_in,
                pair: self.pair,
            });
        };

        let fee_multiplier = U256::from(BPS_DENOMINATOR - u64::from(self.fee_bps));
        let amount_in_with_fee = checked_mul(amount_in, fee_multiplier)?;
        let numerator = checked_mul(amount_in_with_fee, reserve_out)?;
        let denominator = checked_add(
            checked_mul(reserve_in, U256::from(BPS_DENOMINATOR))?,
            amount_in_with_fee,
        )?;
        if denominator == U256::ZERO {
            return Err(RouterError::ZeroDenominator);
        }
        let amount_out = numerator / denominator;
        if amount_out == U256::ZERO || amount_out >= reserve_out {
            return Err(RouterError::NonExecutableQuote(self.pair));
        }
        Ok((token_out, amount_out))
    }
}

#[derive(Debug, Clone)]
pub struct V2GraphSnapshot {
    pub anchor: CanonicalBlock,
    pools: Vec<V2PoolSnapshot>,
    adjacency: HashMap<Address, Vec<usize>>,
}

impl V2GraphSnapshot {
    pub fn new(anchor: CanonicalBlock, pools: Vec<V2PoolSnapshot>) -> Result<Self, RouterError> {
        let mut adjacency: HashMap<Address, Vec<usize>> = HashMap::new();
        let mut seen_pairs = HashSet::new();
        for (index, pool) in pools.iter().copied().enumerate() {
            pool.validate()?;
            if pool.anchor != anchor {
                return Err(RouterError::AnchorMismatch {
                    expected: anchor,
                    actual: pool.anchor,
                });
            }
            if !seen_pairs.insert(pool.pair) {
                return Err(RouterError::DuplicatePair(pool.pair));
            }
            adjacency.entry(pool.token0).or_default().push(index);
            adjacency.entry(pool.token1).or_default().push(index);
        }
        for indexes in adjacency.values_mut() {
            indexes.sort_unstable_by_key(|index| pools[*index].pair);
        }
        Ok(Self {
            anchor,
            pools,
            adjacency,
        })
    }

    #[must_use]
    pub fn pools(&self) -> &[V2PoolSnapshot] {
        &self.pools
    }

    pub fn best_exact_in_route(
        &self,
        token_in: Address,
        token_out: Address,
        amount_in: U256,
        max_hops: usize,
    ) -> Result<Option<V2RouteQuote>, RouterError> {
        if token_in == Address::ZERO || token_out == Address::ZERO {
            return Err(RouterError::ZeroAddress);
        }
        if token_in == token_out {
            return Err(RouterError::IdenticalRouteEndpoints);
        }
        if amount_in == U256::ZERO {
            return Err(RouterError::ZeroAmountIn);
        }
        if max_hops == 0 || max_hops > MAX_SEARCH_HOPS {
            return Err(RouterError::InvalidMaxHops(max_hops));
        }

        let mut best: Option<V2RouteQuote> = None;
        let mut used_pairs = Vec::with_capacity(max_hops);
        let mut visited_tokens = Vec::with_capacity(max_hops + 1);
        visited_tokens.push(token_in);
        let mut hops = Vec::with_capacity(max_hops);
        self.search(
            token_in,
            token_out,
            amount_in,
            max_hops,
            &mut used_pairs,
            &mut visited_tokens,
            &mut hops,
            &mut best,
        )?;
        Ok(best)
    }

    #[allow(clippy::too_many_arguments)]
    fn search(
        &self,
        current_token: Address,
        target_token: Address,
        current_amount: U256,
        max_hops: usize,
        used_pairs: &mut Vec<Address>,
        visited_tokens: &mut Vec<Address>,
        hops: &mut Vec<V2HopPlan>,
        best: &mut Option<V2RouteQuote>,
    ) -> Result<(), RouterError> {
        if hops.len() >= max_hops {
            return Ok(());
        }
        let Some(indexes) = self.adjacency.get(&current_token) else {
            return Ok(());
        };

        for index in indexes {
            let pool = self.pools[*index];
            if used_pairs.contains(&pool.pair) {
                continue;
            }
            let (next_token, amount_out) = match pool.quote_exact_in_validated(current_token, current_amount) {
                Ok(quote) => quote,
                Err(RouterError::NonExecutableQuote(_)) => continue,
                Err(error) => return Err(error),
            };
            if next_token != target_token && visited_tokens.contains(&next_token) {
                continue;
            }

            let hop = V2HopPlan {
                pair: pool.pair,
                token_in: current_token,
                token_out: next_token,
                amount_in: current_amount,
                amount_out,
            };
            hops.push(hop);
            used_pairs.push(pool.pair);
            let inserted_token = if visited_tokens.contains(&next_token) {
                false
            } else {
                visited_tokens.push(next_token);
                true
            };

            if next_token == target_token {
                let candidate = V2RouteQuote {
                    anchor: self.anchor,
                    amount_in: hops[0].amount_in,
                    amount_out,
                    hops: hops.clone(),
                };
                let should_replace = match best.as_ref() {
                    Some(existing) => {
                        candidate.amount_out > existing.amount_out
                            || (candidate.amount_out == existing.amount_out
                                && candidate.hops.len() < existing.hops.len())
                            || (candidate.amount_out == existing.amount_out
                                && candidate.hops.len() == existing.hops.len()
                                && route_pair_order(&candidate.hops, &existing.hops).is_lt())
                    }
                    None => true,
                };
                if should_replace {
                    *best = Some(candidate);
                }
            } else {
                self.search(
                    next_token,
                    target_token,
                    amount_out,
                    max_hops,
                    used_pairs,
                    visited_tokens,
                    hops,
                    best,
                )?;
            }

            if inserted_token {
                visited_tokens.pop();
            }
            used_pairs.pop();
            hops.pop();
        }
        Ok(())
    }
}

fn route_pair_order(left: &[V2HopPlan], right: &[V2HopPlan]) -> core::cmp::Ordering {
    left.iter()
        .map(|hop| hop.pair)
        .cmp(right.iter().map(|hop| hop.pair))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V2RouteQuote {
    pub anchor: CanonicalBlock,
    pub amount_in: U256,
    pub amount_out: U256,
    pub hops: Vec<V2HopPlan>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoutedLiquidation {
    pub opportunity: LiquidationOpportunity,
    pub route: V2RouteQuote,
    pub pre_gas_profit_debt_asset: U256,
}

pub fn route_liquidation(
    graph: &V2GraphSnapshot,
    opportunity: LiquidationOpportunity,
    max_hops: usize,
) -> Result<Option<RoutedLiquidation>, RouterError> {
    if opportunity.anchor != graph.anchor {
        return Err(RouterError::AnchorMismatch {
            expected: opportunity.anchor,
            actual: graph.anchor,
        });
    }
    let Some(route) = graph.best_exact_in_route(
        opportunity.collateral_asset,
        opportunity.debt_asset,
        opportunity.collateral_to_liquidator,
        max_hops,
    )? else {
        return Ok(None);
    };
    if route.amount_out <= opportunity.flash_loan_repayment {
        return Ok(None);
    }
    let pre_gas_profit_debt_asset = checked_sub(route.amount_out, opportunity.flash_loan_repayment)?;
    Ok(Some(RoutedLiquidation {
        opportunity,
        route,
        pre_gas_profit_debt_asset,
    }))
}

#[derive(Debug, Error, Clone, Copy, PartialEq, Eq)]
pub enum RouterError {
    #[error(transparent)]
    Math(#[from] MathError),
    #[error("router contains a zero address")]
    ZeroAddress,
    #[error("pool {0} has identical tokens")]
    IdenticalPoolTokens(Address),
    #[error("pool {0} has zero reserves")]
    EmptyLiquidity(Address),
    #[error("invalid pool fee {0} bps")]
    InvalidFeeBps(u32),
    #[error("input amount cannot be zero")]
    ZeroAmountIn,
    #[error("token {token} is not present in pair {pair}")]
    TokenNotInPool { token: Address, pair: Address },
    #[error("constant-product quote denominator is zero")]
    ZeroDenominator,
    #[error("pair {0} cannot produce a positive executable quote")]
    NonExecutableQuote(Address),
    #[error("pool graph anchor mismatch: expected {expected:?}, got {actual:?}")]
    AnchorMismatch {
        expected: CanonicalBlock,
        actual: CanonicalBlock,
    },
    #[error("duplicate pair in graph: {0}")]
    DuplicatePair(Address),
    #[error("route endpoints must differ")]
    IdenticalRouteEndpoints,
    #[error("max hops must be between 1 and {MAX_SEARCH_HOPS}, got {0}")]
    InvalidMaxHops(usize),
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::B256;

    fn anchor() -> CanonicalBlock {
        CanonicalBlock {
            number: 100,
            hash: B256::repeat_byte(1),
            timestamp: 1_700_000_000,
            base_fee_per_gas: Some(20_000_000_000),
        }
    }

    fn pool(pair: u8, token0: u8, token1: u8, reserve0: u64, reserve1: u64) -> V2PoolSnapshot {
        V2PoolSnapshot {
            anchor: anchor(),
            pair: Address::repeat_byte(pair),
            token0: Address::repeat_byte(token0),
            token1: Address::repeat_byte(token1),
            reserve0: U256::from(reserve0),
            reserve1: U256::from(reserve1),
            fee_bps: 30,
        }
    }

    #[test]
    fn uniswap_v2_formula_matches_known_shape() -> Result<(), RouterError> {
        let p = pool(9, 1, 2, 1_000_000, 2_000_000);
        let (_, out) = p.quote_exact_in(Address::repeat_byte(1), U256::from(10_000u64))?;
        assert_eq!(out, U256::from(19_743u64));
        Ok(())
    }

    #[test]
    fn search_prefers_higher_output_across_direct_and_two_hop_routes() -> Result<(), RouterError> {
        let graph = V2GraphSnapshot::new(
            anchor(),
            vec![
                pool(10, 1, 3, 1_000_000, 900_000),
                pool(11, 1, 2, 1_000_000, 2_000_000),
                pool(12, 2, 3, 2_000_000, 2_000_000),
            ],
        )?;
        let route = graph
            .best_exact_in_route(
                Address::repeat_byte(1),
                Address::repeat_byte(3),
                U256::from(10_000u64),
                2,
            )?
            .ok_or(RouterError::NonExecutableQuote(Address::ZERO))?;
        assert_eq!(route.hops.len(), 2);
        assert_eq!(route.hops[0].pair, Address::repeat_byte(11));
        assert_eq!(route.hops[1].pair, Address::repeat_byte(12));
        Ok(())
    }
}
