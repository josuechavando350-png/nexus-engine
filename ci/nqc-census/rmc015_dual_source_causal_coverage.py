#!/usr/bin/env python3
"""RMC015: compose TWO immutable, previously observed causal-cohort archives.

This is a partial evidence join, not a prediction, a 7,200-block event census,
a shadow trading result, or independent terminal RMC-015 certification.
No RPC access, wallet, paid service or secret is required.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

ANCHOR = 26095351
ANCHOR_HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"
FIRST = ANCHOR + 1
EVENT_LAST = ANCHOR + 480
LAST = ANCHOR + 7200
COHORT = 857
EMPTY_EVENT_SHA256 = hashlib.sha256(b"").hexdigest()
POP = {
    "run": 37802830152,
    "artifact": 11561622884,
    "head": "38fe58debbd729753f84d4587a9f3b961a542bc9",
    "sha256": "15bbe3f90214c95692f0fa64997d1bd103177f02ed78049f17a8500925408829",
    "member": "857-full-cohort-real-future.json",
}
EVENTS = {
    "run": 37807155179,
    "artifact": 11562554317,
    "head": "c2d84ff6486202eb2a5810852e21e89b3ab5e2c5",
    "sha256": "f431bc64770be49ebeee5d48a40f8013592c3a4f1c25fd3abbd4c43f6c66c9f3",
    "member": "all-857-future-liquidation-events.json",
}
SHA = re.compile(r"[0-9a-f]{64}\Z")


def need(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True) + "\n").encode("ascii")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unique_json(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "duplicate JSON key in certified source")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=unique)


def verified_report(report):
    need(type(report) is dict, "source JSON report must be an object")
    h = report.get("report_sha256")
    need(type(h) is str and SHA.fullmatch(h) is not None,
         "source report commitment missing")
    without = {k: v for k, v in report.items() if k != "report_sha256"}
    need(digest(canonical(without)) == h,
         "source report content hash mismatch")
    return report


def artifact_report(path, pinned):
    raw = Path(path).read_bytes()
    need(0 < len(raw) < 1_000_000 and digest(raw) == pinned["sha256"],
         "exact original Actions ZIP SHA-256 not verified")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        infos = archive.infolist()
        allowed = {pinned["member"], "producer-source.sha256", "archive.sha256"}
        names = [info.filename for info in infos]
        need(len(names) == 3 and set(names) == allowed,
             "missing, duplicated or injected GitHub archive members")
        need(all(not info.is_dir() and 0 < info.file_size < 128_000 and
                 info.file_size == len(archive.read(info)) and
                 (info.external_attr >> 16) & 0o170000 != 0o120000
                 for info in infos),
             "unsafe archive path, size or symlink")
        files = {name: archive.read(name) for name in names}
    manifest = files["archive.sha256"].decode("ascii").splitlines()
    hashes = {}
    for line in manifest:
        part = line.split("  ")
        need(len(part) == 2 and SHA.fullmatch(part[0]) is not None and
             part[1] in allowed - {"archive.sha256"} and
             part[1] not in hashes, "invalid original inner SHA-256 manifest")
        hashes[part[1]] = part[0]
    need(set(hashes) == allowed - {"archive.sha256"} and
         all(digest(files[name]) == value for name, value in hashes.items()),
         "immutable archive inner SHA-256 manifest mismatch")
    report = unique_json(files[pinned["member"]])
    need(canonical(report) == files[pinned["member"]],
         "noncanonical content of certified JSON report")
    return verified_report(report)


def counts(report, number):
    node = report["future_full_population_observations"].get(str(number))
    need(type(node) is dict and node.get("source_preselected_accounts") == COHORT
         and type(node.get("source_preselected_accounts")) is int,
         "original population denominator changed")
    c = node.get("end_snapshot_counts")
    need(type(c) is dict and set(c) == {
        "HEALTHY_AT_ENDPOINT", "NO_DEBT_AT_ENDPOINT", "BELOW_ONE_AT_ENDPOINT"
    } and all(type(v) is int and v >= 0 for v in c.values()) and
         sum(c.values()) == COHORT,
         "missing, negative, boolean or extra endpoint cohort state")
    return c


def evaluate(population, events):
    """Pure composition: synthetic tests NEVER constitute authentic archives."""
    verified_report(population)
    verified_report(events)
    need(population.get("schema_version") == 1 and
         type(population.get("schema_version")) is int and
         population.get("status") ==
         "RMC015_857_FIXED_COHORT_MULTICALL_FUTURE_STATE_PASS_NOT_CAPTURE" and
         population.get("source_anchor_block") == ANCHOR and
         population.get("source_anchor_hash") == ANCHOR_HASH and
         population.get("borrowers_fixed_using_only_anchor_data") == COHORT and
         population.get("future_block_numbers") == [FIRST, LAST] and
         population.get("independently_agreeing_archive_rpc_operators") == 2 and
         type(population.get("independently_agreeing_archive_rpc_operators")) is int and
         population.get("lookahead_used_to_select_cohort") is False and
         population.get("competitor_winning_transactions_used_to_select_cohort") is False and
         population.get("account_state_endpoints_only_not_continuous_episodes") is True and
         population.get("early_signal_captured_by_nqc_live") is False and
         population.get("nqc_nonrecourse_gas_or_external_capital_approved") is False and
         population.get("nqc_realized_net_profit_usd") == "0" and
         population.get("rmc015_terminal_closed") is False and
         population.get("real_market_census_closed") is False,
         "historical 857-source endpoint witness not admitted")
    before = counts(population, FIRST)
    after = counts(population, LAST)
    need(before == {"HEALTHY_AT_ENDPOINT": 857, "NO_DEBT_AT_ENDPOINT": 0,
                    "BELOW_ONE_AT_ENDPOINT": 0} and
         after == {"HEALTHY_AT_ENDPOINT": 851, "NO_DEBT_AT_ENDPOINT": 6,
                   "BELOW_ONE_AT_ENDPOINT": 0},
         "original source-verified endpoint populations changed")
    headers = population.get("source_anchor_and_future_multicall_code")
    need(type(headers) is dict and str(FIRST) in headers and str(LAST) in headers
         and headers[str(FIRST)].get("parent_hash") == ANCHOR_HASH
         and type(headers[str(FIRST)].get("timestamp")) is int
         and type(headers[str(LAST)].get("timestamp")) is int
         and headers[str(FIRST)]["timestamp"] < headers[str(LAST)]["timestamp"],
         "post-anchor state ancestry or real clock ordering not admitted")
    need(events.get("schema_version") == 1 and
         type(events.get("schema_version")) is int and
         events.get("status") ==
         "RMC015_857_HISTORIC_REAL_POST_ANCHOR_EVENTS_VERIFIED_NOT_NQC_CAPTURE" and
         events.get("real_ethereum_chain_id") == 1 and
         type(events.get("real_ethereum_chain_id")) is int and
         events.get("original_D09_selection_block") == ANCHOR and
         events.get("original_D09_selection_block_hash") == ANCHOR_HASH and
         events.get("event_window_start_block") == FIRST and
         events.get("event_window_end_block") == EVENT_LAST and
         events.get("full_source_cohort_size") == COHORT and
         events.get("event_scope") == "FIRST_480_POST_ANCHOR_BLOCKS_ONLY" and
         events.get("original_successor_window_expected_blocks") == 7200 and
         events.get("uninspected_original_successor_blocks") == 6720 and
         events.get("fully_segmented_Aave_LiquidationCall_event_window") is True and
         events.get("real_independent_operator_consensus") is True and
         events.get("full_7200_block_source_window_certified") is False and
         events.get("rms_future_event_window_complete_for_7200_blocks") is False and
         events.get("winners_are_third_parties_not_NQC") is True and
         events.get("time_of_first_eligibility_seen_by_NQC_real_time") is False and
         events.get("NQC_own_capital_zero_external_gas_authorized") is False and
         events.get("NQC_realized_profit_usd") == "0" and
         events.get("rmc015_terminal_authority_closed") is False and
         events.get("real_market_census_closed") is False,
         "original bounded independently verified 480-block outcome not admitted")
    need(events.get("observed_successful_public_rpc_operator_ids") ==
         ["blast", "blockscout"] and
         events.get("event_chunks_per_provider") ==
         {"blast": 48, "blockscout": 1},
         "original independent source identity or partition coverage changed")
    for key in ("real_aave_liquidation_logs_in_window_all_borrowers",
                "real_aave_liquidation_events_matching_source_cohort",
                "real_winner_tx_count_matching_source_cohort",
                "distinct_original_cohort_borrowers_liquidated_in_window"):
        need(type(events.get(key)) is int and events[key] == 0,
             "original witnessed 480-block event outcome mismatch")
    need(events.get("matched_event_type_counts") == {} and
         events.get("all_liquidation_event_commitment_sha256") == EMPTY_EVENT_SHA256 and
         events.get("source_cohort_matched_event_commitment_sha256") ==
         EMPTY_EVENT_SHA256, "zero-event raw log commitments not matched")
    need(population.get("source_watchlist_sha256") ==
         events.get("source_watchlist_commitment_sha256") and
         population.get("source_frontier_authority_commitment_sha256") ==
         events.get("source_frontier_authority_sha256") and
         type(population.get("source_watchlist_sha256")) is str and
         SHA.fullmatch(population["source_watchlist_sha256"]) is not None and
         type(population.get("source_frontier_authority_commitment_sha256")) is str and
         SHA.fullmatch(population["source_frontier_authority_commitment_sha256"]) is not None,
         "different selection universes/authority joined")
    # Crucial: a retrospectively reconstructed risk *cohort* is not a
    # predeclared alarm and cannot be assigned a false-positive score.
    report = {
        "schema_version": 1,
        "status": "RMC015_CAUSAL_COVERAGE_COMPOSITION_CANDIDATE_NOT_CERTIFIED",
        "source_archives_authenticated": False,
        "chain_id": 1,
        "source_anchor_block": ANCHOR,
        "source_anchor_hash": ANCHOR_HASH,
        "fixed_prior_selected_material_risk_cohort": COHORT,
        "source_watchlist_sha256": population["source_watchlist_sha256"],
        "source_frontier_authority_sha256":
            population["source_frontier_authority_commitment_sha256"],
        "historical_archive_endpoint_blocks": [FIRST, LAST],
        "covered_executed_liquidation_event_block_intervals": [[FIRST, EVENT_LAST]],
        "uncovered_and_censored_executed_event_block_intervals": [[EVENT_LAST + 1, LAST]],
        "original_intended_successor_block_count": 7200,
        "independently_verified_executed_event_blocks": 480,
        "unobserved_executed_event_blocks": 6720,
        "observed_global_aave_liquidation_calls_first_480_blocks": 0,
        "observed_857_cohort_liquidation_calls_first_480_blocks": 0,
        "observed_857_cohort_winning_transactions_first_480_blocks": 0,
        "first_post_anchor_857_position_snapshot": before,
        "last_7200th_block_857_position_snapshot": after,
        "continuous_position_states_over_7200_blocks_observed": False,
        "executed_liquidation_count_for_full_7200_blocks": None,
        "liquidation_events_in_missing_6720_blocks": None,
        "unexecuted_economically_actionable_opportunities": None,
        "precommitted_positive_alarm_count_at_anchor": None,
        "positive_alarm_precision": None,
        "positive_alarm_recall": None,
        "nqc_real_time_alert_latency_measured": False,
        "historical_source_selection_fixed_without_future_winner": True,
        "historical_replay_is_not_a_real_time_ex_ante_signal": True,
        "borrowers_without_debt_at_last_endpoint_did_not_prove_liquidation": True,
        "independent_terminal_rmc015_authority": False,
        "nqc_gas_provider_execution_authorized": False,
        "nqc_capture_probability_calibrated": False,
        "nqc_realized_net_usd_wad": "0",
        "real_market_census_closed": False,
        "source_run_artifact_identifiers": [
            {k: v for k, v in pinned.items() if k != "member"}
            for pinned in (POP, EVENTS)
        ],
        "non_claims": [
            "NO_7200_BLOCK_EXECUTED_EVENT_CENSUS",
            "NO_ASSUMPTION_NO_LIQUIDATIONS_IN_MISSING_BLOCKS",
            "NO_ASSUMPTION_ENDPOINT_HEALTH_EXCLUDES_TRANSIENT_HF_CROSSING",
            "NO_FALSE_POSITIVE_CLASSIFICATION_FROM_A_RISK_COHORT_ALONE",
            "NO_PRECOMMITTED_SIGNAL_OR_CAPTURE_PROBABILITY",
            "NO_NQC_PROFIT_OR_NONRECOURSE_GAS_AUTHORITY",
            "NO_RMC015_OR_CENSUS_TERMINAL_CERTIFICATION",
        ],
    }
    report["report_sha256"] = digest(canonical(report))
    return report


def evaluate_archives(population_path, event_path):
    population = artifact_report(population_path, POP)
    events = artifact_report(event_path, EVENTS)
    report = evaluate(population, events)
    del report["report_sha256"]
    report["status"] = "RMC015_TWO_PINNED_ARCHIVES_PARTIAL_CAUSAL_COVERAGE_ONLY"
    report["source_archives_authenticated"] = True
    report["report_sha256"] = digest(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--population-archive", type=Path, required=True)
    parser.add_argument("--event-archive", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    need(not args.out.exists(), "append-only admission report; never overwrite")
    report = evaluate_archives(args.population_archive, args.event_archive)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(report))
    print(report["status"], "verified_executed_event_blocks=480",
          "CENSORED_BLOCKS=6720", "NQC_REALIZED_USD=0",
          "CENSUS_CLOSED=false")


if __name__ == "__main__":
    main()
