#!/usr/bin/env python3
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, time, urllib.error, urllib.request
from pathlib import Path

CHAIN_ID=1
FACTORY="0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f"
REFERENCE_PAIR="0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc"
SEMANTICS="UNISWAP_V2_CONSTANT_PRODUCT_30_BPS"
ALL_PAIRS_LENGTH="0x574f2ba3"
ALL_PAIRS="0x1e3dd18b"
TOKEN0="0x0dfe1681"
TOKEN1="0xd21220a7"
GET_RESERVES="0x0902f1ac"
ZERO="0x"+"0"*40

class CensusError(RuntimeError): pass

def stable(v): return json.dumps(v,sort_keys=True,separators=(",",":"))
def sha_text(v): return hashlib.sha256(v.encode()).hexdigest()
def sha_hex(v):
    h=str(v).lower().removeprefix("0x")
    if len(h)%2: h="0"+h
    return hashlib.sha256(bytes.fromhex(h)).hexdigest()
def uint(v):
    if not isinstance(v,str) or not v.startswith("0x"): raise CensusError("bad uint")
    return int(v,16)
def addr(v):
    h=str(v).lower().removeprefix("0x")
    if len(h)!=64: raise CensusError("bad address result")
    return "0x"+h[-40:]
def reserves(v):
    h=str(v).lower().removeprefix("0x")
    if len(h)<192: raise CensusError("bad reserves result")
    return int(h[:64],16),int(h[64:128],16),int(h[128:192],16)
def word(n): return f"{n:064x}"

class Rpc:
    def __init__(self,pid,url,timeout,retries):
        self.id,self.url,self.timeout,self.retries=pid,url,timeout,retries
        self.seq=1; self.http_requests=0; self.rpc_calls=0
    def post(self,payload):
        req=urllib.request.Request(self.url,data=json.dumps(payload,separators=(",",":")).encode(),
            headers={"content-type":"application/json","user-agent":"nqc-real-market-census-v1"},method="POST")
        last=None
        for attempt in range(self.retries):
            try:
                self.http_requests+=1
                with urllib.request.urlopen(req,timeout=self.timeout) as r:
                    return json.loads(r.read().decode())
            except (urllib.error.HTTPError,urllib.error.URLError,TimeoutError,OSError,json.JSONDecodeError) as exc:
                last=exc
                if attempt+1<self.retries: time.sleep(min(8.0,.35*(2**attempt)))
        raise CensusError(f"{self.id}: HTTP failure: {last}")
    def call(self,method,params):
        i=self.seq; self.seq+=1; self.rpc_calls+=1
        d=self.post({"jsonrpc":"2.0","id":i,"method":method,"params":params})
        if not isinstance(d,dict) or d.get("id")!=i or d.get("error") is not None:
            raise CensusError(f"{self.id}: {method} failure {d}")
        return d.get("result")
    def batch(self,calls):
        if not calls: return []
        req=[]; ids=[]
        for method,params in calls:
            i=self.seq; self.seq+=1; ids.append(i)
            req.append({"jsonrpc":"2.0","id":i,"method":method,"params":params})
        self.rpc_calls+=len(calls)
        d=self.post(req)
        if not isinstance(d,list): raise CensusError(f"{self.id}: non-list batch")
        by={x.get("id"):x for x in d if isinstance(x,dict)}
        out=[]
        for i in ids:
            x=by.get(i)
            if x is None or x.get("error") is not None: raise CensusError(f"{self.id}: batch id {i} failure {x}")
            out.append(x.get("result"))
        return out

def exact_anchor(ps):
    finalized=[]
    for p in ps:
        if uint(p.call("eth_chainId",[]))!=CHAIN_ID: raise CensusError(f"{p.id}: wrong chain")
        b=p.call("eth_getBlockByNumber",["finalized",False])
        if not isinstance(b,dict): raise CensusError(f"{p.id}: no finalized block")
        finalized.append(uint(b["number"]))
    height=min(finalized); rows=[]
    for p in ps:
        b=p.call("eth_getBlockByNumber",[hex(height),False])
        rows.append({"number":uint(b["number"]),"hash":b["hash"].lower(),
            "parent_hash":b["parentHash"].lower(),"timestamp":uint(b["timestamp"])})
    if len({stable(x) for x in rows})!=1: raise CensusError(f"anchor dissent {rows}")
    return rows[0]

