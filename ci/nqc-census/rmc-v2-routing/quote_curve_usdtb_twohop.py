#!/usr/bin/env python3
"""NQC V2: exact-block Curve 3pool + USDtb/USDC two-hop quote research.

No live swap, no authenticated capital commitment or complete liquidation.
Use integer base units only for route sizing; decimal display is non-authority.
"""
from __future__ import annotations

import argparse
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path
import re
import subprocess

BLOCK=26_184_741
HASH="0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT="0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
CURVE_3POOL="0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7"
CURVE_USDTB_USDC="0xC2921134073151490193ac7369313c8e0b08e1e7"
DAI="0x6B175474E89094C44Da98b954EedeAC495271d0F"
USDC="0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
USDT="0xdAC17F958D2ee523a2206206994597C13D831ec7"
USDtb="0xC139190F447e929f090Edeb554D95AbB8b18aC1C"
SIZES=(1_000,100_000,472_000,480_000,500_000)
UINT=2**256-1

class QuoteEvidenceError(ValueError):
    pass

def require(condition: bool, msg: str) -> None:
    if not condition: raise QuoteEvidenceError(msg)

def parse_number(result: str) -> int:
    words=result.strip().split()
    require(len(words)>0, "empty integer output")
    value=words[0]
    require(bool(re.fullmatch("(0x[0-9a-fA-F]+|[0-9]+)",value)),
            "unexpected/rounded numeric transport")
    num=int(value,16) if value.startswith("0x") else int(value)
    require(0<=num<=UINT, "uint256 range violated")
    return num

def parse_address(text: str) -> str:
    words=text.strip().split()
    require(len(words)>0 and
            bool(re.fullmatch(r"0x[0-9a-fA-F]{40}",words[0])),
            "address type mismatch")
    return words[0].lower()

def display(n: int,decimals: int) -> str:
    require(isinstance(n,int) and n>=0, "invalid integer display")
    require(decimals in (6,18), "unsupported token decimals")
    with localcontext() as ctx:
        ctx.prec=85
        return format(Decimal(n)/(10**decimals),"f")

def cast(rpc: str,cmd: list[str],may_fail: bool=False) -> str | None:
    require(rpc.startswith("https://"), "HTTPS archive RPC required")
    argv=["cast",*cmd,"--block",str(BLOCK),"--rpc-url",rpc]
    try:
        r=subprocess.run(argv,capture_output=True,text=True,timeout=35,check=False)
    except (OSError,subprocess.TimeoutExpired):
        if may_fail:return None
        raise QuoteEvidenceError("required cast RPC request unavailable")
    if r.returncode:
        if may_fail:return None
        raise QuoteEvidenceError("required cast RPC request failed")
    return r.stdout.strip()

def read_int(rpc: str,address: str,fn: str,*args: object,may_fail: bool=False) -> int | None:
    txt=cast(rpc,["call",address,fn,*map(str,args)],may_fail=may_fail)
    if txt is None:return None
    try: return parse_number(txt)
    except QuoteEvidenceError:
        if may_fail:return None
        raise

def coins(rpc: str,pool: str,count: int=2) -> list[str]:
    return [
        parse_address(cast(rpc,["call",pool,"coins(uint256)(address)",str(i)]))
        for i in range(count)
    ]

def get_dy(rpc: str,pool: str,i: int,j: int,dx: int) -> int:
    result=read_int(rpc,pool,"get_dy(int128,int128,uint256)(uint256)",i,j,dx)
    require(result is not None and result>0, "quote zero or not available")
    return result

