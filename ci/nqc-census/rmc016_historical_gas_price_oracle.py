#!/usr/bin/env python3
"""Read-only Aave V3 WETH/USD historical pre-block price probe; NOT Nexus P&L."""
from __future__ import annotations
import argparse, hashlib, json, re, sys, time
from pathlib import Path
from rmc016_probe_historical_rpc import rpc, PROVIDERS, CHAIN_ID, END_BLOCK, END_HASH, as_hex_quantity

ORACLE="0x54586be62e3c3580375ae3723c145253060ca0c2"
WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
UNIT=100_000_000
ANCHOR_PRICE=270926731143
SELECTOR="0xb3596f07"
CALLDATA=SELECTOR+WETH[2:].rjust(64,"0")
SAMPLES=(25883782,26001679,26085026,END_BLOCK)
HEADERS_UPSTREAM=(
    "0x0b29e0c8c1997f059f82e7fed67e047269f68422ab194d56546c1c9833469d96",
    END_HASH,
)
HEX32=re.compile(r"^0x[0-9a-f]{64}$")
def require(v,msg):
    if not v:raise ValueError(msg)
def canonical(v):
    return (json.dumps(v,sort_keys=True,separators=(",",":"))+"\n").encode()
def sha(v):return hashlib.sha256(v).hexdigest()
def normalize_result(v):
    require(type(v) is str and re.fullmatch(r"0x[0-9a-fA-F]{64}",v) is not None,
            "historical oracle return is not one canonical uint256")
    price=int(v,16)
    require(price>0,"zero/negative oracle price")
    return price

def probe(call=rpc,providers=None,min_interval=0.0):
    providers=providers or [x for x in PROVIDERS if x[0] in ("drpc","blast")]
    require(len(providers)==2 and [x[0] for x in providers]==["drpc","blast"],
            "exact two independent operators required")
    require(0<=min_interval<=20,"invalid request spacing")
    status={"schema_version":1,"claim_scope":"PRE_BLOCK_AAVE_ORACLE_WETH_PRICE_SAMPLE_ONLY",
            "status":"RMC016_HISTORICAL_PREBLOCK_ORACLE_SAMPLES_BLOCKED",
            "source_oracle":ORACLE,"asset":WETH,"base_currency_unit":UNIT,
            "d08_terminal_anchor_block":END_BLOCK,
            "d08_terminal_anchor_weth_price":ANCHOR_PRICE,
            "sampled_pre_event_blocks":list(SAMPLES[:-1]),
            "source_d08_exact_archive_sha256":"9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913",
            "lookahead_used":False,"claims_exact_pre_transaction_price":False,
            "historical_full_receipt_gas_priced":False,
            "independent_full_temporal_authority":False,
            "nexus_profitability_proven":False,"real_market_census_closed":False}
    seen={}
    try:
        for name,operator,url in providers:
            require(as_hex_quantity(call(url,"eth_chainId",[]),"chainId")==CHAIN_ID,"wrong chain")
            prices={}
            for number in SAMPLES:
                tag=hex(number)
                if min_interval:time.sleep(min_interval)
                header=call(url,"eth_getBlockByNumber",[tag,False])
                require(type(header) is dict,"historical header missing")
                require(as_hex_quantity(header.get("number"),"block")==number,
                        "historical block number drift")
                bh=header.get("hash")
                require(type(bh) is str and HEX32.fullmatch(bh) is not None,
                        "historical hash invalid")
                if number==END_BLOCK:require(bh==END_HASH,"D08 anchor hash changed")
                if min_interval:time.sleep(min_interval)
                raw=call(url,"eth_call",[{"to":ORACLE,"data":CALLDATA},tag])
                px=normalize_result(raw)
                if number==END_BLOCK:require(px==ANCHOR_PRICE,"D08 WETH oracle end-anchor parity failed")
                prices[str(number)]={"block_hash":bh,"price_raw":str(px)}
            seen[name]={"provider_id":name,"operator":operator,"sample_prices":prices}
        a,b=seen["drpc"]["sample_prices"],seen["blast"]["sample_prices"]
        require(a==b,"independent providers disagree on historical WETH price/header")
        status.update({"status":"RMC016_TWO_OPERATOR_AAVE_WETH_HISTORICAL_ORACLE_SAMPLE_PASS",
                       "independent_sample_consensus":True,
                       "sample_count":len(SAMPLES),"prices":a})
    except Exception as error:
        status.update({"status":"RMC016_HISTORICAL_PREBLOCK_ORACLE_SAMPLES_BLOCKED",
                       "independent_sample_consensus":False,
                       "blocking_reason":f"{type(error).__name__}: {str(error)[:240]}"})
    status["provider_progress"]=seen
    status["report_sha256"]=sha(canonical(status))
    return status

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--out",required=True,type=Path)
    p.add_argument("--min-interval",type=float,default=0.5)
    a=p.parse_args()
    require(not a.out.exists(),"append-only oracle evidence file")
    report=probe(min_interval=a.min_interval)
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(report))
    print(report["status"])
    return 0 if report["status"]=="RMC016_TWO_OPERATOR_AAVE_WETH_HISTORICAL_ORACLE_SAMPLE_PASS" else 2
if __name__=="__main__":sys.exit(main())
