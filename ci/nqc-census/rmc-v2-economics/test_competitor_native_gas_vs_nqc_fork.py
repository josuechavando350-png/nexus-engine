"""Fail-closed real-world gas provenance, cost arithmetic and false-NET tests."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
import unittest

import competitor_native_gas_vs_nqc_fork as g


class ActualNativeGasEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        def get(name):
            x=os.environ.get(name)
            if not x:
                raise AssertionError("Missing immutable artifact path "+name)
            return Path(x).read_bytes()
        cls.comp_raw=get("NQC_REAL_COMPETITOR_ZIP")
        cls.route_raw=get("NQC_FUNDED_ROUTE_ZIP")
        cls.oracle_raw=get("NQC_ORACLE_CAUSALITY_ZIP")
        cls.comp,cls.cprov=g.authenticate_competitor(cls.comp_raw)
        cls.routes,cls.rprov=g.authenticate_route(cls.route_raw)
        cls.oracles,cls.oprov=g.authenticate_oracle(cls.oracle_raw)

    def report(self,comp=None,route=None,oracle=None):
        return g.build(comp if comp is not None else self.comp,
                       route if route is not None else self.routes,
                       oracle if oracle is not None else self.oracles,
                       {"receipt":self.cprov,"route":self.rprov,
                        "oracle":self.oprov})

    def test_all_three_source_zip_bytes_have_exact_sha(self):
        for raw,digest in (
            (self.comp_raw,g.COMPETITOR_ZIP_SHA),
            (self.route_raw,g.ROUTE_ZIP_SHA),
            (self.oracle_raw,g.ORACLE_ZIP_SHA),
        ):
            self.assertEqual(sha256(raw).hexdigest(),digest)
        self.assertEqual(self.cprov["source_manifests_verified"],2)
        self.assertGreaterEqual(self.oprov["sha256_manifest_members_verified"],10)

    def test_exact_historical_receipts_and_gas_native_wei(self):
        result=self.report()
        self.assertEqual(len(result["cases"]),2)
        lookup={x["label"]:x for x in result["cases"]}
        c=lookup["WETH_COLLATERAL_USDC_DEBT"]
        self.assertEqual(c["competitor_successful_receipt_gas_used"],2740350)
        self.assertEqual(c["competitor_effective_gas_price_wei"],1086577108)
        self.assertEqual(c["competitor_total_native_gas_paid_wei"],2977601577907800)
        c=lookup["WETH_COLLATERAL_USDT_DEBT"]
        self.assertEqual(c["competitor_successful_receipt_gas_used"],591280)
        self.assertEqual(c["competitor_effective_gas_price_wei"],2504340523)
        self.assertEqual(c["competitor_total_native_gas_paid_wei"],1480766464439440)

    def test_observed_zero_eip1559_per_gas_tip_is_not_zero_private_builder_bids(self):
        doc=self.report()
        for x in doc["cases"]:
            self.assertEqual(x["competitor_priority_fee_per_gas_wei_from_receipt"],0)
            self.assertEqual(x["competitor_eip1559_priority_fee_paid_wei"],0)
            self.assertFalse(x["competitor_private_side_payments_absent_proven"])
            self.assertFalse(x["nqc_native_gas_sponsor_nonrecourse_verified"])

    def test_identical_reproducible_oracle_fee_conversion(self):
        for x in self.report()["cases"]:
            self.assertEqual(
                x["competitor_native_gas_usd_oracle_equivalent_micros"],
                g.gas_usd_micros(x["competitor_successful_receipt_gas_used"],
                                 x["competitor_effective_gas_price_wei"],
                                 x["chainlink_eth_usd_price_after_trigger_raw_8_decimals"]))
            self.assertGreater(x["competitor_native_gas_usd_oracle_equivalent_micros"],0)

    def test_usdc_route_metered_gas_not_competitor_receipt(self):
        for x in self.report()["cases"]:
            self.assertNotEqual(x["competitor_successful_receipt_gas_used"],
                                x["nqc_internal_execute_call_gasleft_delta_not_transaction_gas_used"])
            self.assertTrue(x["competitor_gas_is_not_nqc_gas"])
            self.assertFalse(x["cold_nqc_transaction_receipt_gas_used_verified"])
            self.assertFalse(x["actual_nqc_native_gas_payment_verified"])

    def test_true_historical_chainlink_prices_not_synthetic_fiat(self):
        lookup={x["label"]:x for x in self.report()["cases"]}
        self.assertEqual(
            lookup["WETH_COLLATERAL_USDC_DEBT"]["chainlink_eth_usd_price_after_trigger_raw_8_decimals"],
            254164650000)
        self.assertEqual(
            lookup["WETH_COLLATERAL_USDT_DEBT"]["chainlink_eth_usd_price_after_trigger_raw_8_decimals"],
            240967670000)
        self.assertTrue(self.report()["historical_chainlink_usd_fx_is_not_fiat_settlement"])

    def test_gas_sensitivity_not_a_tradable_opportunity(self):
        doc=self.report()
        for x in doc["cases"]:
            self.assertEqual([v["assumed_nqc_whole_transaction_gas"] for v in
                              x["hypothetical_nqc_full_tx_gas_sensitivity"]],
                             list(g.HYPOTHETICAL_WHOLE_TX_GAS))
            for scenario in x["hypothetical_nqc_full_tx_gas_sensitivity"]:
                self.assertTrue(scenario["synthetic_not_nqc_receipt_or_expected_net"])
                self.assertTrue(scenario["builder_failed_bid_sponsor_and_operating_costs_missing"])
        self.assertTrue(doc["no_nqc_cold_whole_transaction_receipt"])
        self.assertTrue(doc["no_actual_nqc_gas_or_priority_fee_payment"])
        self.assertTrue(doc["no_calibrated_mev_builder_inclusion_failed_attempt_sponsor_costs"])

    def test_strict_commercial_policy_no_pnl_or_own_cash(self):
        doc=self.report()
        for k in ("no_prospective_capture_rate","no_45000_55000_monthly_net_forecast",
                  "no_source_exhaustive_de_fi_opportunity_census","no_gas_spending_from_mxn2000",
                  "OWN_CAPITAL_ZERO_INCLUDING_NATIVE_GAS_POLICY_UNCHANGED"):
            self.assertTrue(doc[k])
        for k in ("commercial_score_upgrade","RMC_closed","P2_shadow_certified",
                  "canary_live_authorized"):
            self.assertFalse(doc[k])
        self.assertEqual(doc["nqc_realized_pnl_usd"],"0")

    def test_zip_mutations_are_rejected_before_data_access(self):
        for raw,digest in ((self.comp_raw,g.COMPETITOR_ZIP_SHA),
                           (self.oracle_raw,g.ORACLE_ZIP_SHA)):
            with self.assertRaises(g.Rejected):
                g.open_zip(raw+b"x",digest)
        with self.assertRaises(Exception):
            g.authenticate_route(self.route_raw[:-1])

    def test_competitor_real_gas_mutation_rejected(self):
        a=copy.deepcopy(self.comp)
        a["WETH_COLLATERAL_USDC_DEBT"]["gas_used"]+=1
        with self.assertRaises(g.Rejected):self.report(comp=a)

    def test_competitor_receipt_eth_fee_amount_cannot_mismatch(self):
        a=copy.deepcopy(self.comp)
        a["WETH_COLLATERAL_USDT_DEBT"]["fee_paid_native_wei"]-=1
        with self.assertRaises(g.Rejected):self.report(comp=a)

    def test_false_nqc_transaction_association_rejected(self):
        a=copy.deepcopy(self.comp)
        a["WETH_COLLATERAL_USDC_DEBT"]["is_nqc_transaction"]=True
        with self.assertRaises(g.Rejected):self.report(comp=a)

    def test_wrong_eth_price_context_rejected(self):
        o=copy.deepcopy(self.oracles)
        o["WETH_COLLATERAL_USDT_DEBT"]["eth_usd_chainlink_answer_raw_8_decimals"]+=1
        with self.assertRaises(g.Rejected):self.report(oracle=o)

    def test_hist_block_pair_mismatch_rejected(self):
        a=copy.deepcopy(self.comp)
        a["WETH_COLLATERAL_USDT_DEBT"]["block"]+=1
        with self.assertRaises(g.Rejected):self.report(comp=a)

    def test_source_requires_basefee_not_above_paid_effective_gas(self):
        a=copy.deepcopy(self.routes)
        a["WETH_COLLATERAL_USDT_DEBT"]["block_base_fee_wei"]+=1
        with self.assertRaises(g.Rejected):self.report(route=a)

    def test_missing_price_or_unsupported_market_rejected(self):
        a=copy.deepcopy(self.oracles)
        del a["WETH_COLLATERAL_USDT_DEBT"]
        with self.assertRaises(g.Rejected):self.report(oracle=a)
        b=copy.deepcopy(self.comp)
        b["FAKE_PAIR"]={"tx":"0x"+"ab"*32}
        with self.assertRaises(g.Rejected):self.report(comp=b)

    def test_no_invalid_integer_inputs_or_rounded_native_fee(self):
        for gas,price,feed in ((0,1,1),(1,0,1),(1,1,0),
                               (True,1,1),(1,"1",1)):
            with self.assertRaises(g.Rejected):
                g.gas_usd_micros(gas,price,feed)
        self.assertEqual(g.ceildiv(11,10),2)
        self.assertEqual(g.gas_usd_micros(10**9,10**9,10**8),1_000_000)

    def test_real_source_oracle_not_preinclusion_capture(self):
        doc=self.report()
        self.assertTrue(doc["source_historical_winners_chosen_with_future_knowledge"])
        self.assertFalse(doc["commercial_score_upgrade"])
        self.assertTrue(all(not x["nqc_competitive_capture_proven"] for x in doc["cases"]))

    def test_one_oracle_price_applied_to_other_block_rejected(self):
        a=copy.deepcopy(self.oracles)
        a["WETH_COLLATERAL_USDC_DEBT"]["block"]=26149038
        with self.assertRaises(g.Rejected):self.report(oracle=a)

    def test_historical_route_surplus_cannot_be_zero_or_negative(self):
        a=copy.deepcopy(self.routes)
        a["WETH_COLLATERAL_USDT_DEBT"]["surplus_asset_micros"]=0
        with self.assertRaises(g.Rejected):self.report(route=a)


if __name__=="__main__":
    unittest.main()
