#!/usr/bin/env python3
"""Generate a one-case Rust parity probe for an Aave default-close candidate."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

REQUIRED = {
    "case_index", "transaction_hash", "block_number", "parent_hash",
    "borrower", "collateral_asset", "debt_asset", "collateral_unit",
    "debt_unit", "oracle_base_unit", "collateral_price_oracle_units",
    "debt_price_oracle_units", "borrower_collateral_balance",
    "borrower_variable_debt", "total_collateral_base", "total_debt_base",
    "health_factor_wad", "effective_liquidation_bonus_bps",
    "liquidation_protocol_fee_bps", "flash_loan_premium_bps",
    "observed_callback_flash_premium", "flash_loan_callback_observed",
    "observed_debt_to_cover", "observed_collateral_to_liquidator",
}


def n(value):
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return int(value, 0)
    raise ValueError(f"unexpected integer encoding {value!r}")


def rs(value):
    return f'U256::from_str("{n(value)}")?'


def load_fixture(path: Path):
    doc = json.loads(path.read_text())
    if doc.get("schema_version") != 1 or doc.get("strategy_family") != "liquidation":
        raise ValueError("unexpected candidate fixture schema")
    if doc.get("chain_id") != 1 or doc.get("expected", {}).get("receipt_status") != "0x1":
        raise ValueError("candidate is not a successful Ethereum-mainnet liquidation")
    if doc.get("provenance", {}).get("fixture_admitted") is not False:
        raise ValueError("candidate discovery fixture must remain non-admitted")
    events = doc.get("account", {}).get("observed_liquidations", [])
    if len(events) != 1 or doc["account"].get("total_liquidation_log_count") != 1:
        raise ValueError("candidate must contain exactly one liquidation event")
    return doc, events[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--witness", type=Path, required=True)
    ap.add_argument("--fixture", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()

    fixture, event = load_fixture(args.fixture)
    witness = json.loads(args.witness.read_text())
    missing = sorted(REQUIRED - set(witness))
    if missing:
        raise ValueError(f"candidate witness missing fields {missing}")
    if n(witness["case_index"]) != 14:
        raise ValueError("candidate witness must occupy matrix single-case index 14")

    expected_text = {
        "transaction_hash": fixture["provenance"]["transaction_hash"].lower(),
        "parent_hash": fixture["parent_hash"].lower(),
        "borrower": event["borrower"].lower(),
        "collateral_asset": event["collateral_asset"].lower(),
        "debt_asset": event["debt_asset"].lower(),
    }
    for key, expected in expected_text.items():
        if str(witness[key]).lower() != expected:
            raise ValueError(f"candidate fixture mismatch: {key}")
    if n(witness["block_number"]) != int(fixture["block_number"]):
        raise ValueError("candidate fixture mismatch: block_number")
    if n(witness["observed_debt_to_cover"]) != int(event["debt_to_cover"]):
        raise ValueError("candidate fixture mismatch: observed_debt_to_cover")
    if n(witness["observed_collateral_to_liquidator"]) != int(
        event["liquidated_collateral_amount"]
    ):
        raise ValueError("candidate fixture mismatch: observed collateral")
    if n(witness["flash_loan_callback_observed"]) != 1:
        raise ValueError("candidate lacks deployed flash-loan callback evidence")
    if n(witness["health_factor_wad"]) >= 10**18:
        raise ValueError("candidate is not liquidatable in transaction prestate")

    case_id = fixture["case_id"]
    tx_hash = fixture["provenance"]["transaction_hash"].lower()
    code = f'''use alloy::primitives::U256;
use nqc_aave_math::{{
    calculate_available_collateral_to_liquidate, max_liquidatable_debt,
    AvailableCollateralInput, LiquidationSizingInput, FULL_CLOSE_HF_WAD,
}};
use nqc_core::{{mul_div_ceil, mul_div_floor, percent_mul_ceil_unbounded}};
use std::str::FromStr;
type Error = Box<dyn std::error::Error>;

fn main() -> Result<(), Error> {{
    let health_factor = {rs(witness["health_factor_wad"])};
    let total_debt_base = {rs(witness["total_debt_base"])};
    let borrower_collateral = {rs(witness["borrower_collateral_balance"])};
    let borrower_debt = {rs(witness["borrower_variable_debt"])};
    let collateral_price = {rs(witness["collateral_price_oracle_units"])};
    let debt_price = {rs(witness["debt_price_oracle_units"])};
    let collateral_unit = {rs(witness["collateral_unit"])};
    let debt_unit = {rs(witness["debt_unit"])};
    let base_unit = {rs(witness["oracle_base_unit"])};
    let observed_debt = {rs(witness["observed_debt_to_cover"])};
    let observed_collateral = {rs(witness["observed_collateral_to_liquidator"])};

    let reserve_collateral_base =
        mul_div_floor(borrower_collateral, collateral_price, collateral_unit)?;
    let reserve_debt_base =
        mul_div_ceil(borrower_debt, debt_price, debt_unit)?;
    let close_threshold = U256::from(2_000u64) * base_unit;
    let default_close =
        health_factor > U256::from(FULL_CLOSE_HF_WAD)
        && reserve_collateral_base >= close_threshold
        && reserve_debt_base >= close_threshold;
    let max_debt = max_liquidatable_debt(LiquidationSizingInput {{
        health_factor_wad: health_factor,
        total_debt_base_wad: total_debt_base,
        reserve_debt_amount: borrower_debt,
        reserve_debt_base_wad: reserve_debt_base,
        reserve_collateral_base_wad: reserve_collateral_base,
        debt_asset_price_base_wad: debt_price,
        debt_asset_unit: debt_unit,
        min_base_max_close_factor_threshold_wad: close_threshold,
    }})?;

    if observed_debt > max_debt {{
        return Err(format!(
            "candidate historical debt exceeds recovered close-factor cap: observed={{}} cap={{}}",
            observed_debt, max_debt
        ).into());
    }}

    let available = calculate_available_collateral_to_liquidate(
        AvailableCollateralInput {{
            collateral_price_base_wad: collateral_price,
            collateral_asset_unit: collateral_unit,
            debt_price_base_wad: debt_price,
            debt_asset_unit: debt_unit,
            debt_to_cover: observed_debt,
            borrower_collateral_balance: borrower_collateral,
            liquidation_bonus_bps: {n(witness["effective_liquidation_bonus_bps"])}u32,
            liquidation_protocol_fee_bps: {n(witness["liquidation_protocol_fee_bps"])}u32,
        }},
    )?;
    if available.debt_to_liquidate != observed_debt {{
        return Err(format!(
            "candidate debt integer mismatch: observed={{}} recovered={{}}",
            observed_debt, available.debt_to_liquidate
        ).into());
    }}
    if available.collateral_to_liquidator != observed_collateral {{
        return Err(format!(
            "candidate collateral integer mismatch: observed={{}} recovered={{}}",
            observed_collateral, available.collateral_to_liquidator
        ).into());
    }}

    let premium = percent_mul_ceil_unbounded(
        observed_debt,
        {n(witness["flash_loan_premium_bps"])}u32,
    )?;
    let callback_premium = {rs(witness["observed_callback_flash_premium"])};
    if premium != callback_premium {{
        return Err(format!(
            "candidate deployed callback premium mismatch: callback={{}} recovered={{}}",
            callback_premium, premium
        ).into());
    }}

    if default_close && observed_debt == max_debt {{
        println!(
            "AAVE_DEFAULT_CLOSE_CAP_MATCH case_id={case_id} tx={tx_hash} observed_debt={{}} max_debt={{}} health_factor={{}} premium={{}}",
            observed_debt, max_debt, health_factor, premium
        );
    }} else {{
        println!(
            "AAVE_DEFAULT_CLOSE_CAP_NO_MATCH case_id={case_id} tx={tx_hash} default_close={{}} observed_debt={{}} max_debt={{}} health_factor={{}}",
            default_close, observed_debt, max_debt, health_factor
        );
    }}
    Ok(())
}}
'''
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(code)


if __name__ == "__main__":
    main()
