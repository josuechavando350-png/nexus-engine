#!/usr/bin/env python3
"""Generate recovered Rust liquidation-math parity for all admitted historical events."""
import argparse
import json
from pathlib import Path

REQUIRED = {
    "case_index","transaction_hash","block_number","parent_hash","block_timestamp",
    "pool","borrower","collateral_asset","debt_asset","collateral_reserve_id",
    "debt_reserve_id","collateral_unit","debt_unit","oracle_base_unit",
    "collateral_price_oracle_units","debt_price_oracle_units",
    "borrower_collateral_balance","borrower_variable_debt","total_collateral_base",
    "total_debt_base","health_factor_wad","liquidation_threshold_bps",
    "user_emode_category","reserve_liquidation_bonus_bps",
    "effective_liquidation_bonus_bps","liquidation_protocol_fee_bps",
    "flash_loan_premium_bps","observed_callback_flash_premium",
    "flash_loan_callback_observed","observed_debt_to_cover",
    "observed_collateral_to_liquidator",
}


def n(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        return int(v, 0)
    raise ValueError(f"unexpected integer encoding {v!r}")


def rs(v):
    return f'U256::from_str("{n(v)}")?'


def fixtures(*paths):
    expected=[]
    for path in paths:
        doc=json.loads(path.read_text())
        for event in doc["account"]["observed_liquidations"]:
            expected.append({
                "transaction_hash":doc["provenance"]["transaction_hash"].lower(),
                "block_number":int(doc["block_number"]),
                "parent_hash":doc["parent_hash"].lower(),
                "borrower":event["borrower"].lower(),
                "collateral_asset":event["collateral_asset"].lower(),
                "debt_asset":event["debt_asset"].lower(),
                "observed_debt_to_cover":int(event["debt_to_cover"]),
                "observed_collateral_to_liquidator":int(event["liquidated_collateral_amount"]),
            })
    if len(expected)!=16:
        raise ValueError(f"expected 16 fixture liquidations, got {len(expected)}")
    return expected


def load_witnesses(root, expected):
    out=[]
    for index, exp in enumerate(expected):
        doc=json.loads((root/f"{index}.json").read_text())
        missing=sorted(REQUIRED-set(doc))
        if missing:
            raise ValueError(f"case {index} missing fields {missing}")
        if n(doc["case_index"])!=index:
            raise ValueError(f"case index mismatch {index}")
        for key in ("transaction_hash","parent_hash","borrower","collateral_asset","debt_asset"):
            if str(doc[key]).lower()!=str(exp[key]).lower():
                raise ValueError(f"case {index} fixture mismatch: {key}")
        for key in ("block_number","observed_debt_to_cover","observed_collateral_to_liquidator"):
            if n(doc[key])!=int(exp[key]):
                raise ValueError(f"case {index} fixture mismatch: {key}")
        if n(doc["health_factor_wad"])>=10**18:
            raise ValueError(f"case {index} is not liquidatable in transaction prestate")
        if n(doc["flash_loan_callback_observed"])!=1:
            raise ValueError(f"case {index} did not observe a deployed flash-loan callback")
        out.append(doc)
    return out


def generate(cases):
    lines=[
        "use alloy::primitives::U256;",
        "use nqc_aave_math::{",
        "    calculate_available_collateral_to_liquidate, max_liquidatable_debt,",
        "    AvailableCollateralInput, LiquidationSizingInput, FULL_CLOSE_HF_WAD,",
        "};",
        "use nqc_core::{mul_div_ceil, mul_div_floor, percent_mul_ceil_unbounded};",
        "use std::str::FromStr;",
        "type Error = Box<dyn std::error::Error>;",
        "fn main() -> Result<(), Error> {",
        "let mut cases = 0u64;",
        "let mut exact_integer_checks = 0u64;",
        "let mut deployed_callback_premium_checks = 0u64;",
        "let mut default_close_cap_matches = 0u64;",
        "let mut full_close_cap_matches = 0u64;",
    ]
    for i,w in enumerate(cases):
        lines += [
            "{",
            f"let health_factor = {rs(w['health_factor_wad'])};",
            f"let total_debt_base = {rs(w['total_debt_base'])};",
            f"let borrower_collateral = {rs(w['borrower_collateral_balance'])};",
            f"let borrower_debt = {rs(w['borrower_variable_debt'])};",
            f"let collateral_price = {rs(w['collateral_price_oracle_units'])};",
            f"let debt_price = {rs(w['debt_price_oracle_units'])};",
            f"let collateral_unit = {rs(w['collateral_unit'])};",
            f"let debt_unit = {rs(w['debt_unit'])};",
            f"let base_unit = {rs(w['oracle_base_unit'])};",
            f"let observed_debt = {rs(w['observed_debt_to_cover'])};",
            f"let observed_collateral = {rs(w['observed_collateral_to_liquidator'])};",
            "let reserve_collateral_base =",
            "    mul_div_floor(borrower_collateral, collateral_price, collateral_unit)?;",
            "let reserve_debt_base =",
            "    mul_div_ceil(borrower_debt, debt_price, debt_unit)?;",
            "let close_threshold = U256::from(2_000u64) * base_unit;",
            "let default_close =",
            "    health_factor > U256::from(FULL_CLOSE_HF_WAD)",
            "    && reserve_collateral_base >= close_threshold",
            "    && reserve_debt_base >= close_threshold;",
            "let max_debt = max_liquidatable_debt(LiquidationSizingInput {",
            "    health_factor_wad: health_factor,",
            "    total_debt_base_wad: total_debt_base,",
            "    reserve_debt_amount: borrower_debt,",
            "    reserve_debt_base_wad: reserve_debt_base,",
            "    reserve_collateral_base_wad: reserve_collateral_base,",
            "    debt_asset_price_base_wad: debt_price,",
            "    debt_asset_unit: debt_unit,",
            "    min_base_max_close_factor_threshold_wad: close_threshold,",
            "})?;",
            "if observed_debt > max_debt {",
            f'    return Err(format!("case {i}: historical debt exceeds recovered close-factor cap: observed={{}} cap={{}}", observed_debt, max_debt).into());',
            "}",
            "if observed_debt == max_debt {",
            "    if default_close { default_close_cap_matches += 1; }",
            "    else { full_close_cap_matches += 1; }",
            "}",
            "let available = calculate_available_collateral_to_liquidate(",
            "    AvailableCollateralInput {",
            "        collateral_price_base_wad: collateral_price,",
            "        collateral_asset_unit: collateral_unit,",
            "        debt_price_base_wad: debt_price,",
            "        debt_asset_unit: debt_unit,",
            "        debt_to_cover: observed_debt,",
            "        borrower_collateral_balance: borrower_collateral,",
            f"        liquidation_bonus_bps: {n(w['effective_liquidation_bonus_bps'])}u32,",
            f"        liquidation_protocol_fee_bps: {n(w['liquidation_protocol_fee_bps'])}u32,",
            "    },",
            ")?;",
            "if available.debt_to_liquidate != observed_debt {",
            f'    return Err(format!("case {i}: debt integer mismatch: observed={{}} recovered={{}}", observed_debt, available.debt_to_liquidate).into());',
            "}",
            "if available.collateral_to_liquidator != observed_collateral {",
            f'    return Err(format!("case {i}: collateral integer mismatch: observed={{}} recovered={{}}", observed_collateral, available.collateral_to_liquidator).into());',
            "}",
            f"let premium = percent_mul_ceil_unbounded(observed_debt, {n(w['flash_loan_premium_bps'])}u32)?;",
            f"let observed_callback_premium = {rs(w['observed_callback_flash_premium'])};",
            "if premium != observed_callback_premium {",
            f'    return Err(format!("case {i}: deployed callback flash premium mismatch: callback={{}} recovered={{}}", observed_callback_premium, premium).into());',
            "}",
            "deployed_callback_premium_checks += 1;",
            "cases += 1;",
            "exact_integer_checks += 4;",
            f'println!("AAVE_LIQUIDATION_MATRIX_PASS case={i} block={n(w["block_number"])} emode={n(w["user_emode_category"])} default_close={{}} observed_debt={{}} max_debt={{}} collateral={{}} protocol_fee={{}} premium={{}}", default_close, observed_debt, max_debt, available.collateral_to_liquidator, available.liquidation_protocol_fee_collateral, premium);',
            "}",
        ]
    lines += [
        "if cases != 16 || exact_integer_checks != 64 || deployed_callback_premium_checks != 16 {",
        '    return Err(format!("matrix count mismatch cases={} checks={} callback_premiums={}", cases, exact_integer_checks, deployed_callback_premium_checks).into());',
        "}",
        "if default_close_cap_matches == 0 {",
        '    return Err("no historical event exactly exercised the recovered default close-factor cap".into());',
        "}",
        "if full_close_cap_matches == 0 {",
        '    return Err("no historical event exactly exercised the recovered full close-factor cap".into());',
        "}",
        'println!("AAVE_LIQUIDATION_MATRIX_TOTAL cases={} exact_integer_checks={} deployed_callback_premium_checks={} default_close_cap_matches={} full_close_cap_matches={} unexplained_mismatches=0", cases, exact_integer_checks, deployed_callback_premium_checks, default_close_cap_matches, full_close_cap_matches);',
        "Ok(())",
        "}",
        "",
    ]
    return "\n".join(lines)


if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--witness-dir",type=Path,required=True)
    ap.add_argument("--multi",type=Path,required=True)
    ap.add_argument("--single",type=Path,required=True)
    ap.add_argument("--boundary",type=Path,required=True)
    ap.add_argument("--output",type=Path,required=True)
    args=ap.parse_args()
    expected=fixtures(args.multi,args.single,args.boundary)
    cases=load_witnesses(args.witness_dir,expected)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(generate(cases))
