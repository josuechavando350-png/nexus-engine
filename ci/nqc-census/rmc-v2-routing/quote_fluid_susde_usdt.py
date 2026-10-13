#!/usr/bin/env python3
"""Pinned Ethereum Fluid sUSDe/USDT venue/quote census — no execution authority.

Fluid DEX T1 is not a constant-product ERC20 reserve pool. Its liquidity
availability depends on the Fluid liquidity layer, withdraw/borrow limits and
adjusted imaginary reserves. ERC20.balanceOf(pool) is a raw token observation,
NOT full executable swap capacity. estimateSwapIn is the official resolver
estimate, NOT evidence of token transfer or a guarantee of live execution.

All token amounts are canonical uint256 decimal strings; never use floats.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

BLOCK=26_184_741
HASH="0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT="0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
POOL="0x1dd125c32e4b5086c63cc13b3ca02c4a2a61fa9b"
FACTORY="0x91716c4eda1fb55e84bf8b4c7085f84285c19085"
RESOLVER="0x05bd8269a20c472b148246de20e6852091bf16ff"
SUSDE="0x9d39a5de30e57443bff2a8307a4256c8797a3497"
USDT="0xdac17f958d2ee523a2206206994597c13d831ec7"
MORPHO="0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"
EXPECTED_ID=15
SIZES=(1,100,1000,10000,50000,100000,200000,400000)
UINT=(1<<256)-1

class EvidenceError(ValueError):
    pass

def require(test: bool, message: str):
    if not test:
        raise EvidenceError(message)

def uint_from_rpc(raw: str) -> int:
    require(type(raw) is str, "RPC uint256 response must be string")
    s=raw.strip().split()[0] if raw.strip() else ""
    if s.startswith("0x"):
        require(re.fullmatch(r"0x[0-9a-fA-F]{1,64}",s) is not None,
                "invalid uint256 hex")
        n=int(s,16)
    else:
        require(re.fullmatch(r"(0|[1-9][0-9]*)",s) is not None,
                "invalid uint256 decimal")
        n=int(s)
    require(0<=n<=UINT,"uint256 out of range")
    return n

def address_from_word(word: str) -> str:
    require(type(word) is str and re.fullmatch("[0-9a-fA-F]{64}",word) is not None,
            "address ABI word must be exactly 32 bytes")
    require(int(word[:24],16)==0,"address ABI word has nonzero high bytes")
    return "0x"+word[24:].lower()

def decode_fluid_constant_views(raw: str) -> dict:
    """Static ABI for IFluidDexT1.ConstantViews, per official iDexT1.sol.

    Fields 0 dexId, 1 liquidity, 2 factory, 3-7 implementations,
    8 deployerContract, 9 token0, 10 token1, 11-16 token price slots,
    17 oracleMapping. No dynamic offset in the returned struct.
    """
    require(type(raw) is str and re.fullmatch(r"0x(?:[0-9a-fA-F]{64}){18}",raw.strip()) is not None,
            "Fluid constantsView must be exactly 18 static uint256 words")
    body=raw.strip()[2:]
    words=[body[i*64:(i+1)*64] for i in range(18)]
    return {
        "dex_id":uint_from_rpc("0x"+words[0]),
        "liquidity_contract":address_from_word(words[1]),
        "factory":address_from_word(words[2]),
        "deployer_contract":address_from_word(words[8]),
        "token0":address_from_word(words[9]),
        "token1":address_from_word(words[10]),
        "oracle_mapping":str(uint_from_rpc("0x"+words[17])),
    }

def verify_deployment(v: dict):
    require(v.get("dex_id")==EXPECTED_ID,"wrong Fluid dex pool ID")
    require(v.get("factory")==FACTORY,"unverified Fluid factory")
    require(v.get("token0")==SUSDE and v.get("token1")==USDT,
            "Fluid tokens reversed or mismatched")
    require(re.fullmatch(r"0x[0-9a-f]{40}",v.get("liquidity_contract","")) is not None
            and v["liquidity_contract"] != "0x"+"0"*40,
            "Fluid liquidity layer address invalid")

def rpc(rpc_url: str, argv: list[str],timeout: int=35) -> str:
    require(rpc_url.startswith("https://"),"public HTTPS RPC required")
    try:
        p=subprocess.run(["cast",*argv,"--rpc-url",rpc_url],
                         capture_output=True,text=True,timeout=timeout,check=False)
    except (subprocess.TimeoutExpired,OSError) as exc:
        raise EvidenceError("RPC request failed or timed out") from exc
    require(p.returncode==0,"RPC unavailable: "+(p.stderr[-210:] or "cast failed"))
    return p.stdout.strip()

def on_block(rpc_url: str, action: list[str]) -> str:
    return rpc(rpc_url,[*action,"--block",str(BLOCK)])

def header(rpc_url: str) -> dict:
    response=rpc(rpc_url,["block",str(BLOCK),"--json"])
    try:
        v=json.loads(response)
    except json.JSONDecodeError as exc:
        raise EvidenceError("malformed canonical block header") from exc
    require(type(v) is dict and str(v.get("hash","")).lower()==HASH
            and str(v.get("parentHash","")).lower()==PARENT
            and uint_from_rpc(str(v.get("number","0")))==BLOCK,
            "archive RPC canonical block hash, number or parent mismatch")
    return {"block_number":BLOCK,"hash":HASH,"parent_hash":PARENT}

def token_balance(rpc_url: str, token: str, owner: str) -> int:
    return uint_from_rpc(on_block(
        rpc_url,["call",token,"balanceOf(address)(uint256)",owner]))

def estimate(rpc_url: str, token0_in: int) -> dict:
    require(type(token0_in) is int and token0_in>0 and token0_in<=400_000*10**18,
            "bounded Fluid research input violated")
    try:
        out=uint_from_rpc(on_block(
            rpc_url,["call",RESOLVER,"estimateSwapIn(address,bool,uint256,uint256)(uint256)",
                     POOL,"true",str(token0_in),"1"]))
        return {
            "status": "QUOTE_RETURNED" if out>0 else "QUOTE_ZERO_NOT_CAPACITY",
            "output_usdt_raw":str(out),
            "zero_meaning_full_route_unavailable":False,
        }
    except EvidenceError as exc:
        return {"status":"ESTIMATOR_UNAVAILABLE_OR_REVERT",
                "output_usdt_raw":None,
                "error":str(exc)[:220],
                "zero_meaning_full_route_unavailable":False}

def evaluate(url: str) -> dict:
    first=header(url)
    chain_id=uint_from_rpc(rpc(url,["chain-id"]))
    require(chain_id==1,"not Ethereum mainnet")

    for address,name in ((POOL,"Fluid DEX"),(RESOLVER,"Fluid reserve resolver"),
                         (SUSDE,"sUSDe"),(USDT,"USDT")):
        code=on_block(url,["code",address])
        require(code.startswith("0x") and len(code)>16,
                name+" deployed runtime code missing")

    decoded=decode_fluid_constant_views(
        on_block(url,["call",POOL,"constantsView()"]))
    verify_deployment(decoded)
    dex_id=uint_from_rpc(on_block(url,["call",POOL,"DEX_ID()(uint256)"]))
    require(dex_id==EXPECTED_ID,"Fluid DEX_ID getter mismatch")

    balances={
        "susde_balance_at_dex_raw":str(token_balance(url,SUSDE,POOL)),
        "usdt_balance_at_dex_raw":str(token_balance(url,USDT,POOL)),
        "susde_balance_at_morpho_raw":str(token_balance(url,SUSDE,MORPHO)),
        "usdt_balance_at_morpho_raw":str(token_balance(url,USDT,MORPHO)),
    }
    # This is a historical source crosscheck, not flash borrowing certification.
    require(balances["usdt_balance_at_morpho_raw"]=="65666477002958",
            "known historical Morpho USDT balance mismatch")

    quotes=[]
    for n in SIZES:
        row=estimate(url,n*10**18)
        quotes.append({
            "input_susde_raw":str(n*10**18),
            "input_susde_nominal_units":str(n),
            **row,"actual_swap_executed":False,
            "full_input_consumption_proven":False,
            "realistic_gas_cost_measured":False,
        })

    # Canonicality can change while many calls are running. Recheck.
    second=header(url)
    require(second==first,"chain reorg or block identity drift during census")

    return {
        "schema_version":1,
        "contract":"NQC_V2_FLUID_SUSDE_USDT_VENUE_HISTORICAL_RESEARCH_ONLY",
        "source_tier":"SINGLE_ARCHIVE_RPC_FORK_QUOTE_NOT_EXECUTION",
        "chain_id":1,
        "block":BLOCK,"block_hash":HASH,"parent_hash":PARENT,
        "dex_pool_address":POOL,
        "resolver_address":RESOLVER,
        "official_fluid_source_reference":
           "Instadapp/fluid-contracts-public/contracts/protocols/dex/interfaces/iDexT1.sol",
        "fluid_dex_constants":decoded,
        "raw_erc20_balances_not_total_liquidity":balances,
        "estimator_quotes":quotes,
        "quote_positive_count":sum(r["status"]=="QUOTE_RETURNED" for r in quotes),
        "quote_unavailable_count":sum(r["status"]=="ESTIMATOR_UNAVAILABLE_OR_REVERT" for r in quotes),
        "quotes_do_not_prove_full_input_consumption":True,
        "token_out_0_or_pool_cash_not_available_size_proof":True,
        "actual_swap_executed":False,
        "aave_liquidation_executed":False,
        "s_usde_seized":False,
        "morpho_capital_committed":False,
        "external_gas_sponsor_admitted":False,
        "competitive_capture_calibrated":False,
        "end_to_end_net_pnl_usd":None,
        "prospective_hf_under_one_seen":False,
        "shadow_p2_certified":False,
        "rmc_closed":False,
        "commercial_score_upgrade":False,
        "realized_nqc_pnl_usd":"0",
    }

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("--rpc-url",required=True)
    ap.add_argument("--out",required=True)
    args=ap.parse_args()
    result=evaluate(args.rpc_url)
    Path(args.out).write_text(json.dumps(result,sort_keys=True,indent=2)+"\n")
    print(json.dumps({"contract":result["contract"],
                      "block":result["block"],"dex_id":result["fluid_dex_constants"]["dex_id"],
                      "positive_quotes":result["quote_positive_count"],
                      "unavailable_quotes":result["quote_unavailable_count"]},sort_keys=True))

if __name__=="__main__":
    main()
