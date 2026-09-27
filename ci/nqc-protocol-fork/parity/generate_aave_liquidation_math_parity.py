#!/usr/bin/env python3
"""Generate exact Rust liquidation-math parity from a transaction-prestate witness."""
import argparse, json
from pathlib import Path

TX="0xa36fcaa8b9572a15b81dbeeb9731ff9c7b9e7542de7b52834b9349526364cfc5"
PARENT="0x033656168ee1dba1934f77171fe572c866282e97738b79434cb8c01b6e6f88f2"

REQUIRED={
    "transaction_hash","block_number","parent_hash","block_timestamp","pool","borrower",
    "collateral_asset","debt_asset","collateral_reserve_id","debt_reserve_id",
    "collateral_unit","debt_unit","oracle_base_unit","collateral_price_oracle_units",
    "debt_price_oracle_units","borrower_collateral_balance","borrower_variable_debt",
    "total_collateral_base","total_debt_base","health_factor_wad","liquidation_threshold_bps",
    "user_emode_category","reserve_liquidation_bonus_bps","effective_liquidation_bonus_bps",
    "liquidation_protocol_fee_bps","flash_loan_premium_bps","reference_flash_premium",
    "observed_debt_to_cover","observed_collateral_to_liquidator"
}

def n(v):
    if isinstance(v,int):
        return v
    if isinstance(v,str):
        return int(v,0)
    raise ValueError(f"unexpected integer encoding: {v!r}")

def rs(v):
    return f'U256::from_str("{n(v)}")?'

def generate(w):
    missing=sorted(REQUIRED-set(w))
    if missing:
        raise ValueError(f"missing witness fields: {missing}")
    if str(w["transaction_hash"]).lower()!=TX:
        raise ValueError("transaction mismatch")
    if n(w["block_number"])!=25_437_474:
        raise ValueError("block mismatch")
    if str(w["parent_hash"]).lower()!=PARENT:
        raise ValueError("parent mismatch")
    if n(w["health_factor_wad"])>=10**18:
        raise ValueError("fixture is not liquidatable")
    if n(w["oracle_base_unit"])==0:
        raise ValueError("zero oracle base unit")

    return f'''use alloy::primitives::U256;
use nqc_aave_math::{{
    calculate_available_collateral_to_liquidate,
    max_liquidatable_debt,
    AvailableCollateralInput,
    LiquidationSizingInput,
}};
use nqc_core::{{mul_div_ceil, mul_div_floor, percent_mul_half_up}};
use std::str::FromStr;

type Error = Box<dyn std::error::Error>;

fn main() -> Result<(), Error> {{
    let health_factor = {rs(w["health_factor_wad"])};
    let total_debt_base = {rs(w["total_debt_base"])};
    let borrower_collateral = {rs(w["borrower_collateral_balance"])};
    let borrower_debt = {rs(w["borrower_variable_debt"])};
    let collateral_price = {rs(w["collateral_price_oracle_units"])};
    let debt_price = {rs(w["debt_price_oracle_units"])};
    let collateral_unit = {rs(w["collateral_unit"])};
    let debt_unit = {rs(w["debt_unit"])};
    let base_unit = {rs(w["oracle_base_unit"])};
    let observed_debt = {rs(w["observed_debt_to_cover"])};
    let observed_collateral = {rs(w["observed_collateral_to_liquidator"])};

    let reserve_collateral_base =
        mul_div_floor(borrower_collateral, collateral_price, collateral_unit)?;
    let reserve_debt_base =
        mul_div_ceil(borrower_debt, debt_price, debt_unit)?;

    let max_debt = max_liquidatable_debt(LiquidationSizingInput {{
        health_factor_wad: health_factor,
        total_debt_base_wad: total_debt_base,
        reserve_debt_amount: borrower_debt,
        reserve_debt_base_wad: reserve_debt_base,
        reserve_collateral_base_wad: reserve_collateral_base,
        debt_asset_price_base_wad: debt_price,
        debt_asset_unit: debt_unit,
        min_base_max_close_factor_threshold_wad:
            U256::from(2_000u64) * base_unit,
    }})?;

    if observed_debt > max_debt {{
        return Err(format!(
            "historical debt_to_cover exceeds recovered max: observed={{}} max={{}}",
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
            liquidation_bonus_bps: {n(w["effective_liquidation_bonus_bps"])}u32,
            liquidation_protocol_fee_bps: {n(w["liquidation_protocol_fee_bps"])}u32,
        }}
    )?;

    if available.debt_to_liquidate != observed_debt {{
        return Err(format!(
            "historical debt liquidation mismatch: observed={{}} recovered={{}}",
            observed_debt, available.debt_to_liquidate
        ).into());
    }}
    if available.collateral_to_liquidator != observed_collateral {{
        return Err(format!(
            "historical collateral liquidation mismatch: observed={{}} recovered={{}}",
            observed_collateral, available.collateral_to_liquidator
        ).into());
    }}

    let premium = percent_mul_half_up(
        observed_debt,
        {n(w["flash_loan_premium_bps"])}u32,
    )?;
    let expected_premium = {rs(w["reference_flash_premium"])};
    if premium != expected_premium {{
        return Err(format!(
            "flash premium integer mismatch: expected={{}} recovered={{}}",
            expected_premium, premium
        ).into());
    }}

    println!(
        "AAVE_LIQUIDATION_MATH_PARITY_PASS tx={TX} block=25437474 debt={{}} collateral={{}} protocol_fee_collateral={{}} max_debt={{}} flash_premium={{}}",
        available.debt_to_liquidate,
        available.collateral_to_liquidator,
        available.liquidation_protocol_fee_collateral,
        max_debt,
        premium
    );
    println!(
        "AAVE_LIQUIDATION_MATH_TOTAL exact_checks=4 emode_category={n(w["user_emode_category"])} effective_bonus_bps={n(w["effective_liquidation_bonus_bps"])} protocol_fee_bps={n(w["liquidation_protocol_fee_bps"])}"
    );
    Ok(())
}}
'''

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("witness",type=Path)
    ap.add_argument("output",type=Path)
    a=ap.parse_args()
    w=json.loads(a.witness.read_text())
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(generate(w))
