#!/usr/bin/env python3
"""RMC015 negative/censoring tests. Fixtures are SYNTHETIC, never evidence."""
import copy
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import rmc015_dual_source_causal_coverage as gate


def signed(value):
    obj = copy.deepcopy(value)
    obj.pop("report_sha256", None)
    obj["report_sha256"] = gate.digest(gate.canonical(obj))
    return obj


def population():
    return signed({
        "schema_version": 1,
        "status": "RMC015_857_FIXED_COHORT_MULTICALL_FUTURE_STATE_PASS_NOT_CAPTURE",
        "source_anchor_block": gate.ANCHOR,
        "source_anchor_hash": gate.ANCHOR_HASH,
        "borrowers_fixed_using_only_anchor_data": 857,
        "future_block_numbers": [gate.FIRST, gate.LAST],
        "independently_agreeing_archive_rpc_operators": 2,
        "lookahead_used_to_select_cohort": False,
        "competitor_winning_transactions_used_to_select_cohort": False,
        "account_state_endpoints_only_not_continuous_episodes": True,
        "early_signal_captured_by_nqc_live": False,
        "nqc_nonrecourse_gas_or_external_capital_approved": False,
        "nqc_realized_net_profit_usd": "0",
        "rmc015_terminal_closed": False,
        "real_market_census_closed": False,
        "source_watchlist_sha256": "1" * 64,
        "source_frontier_authority_commitment_sha256": "2" * 64,
        "source_anchor_and_future_multicall_code": {
            str(gate.FIRST): {"parent_hash": gate.ANCHOR_HASH,
                              "timestamp": 1700000001},
            str(gate.LAST): {"parent_hash": "0x" + "9" * 64,
                             "timestamp": 1700086401},
        },
        "future_full_population_observations": {
            str(gate.FIRST): {
                "source_preselected_accounts": 857,
                "end_snapshot_counts": {
                    "HEALTHY_AT_ENDPOINT": 857,
                    "NO_DEBT_AT_ENDPOINT": 0,
                    "BELOW_ONE_AT_ENDPOINT": 0,
                },
            },
            str(gate.LAST): {
                "source_preselected_accounts": 857,
                "end_snapshot_counts": {
                    "HEALTHY_AT_ENDPOINT": 851,
                    "NO_DEBT_AT_ENDPOINT": 6,
                    "BELOW_ONE_AT_ENDPOINT": 0,
                },
            },
        },
    })


def events():
    return signed({
        "schema_version": 1,
        "status": "RMC015_857_HISTORIC_REAL_POST_ANCHOR_EVENTS_VERIFIED_NOT_NQC_CAPTURE",
        "real_ethereum_chain_id": 1,
        "original_D09_selection_block": gate.ANCHOR,
        "original_D09_selection_block_hash": gate.ANCHOR_HASH,
        "event_window_start_block": gate.FIRST,
        "event_window_end_block": gate.EVENT_LAST,
        "full_source_cohort_size": 857,
        "event_scope": "FIRST_480_POST_ANCHOR_BLOCKS_ONLY",
        "original_successor_window_expected_blocks": 7200,
        "uninspected_original_successor_blocks": 6720,
        "fully_segmented_Aave_LiquidationCall_event_window": True,
        "real_independent_operator_consensus": True,
        "full_7200_block_source_window_certified": False,
        "rms_future_event_window_complete_for_7200_blocks": False,
        "winners_are_third_parties_not_NQC": True,
        "time_of_first_eligibility_seen_by_NQC_real_time": False,
        "NQC_own_capital_zero_external_gas_authorized": False,
        "NQC_realized_profit_usd": "0",
        "rmc015_terminal_authority_closed": False,
        "real_market_census_closed": False,
        "observed_successful_public_rpc_operator_ids": ["blast", "blockscout"],
        "event_chunks_per_provider": {"blast": 48, "blockscout": 1},
        "real_aave_liquidation_logs_in_window_all_borrowers": 0,
        "real_aave_liquidation_events_matching_source_cohort": 0,
        "real_winner_tx_count_matching_source_cohort": 0,
        "distinct_original_cohort_borrowers_liquidated_in_window": 0,
        "matched_event_type_counts": {},
        "all_liquidation_event_commitment_sha256": gate.EMPTY_EVENT_SHA256,
        "source_cohort_matched_event_commitment_sha256": gate.EMPTY_EVENT_SHA256,
        "source_watchlist_commitment_sha256": "1" * 64,
        "source_frontier_authority_sha256": "2" * 64,
    })


