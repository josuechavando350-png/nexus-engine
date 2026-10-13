#!/usr/bin/env python3
"""Hard commercial target gate, using authentic RMC016 baseline NOT a forecast.

Net goal USD 45k-55k per 30-day operating month, funded with zero
operator-owned cash, gas, collateral and guarantees. Historical market gross
edge is not captured Nexus profit. No new on-chain activity is performed here.
"""
from __future__ import annotations
from hashlib import sha256
import json
from pathlib import Path

WAD=10**18
MICRO=10**6
TARGET_MIN_USD=45_000
TARGET_MAX_USD=55_000
SCOPE="RMC016_HISTORICAL_GROSS_REFERENCE_NOT_CAPTURABLE_NET_FORECAST"
PIN_GROSS=138_045_174_690_310_000_000_000
PIN_WINDOW=(25_880_316,26_095_351)
PIN_ORIGINAL_SOURCE="9dc03b2d2c480d689e5ecf1e4585d2af55a4271db6a3e5ef0851f821085fac63"
CONSERVATIVE_NQC_NET=0

class TargetError(ValueError):
    pass

def need(valid,reason):
    if not valid:raise TargetError(reason)

def canonical(v):
    return json.dumps(v,sort_keys=True,separators=(",",":")).encode()

def uint(v,name):
    need(type(v) is str and v.isascii() and v.isdecimal() and
         (v=="0" or not v.startswith("0")),name+": canonical uint string")
    n=int(v)
    need(n>=0 and n<2**256,name+": amount overflow")
    return n

def ceil_div(num,den):
    need(type(num) is int and type(den) is int and num>=0 and den>0,
         "not exact integer ratio")
    return (num+den-1)//den

def audit(doc):
    need(type(doc) is dict and doc.get("schema_version")==1 and
         doc.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS",
         "invalid RMC016 source identity")
    need(doc.get("source_authority_file_sha256")==PIN_ORIGINAL_SOURCE,
         "immutable original source authority mismatch")
    a=doc.get("authority")
    need(type(a) is dict and
         a.get("claim_scope")=="PRE_SHADOW_FAIL_CLOSED_CAPACITY_WITH_OBSERVED_MARKET_BASELINE",
         "incorrect source authority scope")
    need(a.get("definite_episode_count")==139 and
         a.get("definite_transaction_count")==127,
         "missing original conflict-set cardinality")
    w=a.get("window")
    need(type(w) is dict and
         (w.get("start_block"),w.get("end_block"))==PIN_WINDOW,
         "original 215k-block observation interval changed")
    g=uint(a.get("observed_market_gross_oracle_edge_usd_wad"),"gross")
    need(g==PIN_GROSS,"original gross edge not authenticated")
    need(a.get("nqc_capture_probability_lower_bound_wad")=="0" and
         a.get("nqc_conservative_realizable_monthly_capacity_usd_wad")=="0" and
         a.get("month1_300k_target_proven") is False and
         "NO_NQC_REALIZED_PNL" in a.get("non_claims",[]),
         "cannot promote unproven source to commercial result")
    targets=[]
    for dollar in (TARGET_MIN_USD,TARGET_MAX_USD):
        net_required=dollar*WAD
        minimum_market_gross_share_ppm=ceil_div(net_required*MICRO,g)
        targets.append({
            "net_target_usd":str(dollar),
            "required_daily_net_usd_30_day_exact_fraction":f"{dollar}/30",
            "minimum_fraction_of_original_gross_value_if_every_dollar_costless_ppm":
                str(minimum_market_gross_share_ppm),
            "observed_capture_fraction_ppm":None,
            "competition_adjusted_net_usd":None,
            "route_cost_usd":None,
            "native_gas_sponsor_and_zero_operator_recourse_proven":False,
            "claim_scope":"MATHEMATICAL_HURDLE_ONLY_NOT_EXPECTED_EARNINGS"
        })
    return {
      "schema_version":1,"status":"FIRST_MONTH_45K_55K_TARGET_NOT_PROVEN",
      "scope":SCOPE,"chain_id":1,
      "historical_window":{"start_block":PIN_WINDOW[0],"end_block":PIN_WINDOW[1]},
      "original_winner_transactions":127,"original_liquidation_events":139,
      "source_authority_sha256":doc["source_authority_file_sha256"],
      "baseline_historical_market_gross_oracle_edge_usd_wad":str(g),
      "target_range":targets,
      "no_inference_for_other_protocols_or_chains":True,
      "realizable_nexus_capacity_lower_bound_usd_wad":"0",
      "nqc_realized_profit_usd":"0",
      "external_sponsorship_committed":False,"p2_shadow_certified":False,
      "rmc_closed":False,"commercial_score_upgrade":False,
      "no_actual_profitability_probability_calibration":True,
      "limitations":[
          "HISTORICAL_MARKET_GROSS_IS_NOT_NEXUS_CAPTURABLE_PNL",
          "NO_PROSPECTIVE_CAPTURE_RATE",
          "NO_BUILDER_PRIORITY_GAS_OR_ALL_ROUTE_COSTS",
          "THIS_BASELINE_IS_NOT_THE_FULL_25000_MARKET_UNIVERSE",
          "ZERO_OWN_CAPITAL_INCLUDING_GAS_NOT_PROVEN",
          "NO_FINANCED_EXECUTABLE_PRODUCTION_TRANSACTIONS"]
    }

def main():
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    raw=args.source.read_bytes()
    result=audit(json.loads(raw))
    result["source_file_sha256"]=sha256(raw).hexdigest()
    args.out.write_text(json.dumps(result,sort_keys=True,indent=2)+"\n")
    print(result["status"],result["target_range"])

if __name__=="__main__":main()
