#!/usr/bin/env python3
"""RMC015: 857 Aave D09 preselected debt accounts -> real post-anchor state.

Only original 26095351 D08/D09 risk cohort selects addresses. Aggregates all
857 (not 12) at 26095352 and 26102551 using deployed read-only Multicall3
and genuine Aave getUserAccountData() at two separately operated Ethereum RPCs.

It does NOT prove a historical NQC real-time alarm, liquidation episode,
builder inclusion, offered gas credit, or any captured net P&L.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import math
import re
from pathlib import Path

import rmc015_post_anchor_causal_sampler as source
from rmc016_probe_historical_rpc import PROVIDERS, rpc

MULTICALL = "0xca11bde05977b3631167028862be2a173976ca11"
AGGREGATE3 = "0x82ad56cb"
BATCH_SIZE = 20
WORD = 32
BLOCKS = (source.FIRST, source.LATER)
ABSOLUTE_MAX_ETH_CALL_GAS=30_000_000
U256_MAX=2**256-1
HEXBYTE=re.compile(r"0x(?:[a-fA-F0-9]{2})+\Z")
EXPECTED_BORROWERS=857


def need(ok,msg):
    if not ok:raise ValueError(msg)


def uint_word(x):
    need(type(x) is int and 0<=x<U256_MAX+1,"ABI uint256 overflow")
    return x.to_bytes(32,"big")


def decode_word(data,at,label):
    need(type(data) is bytes and type(at) is int and at>=0 and at%32==0
         and at+32<=len(data),label+" ABI word bounds")
    return int.from_bytes(data[at:at+32],"big")


def encode_one(addr):
    need(type(addr) is str and source.ADDR.fullmatch(addr) is not None,
         "invalid original D09 borrower address")
    payload=bytes.fromhex(source.GET_ACCOUNT_DATA[2:])+bytes.fromhex(addr[2:]).rjust(32,b"\x00")
    # (address target, bool allowFailure=false, bytes calldata)
    return (bytes.fromhex(source.POOL[2:]).rjust(32,b"\x00")+
            uint_word(0)+uint_word(96)+uint_word(len(payload))+
            payload+b"\x00"*((-len(payload))%32))


def encode_batch(addresses):
    need(type(addresses) is list and 1<=len(addresses)<=BATCH_SIZE,
         "invalid onchain batch size")
    encoded=[encode_one(addr) for addr in addresses]
    offsets=[]
    start=len(encoded)*32
    for item in encoded:
        offsets.append(uint_word(start))
        start+=len(item)
    # selector + abi.encode(Call3[]): arg offset 32 then dynamic array:
    # length, offsets relative to array tuple-table beginning, tuples.
    return AGGREGATE3 + (uint_word(32)+uint_word(len(addresses))+
                         b"".join(offsets)+b"".join(encoded)).hex()


def decode_batch(raw,n):
    need(type(raw) is str and HEXBYTE.fullmatch(raw) is not None,
         "Multicall3 returned invalid canonical ABI bytes")
    data=bytes.fromhex(raw[2:])
    need(len(data)%32==0 and len(data)<32+32+n*512,
         "oversized or misaligned Multicall3 ABI")
    array=decode_word(data,0,"result root offset")
    need(array==32,"Multicall3 results must have canonical array offset")
    count=decode_word(data,array,"result count")
    need(count==n and n<=BATCH_SIZE,"missing or extra result members")
    table=array+32
    need(table+n*32<=len(data),"result array offset table truncated")
    values=[]
    ends=[]
    for i in range(n):
        off=decode_word(data,table+i*32,"result tuple offset")
        begin=table+off
        need(off>=n*32 and off%32==0 and begin>=table+n*32,
             "malformed dynamic Result[] tuple offset")
        ok=decode_word(data,begin,"result success")
        offbytes=decode_word(data,begin+32,"result bytes pointer")
        need(ok==1 and offbytes==64,
             "Multicall3 Aave call failed or noncanonical success")
        payloadlen=decode_word(data,begin+64,"Aave response bytes size")
        need(payloadlen==192,"Aave returned not six uint256 words")
        payload_start=begin+96
        need(payload_start+192<=len(data),
             "Aave result truncated")
        position=source.account_data("0x"+data[payload_start:payload_start+192].hex())
        ends.append((begin,payload_start+192))
        values.append(position)
    # canonical ABI can't alias tuple payloads or add trailing attack data.
    need(all(ends[i][1]==ends[i+1][0] for i in range(n-1))
         and ends[0][0]==table+n*32 and ends[-1][1]==len(data),
         "noncanonical or overlapping Multicall3 results")
    return values


def all_preselected(summary,watchlist_blob):
    source.select(summary,watchlist_blob) # validate all 857, original SHA and anchor, no lookahead
    rows=[source.unique_json(line) for line in watchlist_blob.splitlines()]
    need(len(rows)==EXPECTED_BORROWERS,"incomplete source population")
    return rows


def checked_header(h,n):
    need(type(h) is dict and
         source.inthex(h.get("number"),"height")==n and
         type(h.get("hash")) is str and source.HASH.fullmatch(h["hash"]) is not None and
         type(h.get("parentHash")) is str and source.HASH.fullmatch(h["parentHash"]) is not None and
         type(h.get("stateRoot")) is str and source.HASH.fullmatch(h["stateRoot"]) is not None and
         source.inthex(h.get("timestamp"),"timestamp")>0,
         "block header not canonical")
    return {"hash":h["hash"],"parent_hash":h["parentHash"],
            "state_root":h["stateRoot"],"timestamp":source.inthex(h["timestamp"],"timestamp")}


def eth_call(contract, data, n, url, *, call=rpc):
    return call(url,"eth_call",[
        {"to":contract,"data":data,"gas":hex(ABSOLUTE_MAX_ETH_CALL_GAS)},hex(n)])


def observe(provider,rows,*,call=rpc):
    pid,operator,url=provider
    need(call(url,"eth_chainId",[])=="0x1","archive RPC is not Ethereum")
    anchor=checked_header(call(url,"eth_getBlockByNumber",[hex(source.ANCHOR),False]),source.ANCHOR)
    need(anchor["hash"]==source.ANCHOR_HASH,"source historical anchor reorg")
    chain={}
    for n in BLOCKS:
        x=checked_header(call(url,"eth_getBlockByNumber",[hex(n),False]),n)
        need(x["timestamp"]>anchor["timestamp"],"future block before fixed cohort")
        if n==source.FIRST:
            need(x["parent_hash"]==source.ANCHOR_HASH,
                 "future first block not child of source cohort anchor")
        chain[str(n)]=x
    for n in BLOCKS:
        code=call(url,"eth_getCode",[MULTICALL,hex(n)])
        need(type(code) is str and HEXBYTE.fullmatch(code) is not None and
             len(code)>=1000,"Multicall3 contract not deployed at historical block")
        chain[str(n)]["multicall_code_sha256"]=source.sha(bytes.fromhex(code[2:]))
    addresses=[x["account"] for x in rows]
    outcomes={}
    for n in BLOCKS:
        current=[]
        for begin in range(0,len(addresses),BATCH_SIZE):
            batch=addresses[begin:begin+BATCH_SIZE]
            answer=eth_call(MULTICALL,encode_batch(batch),n,url,call=call)
            current.extend(decode_batch(answer,len(batch)))
        need(len(current)==EXPECTED_BORROWERS,"Aave full risk cohort not conserved")
        # Do not silently drop failed calls or unavailable state; classify all 857.
        health={}
        counts={"BELOW_ONE_AT_ENDPOINT":0,"HEALTHY_AT_ENDPOINT":0,
                "NO_DEBT_AT_ENDPOINT":0}
        hf_buckets={"HF_1_TO_1_01":0,"HF_1_01_TO_1_05":0,
                    "HF_1_05_TO_1_20":0,"HF_1_20_AND_ABOVE":0}
        debt_sum={"BELOW_ONE_AT_ENDPOINT":0,"HEALTHY_AT_ENDPOINT":0}
        transitions={}
        for row,state in zip(rows,current):
            original_hf=int(row["health_factor_wad"])
            oldstatus="HEALTHY_AT_ANCHOR"
            if state["debt"]==0:
                status="NO_DEBT_AT_ENDPOINT"
            elif state["hf"]<source.WAD:
                status="BELOW_ONE_AT_ENDPOINT"
            else:
                status="HEALTHY_AT_ENDPOINT"
            counts[status]+=1
            if status in debt_sum:debt_sum[status]+=state["debt"]
            transitions[oldstatus+"__"+status]=transitions.get(oldstatus+"__"+status,0)+1
            if state["debt"]>0 and state["hf"]>=source.WAD:
                hf=state["hf"]
                bucket=("HF_1_TO_1_01" if hf<101*source.WAD//100
                        else "HF_1_01_TO_1_05" if hf<105*source.WAD//100
                        else "HF_1_05_TO_1_20" if hf<120*source.WAD//100
                        else "HF_1_20_AND_ABOVE")
                hf_buckets[bucket]+=1
        need(sum(counts.values())==EXPECTED_BORROWERS,
             "endpoint state partition does not conserve preselected universe")
        outcomes[str(n)]={
            "source_preselected_accounts":EXPECTED_BORROWERS,
            "end_snapshot_counts":counts,
            "end_snapshot_healthy_health_factor_buckets":hf_buckets,
            "source_healthy_to_endpoint_transition_counts":transitions,
            "end_snapshot_debt_base_units_by_status":{
                key:str(val) for key,val in debt_sum.items()
            },
            "real_observed_sublayer_aggregate_only":True
        }
    return {"operator":operator,"provider_id":pid,"source_anchor":anchor,
            "future_headers":chain,"future_population_aggregates":outcomes}


def assess(summary,watchlist_blob,*,call=rpc,providers=None):
    rows=all_preselected(summary,watchlist_blob)
    providers=providers or [x for x in PROVIDERS if x[0] in ("drpc","blast")]
    need(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"]
         and providers[0][1]!=providers[1][1] and providers[0][2]!=providers[1][2],
         "two independent RPC operators and endpoints mandatory")
    a,b=[observe(x,rows,call=call) for x in providers]
    need(a["source_anchor"]==b["source_anchor"] and
         a["future_headers"]==b["future_headers"] and
         a["future_population_aggregates"]==b["future_population_aggregates"],
         "dual-operator actual Multicall3 population and block mismatch")
    report={
      "schema_version":1,
      "status":"RMC015_857_FIXED_COHORT_MULTICALL_FUTURE_STATE_PASS_NOT_CAPTURE",
      "source_anchor_block":source.ANCHOR,
      "source_anchor_hash":source.ANCHOR_HASH,
      "source_frontier_status":summary["status"],
      "source_watchlist_sha256":summary["watchlist_commitment_sha256"],
      "source_frontier_authority_commitment_sha256":summary["authority_commitment_sha256"],
      "borrowers_fixed_using_only_anchor_data":EXPECTED_BORROWERS,
      "future_block_numbers":list(BLOCKS),
      "aave_pool":source.POOL,
      "multicall3_deployed_address":MULTICALL,
      "onchain_batch_size":BATCH_SIZE,
      "independently_agreeing_archive_rpc_operators":2,
      "future_full_population_observations":a["future_population_aggregates"],
      "source_anchor_and_future_multicall_code":a["future_headers"],
      "three_account_states_entire_time_window_reconstructed":False,
      "account_state_endpoints_only_not_continuous_episodes":True,
      "lookahead_used_to_select_cohort":False,
      "competitor_winning_transactions_used_to_select_cohort":False,
      "initial_cohort_was_healthy":True,
      "sample_representative_of_all_protocol_accounts":False,
      "early_signal_captured_by_nqc_live":False,
      "winner_inclusion_and_builder_auction_measured":False,
      "nqc_nonrecourse_gas_or_external_capital_approved":False,
      "route_executable_or_liquidation_bonus_proven":False,
      "nqc_realized_net_profit_usd":"0",
      "nqc_monthly_income_15k_55k_predicted":False,
      "rmc015_terminal_closed":False,
      "real_market_census_closed":False,
      "non_claims":[
          "THE_COHORT_WAS_ECONOMICALLY_MATERIAL_AT_THE_ANCHOR_NOT_YET_LIQUIDATABLE",
          "A_SNAPSHOT_HF_BELOW_ONE_IS_NOT_AN_OBSERVED_NQC_REALTIME_DETECTION",
          "NO_FUTURE_STATE_USED_IN_ORIGINAL_WATCHLIST_SELECTION",
          "NO_CONTINUOUS_TEMPORAL_EPISODE_OR_COMPETITOR_INCLUSION_REPLAY",
          "NO_COMPETITIVE_EDGE_OR_PROFIT_ESTIMATE_FROM_ENDPOINT_COUNTS",
          "NO_SPONSOR_OR_CAPITAL_FUNDING_CLAIM",
      ],
    }
    report["report_sha256"]=source.sha(source.canonical(report))
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-summary",type=Path,required=True)
    p.add_argument("--watchlist-jsonl",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    need(not a.out.exists(),"append-only report required")
    r=assess(source.unique_json(a.source_summary.read_bytes()),
             a.watchlist_jsonl.read_bytes())
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(source.canonical(r))
    print(r["status"],
          "post+1",r["future_full_population_observations"][str(source.FIRST)]["end_snapshot_counts"],
          "post+7200",r["future_full_population_observations"][str(source.LATER)]["end_snapshot_counts"],
          "NQC-real-net-USD",r["nqc_realized_net_profit_usd"],
          "CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
