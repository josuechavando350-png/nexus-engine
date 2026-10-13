#!/usr/bin/env python3
"""NQC V2 Aave sUSDe liquidation ceiling. RESEARCH ONLY, no simulated liquidation.

Mirrors Aave V3 origin LiquidationLogic._calculateAvailableCollateralToLiquidate:
baseCollateral=floor(debtPrice*debtCover*collateralUnit/(collateralPrice*debtUnit))
grossCollateral=percentMulFloor(baseCollateral,liquidationBonus)
baseWithoutBonus=percentDivFloor(grossCollateral,liquidationBonus)
protocolFee=percentMulCeil(grossCollateral-baseWithoutBonus,protocolFeeBps)
(netCollateral=grossCollateral-protocolFee)
Valid only when liquidation is actually admissible and no borrower collateral cap,
50% close-factor limit, dust rule, configuration change or liquidation-specific
rounding restricts the amounts. This is NOT a positive fork execution or P2.
"""
from __future__ import annotations
from hashlib import sha256
import argparse
import json
from pathlib import Path

WAD=10**18
BPS=10_000
USD_BASE=10**8
SUSDE_PRICE=125_127_009
USDTB_PRICE=100_000_000
BONUS_BPS=10_310
COVER_USDTB=472_000*WAD
ROUTE_387K_USDT_RAW=483_945_545_910
ROUTE_388K_USDT_RAW=485_193_156_507
CURVE_REQUIRED_USDT_RAW=472_461_610_797
LEGACY_GROSS_BENCHMARK_RAW=12_297_010_000
BLOCK=26_184_741
SOURCE_STATUS="HISTORICAL_SNAPSHOT_SINGLE_PROVIDER_RESEARCH"

class EvidenceError(ValueError):
    pass

def need(cond,reason):
    if not cond: raise EvidenceError(reason)

def uint(s, label, zero=False):
    need(type(s) is str and s.isascii() and s.isdecimal() and
         (s=="0" or not s.startswith("0")),label+": canonical uint string")
    v=int(s)
    need((v>=0 if zero else v>0) and v<2**256,label+": outside uint256 range")
    return v

def percent_floor(amount,bps):
    need(type(amount) is int and 0<=amount<2**256 and
         type(bps) is int and 0<=bps<=BPS*2,"integer math range")
    return amount*bps//BPS

def percent_ceil(amount,bps):
    need(type(amount) is int and 0<=amount<2**256 and
         type(bps) is int and 0<=bps<=BPS,"integer math range")
    return (amount*bps+BPS-1)//BPS

def calculate(cover_raw: int,protocol_fee_bps: int,
              borrower_susde_cap_raw: int|None=None):
    need(type(cover_raw) is int and 0<cover_raw<2**256, "cover not exact integer")
    need(type(protocol_fee_bps) is int and 0<=protocol_fee_bps<=BPS,"invalid fee")
    base=USDTB_PRICE*cover_raw*WAD//(SUSDE_PRICE*WAD)
    gross=percent_floor(base,BONUS_BPS)
    if borrower_susde_cap_raw is not None:
        need(type(borrower_susde_cap_raw) is int and
             borrower_susde_cap_raw>=0,"borrower cap invalid")
        need(gross<=borrower_susde_cap_raw,
             "collateral-capped liquidation requires debt-to-cover recomputation")
    bonus=gross-gross*BPS//BONUS_BPS
    fee=percent_ceil(bonus,protocol_fee_bps)
    net=gross-fee
    return {"base_raw":str(base),"gross_raw":str(gross),
            "bonus_component_raw":str(bonus),"protocol_fee_raw":str(fee),
            "net_susde_raw":str(net),
            "gross_susde_display":f"{gross//WAD}.{gross%WAD:018d}",
            "net_susde_display":f"{net//WAD}.{net%WAD:018d}",
            "at_least_387k":net>=387_000*WAD,
            "at_least_388k":net>=388_000*WAD}

def validate(observation):
    need(type(observation) is dict and observation.get("schema_version")==1,
         "schema version")
    need(observation.get("claim_scope")==SOURCE_STATUS, "source scope mismatch")
    need(observation.get("chain_id")==1 and observation.get("block_number")==BLOCK,
         "wrong pinned chain or block")
    need(observation.get("block_hash")==
         "0xe4b0718c51a6a484eef56edce0f25e9a5c546c2f66f595c6e305a589a612dbbe",
         "canonical hash mismatch")
    need(observation.get("aave_emode_category")==24, "eMode category")
    need(observation.get("s_usde_price_8_decimals")==str(SUSDE_PRICE)
         and observation.get("usd_tb_price_8_decimals")==str(USDTB_PRICE),
         "price source changed")
    need(observation.get("emode_liquidation_bonus_bps")==BONUS_BPS,
         "bonus source changed")
    need(observation.get("borrower_hf_less_than_one") is False
         and observation.get("protocol_fee_bps_verified") is False
         and observation.get("borrower_susde_balance_verified") is False
         and observation.get("liquidation_admitted") is False,
         "fixture cannot promote unverified eligibility")
    need(observation.get("realized_nqc_pnl_usd")=="0"
         and observation.get("p2_certified") is False,"profit/authority forgery")

