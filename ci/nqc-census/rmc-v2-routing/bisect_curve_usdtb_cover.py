#!/usr/bin/env python3
"""Bounded historical quote inverse sizing, never execution authority.

Returns the smallest integer USDT input within a declared bracket satisfying
Curve 3pool USDT->USDC and Curve USDtb/USDC get_dy output. It checks the final
neighbor and call-time pinned block identity; neither establishes pool
concurrency/inclusion, real fill, future fee, gas, sponsorship or profitability.
"""
from __future__ import annotations

import argparse
from decimal import Decimal,localcontext
from functools import lru_cache
import json
from pathlib import Path
import re
from quote_curve_usdtb_twohop import (
    BLOCK,HASH,PARENT,CURVE_3POOL,CURVE_USDTB_USDC,
    USDC,USDtb,QuoteEvidenceError,require,cast,read_int,get_dy,
)

USDT_UNIT=10**6
USDtb_UNIT=10**18
LOW=472_000*USDT_UNIT
HIGH=500_000*USDT_UNIT
TARGETS=(
    ("MORPHO_USDT_ACQUIRE_472000_USDTB",472_000*USDtb_UNIT),
    ("AAVE_USDTB_REACQUIRE_PRINCIPAL_PLUS_236_PREMIUM",472_236*USDtb_UNIT),
)

def int_string(value: object, why: str) -> int:
    require(type(value) is str and bool(re.fullmatch(r"(0|[1-9][0-9]*)",value)),why)
    return int(value)

def verify_seed(seed: dict) -> tuple[int,int]:
    require(seed.get("contract")=="NQC_RMC_V2_CURVE_USDT_TO_USDTB_TWOHOP_RESEARCH"
            and seed.get("block")==BLOCK and seed.get("block_hash")==HASH,
            "wrong Curve upstream research seed")
    require(seed.get("parent_hash")==PARENT and
            seed.get("scope")=="EXACT_HISTORICAL_SINGLE_ARCHIVE_RPC_ETH_CALL_ONLY",
            "wrong source block, parent or evidence tier")
    require(seed.get("threepool_address")==CURVE_3POOL.lower()
            and seed.get("usdtb_usdc_pool_address")==CURVE_USDTB_USDC.lower(),
            "pool identity drift")
    require(seed.get("gas_sponsorship_admitted") is False
            and seed.get("strategy_implemented") is False
            and seed.get("p2_shadow_certified") is False
            and seed.get("commercial_score_upgrade") is False,
            "upstream fixture may not claim future execution")
    pair=seed.get("usdtb_pool_coins")
    require(type(pair) is list and len(pair)==2 and
            set(pair)=={USDC.lower(),USDtb.lower()}, "coin ID mismatch")
    usdc_idx=seed.get("usdc_pool_coin_index")
    usdtb_idx=seed.get("usdtb_pool_coin_index")
    require(type(usdc_idx) is int and type(usdtb_idx) is int
            and usdc_idx!=usdtb_idx and
            pair[usdc_idx]==USDC.lower() and pair[usdtb_idx]==USDtb.lower(),
            "coin indices corrupted")
    quotes=seed.get("input_size_to_quote")
    require(type(quotes) is list and len(quotes)==5,"seed cardinality")
    return usdc_idx,usdtb_idx

def output_amount(rpc: str,dx: int,i: int,j: int) -> tuple[int,int]:
    require(isinstance(dx,int) and LOW-1 <=dx<=HIGH,
            "out of bounded quote domain")
    usdc=get_dy(rpc,CURVE_3POOL,2,1,dx)
    out=get_dy(rpc,CURVE_USDTB_USDC,i,j,usdc)
    return usdc,out

def minimal_input(target: int, quote,low: int=LOW,high: int=HIGH) -> tuple[int,int,int,int]:
    require(type(target) is int and target>0, "target must be positive")
    require(type(low) is int and type(high) is int and 0<low<high,
            "invalid search interval")
    low_output=quote(low)[1]
    high_output=quote(high)[1]
    require(low_output<target<=high_output,
            "no strictly bracketed inverse quote at available trade sizes")
    left,right=low,high
    while left<right:
        mid=(left+right)//2
        if quote(mid)[1]>=target:
            right=mid
        else:
            left=mid+1
    usdc,amount=quote(left)
    prev=quote(left-1)[1]
    require(prev<target<=amount,"nonminimal or discontinuous inverse quote")
    return left,usdc,amount,prev

