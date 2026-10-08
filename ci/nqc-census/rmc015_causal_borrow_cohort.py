#!/usr/bin/env python3
"""NQC RMC015: strictly block-cutoff Aave Borrow-log borrower cohort and NEXT-block holdout.

This experiment tests causal information ordering, not full market coverage,
liquidation solvability, inclusion, financing, net P&L or actual NQC revenue.
Importantly the cohort is enumerated from Borrow logs BEFORE next-block events
are requested; no historical winner tx/borrower ID is provided as discovery input.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path
from rmc016_probe_historical_rpc import PROVIDERS, rpc, AAVE_POOL, LIQUIDATION_TOPIC
from rmc016_rank1_preblock_health import GET_ACCOUNT_DATA, WAD
from rmc016_rank1_preblock_health import WORD6

CHAIN = 1
CUTOFF = 25938047
CUTOFF_HASH = "0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab"
NEXT_BLOCK = CUTOFF+1
NEXT_HASH = "0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4"
LOOKBACK = 512
CHUNK = 64
MAX_LOGS_PER_CHUNK = 600
MAX_COHORT = 350
BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"
SOURCE_INTERFACE = "Borrow(address indexed reserve,address user,address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,uint256 borrowRate,uint16 indexed referralCode)"
HEX32 = re.compile(r"0x[0-9a-f]{64}\Z")
HEX40 = re.compile(r"0x[0-9a-f]{40}\Z")
WORD4 = re.compile(r"0x[0-9a-fA-F]{256}\Z")
UINT = re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")


def require(p,msg):
    if not p:raise ValueError(msg)


def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()


def sha(obj):
    return hashlib.sha256(canonical(obj)).hexdigest()


def num(x,name):
    require(type(x) is str and UINT.fullmatch(x) is not None,
            name+" malformed Ethereum quantity")
    return int(x,16)


def header(h,n,expected):
    require(type(h) is dict and num(h.get("number"),"block")==n
            and h.get("hash")==expected,"Ethereum block/hash canonical mismatch")
    require(type(h.get("stateRoot")) is str and HEX32.fullmatch(h["stateRoot"]) is not None
            and type(h.get("parentHash")) is str and HEX32.fullmatch(h["parentHash"]) is not None,
            "Ethereum header missing trusted stateRoot/parentHash")
    ts=num(h.get("timestamp"),"timestamp")
    require(ts>0,"invalid historical timestamp")
    return {"number":n,"hash":h["hash"],"parent_hash":h["parentHash"],
            "state_root":h["stateRoot"],"timestamp":ts}


def decode_account_allow_fully_repaid(raw):
    """Unlike rank-one witness, a deterministic Borrow cohort includes closed loans."""
    require(type(raw) is str and WORD6.fullmatch(raw) is not None,
            "Aave account result must have exactly 6 uint256 words")
    collateral,debt,available,threshold,ltv,hf=(
        int(raw[2+64*i:2+64*(i+1)],16) for i in range(6))
    require(0<=threshold<=10_000 and 0<=ltv<=10_000,
            "Aave account bps invalid")
    return {
        "total_collateral_base":str(collateral),
        "total_debt_base":str(debt),
        "available_borrows_base":str(available),
        "current_liquidation_threshold_bps":threshold,
        "ltv_bps":ltv,
        "health_factor_wad":str(hf),
    }


def borrow_identity(log,lower,upper):
    require(type(log) is dict and log.get("address","").lower()==AAVE_POOL
            and log.get("removed") is False,
            "out-of-pool or reorg-removed Borrow record")
    ts=log.get("topics")
    require(type(ts) is list and len(ts)==4 and ts[0]==BORROW_TOPIC
            and all(type(t) is str and HEX32.fullmatch(t) is not None for t in ts),
            "Borrow canonical ABI topics invalid")
    block=num(log.get("blockNumber"),"Borrow block")
    require(lower<=block<=upper<=CUTOFF,"Borrow record leaked beyond decision block")
    require(type(log.get("blockHash")) is str and HEX32.fullmatch(log["blockHash"]) is not None
            and type(log.get("transactionHash")) is str
            and HEX32.fullmatch(log["transactionHash"]) is not None,
            "Borrow block/tx source missing")
    idx=num(log.get("logIndex"),"Borrow log index")
    require(type(log.get("data")) is str and WORD4.fullmatch(log["data"]) is not None,
            "Borrow ABI payload malformed")
    beneficiary="0x"+ts[2][-40:]
    require(HEX40.fullmatch(beneficiary) is not None
            and beneficiary!="0x"+"0"*40 and ts[2][2:26]=="0"*24,
            "Borrow debt beneficiary ABI invalid")
    borrower="0x"+log["data"][2+24:2+64].lower()
    require(HEX40.fullmatch(borrower) is not None,
            "Borrow initiator non-indexed ABI invalid")
    return {
        "borrower":beneficiary,"block":block,
        "block_hash":log["blockHash"],
        "transaction_hash":log["transactionHash"],
        "log_index":idx,"debt_asset":"0x"+ts[1][-40:],
        "initiator":borrower,
    }


def cutoff_query(call,url,method,args):
    """Features can NEVER request future blocks/tx receipts or unrestricted logs."""
    if method=="eth_chainId":
        require(args==[],"unbound chain ID query")
    elif method=="eth_getBlockByNumber":
        require(type(args) is list and len(args)==2 and
                args==[hex(CUTOFF),False],"feature stage requested noncutoff header")
    elif method=="eth_getLogs":
        require(type(args) is list and len(args)==1 and type(args[0]) is dict,
                "Borrow filter malformed")
        f=args[0]
        require(f.get("address")==AAVE_POOL and f.get("topics")==[BORROW_TOPIC]
                and num(f.get("fromBlock"),"fromBlock")>=CUTOFF-LOOKBACK+1
                and num(f.get("toBlock"),"toBlock")<=CUTOFF
                and num(f["toBlock"],"toBlock")-num(f["fromBlock"],"fromBlock")<CHUNK,
                "future/unbounded Borrow event query")
    elif method=="eth_call":
        require(type(args) is list and len(args)==2 and args[1]==hex(CUTOFF)
                and type(args[0]) is dict
                and args[0].get("to")==AAVE_POOL
                and type(args[0].get("data")) is str
                and args[0]["data"].startswith(GET_ACCOUNT_DATA)
                and len(args[0]["data"])==10+64,
                "feature stage may read only as-of Aave account health")
    else:
        raise ValueError("future/winner/receipt RPC forbidden in discovery stage")
    return call(url,method,args)


def feature_stage(provider,call=rpc):
    pid,operator,url=provider
    gated=lambda m,a:cutoff_query(call,url,m,a)
    require(gated("eth_chainId",[])=="0x1","wrong chain")
    last=header(gated("eth_getBlockByNumber",[hex(CUTOFF),False]),CUTOFF,CUTOFF_HASH)
    first=CUTOFF-LOOKBACK+1
    seen=set()
    events=[]
    for lo in range(first,CUTOFF+1,CHUNK):
        hi=min(CUTOFF,lo+CHUNK-1)
        logs=gated("eth_getLogs",[{"address":AAVE_POOL,"topics":[BORROW_TOPIC],
                                   "fromBlock":hex(lo),"toBlock":hex(hi)}])
        require(type(logs) is list and len(logs)<=MAX_LOGS_PER_CHUNK,
                "event chunk incomplete/suspiciously large")
        for log in logs:
            ev=borrow_identity(log,lo,hi)
            key=(ev["transaction_hash"],ev["log_index"])
            require(key not in seen,"duplicate original Borrow event in chunk")
            seen.add(key)
            events.append(ev)
    require(len(events)<=CHUNK*MAX_LOGS_PER_CHUNK*(LOOKBACK//CHUNK),
            "Borrow log scope limit exceeded")
    borrowers=sorted({ev["borrower"] for ev in events})
    require(len(borrowers)<=MAX_COHORT,
            "borrower cohort exceeds bounded test resources: do not truncate")
    risk=[]
    for borrower in borrowers:
        data=GET_ACCOUNT_DATA+borrower[2:].rjust(64,"0")
        decoded=decode_account_allow_fully_repaid(
            gated("eth_call",[{"to":AAVE_POOL,"data":data},hex(CUTOFF)]))
        hf=int(decoded["health_factor_wad"])
        risk.append({
            "address":borrower,
            "health_factor_wad":str(hf),
            "debt_base":decoded["total_debt_base"],
            "collateral_base":decoded["total_collateral_base"],
            "active_debt":int(decoded["total_debt_base"])>0,
            "already_liquidatable_at_cutoff":
                int(decoded["total_debt_base"])>0 and hf<WAD,
            "in_near_boundary_band":
                int(decoded["total_debt_base"])>0 and WAD<=hf<=WAD+WAD//100,
            "in_micro_boundary_band":
                int(decoded["total_debt_base"])>0 and WAD<=hf<=WAD+WAD//1_000_000,
        })
    # Strictly use no next-block labels, receipts, future winner address or
    # winner transaction when constructing risk scores and cohort commitments.
    features={
        "ethereum_chain_id":CHAIN,
        "decision_time_block":CUTOFF,
        "decision_time_block_hash":CUTOFF_HASH,
        "decision_time_timestamp":last["timestamp"],
        "decision_state_root":last["state_root"],
        "enumeration_coverage":"LAST_512_BLOCKS_BORROW_EVENTS_ONLY_NOT_ALL_BORROWERS",
        "borrow_event_topic":BORROW_TOPIC,
        "borrow_event_count":len(events),
        "unique_recent_borrowers":len(borrowers),
        "borrow_event_commitment_sha256":sha(sorted(events,key=lambda e:(e["block"],e["transaction_hash"],e["log_index"]))),
        "borrower_risks":risk,
        "source_retrospectively_chosen_winners_in_input":False,
        "complete_protocol_borrower_universe":False,
        "risk_is_a_profitable_liquidation_prediction":False,
    }
    features["features_frozen_sha256"]=sha(features)
    return {"provider_id":pid,"operator":operator,"features":features}


def holdout_stage(provider,feature_commitment,call=rpc):
    """Label-only: results can never affect feature-stage candidate selection."""
    pid,operator,url=provider
    require(type(feature_commitment) is str and re.fullmatch(r"[0-9a-f]{64}",feature_commitment),
            "features MUST be committed before holdout inspection")
    require(call(url,"eth_chainId",[])=="0x1","holdout chain wrong")
    h=header(call(url,"eth_getBlockByNumber",[hex(NEXT_BLOCK),False]),
             NEXT_BLOCK,NEXT_HASH)
    require(h["parent_hash"]==CUTOFF_HASH,"holdout not direct canonical successor")
    logs=call(url,"eth_getLogs",[{"address":AAVE_POOL,"topics":[LIQUIDATION_TOPIC],
                                 "fromBlock":hex(NEXT_BLOCK),"toBlock":hex(NEXT_BLOCK)}])
    require(type(logs) is list and len(logs)<=MAX_LOGS_PER_CHUNK,
            "holdout liquidation logs missing/unbounded")
    labels=[]
    seen=set()
    for log in logs:
        require(type(log) is dict and log.get("address","").lower()==AAVE_POOL
                and log.get("removed") is False
                and type(log.get("topics")) is list and len(log["topics"])==4
                and log["topics"][0]==LIQUIDATION_TOPIC
                and num(log.get("blockNumber"),"holdout block")==NEXT_BLOCK
                and log.get("blockHash")==NEXT_HASH
                and type(log.get("transactionHash")) is str
                and HEX32.fullmatch(log["transactionHash"]) is not None,
                "holdout malformed liquidation event")
        b="0x"+log["topics"][3][-40:].lower()
        require(HEX40.fullmatch(b) is not None
                and log["topics"][3][2:26].lower()=="0"*24
                and b!="0x"+"0"*40,"holdout bad borrower")
        idx=num(log.get("logIndex"),"holdout logIndex")
        key=(log["transactionHash"],idx)
        require(key not in seen,"holdout duplicate")
        seen.add(key)
        labels.append({"borrower":b,"tx":key[0],"log_index":idx})
    return {"provider_id":pid,"operator":operator,
            "feature_commitment_attested_before_holdout":feature_commitment,
            "successor_block_hash":h["hash"],
            "successor_parent_hash":h["parent_hash"],
            "observed_next_block_liquidations":
                sorted(labels,key=lambda x:(x["tx"],x["log_index"]))}


def assess(*,call=rpc,providers=None):
    providers=providers or [x for x in PROVIDERS if x[0] in ("drpc","blast")]
    require(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"]
            and providers[0][1]!=providers[1][1] and providers[0][2]!=providers[1][2],
            "need two independently operated unique historical RPCs")
    f=[feature_stage(provider,call=call) for provider in providers]
    require(f[0]["features"]==f[1]["features"],
            "independent operators disagree on before-cutoff cohort/health/risk")
    committed=f[0]["features"]["features_frozen_sha256"]
    h=[holdout_stage(p,committed,call=call) for p in providers]
    require(h[0]["observed_next_block_liquidations"]==h[1]["observed_next_block_liquidations"],
            "independent operators disagree on post-cutoff HOLDOUT receipts/events")
    features=f[0]["features"]
    borrowers={r["address"] for r in features["borrower_risks"]}
    all_liquidations={x["borrower"] for x in h[0]["observed_next_block_liquidations"]}
    hits=sorted(borrowers & all_liquidations)
    misses=sorted(all_liquidations-borrowers)
    risk_by_address={x["address"]:x for x in features["borrower_risks"]}
    # A recent Borrow-event *cohort* may miss most earlier borrowers. This
    # deliberately reports its recall failure rather than masquerading as
    # a complete active-account index or ex-ante executable opportunity.
    output={
        "schema_version":1,
        "status":"RMC015_PREWINNER_BORROW_COHORT_CAUSAL_HOLDOUT_OBSERVED_NOT_PNL",
        "source_selection":"ONLY_BORROW_LOGS_IN_512_BLOCKS_ENDING_BEFORE_HOLDOUT",
        "decision_block_number":CUTOFF,
        "next_label_block_number":NEXT_BLOCK,
        "immutable_input_features_sha256":committed,
        "independent_operator_feature_consensus":True,
        "independent_operator_holdout_label_consensus":True,
        "recent_borrow_event_count":features["borrow_event_count"],
        "recent_borrow_cohort_size":features["unique_recent_borrowers"],
        "cohort_active_debt_accounts":
            sum(x["active_debt"] for x in features["borrower_risks"]),
        "cohort_already_liquidatable_at_cutoff":
            sum(x["already_liquidatable_at_cutoff"] for x in features["borrower_risks"]),
        "cohort_near_boundary_1_percent":
            sum(x["in_near_boundary_band"] for x in features["borrower_risks"]),
        "cohort_micro_boundary_1e_minus6":
            sum(x["in_micro_boundary_band"] for x in features["borrower_risks"]),
        "observed_holdout_unique_liquidated_borrowers":len(all_liquidations),
        "holdout_borrowers_present_in_causal_recent_borrow_cohort":len(hits),
        "holdout_borrowers_absent_from_causal_recent_borrow_cohort":len(misses),
        "holdout_hit_borrowers":hits,
        "holdout_miss_borrowers":misses,
        "holdout_hits_already_liquidatable":
            sum(risk_by_address[x]["already_liquidatable_at_cutoff"] for x in hits),
        "holdout_hits_in_near_boundary_band":
            sum(risk_by_address[x]["in_near_boundary_band"] for x in hits),
        "source_features":features,
        "operator_features":f,
        "operator_holdout_evidence":h,
        "signal_discovery_uses_future_winner_knowledge":False,
        "study_was_designed_with_prior_knowledge_of_this_historical_winner_block":True,
        "unbiased_ex_ante_out_of_sample_validation_complete":False,
        "historical_cohort_coverage_complete":False,
        "next_block_liquidation_match_proves_capture":False,
        "nqc_revenue_or_income_found":False,
        "nqc_capital_zero_external_gas_authorized":False,
        "rmc015_terminal_authority_obtained":False,
        "real_market_census_closed":False,
    }
    output["report_sha256"]=sha(output)
    return output


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    require(not a.out.exists(),"append-only immutable experiment output required")
    result=assess()
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(result))
    print(result["status"],"cohort",result["recent_borrow_cohort_size"],
          "holdout_matches",result["holdout_borrowers_present_in_causal_recent_borrow_cohort"],
          "holdout_missed",result["holdout_borrowers_absent_from_causal_recent_borrow_cohort"],
          "NQC_REALIZED_PNL=false")


if __name__=="__main__":
    main()
