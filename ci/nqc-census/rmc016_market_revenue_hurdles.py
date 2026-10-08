#!/usr/bin/env python3
"""RMC016 original source-locked observed-market gross-vs-goal hurdle.

No projected revenue. No sampled third-party profits are assigned to Nexus.
Even the optimistically required share of past gross edge is only a
mathematical NECESSARY threshold, not a capture or profitability estimate.
"""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path

SOURCE_PATH="ci/nqc-census/rmc016-production-evidence.json"
SOURCE_GIT_BLOB_SHA1="5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa"
REGISTRY_PATH="ci/nqc-census/rmc011-external-capital-provider-registry.json"
REGISTRY_GIT_BLOB_SHA1="a9c1427bb05828d08ade537899ee1b8e43b97ed2"
EXPECTED_SOURCE_SHA256="9dc03b2d2c480d689e5ecf1e4585d2af55a4271db6a3e5ef0851f821085fac63"
EXPECTED_AUTHORITY_COMMITMENT="0xa952f2a3af9c1cef8103a9ad9586f62bc3548d0bdee2c7c1c7ae60018490396c"
EXPECTED_WINDOW=(25880316,26095351)
EXPECTED_WINDOW_HASHES=(
 "0x0b29e0c8c1997f059f82e7fed67e047269f68422ab194d56546c1c9833469d96",
 "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781",
)
EXPECTED_COUNT=(139,127)
EXPECTED_GROSS_ORACLE_EDGE="138045174690310000000000"
EXPECTED_OBSERVED_WINNER_GAS="1144134260592713842029"
EXPECTED_MARKET_DEBT="2929719106126210000000000"
TARGET_USD=(15_000,55_000)
WAD=10**18
BPS=10_000

def need(cond,message):
    if not cond: raise ValueError(message)

def canonical(obj):
    return (json.dumps(obj,sort_keys=True,separators=(",",":"),ensure_ascii=True)+"\n").encode()

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def git_blob_sha1(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode("ascii")+b"\0"+raw).hexdigest()

def object_json(raw):
    def reject_duplicate(pairs):
        out={}
        for k,v in pairs:
            need(k not in out,"duplicate keys forbidden in economic source")
            out[k]=v
        return out
    out=json.loads(raw,object_pairs_hook=reject_duplicate)
    need(type(out) is dict,"economic evidence source is not canonical object")
    return out

def integer_wad(obj,name):
    value=obj.get(name)
    need(type(value) is str and value.isascii() and value.isdecimal() and
         (value=="0" or not value.startswith("0")) and 1<=len(value)<=78,
         "amount is not a nonnegative canonical uint256 decimal WAD: "+name)
    number=int(value)
    need(0<=number<2**256,"invalid WAD magnitude: "+name)
    return number

def ceil_div(a,b):
    need(type(a) is int and type(b) is int and a>=0 and b>0,
         "invalid positive integer denominator/numerator")
    return (a+b-1)//b

def hurdle_bps(target_usd,observed_gross_usd_wad):
    need(type(target_usd) is int and target_usd>0,
         "must be a positive integer USD target")
    need(type(observed_gross_usd_wad) is int and observed_gross_usd_wad>0,
         "no actual positive observed-gross source denominator")
    return ceil_div(target_usd*WAD*BPS,observed_gross_usd_wad)

def auth_source(root):
    doc={}
    for key,path,blob in (
        ("d16",SOURCE_PATH,SOURCE_GIT_BLOB_SHA1),
        ("gas_registry",REGISTRY_PATH,REGISTRY_GIT_BLOB_SHA1),
    ):
        p=root/path
        need(p.is_file(),"missing mandatory unchanged source "+path)
        raw=p.read_bytes()
        need(0<len(raw)<=20_000 and git_blob_sha1(raw)==blob,
             "source Git object mutated or unauthenticated: "+key)
        doc[key]=object_json(raw)
    return doc

