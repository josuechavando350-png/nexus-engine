#!/usr/bin/env python3
"""RMC016 true elapsed historical market window, not a Nexus income projection.

The original certified D16 market gross and third-party transaction-gas data
do not by themselves establish monthly financial capacity. This producer
independently reads historical Ethereum headers to establish the *actual*
elapsed wall-clock denominator for a known 139-event/127-tx market cohort.
This does NOT extrapolate into the future, calibrate NQC capture, or turn
partially netted oracle margins into net realized NQC revenue.
"""
from __future__ import annotations
import argparse
from pathlib import Path
import rmc016_market_revenue_hurdles as economic
from rmc016_probe_historical_rpc import PROVIDERS, rpc

STATUS="RMC016_TRUE_HISTORIC_WINDOW_DURATION_DUAL_RPC_NOT_NQC_PNL"
SECONDS_DAY=86400
DAYS_30=30
MAX_ELAPSED_DAYS=60
MIN_ELAPSED_DAYS=10
GIT_SOURCE_BLOB=economic.SOURCE_GIT_BLOB_SHA1
CHAIN=1


def need(condition,message):
    if not condition:raise ValueError(message)


def canonical_header(provider,number,expected_hash,*,call=rpc):
    pid,operator,url=provider
    header=call(url,"eth_getBlockByNumber",[hex(number),False])
    need(type(header) is dict and economic.object_json, "historic header absent")
    def integer_hex(x,what):
        need(type(x) is str and x.startswith("0x") and x[2:]
             and all(c in "0123456789abcdef" for c in x[2:]) and
             (x=="0x0" or x[2]!="0"),
             "noncanonical historic Ethereum "+what)
        return int(x,16)
    need(integer_hex(header.get("number"),"block number")==number
         and header.get("hash")==expected_hash,
         "historical block hash/height drift or changed chain")
    for field in ("parentHash","stateRoot"):
        v=header.get(field)
        need(type(v) is str and len(v)==66 and v.startswith("0x") and
             all(c in "0123456789abcdef" for c in v[2:]),
             "historic block missing "+field)
    ts=integer_hex(header.get("timestamp"),"timestamp")
    need(ts>0,"historic block time invalid")
    return {
        "number":number,
        "hash":header["hash"],
        "parent_hash":header["parentHash"],
        "state_root":header["stateRoot"],
        "timestamp_epoch_seconds":ts,
    }


def one_operator(provider,*,call=rpc):
    pid,operator,url=provider
    need(call(url,"eth_chainId",[])=="0x1","Ethereum chain id not 1")
    a=canonical_header(provider,economic.EXPECTED_WINDOW[0],
                       economic.EXPECTED_WINDOW_HASHES[0],call=call)
    b=canonical_header(provider,economic.EXPECTED_WINDOW[1],
                       economic.EXPECTED_WINDOW_HASHES[1],call=call)
    elapsed=b["timestamp_epoch_seconds"]-a["timestamp_epoch_seconds"]
    need(MIN_ELAPSED_DAYS*SECONDS_DAY < elapsed <
         MAX_ELAPSED_DAYS*SECONDS_DAY,
         "historical timestamp span is nonchronological or implausible")
    return {
        "provider_id":pid,
        "operator":operator,
        "historical_source_headers":[a,b],
        "actual_elapsed_seconds_between_pinned_headers":elapsed,
    }


