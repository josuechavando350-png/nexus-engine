"""Authentic PR723 local EOA + PR720 original Ethereum fee economic regressions."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
import unittest

import local_full_eoa_gas_headroom as m


class LocalWholeGasAndSetupTruthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        a=os.environ.get("NQC_LOCAL_ATOMIC_RECEIPT_ZIP")
        b=os.environ.get("NQC_COMPETITOR_ECONOMIC_ZIP")
        if not a or not b:
            raise AssertionError("Require both original exact immutable producer archives")
        cls.local_raw=Path(a).read_bytes()
        cls.economic_raw=Path(b).read_bytes()
        cls.authority=m.authenticate_sources(cls.local_raw,cls.economic_raw)

    def doc(self):
        return m.build(self.authority)

    def test_original_zip_digests_and_36_19_members(self):
        self.assertEqual(sha256(self.local_raw).hexdigest(),m.LOCAL_ZIP_SHA)
        self.assertEqual(sha256(self.economic_raw).hexdigest(),m.ECON_ZIP_SHA)
        self.assertEqual(self.authority["source_provenance"]["local_manifest_members_verified"],36)
        self.assertEqual(self.authority["source_provenance"]["competitor_manifest_members_verified"],19)
        self.assertTrue(self.authority["source_provenance"]["cross_source_identical_funded_route_and_oracle_bytes"])

    def test_real_anvil_receipt_gas_is_not_competitor_receipt(self):
        self.assertEqual(self.authority["full_local_gas"],917625)
        self.assertEqual(self.authority["setup_gas"],2918363)
        self.assertEqual(self.authority["usdc_payout_micros"],2273989378)
        self.assertEqual(self.authority["historical_competitor_tx_hash"],m.WINNER)
        self.assertEqual(self.authority["local_only_gas_price_wei"],696037887)
        self.assertEqual(self.authority["historical_gas_price_wei"],1086577108)

    def test_exact_microusd_ceil_of_actual_local_gas_at_historical_price(self):
        self.assertEqual(m.cost_micros(917625,1086577108,254164650000),2534201)
        self.assertEqual(m.cost_micros(3835988,1086577108,254164650000),10593829)
        a=self.doc()["economic_scenarios"][0]
        self.assertEqual(a["ethereum_gas_cost_usdc_micros_if_usdc_usd_peg_one"],2534201)
        self.assertEqual(a["historical_route_surplus_after_native_only_usdc_micros_if_peg_one"],2271455177)

    def test_one_borrower_setup_charge_cannot_be_silently_ignored(self):
        d=self.doc()
        base=[x for x in d["economic_scenarios"]
              if x["gas_price_is_historical_competitor_observation"]]
        self.assertEqual(len(base),2)
        self.assertEqual(base[0]["gas_units_billed_in_assumed_scenario"],917625)
        self.assertEqual(base[1]["gas_units_billed_in_assumed_scenario"],3835988)
        self.assertTrue(base[1]["setup_cost_allocated_to_this_one_borrower_opportunity"])
        self.assertEqual(base[1]["historical_route_surplus_after_native_only_usdc_micros_if_peg_one"],2263395549)
        self.assertFalse(d["per_borrower_setup_is_not_auto_reusable_across_positions"] is False)

    def test_synthetic_gas_price_10_and_50_gwei_reduces_headroom(self):
        d=self.doc()
        s=[x for x in d["economic_scenarios"]
           if x["setup_cost_allocated_to_this_one_borrower_opportunity"]]
        self.assertEqual([x["ethereum_gas_cost_usdc_micros_if_usdc_usd_peg_one"] for x in s],
                         [10593829,97497255,487486274])
        self.assertEqual(s[-1]["historical_route_surplus_after_native_only_usdc_micros_if_peg_one"],1786503104)
        self.assertTrue(d["synthetic_10_50gwei_are_not_future_gas_price_forecasts"])

    def test_max_inclusion_ceiling_is_maths_not_successful_builder_bid(self):
        d=self.doc()
        row=d["economic_scenarios"][0]
        exact=next(x for x in row["bid_headroom_scenarios_not_capture_or_net_profit"]
                   if x["external_financier_revenue_share_bps_assumed"]==0
                   and x["other_failure_financing_operating_cost_usdc_micros_assumed"]==0
                   and x["minimum_nqc_share_usdc_micros_required"]==100000000)
        self.assertEqual(exact["maximum_additional_inclusion_payment_usdc_micros_assumed"],2171455177)
        self.assertTrue(exact["headroom_feasible_at_assumed_costs"])
        self.assertTrue(exact["not_a_winning_builder_bid_or_available_private_orderflow"])

    def test_source_economics_cannot_promote_commercial_or_shadow(self):
        d=self.doc()
        self.assertTrue(d["predeployed_immutable_strategy_known_before_oracle_trigger_unverified"])
        self.assertTrue(d["three_setup_tx_cannot_be_assumed_to_fit_svr_single_backrun_slot"])
        self.assertFalse(d["nqc_ethereum_mainnet_receipt_or_inclusion_proven"])
        self.assertFalse(d["commercial_score_upgrade"])
        self.assertFalse(d["RMC_closed"])
        self.assertFalse(d["P2_shadow_certified"])
        self.assertFalse(d["canary_live_authorized"])
        self.assertEqual(d["nqc_realized_pnl_usd"],"0")

    def test_escrow_reverts_or_failed_attempts_not_falsely_zero(self):
        d=self.doc()
        self.assertTrue(d["failure_rate_unknown_not_zero"])
        self.assertTrue(d["sponsor_nonrecourse_contract_and_reversion_payer_unknown"])
        self.assertTrue(d["builder_access_bid_and_competitor_capture_rate_unknown"])
        self.assertTrue(d["nothing_sent_to_mainnet_and_user_mxn2000_not_spent"])
        self.assertTrue(d["OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED"])

    def test_refund_adjusted_local_gas_lower_than_internal_gas(self):
        d=self.doc()
        self.assertLess(d["nqc_historical_local_full_eoa_execute_receipt_gas_used"],1115038)
        self.assertEqual(d["nqc_historical_local_receipt_fee_paid_from_synthetic_anvil_eoa_wei"],
                         638701766058375)

    def test_oracle_same_historical_block_not_fiat_quote(self):
        d=self.doc()
        self.assertEqual(d["historical_chainlink_eth_usd_raw_8_decimals"],254164650000)
        self.assertEqual(d["onchain_competitor_effective_price_wei"],1086577108)
        self.assertTrue(d["stablecoin_one_usd_peg_not_certified"])

    def test_archive_byte_mutations_hard_fail(self):
        with self.assertRaises(m.Rejected):
            m.authenticate_sources(self.local_raw+b'X',self.economic_raw)
        with self.assertRaises(m.Rejected):
            m.authenticate_sources(self.local_raw,self.economic_raw+b'X')

    def test_forged_full_local_gas_fails_build(self):
        bad=copy.deepcopy(self.authority)
        bad["full_local_gas"]=917624
        with self.assertRaises(m.Rejected):
            m.build(bad)

    def test_forged_profit_transfer_fails_build(self):
        bad=copy.deepcopy(self.authority)
        bad["usdc_payout_micros"]=2273989379
        with self.assertRaises(m.Rejected):m.build(bad)

    def test_forged_oracle_or_gas_price_fails_build(self):
        for field in ("historical_gas_price_wei","oracle_eth_usd_raw8"):
            bad=copy.deepcopy(self.authority)
            bad[field]+=1
            with self.subTest(field=field),self.assertRaises(m.Rejected):
                m.build(bad)

    def test_synthetic_revenue_split_is_applied_after_cost_and_bid(self):
        head,allowed=m.bid_headroom(1_000_000_000,100_000_000,50_000_000,100_000_000,2000)
        self.assertEqual(head,725000000)
        self.assertTrue(allowed)

    def test_bid_budget_can_be_insufficient_and_must_fail_closed(self):
        head,allowed=m.bid_headroom(100,100,0,25,0)
        self.assertEqual(head,0)
        self.assertFalse(allowed)
        with self.assertRaises(m.Rejected):
            m.bid_headroom(100,100,-1,25,0)

    def test_extreme_cost_prohibits_made_up_positive_capture(self):
        h,yes=m.bid_headroom(200,300,0,25,0)
        self.assertEqual(h,0)
        self.assertFalse(yes)

    def test_unsigned_strict_ceil_rounding_never_overstates_net(self):
        self.assertEqual(m.ceildiv(5,2),3)
        with self.assertRaises(m.Rejected):
            m.ceildiv(1,0)
        for bad in (0,-1,True,"917625",None):
            with self.assertRaises(m.Rejected):
                m.cost_micros(bad,100,200)

    def test_no_amortization_across_unrelated_borrowers(self):
        d=self.doc()
        for x in d["economic_scenarios"]:
            self.assertFalse(x["reuse_of_borrower_specific_immutable_strategy_across_other_borrowers_proven"])
            self.assertTrue(x["three_setup_transactions_not_proven_insertable_between_oracle_and_winner"])
            self.assertEqual(len(x["bid_headroom_scenarios_not_capture_or_net_profit"]),8)

    def test_economic_reconciliation_conserves_raw_asset_units(self):
        d=self.doc()
        self.assertEqual(d["nqc_historical_local_atomic_profit_transfer_usdc_micros"],2273989378)
        self.assertEqual(d["source"]["local_source_head"],m.LOCAL_HEAD)
        self.assertEqual(d["source"]["competitor_economics_head"],m.ECON_HEAD)
        self.assertEqual(len(d["economic_scenarios"]),6)
        self.assertTrue(d["transferrable_surplus_pre_bid_not_net_profit"])


if __name__=="__main__":
    unittest.main()