class CausalCoverageTest(unittest.TestCase):
    def setUp(self):
        self.p = population()
        self.e = events()

    def reject(self, target, key, value):
        source = self.p if target == "pop" else self.e
        source[key] = value
        source = signed(source)
        if target == "pop":
            self.p = source
        else:
            self.e = source
        with self.assertRaises(ValueError):
            gate.evaluate(self.p, self.e)

    def test_synthetic_candidate_is_not_authenticated(self):
        result = gate.evaluate(self.p, self.e)
        self.assertFalse(result["source_archives_authenticated"])
        self.assertIn("NOT_CERTIFIED", result["status"])
        self.assertFalse(result["real_market_census_closed"])

    def test_partial_temporal_coverage_is_exact(self):
        result = gate.evaluate(self.p, self.e)
        self.assertEqual(result["covered_executed_liquidation_event_block_intervals"],
                         [[gate.FIRST, gate.EVENT_LAST]])
        self.assertEqual(result["uncovered_and_censored_executed_event_block_intervals"],
                         [[gate.EVENT_LAST + 1, gate.LAST]])
        self.assertEqual(result["unobserved_executed_event_blocks"], 6720)
        self.assertIsNone(result["executed_liquidation_count_for_full_7200_blocks"])
        self.assertIsNone(result["liquidation_events_in_missing_6720_blocks"])

    def test_no_implicit_positive_predictions_or_capture(self):
        result = gate.evaluate(self.p, self.e)
        for name in ("precommitted_positive_alarm_count_at_anchor",
                     "positive_alarm_precision", "positive_alarm_recall",
                     "unexecuted_economically_actionable_opportunities"):
            self.assertIsNone(result[name])
        self.assertFalse(result["nqc_capture_probability_calibrated"])
        self.assertEqual(result["nqc_realized_net_usd_wad"], "0")

    def test_source_report_digest_tamper_rejected(self):
        self.p["source_anchor_block"] += 1
        with self.assertRaisesRegex(ValueError, "hash mismatch"):
            gate.evaluate(self.p, self.e)

    def test_wrong_population_venue_rejected(self):
        self.reject("pop", "source_anchor_hash", "0x" + "0" * 64)

    def test_wrong_event_chain_rejected(self):
        self.reject("ev", "real_ethereum_chain_id", 10)

    def test_missing_480_block_gaps_rejected(self):
        self.reject("ev", "event_window_end_block", gate.EVENT_LAST - 1)

    def test_false_7200_complete_marker_rejected(self):
        self.reject("ev", "full_7200_block_source_window_certified", True)

    def test_lied_unobserved_remainder_rejected(self):
        self.reject("ev", "uninspected_original_successor_blocks", 0)

    def test_wrong_operator_quorum_rejected(self):
        self.reject("ev", "observed_successful_public_rpc_operator_ids",
                    ["blast", "blast"])

    def test_missing_partition_rejected(self):
        self.reject("ev", "event_chunks_per_provider", {"blast": 47, "blockscout": 1})

    def test_forged_empty_log_commitment_rejected(self):
        self.reject("ev", "all_liquidation_event_commitment_sha256", "0" * 64)

    def test_different_857_source_universes_rejected(self):
        self.reject("ev", "source_watchlist_commitment_sha256", "3" * 64)

    def test_future_labels_choose_cohort_rejected(self):
        self.reject("pop", "lookahead_used_to_select_cohort", True)

    def test_forged_realtime_signal_rejected(self):
        self.reject("pop", "early_signal_captured_by_nqc_live", True)

    def test_forged_gas_credit_rejected(self):
        self.reject("ev", "NQC_own_capital_zero_external_gas_authorized", True)

    def test_forged_live_pnl_rejected(self):
        self.reject("ev", "NQC_realized_profit_usd", "100000")

    def test_terminal_closeout_promotion_rejected(self):
        self.reject("pop", "rmc015_terminal_closed", True)

    def test_no_debt_does_not_mean_a_liquidation(self):
        result = gate.evaluate(self.p, self.e)
        self.assertEqual(result["last_7200th_block_857_position_snapshot"]
                         ["NO_DEBT_AT_ENDPOINT"], 6)
        self.assertTrue(result["borrowers_without_debt_at_last_endpoint_did_not_prove_liquidation"])

    def test_bool_endpoint_state_rejected(self):
        self.p["future_full_population_observations"][str(gate.LAST)]["end_snapshot_counts"]["NO_DEBT_AT_ENDPOINT"] = True
        self.p = signed(self.p)
        with self.assertRaises(ValueError):
            gate.evaluate(self.p, self.e)

    def test_negative_or_missing_endpoint_denominator_rejected(self):
        self.p["future_full_population_observations"][str(gate.LAST)]["end_snapshot_counts"]["NO_DEBT_AT_ENDPOINT"] = -1
        self.p = signed(self.p)
        with self.assertRaises(ValueError):
            gate.evaluate(self.p, self.e)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            gate.unique_json(b'{"test":1,"test":2}')

    def test_bad_zip_cannot_replace_immutable_evidence(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "fake.zip"
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr(gate.POP["member"], gate.canonical(self.p))
                archive.writestr("archive.sha256", "fake\n")
                archive.writestr("producer-source.sha256", "fake\n")
            with self.assertRaisesRegex(ValueError, "exact original Actions ZIP"):
                gate.artifact_report(path, gate.POP)

    def test_cannot_claim_observed_nonzero_events_on_zero_source(self):
        self.reject("ev", "real_aave_liquidation_logs_in_window_all_borrowers", 1)

    def test_source_anchored_child_block_required(self):
        self.p["source_anchor_and_future_multicall_code"][str(gate.FIRST)]["parent_hash"] = "0x" + "0" * 64
        self.p = signed(self.p)
        with self.assertRaises(ValueError):
            gate.evaluate(self.p, self.e)

    def test_timestamp_reversal_rejected(self):
        self.p["source_anchor_and_future_multicall_code"][str(gate.LAST)]["timestamp"] = 1
        self.p = signed(self.p)
        with self.assertRaises(ValueError):
            gate.evaluate(self.p, self.e)

    def test_deterministic_canonical_report_digest(self):
        a = gate.evaluate(self.p, self.e)
        b = gate.evaluate(self.p, self.e)
        self.assertEqual(gate.canonical(a), gate.canonical(b))
        self.assertEqual(a["report_sha256"],
                         gate.digest(gate.canonical({k: v for k, v in a.items()
                                                      if k != "report_sha256"})))


if __name__ == "__main__":
    unittest.main(verbosity=2)
