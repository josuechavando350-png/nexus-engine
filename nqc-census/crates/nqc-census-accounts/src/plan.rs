//! The token universe RMC-009 indexes and reads, derived only from the D06
//! reserve lifecycle.

use nqc_census_chain::{abi, hex, job::LogFilter, ChainError};
use nqc_census_core::Address;
use nqc_census_state::stage::AnchorPlan;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// `IScaledBalanceToken.Mint`: emitted on every scaled-balance increase of an
/// aToken or variable debt token (supply, borrow, treasury accrual, interest
/// minted on a burn). `onBehalfOf` is topic 2.
pub const MINT_EVENT: &str = "Mint(address,address,uint256,uint256,uint256)";
/// `IAToken.BalanceTransfer`: emitted on every aToken transfer, including
/// liquidation transfers. `to` is topic 2. Variable debt tokens are not
/// transferable.
pub const BALANCE_TRANSFER_EVENT: &str = "BalanceTransfer(address,address,uint256,uint256)";

pub fn mint_topic() -> [u8; 32] {
    abi::event_topic(MINT_EVENT)
}

pub fn balance_transfer_topic() -> [u8; 32] {
    abi::event_topic(BALANCE_TRANSFER_EVENT)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TokenKind {
    AToken,
    VariableDebt,
}

impl TokenKind {
    pub const fn code(self) -> &'static str {
        match self {
            Self::AToken => "ATOKEN",
            Self::VariableDebt => "VARIABLE_DEBT_TOKEN",
        }
    }
}

/// Tokens of one D06 `ReserveInitialized` event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReserveTokens {
    pub asset: Address,
    pub market_id: String,
    /// Current reserve id at the anchor; `None` for an initialization that is
    /// no longer the reserve's current one (dropped or superseded).
    pub reserve_id: Option<u16>,
    pub a_token: Address,
    pub variable_debt_token: Address,
    pub stable_debt_token: Option<Address>,
    pub initialized_block: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenRef {
    pub reserve: usize,
    pub kind: TokenKind,
}

#[derive(Debug, Clone)]
pub struct AccountPlan {
    pub anchor: AnchorPlan,
    pub pool: Address,
    pub reserves: Vec<ReserveTokens>,
    /// First indexed block: the earliest reserve initialization.
    pub first_block: u64,
    /// Blocks per resumable index job (a global grid from `first_block`).
    pub job_span: u64,
    /// Accounts per resumable state job.
    pub job_accounts: usize,
}

impl AccountPlan {
    pub fn new(
        anchor: AnchorPlan,
        pool: Address,
        reserves: Vec<ReserveTokens>,
        job_span: u64,
        job_accounts: usize,
    ) -> Result<Self, ChainError> {
        if reserves.is_empty() || job_span == 0 || job_accounts == 0 {
            return Err(ChainError::Config("empty account plan".into()));
        }
        let first_block = reserves
            .iter()
            .map(|reserve| reserve.initialized_block)
            .min()
            .unwrap_or(anchor.number);
        if first_block > anchor.number {
            return Err(ChainError::Config(
                "a reserve was initialized after the anchor".into(),
            ));
        }
        let plan = Self {
            anchor,
            pool,
            reserves,
            first_block,
            job_span,
            job_accounts,
        };
        let expected = plan.reserves.len() * 2;
        if plan.tokens().len() != expected {
            return Err(ChainError::Config(
                "reserve tokens are not pairwise distinct".into(),
            ));
        }
        Ok(plan)
    }

    /// Every indexed token and the reserve it belongs to.
    pub fn tokens(&self) -> BTreeMap<Address, TokenRef> {
        let mut tokens = BTreeMap::new();
        for (reserve, tokens_of) in self.reserves.iter().enumerate() {
            tokens.insert(
                tokens_of.a_token,
                TokenRef {
                    reserve,
                    kind: TokenKind::AToken,
                },
            );
            tokens.insert(
                tokens_of.variable_debt_token,
                TokenRef {
                    reserve,
                    kind: TokenKind::VariableDebt,
                },
            );
        }
        tokens
    }

    pub fn index_filter(&self) -> Result<LogFilter, ChainError> {
        LogFilter::new(
            self.tokens().into_keys().collect(),
            vec![mint_topic(), balance_transfer_topic()],
        )
    }

    /// Digest binding every stage to the exact token universe.
    pub fn tokens_digest(&self) -> String {
        let mut digest = Sha256::new();
        digest.update(b"NQC-RMC009-TOKENS-V1");
        digest.update(self.pool.as_bytes());
        for reserve in &self.reserves {
            digest.update(reserve.asset.as_bytes());
            digest.update(reserve.a_token.as_bytes());
            digest.update(reserve.variable_debt_token.as_bytes());
            match reserve.stable_debt_token {
                Some(token) => {
                    digest.update([1]);
                    digest.update(token.as_bytes());
                }
                None => digest.update([0]),
            }
            match reserve.reserve_id {
                Some(id) => {
                    digest.update([1]);
                    digest.update(id.to_be_bytes());
                }
                None => digest.update([0]),
            }
            digest.update(reserve.initialized_block.to_be_bytes());
            digest.update((reserve.market_id.len() as u64).to_be_bytes());
            digest.update(reserve.market_id.as_bytes());
        }
        hex::plain(&digest.finalize())
    }

    /// The global index job grid over `[first_block, anchor]`.
    pub fn job_ranges(&self) -> Vec<(u64, u64)> {
        let mut ranges = Vec::new();
        let mut start = self.first_block;
        while start <= self.anchor.number {
            let end = start
                .saturating_add(self.job_span - 1)
                .min(self.anchor.number);
            ranges.push((start, end));
            start = end + 1;
        }
        ranges
    }
}

/// Blocks per mainnet index job: 200,000 blocks is 20 mevblocker windows of
/// 10,000 and 40 tenderly windows of 5,000 (probe run 36590720390).
pub const MAINNET_JOB_SPAN: u64 = 200_000;
/// Accounts per mainnet state job.
pub const MAINNET_JOB_ACCOUNTS: usize = 500;
