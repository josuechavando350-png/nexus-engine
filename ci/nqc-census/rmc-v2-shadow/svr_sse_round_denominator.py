#!/usr/bin/env python3
"""NQC PREINCLUSION-003: paired, bounded public SSE and canonical WETH rounds.
Only eth_call/getCode/headers and public Flashbots GET. No trade, signing, or bids.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
from pathlib import Path
import re
import time
from urllib.request import Request, urlopen

from svr_channel_access_probe import SSE_URL, clock, canonical, consume_sse, open_fixed, strict_json
from svr_hint_admission import WETH_AGGREGATOR

WETH_PROXY = "0x5424384b256154046e9667ddfaaa5e550145215e"
PROVIDERS = {"drpc":"https://eth.drpc.org", "publicnode":"https://ethereum-rpc.publicnode.com"}
AGGREGATOR_SELECTOR = "0x245a7bfc"
ROUND_SELECTOR = "0xfeaf968c"
MAX_SECONDS = 180
MAX_SSE_BYTES = 6_000_000
MAX_EVENTS = 5_000
MAX_RPC_BYTES = 250_000
MAX_RPC_CALLS = 36
HEX32 = re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEXQ = re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
HEXDATA = re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")

class Reject(ValueError):
    pass

def need(ok, why):
    if not ok:
        raise Reject(why)

def uint(raw):
    need(type(raw) is str and bool(HEXQ.fullmatch(raw)), "bad RPC quantity")
    return int(raw, 16)

def raw_data(raw, max_bytes=MAX_RPC_BYTES):
    need(type(raw) is str and bool(HEXDATA.fullmatch(raw)) and
         len(raw) <= 2 + 2*max_bytes, "invalid/oversized hex data")
    return bytes.fromhex(raw[2:])

def decode_round(raw):
    blob = raw_data(raw)
    need(len(blob) == 160, "latestRoundData not exactly five ABI words")
    a = [int.from_bytes(blob[i:i+32],"big") for i in range(0,160,32)]
    rid, answer, started, updated, answered = a
    if answer >= 2**255:
        answer -= 2**256
    need(rid>0 and answer>0 and started>0 and started<=updated and answered>=rid,
         "invalid feed round, signed price or time")
    return {"round_id":str(rid),"answer_raw":str(answer),
            "started_at":started,"updated_at":updated,
            "answered_in_round":str(answered)}

def decode_address(raw):
    blob=raw_data(raw)
    need(len(blob)==32,"bad address ABI")
    n=int.from_bytes(blob,"big")
    need(0<n<2**160,"zero/overflow address")
    return "0x"+f"{n:040x}"

def header(raw, expected):
    need(type(raw) is dict and uint(raw.get("number"))==expected,
         "canonical number mismatch")
    for key in ("hash","parentHash","stateRoot"):
        need(type(raw.get(key)) is str and HEX32.fullmatch(raw[key]),
             "bad canonical header "+key)
    ts=uint(raw.get("timestamp"))
    need(ts>0,"no canonical block timestamp")
    return {"number":expected,"hash":raw["hash"].lower(),
            "parent_hash":raw["parentHash"].lower(),
            "state_root":raw["stateRoot"].lower(),"timestamp":ts}

class ReadOnly:
    def __init__(self, label, transport=None, sleeper=time.sleep, monotonic=time.monotonic):
        need(label in PROVIDERS,"unapproved source")
        self.label=label
        self.transport=transport or self.http
        self.sleeper=sleeper
        self.monotonic=monotonic
        self.calls=0
        self.last=None
        self.transcript=[]

    @staticmethod
    def http(url, method, params):
        need(url in PROVIDERS.values(),"unapproved host")
        body=canonical({"jsonrpc":"2.0","id":133,"method":method,"params":params})
        need(len(body)<=2000,"RPC request too large")
        req=Request(url,data=body,method="POST",headers={
            "Content-Type":"application/json","User-Agent":"NQC-PREINCLUSION003-READONLY"})
        with urlopen(req,timeout=25) as response:
            need(response.geturl()==url and response.getcode()==200,
                 "redirect or non-200 HTTP blocked")
            data=response.read(MAX_RPC_BYTES+1)
        need(len(data)<=MAX_RPC_BYTES,"RPC response size limit")
        value=strict_json(data)
        need(type(value) is dict and value.get("jsonrpc")=="2.0" and
             value.get("id")==133 and "result" in value and "error" not in value,
             "malformed/failed RPC result")
        return value["result"]

    def call(self, method, params):
        need(self.calls<MAX_RPC_CALLS,"RPC hard call budget")
        if method in ("eth_chainId","eth_blockNumber"):
            need(params==[],"chain/tip takes zero args")
        elif method=="eth_getBlockByNumber":
            need(type(params) is list and len(params)==2 and
                 type(params[0]) is str and HEXQ.fullmatch(params[0]) and
                 params[1] is False,"only exact numbered Ethereum headers")
        elif method in ("eth_call","eth_getCode"):
            need(type(params) is list and len(params)==2 and
                 type(params[1]) is dict and
                 set(params[1])=={"blockHash","requireCanonical"} and
                 params[1]["requireCanonical"] is True and
                 type(params[1]["blockHash"]) is str and
                 HEX32.fullmatch(params[1]["blockHash"]), "must use canonical EIP-1898 block hash")
            if method=="eth_call":
                need(type(params[0]) is dict and set(params[0])=={"to","data"} and
                     (params[0]=={"to":WETH_PROXY,"data":AGGREGATOR_SELECTOR} or
                      params[0]=={"to":WETH_PROXY,"data":ROUND_SELECTOR} or
                      params[0]=={"to":WETH_AGGREGATOR,"data":ROUND_SELECTOR}),
                     "unapproved contract method")
            else:
                need(params[0] in (WETH_PROXY,WETH_AGGREGATOR),
                     "eth_getCode outside 2 predeclared contracts")
        else:
            raise Reject("Ethereum RPC write or arbitrary method forbidden")
        if self.last is not None:
            sleep_for=0.4-(self.monotonic()-self.last)
            if sleep_for>0:self.sleeper(sleep_for)
        self.last=self.monotonic()
        self.calls+=1
        started=clock()
        row={"provider":self.label,"method":method,"request_utc_ns":started["utc_ns"],
             "params_sha256":sha256(canonical(params)).hexdigest()}
        try:
            value=self.transport(PROVIDERS[self.label],method,params)
            row["response_sha256"]=sha256(canonical(value)).hexdigest()
            return value
        except Exception as exc:
            row["error_type"]=type(exc).__name__
            raise
        finally:
            row["elapsed_monotonic_ns"]=clock()["monotonic_ns"]-started["monotonic_ns"]
            self.transcript.append(row)

def pair(clients,method,params):
    left=clients["drpc"].call(method,params)
    right=clients["publicnode"].call(method,params)
    need(left==right,"dual-public-source response mismatch "+method)
    return left

def snapshot(clients):
    need(set(clients)==set(PROVIDERS),"two public sources mandatory")
    chain=[uint(c.call("eth_chainId",[])) for c in clients.values()]
    need(chain==[1,1],"not mainnet Ethereum")
    tips=[uint(c.call("eth_blockNumber",[])) for c in clients.values()]
    need(max(tips)-min(tips)<=3,"RPC height divergence")
    height=min(tips)-2
    need(height>0,"no safe block")
    selected=header(pair(clients,"eth_getBlockByNumber",[hex(height),False]),height)
    pin={"blockHash":selected["hash"],"requireCanonical":True}
    resolved=decode_address(pair(clients,"eth_call",[
        {"to":WETH_PROXY,"data":AGGREGATOR_SELECTOR},pin]))
    need(resolved==WETH_AGGREGATOR,"registered WETH aggregator no longer canonical")
    for contract in (WETH_PROXY,WETH_AGGREGATOR):
        code=raw_data(pair(clients,"eth_getCode",[contract,pin]),70_000)
        need(0<len(code)<=70_000,"missing or oversized onchain runtime")
    proxy=decode_round(pair(clients,"eth_call",[
        {"to":WETH_PROXY,"data":ROUND_SELECTOR},pin]))
    agg=decode_round(pair(clients,"eth_call",[
        {"to":WETH_AGGREGATOR,"data":ROUND_SELECTOR},pin]))
    need(proxy["answer_raw"]==agg["answer_raw"] and
         proxy["updated_at"]==agg["updated_at"],
         "onchain proxy/aggregator price/time mismatch")
    need(0<proxy["updated_at"]<=selected["timestamp"],
         "future oracle timestamp")
    again=header(pair(clients,"eth_getBlockByNumber",[hex(height),False]),height)
    need(selected==again,"header changed/reorg")
    return {"block":selected,"proxy_round":proxy,"aggregator_round":agg,
            "same_block_two_RPC_parity":True,"sealed":clock()}

def classify(before,after,sse):
    if not before or not after:
        return "INCOMPLETE_MISSING_BOOKEND_SNAPSHOT"
    if after["block"]["number"]<=before["block"]["number"]:
        return "INCOMPLETE_NO_FORWARD_CANONICAL_HEIGHT"
    old,new=before["proxy_round"],after["proxy_round"]
    if int(new["round_id"])<int(old["round_id"]) or new["updated_at"]<old["updated_at"]:
        return "INCOMPLETE_FEED_ROUND_REGRESSION"
    if new["round_id"]==old["round_id"] and new["updated_at"]==old["updated_at"]:
        return "NO_WETH_ROUND_ADVANCE_BETWEEN_PINNED_BOOKENDS"
    if not sse or sse.get("status")!="PROSPECTIVE_SOURCE_LOCAL_HINTS_OBSERVED_NOT_PREINCLUSION_PROOF":
        return "WETH_FEED_CHANGED_BUT_SSE_OBSERVATION_CENSORED"
    return "WETH_FEED_CHANGED_IN_BOOKENDS_NOT_PREINCLUSION_PROOF"

def run(out:Path,*,sources=None,live_opener=None,seconds=180):
    need(type(seconds) is int and 60<=seconds<=MAX_SECONDS,
         "unbounded observation duration")
    need(not out.exists() and out.parent.is_dir(),
         "output must be fresh with existing parent")
    out.mkdir()
    freeze={
        "schema_version":1,"target_proxy":WETH_PROXY,
        "target_aggregator":WETH_AGGREGATOR,
        "pinned_public_RPC_providers":sorted(PROVIDERS),
        "fixed_SSE_url":SSE_URL,
        "SSE_max_seconds":seconds,"SSE_max_bytes":MAX_SSE_BYTES,
        "SSE_max_data_messages":MAX_EVENTS,
        "no_wallet_bids_sends_or_gas":True,
        "frozen_before_first_network":clock(),
    }
    (out/"source-precommit.json").write_bytes(canonical(freeze))
    report={
        "schema_version":1,"source_precommit_sha256":sha256(canonical(freeze)).hexdigest(),
        "before":None,"after":None,"sse":None,
        "status":"INCOMPLETE_MISSING_BOOKEND_SNAPSHOT","source_errors":[],
        "SSE_is_private_SVR_access_certificate":False,
        "first_seen_before_builder_cutoff_proven":False,
        "liquidation_capture_or_net_ev_proven":False,
        "gas_financing_without_recourse_proven":False,
        "realized_NQC_USD":"0","PFT_closed":True,"RMC_closed":False,
        "Shadow_certified":False,"canary_or_live_authorized":False}
    readers=sources if sources is not None else {p:ReadOnly(p) for p in PROVIDERS}
    try:
        report["before"]=snapshot(readers)
        with (live_opener() if live_opener else open_fixed(SSE_URL,stream=True)) as stream:
            report["sse"]=consume_sse(stream,max_seconds=seconds,
                    max_bytes=MAX_SSE_BYTES,max_events=MAX_EVENTS)
        report["after"]=snapshot(readers)
        report["status"]=classify(report["before"],report["after"],report["sse"])
    except Exception as e:
        report["source_errors"].append({"error_type":type(e).__name__,
                                        "classification":"SOURCE_INCOMPLETE"})
        report["status"]="INCOMPLETE_SOURCE_OR_CANONICAL_QUORUM"
    report["source_rpc_calls"]={label:c.calls for label,c in readers.items()}
    report["source_transcripts"]={label:c.transcript for label,c in readers.items()}
    report["finished"]=clock()
    (out/"round-denominator.json").write_bytes(canonical(report))
    return report

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--seconds",type=int,default=180)
    opts=parser.parse_args()
    r=run(opts.out,seconds=opts.seconds)
    print("PREINCLUSION-003",r["status"],
          "rounds", (r["before"] or {}).get("proxy_round",{}).get("round_id"),
          (r["after"] or {}).get("proxy_round",{}).get("round_id"),
          "SSE messages",(r["sse"] or {}).get("sse_data_messages"),
          "target hints",(r["sse"] or {}).get("decoded_target_unauthenticated"),
          "errors",len(r["source_errors"]))
