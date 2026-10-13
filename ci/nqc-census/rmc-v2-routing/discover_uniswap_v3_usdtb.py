#!/usr/bin/env python3
"""Block-pinned, strictly bounded Uniswap V3 USDtb venue probe (read-only).

This is NOT an exhaustive liquidity/router discovery. It queries a known
Uniswap V3 factory on one selected archive RPC, asks the canonical Quoter
for bounded hypothetical quotes and emits no executable, net-profit or
prospective capture authority. No tx signing, broadcasting or token spending.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

CHAIN_ID = 1
BLOCK = 26_184_741
BLOCK_HASH = "0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT_HASH = "0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984"
UNISWAP_V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6"
USDtb = "0xC139190F447e929f090Edeb554D95AbB8b18aC1C"
USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"
FEES = (100,500,3000,10000)
PAIR_INPUTS = (("USDC",USDC,6),("USDT",USDT,6))
SIZES = (1_000,472_000)
ZERO = "0x"+"0"*40
ADDRESS = re.compile(r"0x[0-9a-fA-F]{40}")
UINT256_MAX = 2**256-1

class BoundedProbeError(ValueError):
    pass

def require(flag: bool, message: str) -> None:
    if not flag:
        raise BoundedProbeError(message)

def first(text: str) -> str:
    parts=text.strip().split()
    require(bool(parts), "empty cast output")
    return parts[0]

def parse_uint(text: str) -> int:
    value=first(text)
    require(bool(re.fullmatch(r"(0x[0-9a-fA-F]+|[0-9]+)",value)),
            "cast number is not an exact unsigned integer")
    n=int(value,16) if value.startswith("0x") else int(value)
    require(0<=n<=UINT256_MAX, "cast value is outside uint256")
    return n

def parse_address(text: str) -> str:
    value=first(text)
    require(bool(ADDRESS.fullmatch(value)), "cast result is not one EVM address")
    return value.lower()

def canonical_hash(data: object) -> str:
    return hashlib.sha256(json.dumps(
        data,sort_keys=True,separators=(",",":"),ensure_ascii=True
    ).encode("utf-8")).hexdigest()

def assert_header(header: dict) -> None:
    require(type(header) is dict, "invalid block header response")
    require(str(header.get("hash","")).lower()==BLOCK_HASH, "block hash mismatch")
    require(str(header.get("parentHash","")).lower()==PARENT_HASH, "parent hash mismatch")
    number=header.get("number")
    require(number is not None and parse_uint(str(number))==BLOCK,
            "block number mismatch")

def output_row(name: str, address: str, fee: int, pool: str) -> dict:
    require(name in ("USDC","USDT"), "unsupported quote asset")
    require(address.lower() == (USDC if name=="USDC" else USDT).lower(),
            "invalid quote asset address")
    require(fee in FEES, "unknown fee tier")
    return {
        "input_asset":name,
        "input_asset_address":address.lower(),
        "output_asset":"USDtb",
        "fee_pips":fee,
        "pool_address":pool.lower(),
        "is_deployed":pool.lower()!=ZERO,
        "quoted_route_admitted":False,
        "capital_executable_admitted":False,
        "quotes":[],
    }

def classify_result(row: dict) -> dict:
    require(row["quoted_route_admitted"] is False and
            row["capital_executable_admitted"] is False,
            "research quotes cannot self-admit executable capital or routing")
    if not row["is_deployed"]:
        require(row["pool_address"]==ZERO and not row["quotes"],
                "unseen pool cannot contain quotes")
        row["status"]="POOL_NOT_DEPLOYED_AT_FEE"
    elif int(row["pool_active_liquidity_raw"])==0:
        row["status"]="DEPLOYED_BUT_ZERO_ACTIVE_LIQUIDITY"
    elif any(q.get("amount_out_usdtb_raw") is not None for q in row["quotes"]):
        row["status"]="HISTORICAL_QUOTER_RESPONSE_NONEXECUTABLE"
    else:
        row["status"]="POOL_FOUND_BUT_NO_SUCCESSFUL_QUOTE"
    return row

def run_cmd(rpc: str, arguments: list[str], *, may_fail: bool=False) -> str | None:
    require(rpc.startswith("https://"), "only HTTPS RPC is allowed")
    cmd=["cast", *arguments,"--block",str(BLOCK),"--rpc-url",rpc]
    try:
        response=subprocess.run(cmd,check=False,capture_output=True,text=True,timeout=35)
    except (OSError,subprocess.TimeoutExpired):
        if may_fail:
            return None
        raise BoundedProbeError("required archive RPC call failed")
    if response.returncode!=0:
        if may_fail:
            return None
        raise BoundedProbeError("required archive RPC call failed")
    return response.stdout.strip()

def query(rpc: str) -> dict:
    require(rpc.startswith("https://"), "invalid RPC scheme")
    block_json=subprocess.run(
        ["cast","block",str(BLOCK),"--rpc-url",rpc,"--json"],
        check=False,capture_output=True,text=True,timeout=35,
    )
    require(block_json.returncode==0,"canonical block unavailable")
    try:
        header=json.loads(block_json.stdout)
    except json.JSONDecodeError as exc:
        raise BoundedProbeError("invalid canonical block JSON") from exc
    assert_header(header)
    factory_code=run_cmd(rpc,["code",UNISWAP_V3_FACTORY])
    quoter_code=run_cmd(rpc,["code",UNISWAP_V3_QUOTER])
    require(factory_code is not None and len(factory_code)>4 and
            quoter_code is not None and len(quoter_code)>4, "factory/quoter not deployed")
    rows=[]
    for name,asset,decimals in PAIR_INPUTS:
        for fee in FEES:
            pool=parse_address(run_cmd(rpc,[
                "call",UNISWAP_V3_FACTORY,
                "getPool(address,address,uint24)(address)",asset,USDtb,str(fee)
            ]))
            row=output_row(name,asset,fee,pool)
            if pool == ZERO:
                rows.append(classify_result(row))
                continue
            code=run_cmd(rpc,["code",pool])
            require(code is not None and len(code)>4,"factory pool runtime missing")
            token0=parse_address(run_cmd(rpc,["call",pool,"token0()(address)"]))
            token1=parse_address(run_cmd(rpc,["call",pool,"token1()(address)"]))
            require({token0,token1}=={asset.lower(),USDtb.lower()},
                    "deployed pool token pair does not match factory query")
            liquidity=parse_uint(run_cmd(rpc,["call",pool,"liquidity()(uint128)"]))
            usdtb_balance=parse_uint(run_cmd(rpc,[
                "call",USDtb,"balanceOf(address)(uint256)",pool
            ]))
            input_balance=parse_uint(run_cmd(rpc,[
                "call",asset,"balanceOf(address)(uint256)",pool
            ]))
            row.update({
                "pool_active_liquidity_raw":str(liquidity),
                "usdtb_pool_balance_raw":str(usdtb_balance),
                "input_token_pool_balance_raw":str(input_balance),
                "pool_token0":token0,
                "pool_token1":token1,
                "runtime_code_sha256":hashlib.sha256(code.encode()).hexdigest(),
            })
            if liquidity>0:
                for size in SIZES:
                    amount=size*10**decimals
                    result=run_cmd(rpc,[
                        "call",UNISWAP_V3_QUOTER,
                        "quoteExactInputSingle(address,address,uint24,uint256,uint160)(uint256)",
                        asset,USDtb,str(fee),str(amount),"0",
                    ],may_fail=True)
                    out=None
                    if result is not None:
                        try:
                            value=parse_uint(result)
                            if value>0:
                                out=str(value)
                        except BoundedProbeError:
                            pass
                    row["quotes"].append({
                        "input_display_units":size,
                        "input_raw":str(amount),
                        "amount_out_usdtb_raw":out,
                        "quote_exact_input_returned":out is not None,
                        "real_swap_executed":False,
                    })
            rows.append(classify_result(row))
    require(len(rows)==len(PAIR_INPUTS)*len(FEES), "incomplete bounded factory census")
    result={
        "schema_version":1,
        "contract":"NQC_RMC_V2_USDTB_UNISWAP_V3_BOUNDED_VENUE_CENSUS",
        "chain_id":CHAIN_ID,"block_number":BLOCK,"block_hash":BLOCK_HASH,
        "parent_hash":PARENT_HASH,
        "scope":"HISTORICAL_SINGLE_RPC_READONLY_BOUNDED_FEES_ONLY",
        "source_operator_quorum":False,
        "factory_address":UNISWAP_V3_FACTORY.lower(),
        "quoter_address":UNISWAP_V3_QUOTER.lower(),
        "fee_tiers_checked":list(FEES),
        "pair_inputs":[x[0] for x in PAIR_INPUTS],
        "pools":rows,
        "found_pool_count":sum(x["is_deployed"] for x in rows),
        "successful_quote_count":sum(
            sum(q["quote_exact_input_returned"] for q in x["quotes"]) for x in rows
        ),
        "exhaustive_all_dex_venues":False,
        "verified_route_profit":False,
        "net_pnl_usd":None,
        "opportunity_actionable":False,
        "external_gas_sponsor_proven":False,
        "competition_survival_proven":False,
        "capital_execute_admitted":False,
        "p2_shadow_certified":False,
        "rmc_closed":False,
        "commercial_score_upgrade":False,
        "realized_nqc_pnl_usd":"0",
        "nonclaims":[
            "FACTORY_FEE_TIER_SUBSET_ONLY",
            "NO_AGGREGATOR_EXHAUSTIVENESS",
            "EXACT_INPUT_QUOTES_ARE_NOT_EXECUTED_SWAPS",
            "POOL_BALANCES_DO_NOT_PROVE_ROUTING_CAPACITY",
            "NO_CROSS_ASSET_ATOMIC_STRATEGY_OR_GAS_SPONSOR",
            "HF_NOT_BELOW_ONE",
            "NO_PROFIT_CERTIFICATION"
        ],
    }
    result["self_hash_without_self_field"]=canonical_hash(result)
    return result

def main() -> None:
    parser=argparse.ArgumentParser()
    parser.add_argument("--rpc-url",required=True)
    parser.add_argument("--output",required=True)
    ns=parser.parse_args()
    result=query(ns.rpc_url)
    Path(ns.output).write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps({
        "status":"READONLY_NON_AUTHORITY",
        "found_pool_count":result["found_pool_count"],
        "successful_quote_count":result["successful_quote_count"],
        "fee_tiers_checked":result["fee_tiers_checked"],
    },sort_keys=True))

if __name__=="__main__":
    main()
