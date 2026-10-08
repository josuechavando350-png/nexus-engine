#!/usr/bin/env python3
"""Adversarial test suite for the exact source-locked $300k NET monthly RMC gate."""
from __future__ import annotations
import copy
import json
import unittest
from pathlib import Path
import rmc300k_monthly_net_gate as G

HERE=Path(__file__).resolve().parent

class NetTargetGuardrails(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.raw=(HERE/"rmc016-production-evidence.json").read_bytes()
        cls.report=G.assess(cls.raw)

    def test_strict_minimum_not_status_promotion(self):
        x=self.report
        self.assertEqual(x["target_monthly_net_usd_wad"],str(300_000*10**18))
        self.assertEqual(x["reference_daily_net_target_usd_wad"],str(10_000*10**18))
        self.assertEqual(x["status"],"RMC300K_NET_MONTHLY_TARGET_UNPROVEN")
        self.assertEqual(x["minimum_p_target"],"0.90")
        self.assertTrue(x["target_is_minimum_not_achieved_claim"])
        self.assertFalse(x["monthly_300k_certified"])
        self.assertFalse(x["real_market_census_closed"])
    def test_observed_winners_are_not_nexus_wins(self):
        x=self.report
        self.assertEqual(x["observed_historical_winner_transaction_count"],127)
        self.assertEqual(x["observed_historical_liquidation_event_count"],139)
        self.assertIsNone(x["nexus_realized_profit_usd_wad"])
        self.assertIsNone(x["nexus_net_monthly_forecast_usd_wad"])
        self.assertEqual(x["nexus_positive_capture_lower_bound_usd_wad"],"0")
        self.assertFalse(x["conditional_historical_scenarios_are_forecasts"])
    def test_source_usd_wad_accurate(self):
        x=self.report
        self.assertEqual(x["observed_market_oracle_gross_usd_wad"],
                         "138045174690310000000000")
        self.assertEqual(x["observed_winner_gas_usd_wad"],
                         "1144134260592713842029")
        self.assertEqual(x["observed_gross_less_only_winner_gas_usd_wad"],
                         "136901040429717286157971")
        self.assertFalse(x["observed_gross_less_only_winner_gas_is_net_profit"])
    def test_capture_fraction_scenarios_are_not_forecasts(self):
        scenarios=self.report["capture_sensitivity_at_zero_other_cost"]
        self.assertEqual([x["hypothetical_full_cost_free_capture_percent"] for x in scenarios],
                         [10,25,50,100])
        self.assertEqual([int(x["minimum_required_total_gross_usd_wad_at_zero_additional_cost"])
                          for x in scenarios],
                         [3000000*G.WAD,1200000*G.WAD,600000*G.WAD,300000*G.WAD])
        self.assertTrue(all(x["hypothetical_not_calibrated"] and x["not_a_nexus_forecast"]
                            for x in scenarios))
        self.assertFalse(self.report["monthly_300k_certified"])

    def test_capture_scenarios_do_not_promote_observed_market_gross(self):
        actual=int(self.report["observed_market_oracle_gross_usd_wad"])
        gross=list(self.report["capture_sensitivity_at_zero_other_cost"])
        self.assertTrue(all(actual<int(x["minimum_required_total_gross_usd_wad_at_zero_additional_cost"])
                            for x in gross))
        self.assertIsNone(self.report["nexus_net_monthly_forecast_usd_wad"])

    def test_idealized_gap_is_not_global_market_bound(self):
        x=self.report
        self.assertEqual(int(x["idealized_full_capture_zero_cost_gross_shortfall_usd_wad"]),
                         300000*10**18-138045174690310000000000)
        self.assertFalse(x["idealized_gap_is_global_required_market_capacity"])
        self.assertFalse(x["cross_chain_multi_protocol_coverage_certified"])
    def test_no_30_day_extrapolation(self):
        x=self.report
        self.assertFalse(x["extrapolation_used"])
        self.assertEqual(x["historical_source_range"],[25880316,26095351])
        self.assertEqual(x["reference_target_days"],30)
        self.assertIn("COMPLETE_30_DAY_NET_CAPACITY_AND_P90_UNPROVEN",x["blocking_reasons"])
    def test_zero_own_capital_binds_gas_and_flash_principal(self):
        x=self.report
        self.assertEqual(x["own_capital_required_usd"],"0")
        self.assertIn("INDEPENDENTLY_FINANCED_GAS_AT_OWN_CAPITAL_ZERO_UNPROVEN",
                      x["blocking_reasons"])
        self.assertIn("BLOCK_PINNED_FLASH_PRINCIPAL_ROUTE_AND_FEES_UNPROVEN",
                      x["blocking_reasons"])
    def test_immutable_git_blob_matches_production(self):
        self.assertEqual(G.git_blob(self.raw),G.SOURCE_GIT_BLOB)
    def test_reject_changed_observed_gross(self):
        raw=json.loads(self.raw)
        raw["authority"]["observed_market_gross_oracle_edge_usd_wad"]=str(300000*10**18)
        with self.assertRaisesRegex(ValueError,"exact Git blob"):
            G.assess(G.canonical(raw))
    def test_reject_changed_capture_claim(self):
        raw=json.loads(self.raw)
        raw["authority"]["nqc_capture_probability_lower_bound_wad"]=str(10**18)
        with self.assertRaisesRegex(ValueError,"exact Git blob"):
            G.assess(G.canonical(raw))
    def test_reject_same_fields_modified_whitespace(self):
        with self.assertRaisesRegex(ValueError,"exact Git blob"):
            G.assess(self.raw.rstrip()+b" ")
    def test_reject_missing_or_replaced_source(self):
        for raw in (b"",b"{}",b"[]",b"not a file"):
            with self.assertRaises(ValueError):
                G.assess(raw)
    def test_deterministic_report_hash(self):
        self.assertEqual(G.canonical(G.assess(self.raw)),G.canonical(self.report))
        cert=self.report["evidence_report_sha256"]
        other={k:v for k,v in self.report.items() if k!="evidence_report_sha256"}
        self.assertEqual(G.sha256(G.canonical(other)),cert)
    def test_no_float_money_and_negative_canary(self):
        self.assertEqual(G.money(10**18//4),"0.250000000000000000")
        self.assertEqual(G.money(-10**18//2),"-0.500000000000000000")
        x=self.report
        self.assertTrue(all(type(v) is str and v.isdigit() for k,v in x.items()
                            if k.endswith("_usd_wad") and v is not None))
    def test_external_evidence_gate_cannot_be_toggled_by_test_fixture(self):
        x=copy.deepcopy(self.report)
        x["monthly_300k_certified"]=True
        self.assertNotEqual(G.canonical(x),G.canonical(self.report))
        self.assertNotEqual(G.sha256(G.canonical(x)),
                            G.sha256(G.canonical(self.report)))

if __name__=="__main__":
    unittest.main()
