#!/usr/bin/env python3
"""PREINCLUSION-005: public MEV-Share hints for historical Aave HF-trigger oracle TX0s.

Retrospective, read-only, bounded and fail-closed. Neither this probe nor the
historical winner selection establishes prospective receipt, builder inclusion,
recourse-free native-gas financing or repeatable monetary returns.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
from pathlib import Path
import json
import re
from typing import Any

import svr_archive_positive_controls as base

# Authoritative original transaction identities in NQC PR705/#727, selected BEFORE
# consulting the MEV-Share archive. Original index-zero WETH price-report updates.
CAUSAL_CONTROLS = (
    {"label":"AAVE_WETH_USDC_HF_TRIGGER_2026_10_07", "block":26142067,"index":0,
     "tx_hash":"0x20dd5bccadb185dbac34c94c8d00bf363a4a0b779fe1fddcdcfd8a3066d96c8b"},
    {"label":"AAVE_WETH_USDT_HF_TRIGGER_2026_10_08", "block":26149038,"index":0,
     "tx_hash":"0x8195ce367cbf91e713b487af24dcb004def69e1c7ac9f62ce2aaedba04c4566b"},
)

EXTERNAL_CAUSAL_EVIDENCE = {
    "first_oracle_trigger": "NQC PR727, exact 3-state Anvil prefix, workflow 38634669287, source commit 202f3df38abd315a6f6aceb7d388304bd8711ebd, artifact 11927907826, SHA256 ff00c7e499cb3c371aa4848ea90edff2df9526588d878e44fb1829d459573251",
    "second_oracle_trigger": "NQC PR700 source-bound historical ETH/USD price-freeze; historical dRPC controls/attribution limitations apply",
    "prior_crossing_replay_newly_run_in_this_gate": False,
    "two_controls_chosen_with_historical_hindsight": True,
}


def require(ok: bool, why: str):
    if not ok:
        raise ValueError(why)


def classification(source: dict[str, Any]) -> str:
    status = source.get("status", "")
    cases = source.get("positive_controls", [])
    rows = source.get("archive", [])
    if status.startswith("INCOMPLETE_") or len(cases) != 2:
        return "INCOMPLETE_CAUSAL_SOURCE_OR_ARCHIVE"
    if any(not c.get("canonical_receipt_verified") or not c.get("round_advanced") or
           int(c["price_before"]["answer_raw"])<=int(c["price_after"]["answer_raw"])
           for c in cases):
        return "INCOMPLETE_NONDECREASING_ORACLE_SOURCE"
    if len(rows)!=2 or not all(x.get("archive_complete_in_bounded_range") for x in rows):
        return "INCOMPLETE_ARCHIVE_COVERAGE_NOT_ZERO"
    linked=[(r.get("exact_double_hash_matches",0)>0 and
             r.get("matching_double_hash_with_decodable_target",0)>0 and
             any(t.get("hint_price_matches_onchain_transmit_report") is True
                 for t in r.get("matching_archive_source_timings",[]))) for r in rows]
    if linked==[True,True]:
        return "TWO_HISTORICAL_HF_TRIGGER_ORACLE_HINT_LINKS_NO_CAPTURE_AUTHORITY"
    if any(linked):
        return "PARTIAL_HISTORICAL_HF_TRIGGER_HINT_LINK_NOT_RECALL"
    return "NO_COMPLETE_HINT_LINK_IN_TWO_BOUNDED_HISTORICAL_WINDOWS"


def audit(out: Path, *, source_runner=base.run) -> dict[str, Any]:
    require(isinstance(out,Path) and out.is_absolute() and not out.exists() and out.parent.is_dir(),
            "fresh absolute evidence destination required")
    out.mkdir()
    freeze = {
        "schema_version":1,"predeclared_price_changing_oracle_txs":list(CAUSAL_CONTROLS),
        "source":"NQC PR705/PR727 chain 1 historical tx0 witnesses; independent archive yet unqueried",
        "prior_causality":EXTERNAL_CAUSAL_EVIDENCE,
        "mev_share_archive":"https://mev-share.flashbots.net",
        "maximum_history_pages_per_event":8,"maximum_page_size":400,
        "maximum_total_history_gets":17,
        "read_only_no_wallet_no_bid_no_gas":True,
        "created_before_first_network":base.clock(),
    }
    frozen = base.canonical(freeze)
    (out/"causal-source-precommit.json").write_bytes(frozen)
    result = {
        "schema_version":1,"precommit_sha256":sha256(frozen).hexdigest(),
        "status":"INCOMPLETE_NO_CAUSAL_POSITIVE_SOURCE",
        "source_result_status":None,"source_result_sha256":None,
        "source_errors":[],"authenticated_price_drops":[],
        "historical_archive_matches":[],"external_causality_provenance":EXTERNAL_CAUSAL_EVIDENCE,
        "actual_NQC_process_first_seen_proven":False,
        "independent_builder_cutoff_proven":False,
        "prospective_preinclusion_delivery_proven":False,
        "historical_oracle_causality_is_not_prospectivity":True,
        "winning_inclusion_proven":False,"nonrecourse_native_gas_sponsor_proven":False,
        "monthly_net_pnl_certified":False,"realized_NQC_profit_USD":"0",
        "PFT_closed":True,"RMC_closed":False,"Shadow_P2_certified":False,
        "canary_or_LIVE_authorized":False,"operator_capital_usd":"0",
        "MXN2000_reserved_spent":False,
    }
    try:
        evidence = source_runner(out/"attempt",controls=CAUSAL_CONTROLS,require_decrease=True)
        underlying = out/"attempt"/"oracle-to-mev-share-archive-witness.json"
        require(underlying.is_file(),"source witness file missing")
        result["source_result_sha256"]=sha256(underlying.read_bytes()).hexdigest()
        result["source_result_status"]=evidence.get("status")
        result["source_errors"] = evidence.get("source_errors",[])
        for row in evidence.get("positive_controls",[]):
            result["authenticated_price_drops"].append({
                "label":row["label"],"block":row["block_number"],
                "canonical_receipt_verified":row["canonical_receipt_verified"],
                "oracle_round_advanced":row["round_advanced"],
                "price_before_raw":row["price_before"]["answer_raw"],
                "price_after_raw":row["price_after"]["answer_raw"],
                "original_report_median_equals_after":row.get("feed_report_median_matches_after_if_decoded"),
            })
        for row in evidence.get("archive",[]):
            result["historical_archive_matches"].append({
                "rows_scanned":row.get("hint_rows"),
                "archive_complete":row.get("archive_complete_in_bounded_range"),
                "status":row.get("status"),
                "exact_event_hash_matches":row.get("exact_double_hash_matches"),
                "target_report_decodes":row.get("matching_double_hash_with_decodable_target"),
                "source_timestamps_are_not_NQC_first_seen":True,
            })
        result["status"]=classification(evidence)
    except (ValueError,TypeError,KeyError,OverflowError,OSError) as exc:
        result["source_errors"].append({"type":type(exc).__name__,"phase":"bounded_source_read"})
        result["status"]="INCOMPLETE_SOURCE_EXCEPTION_NO_CAPTURE_AUTHORITY"
    result["completed"] = base.clock()
    (out/"causal-oracle-hints-report.json").write_bytes(base.canonical(result))
    return result


if __name__ == "__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--out",required=True,type=Path)
    args=parser.parse_args()
    x=audit(args.out)
    print("PREINCLUSION-005",x["status"],"onchain_drops",len(x["authenticated_price_drops"]),
          "historical_windows",len(x["historical_archive_matches"]),
          "errors",len(x["source_errors"]))
