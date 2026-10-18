#!/usr/bin/env python3
"""Generate full recovered Aave account-risk parity, including eMode."""
import argparse, hashlib, json
from pathlib import Path

EXPECTED_WITNESS_SHA256 = "16a4260977fa7784fd5b1282de8eee71710fdb49ca171b42e99592e8cf870441"

def q(v):
    return json.dumps(str(v))

def generate(path: Path):
    raw=path.read_bytes()
    if hashlib.sha256(raw).hexdigest()!=EXPECTED_WITNESS_SHA256:
        raise ValueError("locked Aave user-meta witness digest mismatch")
    w=json.loads(raw)
    if w["physical_checkpoint"]!="2b640ccdeadeb8bf7b0ffc0e07ce861305cf11b9":
        raise ValueError("physical checkpoint mismatch")
    if w["pool"].lower()!="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2":
        raise ValueError("pool mismatch")
    total=sum(len(c["canonical_users"]) for c in w["cases"])
    emode=sum(1 for c in w["cases"] for u in c["canonical_users"].values() if int(u["e_mode_category"])!=0)
    if total!=15 or emode<2:
        raise ValueError("expected 15 users including locked eMode coverage")

    lines=[
      "use alloy::primitives::{Address, B256, U256};",
      "use nqc_aave_events::AaveEventDecoder;",
      "use nqc_aave_market::AaveMarketBootstrap;",
      "use nqc_aave_reader::AaveLocalReader;",
      "use nqc_aave_sync::RefreshRequest;",
      "use nqc_hot_state::AaveHotState;",
      "use nqc_state::{RethIpcConfig, RethIpcSource};",
      "use std::{env, str::FromStr};",
      "type Error=Box<dyn std::error::Error>;",
      "fn addr(s:&str)->Result<Address,Error>{Ok(Address::from_str(s)?)}",
      "fn uint(s:&str)->Result<U256,Error>{Ok(U256::from_str(s)?)}",
      "#[tokio::main]",
      "async fn main()->Result<(),Error>{",
      'let upstream=env::var("NQC_PFT_UPSTREAM_ID")?;',
      'let source=RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;',
      f"let pool=addr({q(w['pool'])})?;",
      "let mut user_checks=0u64;",
      "let mut integer_checks=0u64;",
      "let mut emode_users=0u64;",
    ]
    for case in w["cases"]:
        lines += [
          "{",
          f"let anchor=source.canonical_block_at({int(case['block_number'])}).await?;",
          f"assert_eq!(anchor.hash,B256::from_str({q(case['block_hash'])})?);",
          "let bootstrap=AaveMarketBootstrap::from_reth(&source,pool,1).await?;",
          "let market=bootstrap.bootstrap_at(anchor).await?;",
          "let mut reader=AaveLocalReader::from_reth(&source,pool,1).await?;",
          "let mut decoder=AaveEventDecoder::new(pool)?;",
          "let mut hot=AaveHotState::new();",
          "market.apply(&mut hot,&mut reader,&mut decoder)?;",
        ]
        for user,meta in sorted(case["canonical_users"].items()):
            lines += [
              "{",
              f"let user=addr({q(user)})?;",
              "let observed_meta=reader.read_user_meta_at(user,anchor).await?;",
              f"assert_eq!(observed_meta.user_configuration.0,uint({q(meta['user_configuration_raw'])})?);",
              f"assert_eq!(observed_meta.e_mode_category,{int(meta['e_mode_category'])});",
              "let assets=reader.assets_for_configuration(observed_meta.user_configuration)?;",
              "let request=RefreshRequest{user,assets,refresh_user_configuration:true,refresh_emode:true};",
              "let snapshot=reader.read_refresh_at(&request,anchor).await?;",
              "snapshot.snapshot.apply(&mut hot)?;",
              "let risk=hot.account_protocol_risk_at(user,anchor.timestamp)?;",
              f"let expected_collateral=uint({q(meta['total_collateral_base'])})?;",
              f"let expected_debt=uint({q(meta['total_debt_base'])})?;",
              f"let expected_threshold=uint({q(meta['current_liquidation_threshold_bps'])})?;",
              f"let expected_hf=uint({q(meta['health_factor_wad'])})?;",
              "let actual_hf=risk.health_factor_wad.unwrap_or(U256::MAX);",
              "assert_eq!(risk.collateral_base,expected_collateral);",
              "assert_eq!(risk.debt_base,expected_debt);",
              "assert_eq!(risk.average_liquidation_threshold_bps,expected_threshold);",
              "assert_eq!(actual_hf,expected_hf);",
              f"if {int(meta['e_mode_category'])}u8 != 0 {{ emode_users += 1; }}",
              "user_checks += 1;",
              "integer_checks += 4;",
              'println!("FULL_ACCOUNT_RISK_PARITY_PASS upstream={} block={} user={} emode={}",upstream,anchor.number,user,observed_meta.e_mode_category);',
              "}",
            ]
        lines += ["source.ensure_canonical(anchor).await?;","}"]
    lines += [
      "assert_eq!(user_checks,15);",
      "assert_eq!(integer_checks,60);",
      "assert!(emode_users>=2);",
      'println!("FULL_ACCOUNT_RISK_TOTAL upstream={} users={} integer_checks={} emode_users={}",upstream,user_checks,integer_checks,emode_users);',
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