def audit(obs):
    validate(obs)
    cases=[]
    # These are sensitivity points, NOT Aave current fee observations.
    for bps in (0,250,500,750,1000,1250,1500,2000,3000,10000):
        result=calculate(COVER_USDTB,bps)
        cases.append({"hypothetical_protocol_fee_bps":bps,**result})
    gross=uint(cases[0]["gross_raw"],"gross")
    bonus=uint(cases[0]["bonus_component_raw"],"bonus")
    # Exact maximum fee bps allowing >=388000 sUSDe net, assuming no cap.
    allowed=(gross-388_000*WAD)
    threshold=max((v for v in range(0,10001)
                   if percent_ceil(bonus,v)<=allowed),default=-1)
    need(threshold>=0,"target unreachable even with zero protocol fee")
    require_plus=calculate(COVER_USDTB,threshold)
    fail_next=calculate(COVER_USDTB,threshold+1)
    need(require_plus["at_least_388k"] and not fail_next["at_least_388k"],
         "fee threshold boundary invalid")
    return {
      "schema_version":1,"contract":"NQC_V2_AAVE_SEIZURE_INTEGER_CEILING_NO_AUTHORITY",
      "source_sha256":sha256(json.dumps(obs,sort_keys=True,separators=(",",":")).encode()).hexdigest(),
      "status":"NOT_EXECUTABLE_HF_ABOVE_ONE_FEE_AND_COLLATERAL_UNVERIFIED",
      "chain_id":1,"block_number":BLOCK,
      "cover_usdtb_raw":str(COVER_USDTB),
      "emode_bonus_bps":BONUS_BPS,
      "s_usde_price_8_decimal":str(SUSDE_PRICE),
      "usd_tb_price_8_decimal":str(USDTB_PRICE),
      "fee_sensitivity":cases,
      "max_hypothetical_fee_bps_to_leave_388k_susde_net":threshold,
      "gross_susde_at_zero_fee_raw":str(gross),
      "maximum_gross_before_fee_not_account_balance_capped":True,
      "fluid_388k_historical_executed_fork_usdt_raw":str(ROUTE_388K_USDT_RAW),
      "fluid_387k_historical_executed_fork_usdt_raw":str(ROUTE_387K_USDT_RAW),
      "curve_472k_usdtb_historical_executed_fork_input_usdt_raw":str(CURVE_REQUIRED_USDT_RAW),
      "gross_388k_route_spread_raw_before_any_other_cost":str(ROUTE_388K_USDT_RAW-CURVE_REQUIRED_USDT_RAW),
      "scenario_388k_fork_output_covers_legacy_target":(ROUTE_388K_USDT_RAW-CURVE_REQUIRED_USDT_RAW)>=LEGACY_GROSS_BENCHMARK_RAW,
      "aave_liquidation_executed":False,"borrower_susde_position_authenticated":False,
      "liquidation_protocol_fee_at_block_known":False,"close_factor_allows_cover_verified":False,
      "s_usde_out_fork_realized":False,"atomic_route_repayment_verified":False,
      "morpho_flash_loan_sponsor_committed":False,"gas_provider_verified":False,
      "route_net_pnl_usd":None,"commercial_score_upgrade":False,
      "p2_shadow_certified":False,"rmc_closed":False,"nqc_realized_pnl_usd":"0",
      "limitations":["HF_AT_PINNED_BLOCK_ABOVE_ONE","EMODE_BONUS_FROM_SINGLE_PROVIDER",
                     "BORROWER_ATOKEN_BALANCE_UNKNOWN","PROTOCOL_FEE_UNKNOWN",
                     "CLOSE_FACTOR_AND_DUST_NOT_CERTIFIED","GROSS_BEFORE_COLLATERAL_CAP",
                     "NO_PROSPECTIVE_CROSSING","FORK_PIECES_ARE_SEPARATE_REVERTED_RUNS",
                     "ZERO_OPERATOR_CAPITAL_AND_GAS_RECOURSE_NOT_PROVEN"]
    }

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--input",required=True)
    p.add_argument("--out",required=True)
    args=p.parse_args()
    result=audit(json.loads(Path(args.input).read_text()))
    Path(args.out).write_text(json.dumps(result,sort_keys=True,indent=2)+"\n")
    print(result["status"],result["max_hypothetical_fee_bps_to_leave_388k_susde_net"])

if __name__=="__main__":main()