def evaluate(rpc: str) -> dict:
    raw=subprocess.run(["cast","block",str(BLOCK),"--rpc-url",rpc,"--json"],
        capture_output=True,text=True,timeout=35,check=False)
    require(raw.returncode==0,"block unavailable")
    try: h=json.loads(raw.stdout)
    except json.JSONDecodeError as exc:
        raise QuoteEvidenceError("malformed block JSON") from exc
    require(str(h.get("hash","")).lower()==HASH and
            str(h.get("parentHash","")).lower()==PARENT and
            parse_number(str(h.get("number","0")))==BLOCK,"canonical header mismatch")

    for pool in (CURVE_3POOL,CURVE_USDTB_USDC):
        code=cast(rpc,["code",pool])
        require(code is not None and len(code)>6, "Curve pool has no runtime code")

    three=coins(rpc,CURVE_3POOL,3)
    pair=coins(rpc,CURVE_USDTB_USDC,2)
    require(three==[DAI.lower(),USDC.lower(),USDT.lower()],
            "3pool canonical token/index identity mismatched")
    require(set(pair)=={USDtb.lower(),USDC.lower()},
            "USDtb/USDC Curve pool token/index identity mismatched")
    usdc_index=pair.index(USDC.lower())
    usdtb_index=pair.index(USDtb.lower())
    three_balances=[
        read_int(rpc,CURVE_3POOL,"balances(uint256)(uint256)",i)
        for i in range(3)
    ]
    pair_balances=[
        read_int(rpc,CURVE_USDTB_USDC,"balances(uint256)(uint256)",i)
        for i in range(2)
    ]
    require(all(v is not None for v in three_balances+pair_balances),
            "pool reserves unavailable")
    require(three_balances[1]>0 and three_balances[2]>0
            and pair_balances[usdc_index]>0 and pair_balances[usdtb_index]>0,
            "pool balances zero")
    three_fee=read_int(rpc,CURVE_3POOL,"fee()(uint256)",may_fail=True)
    usdtb_fee=read_int(rpc,CURVE_USDTB_USDC,"fee()(uint256)",may_fail=True)

    quotes=[]
    for size in SIZES:
        raw_usdt=size*10**6
        usdc=get_dy(rpc,CURVE_3POOL,2,1,raw_usdt)
        usdtb=get_dy(rpc,CURVE_USDTB_USDC,usdc_index,usdtb_index,usdc)
        require(usdtb<=pair_balances[usdtb_index],
                "theoretical output exceeds observed Curve USDtb pool reserves")
        quotes.append({
            "input_usdt_display":size,
            "input_usdt_raw":str(raw_usdt),
            "usdc_after_3pool_raw":str(usdc),
            "usdc_after_3pool_display":display(usdc,6),
            "usdtb_after_curve_pool_raw":str(usdtb),
            "usdtb_after_curve_pool_display":display(usdtb,18),
            "usdtb_out_per_usdt_in_decimal":
                str((Decimal(usdtb)/10**18)/(Decimal(raw_usdt)/10**6)),
            "full_input_consumed_onchain_proven":False,
            "actual_swap_executed":False,
            "liquidation_executed":False,
        })
    require(len(quotes)==len(SIZES),"incomplete bounded route curve")
    return {
        "schema_version":1,
        "contract":"NQC_RMC_V2_CURVE_USDT_TO_USDTB_TWOHOP_RESEARCH",
        "scope":"EXACT_HISTORICAL_SINGLE_ARCHIVE_RPC_ETH_CALL_ONLY",
        "chain_id":1,
        "block":BLOCK,
        "block_hash":HASH,
        "parent_hash":PARENT,
        "path":["USDT","CURVE_3POOL","USDC","CURVE_USDTB_USDC","USDtb"],
        "threepool_address":CURVE_3POOL.lower(),
        "usdtb_usdc_pool_address":CURVE_USDTB_USDC.lower(),
        "threepool_coins":three,
        "usdtb_pool_coins":pair,
        "usdtb_pool_coin_index":usdtb_index,
        "usdc_pool_coin_index":usdc_index,
        "threepool_fee_raw":None if three_fee is None else str(three_fee),
        "usdtb_pool_fee_raw":None if usdtb_fee is None else str(usdtb_fee),
        "threepool_reserve_units":[str(x) for x in three_balances],
        "usdtb_pool_reserve_units":[str(x) for x in pair_balances],
        "observed_usdtb_nominal_pool_balance_display":
            display(pair_balances[usdtb_index],18),
        "input_size_to_quote":quotes,
        "quote_source_uniswap_quoter":False,
        "capital_committed":False,
        "transaction_simulated":False,
        "strategy_implemented":False,
        "full_repayment_route_proven":False,
        "gas_sponsorship_admitted":False,
        "builder_competition_calibrated":False,
        "prospective_hf_under_one":False,
        "p2_shadow_certified":False,
        "rmc_closed":False,
        "commercial_score_upgrade":False,
        "realized_nqc_pnl_usd":"0",
        "nonclaims":["HISTORICAL_QUOTER_NOT_FORK_EXECUTED",
                     "NO_INPUT_CONSUMPTION_EXECUTION_PROOF",
                     "NO_MORPHO_AAVE_FLUID_ATOMIC_STRATEGY",
                     "NO_PROSPECTIVE_LIQUIDATION",
                     "NO_GAS_BUILDER_COMPETITION_CAPTURE_PROOF"],
    }

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("--rpc-url",required=True)
    parser.add_argument("--output",required=True)
    args=parser.parse_args()
    obj=evaluate(args.rpc_url)
    Path(args.output).write_text(json.dumps(obj,indent=2,sort_keys=True)+"\n")
    print(json.dumps({
        "status":"HISTORICAL_QUOTES_ONLY",
        "usdtb_pool_balance":obj["observed_usdtb_nominal_pool_balance_display"],
        "quotes":[{"input":x["input_usdt_display"],
                   "out_usdtb":x["usdtb_after_curve_pool_display"]}
                  for x in obj["input_size_to_quote"]]
    },sort_keys=True))

if __name__=="__main__":
    main()
