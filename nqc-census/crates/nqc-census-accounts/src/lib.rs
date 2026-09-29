//! RMC-009 — Aave V3 account and position universe.
//!
//! The universe of accounts holding a position in the D06-admitted Aave V3
//! core pool at the observation anchor, with every position read from the
//! protocol at that anchor on two providers.
//!
//! Token logs are candidate hints only. Completeness is proven by exact
//! conservation at the anchor: for every aToken and variable debt token, the
//! scaled balances of the indexed accounts must sum to the token's
//! `scaledTotalSupply()` (the token's own accounting keeps `_totalSupply`
//! equal to the sum of every holder's scaled balance). A holder the index
//! missed leaves a deficit and the census blocks; nothing is inferred from
//! the absence of a log.
//!
//! Uniswap V2 has no borrower or collateral positions; RMC-009 records it as
//! not applicable and fabricates nothing for it.

pub mod candidates;
pub mod closeout;
pub mod index;
pub mod inputs;
pub mod plan;
pub mod replay;
pub mod stage;
pub mod state;
pub mod tokens;
pub mod verify;
