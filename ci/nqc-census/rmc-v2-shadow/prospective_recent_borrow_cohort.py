#!/usr/bin/env python3
"""Aave V3 fresh Borrow-event cohort + exact block state, read-only research.

No hindsight winner selection: select recently debt-opening onBehalfOf accounts
before reading HF. Event-indexed new borrows do NOT equal all active borrowers.
No NQC signed/broadcast transaction, deployed listener, or P2/net authority.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from prospective_50borrower_state import (
    decode_account, call_data, WAD, NEAR_50BPS, NEAR_200BPS,
    NEAR_1000BPS,
)

POOL = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
# Aave V3 IPool Borrow(address indexed reserve,address user,
# address indexed onBehalfOf,uint256 amount,uint8 interestRateMode,
# uint256 borrowRate,uint16 indexed referralCode).
# keccak256("Borrow(address,address,address,uint256,uint8,uint256,uint16)")
BORROW_TOPIC = "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0"
RPC_ENDPOINTS = {
    "drpc": "https://eth.drpc.org",
    "publicnode": "https://ethereum-rpc.publicnode.com",
}
WINDOW_BLOCKS = 384
LOG_SHARD_BLOCKS = 24
CONFIRMATION_DEPTH = 3
MAX_TIP_DRIFT = 12
MAX_HEADER_STALENESS = 180
MAX_LOG_EVENTS = 320
MAX_LOG_EVENT_BLOCKS = 105
MAX_RECENT_ACCOUNTS = 64
MAX_RECEIPT_CONTROLS = 2
MAX_RPC_CALLS_PER_SOURCE = 200
# Only explicitly authorized dense event-block header scans may request this
# larger, still finite RPC budget. Existing Borrow default stays at 200.
MAX_EXPLICIT_RPC_CALLS_PER_SOURCE = 413
MAX_REPLY_BYTES = 4_000_000
HEX32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEXADDR = re.compile(r"0x[0-9a-fA-F]{40}\Z")
HEXQ = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
HEXDATA = re.compile(r"0x[0-9a-fA-F]{256}\Z")


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def qty(v, name):
    need(type(v) is str and HEXQ.fullmatch(v), name + " must be Ethereum quantity")
    return int(v, 16)


def b32(v, name):
    need(type(v) is str and HEX32.fullmatch(v), name + " must be bytes32")
    return v.lower()


def addr_topic(v, name):
    b32(v, name)
    need(int(v[2:26], 16) == 0 and int(v[26:], 16) > 0,
         name + " invalid indexed address")
    return "0x" + v[-40:].lower()


def stamp():
    return datetime.now(timezone.utc).isoformat()


def canon(o):
    return (json.dumps(o, separators=(",", ":"), sort_keys=True,
                       ensure_ascii=True) + "\n").encode()


def header(raw, expected):
    need(type(raw) is dict and qty(raw.get("number"), "block number") == expected,
         "wrong block/absent canonical header")
    h = b32(raw.get("hash"), "block hash")
    p = b32(raw.get("parentHash"), "parent hash")
    root = b32(raw.get("stateRoot"), "state root")
    ts = qty(raw.get("timestamp"), "block timestamp")
    need(ts > 0 and h != p, "invalid block ancestry")
    return {"number": expected, "hash": h, "parent_hash": p,
            "state_root": root, "timestamp": ts}


def parse_borrow(raw, first, last):
    need(type(raw) is dict and type(raw.get("address")) is str and
         raw["address"].lower() == POOL, "event not emitted by canonical Aave pool")
    ts = raw.get("topics")
    need(type(ts) is list and len(ts) == 4 and
         b32(ts[0], "event topic0") == BORROW_TOPIC,
         "not Aave V3 Borrow topic/ABI")
    reserve = addr_topic(ts[1], "reserve")
    beneficiary = addr_topic(ts[2], "onBehalfOf")
    referral = int(b32(ts[3], "indexed referralCode"), 16)
    need(referral <= 65535, "uint16 referral overflow")
    data = raw.get("data")
    need(type(data) is str and HEXDATA.fullmatch(data),
         "Borrow must encode exactly 4 unindexed ABI words")
    words = [int(data[2+i*64:2+(i+1)*64], 16) for i in range(4)]
    user_word, amount, interest_mode, rate = words
    need(user_word < 2**160 and user_word > 0,
         "initiating user ABI address padding or zero address invalid")
    need(amount > 0 and interest_mode in (1, 2),
         "zero loan or invalid rate mode")
    block = qty(raw.get("blockNumber"), "event block")
    need(first <= block <= last, "out-of-range recent borrowing event")
    need(raw.get("removed") in (None, False), "reorged event invalid")
    return {
        "block_number": block,
        "block_hash": b32(raw.get("blockHash"), "event blockHash"),
        "tx_hash": b32(raw.get("transactionHash"), "event txHash"),
        "tx_index": qty(raw.get("transactionIndex"), "event transactionIndex"),
        "log_index": qty(raw.get("logIndex"), "event logIndex"),
        "reserve": reserve,
        "user_initiator": "0x" + f"{user_word:040x}",
        "on_behalf_of": beneficiary,
        "amount_raw": str(amount),
        "interest_rate_mode": interest_mode,
        "borrow_rate_ray": str(rate),
        "referral_code": referral,
        "raw_event_sha256": sha256(canon({
            "topics": [s.lower() for s in ts],
            "data": data.lower(), "address": POOL,
        })).hexdigest(),
        "selected_without_future_hf_or_liquidation_outcome": True,
    }


def event_id(event):
    return (event["block_number"], event["tx_index"],
            event["log_index"], event["tx_hash"])


def shards(first, last):
    need(type(first) is int and type(last) is int and
         first > 0 and first <= last and
         last-first+1 == WINDOW_BLOCKS,
         "window must cover exact fixed contiguous 384 blocks")
    return [(x, min(last, x+LOG_SHARD_BLOCKS-1))
            for x in range(first, last+1, LOG_SHARD_BLOCKS)]


class RPC:
    def __init__(self, provider, transport=None, call_budget=None):
        need(provider in RPC_ENDPOINTS, "unapproved RPC provider")
        if call_budget is None:
            call_budget = MAX_RPC_CALLS_PER_SOURCE
        need(type(call_budget) is int and
             1 <= call_budget <= MAX_EXPLICIT_RPC_CALLS_PER_SOURCE,
             "unbounded or invalid source-specific RPC budget")
        self.call_budget = call_budget
        self.provider = provider
        self.url = RPC_ENDPOINTS[provider]
        self.transport = transport or self.network
        self.calls = 0
        self.transcript = []

    @staticmethod
    def network(url, method, params):
        need(url in set(RPC_ENDPOINTS.values()), "endpoint outside allowlist")
        need(method in ("eth_chainId", "eth_blockNumber",
                        "eth_getBlockByNumber", "eth_getLogs",
                        "eth_getTransactionReceipt", "eth_call"),
             "non-read-only method forbidden")
        request = Request(url, data=json.dumps({
            "jsonrpc": "2.0", "id": 92,
            "method": method, "params": params
        }).encode(), method="POST",
          headers={"Content-Type": "application/json",
                   "User-Agent": "NQC-V2-RecentBorrow-ReadOnlyResearch/1"})
        with urlopen(request, timeout=23) as response:
            body = response.read(MAX_REPLY_BYTES+1)
        need(len(body) <= MAX_REPLY_BYTES, "oversized public RPC response")
        def pairs(entries):
            obj = {}
            for k,v in entries:
                need(k not in obj, "duplicate JSON key")
                obj[k] = v
            return obj
        def reject_constant(v):
            raise Rejected("nonfinite JSON constant: "+v)
        reply = json.loads(body, object_pairs_hook=pairs,
                           parse_constant=reject_constant)
        need(type(reply) is dict and reply.get("id") == 92 and
             reply.get("jsonrpc") == "2.0" and "error" not in reply and
             "result" in reply, "RPC failure or malformed response")
        return reply["result"]

    def call(self, method, params, allowed_borrowers=None):
        need(self.calls < self.call_budget,
             "source-specific request quota reached")
        if method in ("eth_chainId", "eth_blockNumber"):
            need(params == [], "unexpected chain/tip arguments")
        elif method == "eth_getBlockByNumber":
            need(type(params) is list and len(params) == 2 and
                 type(params[0]) is str and HEXQ.fullmatch(params[0]) and
                 params[1] is False, "only numbered canonical headers allowed")
        elif method == "eth_getLogs":
            need(type(params) is list and len(params) == 1 and
                 type(params[0]) is dict, "eth_getLogs shape invalid")
            f = params[0]
            need(set(f) == {"address", "topics", "fromBlock", "toBlock"} and
                 f["address"] == POOL and f["topics"] == [BORROW_TOPIC] and
                 0 <= qty(f["toBlock"], "logs to")-qty(f["fromBlock"], "logs from")
                    < LOG_SHARD_BLOCKS,
                 "eth_getLogs beyond bounded Aave Borrow topic/range")
        elif method == "eth_getTransactionReceipt":
            need(type(params) is list and len(params) == 1 and
                 type(params[0]) is str and HEX32.fullmatch(params[0]),
                 "receipt transaction hash malformed")
        elif method == "eth_call":
            need(type(params) is list and len(params) == 2 and
                 type(params[0]) is dict and
                 set(params[0]) == {"to", "data"} and
                 params[0]["to"] == POOL and
                 type(params[0]["data"]) is str and
                 re.fullmatch(r"0xbf92857c0{24}[0-9a-f]{40}",
                              params[0]["data"]) and
                 type(allowed_borrowers) is set and
                 "0x"+params[0]["data"][-40:] in allowed_borrowers and
                 type(params[1]) is dict and
                 set(params[1]) == {"blockHash", "requireCanonical"} and
                 params[1]["requireCanonical"] is True and
                 HEX32.fullmatch(params[1]["blockHash"]),
                 "out-of-cohort, noncanonical or overridden Aave eth_call")
        else:
            raise Rejected("write RPC forbidden")
        self.calls += 1
        row = {"provider":self.provider, "method":method,
               "params":params,"started_at_utc":stamp()}
        started = time.monotonic_ns()
        try:
            if self.transport == self.network:
                time.sleep(.30)  # bounded, no rate-limit bypass
            result = self.transport(self.url,method,params)
            row["response_sha256"] = sha256(canon(result)).hexdigest()
            return result
        except Exception as exc:
            row["error_type"] = type(exc).__name__
            row["error_detail"] = str(exc).split("https://")[0][:150]
            raise
        finally:
            row["elapsed_ns"] = time.monotonic_ns()-started
            row["finished_at_utc"] = stamp()
            self.transcript.append(row)

    def tip(self):
        need(qty(self.call("eth_chainId", []), "chain") == 1,
             "source isn't Ethereum mainnet")
        return qty(self.call("eth_blockNumber", []), "tip")

    def get_header(self, number):
        return header(self.call("eth_getBlockByNumber",
                                [hex(number), False]), number)


def verify_receipt(receipt, event):
    need(type(receipt) is dict and
         b32(receipt.get("transactionHash"), "receipt txHash") == event["tx_hash"] and
         b32(receipt.get("blockHash"), "receipt blockHash") == event["block_hash"] and
         qty(receipt.get("blockNumber"), "receipt blockNumber") == event["block_number"] and
         qty(receipt.get("transactionIndex"), "receipt txIndex") == event["tx_index"] and
         qty(receipt.get("status"), "receipt status") == 1 and
         qty(receipt.get("gasUsed"), "receipt gas") > 0 and
         qty(receipt.get("effectiveGasPrice"), "receipt gasPrice") > 0,
         "Borrow receipt failed or differs from log")
    logs = receipt.get("logs")
    need(type(logs) is list and len(logs) < 15_000,
         "receipt log list missing/oversized")
    rows = [parse_borrow(x,event["block_number"],event["block_number"])
            for x in logs if type(x) is dict and
            type(x.get("address")) is str and
            x["address"].lower() == POOL and
            type(x.get("topics")) is list and
            x["topics"] and x["topics"][0].lower() == BORROW_TOPIC and
            type(x.get("logIndex")) is str and
            qty(x["logIndex"], "receipt event logIndex") == event["log_index"]]
    need(len(rows) == 1 and rows[0] == event,
         "actual successful tx receipt lacks identical Aave Borrow event")
    return {
        "tx_hash":event["tx_hash"],
        "event_log_index":event["log_index"],
        "block_hash":event["block_hash"],
        "borrower":event["on_behalf_of"],
        "borrow_receipt_event_parity":True,
        "receipt_gas_is_original_competitor_not_nqc":True,
    }


def scan_source(rpc, first, last):
    out = {"provider":rpc.provider, "status":"INCOMPLETE_BORROW_LOG_SOURCE",
           "events":[], "event_blocks_checked":0,
           "positive_receipt_controls":[], "shards_complete":0,
           "errors":[]}
    try:
        start_head=rpc.get_header(first)
        end_head=rpc.get_header(last)
        out["starting_head"]=start_head
        out["ending_head"]=end_head
        events = []
        for lo,hi in shards(first,last):
            raw=rpc.call("eth_getLogs",[{
                "address":POOL, "topics":[BORROW_TOPIC],
                "fromBlock":hex(lo), "toBlock":hex(hi),
            }])
            need(type(raw) is list and len(raw) <= MAX_LOG_EVENTS,
                 "oversized or missing Aave Borrow log response")
            events.extend(parse_borrow(x,lo,hi) for x in raw)
            need(len(events) <= MAX_LOG_EVENTS,
                 "Borrow event cap exhausted before full scan")
            out["shards_complete"] += 1
        events.sort(key=event_id)
        need(len(events) == len(set(event_id(e) for e in events)),
             "duplicate Borrow event identity")
        unique_blocks=sorted({e["block_number"] for e in events})
        need(len(unique_blocks) <= MAX_LOG_EVENT_BLOCKS,
             "more event-bearing block headers than authorized")
        heads={n:rpc.get_header(n) for n in unique_blocks}
        for event in events:
            need(event["block_hash"] == heads[event["block_number"]]["hash"],
                 "Borrow log block not canonical")
        out["event_blocks_checked"]=len(heads)
        for tx in dict.fromkeys(event["tx_hash"] for event in events):
            if len(out["positive_receipt_controls"]) >= MAX_RECEIPT_CONTROLS:
                break
            e=next(e for e in events if e["tx_hash"]==tx)
            proof=verify_receipt(
                rpc.call("eth_getTransactionReceipt",[tx]),e)
            out["positive_receipt_controls"].append(proof)
        need(rpc.get_header(first)==start_head and
             rpc.get_header(last)==end_head,
             "head changed during entire Borrow scan")
        out["events"]=events
        out["status"]="COMPLETE_CANONICAL_BORROW_EVENT_SOURCE"
    except Exception as exc:
        out["errors"].append({"kind":type(exc).__name__,
                              "detail":str(exc).split("https://")[0][:200]})
    return out


def select_cohort(events):
    need(type(events) is list and len(events)<=MAX_LOG_EVENTS,
         "unbounded or unknown Borrow event set")
    latest=sorted(events,key=event_id,reverse=True)
    selected={}
    for e in latest:
        b=e["on_behalf_of"]
        if b not in selected and len(selected)<MAX_RECENT_ACCOUNTS:
            selected[b]={
                "borrower":b,
                "latest_borrow_tx_hash":e["tx_hash"],
                "latest_borrow_block":e["block_number"],
                "latest_borrow_log_index":e["log_index"],
                "latest_reserve":e["reserve"],
                "latest_borrow_amount_raw":e["amount_raw"],
                "beneficiary_identity_from_indexed_topic_2":True,
                "hindsight_liquidator_selection_used":False,
            }
    distinct={e["on_behalf_of"] for e in events}
    return list(selected.values()),{
        "events_in_full_window":len(events),
        "distinct_debt_receivers":len(distinct),
        "selected_receivers":len(selected),
        "excess_distinct_receivers_not_reconstructed":
            len(distinct)-len(selected),
        "selection_rule":"LATEST_64_DISTINCT_BORROW_ON_BEHALF_OF_BEFORE_HF",
        "no_future_liquidation_outcome_used":True,
        "cohort_is_not_all_active_aave_positions":True,
    }


def assess_accounts(rpc, expected_header, cohort):
    authorized={r["borrower"] for r in cohort}
    need(type(cohort) is list and 0<len(cohort)<=MAX_RECENT_ACCOUNTS
         and len(authorized)==len(cohort), "empty/duplicated/unbounded new cohort")
    observed=[]
    start=rpc.get_header(expected_header["number"])
    need(start==expected_header,"state provider block/hash drift")
    for entry in cohort:
        who=entry["borrower"]
        raw=rpc.call("eth_call",[{
            "to":POOL,"data":call_data(who)
        },{"blockHash":expected_header["hash"],"requireCanonical":True}],
             allowed_borrowers=authorized)
        data=decode_account(raw)
        observed.append({
            "borrower":who,"latest_borrow_block":entry["latest_borrow_block"],
            "inclusion_after_latest_borrow_block":
                expected_header["number"] >= entry["latest_borrow_block"],
            "risk":data,"source_account_raw_sha256":
                sha256(raw.lower().encode()).hexdigest(),
            "borrow_event_and_state_same_transaction_prestate":False,
            "route_execution_proven":False,
        })
    need(rpc.get_header(expected_header["number"])==start,
         "canonical risk state header changed during read")
    return observed


def make_report(index,src,peer,cohort,selection,errors,reader_data):
    result={
        "schema_version":1,
        "status":"INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE",
        "chain_id":1,
        "observation_started_at_utc":stamp(),
        "anchor":index,
        "borrow_event_topic0":BORROW_TOPIC,
        "source_reports":{"drpc":src,"publicnode":peer},
        "state_reports":reader_data,
        "errors":errors,
        "recent_borrow_event_count_quorum":None,
        "recent_borrower_count_quorum":None,
        "selected_recent_borrower_count_quorum":None,
        "borrower_accounts_exact_two_url_parity":False,
        "source_verified_hf_lt_one_count":None,
        "source_verified_near_50bps_count":None,
        "source_verified_near_200bps_count":None,
        "source_verified_near_1000bps_count":None,
        "source_verified_debt_active_count":None,
        "source_verified_no_debt_count":None,
        "most_at_risk_hf_wad":None,
        "most_at_risk_address":None,
        "truncation":selection,
        "selected_source_cohort":cohort,
        "selection_is_recent_borrow_not_all_outstanding_positions":True,
        "prospective_observation_after_borrow_inclusion_not_before":True,
        "all_source_endpoints_ultimately_share_mainnet_may_not_be_operator_independent":True,
        "candidate_HF_state_is_not_actionable_liquidation":True,
        "real_full_transaction_gas_calibrated":False,
        "route_feasibility_proven":False,
        "competitive_capture_probability_calibrated":False,
        "nonrecourse_sponsor_for_own_capital_zero_certified":False,
        "shadow_P2_certified":False,
        "RMC_closed":False,
        "canary_live_authorized":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }
    return result


def collect(transport_factory=None, current_unix=None):
    clients={n:RPC(n,transport_factory(n) if transport_factory else None)
             for n in ("drpc","publicnode")}
    now_ts=int(datetime.now(timezone.utc).timestamp()) if current_unix is None else current_unix
    need(type(now_ts) is int and now_ts>0, "invalid observation time")
    tips={}
    failures=[]
    for n,rpc in clients.items():
        try:
            tips[n]=rpc.tip()
        except Exception as exc:
            failures.append({"stage":"preflight","provider":n,
                             "error":type(exc).__name__,"detail":str(exc)[:160]})
    anchor=None
    if len(tips)==2 and max(tips.values())-min(tips.values())<=MAX_TIP_DRIFT:
        last=min(tips.values())-CONFIRMATION_DEPTH
        first=last-WINDOW_BLOCKS+1
        if first>0:
            anchor={"first_block":first,"last_block":last,
                    "inclusive_blocks":WINDOW_BLOCKS,
                    "head_confirmation_delay_blocks":CONFIRMATION_DEPTH,
                    "provider_tips":tips}
    else:
        failures.append({"stage":"anchor","error":"SOURCE_TIP_MISMATCH_OR_UNAVAILABLE"})
    sources={n:{"provider":n,"status":"NOT_SAMPLED","events":[],
                "errors":[],"shards_complete":0} for n in clients}
    states={}
    cohort=[]
    selection={}
    if anchor:
        first,last=anchor["first_block"],anchor["last_block"]
        for n,rpc in clients.items():
            sources[n]=scan_source(rpc,first,last)
        a,b=sources["drpc"],sources["publicnode"]
        if a["status"]==b["status"]=="COMPLETE_CANONICAL_BORROW_EVENT_SOURCE":
            if (a["starting_head"] == b["starting_head"] and
                    a["ending_head"] == b["ending_head"] and
                    a["events"] == b["events"]):
                cohort,selection=select_cohort(a["events"])
                anchor["pinned_end_head"]=a["ending_head"]
                if now_ts-anchor["pinned_end_head"]["timestamp"]<0 or \
                   now_ts-anchor["pinned_end_head"]["timestamp"]>MAX_HEADER_STALENESS:
                    failures.append({"stage":"state","error":"SOURCE_HEADER_STALE_OR_FUTURE"})
                elif cohort:
                    for n,rpc in clients.items():
                        try:
                            states[n]={"status":"COMPLETE_STATE",
                                       "accounts":assess_accounts(rpc,a["ending_head"],cohort)}
                        except Exception as exc:
                            states[n]={"status":"INCOMPLETE_STATE","accounts":[],
                                       "error":type(exc).__name__+":"+str(exc)[:180]}
                else:
                    states={n:{"status":"NO_BORROW_EVENTS",
                               "accounts":[]} for n in clients}
            else:
                failures.append({"stage":"log-parity","error":"CANONICAL_BORROW_LOG_MISMATCH"})
        else:
            failures.append({"stage":"logs","error":"BOTH_PROVIDERS_DID_NOT_COMPLETE_SOURCE"})
    out=make_report(anchor,sources["drpc"],sources["publicnode"],
                    cohort,selection,failures,states)
    for n,rpc in clients.items():
        out["source_reports"][n]["rpc_call_count"]=rpc.calls
        out["source_reports"][n]["rpc_transcript"]=rpc.transcript
    if not failures and sources["drpc"]["status"]=="COMPLETE_CANONICAL_BORROW_EVENT_SOURCE" and \
       sources["publicnode"]["status"]=="COMPLETE_CANONICAL_BORROW_EVENT_SOURCE":
        if not cohort:
            out["status"]="TWO_URL_ZERO_BORROW_EVENTS_ONLY_IN_FIXED_WINDOW"
            out["recent_borrow_event_count_quorum"]=0
            out["recent_borrower_count_quorum"]=0
            out["selected_recent_borrower_count_quorum"]=0
        elif states.get("drpc",{}).get("status")==states.get("publicnode",{}).get("status")=="COMPLETE_STATE":
            ar=states["drpc"]["accounts"]
            br=states["publicnode"]["accounts"]
            if ar==br and len(ar)==len(cohort):
                counts=[r["risk"]["status"] for r in ar]
                loan=[r for r in ar if int(r["risk"]["total_debt_base_raw"])>0]
                out["status"]="TWO_URL_RECENT_BORROW_COHORT_STATE_ONLY_NOT_P2"
                out["borrower_accounts_exact_two_url_parity"]=True
                out["recent_borrow_event_count_quorum"]=len(sources["drpc"]["events"])
                out["recent_borrower_count_quorum"]=selection["distinct_debt_receivers"]
                out["selected_recent_borrower_count_quorum"]=len(cohort)
                out["source_verified_hf_lt_one_count"]=counts.count(
                    "HF_LT_ONE_BORROWER_STATE_ONLY_NEEDS_ROUTE")
                out["source_verified_near_50bps_count"]=counts.count(
                    "HF_1_TO_1_005_PRIORITY_WATCH_ONLY")
                out["source_verified_near_200bps_count"]=sum(x in (
                    "HF_1_TO_1_005_PRIORITY_WATCH_ONLY",
                    "HF_1_005_TO_1_02_WATCH_ONLY") for x in counts)
                out["source_verified_near_1000bps_count"]=sum(x in (
                    "HF_1_TO_1_005_PRIORITY_WATCH_ONLY",
                    "HF_1_005_TO_1_02_WATCH_ONLY",
                    "HF_1_02_TO_1_10_WATCH_ONLY") for x in counts)
                out["source_verified_debt_active_count"]=len(loan)
                out["source_verified_no_debt_count"]=counts.count(
                    "NO_OUTSTANDING_DEBT_IN_PINNED_AAVE_SNAPSHOT")
                if loan:
                    lowest=min(loan,key=lambda x:int(x["risk"]["health_factor_wad"]))
                    out["most_at_risk_hf_wad"]=lowest["risk"]["health_factor_wad"]
                    out["most_at_risk_address"]=lowest["borrower"]
            else:
                out["errors"].append({"stage":"state-parity",
                                      "error":"ACCOUNT_OR_BLOCK_STATE_MISMATCH"})
    out["finished_at_utc"]=stamp()
    return out


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out",required=True,type=Path)
    a=p.parse_args()
    need(a.out.is_absolute() and a.out.parent.is_dir() and not a.out.exists(),
         "fresh absolute report path required")
    report=collect()
    with a.out.open("xb") as f:
        f.write(canon(report))
    print(report["status"],
          "source_events",report["recent_borrow_event_count_quorum"],
          "borrowers",report["recent_borrower_count_quorum"],
          "hf_below_one",report["source_verified_hf_lt_one_count"],
          "near_200bps",report["source_verified_near_200bps_count"],
          "errors",len(report["errors"]))
    return 0  # negative/partial is preserved evidence, never market closure


if __name__=="__main__":
    raise SystemExit(main())
