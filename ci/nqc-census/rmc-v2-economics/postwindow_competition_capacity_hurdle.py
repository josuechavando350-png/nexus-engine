#!/usr/bin/env python3
"""Two-source economic *falsification* gate, not a net P&L forecast or a trade.

Authenticates immutable PR693 indexed transaction conflict sets and PR698
historical funded route surplus. Computes labeled counterfactual capacity by
deduplicating WETH/USDC and WETH/USDT winner transactions.

Never asserts that the REST indexer found all transactions, that a winning
competitor transaction is capturable by NQC, or that a single hindsight-selected
surplus represents other winners. Operator capital including gas remains $0,
with NO demonstrated external nonrecourse gas sponsor. No RPC or broadcasts.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import zipfile

import postwindow_indexed_winner_conflicts as indexed
import postwindow_economic_envelope as economics

INDEX_PRODUCER_SHA = "219b8e97ee667c0797980e3e28edf34030ad1a03"
INDEX_ARTIFACT_SHA = "5a198ad15588e6e2ec692ef05ab16f51127141b3b00b0949b6ea7d945b20d1c4"
INDEX_SUMMARY_SHA = "37b68d4f214e119f2c2b7b20d7c716d101d1d0e42796ec2b97b047a5dd5092e8"
INDEX_PRODUCER_PY_SHA = "8183e6d7326b86dbe4ff9aa63bdb9c7d6a7255b78908826c612c3c9ac326d493"
ROUTE_ARTIFACT_SHA = economics.EXPECTED_ARTIFACT_SHA256
WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7"
MONTH_30D_ASSUMED_BLOCKS = 216_000
MONTH_TARGET_USD = (45_000, 55_000)
SYNTHETIC_CAPTURE_COST_USD = (0, 100, 300)
USD_MICROS = 1_000_000
MAX_ARCHIVE_BYTES = 12_000_000
EVIDENCE_FILE_NAMES = {
    "adversarial-tests.log", "evidence.sha256", "immutable-source.zip",
    "indexed-market-conflicts.json", "negative-tests.py",
    "parent-source-commit.txt", "producer.py",
}


class Rejected(ValueError):
    pass


def need(ok, why):
    if not ok:
        raise Rejected(why)


def integer(v, label, low=0):
    need(type(v) is int and v >= low, label + " must be exact integer")
    return v


def ceildiv(n, d):
    need(type(n) is int and n >= 0 and type(d) is int and d > 0,
         "ceil division arguments invalid")
    return (n+d-1)//d


def canon(v):
    return (json.dumps(v, sort_keys=True, separators=(',', ':'), ensure_ascii=True)+'\n').encode()


def authenticate_index_archive(raw):
    need(type(raw) is bytes and 0 < len(raw) <= MAX_ARCHIVE_BYTES,
         "indexed archive invalid size/type")
    need(sha256(raw).hexdigest() == INDEX_ARTIFACT_SHA, "index ZIP digest drift")
    with zipfile.ZipFile(BytesIO(raw)) as z:
        members = z.infolist()
        names = [f.filename for f in members]
        need(len(names) == len(EVIDENCE_FILE_NAMES) and set(names) == EVIDENCE_FILE_NAMES,
             "index evidence member list changed")
        need(len(names) == len(set(names)), "duplicate ZIP member names")
        for f in members:
            path = PurePosixPath(f.filename)
            need(not f.is_dir() and not path.is_absolute() and
                 f.filename == str(path) and '..' not in path.parts and
                 '\\' not in f.filename and f.file_size < 3_000_000,
                 "unsafe/oversized archive member")
        manifest = z.read("evidence.sha256").decode("ascii")
        declared={}
        for line in manifest.splitlines():
            match = re.fullmatch(r"([0-9a-f]{64})  ([a-z0-9._/-]+)", line)
            need(match is not None, "bad indexed evidence manifest")
            digest, name = match.groups()
            need(name not in declared and name != "evidence.sha256", "duplicate manifest entry")
            declared[name] = digest
        need(set(declared) == EVIDENCE_FILE_NAMES - {"evidence.sha256"},
             "indexed evidence manifest incomplete")
        for name, digest in declared.items():
            need(sha256(z.read(name)).hexdigest() == digest,
                 "indexed member SHA drift: "+name)
        need(z.read("parent-source-commit.txt").decode().strip() ==
             indexed.ORIGINAL_HEAD, "original discovery head changed")
        need(declared["producer.py"] == INDEX_PRODUCER_PY_SHA and
             declared["producer.py"] == sha256(Path(indexed.__file__).read_bytes()).hexdigest(),
             "indexed ranking producer does not match tested repository code")
        nested=z.read("immutable-source.zip")
        need(sha256(nested).hexdigest() == indexed.ZIP_SHA,
             "original Blockscout index ZIP digest drift")
        summary=indexed.source.strict_json(z.read("indexed-market-conflicts.json"))
        computed=indexed.run(nested)
        need(summary == computed, "indexed report differs from fully replayed raw source")
        need(declared["indexed-market-conflicts.json"] == INDEX_SUMMARY_SHA,
             "indexed report raw commitment drift")
        rows=indexed.authenticate_archive(nested)
    return summary,rows,{
        "producer_head":INDEX_PRODUCER_SHA,
        "source_zip_sha256":INDEX_ARTIFACT_SHA,
        "original_indexer_zip_sha256":indexed.ZIP_SHA,
        "verified_manifest_members":len(declared),
        "original_indexer_response_is_exhaustive":False,
    }


def authenticate_route_archive(raw):
    try:
        report, provenance=economics.authenticate_archive(raw)
        cases=economics.authenticated_cases(report)
    except (ValueError, AssertionError, KeyError) as exc:
        raise Rejected("funded route authority changed: "+type(exc).__name__) from exc
    need(sha256(raw).hexdigest()==ROUTE_ARTIFACT_SHA,
         "funded route ZIP digest drift")
    need(len(cases)==2 and {x["label"] for x in cases}==
         {"WETH_COLLATERAL_USDC_DEBT","WETH_COLLATERAL_USDT_DEBT"},
         "funded route economic pair count changed")
    for case in cases:
        integer(case['surplus_asset_micros'], "historical surplus", 1)
        need(case['gross_call_gas_not_receipt_gas']>0,
             "missing strictly gross gas measurement")
    return {x['label']:x for x in cases},provenance


def build_market_slots(index_report,source_rows):
    need(type(index_report) is dict and index_report.get("status")==
         "INDEXER_DISCOVERY_RANKING_ONLY_NOT_CANONICAL_P2_OR_PNL",
         "index report unexpectedly elevated")
    need(index_report.get("source_rest_indexer_full_onchain_completeness") is False and
         index_report.get("block_and_tx_receipt_independent_quorum") is False and
         index_report.get("capturable_future_opportunities_established") is False and
         index_report.get("commercial_score_upgrade") is False and
         index_report.get("RMC_closed") is False and
         index_report.get("P2_shadow_certified") is False and
         index_report.get("nqc_realized_pnl_usd") == "0",
         "indexed source claimed commercial authority")
    need(type(source_rows) is list and len(source_rows)==53 and
         index_report["indexed_event_count"]==53 and
         index_report["unique_indexed_winner_tx_count"]==47 and
         index_report["unique_indexed_pair_count"]==21,
         "original 53/47/21 source identity changed")
    w=index_report.get("window")
    need(type(w) is dict and
         w.get("start")==26_095_352 and w.get("end")==26_184_741 and
         w.get("inclusive_blocks")==89_390,
         "market observation interval drift")
    pools={(WETH, USDC):set(), (WETH, USDT):set()}
    total=set()
    all_pairs=set()
    exact_events=set()
    for r in source_rows:
        need(type(r) is dict and type(r.get("tx_hash")) is str and
             type(r.get("block")) is int and type(r.get("log_index")) is int,
             "raw indexed event identity missing")
        identity=(r["block"],r["tx_hash"],r["log_index"])
        need(identity not in exact_events and w['start']<=r['block']<=w['end'],
             "duplicate/out-of-range index event")
        exact_events.add(identity)
        total.add(r['tx_hash'])
        pair=(r["collateral_asset"],r["debt_asset"])
        all_pairs.add(pair)
        if pair in pools:
            pools[pair].add(r["tx_hash"])
    need(len(total)==47 and len(all_pairs)==21, "market breadth differs from report")
    usdc=pools[(WETH,USDC)]
    usdt=pools[(WETH,USDT)]
    both=usdc & usdt
    need(len(usdc)==9 and len(usdt)==7 and len(both)==1,
         "WETH stable winner overlap/census changed")
    need(len(usdc|usdt)==15,"WETH stable unique candidate count drift")
    # One canonical winning transaction may contain both debt pairs; assigning
    # the higher of two historical *proxies* is a policy, NOT a true measured PnL.
    assignment={tx:'WETH_COLLATERAL_USDC_DEBT' for tx in usdc}
    assignment.update({tx:'WETH_COLLATERAL_USDT_DEBT'
                       for tx in (usdt-usdc)})
    need(len(assignment)==15,"same winning transaction counted more than once")
    report_rank={(r["collateral_asset"],r["debt_asset"]):
                 r["distinct_historical_winner_tx_count"]
                 for r in index_report["ranked_pairs"]}
    need(report_rank[(WETH,USDC)]==len(usdc) and
         report_rank[(WETH,USDT)]==len(usdt),
         "ranked market transaction count disagrees with raw source")
    return {"usdc_txs":usdc, "usdt_txs":usdt, "shared":both,
            "assignment":assignment,"window":w,"total_indexed_txs":total}


def build(index_report,source_rows,route_cases,provenance):
    pools=build_market_slots(index_report,source_rows)
    need(type(route_cases) is dict and set(route_cases)=={
        "WETH_COLLATERAL_USDC_DEBT","WETH_COLLATERAL_USDT_DEBT"},
        "missing canonical historical route cases")
    surpluses={k:integer(v.get('surplus_asset_micros'),k+' surplus',1)
               for k,v in route_cases.items()}
    need(surpluses=={
        "WETH_COLLATERAL_USDC_DEBT":2_273_989_378,
        "WETH_COLLATERAL_USDT_DEBT":150_882_941}, "route economic witness changed")
    window=pools["window"]["inclusive_blocks"]
    result=[]
    for cost in SYNTHETIC_CAPTURE_COST_USD:
        cost_micros=cost*USD_MICROS
        per_window_micros=sum(max(0,surpluses[family]-cost_micros)
                              for family in pools["assignment"].values())
        per_30d_micros=per_window_micros*MONTH_30D_ASSUMED_BLOCKS//window
        rows=[]
        for target in MONTH_TARGET_USD:
            need(per_30d_micros>0,"synthetic scenario left no margin")
            req_bps=ceildiv(target*USD_MICROS*10_000,per_30d_micros)
            rows.append({
                "target_usd":target,
                "capture_share_bps_necessary_under_assumptions":req_bps,
                "possible_within_100pct_of_the_15_assumed_slots":req_bps<=10_000,
                "additional_monthly_contribution_usd_micros_if_full_capture":
                    max(0,target*USD_MICROS-per_30d_micros),
            })
        result.append({
            "synthetic_assumed_combined_cost_per_captured_tx_usd":cost,
            "all_15_distinct_source_txs_proxy_residual_usd_micros_30d":
                per_30d_micros,
            "economically_positive_slot_count_under_assumptions":
                sum(surpluses[f]>cost_micros for f in pools["assignment"].values()),
            "targets":rows,
            "fractional_30d_scaling_is_descriptive_not_future_opportunity_rate":True,
            "cost_is_synthetic_not_cold_tx_gas_or_builder_invoice":True,
            "failed_bid_costs_not_calibrated":True,
            "stablecoins_assumed_at_one_usd_not_onchain_verified":True,
        })
    require_single_market=(9*surpluses["WETH_COLLATERAL_USDC_DEBT"]*
                           MONTH_30D_ASSUMED_BLOCKS//window)
    need(require_single_market>0,"missing historical market proxy")
    return {
        "schema_version":1,
        "status":"COMMERCIAL_TARGET_UNPROVEN_15_INDEXED_TX_SENSITIVITY_ONLY",
        "sources":provenance,
        "historical_indexed_window":pools["window"],
        "indexed_event_count":53,
        "indexed_distinct_winner_transaction_count":47,
        "indexed_asset_pair_count":21,
        "weth_usdc_indexed_winner_txs":len(pools["usdc_txs"]),
        "weth_usdt_indexed_winner_txs":len(pools["usdt_txs"]),
        "shared_winner_transaction_count":len(pools["shared"]),
        "shared_winner_txs":sorted(pools["shared"]),
        "weth_stable_distinct_transaction_slots":len(pools["assignment"]),
        "all_weth_stable_indexed_txs_share_of_47_bps_floor":
            len(pools["assignment"])*10_000//47,
        "weth_usdc_only_monthly_no_cost_proxy_usd_micros":require_single_market,
        "scenarios":result,
        "historical_winner_selection_and_homogeneous_surplus_lookahead":True,
        "ethereum_12_seconds_per_block_assumed_for_month_scaling":True,
        "all_competitor_winner_txs_available_to_nqc_unproven":True,
        "indexer_source_complete_canonical_chain":False,
        "scenario_outputs_are_not_upper_bounds_for_other_realized_strategies":True,
        "no_markets_frozen_or_excluded":True,
        "further_protocols_and_assets_required_for_capacity_validation":True,
        "real_capture_fraction_calibrated":False,
        "full_cold_tx_gas_measured":False,
        "failed_bid_competition_model_calibrated":False,
        "external_nonrecourse_gas_sponsor_certified":False,
        "realizable_nqc_monthly_net_lower_bound_usd_micros":0,
        "net_pnl_certified":False,
        "RMC_closed":False, "P2_shadow_certified":False,
        "canary_live_authorized":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
    }


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--indexed-artifact",required=True,type=Path)
    parser.add_argument("--funded-artifact",required=True,type=Path)
    parser.add_argument("--out",required=True,type=Path)
    a=parser.parse_args()
    need(a.out.is_absolute() and a.out.parent.exists() and
         not a.out.exists(),"fresh absolute report destination required")
    index_report,rows,ixproof=authenticate_index_archive(a.indexed_artifact.read_bytes())
    routes,rtproof=authenticate_route_archive(a.funded_artifact.read_bytes())
    report=build(index_report,rows,routes,
                 {"indexed_market_source":ixproof,"historical_route_source":rtproof})
    with a.out.open("xb") as f:
        f.write(canon(report))
    print(report["status"])
    for row in report['scenarios']:
        print("assumed_cost_usd",row['synthetic_assumed_combined_cost_per_captured_tx_usd'],
              "monthly_proxy_usd",row['all_15_distinct_source_txs_proxy_residual_usd_micros_30d']/USD_MICROS,
              "targets",[(x['target_usd'],x['capture_share_bps_necessary_under_assumptions'])
                         for x in row['targets']])
    return 0


if __name__=="__main__":
    raise SystemExit(main())
