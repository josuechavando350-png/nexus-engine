#!/usr/bin/env python3
"""Ethereum Aave eMode24 historical read-only liquidation ceiling (NO AUTHORITY).

Exact ABI-hex words at one pinned block, no floats or custom oracles. Reads the
deployed Pool, AaveOracle, aToken, variable debt token and Fluid resolver.
Research only: Aave HF>1, so NO actual liquidation is admissible. A full
transaction with Morpho repayment, competitive capture or NQC P&L is NOT shown.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

BLOCK=26_184_741
BLOCK_HASH="0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT_HASH="0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
ORACLE="0x54586be62e3c3580375ae3723c145253060ca0c2"
BORROWER="0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
SUSDE="0x9d39a5de30e57443bff2a8307a4256c8797a3497"
USDTB="0xc139190f447e929f090edeb554d95abb8b18ac1c"
SUSDE_ATOKEN="0x4579a27af00a62c0eb156349f31b345c08386419"
USDTB_ATOKEN="0xec4ef66d4fceeba34abb4de69db391bc5476ccc8"
USDTB_VTOKEN="0xea85a065f87fe28aa8fbf0d6c7dec472b106252c"
FLUID="0x1dd125c32e4b5086c63cc13b3ca02c4a2a61fa9b"
FLUID_RESOLVER="0x05bd8269a20c472b148246de20e6852091bf16ff"
USDT_REQUIRED_MICRO=472_461_610_797
LEGACY_TARGET_MICRO=12_297_010_000
WAD=10**18
BPS=10_000
COVER=472_000*WAD
EXPECTED_EMODE=24
EXPECTED_PRICE_SUSDE=125_127_009
EXPECTED_PRICE_USDTB=100_000_000
EXPECTED_BONUS=10_310
UINT_MAX=2**256-1

class GateError(ValueError):
    pass

def require(condition,description):
    if not condition: raise GateError(description)

def exact_uint(raw):
    require(type(raw) is str,"uint256 RPC response must be text")
    s=raw.strip()
    require(re.fullmatch(r"0x[0-9a-fA-F]{1,64}|0|[1-9][0-9]*",s) is not None,
            "invalid canonical integer RPC response")
    value=int(s,16) if s.startswith("0x") else int(s)
    require(value<=UINT_MAX,"uint256 overflow")
    return value

def abi_words(raw,n):
    require(type(raw) is str and type(n) is int and n>0,
            "invalid ABI word count")
    require(re.fullmatch("0x(?:[0-9a-fA-F]{64}){"+str(n)+"}",raw.strip()) is not None,
            "unexpected return ABI payload size (fail closed)")
    h=raw.strip()[2:]
    return [int(h[i*64:(i+1)*64],16) for i in range(n)]

def addr_word(v):
    require(type(v) is int and 0<=v<2**160,"invalid ABI address padding")
    return "0x"+format(v,"040x")

def canonical_header(v):
    require(type(v) is dict and
            str(v.get("hash","")).lower()==BLOCK_HASH and
            str(v.get("parentHash","")).lower()==PARENT_HASH and
            exact_uint(str(v.get("number","0")))==BLOCK,
            "historical block identity mismatch")
    timestamp=exact_uint(str(v.get("timestamp","0")))
    require(timestamp>0,"block timestamp unavailable")
    return timestamp

def pct_half_up(value,bps):
    require(type(value) is int and value>=0 and type(bps) is int
            and 0<=bps<=20000,"percentage inputs invalid")
    return (value*bps+5000)//BPS

def pct_floor(value,bps):
    require(type(value) is int and value>=0 and type(bps) is int
            and bps>0,"percentage inputs invalid")
    return value*bps//BPS

def pct_ceil(value,bps):
    require(type(value) is int and value>=0 and type(bps) is int
            and 0<=bps<=BPS,"percentage inputs invalid")
    return (value*bps+BPS-1)//BPS

def collateral_math(cover,collateral_price,debt_price,collateral_decimals,
                    debt_decimals,bonus,protocol_fee,borrower_collateral):
    require(all(type(x) is int and x>0 for x in
                (cover,collateral_price,debt_price,borrower_collateral)),
            "integer positive collateral math parameters required")
    require(type(collateral_decimals) is int and type(debt_decimals) is int
            and collateral_decimals<=36 and debt_decimals<=36,
            "decimals unsupported")
    require(10000<=bonus<=20000 and 0<=protocol_fee<=10000,
            "bonus/fee bounds")
    base=(debt_price*cover*10**collateral_decimals)//(
        collateral_price*10**debt_decimals)
    gross=pct_floor(base,bonus)
    capped=gross>borrower_collateral
    # Never pretend the full 472k USDtb can be liquidated when gross
    # collateral exceeds the available borrower-specific balance.
    if capped:
        return {"status":"COLLATERAL_CAPPED_RECOMPUTE_DEBT",
                "base_susde_raw":str(base),
                "uncapped_gross_susde_raw":str(gross),
                "borrower_collateral_raw":str(borrower_collateral),
                "conditional_net_susde_raw":None}
    bonus_component=gross-pct_floor(gross,10000*10000//bonus) if False else (
        gross-(gross*BPS//bonus))
    fee=pct_ceil(bonus_component,protocol_fee)
    net=gross-fee
    return {
        "status":"CONDITIONAL_ONLY_HF_ABOVE_ONE",
        "base_susde_raw":str(base),"gross_susde_raw":str(gross),
        "gross_bonus_component_raw":str(bonus_component),
        "protocol_fee_raw":str(fee),"net_susde_raw":str(net),
        "net_susde_display":f"{net//WAD}.{net%WAD:018d}",
        "at_least_388k_susde":net>=388000*WAD,
        "at_least_387k_susde":net>=387000*WAD,
    }

class Cast:
    def __init__(self,url):
        require(type(url) is str and url.startswith("https://"),
                "archive RPC must be HTTPS")
        self.url=url
        self.transcript=[]
    def call(self,to,signature,*args,n=1):
        # eth_call only: never broadcast a transaction.
        cmd=["cast","call",to,signature,*[str(a) for a in args],
             "--block",str(BLOCK),"--rpc-url",self.url]
        try:
            p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                text=True,timeout=40,check=False)
        except (subprocess.TimeoutExpired,OSError) as exc:
            raise GateError("cast historical eth_call unavailable") from exc
        require(p.returncode==0,
                "eth_call failed for "+signature+": "+p.stderr[-140:])
        values=abi_words(p.stdout,n)
        self.transcript.append({"target":to.lower(),"method":signature,
                                "args":[str(a) for a in args],
                                "result_words":[str(x) for x in values]})
        return values[0] if n==1 else values
    def header(self):
        try:
            p=subprocess.run(["cast","block",str(BLOCK),"--rpc-url",self.url,
                  "--json"],capture_output=True,text=True,timeout=40,check=False)
        except (subprocess.TimeoutExpired,OSError) as exc:
            raise GateError("historical block header unavailable") from exc
        require(p.returncode==0,"cannot read block header")
        try:
            value=json.loads(p.stdout)
        except json.JSONDecodeError as exc:
            raise GateError("malformed block header") from exc
        return canonical_header(value)

def run(cast):
    ts=cast.header()
    mode=cast.call(POOL,"getUserEMode(address)",BORROWER)
    require(mode==EXPECTED_EMODE,"borrower no longer in eMode24 at pinned block")
    category=cast.call(POOL,"getEModeCategoryCollateralConfig(uint8)",mode,n=3)
    ltv,threshold,bonus=category
    require(bonus==EXPECTED_BONUS and threshold==9200 and ltv==9000,
            "eMode24 config mismatch against prior independent research")
    coll_bitmap=cast.call(POOL,"getEModeCategoryCollateralBitmap(uint8)",mode)
    borrower_bits=cast.call(POOL,"getUserConfiguration(address)",BORROWER)
    account=cast.call(POOL,"getUserAccountData(address)",BORROWER,n=6)
    collateral_base,debt_base,_,effective_liq_threshold,_,hf=account
    require(hf>WAD,"research fixture is not an admissible liquidation event")
    require(collateral_base>debt_base>0 and effective_liq_threshold>0,
            "borrower Aave account state invalid")
    collateral_config=cast.call(POOL,"getConfiguration(address)",SUSDE)
    debt_config=cast.call(POOL,"getConfiguration(address)",USDTB)
    col_reserve=cast.call(POOL,"getReserveData(address)",SUSDE,n=15)
    debt_reserve=cast.call(POOL,"getReserveData(address)",USDTB,n=15)
    col_id=col_reserve[7];debt_id=debt_reserve[7]
    require(col_id<128 and debt_id<128,"reserve IDs outside Aave bitmap range")
    require(addr_word(col_reserve[8])==SUSDE_ATOKEN,
            "sUSDe aToken differs from pinned Aave address book")
    require(addr_word(debt_reserve[8])==USDTB_ATOKEN and
            addr_word(debt_reserve[10])==USDTB_VTOKEN,
            "USDtb reserve token identity mismatch")
    require((coll_bitmap>>col_id)&1==1,"sUSDe excluded from eMode24 collateral bitmap")
    require((borrower_bits>>(2*col_id+1))&1==1,
            "borrower not using sUSDe as collateral")
    require((borrower_bits>>(2*debt_id))&1==1,
            "borrower not recorded as owing USDtb")
    for config,name in ((collateral_config,"sUSDe"),(debt_config,"USDtb")):
        require(((config>>56)&1)==1 and ((config>>60)&1)==0,
                name+" inactive or paused")
    col_dec=(collateral_config>>48)&255
    debt_dec=(debt_config>>48)&255
    require(col_dec==18 and debt_dec==18,"unexpected Aave token precision")
    protocol_fee=(collateral_config>>152)&65535
    require(0<=protocol_fee<=10000,"Aave reserve protocol fee out of range")
    col_bal=cast.call(SUSDE_ATOKEN,"balanceOf(address)",BORROWER)
    # Aave aToken balance held by borrower is a CLAIM; the actual sUSDe
    # held at the reserve aToken is the separate physical asset available
    # for liquidation with receiveAToken=false. Neither alone is sufficient.
    physical_susde_cash=cast.call(SUSDE,"balanceOf(address)",SUSDE_ATOKEN)
    borrower_debt=cast.call(USDTB_VTOKEN,"balanceOf(address)",BORROWER)
    available_usdtb=cast.call(USDTB,"balanceOf(address)",USDTB_ATOKEN)
    price_col=cast.call(ORACLE,"getAssetPrice(address)",SUSDE)
    price_debt=cast.call(ORACLE,"getAssetPrice(address)",USDTB)
    require(price_col==EXPECTED_PRICE_SUSDE and price_debt==EXPECTED_PRICE_USDTB,
            "Aave oracle price differs from pinned Blockscout observation")
    grace_col=cast.call(POOL,"getLiquidationGracePeriod(address)",SUSDE)
    grace_debt=cast.call(POOL,"getLiquidationGracePeriod(address)",USDTB)
    require(grace_col<ts and grace_debt<ts,
            "Aave liquidation grace sentinel active at pinned block")

    # Aave V3 origin close factor: 50% of total debt base for a position
    # with both reserve exposure > 2000 USD and HF > 0.95, otherwise 100%.
    col_base=col_bal*price_col//10**col_dec
    debt_reserve_base=(borrower_debt*price_debt+10**debt_dec-1)//10**debt_dec
    default_conditions=(col_base>=2000*10**8 and
                       debt_reserve_base>=2000*10**8 and
                       hf>950_000_000_000_000_000)
    default_cap_base=pct_half_up(debt_base,5000)
    debt_cap=borrower_debt
    if default_conditions and debt_reserve_base>default_cap_base:
        debt_cap=min(debt_cap,default_cap_base*10**debt_dec//price_debt)
    can_cover_472k=debt_cap>=COVER
    estimate=collateral_math(
        COVER,price_col,price_debt,col_dec,debt_dec,bonus,protocol_fee,col_bal
    )
    if estimate["status"]=="CONDITIONAL_ONLY_HF_ABOVE_ONE":
        net_for_liquidity=int(estimate["net_susde_raw"])
        estimate["aave_physical_susde_cash_raw"]=str(physical_susde_cash)
        estimate["physical_cash_covers_hypothetical_net_susde"]=(
            physical_susde_cash>=net_for_liquidity)
    if estimate["status"]=="CONDITIONAL_ONLY_HF_ABOVE_ONE" and can_cover_472k:
        net=int(estimate["net_susde_raw"])
        try:
            quoted=cast.call(FLUID_RESOLVER,
                "estimateSwapIn(address,bool,uint256,uint256)",
                FLUID,"true",net,1)
            estimate["fluid_estimate_status"]=(
                "POSITIVE_HISTORICAL_ESTIMATE_ONLY" if quoted>0
                else "ZERO_NOT_PROOF_OF_GLOBAL_NO_LIQUIDITY")
            estimate["fluid_estimate_usdt_raw"]=str(quoted)
            estimate["hypothetical_surplus_usdt_raw"]=(
                str(quoted-USDT_REQUIRED_MICRO) if quoted>0 else None)
            estimate["surplus_above_legacy_reference_before_other_costs"]=(
                quoted-USDT_REQUIRED_MICRO>=LEGACY_TARGET_MICRO if quoted>0 else False)
        except GateError as exc:
            estimate["fluid_estimate_status"]="UNKNOWN_CALL_FAILED"
            estimate["fluid_estimate_usdt_raw"]=None
            estimate["fluid_estimate_error"]=str(exc)[:150]
    else:
        estimate["fluid_estimate_status"]="NOT_QUOTED_COLLATERAL_OR_CLOSE_FACTOR_LIMIT"
        estimate["fluid_estimate_usdt_raw"]=None
    require(cast.header()==ts,"canonical header changed during state reads")
    return {
      "schema_version":1,"contract":"NQC_AAVE_EMODE24_EXACT_BLOCK_SEIZURE_NEGATIVE_GATE",
      "claim_scope":"HISTORICAL_SINGLE_ARCHIVE_RPC_RESEARCH_NO_P2",
      "chain_id":1,"block_number":BLOCK,"block_hash":BLOCK_HASH,
      "block_timestamp":ts,"user":BORROWER,"e_mode":mode,
      "emode_collateral_bitmap_raw":str(coll_bitmap),
      "borrower_configuration_bits_raw":str(borrower_bits),
      "collateral_reserve_id":col_id,"debt_reserve_id":debt_id,
      "liquidation_bonus_bps":bonus,"liquidation_protocol_fee_bps":protocol_fee,
      "oracle_susde_8decimals":str(price_col),
      "oracle_usdtb_8decimals":str(price_debt),
      "borrower_susde_atoken_balance_raw":str(col_bal),
      "aave_susde_underlying_cash_at_atoken_raw":str(physical_susde_cash),
      "aave_receive_underlying_cash_not_execution_guarantee":True,
      "borrower_usdtb_variable_debt_balance_raw":str(borrower_debt),
      "available_aave_usdtb_atoken_cash_raw":str(available_usdtb),
      "borrower_hf_wad_raw":str(hf),
      "hf_below_one":False,"close_factor_rule":"AAVE_V3_50PCT_IF_OVER_2000USD_AND_HF_GT_0_95",
      "close_factor_conditions_for_50_percent":default_conditions,
      "maximum_usdtb_debt_cover_raw_conditional":str(debt_cap),
      "472000_usdtb_size_within_conditional_close_factor":can_cover_472k,
      "aave_susde_collateral_grace_until":grace_col,
      "aave_usdtb_debt_grace_until":grace_debt,
      "collateral_seizure_sensitivity":estimate,
      "acquisition_curve_usdt_needed_raw":str(USDT_REQUIRED_MICRO),
      "cross_asset_full_route_executed":False,
      "aave_actual_liquidation_admitted":False,
      "liquidated_susde_obtained":False,"atomic_morpho_repayment_verified":False,
      "externally_sponsored_gas_verified":False,"independent_rpc_quorum":False,
      "competitive_capture_calibrated":False,
      "actual_nqc_net_pnl_usd":None,"realized_nqc_pnl_usd":"0",
      "commercial_score_upgrade":False,"shadow_p2_certified":False,
      "rmc_closed":False,
      "audit_transcript_sha256":hashlib.sha256(
          json.dumps(cast.transcript,sort_keys=True,separators=(",",":")).encode()
      ).hexdigest(),
      "limitations":[
         "HF_GT_ONE_AT_PINNED_BLOCK","ONE_ARCHIVE_RPC_ONLY_NOT_OPERATOR_QUORUM",
         "AAVE_DEPLOYED_IMPLEMENTATION_MATH_PARITY_NOT_TERMINAL_AT_THIS_BLOCK",
         "BORROWER_A_TOKEN_BALANCE_MAY_DIFFER_AFTER_RESERVE_UPDATE",
         "COLLATERAL_SEIZURE_IS_CONDITIONAL_NOT_EXECUTED",
         "PHYSICAL_CASH_NECESSARY_NOT_SUFFICIENT_FOR_RECEIVE_ATOKEN_FALSE",
         "FLUID_QUOTE_ONLY_NOT_SAME_TRANSACTION_SWAP_OR_REPAY",
         "BUILDER_PRIORITY_FEE_GAS_SPONSOR_AND_CAPTURE_UNPROVEN"]
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--rpc-url",required=True)
    p.add_argument("--out",required=True)
    ns=p.parse_args()
    evidence=run(Cast(ns.rpc_url))
    Path(ns.out).write_text(json.dumps(evidence,indent=2,sort_keys=True)+"\n")
    print("AAVE_HISTORICAL_NEGATIVE_STATE_ONLY")
    print(json.dumps({
      "fee_bps":evidence["liquidation_protocol_fee_bps"],
      "collateral_raw":evidence["borrower_susde_atoken_balance_raw"],
      "borrower_usdtb_debt_raw":evidence["borrower_usdtb_variable_debt_balance_raw"],
      "conditional_net_susde":evidence["collateral_seizure_sensitivity"].get("net_susde_display"),
      "fluid_usdt_quote":evidence["collateral_seizure_sensitivity"].get("fluid_estimate_usdt_raw"),
      "hf_below_one":evidence["hf_below_one"]
    },sort_keys=True))

if __name__=="__main__":
    main()