def ecall(p,to,data,tag): return p.call("eth_call",[{"to":to,"data":data},tag])

def factory_identity(p,tag):
    code=p.call("eth_getCode",[FACTORY,tag])
    ref=p.call("eth_getCode",[REFERENCE_PAIR,tag])
    if code in ("0x","0x0",None) or ref in ("0x","0x0",None): raise CensusError(f"{p.id}: missing code")
    return {"factory_code_sha256":sha_hex(code),
        "reference_pair_code_sha256":sha_hex(ref),
        "all_pairs_length":uint(ecall(p,FACTORY,ALL_PAIRS_LENGTH,tag))}

def pair_addresses(p,start,stop,tag):
    calls=[("eth_call",[{"to":FACTORY,"data":ALL_PAIRS+word(i)},tag]) for i in range(start,stop)]
    return [addr(x) for x in p.batch(calls)]

def pair_details(p,pairs,tag):
    calls=[]
    for a in pairs:
        calls += [("eth_call",[{"to":a,"data":TOKEN0},tag]),
                  ("eth_call",[{"to":a,"data":TOKEN1},tag]),
                  ("eth_call",[{"to":a,"data":GET_RESERVES},tag]),
                  ("eth_getCode",[a,tag])]
    raw=p.batch(calls); out=[]
    for i,a in enumerate(pairs):
        r0,r1,ts=reserves(raw[i*4+2]); code=raw[i*4+3]
        out.append({"pair":a,"token0":addr(raw[i*4]),"token1":addr(raw[i*4+1]),
            "reserve0":r0,"reserve1":r1,"block_timestamp_last":ts,
            "code_sha256":None if code in ("0x","0x0",None) else sha_hex(code)})
    return out

