#!/usr/bin/env python3
"""Generate V2 real-orphan invalidation and replay-refresh parity executable."""
import argparse
import json
from pathlib import Path

from reserve_balance_witness import digest


def q(v):
    return json.dumps(str(v))


def generate(w):
    unsigned={k:v for k,v in w.items() if k!="attestation_sha256"}
    if digest(unsigned)!=w["attestation_sha256"]:
        raise ValueError("real-reorg witness attestation mismatch")
    if w["providers"]!=["blastapi-public","mevblocker-rpc"]:
        raise ValueError("provider lock mismatch")
    if w["observed_real_reorg_depth"]!=1:
        raise ValueError("expected real shallow orphan")
    orphan=w["orphan"]; canonical=w["canonical"]; state=w["v2"]
    if orphan["number"]!=canonical["number"] or orphan["hash"]==canonical["hash"]:
        raise ValueError("invalid competing block identity")
    if orphan["parent_hash"]!=w["canonical_parent"]["hash"]:
        raise ValueError("locked orphan is not a real shallow competing child")

    base_fee = (
        "None" if canonical["base_fee_per_gas"] is None
        else f"Some({int(canonical['base_fee_per_gas'])}u64)"
    )
    orphan_base_fee = (
        "None" if orphan["base_fee_per_gas"] is None
        else f"Some({int(orphan['base_fee_per_gas'])}u64)"
    )
    return f'''use alloy::primitives::{{Address, B256, U256}};
use nqc_replay::{{hash_artifact, ReplayContext, ReplayError, StrategyKind}};
use nqc_state::{{CanonicalBlock, RethIpcConfig, RethIpcSource, StateError}};
use nqc_v2_state_reimplementation::{{V2CanonicalReader, V2FactorySpec}};
use std::{{env, str::FromStr}};

type Error=Box<dyn std::error::Error>;
fn addr(s:&str)->Result<Address,Error>{{Ok(Address::from_str(s)?)}}

#[tokio::main]
async fn main()->Result<(),Error>{{
    let upstream=env::var("NQC_PFT_UPSTREAM_ID")?;
    let source=RethIpcSource::connect(&RethIpcConfig::new(env::var("NQC_PFT_IPC_PATH")?)).await?;
    let canonical=CanonicalBlock{{
        number:{canonical["number"]}u64,
        hash:B256::from_str({q(canonical["hash"])})?,
        timestamp:{canonical["timestamp"]}u64,
        base_fee_per_gas:{base_fee},
    }};
    let orphan=CanonicalBlock{{
        number:{orphan["number"]}u64,
        hash:B256::from_str({q(orphan["hash"])})?,
        timestamp:{orphan["timestamp"]}u64,
        base_fee_per_gas:{orphan_base_fee},
    }};

    match source.ensure_canonical(orphan).await {{
        Err(StateError::CanonicalHashMismatch{{block_number,expected,actual}}) => {{
            assert_eq!(block_number, orphan.number);
            assert_eq!(expected, orphan.hash);
            assert_eq!(actual, canonical.hash);
        }}
        other => return Err(format!("real orphan was not rejected: {{other:?}}").into()),
    }}

    let reader=V2CanonicalReader::from_reth(&source,1).await?;
    let snapshot=reader.read_pairs_at(
        V2FactorySpec{{
            factory:addr({q(state["factory"])})?,
            fee_bps:{state["fee_bps"]}u32,
            max_pairs:1,
        }},
        &[addr({q(state["pair"])})?],
        canonical,
    ).await?;
    assert_eq!(snapshot.anchor,canonical);
    assert_eq!(snapshot.pairs.len(),1);
    let pair=&snapshot.pairs[0];
    assert_eq!(pair.pair,addr({q(state["pair"])})?);
    assert_eq!(pair.token0,addr({q(state["token0"])})?);
    assert_eq!(pair.token1,addr({q(state["token1"])})?);
    assert_eq!(pair.reserve0,U256::from({state["reserve0"]}u128));
    assert_eq!(pair.reserve1,U256::from({state["reserve1"]}u128));
    assert_eq!(pair.block_timestamp_last,{state["block_timestamp_last"]}u32);

    let subject=pair.pair;
    let evidence=hash_artifact(format!("{{}}:{{}}:{{}}",orphan.hash,canonical.hash,snapshot.snapshot_hash()));
    let context=ReplayContext{{
        chain_id:1,
        anchor:orphan,
        target_block:orphan.number+1,
        strategy:StrategyKind::DexArbitrage,
        subject,
        market_snapshot_hash:evidence,
        state_snapshot_hash:evidence,
        execution_plan_hash:evidence,
        transaction_intent_hash:evidence,
        simulation_environment_hash:evidence,
        simulation_result_hash:evidence,
        settlement_result_hash:evidence,
        edge_assessment_hash:evidence,
        fee_envelope_hash:evidence,
        risk_policy_hash:evidence,
    }};
    let capsule=context.seal();
    match capsule.require_anchor(canonical) {{
        Err(ReplayError::AnchorMismatch{{expected,actual}}) => {{
            assert_eq!(expected,orphan);
            assert_eq!(actual,canonical);
        }}
        other => return Err(format!("orphan replay capsule was not invalidated: {{other:?}}").into()),
    }}

    source.ensure_canonical(canonical).await?;
    println!(
        "V2_REAL_REORG_INVALIDATION_PASS upstream={{}} height={{}} orphan={{}} canonical={{}} reserve0={{}} reserve1={{}}",
        upstream,canonical.number,orphan.hash,canonical.hash,pair.reserve0,pair.reserve1
    );
    println!("V2_REAL_REORG_TOTAL upstream={{}} real_orphan_checks=1 canonical_refresh_checks=1 replay_invalidation_checks=1",upstream);
    Ok(())
}}
'''


if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("witness",type=Path)
    ap.add_argument("output",type=Path)
    a=ap.parse_args()
    data=json.loads(a.witness.read_text())
    a.output.parent.mkdir(parents=True,exist_ok=True)
    a.output.write_text(generate(data))
