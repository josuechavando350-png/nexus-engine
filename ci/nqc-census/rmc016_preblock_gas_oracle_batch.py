#!/usr/bin/env python3
"""Two-operator historical pre-block WETH oracle reference for competitor gas; not Nexus P&L."""
from __future__ import annotations
import argparse,hashlib,json,re,time,zipfile
from pathlib import Path
from rmc016_resume_verified_receipts import authenticated_drpc_checkpoint
from rmc016_probe_historical_rpc import PROVIDERS,rpc,START_BLOCK,END_BLOCK
from rmc016_historical_gas_price_oracle import ORACLE,WETH,UNIT,CALLDATA,normalize_result

SOURCE_SHA="6b4098c1acf153106ac5b67d2c5c7db5cd0295a16c782ad8c34ae75303306204"
DRPC_SHA="182b5e81b00ca04e53c9193c1496a725dc152ade9a17d3ab2dfaeb5045ac86b6"
SAMPLE_SHA="5d321ec4707da6b9b0a0e1b24ce2d28992bb9329dd937baa6466c759359c3f73"
HEX=re.compile(r"^0x[0-9a-f]{64}$")
def need(ok,reason):
    if not ok:raise ValueError(reason)
def canonical(x):return (json.dumps(x,sort_keys=True,separators=(",",":"))+"\n").encode()
def digest(x):return hashlib.sha256(x).hexdigest()
def real_sample(path):
    need(digest(path.read_bytes())==SAMPLE_SHA,"price sample ZIP digest mismatch")
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        need(len(names)==2 and set(names)=={"archive.sha256","price-samples.json"},"price sample members drift")
        content=z.read("price-samples.json")
        need(z.read("archive.sha256").decode("ascii")==digest(content)+"  price-samples.json\n",
             "price sample internal SHA mismatch")
    obj=json.loads(content)
    need(obj.get("status")=="RMC016_TWO_OPERATOR_AAVE_WETH_HISTORICAL_ORACLE_SAMPLE_PASS"
         and obj.get("independent_sample_consensus") is True
         and obj.get("claims_exact_pre_transaction_price") is False
         and obj.get("nexus_profitability_proven") is False
         and obj.get("source_oracle")==ORACLE and obj.get("asset")==WETH
         and obj.get("base_currency_unit")==UNIT,"previous sample authority mismatch")
    return obj["prices"]
def src(event_zip,drpc_zip,sample_zip):
    need(digest(event_zip.read_bytes())==SOURCE_SHA and digest(drpc_zip.read_bytes())==DRPC_SHA,
         "original receipt/event archive digest mismatch")
    receipts,events,ids=authenticated_drpc_checkpoint(drpc_zip,event_zip)
    need(len(receipts)==len(events)==len(ids)==127,"127-source conservation")
    by={}
    for tid in ids:
        x=receipts[tid];block=x["block_number"]
        need(type(block) is int and START_BLOCK<block<=END_BLOCK,"historical block outside authority")
        by.setdefault(block,[]).append(x)
    blocks=sorted(by)
    need(len(blocks)==123 and blocks[0]==25883783,"winner block universe mismatch")
    return by,blocks,real_sample(sample_zip)
