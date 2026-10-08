#!/usr/bin/env python3
"""RMC-015: genuinely post-selection Aave risk probe, no hindsight membership.

Read only. The original Aave D09 snapshot at anchor block 26095351 fixes a
watchlist of 857 healthy material borrowers. Select the cohort ONLY from
that snapshot, then query later blocks. These historical queries performed
today are NOT archived real-time Nexus signals or ex-ante capture evidence.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
from rmc016_probe_historical_rpc import PROVIDERS, rpc

ANCHOR = 26095351
ANCHOR_HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"
FIRST = ANCHOR + 1
LATER = ANCHOR + 7200
POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
GET_ACCOUNT_DATA = "0xbf92857c"
WAD = 10**18
NEAR_COUNT=6
CONTROL_COUNT=6
UINT=re.compile(r"(?:0|[1-9][0-9]*)\Z")
ADDR=re.compile(r"0x[0-9a-f]{40}\Z")
HASH=re.compile(r"0x[0-9a-f]{64}\Z")
WORD6=re.compile(r"0x[0-9a-fA-F]{384}\Z")
HEXQ=re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")


def need(ok,msg):
    if not ok:raise ValueError(msg)


def canonical(d):
    return (json.dumps(d,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def sha(b):
    return hashlib.sha256(b).hexdigest()


def unique_json(raw):
    def no_dupes(pairs):
        d={}
        for k,v in pairs:
            need(k not in d,"duplicate JSON key")
            d[k]=v
        return d
    return json.loads(raw,object_pairs_hook=no_dupes)


def uint(v,name):
    need(type(v) is str and UINT.fullmatch(v) is not None,name+": noncanonical uint")
    n=int(v)
    need(0<=n<2**256,name+": not uint256")
    return n


def select(source_summary,watchlist_blob):
    need(type(source_summary) is dict and
         source_summary.get("status")=="RMC015_AUXILIARY_RISK_FRONTIER_VERIFIED"
         and source_summary.get("anchor",{}).get("chain_id")==1
         and source_summary["anchor"].get("block_number")==ANCHOR
         and source_summary["anchor"].get("block_hash")==ANCHOR_HASH
         and source_summary.get("earliest_ex_ante_evaluation_block")==FIRST
         and source_summary.get("retrospective_backtest_admitted") is False
         and source_summary.get("lookahead_used") is False
         and source_summary.get("material_risk_frontier",{}).get("account_count")==857
         and source_summary.get("realized_profitability_proven") is False
         and source_summary.get("execution_or_capital_feasibility_proven") is False,
         "historic risk source is not canonical/future-only")
    need(type(watchlist_blob) is bytes and len(watchlist_blob)<170_000 and
         watchlist_blob.endswith(b"\n"),
         "watchlist bytes missing or unexpected size")
    need(sha(watchlist_blob)==source_summary.get("watchlist_commitment_sha256"),
         "post-anchor source watchlist SHA256 mismatch")
    raw=watchlist_blob.splitlines()
    need(len(raw)==857,"incomplete 857-account source watchlist")
    rows=[unique_json(x) for x in raw]
    need(all(canonical(row).rstrip(b"\n")==line for row,line in zip(rows,raw)),
         "source account record is not canonical")
    seen=set()
    for row in rows:
        addr=row.get("account")
        need(type(addr) is str and ADDR.fullmatch(addr) is not None and addr not in seen,
             "duplicated or malformed watchlist borrower")
        seen.add(addr)
        hf=uint(row.get("health_factor_wad"),"source HF")
        debt=uint(row.get("debt_base_units"),"source debt")
        need(WAD<=hf<120*WAD//100 and debt>=10000*10**8,
             "source watchlist not material and healthy")
        need(type(row.get("debt_position_count")) is int and
             row["debt_position_count"]>=1,
             "debt-bearing position absent")
    need(rows==sorted(rows,key=lambda r:
         (int(r["health_factor_wad"]),-int(r["debt_base_units"]),r["account"])),
         "source watchlist no longer sorted by anchor HF/debt")
    # The control cohort is ordered by SHA256 of SOURCE account identity and
    # fixed ancestor hash, not any future block data or future winner receipts.
    nearest=rows[:NEAR_COUNT]
    remaining=rows[NEAR_COUNT:]
    controls=sorted(remaining,
        key=lambda r:(sha((ANCHOR_HASH+r["account"]).encode()),r["account"]))[:CONTROL_COUNT]
    cohort=[("CLOSEST_TO_ONE",x) for x in nearest] + [
        ("HASH_FIXED_CONTROL",x) for x in controls]
    commitment=sha(b"".join(canonical({"cohort":kind,"account":row["account"],
                    "health_factor_wad":row["health_factor_wad"],
                    "debt_base_units":row["debt_base_units"]}) for kind,row in cohort))
    return cohort,commitment


def inthex(x,label):
    need(type(x) is str and HEXQ.fullmatch(x) is not None,label+" bad quantity")
    return int(x,16)


def account_data(output):
    need(type(output) is str and WORD6.fullmatch(output) is not None,
         "Aave six ABI user account words required")
    w=[int(output[2+i*64:2+(i+1)*64],16) for i in range(6)]
    need(w[3]<=10000 and w[4]<=10000 and w[1]<=w[0]*1000000000+10**32,
         "invalid Aave user accounting result")
    if w[1]==0:
        need(w[5]==2**256-1,"Aave debt-free account has finite HF")
    return {"debt":w[1],"hf":w[5]}


def observe(provider,cohort,call=rpc):
    pid,operator,url=provider
    need(call(url,"eth_chainId",[])=="0x1",
         "invalid Ethereum archive RPC chain")
    blocks={}
    for n in (ANCHOR,FIRST,LATER):
        h=call(url,"eth_getBlockByNumber",[hex(n),False])
        need(type(h) is dict and inthex(h.get("number"),"block")==n and
             type(h.get("hash")) is str and HASH.fullmatch(h["hash"]) is not None and
             type(h.get("parentHash")) is str and HASH.fullmatch(h["parentHash"]) is not None and
             type(h.get("stateRoot")) is str and HASH.fullmatch(h["stateRoot"]) is not None,
             "historical block missing canonical EVM header")
        timestamp=inthex(h.get("timestamp"),"timestamp")
        need(timestamp>0,"invalid canonical block timestamp")
        blocks[n]={"hash":h["hash"],"parent":h["parentHash"],
                   "state_root":h["stateRoot"],"timestamp":timestamp}
    need(blocks[ANCHOR]["hash"]==ANCHOR_HASH and
         blocks[FIRST]["parent"]==ANCHOR_HASH and
         blocks[FIRST]["timestamp"]>blocks[ANCHOR]["timestamp"] and
         blocks[LATER]["timestamp"]>blocks[FIRST]["timestamp"],
         "block future/selection boundary mismatch")
    result=[]
    for kind,r in cohort:
        addr=r["account"]
        data=GET_ACCOUNT_DATA+addr[2:].rjust(64,"0")
        observations=[]
        for n in (ANCHOR,FIRST,LATER):
            position=account_data(call(url,"eth_call",[
                {"to":POOL,"data":data},hex(n)]))
            observations.append(position)
        need(observations[0]["hf"]==int(r["health_factor_wad"]) and
             observations[0]["debt"]==int(r["debt_base_units"]),
             "D09 anchor watchlist does not match actual mainnet Aave state")
        result.append({"cohort":kind,"source_health_factor":r["health_factor_wad"],
                       "source_debt_base_units":r["debt_base_units"],
                       "future_1":observations[1],
                       "future_7200":observations[2],
                       # included ONLY for two-RPC internal reconciliation;
                       # NEVER put borrower identifiers in returned artifact.
                       "identity_commitment":sha(addr.encode())})
    return {"operator":operator,"provider_id":pid,"blocks":blocks,"observations":result}


def assess(summary,watchlist_blob,*,providers=None,call=rpc):
    cohort,cohort_sha=select(summary,watchlist_blob)
    providers=providers or [p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(len(providers)==2 and [p[0] for p in providers]==["drpc","blast"]
         and providers[0][1]!=providers[1][1]
         and providers[0][2]!=providers[1][2],
         "two independent archive RPC operators and endpoints required")
    a,b=[observe(p,cohort,call=call) for p in providers]
    need(a["blocks"]==b["blocks"] and
         a["observations"]==b["observations"],
         "Aave post-anchor account health or block mismatch across providers")
    totals={}
    for step in ("future_1","future_7200"):
        counts={}
        for x in a["observations"]:
            curr=x[step]
            status=("NO_DEBT_AT_ENDPOINT" if curr["debt"]==0 else
                    "BELOW_ONE_AT_ENDPOINT" if curr["hf"]<WAD else
                    "HEALTHY_AT_ENDPOINT")
            key=x["cohort"]+"__"+status
            counts[key]=counts.get(key,0)+1
        totals[step]={"cohort_outcome_counts":dict(sorted(counts.items())),
                      "sample_accounts":len(cohort)}
    block_evidence={str(n):{
        "block_hash":a["blocks"][n]["hash"],
        "state_root":a["blocks"][n]["state_root"],
        "timestamp":a["blocks"][n]["timestamp"]
    } for n in (ANCHOR,FIRST,LATER)}
    report={
       "schema_version":1,
       "status":"RMC015_POST_ANCHOR_SAMPLE_REAL_TWO_OPERATOR_STATE_PASS_NOT_PNL",
       "chain_id":1,
       "aave_v3_pool":POOL,
       "original_d08_d09_frontier_sha256":summary["authority_commitment_sha256"],
       "original_d09_anchor_block":ANCHOR,
       "original_d09_anchor_hash":ANCHOR_HASH,
       "original_source_watchlist_count":857,
       "source_watchlist_sha256":summary["watchlist_commitment_sha256"],
       "decision_time_cohort_sha256":cohort_sha,
       "sampling_rule":"6_LOWEST_HF_AT_ANCHOR_PLUS_6_SHA256_FIXED_CONTROLS",
       "selection_was_fixed_before_any_future_block_was_queried":True,
       "sample_count":len(cohort),
       "sample_made_from_any_future_winning_transaction":False,
       "independent_operator_block_and_state_consensus":True,
       "historical_probe_blocks":block_evidence,
       "post_anchor_endpoint_observations":totals,
       "original_857_account_population_fully_rescanned":False,
       "continuous_account_monitoring_or_intermediate_liquidations_proven":False,
       "historic_queries_issued_in_real_time_at_2026_anchor":False,
       "live_nqc_signal_or_trading_decision_proven":False,
       "builder_bid_or_competitor_capture_measured":False,
       "capital_and_gas_with_zero_own_capital_authorized":False,
       "net_nqc_income_measured_usd":"0",
       "nqc_realized_profitable_trades_proven":False,
       "monthly_profit_or_15k_55k_goal_probability_proven":False,
       "rmc015_terminal_authority_closed":False,
       "real_market_census_closed":False,
       "non_claims":[
          "NO_LOOKAHEAD_MEMBERSHIP_SELECTION",
          "POST_ANCHOR_RETROSPECTIVE_OBSERVATION_NOT_TIMESTAMPED_LIVE_SIGNAL",
          "TWO_ENDPOINT_STATES_ARE_NOT_CONTINUOUS_EPISODE_COVERAGE",
          "NO_PROFIT_OR_CAPTURE_CLAIM_FROM_HEALTH_FACTORS",
          "EXTERNAL_SPONSOR_PIMLICO_DEPOSIT_NOT_NQC_FINANCING",
       ],
    }
    report["report_sha256"]=sha(canonical(report))
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source-summary",type=Path,required=True)
    p.add_argument("--watchlist-jsonl",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    need(not a.out.exists(),"output must be append-only")
    s=unique_json(a.source_summary.read_bytes())
    result=assess(s,a.watchlist_jsonl.read_bytes())
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(result))
    print(result["status"],
          "sample",result["sample_count"],
          "post1",result["post_anchor_endpoint_observations"]["future_1"],
          "post7200",result["post_anchor_endpoint_observations"]["future_7200"],
          "income",result["net_nqc_income_measured_usd"],
          "CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
