#!/usr/bin/env python3
"""Generate exact V2 Sync replay parity executable."""
import argparse
import json
from pathlib import Path

from reserve_balance_witness import digest

def q(v):
    return json.dumps(str(v))

def generate(w):
    unsigned={k:v for k,v in w.items() if k!="attestation_sha256"}
    if digest(unsigned)!=w["attestation_sha256"]:
        raise ValueError("V2 Sync witness attestation mismatch")
    if w["providers"] != ["blastapi-public","mevblocker-rpc"]:
        raise ValueError("provider lock mismatch")
    if len(w["cases"]) != 2:
        raise ValueError("expected two fixed Sync cases")

    lines=[
      "use alloy::primitives::{Address, B256, U256};",
      "use nqc_state::{RethIpcConfig, RethIpcSource};",
      "use nqc_v2_state_reimplementation::{V2CanonicalReader, V2FactorySpec, V2SyncUpdate};",
      "use std::{env, io, str::FromStr};",
      "type Error = Box<dyn std::error::Error>;",
      "fn addr(s:&str)->Result<Address,Error>{ Ok(Address::from_str(s)?) }",
      "fn b256(s:&str)->Result<B256,Error>{ Ok(B256::from_str(s)?) }",
      "fn uint(v:u128)->U256{ U256::from(v) }",
      "#[tokio::main]",
      "async fn main()->Result<(),Error>{",
      'let upstream=env::var("NQC_PFT_UPSTREAM_ID")?;',
      'let source=RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;',
      "let reader=V2CanonicalReader::from_reth(&source,1).await?;",
      "let mut cases=0u64;",
      "let mut updates_total=0u64;",
    ]
    for case in w["cases"]:
        p=case["parent"]; t=case["target"]; pair=case["pair"]
        updates=",".join(
          "V2SyncUpdate{pair:addr("+q(pair)+")?,reserve0:uint("+str(int(log["reserve0"]))+"u128),reserve1:uint("+str(int(log["reserve1"]))+"u128)}"
          for log in case["sync_logs"]
        )
        before=p["state"]; after=t["state"]
        lines += [
          "{",
          f"let parent_anchor=source.canonical_block_at({int(p['number'])}).await?;",
          f"assert_eq!(parent_anchor.hash,b256({q(p['hash'])})?);",
          f"assert_eq!(parent_anchor.timestamp,{int(p['timestamp'])});",
          f"let target_anchor=source.canonical_block_at({int(t['number'])}).await?;",
          f"assert_eq!(target_anchor.hash,b256({q(t['hash'])})?);",
          f"assert_eq!(target_anchor.timestamp,{int(t['timestamp'])});",
          f"let pair_addresses=vec![addr({q(pair)})?];",
          f"let spec=V2FactorySpec{{factory:addr({q(case['factory'])})?,fee_bps:{int(case['fee_bps'])},max_pairs:1}};",
          "let parent=reader.read_pairs_at(spec,&pair_addresses,parent_anchor).await?;",
          "let target=reader.read_pairs_at(spec,&pair_addresses,target_anchor).await?;",
          "assert_eq!(parent.pairs.len(),1);",
          "assert_eq!(target.pairs.len(),1);",
          f"assert_eq!(parent.pairs[0].reserve0,uint({int(before['reserve0'])}u128));",
          f"assert_eq!(parent.pairs[0].reserve1,uint({int(before['reserve1'])}u128));",
          f"assert_eq!(parent.pairs[0].block_timestamp_last,{int(before['block_timestamp_last'])});",
          f"assert_eq!(target.pairs[0].reserve0,uint({int(after['reserve0'])}u128));",
          f"assert_eq!(target.pairs[0].reserve1,uint({int(after['reserve1'])}u128));",
          f"assert_eq!(target.pairs[0].block_timestamp_last,{int(after['block_timestamp_last'])});",
          f"let updates=vec![{updates}];",
          "let replayed=parent.replay_sync_block(target_anchor,&updates)?;",
          "assert_eq!(replayed.pairs,target.pairs);",
          "assert_eq!(replayed.snapshot_hash(),target.snapshot_hash());",
          "source.ensure_canonical(parent_anchor).await?;",
          "source.ensure_canonical(target_anchor).await?;",
          f"assert_eq!(updates.len(),{len(case['sync_logs'])});",
          "updates_total += updates.len() as u64;",
          "cases += 1;",
          'println!("V2_SYNC_PARITY_PASS upstream={} block={} logs={} snapshot={}",upstream,target_anchor.number,updates.len(),target.snapshot_hash());',
          "}",
        ]
    lines += [
      "assert_eq!(cases,2);",
      "assert!(updates_total >= 2);",
      'println!("V2_SYNC_TOTAL upstream={} cases={} updates={}",upstream,cases,updates_total);',
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
    data=json.loads(a.witness.read_text())
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(generate(data))
