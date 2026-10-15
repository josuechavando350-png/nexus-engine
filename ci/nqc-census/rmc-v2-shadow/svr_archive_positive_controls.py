#!/usr/bin/env python3
"""NQC PREINCLUSION-004 — immutable onchain SVR-positive controls vs public MEV-Share archive.

The scope is read-only; archive is retrospective and cannot demonstrate prospective
first-seen, builder cutoff, winning inclusion, financing or profitability.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, parse_qsl
from urllib.request import Request, urlopen

from svr_hint_admission import (WETH_AGGREGATOR, FORWARD_SELECTOR,
                                decode_forward, decode_secondary, inspect_event)
from svr_channel_access_probe import canonical, clock, strict_json

# Frozen before any RPC/MEV-Share read, from a 2026-10-14 Blockscout source-index query.
# Internal calls to DualAggregator.transmitSecondary, NOT inferred profitable liquidations.
POSITIVE = (
    {"label":"2026-10-14-22-10", "block":26193643, "index":1,
     "tx_hash":"0x8a25a63c628cca85d613e577bfbd0f89d9c5a0112c409abf1f5474b0d96ab8da"},
    {"label":"2026-10-14-23-11", "block":26193944, "index":287,
     "tx_hash":"0x53de29056359c29351d353fff7542daf50416053842385e9cb6013834140dc40"},
)
RPCS={"drpc":"https://eth.drpc.org", "publicnode":"https://ethereum-rpc.publicnode.com"}
# Existing NQC PR694/PR700 historically used the legitimate public BlastAPI RPC.
# This is only a predeclared ALTERNATIVE after PublicNode returned JSON-RPC null
# for the original economic-causal oracle TX0; never retry denied access.
BLAST_PUBLIC_URL="https://eth-mainnet.public.blastapi.io"
MEV_SHARE="https://mev-share.flashbots.net"
HISTORY_INFO=MEV_SHARE+"/api/v1/history/info"
HISTORY=MEV_SHARE+"/api/v1/history"
SECONDARY_TOPIC="0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b"
PRIMARY_TOPIC="0xc797025feeeaf2cd924c99e9205acb8ec04d5cad21c41ce637a38fb6dee6016a"
ROUND_SELECTOR="0xfeaf968c"
MAX_RPC_CALLS=18
MAX_HISTORY_PAGES=4
MAX_HISTORY_ROWS=1600
MAX_HISTORY_BODY_BYTES=8_000_000
MAX_RECEIPT_LOGS=2000
MIN_REQUEST_GAP_SEC=0.35
HEX32=re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEXQ=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
HEXBLOB=re.compile(r"0x(?:[0-9a-fA-F]{2})*\Z")

# Ethereum Keccak-f[1600], originally separately source-tested by NQC one-shot.
_RC=(
  0x0000000000000001,0x0000000000008082,0x800000000000808a,0x8000000080008000,
  0x000000000000808b,0x0000000080000001,0x8000000080008081,0x8000000000008009,
  0x000000000000008a,0x0000000000000088,0x0000000080008009,0x000000008000000a,
  0x000000008000808b,0x800000000000008b,0x8000000000008089,0x8000000000008003,
  0x8000000000008002,0x8000000000000080,0x000000000000800a,0x800000008000000a,
  0x8000000080008081,0x8000000000008080,0x0000000080000001,0x8000000080008008,
)
_RHO=((0,1,62,28,27),(36,44,6,55,20),(3,10,43,25,39),
      (41,45,15,21,8),(18,2,61,56,14))
_MASK=(1<<64)-1

class Rejected(ValueError):pass

def require(ok,why):
    if not ok:raise Rejected(why)

def keccak256(data:bytes)->bytes:
    require(type(data) is bytes and len(data)<=2048,"keccak input too long/invalid")
    def rol(x,n):return (((x<<n)|(x>>(64-n)))&_MASK) if n else x
    padded=bytearray(data);padded.append(1)
    while len(padded)%136!=135:padded.append(0)
    padded.append(0x80);a=[0]*25
    for start in range(0,len(padded),136):
        for i in range(17):a[i]^=int.from_bytes(padded[start+8*i:start+8*i+8],"little")
        for rc in _RC:
            c=[a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20] for x in range(5)]
            for x in range(5):
                d=c[(x-1)%5]^rol(c[(x+1)%5],1)
                for y in range(5):a[x+y*5]^=d
            b=[0]*25
            for x in range(5):
                for y in range(5):b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y],_RHO[y][x])
            for x in range(5):
                for y in range(5):a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y])
            a[0]^=rc
    return b"".join(a[i].to_bytes(8,"little") for i in range(4))

def bytes32(v):
    require(type(v) is str and HEX32.fullmatch(v),"invalid hash")
    return v.lower()

def quantity(v):
    require(type(v) is str and HEXQ.fullmatch(v),"invalid quantity")
    return int(v,16)

def canonical_header(obj,expected_height):
    require(type(obj) is dict and quantity(obj.get("number"))==expected_height,
            "header height mismatch")
    for k in ("hash","parentHash","stateRoot"):
        bytes32(obj.get(k))
    ts=quantity(obj.get("timestamp"))
    require(ts>0,"invalid canonical timestamp")
    return {"number":expected_height,"hash":obj["hash"].lower(),
            "parent_hash":obj["parentHash"].lower(),
            "state_root":obj["stateRoot"].lower(),"timestamp":ts}

def decode_round(raw):
    require(type(raw) is str and HEXBLOB.fullmatch(raw) and len(raw)==322,
            "latestRoundData expected 160 bytes")
    buf=bytes.fromhex(raw[2:])
    w=[int.from_bytes(buf[i:i+32],"big") for i in range(0,160,32)]
    rid,ans,started,updated,answered=w
    if ans>=2**255:ans-=2**256
    require(rid>0 and ans>0 and started>0 and started<=updated and answered>=rid,
            "unusable canonical feed price")
    return {"round_id":str(rid),"answer_raw":str(ans),"updated_at":updated}

class RPC:
    def __init__(self,label,transport=None,monotonic=time.monotonic,sleeper=time.sleep,*,controls=POSITIVE):
        require(label in RPCS or label=="blast","unapproved provider")
        self.label=label;self.url=BLAST_PUBLIC_URL if label=="blast" else RPCS[label]
        self.transport=transport or self._real
        self.monotonic=monotonic;self.sleeper=sleeper
        self.calls=0;self.last=None;self.pins=set();self.transcript=[]
        self.controls=tuple(controls)
        self.mismatch_ledger=[]

    @staticmethod
    def _real(url,method,params):
        require(url in tuple(RPCS.values())+(BLAST_PUBLIC_URL,),"unapproved source URL")
        body=canonical({"jsonrpc":"2.0","id":404,"method":method,"params":params})
        require(len(body)<=1200,"RPC request too large")
        req=Request(url,data=body,method="POST",headers={"Content-Type":"application/json",
                              "User-Agent":"NQC-PREINCLUSION004-READONLY/1"})
        with urlopen(req,timeout=24) as h:
            require(h.geturl()==url and h.getcode()==200,"redirect/non-200 RPC response")
            raw=h.read(2_000_001)
        require(len(raw)<=2_000_000,"RPC response cap")
        doc=strict_json(raw)
        require(type(doc) is dict and doc.get("id")==404 and doc.get("jsonrpc")=="2.0"
                and "error" not in doc and "result" in doc,"malformed/rate-limited RPC")
        return doc["result"]

    def call(self,method,params):
        require(self.calls<MAX_RPC_CALLS,"RPC bounded call ceiling")
        if method=="eth_chainId":require(params==[],"chain id args forbidden")
        elif method=="eth_getBlockByNumber":
            require(type(params) is list and len(params)==2 and
                    params[1] is False and type(params[0]) is str and
                    HEXQ.fullmatch(params[0]) and int(params[0],16) in
                    {b+offset for b in (q["block"] for q in self.controls) for offset in (0,-1)},
                    "unapproved header height")
        elif method in ("eth_getTransactionReceipt","eth_getTransactionByHash"):
            require(type(params) is list and len(params)==1 and
                    params[0] in [q["tx_hash"] for q in self.controls],
                    "arbitrary transaction query forbidden")
        elif method=="eth_call":
            require(type(params) is list and len(params)==2 and params[0]==
                    {"to":WETH_AGGREGATOR,"data":ROUND_SELECTOR} and
                    type(params[1]) is dict and
                    params[1].get("requireCanonical") is True and
                    set(params[1])=={"blockHash","requireCanonical"} and
                    params[1]["blockHash"] in self.pins,
                    "only canonical pinned WETH aggregator round allowed")
        else:raise Rejected("Ethereum method not read-only allowlisted")
        if self.last is not None:
            remain=MIN_REQUEST_GAP_SEC-(self.monotonic()-self.last)
            if remain>0:self.sleeper(remain)
        self.last=self.monotonic();self.calls+=1
        beg=clock();entry={"source":self.label,"method":method,
                           "request_sha256":sha256(canonical(params)).hexdigest()}
        try:
            value=self.transport(self.url,method,params)
            entry["result_sha256"]=sha256(canonical(value)).hexdigest()
            return value
        except Exception as error:
            entry["error_type"]=type(error).__name__
            raise
        finally:
            entry["elapsed_monotonic_ns"]=clock()["monotonic_ns"]-beg["monotonic_ns"]
            self.transcript.append(entry)

def sanitized_mismatch(method,a,b,*,peer="publicnode"):
    """Only mismatching FIELD NAMES and content hashes; no private source payload."""
    entry={"method":method,"second_provider":peer,"source_values_bitwise_identical":False,
           "drpc_result_sha256":sha256(canonical(a)).hexdigest(),
           "secondary_provider_result_sha256":sha256(canonical(b)).hexdigest(),
           "canonical_authority_promoted":False}
    if type(a) is not dict or type(b) is not dict:
        entry["shape"]="NOT_TWO_DICTIONARIES"
        return entry
    keys_a=set(a);keys_b=set(b)
    entry["only_drpc_fields"]=sorted(keys_a-keys_b)
    entry["only_secondary_provider_fields"]=sorted(keys_b-keys_a)
    entry["changed_shared_fields"]=sorted(k for k in keys_a&keys_b if a[k]!=b[k])
    important=("transactionHash","blockHash","blockNumber","transactionIndex",
               "status","gasUsed","effectiveGasPrice")
    entry["required_receipt_fields_identical"]=(
        all(k in a and k in b and a[k]==b[k] for k in important))
    if method=="eth_getTransactionReceipt" and type(a.get("logs")) is list and type(b.get("logs")) is list:
        la,lb=a["logs"],b["logs"]
        entry["drpc_log_count"]=len(la)
        entry["publicnode_log_count"]=len(lb)
        changed=[]
        for i in range(min(len(la),len(lb),20)):
            x,y=la[i],lb[i]
            if type(x) is dict and type(y) is dict:
                changed.append({"log_position":i,
                                "changed_keys":sorted(k for k in set(x)&set(y) if x[k]!=y[k]),
                                "only_drpc_keys":sorted(set(x)-set(y)),
                                "only_secondary_provider_keys":sorted(set(y)-set(x))})
            elif x!=y:
                changed.append({"log_position":i,"different_log_shape":True})
        entry["log_field_deltas"]=[x for x in changed if x.get("changed_keys") or
            x.get("only_drpc_keys") or x.get("only_secondary_provider_keys") or x.get("different_log_shape")]
        entry["logs_compared_up_to_first_20"] = True
    return entry


def same(clients,method,params):
    require(set(clients) in ({"drpc","publicnode"},{"drpc","blast"}),
            "unauthorized dual RPC source pairing")
    peer="blast" if "blast" in clients else "publicnode"
    a=clients["drpc"].call(method,params)
    b=clients[peer].call(method,params)
    if a!=b:
        row=sanitized_mismatch(method,a,b,peer=peer)
        for c in clients.values():
            if not hasattr(c,"mismatch_ledger"):
                c.mismatch_ledger=[]
            c.mismatch_ledger.append(row)
        raise Rejected("dual-RPC source disagreement on "+method)
    return a

def verified_transaction(control,clients):
    height,txhash=control["block"],control["tx_hash"]
    heads={}
    for h in (height-1,height):
        heads[h]=canonical_header(same(clients,"eth_getBlockByNumber",[hex(h),False]),h)
        for client in clients.values():client.pins.add(heads[h]["hash"])
    receipt=same(clients,"eth_getTransactionReceipt",[txhash])
    require(type(receipt) is dict and
            bytes32(receipt.get("transactionHash"))==txhash and
            bytes32(receipt.get("blockHash"))==heads[height]["hash"] and
            quantity(receipt.get("blockNumber"))==height and
            quantity(receipt.get("transactionIndex"))==control["index"] and
            quantity(receipt.get("status"))==1,
            "canonical source receipt identity/status mismatch")
    logs=receipt.get("logs")
    require(type(logs) is list and len(logs)<=MAX_RECEIPT_LOGS,
            "invalid/unbounded source receipt logs")
    relevant=[log for log in logs if type(log) is dict and
              log.get("address","").lower()==WETH_AGGREGATOR and
              type(log.get("topics")) is list and log["topics"] and
              log["topics"][0].lower() in (SECONDARY_TOPIC,PRIMARY_TOPIC)]
    require(len(relevant)>0,"no authenticated WETH DualAggregator price update event")
    for log in relevant:
        require(bytes32(log["blockHash"])==heads[height]["hash"] and
                bytes32(log["transactionHash"])==txhash and
                quantity(log["blockNumber"])==height and
                log.get("removed") in (None,False),"oracle receipt log identity mismatch")
    tx=same(clients,"eth_getTransactionByHash",[txhash])
    require(type(tx) is dict and tx.get("hash","").lower()==txhash and
            tx.get("blockHash","").lower()==heads[height]["hash"] and
            quantity(tx.get("blockNumber"))==height and
            quantity(tx.get("transactionIndex"))==control["index"],
            "canonical tx mismatched receipt")
    calldata=tx.get("input")
    report=None
    if type(calldata) is str and HEXBLOB.fullmatch(calldata) and len(calldata)<=2*100000+2:
        try:
            address,nested=decode_forward(bytes.fromhex(calldata[2:]))
            if address==WETH_AGGREGATOR:
                report=decode_secondary(nested)
        except (ValueError,OverflowError,TypeError):
            pass
    prices={}
    for h in (height-1,height):
        prices[h]=decode_round(same(clients,"eth_call",[
            {"to":WETH_AGGREGATOR,"data":ROUND_SELECTOR},
            {"blockHash":heads[h]["hash"],"requireCanonical":True}]))
    # Recheck original heads to reject any reorg in the evidence interval.
    for h in (height-1,height):
        require(canonical_header(same(clients,"eth_getBlockByNumber",[hex(h),False]),h)==heads[h],
                "canonical block reorg during verification")
    return {"label":control["label"],"tx_hash":txhash,"block_number":height,
            "canonical_tx_block_timestamp":heads[height]["timestamp"],
            "canonical_prior_block_timestamp":heads[height-1]["timestamp"],
            "canonical_block_hash":heads[height]["hash"],
            "oracle_topics":sorted(set(z["topics"][0].lower() for z in relevant)),
            "oracle_logs":len(relevant),"canonical_receipt_verified":True,
            "tx_input_forwarded_report_decoded":report is not None,
            "report_median_raw":report["median_signed_int192_raw"] if report else None,
            "price_before":prices[height-1],"price_after":prices[height],
            "round_advanced":prices[height-1]["round_id"]!=prices[height]["round_id"] or
                             prices[height-1]["updated_at"]!=prices[height]["updated_at"],
            "feed_report_median_matches_after_if_decoded":
               report["median_signed_int192_raw"]==prices[height]["answer_raw"] if report else None,
            "expected_event_double_keccak":"0x"+keccak256(bytes.fromhex(txhash[2:])).hex()}

class Archive:
    def __init__(self,opener=urlopen,monotonic=time.monotonic,sleeper=time.sleep,*,controls=POSITIVE,max_pages=MAX_HISTORY_PAGES):
        self.opener=opener;self.monotonic=monotonic;self.sleeper=sleeper
        self.last=None;self.calls=0;self.log=[]
        self.controls=tuple(controls)
        require(type(max_pages) is int and 1<=max_pages<=8,"invalid archival page budget")
        self.max_pages=max_pages

    def get(self,url):
        if url != HISTORY_INFO:
            parsed=urlsplit(url)
            require(parsed.scheme=="https" and parsed.netloc=="mev-share.flashbots.net" and
                    parsed.path=="/api/v1/history" and not parsed.fragment,
                    "unapproved archive endpoint")
            pairs=parse_qsl(parsed.query,keep_blank_values=True)
            require(len(pairs)==4 and len({k for k,v in pairs})==4 and
                    set(k for k,v in pairs)=={"blockStart","blockEnd","limit","offset"} and
                    all(v.isascii() and v.isdecimal() for k,v in pairs),
                    "unapproved or duplicated archive parameters")
            args={k:int(v) for k,v in pairs}
            require(args["blockStart"] in {c["block"]-8 for c in self.controls} and
                    args["blockEnd"]==args["blockStart"]+9 and
                    1<=args["limit"]<=400 and
                    args["offset"]%args["limit"]==0 and
                    args["offset"]//args["limit"]<self.max_pages,
                    "archive request outside fixed positive-control windows")
        require(self.calls<1+self.max_pages*len(self.controls),"archive request hard budget")
        if self.last is not None:
            lag=0.4-(self.monotonic()-self.last)
            if lag>0:self.sleeper(lag)
        self.last=self.monotonic();self.calls+=1
        req=Request(url,method="GET",headers={"Accept":"application/json",
               "User-Agent":"NQC-PREINCLUSION004-HISTORICAL/1"})
        entry={"path":url[len(MEV_SHARE):].split("?")[0],
               "params_sha256":sha256(url.encode()).hexdigest()}
        try:
            with self.opener(req,timeout=20) as handle:
                require(handle.geturl()==url and handle.getcode()==200,
                        "unapproved redirect/non-200 HTTP archive")
                raw=handle.read(MAX_HISTORY_BODY_BYTES+1)
            require(len(raw)<=MAX_HISTORY_BODY_BYTES,"archive response bytes cap")
            entry["response_sha256"]=sha256(raw).hexdigest()
            return strict_json(raw)
        except Exception as e:
            entry["error_type"]=type(e).__name__
            entry["http_status"]=getattr(e,"code",None)
            raise
        finally:self.log.append(entry)

    def info(self):
        data=self.get(HISTORY_INFO)
        require(type(data) is dict and all(type(data.get(k)) is int for k in
                ("minBlock","maxBlock","maxLimit")) and
                0<=data["minBlock"]<=data["maxBlock"] and 1<=data["maxLimit"]<=100000,
                "invalid archived-range metadata")
        return {k:data[k] for k in ("minBlock","maxBlock","maxLimit")}

    def inspect(self,control,meta):
        height=control["block_number"]
        lo,hi=height-8,height+1
        result={"block_start":lo,"block_end":hi,"page_count":0,"hint_rows":0,
                "hint_rows_with_forward_selector":0,"hint_rows_with_complete_forward_calldata":0,
                "target_report_decoded_unauthenticated":0,"exact_double_hash_matches":0,
                "matching_double_hash_with_decodable_target":0,
                "matching_double_hash_hint_partial":0,
                "matching_archive_source_timings":[],"matching_timings_truncated":False,
                "archive_complete_in_bounded_range":False,
                "status":"INCOMPLETE_ARCHIVE_SCOPE_NOT_VERIFIED"}
        if not meta["minBlock"]<=lo or not meta["maxBlock"]>=hi:
            result["status"]="INCOMPLETE_TARGET_RANGE_NOT_ARCHIVED"
            return result
        limit=min(400,meta["maxLimit"])
        for p in range(self.max_pages):
            query=urlencode({"blockStart":lo,"blockEnd":hi,
                             "limit":limit,"offset":p*limit})
            rows=self.get(HISTORY+"?"+query)
            require(type(rows) is list and len(rows)<=limit,
                    "unbounded/malformed archive page")
            result["page_count"]+=1
            result["hint_rows"]+=len(rows)
            for row in rows:
                require(type(row) is dict and type(row.get("block")) is int and
                        lo<=row["block"]<=hi and type(row.get("timestamp")) is int and
                        row["timestamp"]>0,
                        "archive row outside frozen historical range")
                hint=row.get("hint")
                if type(hint) is not dict:
                    continue
                txs=hint.get("txs")
                if type(txs) is list:
                    for tx in txs[:16]:
                        if type(tx) is not dict:continue
                        sel=tx.get("functionSelector")
                        if type(sel) is str and sel.lower().removeprefix("0x")==FORWARD_SELECTOR.hex():
                            result["hint_rows_with_forward_selector"]+=1
                            result["hint_rows_with_complete_forward_calldata"]+= (
                                type(tx.get("callData")) is str and len(tx["callData"])>10)
                # MEV-Share event hash is Keccak(tx hash); it is not a receipt tx hash.
                match=(hint.get("hash","").lower()==control["expected_event_double_keccak"])
                if match:result["exact_double_hash_matches"]+=1
                clean_hint={"hash":hint.get("hash"),"txs":hint.get("txs")}
                verdict=inspect_event(canonical(clean_hint).strip())
                if verdict["result"]=="TARGET_PRICE_DECODED_UNAUTHENTICATED":
                    result["target_report_decoded_unauthenticated"]+=1
                    if match:result["matching_double_hash_with_decodable_target"]+=1
                elif match:
                    result["matching_double_hash_hint_partial"]+=1
                if match:
                    # Historical source timestamps are NOT process first-seen or builder cutoff.
                    price_confirmed=(verdict["report"]["median_signed_int192_raw"]==
                       control["report_median_raw"]
                       if verdict["result"]=="TARGET_PRICE_DECODED_UNAUTHENTICATED" and
                          type(control.get("report_median_raw")) is str else None)
                    timing={
                        "archive_tip_block_when_hint_generated":row["block"],
                        "archive_source_timestamp_epoch":row["timestamp"],
                        "included_consensus_block_timestamp_epoch":control.get("canonical_tx_block_timestamp"),
                        "source_archive_tip_before_included_height":row["block"]<height,
                        "nominal_included_slot_minus_source_timestamp_seconds":(
                           control["canonical_tx_block_timestamp"]-row["timestamp"]
                           if type(control.get("canonical_tx_block_timestamp")) is int else None),
                        "hint_price_matches_onchain_transmit_report":price_confirmed,
                        "NQC_process_first_seen_proven":False,
                        "actual_builder_cutoff_known":False,
                    }
                    if len(result["matching_archive_source_timings"])<8:
                        result["matching_archive_source_timings"].append(timing)
                    else:result["matching_timings_truncated"]=True
            if len(rows)<limit:
                result["archive_complete_in_bounded_range"]=True
                result["status"]="BOUNDED_PUBLIC_ARCHIVE_EXHAUSTED_NOT_PRIVATE_ACCESS"
                return result
        result["status"]="INCOMPLETE_ARCHIVE_PAGINATION_CAP"
        return result

def run(out:Path,*,rpc_clients=None,archive=None,controls=POSITIVE,require_decrease=False):
    require(out.is_absolute() and not out.exists() and out.parent.is_dir(),
            "fresh absolute output path expected")
    out.mkdir()
    controls=tuple(controls)
    require(len(controls)==2 and len({q["tx_hash"] for q in controls})==2,
            "exactly two distinct predeclared controls required")
    source={"schema_version":1,"predeclared_blockscout_secondary_controls":list(controls),
            "target":WETH_AGGREGATOR,
            "public_rpc_provider_ids":["drpc","blast"] if require_decrease else list(RPCS),
            "excluded_publicnode_null_receipt_first_attempt":require_decrease,
            "history_source":MEV_SHARE,"require_decreasing_price":require_decrease,
            "max_history_pages_per_control":8 if require_decrease else MAX_HISTORY_PAGES,
            "max_history_rows_per_control":3200 if require_decrease else MAX_HISTORY_ROWS,"read_only":True,
            "created_before_network":clock()}
    (out/"source-precommit.json").write_bytes(canonical(source))
    result={"schema_version":1,"precommit_sha256":sha256(canonical(source)).hexdigest(),
            "status":"INCOMPLETE_SOURCE_CONTROLS","positive_controls":[],
            "archive":[],"source_errors":[],"source_call_log":{},"archive_calls":[],
            "private_first_seen_proven":False,"builder_cutoff_proven":False,
            "bundles_or_bids_submitted":False,"win_inclusion_proven":False,
            "nonrecourse_native_gas_funded":False,"net_pnl_proven":False,
            "RMC_closed":False,"shadow_certified":False,"live_authorized":False,
            "nqc_realized_pnl_usd":"0"}
    clients=rpc_clients if rpc_clients is not None else {
        s:RPC(s,controls=controls) for s in
        (["drpc","blast"] if require_decrease else list(RPCS))}
    archive=archive if archive is not None else Archive(controls=controls,max_pages=8 if require_decrease else MAX_HISTORY_PAGES)
    try:
        require(set(clients)==({"drpc","blast"} if require_decrease else set(RPCS)),
                "required exactly two declared provider identities")
        require(all(quantity(x.call("eth_chainId",[]))==1 for x in clients.values()),
                "Ethereum mainnet identity mismatch")
        for control in controls:
            verified=verified_transaction(control,clients)
            if require_decrease:
                initial=int(verified["price_before"]["answer_raw"])
                final=int(verified["price_after"]["answer_raw"])
                require(verified["round_advanced"] and initial>final>0,
                        "historical source did not cause a lower canonical WETH price")
                require(verified["feed_report_median_matches_after_if_decoded"] is not False,
                        "decoded report contradicts canonical price")
            result["positive_controls"].append(verified)
        result["status"]="ONCHAIN_POSITIVE_CONTROLS_CERTIFIED_ARCHIVE_PENDING"
        meta=archive.info()
        result["archive_info"]={"minBlock":meta["minBlock"],
                                 "maxBlock":meta["maxBlock"],"maxLimit":meta["maxLimit"]}
        for control in result["positive_controls"]:
            result["archive"].append(archive.inspect(control,meta))
        result["status"]=("ONCHAIN_CONTROLS_AND_ARCHIVE_BOUNDED_READ_COMPLETE_NO_PROSPECTIVE_AUTHORITY"
                          if all(a["archive_complete_in_bounded_range"] for a in result["archive"])
                          else "INCOMPLETE_ARCHIVE_COVERAGE_NOT_ABSENCE")
    except Exception as exc:
        result["source_errors"].append({"type":type(exc).__name__,
                                        "stage":"onchain_or_archive_source"})
        if result["positive_controls"]:
            result["status"]="INCOMPLETE_POST_ONCHAIN_ARCHIVE_READ"
        else:
            result["status"]="INCOMPLETE_SOURCE_CONTROLS"
    result["source_call_log"]={s:{"call_count":c.calls,"log":c.transcript,
            "sanitized_mismatch_ledger":getattr(c,"mismatch_ledger",[])}
            for s,c in clients.items()}
    result["archive_calls"]=archive.log
    result["finished"]=clock()
    (out/"oracle-to-mev-share-archive-witness.json").write_bytes(canonical(result))
    return result

if __name__=="__main__":
    ap=argparse.ArgumentParser()
    ap.add_argument("--out",required=True,type=Path)
    cfg=ap.parse_args()
    d=run(cfg.out)
    print("PREINCLUSION-004",d["status"],"verified_receipts",len(d["positive_controls"]),
          "archive_rows",[x["hint_rows"] for x in d["archive"]],
          "matched_double_hashes",[x["exact_double_hash_matches"] for x in d["archive"]],
          "target_decoded",[x["target_report_decoded_unauthenticated"] for x in d["archive"]],
          "errors",len(d["source_errors"]))
