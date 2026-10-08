#!/usr/bin/env python3
"""RMC-300K adversarial monthly-NET target underwriting, not a trading strategy.

Source-locked historical market gross is context only. This gate has no authority
to certify Nexus revenues or a global market maximum. It refuses profitability
promotion until independently certified shadow, funding and capture evidence.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from decimal import Decimal, localcontext

WAD = 10**18
TARGET_USD = 300_000
TARGET_WAD = TARGET_USD * WAD
DAYS_IN_TARGET_PERIOD = 30
REQUIRED_LOWER_CONFIDENCE = "0.90"
SOURCE_COMMIT = "96a0b3e3c0b55df1b1d890f8c70a7a9014e2ff9a"
SOURCE_GIT_BLOB = "5d5ed3635a426d686c8a98aa3547fd5b9d8b95aa"
D15_START = 25880316
D15_END = 26095351
EXACT_NONCLAIMS = frozenset({
    "NO_NQC_REALIZED_PNL",
    "NO_POSITIVE_CAPTURE_PROBABILITY",
    "NO_PROTOCOL_FEE_COMPLETE_HISTORICAL_NET",
    "NO_ROUTE_COMPLETE_HISTORICAL_NET",
    "NO_MONTH1_TARGET_PROOF",
})
BLOCKERS = (
    "FULL_MULTI_MARKET_CANONICAL_UNIVERSE_NOT_INDEPENDENTLY_CERTIFIED",
    "EX_ANTE_NEXUS_EXECUTION_AND_RECEIPT_ECONOMICS_UNPROVEN",
    "INDEPENDENTLY_FINANCED_GAS_AT_OWN_CAPITAL_ZERO_UNPROVEN",
    "BLOCK_PINNED_FLASH_PRINCIPAL_ROUTE_AND_FEES_UNPROVEN",
    "INCLUSION_COMPETITION_COLLISION_AND_CAPTURE_UNCALIBRATED",
    "COMPLETE_30_DAY_NET_CAPACITY_AND_P90_UNPROVEN",
    "OUT_OF_SAMPLE_REPEATED_MONTHLY_NET_300K_NOT_DEMONSTRATED",
)
CENSORED_CAPACITY_IS_ZERO = True

def require(cond, message):
    if not cond:
        raise ValueError(message)

def canonical(x):
    return (json.dumps(x, sort_keys=True, separators=(",", ":"), ensure_ascii=True)+"\n").encode()

def sha256(raw):
    return hashlib.sha256(raw).hexdigest()

def git_blob(raw):
    return hashlib.sha1(b"blob "+str(len(raw)).encode()+b"\0"+raw).hexdigest()

def parse_locked_source(raw):
    require(git_blob(raw)==SOURCE_GIT_BLOB, "D16 economic source is not exact Git blob")
    def pairs_unique(pairs):
        result={}
        for k,v in pairs:
            require(k not in result,"duplicate economic source JSON keys")
            result[k]=v
        return result
    doc=json.loads(raw,object_pairs_hook=pairs_unique)
    require(type(doc) is dict and doc.get("schema_version")==1,"wrong economic evidence schema")
    a=doc.get("authority")
    require(type(a) is dict and a.get("status")=="RMC016_CONSERVATIVE_REALIZABLE_CAPACITY_PASS",
            "D16 production economic status inconsistent")
    require(a.get("definite_transaction_count")==127 and
            a.get("definite_episode_count")==139,"winner/event universe mismatch")
    require(a.get("window",{}).get("start_block")==D15_START and
            a.get("window",{}).get("end_block")==D15_END,"D15 window mismatch")
    require(a.get("zero_own_capital_not_overridden") is True,"own capital constraint removed")
    require(a.get("month1_300k_target_proven") is False,"source overclaimed USD300K")
    require(set(a.get("non_claims",[]))==EXACT_NONCLAIMS,"D16 missing required non-claims")
    require(a.get("nqc_capture_probability_lower_bound_wad")=="0" and
            a.get("nqc_conservative_realizable_capacity_usd_wad")=="0" and
            a.get("nqc_conservative_realizable_daily_capacity_usd_wad")=="0" and
            a.get("nqc_conservative_realizable_monthly_capacity_usd_wad")=="0",
            "source claim inflates Nexus capture or profitability")
    def uint(name):
        v=a.get(name)
        require(type(v) is str and re.fullmatch(r"(?:0|[1-9][0-9]*)",v) is not None,
                "monetary source must be canonical unsigned WAD: "+name)
        return int(v)
    principal=uint("observed_market_debt_principal_usd_wad")
    gross=uint("observed_market_gross_oracle_edge_usd_wad")
    gas=uint("observed_winner_gas_cost_usd_wad")
    require(principal>0 and gross>gas>0,"malformed historical market gross/gas")
    return principal,gross,gas

def money(x):
    sign="-" if x<0 else ""
    whole,fract=divmod(abs(x),WAD)
    return sign+str(whole)+"."+str(fract).zfill(18)

def assess(source_raw):
    principal,gross,gas=parse_locked_source(source_raw)
    remainder=gross-gas
    with localcontext() as ctx:
        ctx.prec=42
        ratio=(Decimal(TARGET_WAD)/Decimal(gross)).quantize(Decimal("0.000001"))
    # Gap is a SCENARIO shortfall: assume 100% of reported oracle gross is
    # captured, no other costs. NOT a bound on unobserved/global routes.
    idealized_gap=max(0,TARGET_WAD-gross)
    result={
        "schema_version":1,
        "status":"RMC300K_NET_MONTHLY_TARGET_UNPROVEN",
        "source_code_commit":SOURCE_COMMIT,
        "source_git_blob_sha1":SOURCE_GIT_BLOB,
        "source_scope":"OBSERVED_WINNER_GROSS_ORACLE_EDGE_AAVE_V3_ETHEREUM_ONLY",
        "target_monthly_net_usd_wad":str(TARGET_WAD),
        "target_monthly_net_usd":money(TARGET_WAD),
        "reference_target_days":DAYS_IN_TARGET_PERIOD,
        "reference_daily_net_target_usd_wad":str(TARGET_WAD//DAYS_IN_TARGET_PERIOD),
        "minimum_required_reliability":"P(monthly_net>=300000_USD)>=0.90",
        "minimum_p_target":REQUIRED_LOWER_CONFIDENCE,
        "own_capital_required_usd":"0",
        "target_is_minimum_not_achieved_claim":True,
        "observed_historical_winner_transaction_count":127,
        "observed_historical_liquidation_event_count":139,
        "historical_source_range":[D15_START,D15_END],
        "observed_market_debt_principal_usd_wad":str(principal),
        "observed_market_oracle_gross_usd_wad":str(gross),
        "observed_winner_gas_usd_wad":str(gas),
        "observed_gross_less_only_winner_gas_usd_wad":str(remainder),
        "observed_gross_less_only_winner_gas_is_net_profit":False,
        "target_over_observed_oracle_gross_factor":str(ratio),
        "idealized_full_capture_zero_cost_gross_shortfall_usd_wad":str(idealized_gap),
        "idealized_gap_is_global_required_market_capacity":False,
        "nexus_realized_profit_usd_wad":None,
        "nexus_net_monthly_forecast_usd_wad":None,
        "nexus_positive_capture_lower_bound_usd_wad":"0",
        "monthly_300k_certified":False,
        "conditional_historical_scenarios_are_forecasts":False,
        "cross_chain_multi_protocol_coverage_certified":False,
        "real_market_census_closed":False,
        "extrapolation_used":False,
        "blocking_reasons":list(BLOCKERS),
    }
    result["evidence_report_sha256"]=sha256(canonical(result))
    return result

def main():
    p=argparse.ArgumentParser()
    p.add_argument("--source",type=Path,required=True)
    p.add_argument("--out",type=Path,required=True)
    a=p.parse_args()
    require(not a.out.exists(),"append-only report required")
    result=assess(a.source.read_bytes())
    a.out.parent.mkdir(parents=True,exist_ok=True)
    a.out.write_bytes(canonical(result))
    print(result["status"],"target_USD",TARGET_USD,
          "observed_oracle_gross_USD",money(int(result["observed_market_oracle_gross_usd_wad"])),
          "certified_nexus_net_monthly",result["nexus_net_monthly_forecast_usd_wad"])

if __name__=="__main__":
    main()
