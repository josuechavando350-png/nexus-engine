#!/usr/bin/env python3
"""Negative-only economic target tests. Numbers are source-locked, not returns."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import unittest
import first_month_commercial_hurdle as m

SOURCE=Path(__file__).resolve().parents[1]/"rmc016-production-evidence.json"

class MarketHurdleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source=json.loads(SOURCE.read_text())
    def test_source_authentic_baseline_admitted_as_research_only(self):
        out=m.audit(self.source)
        self.assertEqual(out["status"],"FIRST_MONTH_45K_55K_TARGET_NOT_PROVEN")
        self.assertEqual(out["nqc_realized_profit_usd"],"0")
        self.assertEqual(out["realizable_nexus_capacity_lower_bound_usd_wad"],"0")
        self.assertFalse(out["p2_shadow_certified"])
        self.assertFalse(out["commercial_score_upgrade"])
    def test_minimum_hurdle_45k(self):
        out=m.audit(self.source)
        self.assertEqual(out["target_range"][0]["net_target_usd"],"45000")
        self.assertEqual(out["target_range"][0]["minimum_fraction_of_original_gross_value_if_every_dollar_costless_ppm"],"325981")
    def test_maximum_hurdle_55k(self):
        out=m.audit(self.source)
        self.assertEqual(out["target_range"][1]["minimum_fraction_of_original_gross_value_if_every_dollar_costless_ppm"],"398421")
    def test_target_has_no_calibrated_competitive_capture(self):
        out=m.audit(self.source)
        self.assertTrue(all(x["observed_capture_fraction_ppm"] is None
                            for x in out["target_range"]))
        self.assertFalse(out["external_sponsorship_committed"])
    def test_gross_mutation_rejected(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["observed_market_gross_oracle_edge_usd_wad"]="2000000000000000000000000"
        with self.assertRaisesRegex(m.TargetError,"gross"):
            m.audit(doc)
    def test_false_market_win_count_rejected(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["definite_transaction_count"]=126
        with self.assertRaisesRegex(m.TargetError,"cardinality"):m.audit(doc)
    def test_false_monthly_profit_rejected(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["nqc_conservative_realizable_monthly_capacity_usd_wad"]="45000000000000000000000"
        with self.assertRaisesRegex(m.TargetError,"promote"):m.audit(doc)
    def test_forged_capture_fraction_rejected(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["nqc_capture_probability_lower_bound_wad"]="1"
        with self.assertRaisesRegex(m.TargetError,"promote"):m.audit(doc)
    def test_original_period_cannot_shift(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["window"]["end_block"]+=1
        with self.assertRaisesRegex(m.TargetError,"interval"):m.audit(doc)
    def test_source_commitment_rejected(self):
        doc=copy.deepcopy(self.source)
        doc["source_authority_file_sha256"]="0"*64
        with self.assertRaisesRegex(m.TargetError,"authority mismatch"):m.audit(doc)
    def test_scope_cannot_be_commercial(self):
        doc=copy.deepcopy(self.source)
        doc["authority"]["claim_scope"]="CERTIFIED_EARNINGS"
        with self.assertRaisesRegex(m.TargetError,"scope"):m.audit(doc)
    def test_uint_rejects_noncanonical_and_float(self):
        for value in ("01","-1","1.1"," 1",1.0,None):
            with self.subTest(value=value),self.assertRaises(m.TargetError):
                m.uint(value,"test")
    def test_zero_capture_proof_not_positive_probability(self):
        out=m.audit(self.source)
        self.assertTrue(out["no_actual_profitability_probability_calibration"])
    def test_ppm_threshold_exact_ceiling(self):
        self.assertEqual(m.ceil_div(10,3),4)
        self.assertEqual(m.ceil_div(9,3),3)
    def test_impossible_denominator_rejected(self):
        with self.assertRaises(m.TargetError):m.ceil_div(5,0)
    def test_target_values_are_hurdles_not_forecasts(self):
        out=m.audit(self.source)
        self.assertTrue(all("NOT_EXPECTED_EARNINGS" in x["claim_scope"]
                            for x in out["target_range"]))
    def test_no_own_capital_not_implied_by_flash_loan(self):
        out=m.audit(self.source)
        self.assertTrue(all(x["native_gas_sponsor_and_zero_operator_recourse_proven"] is False
                            for x in out["target_range"]))

if __name__=="__main__":unittest.main()
