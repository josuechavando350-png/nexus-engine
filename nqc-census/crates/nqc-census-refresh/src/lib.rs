//! RMC-010 — incremental refresh and full-census parity.
//!
//! An incremental refresh reaches a target anchor A1 from a certified census
//! at a base anchor A0 by acquiring only what the base cannot answer:
//!
//! - the base anchor must still be canonical at A1 on two providers
//!   (`BASE_CANONICALITY`); a reorged base refuses the refresh and a full
//!   census is required;
//! - event-derived universes are the certified base plus a delta index over
//!   `(A0, A1]`;
//! - every time-dependent fact (balances, configuration, supplies, account
//!   data) is re-read at A1, exactly as a full census reads it.
//!
//! The census artifacts of the refresh must be byte-identical to those of a
//! full census at A1 (`census_parity`); only the provenance differs.

pub mod base;
pub mod canonical;
pub mod canonical_extract;
pub mod parity;
pub mod refresh;
pub mod stage;