def assess(*,root=Path("."),call=rpc,providers=None):
    sources=economic.auth_source(root)
    prior=economic.evaluate(sources)
    need(prior["status"]==
         "RMC016_HISTORIC_MARKET_GROSS_SHARE_HURDLES_ONLY_NOT_NQC_NET"
         and prior["real_market_census_closed"] is False
         and prior["nqc_external_native_gas_financer_authorized"] is False
         and prior["nqc_realized_income_usd_wad"]=="0"
         and prior["monthly_income_forecast_usd"] is None,
         "upstream historical market gross source falsely promoted to Nexus revenue")
    candidates=providers
    if candidates is None:
        candidates=[p for p in PROVIDERS if p[0] in ("drpc","blast")]
    need(type(candidates) in (tuple,list) and len(candidates)==2 and
         [p[0] for p in candidates]==["drpc","blast"] and
         candidates[0][1]!=candidates[1][1] and
         candidates[0][2]!=candidates[1][2],
         "two independent original Ethereum historic header operators required")
    witnesses=[one_operator(provider,call=call) for provider in candidates]
    need(witnesses[0]["historical_source_headers"]==
         witnesses[1]["historical_source_headers"],
         "independent historical Ethereum operators disagree on timestamps/headers")
    elapsed=witnesses[0]["actual_elapsed_seconds_between_pinned_headers"]
    need(elapsed==witnesses[1]["actual_elapsed_seconds_between_pinned_headers"],
         "independent elapsed-duration sources disagree")
    gross=economic.integer_wad(sources["d16"]["authority"],
         "observed_market_gross_oracle_edge_usd_wad")
    gas=economic.integer_wad(sources["d16"]["authority"],
         "observed_winner_gas_cost_usd_wad")
    partial=gross-gas
    need(gross>gas>0 and
         str(gross)==prior["observed_market_gross_oracle_edge_usd_wad"] and
         str(partial)==prior[
           "observed_market_partial_gross_edge_after_third_party_gas_usd_wad"],
         "original certified D16 source economic WAD mismatch")
    # This is historical rate arithmetic and a 30-day equivalent of one
    # previously observed period. NOT a stochastic forecast or sustainable
    # monthly NQC revenue estimate.
    report={
        "schema_version":1,
        "status":STATUS,
        "chain_id":CHAIN,
        "original_D16_source_git_blob_sha1":GIT_SOURCE_BLOB,
        "original_gas_authority_registry_git_blob_sha1":
            economic.REGISTRY_GIT_BLOB_SHA1,
        "original_market_window_start_block":economic.EXPECTED_WINDOW[0],
        "original_market_window_end_block":economic.EXPECTED_WINDOW[1],
        "original_market_window_block_count":economic.EXPECTED_WINDOW[1]-
            economic.EXPECTED_WINDOW[0]+1,
        "independent_historical_block_operator_ids":
            [p[0] for p in candidates],
        "independent_historical_source_header_witnesses":witnesses,
        "actual_elapsed_seconds_between_start_and_end_block_timestamps":elapsed,
        "actual_elapsed_days_numerator":elapsed,
        "actual_elapsed_days_denominator":SECONDS_DAY,
        "one_source_window_not_an_automatically_repeatable_month":True,
        "observed_market_third_party_liquidation_events":prior[
            "observed_competitor_liquidation_events"],
        "observed_third_party_unique_winning_transactions":prior[
            "observed_competitor_winning_transactions"],
        "observed_market_oracle_gross_usd_wad":str(gross),
        "observed_market_partial_after_competitor_paid_gas_usd_wad":str(partial),
        "observed_historical_oracle_gross_rate_usd_per_day_wad_floor":
            str(gross*SECONDS_DAY//elapsed),
        "observed_historical_partial_after_competitor_gas_usd_per_day_wad_floor":
            str(partial*SECONDS_DAY//elapsed),
        "same_past_window_30_day_arithmetic_equivalent_oracle_gross_usd_wad_floor":
            str(gross*SECONDS_DAY*DAYS_30//elapsed),
        "same_past_window_30_day_arithmetic_equivalent_partial_after_third_party_gas_usd_wad_floor":
            str(partial*SECONDS_DAY*DAYS_30//elapsed),
        "original_same_window_nominal_USD_target_share_thresholds":
            prior["conditional_necessary_gross_share_thresholds"],
        "post_hoc_historical_arithmetic_is_no_future_market_forecast":True,
        "all_monetization_execution_capital_builder_costs_complete":False,
        "nqc_market_share_or_capture_probability_calibrated":False,
        "nqc_nonrecourse_native_gas_credit_line_available":False,
        "nqc_realized_net_profit_usd_wad":"0",
        "nqc_monthly_USD_15000_or_55000_reliability_certified":False,
        "rmc011_terminal_closed":False,
        "rmc015_terminal_closed":False,
        "rmc016_terminal_authority_closed_by_this_report":False,
        "real_market_census_closed":False,
    }
    report["report_sha256"]=economic.sha(economic.canonical(report))
    return report


def main():
    p=argparse.ArgumentParser()
    p.add_argument("--repo-root",type=Path,default=Path("."))
    p.add_argument("--out",type=Path,required=True)
    args=p.parse_args()
    need(not args.out.exists(),"historical timing report must be append-only")
    report=assess(root=args.repo_root)
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_bytes(economic.canonical(report))
    print(STATUS,
          "elapsed_seconds",report[
              "actual_elapsed_seconds_between_start_and_end_block_timestamps"],
          "historic_oracle_gross_USD_WAD",report["observed_market_oracle_gross_usd_wad"],
          "historic_per_30d_oracle_gross_USD_WAD",report[
              "same_past_window_30_day_arithmetic_equivalent_oracle_gross_usd_wad_floor"],
          "NQC_REALIZED_USD_WAD=0","CENSUS_CLOSED=false")


if __name__=="__main__":
    main()
