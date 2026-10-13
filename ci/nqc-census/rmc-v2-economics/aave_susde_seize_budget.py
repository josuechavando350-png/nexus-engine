#!/usr/bin/env python3
"""RMC V2: exact-block Aave conditional sUSDe liquidation budget (NO AUTHORITY).

ETH_CALL ONLY. Rebuild 18-decimal sUSDe collateral amount for an illustrative
472,000 USDtb debt cover, using Aave eMode24, oracle, collateral protocol fee,
borrower aToken, debt token and close factor. This borrower is HF>1 at the
pinned historical block and CANNOT be liquidated. No flash borrowing, swap,
signature, live P&L, external gas or P2/Shadow authority is produced.

The integer arithmetic follows publicly auditable Aave V3 origin
LiquidationLogic._calculateAvailableCollateralToLiquidate. A model is not an
equivalent replacement for actual deployed-contract fork execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

CHAIN=1
BLOCK=26_184_741
BLOCK_HASH="0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT_HASH="0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
ORACLE="0x54586be62e3c3580375ae3723c145253060ca0c2"
PROVIDER="0x2f39d218133afab8f2b819b1066c7e434ad94e9e"
COLLATERAL="0x9d39a5de30e57443bff2a8307a4256c8797a3497"
DEBT="0xc139190f447e929f090edeb554d95abb8b18ac1c"
ATOKEN="0x4579a27af00a62c0eb156349f31b345c08386419"
VTOKEN="0xea85a065f87fe28aa8fbf0d6c7dec472b106252c"
BORROWER="0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
COVER=472_000*10**18
BITMAX=(1<<256)-1
PERCENT=10000
FLUID_FORK_USDT_MICRO={
    378000:472716380596,
    380000:475211854882,
    387000:483945545910,
    388000:485193156507,
}
CURVE_FORK_INPUT_USDT_MICRO=472461610797

class Reject(ValueError): pass

def require(ok,why):
    if not ok: raise Reject(why)

def natural(s,name):
    require(type(s) is str and re.fullmatch(r'(0|[1-9][0-9]*)',s) is not None,
            name+": unsigned canonical decimal string required")
    v=int(s)
    require(0<=v<=BITMAX,name+": uint256 overflow")
    return v

def words(x,n,name):
    require(type(x) is str and re.fullmatch(r'0x[0-9a-fA-F]{'+str(n*64)+'}',x) is not None,
            name+": ABI static response length or hex invalid")
    h=x[2:]
    return [int(h[i*64:(i+1)*64],16) for i in range(n)]

def addr_from_word(w):
    require(type(w) is int and 0<=w<2**160,"ABI address upper bits set")
    return "0x"+format(w,"040x")

def ceil_div(a,b):
    require(type(a) is int and a>=0 and type(b) is int and b>0,"invalid exact division")
    return (a+b-1)//b

def canonical_hash(obj):
    return hashlib.sha256(json.dumps(obj,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def budget(doc):
    require(type(doc) is dict and doc.get("schema_version")==1,"input schema")
    require(doc.get("evidence_scope")=="SINGLE_ARCHIVE_RPC_EXACT_BLOCK_RESEARCH_ONLY",
            "cannot upgrade evidence tier")
    require(doc.get("chain_id")==CHAIN and doc.get("block_number")==BLOCK
            and doc.get("block_hash")==BLOCK_HASH
            and doc.get("parent_hash")==PARENT_HASH,"noncanonical block")
    require(doc.get("research_only") is True and doc.get("nqc_realized_pnl_usd")=="0"
            and doc.get("prospective_trigger_seen") is False
            and doc.get("independent_rpc_quorum") is False
            and doc.get("gas_sponsor_admitted") is False
            and doc.get("p2_certified") is False
            and doc.get("rmc_closed") is False,"authority forgery")
    r=doc["state"]
    require(type(r) is dict,"missing onchain state")
    sc=words(r["sUSDe_reserve"],15,"sUSDe getReserveData")
    dc=words(r["USDtb_reserve"],15,"USDtb getReserveData")
    require(addr_from_word(sc[8])==ATOKEN and addr_from_word(dc[10])==VTOKEN,
            "aToken/variable debt token deployment drift")
    reserve_id=sc[7]
    require(0<=reserve_id<128,"bad Aave reserve id")
    cfg=sc[0]
    fee=(cfg>>152)&65535
    reserve_bonus=(cfg>>32)&65535
    cd=(cfg>>48)&255
    dd=(dc[0]>>48)&255
    require(cd==18 and dd==18,"wrong sUSDe/USDtb decimals")
    require((cfg>>56)&1==1 and (cfg>>60)&1==0,"reserve paused/inactive")
    require(0<=fee<=PERCENT and PERCENT<=reserve_bonus<=20000,
            "malformed liquidation protocol fee/bonus")
    mode=natural(r["emode"],"emode")
    bitmap=natural(r["emode_collateral_bitmap"],"collateral bitmap")
    lc=words(r["emode_collateral_config"],3,"eMode collateral config")
    require(mode==24 and (bitmap & (1<<reserve_id))!=0,
            "sUSDe is not eligible for borrower eMode 24 bonus")
    require(lc==[9000,9200,10310],"unexpected pinned eMode parameters")
    bonus=lc[2]
    pc=natural(r["sUSDe_price_1e8"],"sUSDe oracle")
    pd=natural(r["USDtb_price_1e8"],"USDtb oracle")
    require(0<pc<100*10**8 and 0<pd<100*10**8,"oracle stale/zero/unreasonable price")
    holdings=natural(r["borrower_sUSDe_aToken_balance"],"borrower aToken")
    actual_debt=natural(r["borrower_USDtb_vToken_balance"],"borrower vToken")
    require(holdings>0 and actual_debt>=COVER,"borrower collateral or debt insufficient")
    account=words(r["borrower_account"],6,"borrower Pool getUserAccountData")
    total_col,total_debt,_,weighted_lt,_,hf=account
    require(total_debt>0 and total_col>total_debt and 0<weighted_lt<=10000,"bad borrower account")
    require(hf>=10**18,"HF<1 requires separate prospective event gate")
    # Aave v3.5: close factor 50% for HF>0.95 and sufficiently material
    # collateral and debt. This is an ILLUSTRATIVE cap at HF>=1.
    dbase=ceil_div(actual_debt*pd,10**dd)
    cbase=holdings*pc//10**cd
    if hf>95*10**16 and dbase>=2000*10**8 and cbase>=2000*10**8:
        half=(total_debt*5000+5000)//PERCENT
        maxcover=(half*10**dd)//pd if dbase>half else actual_debt
    else:
        maxcover=actual_debt
    require(maxcover>=COVER,"requested USDtb cover exceeds conditional close factor")
    # Replicate the Aave V3-origin floor, bonus-only fee, ceil.
    base=(pd*COVER*10**cd)//(pc*10**dd)
    gross=min(base*bonus//PERCENT,holdings)
    needed=COVER if gross<holdings else ceil_div(
        ((pc*gross*10**dd)//(pd*10**cd))*PERCENT,bonus)
    bonus_part=gross-(gross*PERCENT)//bonus
    protocol_fee=ceil_div(bonus_part*fee,PERCENT)
    require(needed>0 and needed<=COVER and protocol_fee<=gross,
            "invalid available collateral accounting")
    net=gross-protocol_fee
    output={
      "schema_version":1,
      "contract":"NQC_RMC_V2_AAVE_SUSDE_SEIZE_BUDGET_CONDITIONAL_RESEARCH",
      "input_sha256":canonical_hash(doc),
      "block_number":BLOCK,"block_hash":BLOCK_HASH,
      "borrower":BORROWER,"health_factor_wad":str(hf),
      "health_factor_below_one":False,
      "emode":mode,"emode_bonus_bps":bonus,
      "sUSDe_protocol_liquidation_fee_bps":fee,
      "sUSDe_oracle_price_1e8":str(pc),"USDtb_oracle_price_1e8":str(pd),
      "borrower_sUSDe_aToken_balance_raw":str(holdings),
      "borrower_USDtb_vToken_debt_raw":str(actual_debt),
      "conditional_close_factor_max_cover_raw":str(maxcover),
      "illustrative_debt_cover_usdtb_raw":str(COVER),
      "conditional_gross_collateral_susde_raw":str(gross),
      "conditional_protocol_fee_susde_raw":str(protocol_fee),
      "conditional_liquidator_net_susde_raw":str(net),
      "conditional_debt_needed_usdtb_raw":str(needed),
      "gross_388k_susde_possible":gross>=388000*10**18,
      "net_388k_susde_possible":net>=388000*10**18,
      "net_minus_388k_susde_raw":str(net-388000*10**18),
      "separate_fluid_fork_sizes":{str(k):{
        "output_usdt_micro":str(v),
        "conditional_net_susde_can_supply_this_size":net>=k*10**18,
        "separate_reverted_historical_fork":True,
        "hypothetical_pre_other_costs_margin_usdt_micro":str(v-CURVE_FORK_INPUT_USDT_MICRO),
       } for k,v in FLUID_FORK_USDT_MICRO.items()},
      "no_interpolation_between_samples":True,
      "liquidation_executed":False,"route_settled":False,
      "prospective_hf_crossing":False,"external_nonrecourse_gas":False,
      "builder_competition_capture_proven":False,"economic_net_pnl_usd":None,
      "p2_shadow_certified":False,"rmc_closed":False,
      "commercial_score_upgrade":False,"nqc_realized_pnl_usd":"0",
      "limitations":[
        "NO_ACTUAL_LIQUIDATION_HF_ABOVE_ONE",
        "CONDITIONAL_MATH_DEPLOYED_FORK_PARITY_NOT_YET_ATTESTED",
        "NO_EIP1898_BLOCK_HASH_ETH_CALL_OPERATOR_QUORUM",
        "SEPARATE_CURVE_FLUID_FORKS_NOT_ATOMIC_PNL",
        "NO_SUSDE_COLLATERAL_FROM_SUCCESSFUL_AAVE_LIQUIDATION",
        "NO_EXTERNAL_GAS_BUILDER_MEASUREMENTS",
       ]
    }
    return output

def cast(url,cmd):
    require(type(url) is str and url.startswith("https://"),"HTTPS archive provider")
    response=subprocess.run(["cast",*cmd,"--rpc-url",url],
                            text=True,capture_output=True,timeout=35,check=False)
    require(response.returncode==0,"RPC call unavailable: "+response.stderr[-170:])
    return response.stdout.strip()

def pinned(url):
    h=json.loads(cast(url,["block",str(BLOCK),"--json"]))
    require(str(h.get("hash","")).lower()==BLOCK_HASH
            and str(h.get("parentHash","")).lower()==PARENT_HASH
            and int(str(h.get("number","0")),16)==BLOCK,"noncanonical archive header")

def collect(url):
    pinned(url)
    require(int(cast(url,["chain-id"]).split()[0])==CHAIN,"not Ethereum")
    # Verify current price oracle from PoolAddressesProvider, rather than
    # blindly trusting a present-day generated address-book value.
    assert_oracle=cast(url,["call",PROVIDER,"getPriceOracle()(address)","--block",str(BLOCK)])
    require(assert_oracle.split()[0].lower()==ORACLE,"Aave oracle changed at pinned block")
    ops={
        "sUSDe_reserve":(POOL,"getReserveData(address)",COLLATERAL),
        "USDtb_reserve":(POOL,"getReserveData(address)",DEBT),
        "emode":(POOL,"getUserEMode(address)(uint256)",BORROWER),
        "emode_collateral_bitmap":(POOL,"getEModeCategoryCollateralBitmap(uint8)(uint128)","24"),
        "emode_collateral_config":(POOL,"getEModeCategoryCollateralConfig(uint8)","24"),
        "sUSDe_price_1e8":(ORACLE,"getAssetPrice(address)(uint256)",COLLATERAL),
        "USDtb_price_1e8":(ORACLE,"getAssetPrice(address)(uint256)",DEBT),
        "borrower_sUSDe_aToken_balance":(ATOKEN,"balanceOf(address)(uint256)",BORROWER),
        "borrower_USDtb_vToken_balance":(VTOKEN,"balanceOf(address)(uint256)",BORROWER),
        "borrower_account":(POOL,"getUserAccountData(address)",BORROWER),
    }
    state={}
    raw_fields={"sUSDe_reserve","USDtb_reserve","emode_collateral_config","borrower_account"}
    for key,(address,fn,arg) in ops.items():
        v=cast(url,["call",address,fn,arg,"--block",str(BLOCK)])
        if key in raw_fields:
            require(v.startswith("0x"),key+": require unrounded raw ABI")
            state[key]=v
        else:
            state[key]=str(int(v.split()[0],16) if v.startswith("0x") else natural(v.split()[0],key))
    pinned(url)
    return {
        "schema_version":1,"evidence_scope":"SINGLE_ARCHIVE_RPC_EXACT_BLOCK_RESEARCH_ONLY",
        "chain_id":CHAIN,"block_number":BLOCK,"block_hash":BLOCK_HASH,
        "parent_hash":PARENT_HASH,"state":state,
        "research_only":True,"nqc_realized_pnl_usd":"0",
        "prospective_trigger_seen":False,"independent_rpc_quorum":False,
        "gas_sponsor_admitted":False,"p2_certified":False,"rmc_closed":False
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--rpc-url",required=True)
    p.add_argument("--source-out",required=True)
    p.add_argument("--result-out",required=True)
    a=p.parse_args()
    d=collect(a.rpc_url)
    report=budget(d)
    Path(a.source_out).write_text(json.dumps(d,indent=2,sort_keys=True)+"\n")
    Path(a.result_out).write_text(json.dumps(report,indent=2,sort_keys=True)+"\n")
    print(json.dumps({
        "emod_liquidation_bonus_bps":report["emode_bonus_bps"],
        "protocol_fee_bps":report["sUSDe_protocol_liquidation_fee_bps"],
        "gross_susde_raw":report["conditional_gross_collateral_susde_raw"],
        "net_susde_raw":report["conditional_liquidator_net_susde_raw"],
        "can_supply_388k_susde":report["net_388k_susde_possible"],
        "no_liquidation_possible_at_current_hf":True,
    },sort_keys=True))

if __name__=="__main__":main()
