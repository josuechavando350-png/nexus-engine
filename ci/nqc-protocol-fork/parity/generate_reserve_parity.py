#!/usr/bin/env python3
"""Generate an executable test of recovered code, not a replacement implementation."""
import argparse
import json
from pathlib import Path

from reserve_balance_witness import digest, PROVIDERS, LOCK, LOCK_SHA, SELECTORS, active_ids


def generate(w):
    unsigned = {k: v for k, v in w.items() if k != "attestation_sha256"}
    if digest(unsigned) != w["attestation_sha256"]:
        raise ValueError("witness attestation mismatch")
    if w["providers"] != [p[0] for p in PROVIDERS] or len(w["cases"]) != 2:
        raise ValueError("witness coverage mismatch")
    if w["selectors"] != SELECTORS:
        raise ValueError("ABI selector mismatch")
    locked = json.loads(LOCK.read_text())
    if w["pool"] != locked["pool"] or w["locked_user_meta_sha256"] != LOCK_SHA:
        raise ValueError("witness provenance mismatch")
    for case, expected in zip(w["cases"], locked["cases"], strict=True):
        if any(case[k] != expected[k] for k in ("case_id", "block_hash", "block_number")):
            raise ValueError("historical anchor mismatch")
        if {u["user"]: u["meta"] for u in case["users"]} != expected["canonical_users"]:
            raise ValueError("locked borrower coverage mismatch")
        if len(case["users"]) != len(expected["canonical_users"]):
            raise ValueError("duplicate borrower")
        required = sorted({i for u in case["users"] for i in active_ids(u["meta"]["user_configuration_raw"])})
        if [r["reserve_id"] for r in case["reserves"]] != required:
            raise ValueError("active reserve coverage mismatch")
        assets_by_id = {r["reserve_id"]: r["asset"] for r in case["reserves"]}
        for user in case["users"]:
            ids = active_ids(user["meta"]["user_configuration_raw"])
            if [(p["reserve_id"], p["asset"]) for p in user["positions"]] != [(i, assets_by_id[i]) for i in ids]:
                raise ValueError("active position coverage mismatch")
    lines = [
        "use alloy::primitives::{Address, B256, U256};",
        "use nqc_aave_market::AaveMarketBootstrap;",
        "use nqc_aave_reader::{AaveLocalReader, ReserveReadTarget};",
        "use nqc_aave_sync::RefreshRequest;",
        "use nqc_state::{RethIpcConfig, RethIpcSource};",
        "use std::{env, str::FromStr};",
        "type Error = Box<dyn std::error::Error>;",
        "fn addr(s: &str) -> Result<Address, Error> { Ok(Address::from_str(s)?) }",
        "fn uint(s: &str) -> Result<U256, Error> { Ok(U256::from_str(s)?) }",
        "#[tokio::main]",
        "async fn main() -> Result<(), Error> {",
        'let upstream = env::var("NQC_PFT_UPSTREAM_ID")?;',
        'let source = RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;',
        f'let pool = addr({json.dumps(w["pool"])})?;',
        "let bootstrap = AaveMarketBootstrap::from_reth(&source, pool, 1).await?;",
        "let mut reserve_checks = 0u64; let mut position_checks = 0u64; let mut user_checks = 0u64;",
    ]
    for signature, selector in SELECTORS.items():
        byte_values = ",".join(str(v) for v in bytes.fromhex(selector[2:]))
        lines.append(f'assert_eq!(&alloy::primitives::keccak256({json.dumps(signature)}.as_bytes()).as_slice()[..4], &[{byte_values}]);')
    expected_reserves = expected_positions = expected_users = 0
    for case in w["cases"]:
        lines += [
            "{",
            f'let anchor = source.canonical_block_at({case["block_number"]}).await?;',
            f'assert_eq!(anchor.hash, B256::from_str({json.dumps(case["block_hash"])})?);',
            f'assert_eq!(anchor.timestamp, {case["timestamp"]});',
            'println!("BOOTSTRAP_BEGIN upstream={} block={}", upstream, anchor.number);',
            "let market = bootstrap.bootstrap_at(anchor).await?;",
            "assert_eq!(market.anchor, anchor);",
            f'assert_eq!(market.addresses_provider, addr({json.dumps(case["addresses_provider"])})?);',
            f'assert_eq!(market.price_oracle, addr({json.dumps(case["price_oracle"])})?);',
            f'assert_eq!(market.oracle_base_unit, uint({json.dumps(case["oracle_base_unit"])})?);',
            "let mut reader = AaveLocalReader::from_reth(&source, pool, 1).await?;",
            "for r in &market.reserves { reader.register_reserve(ReserveReadTarget { asset:r.asset, reserve_id:r.reserve_id, a_token:r.a_token, variable_debt_token:r.variable_debt_token })?; }",
        ]
        for r in case["reserves"]:
            expected_reserves += 1
            raw = int(r["configuration"])
            lines += ["{", f'let r = market.reserve(addr({json.dumps(r["asset"])})?).ok_or("missing expected reserve")?;',
                      f'assert_eq!(r.reserve_id, {r["reserve_id"]});',
                      f'assert_eq!(r.configuration.0, uint({json.dumps(r["configuration"])})?);']
            for key in ("a_token", "variable_debt_token"):
                lines.append(f'assert_eq!(r.{key}, addr({json.dumps(r[key])})?);')
            for key in ("liquidity_index_ray", "variable_borrow_index_ray", "liquidity_rate_ray", "variable_borrow_rate_ray", "price_oracle_units", "price_usd_wad"):
                lines.append(f'assert_eq!(r.{key}, uint({json.dumps(r[key])})?, "{key}");')
            for key in ("last_update_timestamp", "liquidation_grace_period_until"):
                lines.append(f'assert_eq!(r.{key}, {r[key]});')
            lines += [f'assert_eq!(r.liquidation_bonus_bps, {(raw >> 32) & 65535});',
                      f'assert_eq!(r.liquidation_protocol_fee_bps, {(raw >> 152) & 65535});',
                      f'assert_eq!(r.flash_loan_enabled, {str(bool((raw >> 63) & 1)).lower()});',
                      'reserve_checks += 1;',
                      'println!("RESERVE_PARITY_PASS upstream={} block={} id={}", upstream, anchor.number, r.reserve_id);', "}"]
        for user in case["users"]:
            expected_users += 1
            meta = user["meta"]
            assets = ",".join(f'addr({json.dumps(p["asset"])})?' for p in user["positions"])
            lines += ["{", f'let user = addr({json.dumps(user["user"])})?;',
                      f'let assets = vec![{assets}];',
                      "let meta = reader.read_user_meta_at(user, anchor).await?;",
                      f'assert_eq!(meta.user_configuration.0, uint({json.dumps(meta["user_configuration_raw"])})?);',
                      f'assert_eq!(meta.e_mode_category, {meta["e_mode_category"]});',
                      "assert_eq!(reader.assets_for_configuration(meta.user_configuration)?, assets);",
                      "let request = RefreshRequest { user, assets, refresh_user_configuration:true, refresh_emode:true };",
                      "let result = reader.read_refresh_at(&request, anchor).await?;",
                      "assert_eq!(result.anchor, anchor); assert_eq!(result.snapshot.user, user);",
                      "assert_eq!(result.snapshot.user_configuration, meta.user_configuration);",
                      "assert_eq!(result.snapshot.e_mode_category, meta.e_mode_category);",
                      f'assert_eq!(result.snapshot.reserves.len(), {len(user["positions"])});']
            for i, pos in enumerate(user["positions"]):
                expected_positions += 1
                lines += [f'let p = &result.snapshot.reserves[{i}];',
                          f'assert_eq!(p.asset, addr({json.dumps(pos["asset"])})?);',
                          f'assert_eq!(p.reserve_id, {pos["reserve_id"]});',
                          f'assert_eq!(p.scaled_atoken_balance, uint({json.dumps(pos["scaled_atoken_balance"])})?);',
                          f'assert_eq!(p.scaled_variable_debt, uint({json.dumps(pos["scaled_variable_debt"])})?);',
                          'position_checks += 1;']
            lines += ['user_checks += 1;', 'println!("BALANCE_PARITY_PASS upstream={} block={} user={}", upstream, anchor.number, user);', "}"]
        lines += ["source.ensure_canonical(anchor).await?;", "}"]
    if expected_users != 15 or not expected_positions or not expected_reserves:
        raise ValueError("incomplete borrower/reserve coverage")
    lines += [f'assert_eq!(reserve_checks, {expected_reserves});',
              f'assert_eq!(position_checks, {expected_positions});',
              f'assert_eq!(user_checks, {expected_users});',
              'println!("RESERVE_BALANCE_TOTAL upstream={} reserves={} positions={} users={}", upstream, reserve_checks, position_checks, user_checks);',
              "Ok(())", "}", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("witness", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generate(json.loads(args.witness.read_text())))