def evaluate(rpc: str,seed: dict) -> dict:
    i,j=verify_seed(seed)
    # Root source already pinned; explicitly read canonical header again so
    # this consumer cannot be replayed against a different RPC state.
    import subprocess
    check=subprocess.run(["cast","block",str(BLOCK),"--rpc-url",rpc,"--json"],
        capture_output=True,text=True,timeout=35,check=False)
    require(check.returncode==0,"canonical block unreadable during inverse sizing")
    header=json.loads(check.stdout)
    require(str(header.get("hash","")).lower()==HASH and
            str(header.get("parentHash","")).lower()==PARENT,
            "inverse run used noncanonical fork state")
    observed=seed["input_size_to_quote"]
    @lru_cache(maxsize=128)
    def quote(amount: int) -> tuple[int,int]:
        return output_amount(rpc,amount,i,j)
    for row in observed:
        inp=int_string(row["input_usdt_raw"],"seed input")
        if LOW <=inp<=HIGH:
            usdc,usdtb=quote(inp)
            require(str(usdc)==row["usdc_after_3pool_raw"] and
                    str(usdtb)==row["usdtb_after_curve_pool_raw"],
                    "upstream quote changed despite identical block")
    records=[]
    for name,target in TARGETS:
        needed,usdc,output,prior=minimal_input(target,quote)
        with localcontext() as ctx:
            ctx.prec=78
            input_units=Decimal(needed)/USDT_UNIT
            target_units=Decimal(target)/USDtb_UNIT
            residual=input_units-target_units
        records.append({
            "goal":name,
            "target_usdtb_raw":str(target),
            "target_usdtb_display":str(target_units),
            "required_usdt_raw":str(needed),
            "required_usdt_display":str(input_units),
            "usdc_out_raw":str(usdc),
            "usdtb_quote_out_raw":str(output),
            "preceding_usdtb_quote_out_raw":str(prior),
            "target_plus_slippage_delta_usdt_display":str(residual),
            "quote_minimal_within_bracket":True,
            "actual_swap_executed":False,
        })
    return {
        "schema_version":1,
        "contract":"NQC_RMC_V2_CURVE_TWOHOP_EXACT_INPUT_SIZING_RESEARCH_ONLY",
        "block_number":BLOCK,
        "block_hash":HASH,
        "source_tier":"SINGLE_ARCHIVE_RPC_HISTORICAL_QUOTE_NOT_EXECUTION",
        "minimum_usdt_quotes":records,
        "quote_function_evaluations":quote.cache_info().misses,
        "underlying_pool_balance_observed":seed["observed_usdtb_nominal_pool_balance_display"],
        "morpho_nominal_usdt_at_block_raw":"65666477002958",
        "aave_nominal_usdtb_at_block_raw":"2282160051774282408759215",
        "aave_illustrative_flash_premium_bps":5,
        "morpho_required_flash_tested_at_exact_size":False,
        "full_input_consumption_proven":False,
        "route_executed_on_fork":False,
        "route_gas_and_builder_costs_usd":None,
        "execution_probability_calibrated":False,
        "external_gas_nonrecourse_admitted":False,
        "decision_time_prospective":False,
        "p2_shadow_certified":False,
        "rmc_closed":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }

def main() -> None:
    p=argparse.ArgumentParser()
    p.add_argument("--rpc-url",required=True)
    p.add_argument("--seed",required=True)
    p.add_argument("--output",required=True)
    x=p.parse_args()
    obj=evaluate(x.rpc_url,json.loads(Path(x.seed).read_text()))
    Path(x.output).write_text(json.dumps(obj,indent=2,sort_keys=True)+"\n")
    print(json.dumps({
        "status":"EXACT_INTEGER_QUOTE_SIZING_NOT_EXECUTABLE",
        "target_size_records":[{
            "goal":r["goal"],
            "needed_usdt":r["required_usdt_display"],
            "target_usdtb":r["target_usdtb_display"]
        } for r in obj["minimum_usdt_quotes"]]
    },sort_keys=True))

if __name__=="__main__":main()
