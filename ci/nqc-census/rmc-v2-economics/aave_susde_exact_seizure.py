#!/usr/bin/env python3
"""RMC V2 Aave sUSDe / USDtb counterfactual liquidation arithmetic.

Read-only Ethereum archive RPC at the *exact* original, non-liquidatable block
26184741. No oracle manipulation, no executed liquidation, no capital use.
The Aave v3-origin integer formulas below preserve percentMulFloor,
percentDivFloor and percentMulCeil semantics, including protocol fee.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

BLOCK=26184741
BLOCK_HASH="0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe"
PARENT_HASH="0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66"
POOL="0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
ORACLE="0x54586be62e3c3580375ae3723c145253060ca0c2"
BORROWER="0x08c14b32c8a48894e4b933090ebcc9ce33b21135"
SUSDE="0x9d39a5de30e57443bff2a8307a4256c8797a3497"
SUSDE_ATOKEN="0x4579a27af00a62c0eb156349f31b345c08386419"
USDTB="0xc139190f447e929f090edeb554d95abb8b18ac1c"
USDTB_VTOKEN="0xea85a065f87fe28aa8fbf0d6c7dec472b106252c"
EMODE_ID=24
EMODE_BONUS_BPS=10310
COVER=472000*10**18
TARGET_SUSDE=388000*10**18
PERCENT_FACTOR=10000
LOW_CLOSE_HF=95*10**16
WAD=10**18
MIN_BASE_MAX_CLOSE=2000*10**8
UINT256_MAX=2**256-1

class EvidenceError(ValueError): pass

def require(value: bool, error: str) -> None:
    if not value: raise EvidenceError(error)

def nat(x: object, title: str, positive: bool=False) -> int:
    require(type(x) is int and 0 <= x <= UINT256_MAX and (not positive or x>0),
            title+": canonical uint256 required")
    return x

def decode_rpc_uint(raw: str) -> int:
    require(type(raw) is str,"cast ABI response must be UTF-8")
    s=raw.strip()
    require(re.fullmatch(r"0x[0-9a-fA-F]{64}",s) is not None,
            "exact ABI call must return one 32-byte uint")
    return int(s,16)

def abi_words(raw: str, count: int) -> list[int]:
    require(type(raw) is str and type(count) is int and count>0,
            "ABI response/cardinality invalid")
    raw=raw.strip()
    require(re.fullmatch("0x(?:[0-9a-fA-F]{64}){"+str(count)+"}",raw) is not None,
            "unexpected ABI output word count: "+str(count))
    return [int(raw[2+i*64:2+(i+1)*64],16) for i in range(count)]

def typed_address(word: int) -> str:
    nat(word,"ABI address")
    require(word < 2**160,"nonzero ABI address high bits")
    return "0x"+format(word,"040x")

def percent_mul_floor(value: int,bps: int) -> int:
    nat(value,"percent_mul_floor amount")
    require(type(bps) is int and 0<=bps<=10000*10,"basis points out of range")
    require(value*bps<=UINT256_MAX,"percentMulFloor intermediate overflow")
    return value*bps//PERCENT_FACTOR

def percent_div_floor(value: int,bps: int) -> int:
    nat(value,"percent_div_floor amount")
    require(type(bps) is int and bps>0,"percentDivFloor denominator")
    require(value*PERCENT_FACTOR<=UINT256_MAX,"percentDivFloor overflow")
    return value*PERCENT_FACTOR//bps

def percent_mul_ceil(value: int,bps: int) -> int:
    nat(value,"percent_mul_ceil amount")
    require(type(bps) is int and 0<=bps<=PERCENT_FACTOR,"protocol fee invalid")
    require(value*bps<=UINT256_MAX,"percentMulCeil overflow")
    return (value*bps+PERCENT_FACTOR-1)//PERCENT_FACTOR

def percent_mul_half_up(value: int,bps: int) -> int:
    nat(value,"half up amount")
    require(type(bps) is int and 0<=bps<=PERCENT_FACTOR,"half up BPS invalid")
    require(value*bps+5000<=UINT256_MAX,"percentMul overflow")
    return (value*bps+5000)//PERCENT_FACTOR

def reserve_flags(config: int) -> dict:
    nat(config,"reserve configuration")
    return {
        "ltv_bps":(config>>0)&65535,
        "liquidation_threshold_bps":(config>>16)&65535,
        "liquidation_bonus_bps":(config>>32)&65535,
        "decimals":(config>>48)&255,
        "active":bool((config>>56)&1),
        "frozen":bool((config>>57)&1),
        "paused":bool((config>>60)&1),
        "flash_enabled":bool((config>>63)&1),
        "liquidation_protocol_fee_bps":(config>>152)&65535,
    }

def validate(s: dict) -> dict:
    require(type(s) is dict and s.get("schema_version")==1
            and s.get("scope")=="PINNED_SINGLE_ARCHIVE_RPC_NON_LIQUIDATABLE_PRESTATE",
            "research scope/version not authorized")
    require(s.get("chain_id")==1 and s.get("block_number")==BLOCK
            and s.get("block_hash")==BLOCK_HASH and s.get("parent_hash")==PARENT_HASH,
            "historical canonical block misbound")
    require(s.get("source_operator_count")==1
            and s.get("realized_nqc_pnl_usd")=="0"
            and s.get("p2_certified") is False
            and s.get("full_route_executed") is False
            and s.get("flash_repayment_proven") is False,
            "research input attempted execution/profit authority")
    require(s.get("aave_pool")==POOL and s.get("borrower")==BORROWER
            and s.get("s_usde")==SUSDE and s.get("usdtb")==USDTB,
            "protocol or asset identity mismatch")
    require(s.get("user_emode")==EMODE_ID,"borrower eMode unexpected")
    em=s.get("emode24")
    require(type(em) is dict and set(em)=={"ltv_bps","liq_threshold_bps",
            "liq_bonus_bps","collateral_bitmap"},"eMode configuration schema")
    for k in em:
        nat(em[k],"eMode."+k)
    require(em["liq_bonus_bps"]==EMODE_BONUS_BPS and
            em["liq_threshold_bps"]==9200 and em["ltv_bps"]==9000,
            "eMode bonus and threshold not certified")
    config=reserve_flags(nat(s.get("susde_reserve_config"),"sUSDe reserve config"))
    debt_config=reserve_flags(nat(s.get("usdtb_reserve_config"),"USDtb reserve config"))
    require(config["decimals"]==18 and debt_config["decimals"]==18,
            "reserve decimals not 18")
    require(config["active"] and not config["paused"]
            and debt_config["active"] and not debt_config["paused"],
            "collateral/debt reserve paused or inactive")
    require(10000<=config["liquidation_bonus_bps"]<=20000,
            "unreasonable native collateral bonus")
    require(0<=config["liquidation_protocol_fee_bps"]<=10000,
            "invalid protocol liquidation fee")
    coll_id=nat(s.get("susde_reserve_id"),"collateral reserve id")
    debt_id=nat(s.get("usdtb_reserve_id"),"debt reserve id")
    require(coll_id <128 and debt_id<128 and coll_id!=debt_id,
            "reserve ids invalid")
    emode_collateral_applies=bool((em["collateral_bitmap"]>>coll_id)&1)
    user_bitmap=nat(s.get("user_configuration_bitmap"),"borrower position bitmap")
    # Aave v3-origin UserConfiguration.sol is definitive, not the
    # contradictory/misleading DataTypes bitmap comment:
    # isBorrowing -> 2*reserveId; isUsingAsCollateral -> 2*reserveId+1.
    require((user_bitmap>>(2*coll_id+1))&1==1,
            "borrower not using sUSDe as collateral")
    require((user_bitmap>>(2*debt_id))&1==1,
            "borrower not borrowing USDtb")
    require(s.get("susde_atoken")==SUSDE_ATOKEN
            and s.get("usdtb_variable_debt_token")==USDTB_VTOKEN,
            "reserve token identities mismatch")
    collateral=nat(s.get("borrower_susde_atoken_balance_raw"),
                   "borrower sUSDe aToken balance",positive=True)
    reserve_debt=nat(s.get("borrower_usdtb_variable_debt_raw"),
                    "borrower USDtb variable debt",positive=True)
    coll_price=nat(s.get("oracle_susde_price_base"),"sUSDe price",positive=True)
    debt_price=nat(s.get("oracle_usdtb_price_base"),"USDtb price",positive=True)
    require(coll_price<10**12 and debt_price<10**12,
            "Aave 8-decimal oracle price plausibility")
    hf=nat(s.get("health_factor_wad"),"actual observed HF",positive=True)
    require(hf>WAD and hf<1_001*10**15,
            "current borrower is not the pinned non-liquidatable prestate")
    total_coll_base=nat(s.get("total_collateral_base"),"account collateral base",positive=True)
    total_debt_base=nat(s.get("total_debt_base"),"account debt base",positive=True)
    require(total_coll_base>total_debt_base and total_debt_base>0,
            "account values inconsistent")
    require(s.get("liquidation_authorized_at_block") is False,
            "cannot authorize liquidation with HF above one")

    effective_bonus=(em["liq_bonus_bps"] if emode_collateral_applies
                     else config["liquidation_bonus_bps"])
    require(10000<=effective_bonus<=20000,
            "effective bonus outside supported interval")

    reserve_collateral_base=collateral*coll_price//10**18
    reserve_debt_base=(reserve_debt*debt_price+10**18-1)//10**18
    max_debt=reserve_debt
    if (reserve_collateral_base>=MIN_BASE_MAX_CLOSE
        and reserve_debt_base>=MIN_BASE_MAX_CLOSE and hf>LOW_CLOSE_HF):
        half_total_debt_base=percent_mul_half_up(total_debt_base,5000)
        if reserve_debt_base>half_total_debt_base:
            max_debt=half_total_debt_base*10**18//debt_price
    require(COVER<=reserve_debt and COVER<=max_debt,
            "472k USDtb not permitted under reserve debt/close factor")

    # Exactly Aave v3-origin LiquidationLogic._calculateAvailableCollateralToLiquidate.
    base_coll=debt_price*COVER*10**18//(coll_price*10**18)
    gross=percent_mul_floor(base_coll,effective_bonus)
    if gross>collateral:
        gross=collateral
        # precise actual debt covered would need percentDivCeil; for this
        # sizing envelope reject any capping rather than imply full cover.
        raise EvidenceError("borrower collateral caps hypothetical 472k full cover")
    bonus_only=gross-percent_div_floor(gross,effective_bonus)
    liquidation_fee=percent_mul_ceil(bonus_only,config["liquidation_protocol_fee_bps"])
    net=gross-liquidation_fee
    require(0<net<=collateral,"Aave collateral amount impossible")

    return {
        "contract":"NQC_V2_AAVE_SUSDE_LIQUIDATION_COUNTERFACTUAL_EXACT_INTEGERS",
        "schema_version":1,
        "source_tier":"SINGLE_ARCHIVE_RPC_STATE_ONLY_NO_LIQUIDATION",
        "block_number":BLOCK,"block_hash":BLOCK_HASH,
        "borrower":BORROWER,"actual_health_factor_wad":str(hf),
        "is_liquidatable_at_block":False,
        "borrower_emode_id":EMODE_ID,
        "emode_applies_to_susde":emode_collateral_applies,
        "effective_liquidation_bonus_bps":effective_bonus,
        "native_susde_liquidation_bonus_bps":config["liquidation_bonus_bps"],
        "protocol_fee_on_bonus_bps":config["liquidation_protocol_fee_bps"],
        "actual_price_susde_in_aave_base_units":str(coll_price),
        "actual_price_usdtb_in_aave_base_units":str(debt_price),
        "aave_default_close_factor_bps":5000 if max_debt!=reserve_debt else 10000,
        "maximum_debt_cover_raw_sensitivity":str(max_debt),
        "illustrative_requested_debt_cover_usdtb_raw":str(COVER),
        "gross_susde_before_protocol_fee_raw":str(gross),
        "bonus_only_susde_raw":str(bonus_only),
        "protocol_fee_susde_raw":str(liquidation_fee),
        "hypothetical_net_susde_raw":str(net),
        "target_susde_raw":str(TARGET_SUSDE),
        "net_susde_minus_388k_raw":str(net-TARGET_SUSDE),
        "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger":
            net>=TARGET_SUSDE,
        "amount_depends_on_real_future_state_and_trigger":True,
        "real_liquidation_executed":False,
        "future_liquidation_reward_attested":False,
        "integrated_morpho_curve_aave_fluid_repay_proven":False,
        "independent_operator_quorum_proven":False,
        "external_gas_sponsor_nonrecourse_proven":False,
        "builder_competition_survival_proven":False,
        "end_to_end_net_pnl_usd":None,
        "commercial_upgrade":False,"p2_shadow_certified":False,
        "rmc_closed":False,"realized_nqc_pnl_usd":"0",
    }

def call(rpc: str,address: str,selector: str,*args: str) -> str:
    require(rpc.startswith("https://"),"only public read-only HTTPS RPC")
    try:
        p=subprocess.run(["cast","call",address,selector,*map(str,args),
                          "--block",str(BLOCK),"--rpc-url",rpc],
                         capture_output=True,text=True,timeout=35,check=False)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise EvidenceError("archive RPC failed") from exc
    require(p.returncode==0,
            "archive call failed for "+selector+" "+p.stderr[-180:])
    return p.stdout.strip()

def header(rpc: str) -> dict:
    try:
        p=subprocess.run(["cast","block",str(BLOCK),"--rpc-url",rpc,"--json"],
                         capture_output=True,text=True,timeout=35,check=False)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise EvidenceError("canonical header unavailable") from exc
    require(p.returncode==0,"canonical header RPC returned error: "+(p.stderr[-300:] or p.stdout[-200:]))
    try:v=json.loads(p.stdout)
    except json.JSONDecodeError as exc:raise EvidenceError("header not JSON") from exc
    require(str(v.get("hash","")).lower()==BLOCK_HASH
            and str(v.get("parentHash","")).lower()==PARENT_HASH
            and int(str(v.get("number","0")),0)==BLOCK,
            "wrong canonical block/hash/parent")
    return {"number":BLOCK,"hash":BLOCK_HASH,"parent":PARENT_HASH}

def read_state(rpc: str) -> dict:
    pre=header(rpc)
    account=abi_words(call(rpc,POOL,"getUserAccountData(address)",BORROWER),6)
    e_id=decode_rpc_uint(call(rpc,POOL,"getUserEMode(address)",BORROWER))
    em=abi_words(call(rpc,POOL,"getEModeCategoryCollateralConfig(uint8)",str(EMODE_ID)),3)
    bitmap=decode_rpc_uint(call(rpc,POOL,
        "getEModeCategoryCollateralBitmap(uint8)",str(EMODE_ID)))
    collateral_config=decode_rpc_uint(call(rpc,POOL,"getConfiguration(address)",SUSDE))
    debt_config=decode_rpc_uint(call(rpc,POOL,"getConfiguration(address)",USDTB))
    collateral_reserve=abi_words(call(rpc,POOL,"getReserveData(address)",SUSDE),15)
    debt_reserve=abi_words(call(rpc,POOL,"getReserveData(address)",USDTB),15)
    require(typed_address(collateral_reserve[8])==SUSDE_ATOKEN
            and typed_address(debt_reserve[10])==USDTB_VTOKEN,
            "aToken/variableDebt contracts disagree with pinned Aave address book")
    require(collateral_reserve[0]==collateral_config and debt_reserve[0]==debt_config,
            "getReserveData and getConfiguration disagree")
    user_config=decode_rpc_uint(call(rpc,POOL,"getUserConfiguration(address)",BORROWER))
    collateral_balance=decode_rpc_uint(call(
        rpc,SUSDE_ATOKEN,"balanceOf(address)",BORROWER))
    debt_balance=decode_rpc_uint(call(
        rpc,USDTB_VTOKEN,"balanceOf(address)",BORROWER))
    collateral_price=decode_rpc_uint(call(
        rpc,ORACLE,"getAssetPrice(address)",SUSDE))
    debt_price=decode_rpc_uint(call(
        rpc,ORACLE,"getAssetPrice(address)",USDTB))
    post=header(rpc)
    require(post==pre,"canonical header drift during exact on-chain reads")
    return {
        "schema_version":1,
        "scope":"PINNED_SINGLE_ARCHIVE_RPC_NON_LIQUIDATABLE_PRESTATE",
        "chain_id":1,"block_number":BLOCK,"block_hash":BLOCK_HASH,
        "parent_hash":PARENT_HASH,"aave_pool":POOL,"borrower":BORROWER,
        "s_usde":SUSDE,"usdtb":USDTB,
        "susde_atoken":SUSDE_ATOKEN,"usdtb_variable_debt_token":USDTB_VTOKEN,
        "source_operator_count":1,
        "user_emode":e_id,
        "emode24":{"ltv_bps":em[0],"liq_threshold_bps":em[1],
                   "liq_bonus_bps":em[2],"collateral_bitmap":bitmap},
        "susde_reserve_config":collateral_config,
        "usdtb_reserve_config":debt_config,
        "susde_reserve_id":collateral_reserve[7],
        "usdtb_reserve_id":debt_reserve[7],
        "user_configuration_bitmap":user_config,
        "borrower_susde_atoken_balance_raw":collateral_balance,
        "borrower_usdtb_variable_debt_raw":debt_balance,
        "oracle_susde_price_base":collateral_price,
        "oracle_usdtb_price_base":debt_price,
        "total_collateral_base":account[0],
        "total_debt_base":account[1],
        "health_factor_wad":account[5],
        "liquidation_authorized_at_block":False,
        "full_route_executed":False,"flash_repayment_proven":False,
        "p2_certified":False,"realized_nqc_pnl_usd":"0",
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--rpc-url",required=True)
    p.add_argument("--out",required=True)
    p.add_argument("--state-out",required=True)
    args=p.parse_args()
    s=read_state(args.rpc_url)
    output=validate(s)
    Path(args.state_out).write_text(json.dumps(s,sort_keys=True,indent=2)+"\n")
    Path(args.out).write_text(json.dumps(output,sort_keys=True,indent=2)+"\n")
    print(json.dumps({"hf_raw":output["actual_health_factor_wad"],
        "fee_bps":output["protocol_fee_on_bonus_bps"],
        "hypothetical_net_susde_raw":output["hypothetical_net_susde_raw"],
        "can_reach_388k":output[
          "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger"]},
        sort_keys=True))

if __name__=="__main__":main()