def evaluate(inputs):
    need(type(inputs) is dict and set(inputs)=={"d16","gas_registry"},
         "exact D16 and gas-registry sources required")
    d16=inputs["d16"]
    a=d16.get("authority")
    need(type(a) is dict and d16.get("schema_version")==1 and
         type(d16.get("schema_version")) is int and
         d16.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS" and
         d16.get("source_authority_file_sha256")==EXPECTED_SOURCE_SHA256 and
         a.get("authority_commitment")==EXPECTED_AUTHORITY_COMMITMENT and
         a.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS" and
         a.get("claim_scope")=="PRE_SHADOW_FAIL_CLOSED_CAPACITY_WITH_OBSERVED_MARKET_BASELINE",
         "original D16 authority identity/scope not preserved")
    w=a.get("window")
    need(type(w) is dict and (w.get("start_block"),w.get("end_block"))==EXPECTED_WINDOW
         and (w.get("start_hash"),w.get("end_hash"))==EXPECTED_WINDOW_HASHES,
         "observed historical window anchor does not match original source")
    need(type(a.get("definite_episode_count")) is int and
         type(a.get("definite_transaction_count")) is int and
         (a["definite_episode_count"],a["definite_transaction_count"])==EXPECTED_COUNT and
         a.get("double_counting_policy")==
          "TRANSACTION_HASH_IS_EXECUTION_CONFLICT_SET; MULTI_EVENT_WINNER_TX_GAS_COUNTED_ONCE; CENSORED_EPISODES_COUNT_ZERO" and
         a.get("provider_mismatch_count")==0 and
         a.get("unknown_count")==0,
         "historical 139 events / 127 receipts or conflict policy not canonical")
    gross=integer_wad(a,"observed_market_gross_oracle_edge_usd_wad")
    gas=integer_wad(a,"observed_winner_gas_cost_usd_wad")
    principal=integer_wad(a,"observed_market_debt_principal_usd_wad")
    need(str(gross)==EXPECTED_GROSS_ORACLE_EDGE and
         str(gas)==EXPECTED_OBSERVED_WINNER_GAS and
         str(principal)==EXPECTED_MARKET_DEBT and
         0<gas<gross<principal,
         "market source economic raw figures not exact, or unsupported signs")
    lower=integer_wad(a,"nqc_capture_probability_lower_bound_wad")
    minimum=integer_wad(a,"nqc_conservative_realizable_monthly_capacity_usd_wad")
    daily=integer_wad(a,"nqc_conservative_realizable_daily_capacity_usd_wad")
    capacity=integer_wad(a,"nqc_conservative_realizable_capacity_usd_wad")
    need((lower,minimum,daily,capacity)==(0,0,0,0)
         and a.get("month1_300k_target_proven") is False
         and a.get("zero_own_capital_not_overridden") is True
         and "NO_NQC_REALIZED_PNL" in a.get("non_claims",[])
         and "NO_POSITIVE_CAPTURE_PROBABILITY" in a.get("non_claims",[])
         and "NO_PROTOCOL_FEE_COMPLETE_HISTORICAL_NET" in a.get("non_claims",[])
         and "NO_ROUTE_COMPLETE_HISTORICAL_NET" in a.get("non_claims",[]),
         "cannot promote partial third-party market gross to NQC realizable net")
    registry=inputs["gas_registry"]
    need(registry.get("stage")=="RMC-011" and
         registry.get("schema_version")==1 and
         type(registry.get("schema_version")) is int and
         registry.get("status")=="DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE" and
         registry.get("registry_scope")=="NQC_EXECUTION_AUTHORIZED_EXTERNAL_CAPITAL_PROVIDERS" and
         registry.get("provider_count")==0 and
         type(registry.get("provider_count")) is int and
         registry.get("providers")==[],
         "external gas cannot be admitted from model support or third-party deposit")
    partial=gross-gas
    targets=[]
    for target in TARGET_USD:
        gross_hurdle=hurdle_bps(target,gross)
        cost_adjusted_benchmark=hurdle_bps(target,partial)
        targets.append({
            "hypothetical_same_window_target_usd":str(target),
            "minimum_required_share_bps_of_observed_gross_oracle_edge_if_NO_costs":
                gross_hurdle,
            "minimum_required_share_bps_of_observed_market_after_winner_gas_if_other_costs_ZERO":
                cost_adjusted_benchmark,
            "gross_share_above_100_percent":gross_hurdle>BPS,
            "confirmed_achievable_by_nexus":False,
            "sufficient_for_nexus_monthly_reliability":False,
            "empirical_nexus_capture_probability_known":False,
        })
    report={
       "schema_version":1,
       "status":"RMC016_HISTORIC_MARKET_GROSS_SHARE_HURDLES_ONLY_NOT_NQC_NET",
       "original_d16_source_git_blob_sha1":SOURCE_GIT_BLOB_SHA1,
       "original_gas_provider_registry_blob_sha1":REGISTRY_GIT_BLOB_SHA1,
       "original_d16_authority_commitment":EXPECTED_AUTHORITY_COMMITMENT,
       "original_observation_window_block_range":list(EXPECTED_WINDOW),
       "observed_window_number_of_blocks":EXPECTED_WINDOW[1]-EXPECTED_WINDOW[0]+1,
       "original_observation_window_hashes":list(EXPECTED_WINDOW_HASHES),
       "observed_competitor_liquidation_events":EXPECTED_COUNT[0],
       "observed_competitor_winning_transactions":EXPECTED_COUNT[1],
       "observed_market_debt_principal_usd_wad":str(principal),
       "observed_market_gross_oracle_edge_usd_wad":str(gross),
       "observed_actual_third_party_winner_gas_usd_wad":str(gas),
       "observed_market_partial_gross_edge_after_third_party_gas_usd_wad":
           str(partial),
       "historical_market_gross_and_gas_distinct_economic_sums":True,
       "conditional_necessary_gross_share_thresholds":targets,
       "report_target_scope":"SAME_OBSERVATION_WINDOW_ALGEBRA_ONLY_NOT_CALENDAR_MONTH",
       "historical_winners_do_not_establish_nqc_capture":True,
       "observed_partial_market_edge_is_not_A_RIGOROUS_NQC_PROFIT_UPPER_BOUND":True,
       "single_observation_window_is_not_revenue_reliability":True,
       "complete_transaction_level_cost_ledgers_authenticated_in_this_gate":False,
       "protocol_flash_route_mev_financing_failure_and_infra_costs_fully_recovered":False,
       "nqc_external_native_gas_financer_authorized":False,
       "nqc_capture_probability_lower_bound_wad":"0",
       "nqc_conservative_realizable_monthly_capacity_usd_wad":"0",
       "nqc_realized_income_usd_wad":"0",
       "monthly_income_forecast_usd":None,
       "monthly_goal_15k_usd_proven":False,
       "monthly_goal_55k_usd_proven":False,
       "reliability_p_at_least_90pct_proven":False,
       "rmc011_terminal_closed":False,
       "rmc013_terminal_closed":False,
       "rmc015_terminal_closed":False,
       "rmc016_independent_terminal_authority_promoted_by_this_gate":False,
       "real_market_census_closed":False,
       "non_claims":[
           "OBSERVED_THIRD_PARTY_GROSS_IS_NOT_NQC_NET",
           "NECESSARY_SHARE_IS_NOT_AN_ESTIMATED_OR_ATTAINABLE_CAPTURE_RATE",
           "ACTUAL_THIRD_PARTY_WINNER_GAS_IS_NOT_NQC_EXECUTION_GAS",
           "THIS_215036_BLOCK_WINDOW_NOT_CERTIFIED_AS_CALENDAR_MONTH",
           "NO_INDEPENDENT_NONRECOURSE_NATIVE_GAS_FINANCING",
           "NO_REPEATED_OUT_OF_SAMPLE_NQC_EXECUTION_PROBABILITY",
           "UNEXECUTED_LIQUIDATABLE_EVENTS_MAY_EXIST_OUTSIDE_OBSERVED_WINNER_SET",
           "NO_CENSUS_OR_RELIABILITY_CERTIFICATION",
       ],
    }
    report["report_sha256"]=sha(canonical(report))
    return report

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--repo-root",type=Path,default=Path("."))
    p.add_argument("--out",type=Path,required=True)
    opt=p.parse_args()
    need(not opt.out.exists(),"append-only economic audit artifact only")
    result=evaluate(auth_source(opt.repo_root))
    opt.out.parent.mkdir(parents=True,exist_ok=True)
    opt.out.write_bytes(canonical(result))
    print(result["status"],"source_market_oracle_gross_usd_wad",
          result["observed_market_gross_oracle_edge_usd_wad"],
          "after_actual_winner_gas_wad",
          result["observed_market_partial_gross_edge_after_third_party_gas_usd_wad"],
          "conditional_share_hurdles_bps",
          [(t["hypothetical_same_window_target_usd"],
            t["minimum_required_share_bps_of_observed_gross_oracle_edge_if_NO_costs"],
            t["minimum_required_share_bps_of_observed_market_after_winner_gas_if_other_costs_ZERO"])
           for t in result["conditional_necessary_gross_share_thresholds"]],
          "NQC_REALIZED_USD=0", "CENSUS_CLOSED=false")
if __name__=="__main__":
    main()