def consensus_batch(ps,start,stop,tag):
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ps)) as ex:
        fut={p.id:ex.submit(pair_addresses,p,start,stop,tag) for p in ps}
        by={k:v.result() for k,v in fut.items()}
    canonical=next(iter(by.values()))
    if any(v!=canonical for v in by.values()): raise CensusError(f"address dissent {start}:{stop}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(ps)) as ex:
        fut={p.id:ex.submit(pair_details,p,canonical,tag) for p in ps}
        by={k:v.result() for k,v in fut.items()}
    rows=next(iter(by.values()))
    if any(v!=rows for v in by.values()): raise CensusError(f"state dissent {start}:{stop}")
    return rows

def record(index,row,anchor,pair_code,provider_ids):
    code_ok=row["code_sha256"]==pair_code
    assets_ok=row["token0"]!=ZERO and row["token1"]!=ZERO and row["token0"]!=row["token1"]
    live=row["reserve0"]>0 and row["reserve1"]>0
    countable=code_ok and assets_ok and live
    raw={"factory_index":index,"providers":provider_ids,"row":row}
    return {
      "chain_id":CHAIN_ID,
      "protocol_semantics":SEMANTICS,
      "market_address":row["pair"],
      "code_identity":{"runtime_sha256":row["code_sha256"],"matches_certified_reference_pair":code_ok},
      "asset_identities":[row["token0"],row["token1"]],
      "canonical_state_anchor":anchor,
      "lifecycle_activity_status":"LIQUIDITY_PRESENT" if live else "ZERO_LIQUIDITY",
      "signal_observability":"PASS_SYNC_STATE_OBSERVABLE" if code_ok and assets_ok else "FAIL",
      "simulation_support_state":"PASS_UNISWAP_V2_EXACT_IN_30_BPS" if code_ok and assets_ok else "FAIL",
      "funding_compatibility_state":"UNCLASSIFIED_AT_CENSUS_STAGE",
      "execution_compatibility_state":"UNCLASSIFIED_AT_CENSUS_STAGE",
      "evidence_provenance":{"kind":"EXACT_TWO_PROVIDER_CANONICAL_RPC_CONSENSUS",
        "factory":FACTORY,"factory_index":index,"providers":provider_ids,
        "observation_sha256":sha_text(stable(raw))},
      "counted_toward_real_market_census":countable,
      "reserve0":str(row["reserve0"]),"reserve1":str(row["reserve1"]),
      "block_timestamp_last":row["block_timestamp_last"]}

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--out",type=Path,required=True)
    ap.add_argument("--provider",action="append",required=True)
    ap.add_argument("--minimum-counted",type=int,default=25001)
    ap.add_argument("--collection-target",type=int,default=26000)
    ap.add_argument("--batch-pairs",type=int,default=40)
    ap.add_argument("--timeout-seconds",type=int,default=90)
    ap.add_argument("--retries",type=int,default=8)
    a=ap.parse_args()
    if a.minimum_counted<25001: raise CensusError("minimum-counted may not weaken 25,001")
    if a.collection_target<a.minimum_counted: raise CensusError("collection target below minimum")
    if not 1<=a.batch_pairs<=100: raise CensusError("batch-pairs outside [1,100]")
    ps=[]; seen=set()
    for item in a.provider:
        pid,sep,url=item.partition("=")
        if not sep or not pid or not url or pid in seen: raise CensusError("bad/duplicate provider")
        seen.add(pid); ps.append(Rpc(pid,url,a.timeout_seconds,a.retries))
    if len(ps)<2: raise CensusError("two providers required")
    a.out.mkdir(parents=True,exist_ok=True)
    anchor=exact_anchor(ps); tag=hex(anchor["number"])
    identities={p.id:factory_identity(p,tag) for p in ps}
    if len({stable(v) for v in identities.values()})!=1: raise CensusError(f"factory dissent {identities}")
    ident=next(iter(identities.values())); total=ident["all_pairs_length"]
    if total<a.minimum_counted: raise CensusError(f"factory pairs {total} below minimum")
    counted=scanned=zero=rejected=0; provider_ids=[p.id for p in ps]
    records=a.out/"markets.ndjson"
    with records.open("w") as f:
        for start in range(0,total,a.batch_pairs):
            stop=min(total,start+a.batch_pairs)
            rows=consensus_batch(ps,start,stop,tag)
            for off,row in enumerate(rows):
                rec=record(start+off,row,anchor,ident["reference_pair_code_sha256"],provider_ids)
                scanned+=1
                if rec["counted_toward_real_market_census"]:
                    counted+=1; f.write(stable(rec)+"\n")
                elif rec["lifecycle_activity_status"]=="ZERO_LIQUIDITY": zero+=1
                else: rejected+=1
            if counted>=a.collection_target: break
    status="PASS" if counted>=a.minimum_counted else "FAIL"
    summary={"schema_version":1,"gate":"REAL_MARKET_CENSUS","status":status,
      "chain_id":CHAIN_ID,"network":"ethereum-mainnet","protocol_semantics":SEMANTICS,
      "factory":FACTORY,"factory_code_sha256":ident["factory_code_sha256"],
      "certified_reference_pair":REFERENCE_PAIR,
      "reference_pair_code_sha256":ident["reference_pair_code_sha256"],
      "canonical_anchor":anchor,"provider_ids":provider_ids,"provider_count":len(provider_ids),
      "factory_total_pairs":total,"pairs_scanned":scanned,"counted_real_live_markets":counted,
      "minimum_required":a.minimum_counted,"collection_target":a.collection_target,
      "zero_liquidity_not_counted":zero,"identity_or_asset_rejections":rejected,
      "market_records_sha256":hashlib.sha256(records.read_bytes()).hexdigest(),
      "funding_compatibility_state":"UNCLASSIFIED_AT_CENSUS_STAGE",
      "execution_compatibility_state":"UNCLASSIFIED_AT_CENSUS_STAGE",
      "shadow_execution":"NOT_TESTED","canary_execution":"NOT_TESTED",
      "live_pnl_evidence":False,"production_authority_issued":False,
      "production_certification":"NOT_CERTIFIED",
      "rpc_usage":{p.id:{"http_requests":p.http_requests,"rpc_calls":p.rpc_calls} for p in ps}}
    (a.out/"summary.json").write_text(json.dumps(summary,indent=2,sort_keys=True)+"\n")
    sums=[]
    for p in sorted(a.out.iterdir()):
        if p.is_file() and p.name!="SHA256SUMS":
            sums.append(f"{hashlib.sha256(p.read_bytes()).hexdigest()}  {p.name}")
    (a.out/"SHA256SUMS").write_text("\n".join(sums)+"\n")
    print(("REAL_MARKET_CENSUS_PASS" if status=="PASS" else "REAL_MARKET_CENSUS_FAIL"),
      f"counted={counted}",f"scanned={scanned}",f"factory_total={total}",
      f"anchor={anchor['number']}:{anchor['hash']}")
    if status!="PASS": raise SystemExit(1)

if __name__=="__main__": main()
