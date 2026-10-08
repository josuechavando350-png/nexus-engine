#!/usr/bin/env python3
"""Adversarial original D16 source-only historic gross-vs-goal hurdle tests."""
import copy
import tempfile
import unittest
from pathlib import Path

import rmc016_market_revenue_hurdles as m

ROOT=Path(__file__).resolve().parents[2]

def sources():
    return m.auth_source(ROOT)

def safe():
    return m.evaluate(sources())

class TestHistoricalNoPromiseEconomicHurdles(unittest.TestCase):
    def test_real_original_source_git_blobs_unchanged(self):
        s=sources()
        self.assertEqual(s["d16"]["authority"]["definite_episode_count"],139)
        self.assertEqual(s["d16"]["authority"]["definite_transaction_count"],127)
        self.assertEqual(s["gas_registry"]["provider_count"],0)

    def test_original_historical_gross_is_not_nqc_revenue(self):
        r=safe()
        self.assertEqual(r["status"],
            "RMC016_HISTORIC_MARKET_GROSS_SHARE_HURDLES_ONLY_NOT_NQC_NET")
        self.assertEqual(r["observed_market_gross_oracle_edge_usd_wad"],
                         m.EXPECTED_GROSS_ORACLE_EDGE)
        self.assertEqual(r["observed_actual_third_party_winner_gas_usd_wad"],
                         m.EXPECTED_OBSERVED_WINNER_GAS)
        self.assertEqual(r["nqc_realized_income_usd_wad"],"0")
        self.assertIsNone(r["monthly_income_forecast_usd"])

    def test_after_market_winner_gas_partial_diff_exact(self):
        r=safe()
        expected=int(m.EXPECTED_GROSS_ORACLE_EDGE)-int(m.EXPECTED_OBSERVED_WINNER_GAS)
        self.assertEqual(int(r["observed_market_partial_gross_edge_after_third_party_gas_usd_wad"]),
                         expected)
        self.assertEqual(expected,136901040429717286157971)

    def test_two_goals_required_fraction_is_integer_ceiling(self):
        r=safe()
        hurdles=r["conditional_necessary_gross_share_thresholds"]
        self.assertEqual([t["hypothetical_same_window_target_usd"] for t in hurdles],
                         ["15000","55000"])
        for t in hurdles:
            target=int(t["hypothetical_same_window_target_usd"])
            bps=t["minimum_required_share_bps_of_observed_gross_oracle_edge_if_NO_costs"]
            partial=t["minimum_required_share_bps_of_observed_market_after_winner_gas_if_other_costs_ZERO"]
            self.assertEqual(bps,m.ceil_div(target*m.WAD*m.BPS,
                                            int(m.EXPECTED_GROSS_ORACLE_EDGE)))
            self.assertGreaterEqual(partial,bps)
            self.assertFalse(t["confirmed_achievable_by_nexus"])
            self.assertFalse(t["empirical_nexus_capture_probability_known"])

    def test_observed_window_not_monthly_growth_extrapolation(self):
        r=safe()
        self.assertEqual(r["observed_window_number_of_blocks"],215036)
        self.assertEqual(r["report_target_scope"],
                         "SAME_OBSERVATION_WINDOW_ALGEBRA_ONLY_NOT_CALENDAR_MONTH")
        self.assertTrue(r["single_observation_window_is_not_revenue_reliability"])
        self.assertFalse(r["monthly_goal_15k_usd_proven"])
        self.assertFalse(r["monthly_goal_55k_usd_proven"])

    def test_no_fictitious_capital_or_profit(self):
        r=safe()
        for k in (
            "complete_transaction_level_cost_ledgers_authenticated_in_this_gate",
            "protocol_flash_route_mev_financing_failure_and_infra_costs_fully_recovered",
            "nqc_external_native_gas_financer_authorized",
            "monthly_goal_15k_usd_proven","monthly_goal_55k_usd_proven",
            "reliability_p_at_least_90pct_proven","rmc011_terminal_closed",
            "rmc013_terminal_closed","rmc015_terminal_closed",
            "rmc016_independent_terminal_authority_promoted_by_this_gate",
            "real_market_census_closed",
            "uncorroborated_archive_empty_result_accepted" # intentionally not emitted
        ):
            if k in r:self.assertIs(r[k],False,k)
        self.assertEqual(r["nqc_capture_probability_lower_bound_wad"],"0")
        self.assertEqual(r["nqc_conservative_realizable_monthly_capacity_usd_wad"],"0")

    def test_hurdle_rounds_up_not_nearest(self):
        self.assertEqual(m.hurdle_bps(1,3*m.WAD),3334)
        self.assertEqual(m.hurdle_bps(1,100*m.WAD),100)
        self.assertEqual(m.hurdle_bps(55_000,100*m.WAD),5_500_000)

    def test_no_division_by_zero_or_invalid_target(self):
        for a,b in ((0,100),(True,100),(-1,100),(1,0),(1,-1),(1,True),(1,0.5)):
            with self.subTest(input=(a,b)):
                with self.assertRaises(ValueError):
                    m.hurdle_bps(a,b)

    def test_fake_zero_gas_or_cost_mutation_source_denied(self):
        d=sources()
        d["d16"]["authority"]["observed_winner_gas_cost_usd_wad"]="0"
        with self.assertRaisesRegex(ValueError,"figures"):
            m.evaluate(d)

    def test_fake_gross_edge_increase_denied(self):
        d=sources()
        d["d16"]["authority"]["observed_market_gross_oracle_edge_usd_wad"]=str(
            5*int(m.EXPECTED_GROSS_ORACLE_EDGE))
        with self.assertRaisesRegex(ValueError,"figures"):
            m.evaluate(d)

    def test_fake_zero_own_capital_gas_sponsor_denied(self):
        d=sources()
        d["gas_registry"]["provider_count"]=1
        d["gas_registry"]["providers"]=[{"provider":"imaginary"}]
        with self.assertRaisesRegex(ValueError,"external gas"):
            m.evaluate(d)

    def test_monthly_capture_authority_fake_denied(self):
        d=sources()
        d["d16"]["authority"]["nqc_conservative_realizable_monthly_capacity_usd_wad"]=str(
            15_000*m.WAD)
        with self.assertRaisesRegex(ValueError,"cannot promote"):
            m.evaluate(d)

    def test_fake_nonzero_nqc_capture_denied(self):
        d=sources()
        d["d16"]["authority"]["nqc_capture_probability_lower_bound_wad"]=str(
            m.WAD//2)
        with self.assertRaisesRegex(ValueError,"cannot promote"):
            m.evaluate(d)

    def test_not_fully_costed_source_is_pinned(self):
        d=sources()
        d["d16"]["authority"]["non_claims"].remove("NO_ROUTE_COMPLETE_HISTORICAL_NET")
        with self.assertRaisesRegex(ValueError,"cannot promote"):
            m.evaluate(d)

    def test_wrong_139_127_conservation_denied(self):
        d=sources()
        d["d16"]["authority"]["definite_transaction_count"]=139
        with self.assertRaisesRegex(ValueError,"127 receipts"):
            m.evaluate(d)

    def test_changed_canonical_historical_block_denied(self):
        d=sources()
        d["d16"]["authority"]["window"]["end_block"]+=1
        with self.assertRaisesRegex(ValueError,"window anchor"):
            m.evaluate(d)

    def test_changed_double_counting_policy_denied(self):
        d=sources()
        d["d16"]["authority"]["double_counting_policy"]="COUNT_LIQUIDATION_EVENT_AS_TX"
        with self.assertRaisesRegex(ValueError,"conflict policy"):
            m.evaluate(d)

    def test_noncanonical_decimal_amounts_denied(self):
        for val in (None,True,1.0,123,"","001","-1","0x100","1e18","1.0"):
            d=sources()
            d["d16"]["authority"]["observed_market_debt_principal_usd_wad"]=val
            with self.subTest(value=str(val)):
                with self.assertRaises(ValueError):
                    m.evaluate(d)

    def test_raw_git_file_change_denied_even_equivalent_json(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            for p in (m.SOURCE_PATH,m.REGISTRY_PATH):
                target=root/p
                target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes((ROOT/p).read_bytes())
            d16=root/m.SOURCE_PATH
            d16.write_bytes(d16.read_bytes()+b"\n")
            with self.assertRaisesRegex(ValueError,"Git object mutated"):
                m.auth_source(root)

    def test_fake_duplicate_keys_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate keys"):
            m.object_json(b'{"authority":{},"authority":{"gross":100}}')

    def test_nqc_source_report_sha256_replay_deterministic(self):
        a=safe()
        b=safe()
        self.assertEqual(a,b)
        claim=a["report_sha256"]
        self.assertEqual(claim,m.sha(m.canonical({k:v for k,v in a.items()
                                                 if k!="report_sha256"})))
        self.assertEqual(len(claim),64)

if __name__=="__main__":
    unittest.main()
