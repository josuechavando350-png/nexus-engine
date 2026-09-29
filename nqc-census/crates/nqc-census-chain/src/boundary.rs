//! Earliest-runtime-code boundary from archive state.
//!
//! Binary search over block-pinned `eth_getCode` observations for the first
//! block at which an account has code, proven by: empty code at the
//! predecessor, non-empty code at the boundary, and the boundary header's
//! parent hash equal to the predecessor's hash. The search is only valid if
//! code presence is monotone over the interval; whether the account could
//! have lost its code (self-destruct through its own code or a delegate) is a
//! separate claim the caller must establish and report.

use crate::error::ChainError;
use crate::hex;
use crate::job::{chain_read_semantics, JobContext};
use crate::json::Json;
use nqc_census_core::Address;
use sha2::{Digest, Sha256};

/// Job body: earliest block in `(lo, hi]` where `account` has code, given
/// code is absent at `lo` and present at `hi`.
pub fn earliest_code_body(
    ctx: &mut JobContext<'_>,
    account: Address,
    lo: u64,
    hi: u64,
) -> Result<Json, ChainError> {
    if lo >= hi {
        return Err(ChainError::Config("earliest-code interval is empty".into()));
    }
    let semantics = chain_read_semantics()?;
    let probe = |ctx: &mut JobContext<'_>, number: u64| -> Result<(bool, Json), ChainError> {
        let header = ctx.header_by_number(number)?;
        let anchor = header.envelope().anchor().clone();
        let code = ctx.code(account, &anchor, semantics)?;
        let present = !code.payload().is_absent();
        Ok((
            present,
            Json::object([
                ("block", Json::uint(number)),
                ("hash", Json::string(anchor.block_hash().to_hex())),
                ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
                ("code_len", Json::uint(code.payload().code().len() as u64)),
                (
                    "code_sha256",
                    Json::string(hex::plain(&Sha256::digest(code.payload().code()))),
                ),
            ]),
        ))
    };

    let (present_hi, _) = probe(ctx, hi)?;
    if !present_hi {
        return Err(ChainError::Evidence(
            "account has no code at the upper bound".into(),
        ));
    }
    let (present_lo, _) = probe(ctx, lo)?;
    if present_lo {
        return Err(ChainError::Evidence(
            "account already has code at the lower bound".into(),
        ));
    }
    let (mut low, mut high) = (lo, hi);
    let mut probes = 2_u64;
    while high - low > 1 {
        let middle = low + (high - low) / 2;
        let (present, _) = probe(ctx, middle)?;
        probes += 1;
        if present {
            high = middle;
        } else {
            low = middle;
        }
    }
    let (predecessor_present, predecessor) = probe(ctx, high - 1)?;
    let (boundary_present, boundary) = probe(ctx, high)?;
    if predecessor_present || !boundary_present {
        return Err(ChainError::Evidence(
            "boundary proof is inconsistent".into(),
        ));
    }
    if boundary.get("parent_hash") != predecessor.get("hash") {
        return Err(ChainError::NonCanonical {
            what: "code boundary",
            detail: "boundary header does not extend its predecessor".into(),
        });
    }
    Ok(Json::object([
        ("account", Json::string(account.to_hex())),
        (
            "search_interval",
            Json::array([Json::uint(lo), Json::uint(hi)]),
        ),
        ("first_code_block", Json::uint(high)),
        ("boundary", boundary),
        ("predecessor", predecessor),
        ("probes", Json::uint(probes + 2)),
    ]))
}
