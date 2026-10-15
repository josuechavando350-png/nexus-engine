#!/usr/bin/env python3
"""Offline invariants, no network or signing; all money is integer math."""
from __future__ import annotations

from hashlib import sha1
import unittest
import svr_auction_finance_gate as a

TEST_CODE = (b"contract NqcV2OneShotAtomicLocal {\n"
             b"uint256 constant FIRST_HISTORICAL_BLOCK = 26_142_067;\n"
             b"(block.number == FIRST_HISTORICAL_BLOCK ||\n"
             b"block.number == FIRST_HISTORICAL_BLOCK + 1);\n"
             b'"HISTORICAL_LOCAL_FORK_ONLY";\n'
             b"originalParentHash;blockhash(FIRST_HISTORICAL_BLOCK - 1);\n"
             b"EXPECTED_USDC_SURPLUS = 2_273_989_378;\n"
             b"IERC20FlashMinimal(USDC).transfer(msg.sender, finalProfit);\n"
             b'"LOCAL_ONE_SHOT_TEST_NO_SPONSOR";\n}\n')
FIXTURE_BLOB = a.git_blob(TEST_CODE)

class AuctionAdmissionTests(unittest.TestCase):
    def test_git_blob_vector(self):
        self.assertEqual(a.git_blob(b"test content\n"),
                         "d670460b4b4aece5915caf5c68d12f560a9fe3e4")

    def test_source_shape_truth_and_immutability(self):
        z=a.source_truth(TEST_CODE,expected_blob=FIXTURE_BLOB)
        self.assertTrue(z["hardcoded_historical_block_guard"])
        self.assertFalse(z["production_current_block_admissible"])
        self.assertFalse(z["explicit_native_coinbase_payment_in_constructor"])

    def test_source_changed_bytes_rejected_even_if_some_anchors_present(self):
        with self.assertRaisesRegex(a.Reject,"drift"):
            a.source_truth(TEST_CODE+b"\n",expected_blob=FIXTURE_BLOB)

    def test_source_missing_anchor_fail_closed(self):
        raw=TEST_CODE.replace(b"LOCAL_ONE_SHOT_TEST_NO_SPONSOR",b"SOME_OTHER_LABEL")
        with self.assertRaisesRegex(a.Reject,"missing source"):
            a.source_truth(raw,expected_blob=a.git_blob(raw))

    def test_coinbase_adding_source_requires_independent_new_source_gate(self):
        raw=TEST_CODE+b"block.coinbase;\n"
        with self.assertRaisesRegex(a.Reject,"unexpected new direct"):
            a.source_truth(raw,expected_blob=a.git_blob(raw))

    def test_bad_source_encoding_rejected(self):
        with self.assertRaises(a.Reject):
            a.source_truth(TEST_CODE+b"\xff", expected_blob=a.git_blob(TEST_CODE+b"\xff"))

    def test_zero_length_source_rejected(self):
        with self.assertRaises(a.Reject): a.source_truth(b"")

    def test_positive_integer_gas_quote(self):
        x=a.gas_scenario(gas_used=100,gas_limit=200,
                         base_wei=1*a.GWEI,tip_wei=a.GWEI,max_fee_wei=3*a.GWEI,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=1_000_000)
        self.assertEqual(x["gas_cost_wei_at_assumed_effective_fee"],str(200*a.GWEI))
        self.assertEqual(x["minimum_EOA_upfront_gas_escrow_wei_at_max_fee"],str(600*a.GWEI))
        self.assertEqual(x["gas_cost_USDC_base_units_rounded_up"],"500")

    def test_escrow_gas_limit_times_fee_cap_not_actual_gas(self):
        z=a.gas_scenario(gas_used=50,gas_limit=100,
                         base_wei=4,tip_wei=2,max_fee_wei=10,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=1_000_000)
        self.assertEqual(z["minimum_EOA_upfront_gas_escrow_wei_at_max_fee"],"1000")
        self.assertEqual(z["gas_cost_wei_at_assumed_effective_fee"],"300")

    def test_float_bool_noninteger_and_negative_quote_fail(self):
        for invalid in [1.0,True,-1,"1"]:
            with self.subTest(invalid=invalid):
                with self.assertRaises(a.Reject):
                    a.gas_scenario(gas_used=10,gas_limit=20,base_wei=1,tip_wei=0,
                                   max_fee_wei=invalid,eth_usd_raw=2500*a.USD_PRICE_SCALE,
                                   gross_usdc_base=1_000_000)

    def test_effective_fee_above_cap_rejected(self):
        with self.assertRaises(a.Reject):
            a.gas_scenario(gas_used=100,gas_limit=200,base_wei=10,tip_wei=5,
                           max_fee_wei=14,eth_usd_raw=100*a.USD_PRICE_SCALE,
                           gross_usdc_base=100_000_000)

    def test_gas_used_over_limit_rejected(self):
        with self.assertRaises(a.Reject):
            a.gas_scenario(gas_used=200,gas_limit=100,base_wei=10,tip_wei=0,
                           max_fee_wei=20,eth_usd_raw=100*a.USD_PRICE_SCALE,
                           gross_usdc_base=100_000_000)

    def test_gas_and_priority_not_double_subtracted(self):
        d=a.gas_scenario(gas_used=100,gas_limit=200,base_wei=a.GWEI,
                         tip_wei=a.GWEI,max_fee_wei=3*a.GWEI,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=1_000_000,builder_bid_usdc_base=500)
        self.assertEqual(int(d["hypothetical_residual_USDC_base_units"]),999000)

    def test_zero_own_capital_not_proved_by_zero_value_ether_tx(self):
        d=a.gas_scenario(gas_used=300,gas_limit=500,base_wei=1*a.GWEI,
                         tip_wei=0,max_fee_wei=2*a.GWEI,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=2_000_000)
        self.assertGreater(int(d["minimum_EOA_upfront_gas_escrow_wei_at_max_fee"]),0)
        self.assertFalse(d["independent_gas_sponsor_verified"])

    def test_fee_ceiling_negative_profit_still_not_live(self):
        d=a.gas_scenario(gas_used=100_000,gas_limit=200_000,
                         base_wei=100*a.GWEI,tip_wei=20*a.GWEI,
                         max_fee_wei=130*a.GWEI,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=10_000_000)
        self.assertLess(int(d["hypothetical_residual_USDC_base_units"]),0)
        self.assertFalse(d["mainnet_inclusion_or_profit_proven"])

    def test_zero_failure_sponsor_cost_is_assumption_not_proof(self):
        d=a.gas_scenario(gas_used=100,gas_limit=200,
                         base_wei=10*a.GWEI,tip_wei=1*a.GWEI,max_fee_wei=15*a.GWEI,
                         eth_usd_raw=2500*a.USD_PRICE_SCALE,
                         gross_usdc_base=1_000_000)
        self.assertFalse(d["independent_gas_sponsor_verified"])
        self.assertFalse(d["bid_competitiveness_verified"])

    def test_historical_case_constants_exact(self):
        self.assertEqual(a.CERT["local_receipt_gas_used"],3_914_680)
        self.assertEqual(a.CERT["local_transaction_gas_limit"],5_089_056)
        self.assertEqual(a.CERT["local_surplus_USDC_base_units"],2_273_989_378)

if __name__=="__main__":
    unittest.main()
