#!/usr/bin/env python3
"""Generate an exact recovered AaveHotState account-risk parity executable.

This intentionally compares integer outputs without tolerance. It is a probe:
a mismatch must fail and be preserved, not normalized away.
"""
import argparse
import json
from pathlib import Path

from reserve_balance_witness import digest, PROVIDERS, SELECTORS


def q(value):
    return json.dumps(str(value))


def generate(witness):
    unsigned = {k: v for k, v in witness.items() if k != "attestation_sha256"}
    if digest(unsigned) != witness["attestation_sha256"]:
        raise ValueError("reserve witness attestation mismatch")
    if witness["providers"] != [p[0] for p in PROVIDERS]:
        raise ValueError("provider provenance mismatch")
    if witness["selectors"] != SELECTORS:
        raise ValueError("selector set mismatch")

    cases = []
    for case in witness["cases"]:
        users = [u for u in case["users"] if int(u["meta"]["e_mode_category"]) == 0]
        if users:
            cases.append((case, users))
    if len(cases) != 1 or len(cases[0][1]) != 13:
        raise ValueError("expected exactly 13 locked eMode-zero users in one case")

    case, users = cases[0]
    reserves = {int(r["reserve_id"]): r for r in case["reserves"]}
    expected_ids = sorted({
        int(p["reserve_id"])
        for user in users
        for p in user["positions"]
    })
    if sorted(reserves) != expected_ids:
        raise ValueError("reserve coverage mismatch")

    lines = [
        "use alloy::primitives::{Address, U256};",
        "use nqc_hot_state::{AaveHotState, AccountReservePosition, ReserveConfig, ReserveRuntime};",
        "use std::str::FromStr;",
        "type Error = Box<dyn std::error::Error>;",
        "fn addr(s: &str) -> Result<Address, Error> { Ok(Address::from_str(s)?) }",
        "fn uint(s: &str) -> Result<U256, Error> { Ok(U256::from_str(s)?) }",
        "fn main() -> Result<(), Error> {",
        "let mut state = AaveHotState::new();",
    ]

    for reserve_id in expected_ids:
        r = reserves[reserve_id]
        raw = int(r["configuration"])
        decimals = (raw >> 48) & 0xff
        liquidation_threshold = (raw >> 16) & 0xffff
        token_unit = 10 ** decimals
        lines += [
            "state.configure_reserve(",
            f"    addr({q(r['asset'])})?,",
            f"    ReserveConfig {{ reserve_id: {reserve_id}, token_unit: uint({q(token_unit)})?, liquidation_threshold_bps: {liquidation_threshold} }},",
            "    ReserveRuntime {",
            f"        price_usd_wad: uint({q(r['price_usd_wad'])})?,",
            f"        liquidity_index_ray: uint({q(r['liquidity_index_ray'])})?,",
            f"        variable_borrow_index_ray: uint({q(r['variable_borrow_index_ray'])})?,",
            f"        liquidity_rate_ray: uint({q(r['liquidity_rate_ray'])})?,",
            f"        variable_borrow_rate_ray: uint({q(r['variable_borrow_rate_ray'])})?,",
            f"        last_update_timestamp: {int(r['last_update_timestamp'])},",
            "    },",
            ")?;",
            f"state.configure_protocol_price(addr({q(r['asset'])})?, uint({q(r['price_oracle_units'])})?, uint({q(case['oracle_base_unit'])})?)?;",
        ]

    for user in users:
        conf = int(user["meta"]["user_configuration_raw"])
        for p in user["positions"]:
            rid = int(p["reserve_id"])
            collateral = bool((conf >> (2 * rid + 1)) & 1)
            lines += [
                "state.set_position(",
                f"    addr({q(user['user'])})?,",
                f"    addr({q(p['asset'])})?,",
                "    AccountReservePosition {",
                f"        scaled_atoken_balance: uint({q(p['scaled_atoken_balance'])})?,",
                f"        scaled_variable_debt: uint({q(p['scaled_variable_debt'])})?,",
                f"        collateral_enabled: {str(collateral).lower()},",
                "    },",
                ")?;",
            ]

    lines += [
        f"let timestamp: u64 = {int(case['timestamp'])};",
        f"let base_unit = uint({q(case['oracle_base_unit'])})?;",
        "let wad = U256::from(1_000_000_000_000_000_000u128);",
        "let mut mismatches = 0u64;",
        "let mut checks = 0u64;",
    ]

    for user in users:
        meta = user["meta"]
        lines += [
            "{",
            f"let user = addr({q(user['user'])})?;",
            "let protocol = state.account_protocol_risk_at(user, timestamp)?;",
            "let risk = state.account_risk_at(user, timestamp)?;",
            "let collateral_base = protocol.collateral_base;",
            "let debt_base = protocol.debt_base;",
            "let hf = protocol.health_factor_wad.unwrap_or(U256::MAX);",
            "assert_eq!(risk.health_factor_wad, protocol.health_factor_wad);",
            "assert_eq!(risk.collateral_usd_wad * base_unit / wad, collateral_base);",
            "assert_eq!(risk.debt_usd_wad * base_unit / wad, debt_base);",
            f"let expected_collateral = uint({q(meta['total_collateral_base'])})?;",
            f"let expected_debt = uint({q(meta['total_debt_base'])})?;",
            f"let expected_hf = uint({q(meta['health_factor_wad'])})?;",
            "checks += 3;",
            "if collateral_base != expected_collateral {",
            "  mismatches += 1;",
            '  println!("RISK_MISMATCH dimension=total_collateral_base user={} expected={} actual={}", user, expected_collateral, collateral_base);',
            "}",
            "if debt_base != expected_debt {",
            "  mismatches += 1;",
            '  println!("RISK_MISMATCH dimension=total_debt_base user={} expected={} actual={}", user, expected_debt, debt_base);',
            "}",
            "if hf != expected_hf {",
            "  mismatches += 1;",
            '  println!("RISK_MISMATCH dimension=health_factor_wad user={} expected={} actual={}", user, expected_hf, hf);',
            "}",
            'if collateral_base == expected_collateral && debt_base == expected_debt && hf == expected_hf { println!("ACCOUNT_RISK_PARITY_PASS user={}", user); }',
            "}",
        ]

    lines += [
        f'println!("ACCOUNT_RISK_TOTAL users={len(users)} checks={{}} mismatches={{}}", checks, mismatches);',
        'if mismatches != 0 { return Err(format!("exact Aave account-risk mismatches: {}", mismatches).into()); }',
        "Ok(())",
        "}",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("witness", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    data = json.loads(args.witness.read_text())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generate(data))
