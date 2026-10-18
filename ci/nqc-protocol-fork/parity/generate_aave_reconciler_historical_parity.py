#!/usr/bin/env python3
"""Generate historical Aave reconciler parity from the locked canonical witness."""
import argparse
import hashlib
import json
from pathlib import Path

EXPECTED_WITNESS_SHA256="16a4260977fa7784fd5b1282de8eee71710fdb49ca171b42e99592e8cf870441"
REAL_ORPHAN_HEIGHT=10_500_011
REAL_ORPHAN_HASH="0xb4e222da7f14708b71c9cf64a68e40017e5b49870d840d343412a5f899474f67"
REAL_CANONICAL_HASH="0xa1f5eb25631c2d47d91071fb0c6ff7d925a4a45e07fc1d3fe47d7a268d5ff0c1"


def q(v):
    return json.dumps(str(v))


def uint(v):
    return f'U256::from_str({q(v)})?'


def generate(path: Path):
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=EXPECTED_WITNESS_SHA256:
        raise ValueError("locked Aave witness digest mismatch")
    w=json.loads(raw)
    if w["physical_checkpoint"]!="2b640ccdeadeb8bf7b0ffc0e07ce861305cf11b9":
        raise ValueError("physical checkpoint mismatch")
    if w["pool"].lower()!="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2":
        raise ValueError("pool mismatch")
    if sum(len(c["canonical_users"]) for c in w["cases"])!=15:
        raise ValueError("expected 15 locked users")

    lines=[
      "use alloy::primitives::{Address, B256, U256};",
      "use nqc_aave_reconciler_reimplementation::AaveCanonicalReconciler;",
      "use nqc_core::{ray, wad};",
      "use nqc_hot_state::{AaveHotState, AccountReservePosition, ReserveConfig, ReserveRuntime};",
      "use nqc_state::{CanonicalBlock, RethIpcConfig, RethIpcSource, StateError};",
      "use std::{env, str::FromStr};",
      "type Error=Box<dyn std::error::Error>;",
      "fn addr(s:&str)->Result<Address,Error>{Ok(Address::from_str(s)?)}",
      "#[tokio::main]",
      "async fn main()->Result<(),Error>{",
      'let upstream=env::var("NQC_PFT_UPSTREAM_ID")?;',
      'let source=RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;',
      f"let old_canonical=source.canonical_block_at({REAL_ORPHAN_HEIGHT}).await?;",
      f"assert_eq!(old_canonical.hash,B256::from_str({q(REAL_CANONICAL_HASH)})?);",
      "let real_orphan=CanonicalBlock{",
      f"    number:{REAL_ORPHAN_HEIGHT},",
      f"    hash:B256::from_str({q(REAL_ORPHAN_HASH)})?,",
      "    timestamp:old_canonical.timestamp,",
      "    base_fee_per_gas:old_canonical.base_fee_per_gas,",
      "};",
      "match source.ensure_canonical(real_orphan).await {",
      "    Err(StateError::CanonicalHashMismatch{block_number,expected,actual}) => {",
      f"        assert_eq!(block_number,{REAL_ORPHAN_HEIGHT});",
      "        assert_eq!(expected,real_orphan.hash);",
      "        assert_eq!(actual,old_canonical.hash);",
      "    }",
      '    other => return Err(format!("real historical orphan was not rejected: {other:?}").into()),',
      "}",
      f"let pool=addr({q(w['pool'])})?;",
      "let mut reconciled_users=0u64;",
      "let mut exact_integer_checks=0u64;",
      "let mut canonical_rebuilds=0u64;",
    ]

    for case_index,case in enumerate(w["cases"]):
        users=sorted(case["canonical_users"].items())
        lines += [
          "{",
          f"let anchor=source.canonical_block_at({int(case['block_number'])}).await?;",
          f"assert_eq!(anchor.hash,B256::from_str({q(case['block_hash'])})?);",
          "let mut reconciler=AaveCanonicalReconciler::from_reth(&source,pool,1).await?;",
        ]
        for user,_ in users:
            lines += [f"assert!(reconciler.track_user(addr({q(user)})?)?);"]
        lines += [
          "let fake_asset=Address::repeat_byte(0xfe);",
          "let fake_user=Address::repeat_byte(0xfd);",
          "let mut current=AaveHotState::new();",
          "current.configure_reserve(",
          "    fake_asset,",
          "    ReserveConfig{reserve_id:127,token_unit:wad(),liquidation_threshold_bps:5_000},",
          "    ReserveRuntime{",
          "        price_usd_wad:wad(),",
          "        liquidity_index_ray:ray(),",
          "        variable_borrow_index_ray:ray(),",
          "        liquidity_rate_ray:U256::ZERO,",
          "        variable_borrow_rate_ray:U256::ZERO,",
          "        last_update_timestamp:anchor.timestamp,",
          "    },",
          ")?;",
          "current.set_position(",
          "    fake_user,",
          "    fake_asset,",
          "    AccountReservePosition{scaled_atoken_balance:wad(),scaled_variable_debt:wad(),collateral_enabled:true},",
          ")?;",
          "assert_eq!(current.tracked_reserves(),1);",
          "assert_eq!(current.tracked_accounts(),1);",
          "let report=reconciler.reconcile_at(&mut current,anchor).await?;",
          f"assert_eq!(report.tracked_users,{len(users)});",
          "assert_eq!(current.tracked_reserves(),report.market_reserves);",
          "assert!(current.account_snapshot_at(fake_user,anchor.timestamp)?.is_none());",
          "canonical_rebuilds += 1;",
        ]
        for user,meta in users:
            lines += [
              "{",
              f"let user=addr({q(user)})?;",
              "let snapshot=current.account_snapshot_at(user,anchor.timestamp)?",
              '    .ok_or_else(|| std::io::Error::other("reconciler omitted tracked user"))?;',
              f"assert_eq!(snapshot.e_mode_category,{int(meta['e_mode_category'])}u8);",
              "let risk=current.account_protocol_risk_at(user,anchor.timestamp)?;",
              f"let expected_collateral={uint(meta['total_collateral_base'])};",
              f"let expected_debt={uint(meta['total_debt_base'])};",
              f"let expected_threshold={uint(meta['current_liquidation_threshold_bps'])};",
              f"let expected_hf={uint(meta['health_factor_wad'])};",
              "let actual_hf=risk.health_factor_wad.unwrap_or(U256::MAX);",
              "assert_eq!(risk.collateral_base,expected_collateral);",
              "assert_eq!(risk.debt_base,expected_debt);",
              "assert_eq!(risk.average_liquidation_threshold_bps,expected_threshold);",
              "assert_eq!(actual_hf,expected_hf);",
              "reconciled_users += 1;",
              "exact_integer_checks += 4;",
              'println!("AAVE_RECONCILER_HISTORICAL_USER_PASS upstream={} block={} user={} emode={}",upstream,anchor.number,user,snapshot.e_mode_category);',
              "}",
            ]
        lines += [
          "source.ensure_canonical(anchor).await?;",
          f'println!("AAVE_RECONCILER_HISTORICAL_BLOCK_PASS upstream={{}} block={{}} users={len(users)} reserves={{}} market_hash={{}}",upstream,anchor.number,report.market_reserves,report.market_snapshot_hash);',
          "}",
        ]

    lines += [
      "assert_eq!(reconciled_users,15);",
      "assert_eq!(exact_integer_checks,60);",
      f"assert_eq!(canonical_rebuilds,{len(w['cases'])});",
      'println!("AAVE_RECONCILER_HISTORICAL_TOTAL upstream={} real_orphan_rejections=1 canonical_rebuilds={} users={} exact_integer_checks={}",upstream,canonical_rebuilds,reconciled_users,exact_integer_checks);',
      "Ok(())",
      "}",
      "",
    ]
    return "\n".join(lines)


if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("witness",type=Path)
    ap.add_argument("output",type=Path)
    a=ap.parse_args()
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(generate(a.witness))