def acquire(event_zip,drpc_zip,sample_zip,*,offset=0,count=5,request=rpc,
            pause=time.sleep,spacing=2.0):
    need(type(offset) is int and offset>=0 and type(count) is int and 1<=count<=5,
         "request must select 1..5 contiguous historical blocks")
    need(type(spacing) in (int,float) and 0<=spacing<=20,"invalid RPC interval")
    by,blocks,samples=src(event_zip,drpc_zip,sample_zip)
    need(offset+count<=len(blocks),"historical block offset overflow")
    chosen=blocks[offset:offset+count]
    providers=[p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(len(providers)==2 and providers[0][0]=="drpc" and providers[1][0]=="blast"
         and providers[0][1]!=providers[1][1],"two independent RPC operators required")
    seen={};err=None;records=[]
    try:
        for name,operator,url in providers:
            need(request(url,"eth_chainId",[])=="0x1","wrong chain "+name)
            bucket=[]
            for number in chosen:
                pair=[]
                for at in (number-1,number):
                    if spacing:pause(spacing)
                    h=request(url,"eth_getBlockByNumber",[hex(at),False])
                    need(type(h) is dict and int(h.get("number","-1"),16)==at
                         and type(h.get("hash")) is str and HEX.fullmatch(h["hash"]),
                         "historical block hash/header mismatch")
                    if spacing:pause(spacing)
                    price=normalize_result(request(url,"eth_call",
                        [{"to":ORACLE,"data":CALLDATA},hex(at)]))
                    observed={"block":at,"hash":h["hash"],"oracle_usd_base_1e8":str(price)}
                    if str(at) in samples:
                        old=samples[str(at)]
                        need(old=={"block_hash":observed["hash"],"price_raw":observed["oracle_usd_base_1e8"]},
                             "previous immutable oracle sample disagrees")
                    pair.append(observed)
                bucket.append({"tx_block":number,"pair":pair})
            seen[name]={"operator":operator,"rows":bucket}
        need(seen["drpc"]["rows"]==seen["blast"]["rows"],
             "cross-operator historical oracle/header disagreement")
        for item in seen["drpc"]["rows"]:
            n=item["tx_block"];earlier,later=item["pair"]
            gas=sum(int(r["total_gas_paid_wei"]) for r in by[n])
            # Wei ETH * (USD*1e8) / 1e8 -> USD in 1e18 fixed-point.
            amount=gas*int(earlier["oracle_usd_base_1e8"])//UNIT
            records.append({"tx_block":n,"winner_transaction_count":len(by[n]),
                "winner_gas_wei":str(gas),"preblock":earlier,"block_end":later,
                "preblock_gas_usd_wad_reference":str(amount),
                "oracle_end_state_changed":earlier["oracle_usd_base_1e8"]!=later["oracle_usd_base_1e8"],
                "pre_transaction_price_certified":False})
    except Exception as e:err=type(e).__name__+": "+str(e)[:220]
    good=err is None and len(records)==len(chosen)
    out={"schema_version":1,
       "status":"RMC016_DUAL_OPERATOR_PREBLOCK_GAS_REFERENCE_PASS" if good else
                "RMC016_PREBLOCK_GAS_REFERENCE_BLOCKED",
       "full_historical_winner_transactions":127,"historical_winner_blocks":len(blocks),
       "source_event_sha256":SOURCE_SHA,"source_receipts_sha256":DRPC_SHA,
       "sample_authority_sha256":SAMPLE_SHA,"offset":offset,"count":count,
       "requested_blocks":chosen,"verified_blocks":len(records),
       "prices":records,"error":err,
       "two_provider_consensus":good,"reference_only":True,
       "exact_pre_tx_state_proven":False,"complete_historical_gas_usd_proven":False,
       "complete_transaction_net_proven":False,"nexus_gas_funding_proven":False,
       "nexus_capture_probability_calibrated":False,"nexus_net_profit_proven":False,
       "real_market_census_closed":False}
    out["commitment_sha256"]=digest(canonical(out))
    return out

if __name__=="__main__":
    p=argparse.ArgumentParser()
    for name in ("event-zip","drpc-zip","price-sample-zip"):
        p.add_argument("--"+name,type=Path,required=True)
    p.add_argument("--offset",type=int,default=0);p.add_argument("--count",type=int,default=5)
    p.add_argument("--spacing",type=float,default=2.0);p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    need(not a.out.exists(),"append-only output path")
    z=acquire(a.event_zip,a.drpc_zip,a.price_sample_zip,
              offset=a.offset,count=a.count,spacing=a.spacing)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(z))
    print(z["status"],"blocks",z["verified_blocks"])
    raise SystemExit(0 if z["two_provider_consensus"] else 2)
