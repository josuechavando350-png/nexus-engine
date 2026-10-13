#!/usr/bin/env python3
"""NQC V2 sniper: one real, read-only, prospective Aave account observation.

Only eth_chainId, eth_blockNumber, eth_getBlockByNumber and eth_call. No keys,
wallets, transactions, broadcasting, eth_sendRawTransaction, signing or gas
payments. One run is a *sample*, not a 24/7 service, liquidatability certificate,
P2 Shadow capture or projected profit.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import re
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

CHAIN_ID=1
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
SELECTOR="bf92857c"  # Aave getUserAccountData(address)
WAD=10**18
EXPECTED_FIELDS=("total_collateral_base","total_debt_base",
                 "available_borrows_base","liquidation_threshold_bps",
                 "ltv_bps","health_factor_wad")
HEX_HASH=re.compile(r"0x[0-9a-fA-F]{64}\Z")
HEX_ADDR=re.compile(r"0x[0-9a-fA-F]{40}\Z")
HEX_NUM=re.compile(r"0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)\Z")
READ_METHODS=frozenset(("eth_chainId","eth_blockNumber",
                        "eth_getBlockByNumber","eth_call"))
SOURCES={
    "drpc":("dRPC","https://eth.drpc.org"),
    "publicnode":("PublicNode","https://ethereum-rpc.publicnode.com"),
    "blast":("BlastAPI","https://eth-mainnet.public.blastapi.io"),
    "mevblocker":("MEV Blocker","https://rpc.mevblocker.io"),
}
# Each identity originates from Aave or the RMC016 historical competitor
# time-only witness. These are NOT a complete borrower discovery index.
BORROWERS={
    "emode24_susde_usdtb":{
        "address":"0x08c14b32c8a48894e4b933090ebcc9ce33b21135",
        "origin":"NQC_AAVE_EMODE24_EXACT_26184741",
    },
    "rank1_weth_weth":{
        "address":"0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3",
        "origin":"RMC016_RANK1_PREBLOCK_WINNER_25938048",
    },
    "rank2_weth_history":{
        "address":"0xab964a92c157afd8019840a0ae48af3590a0b731",
        "origin":"RMC016_RANK2_PREBLOCK_WINNER_26024990",
    },
    "rank3_weth_history":{
        "address":"0xc950fe241c50f93d872edb5a97066474c84c2394",
        "origin":"RMC016_RANK3_PREBLOCK_WINNER",
    },
}
MAX_RESPONSE_BYTES=1024*1024
MAX_CALLS_PER_SOURCE=16
STALENESS_SECONDS=180
CONFIRMATION_BLOCKS=3

class ObservationError(ValueError):
    pass

def need(cond, reason):
    if not cond:raise ObservationError(reason)

def canonical(doc):
    return (json.dumps(doc,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def sha256(raw):
    return hashlib.sha256(raw).hexdigest()

def quantity(raw,name):
    need(type(raw) is str and HEX_NUM.fullmatch(raw) is not None,
         name+": invalid hex quantity")
    return int(raw,16)

def account_calldata(addr):
    need(type(addr) is str and HEX_ADDR.fullmatch(addr) is not None,
         "invalid borrower address")
    return "0x"+SELECTOR+"0"*24+addr[2:].lower()

def decode_account(payload):
    need(type(payload) is str and
         re.fullmatch(r"0x(?:[0-9a-fA-F]{64}){6}",payload) is not None,
         "Aave six-word uint256 ABI required")
    values=[int(payload[2+64*i:2+64*(i+1)],16) for i in range(6)]
    data=dict(zip(EXPECTED_FIELDS,values))
    need(data["liquidation_threshold_bps"]<=10000 and data["ltv_bps"]<=10000,
         "Aave account risk configuration malformed")
    return data

def block_header(header,height):
    need(type(header) is dict, "missing Ethereum canonical block header")
    need(quantity(header.get("number"),"block number")==height,
         "wrong block height")
    result={}
    for source,target in (("hash","hash"),("parentHash","parent_hash"),
                          ("stateRoot","state_root")):
        raw=header.get(source)
        need(type(raw) is str and HEX_HASH.fullmatch(raw) is not None,
             "invalid "+source)
        result[target]=raw.lower()
    result["number"]=height
    result["timestamp"]=quantity(header.get("timestamp"),"block timestamp")
    need(result["timestamp"]>0 and result["hash"]!=result["parent_hash"],
         "impossible block identity")
    return result

def default_transport(url,method,params):
    need(url in [pair[1] for pair in SOURCES.values()],"unapproved RPC endpoint")
    need(method in READ_METHODS,"non-read-only JSON-RPC method prohibited")
    body=json.dumps({"jsonrpc":"2.0","id":7,"method":method,"params":params},
                    separators=(",",":")).encode()
    req=Request(url,data=body,method="POST",headers={
        "Accept":"application/json","Content-Type":"application/json",
        "User-Agent":"NQC-V2-Sniper-Observer-ReadOnly/1"})
    try:
        with urlopen(req,timeout=14) as stream:
            raw=stream.read(MAX_RESPONSE_BYTES+1)
        need(len(raw)<=MAX_RESPONSE_BYTES,"RPC response exceeded bounded size")
        doc=json.loads(raw)
    except (OSError,TimeoutError,UnicodeError,ValueError) as exc:
        raise ObservationError("RPC_SOURCE_ERROR:"+type(exc).__name__+
                               ":"+str(exc)[:155]) from exc
    need(type(doc) is dict and doc.get("jsonrpc")=="2.0" and
         doc.get("id")==7 and "error" not in doc and "result" in doc,
         "RPC_RETURNED_ERROR_OR_NONCANONICAL_RESPONSE")
    return doc["result"]

class Reader:
    def __init__(self,identifier,transport=default_transport):
        need(identifier in SOURCES,"unapproved provider")
        self.identifier=identifier
        self.operator,self.url=SOURCES[identifier]
        self.transport=transport
        self.count=0
    def call(self,method,params):
        need(method in READ_METHODS,"non-read-only JSON-RPC method prohibited")
        self.count+=1
        need(self.count<=MAX_CALLS_PER_SOURCE,"bounded source call budget exceeded")
        return self.transport(self.url,method,params)
    def preflight(self):
        need(quantity(self.call("eth_chainId",[]),"chain id")==CHAIN_ID,
             "source returned wrong chain")
        tip=quantity(self.call("eth_blockNumber",[]),"head")
        need(tip>CONFIRMATION_BLOCKS+1,"source tip too low")
        return tip
    def sample_at(self,height,observed_timestamp):
        tag=hex(height)
        before=block_header(self.call("eth_getBlockByNumber",[tag,False]),height)
        need(observed_timestamp>=before["timestamp"] and
             observed_timestamp-before["timestamp"]<=STALENESS_SECONDS,
             "provider block too stale or timestamp in future")
        rows=[]
        raw_commitments=[]
        for label,meta in BORROWERS.items():
            addr=meta["address"]
            # EIP-1898 is deliberate: do not silently fall back to a block-number
            # eth_call that can be reordered across reorgs.
            result=self.call("eth_call",[
                {"to":POOL,"data":account_calldata(addr)},
                {"blockHash":before["hash"],"requireCanonical":True}
            ])
            account=decode_account(result)
            raw_commitments.append(sha256(result.lower().encode()))
            hf=account["health_factor_wad"]
            debt=account["total_debt_base"]
            status=("HF_LT_ONE_OBSERVED_NEEDS_EXECUTION_GATES"
                    if debt>0 and 0<hf<WAD else
                    "NO_DEBT_OR_NO_CONFIRMED_HF_TRIGGER")
            rows.append({
                "borrower_label":label,"borrower":addr,
                "identity_origin":meta["origin"],
                "account":{k:str(v) for k,v in account.items()},
                "health_factor_below_one_with_debt":debt>0 and 0<hf<WAD,
                "status":status,"raw_account_sha256":raw_commitments[-1]
            })
        after=block_header(self.call("eth_getBlockByNumber",[tag,False]),height)
        need(before==after,"reorg/changed block during account observation")
        return {"provider_id":self.identifier,"operator":self.operator,
                "block":before,"rows":rows,
                "raw_abi_commitments":raw_commitments,
                "read_only_rpc_calls":self.count}

def observe(provider_ids=("drpc","publicnode","blast"),transport=default_transport,
            now=None):
    need(type(provider_ids) in (tuple,list) and
         1<=len(provider_ids)<=3 and len(set(provider_ids))==len(provider_ids),
         "provider selection invalid")
    need(all(p in SOURCES for p in provider_ids),
         "unapproved provider in selection")
    when=int(datetime.now(timezone.utc).timestamp()) if now is None else now
    need(type(when) is int and when>0,"time source invalid")
    attempts=[]
    admitted=[]
    for name in provider_ids:
        reader=Reader(name,transport)
        try:
            tip=reader.preflight()
            admitted.append((reader,tip))
            attempts.append({"provider_id":name,"preflight":"READS_OK",
                             "tip":tip})
        except ObservationError as err:
            attempts.append({"provider_id":name,"preflight":"BLOCKED",
                             "error":str(err)[:180]})
    if not admitted:
        return unavailable_report(when,attempts,"NO_PROVIDER_AUTHORIZED")
    min_tip=min(tip for _,tip in admitted)
    height=min_tip-CONFIRMATION_BLOCKS
    if max(tip for _,tip in admitted)-min_tip>12:
        return unavailable_report(when,attempts,"RPC_TIP_DIVERGENCE",height)
    successes=[]
    for reader,_ in admitted:
        try:
            successes.append(reader.sample_at(height,when))
        except ObservationError as err:
            attempts.append({"provider_id":reader.identifier,
                             "pinned_sample":"BLOCKED","error":str(err)[:180]})
    if not successes:
        return unavailable_report(when,attempts,"NO_PINNED_STATE_AVAILABLE",height)
    canonical_sample=successes[0]
    matches=all(s["block"]==canonical_sample["block"] and
                s["raw_abi_commitments"]==canonical_sample["raw_abi_commitments"]
                for s in successes[1:])
    if not matches:
        return unavailable_report(when,attempts,"PROVIDER_STATE_MISMATCH",height)
    # Candidate is a borrower-state witness, not verified liquidatability,
    # route executability, P&L, winning probability or a trade.
    candidates=sum(r["health_factor_below_one_with_debt"]
                   for r in canonical_sample["rows"])
    status=("DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2"
            if len(successes)>=2 else
            "SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2")
    result={
        "schema_version":1,"contract":"NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT",
        "status":status,
        "observed_at_utc":datetime.fromtimestamp(when,timezone.utc).isoformat(),
        "observed_epoch_seconds":when,
        "chain_id":1,"pinned_block":canonical_sample["block"],
        "source_attempts":attempts,
        "successful_provider_ids":[s["provider_id"] for s in successes],
        "provider_count":len(successes),
        "independent_rpc_operator_authenticity_certified":False,
        "accounts_consistent_across_successful_endpoints":matches,
        "watched_borrower_count":len(BORROWERS),
        "account_rows":canonical_sample["rows"],
        "hf_below_one_state_count_not_execution_admission":candidates,
        "raw_evidence_sha256":sha256(canonical([
            {"provider_id":s["provider_id"],"block":s["block"],
             "hashes":s["raw_abi_commitments"]} for s in successes])),
        "snapshot_sampling_not_24_7_deployment":True,
        "candidate_route_profit_verified":False,
        "native_gas_nonrecourse_sponsor_verified":False,
        "external_flash_capital_committed":False,
        "competitive_capture_probability_known":False,
        "actual_liquidation_executed":False,
        "p2_shadow_certified":False,"rmc_closed":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0"
    }
    return result

def unavailable_report(when,attempts,why,height=None):
    return {"schema_version":1,
            "contract":"NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT",
            "status":"UNVERIFIED_NO_OBSERVATION",
            "blocker":why,
            "observed_at_utc":datetime.fromtimestamp(when,timezone.utc).isoformat(),
            "source_attempts":attempts,"candidate_count":None,
            "attempted_height":height,
            "p2_shadow_certified":False,"rmc_closed":False,
            "commercial_score_upgrade":False,"nqc_realized_pnl_usd":"0"}

def main():
    cli=argparse.ArgumentParser()
    cli.add_argument("--out",required=True,type=Path)
    cli.add_argument("--providers",nargs="+",default=["drpc","publicnode","blast"],
                     choices=sorted(SOURCES))
    ns=cli.parse_args()
    try:
        result=observe(tuple(ns.providers))
    except Exception as exc:
        result=unavailable_report(
            int(datetime.now(timezone.utc).timestamp()),
            [{"error_type":type(exc).__name__,
              "error":str(exc)[:220]}],"UNCAUGHT_FAIL_CLOSED")
    ns.out.parent.mkdir(parents=True,exist_ok=True)
    ns.out.write_bytes(json.dumps(result,sort_keys=True,indent=2).encode()+b"\n")
    print(result["status"],"candidate_state_count",
          result.get("hf_below_one_state_count_not_execution_admission"))
    return 2 if result["status"]=="UNVERIFIED_NO_OBSERVATION" else 0

if __name__=="__main__":
    raise SystemExit(main())
