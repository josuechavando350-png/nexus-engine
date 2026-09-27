use alloy::primitives::{Address, B256};
use nqc_replay::{ReplayContext, ReplayError, StrategyKind};
use nqc_state::CanonicalBlock;
use std::{env, str::FromStr};

type Error = Box<dyn std::error::Error>;

const HEIGHT: u64 = 10_500_011;
const ORPHAN_HASH: &str =
    "0xb4e222da7f14708b71c9cf64a68e40017e5b49870d840d343412a5f899474f67";
const CANONICAL_HASH: &str =
    "0xa1f5eb25631c2d47d91071fb0c6ff7d925a4a45e07fc1d3fe47d7a268d5ff0c1";

fn context(anchor: CanonicalBlock, salt: u8) -> ReplayContext {
    ReplayContext {
        chain_id: 1,
        anchor,
        target_block: anchor.number + 1,
        strategy: StrategyKind::AaveLiquidation,
        subject: Address::repeat_byte(salt),
        market_snapshot_hash: B256::with_last_byte(salt.wrapping_add(1)),
        state_snapshot_hash: B256::with_last_byte(salt.wrapping_add(2)),
        execution_plan_hash: B256::with_last_byte(salt.wrapping_add(3)),
        transaction_intent_hash: B256::with_last_byte(salt.wrapping_add(4)),
        simulation_environment_hash: B256::with_last_byte(salt.wrapping_add(5)),
        simulation_result_hash: B256::with_last_byte(salt.wrapping_add(6)),
        settlement_result_hash: B256::with_last_byte(salt.wrapping_add(7)),
        edge_assessment_hash: B256::with_last_byte(salt.wrapping_add(8)),
        fee_envelope_hash: B256::with_last_byte(salt.wrapping_add(9)),
        risk_policy_hash: B256::with_last_byte(salt.wrapping_add(10)),
    }
}

fn require_stale_rejection(
    old_anchor: CanonicalBlock,
    new_anchor: CanonicalBlock,
    salt: u8,
) -> Result<(B256, B256), Error> {
    let stale = context(old_anchor, salt).seal();
    stale.verify()?;
    match stale.require_anchor(new_anchor) {
        Err(ReplayError::AnchorMismatch { expected, actual }) => {
            if expected != old_anchor || actual != new_anchor {
                return Err("anchor mismatch payload drift".into());
            }
        }
        other => return Err(format!("stale replay capsule did not fail closed: {other:?}").into()),
    }

    let refreshed = context(new_anchor, salt).seal();
    refreshed.verify()?;
    refreshed.require_anchor(new_anchor)?;
    if stale.fingerprint == refreshed.fingerprint {
        return Err("reorg did not change replay fingerprint".into());
    }
    Ok((stale.fingerprint, refreshed.fingerprint))
}

fn require_anchor_identity_fingerprint_binding(anchor: CanonicalBlock) -> Result<u64, Error> {
    let baseline = context(anchor, 0x70);
    let baseline_fp = baseline.fingerprint();
    let mut checked = 0u64;

    let mut number = baseline;
    number.anchor.number = number.anchor.number.checked_add(1).ok_or("anchor number overflow")?;
    if number.fingerprint() == baseline_fp {
        return Err("anchor number omitted from replay fingerprint".into());
    }
    checked += 1;

    let mut hash = baseline;
    hash.anchor.hash = B256::with_last_byte(0x7a);
    if hash.anchor.hash == baseline.anchor.hash {
        hash.anchor.hash = B256::with_last_byte(0x7b);
    }
    if hash.fingerprint() == baseline_fp {
        return Err("anchor hash omitted from replay fingerprint".into());
    }
    checked += 1;

    let mut timestamp = baseline;
    timestamp.anchor.timestamp = timestamp.anchor.timestamp.checked_add(1).ok_or("anchor timestamp overflow")?;
    if timestamp.fingerprint() == baseline_fp {
        return Err("anchor timestamp omitted from replay fingerprint".into());
    }
    checked += 1;

    let mut base_fee = baseline;
    base_fee.anchor.base_fee_per_gas = match baseline.anchor.base_fee_per_gas {
        Some(value) => Some(value.checked_add(1).ok_or("base fee overflow")?),
        None => Some(1),
    };
    if base_fee.fingerprint() == baseline_fp {
        return Err("anchor base fee omitted from replay fingerprint".into());
    }
    checked += 1;

    Ok(checked)
}

fn main() -> Result<(), Error> {
    let args: Vec<String> = env::args().collect();
    if args.len() != 6 {
        return Err("usage: pft_reorg_replay_refresh <provider-id> <canonical-timestamp> <canonical-base-fee-or-none> <orphan-timestamp> <orphan-base-fee-or-none>".into());
    }
    let provider = &args[1];
    let canonical_timestamp: u64 = args[2].parse()?;
    let canonical_base_fee_per_gas = if args[3] == "none" {
        None
    } else {
        Some(args[3].parse::<u64>()?)
    };
    let orphan_timestamp: u64 = args[4].parse()?;
    let orphan_base_fee_per_gas = if args[5] == "none" {
        None
    } else {
        Some(args[5].parse::<u64>()?)
    };

    let canonical = CanonicalBlock {
        number: HEIGHT,
        hash: B256::from_str(CANONICAL_HASH)?,
        timestamp: canonical_timestamp,
        base_fee_per_gas: canonical_base_fee_per_gas,
    };
    let orphan = CanonicalBlock {
        number: HEIGHT,
        hash: B256::from_str(ORPHAN_HASH)?,
        timestamp: orphan_timestamp,
        base_fee_per_gas: orphan_base_fee_per_gas,
    };

    let (stale_fp, refreshed_fp) = require_stale_rejection(orphan, canonical, 0x31)?;
    let anchor_identity_dimensions = require_anchor_identity_fingerprint_binding(canonical)?;
    if anchor_identity_dimensions != 4 {
        return Err("anchor identity dimension count mismatch".into());
    }

    let mut deep_replacements = 0u64;
    for (offset, (old_hash, new_hash)) in [(0x41u8, 0x51u8), (0x42u8, 0x52u8)]
        .into_iter()
        .enumerate()
    {
        let old_anchor = CanonicalBlock {
            number: 20_000_000 + offset as u64,
            hash: B256::with_last_byte(old_hash),
            timestamp: 1_800_000_000 + offset as u64 * 12,
            base_fee_per_gas: Some(1_000_000_000 + offset as u64),
        };
        let new_anchor = CanonicalBlock {
            hash: B256::with_last_byte(new_hash),
            ..old_anchor
        };
        let _ = require_stale_rejection(old_anchor, new_anchor, 0x60 + offset as u8)?;
        deep_replacements += 1;
    }

    if deep_replacements != 2 {
        return Err("deep replacement count mismatch".into());
    }

    println!(
        "REORG_REPLAY_REFRESH_PASS upstream={} height={} orphan={} canonical={} orphan_timestamp={} canonical_timestamp={} orphan_base_fee={:?} canonical_base_fee={:?} stale_fingerprint={:#x} refreshed_fingerprint={:#x} anchor_identity_dimensions={} deep_replacements={} unexplained_mismatches=0",
        provider,
        HEIGHT,
        ORPHAN_HASH,
        CANONICAL_HASH,
        orphan.timestamp,
        canonical.timestamp,
        orphan.base_fee_per_gas,
        canonical.base_fee_per_gas,
        stale_fp,
        refreshed_fp,
        anchor_identity_dimensions,
        deep_replacements,
    );
    Ok(())
}
