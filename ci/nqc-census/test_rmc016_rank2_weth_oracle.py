#!/usr/bin/env python3
"""Adversarial non-authoritative historical WETH rank-2 price verification."""
import copy
import unittest

import rmc016_rank2_weth_oracle as m
from test_rmc016_weth_cashflow_audit import corpus


def fixtures():
    legs, receipts, _ = corpus()
    # The historical rank-two WETH winner is not one of the prior two priced tx.
    replacement = legs[2]
    previous = replacement["transaction_hash"]
    del receipts[previous]
    replacement["transaction_hash"] = m.TX
    replacement["block_number"] = m.BLOCK
    replacement["block_hash"] = "0x" + "d" * 64
    replacement["debt_to_cover_raw"] = str(m.DEBT_WEI)
    replacement["collateral_liquidated_raw"] = str(m.COLLATERAL_WEI)
    receipts[m.TX] = {
        "block_number": m.BLOCK,
        "block_hash": "0x" + "d" * 64,
        "total_gas_paid_wei": str(m.HISTORICAL_WINNER_GAS_WEI),
    }
    return legs, receipts


def observation(chosen):
    return {
        "status": "RMC016_DUAL_OPERATOR_PREBLOCK_GAS_REFERENCE_PASS",
        "two_provider_consensus": True,
        "offset": m.SORTED_WINNER_BLOCK_OFFSET, "count": 1,
        "requested_blocks": [m.BLOCK], "verified_blocks": 1,
        "exact_pre_tx_state_proven": False,
        "nexus_net_profit_proven": False,
        "real_market_census_closed": False,
        "prices": [{
            "tx_block": m.BLOCK,
            "winner_transaction_count": 1,
            "winner_gas_wei": str(m.HISTORICAL_WINNER_GAS_WEI),
            "pre_transaction_price_certified": False,
            "preblock": {
                "block": m.BLOCK-1, "hash": "0x" + "c"*64,
                "oracle_usd_base_1e8": "269012345678"},
            "block_end": {
                "block": m.BLOCK, "hash": chosen["block_hash"],
                "oracle_usd_base_1e8": "269112345678"},
        }],
    }


def sample(chosen):
    blocks=list(range(m.BLOCK-200,m.BLOCK-120))+[m.BLOCK]+list(range(m.BLOCK+1,m.BLOCK+43))
    assert len(blocks)==123 and blocks[80]==m.BLOCK
    source={m.BLOCK:[{"transaction_hash":m.TX,
                      "block_hash":chosen["block_hash"],
                      "total_gas_paid_wei":str(m.HISTORICAL_WINNER_GAS_WEI)}]}
    return blocks, source


class Rank2HistoricalOracleTests(unittest.TestCase):
    def test_exact_nine_and_historical_second_rank(self):
        legs,receipts=fixtures()
        rows,chosen=m.ranked_weth_rows(legs,receipts)
        self.assertEqual(len(rows),9)
        self.assertEqual(rows[1],chosen)
        self.assertEqual(chosen["transaction_hash"],m.TX)
        self.assertEqual(chosen["historical_after_competitor_gas_wei"],str(m.AFTER_GAS_WEI))
        self.assertEqual(chosen["conditional_after_hypothetical_5bps_wei"],str(m.AFTER_ILLUSTRATIVE_5BPS_WEI))
        self.assertTrue(int(chosen["conditional_after_hypothetical_5bps_wei"])>0)

    def test_report_never_claims_nexus_pnl_or_intratransaction_prestate(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        report=m.validate_price(chosen,blocks,source,observation(chosen))
        self.assertTrue(report["two_independent_operator_price_consensus"])
        self.assertTrue(report["previous_block_price_is_not_exact_pretransaction_price"])
        self.assertFalse(report["nexus_gas_financing_proven"])
        self.assertFalse(report["nexus_capture_proven"])
        self.assertFalse(report["nexus_positive_net_pnl_proven"])
        self.assertFalse(report["real_market_census_closed"])
        self.assertFalse(report["flash_fee_is_not_an_authenticated_capital_quote"] is False)

    def test_deterministic_order(self):
        legs,receipts=fixtures()
        x=m.ranked_weth_rows(legs,receipts)
        y=m.ranked_weth_rows(list(reversed(legs)),receipts)
        self.assertEqual(x,y)

    def test_missing_historical_weth_ledger_row_denied(self):
        legs,receipts=fixtures()
        legs[2]["debt_asset"]="0x"+"0"*40
        with self.assertRaisesRegex(ValueError,"nine"):
            m.ranked_weth_rows(legs,receipts)

    def test_forged_rank_two_debt_denied(self):
        legs,receipts=fixtures()
        legs[2]["debt_to_cover_raw"]=str(m.DEBT_WEI+1)
        with self.assertRaisesRegex(ValueError,"quantity/identity"):
            m.ranked_weth_rows(legs,receipts)

    def test_other_large_historical_margin_changes_rank(self):
        legs,receipts=fixtures()
        legs[3]["collateral_liquidated_raw"]=str(100*m.DEBT_WEI)
        with self.assertRaises(ValueError):
            m.ranked_weth_rows(legs,receipts)

    def test_missing_full_receipt_denied(self):
        legs,receipts=fixtures()
        del receipts[m.TX]
        with self.assertRaises(ValueError):
            m.ranked_weth_rows(legs,receipts)

    def test_inconsistent_event_block_denied(self):
        legs,receipts=fixtures()
        legs[2]["block_number"]+=1
        with self.assertRaisesRegex(ValueError,"not bound"):
            m.ranked_weth_rows(legs,receipts)

    def test_123_blocks_wrong_offset_denied(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        blocks[80]=m.BLOCK-1
        with self.assertRaisesRegex(ValueError,"offset"):
            m.validate_price(chosen,blocks,source,observation(chosen))

    def test_second_provider_disagreement_denied(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        o=observation(chosen)
        o["two_provider_consensus"]=False
        with self.assertRaises(ValueError):
            m.validate_price(chosen,blocks,source,o)

    def test_wrong_block_end_hash_denied(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        o=observation(chosen)
        o["prices"][0]["block_end"]["hash"]="0x"+"b"*64
        with self.assertRaises(ValueError):
            m.validate_price(chosen,blocks,source,o)

    def test_wrong_price_oracle_state_denied(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        for raw in ("0","-1","2690.1",269000000000):
            o=observation(chosen)
            o["prices"][0]["preblock"]["oracle_usd_base_1e8"]=raw
            with self.assertRaises(ValueError):
                m.validate_price(chosen,blocks,source,o)

    def test_no_promotion_of_pretransaction_price(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        o=observation(chosen)
        o["prices"][0]["pre_transaction_price_certified"]=True
        with self.assertRaises(ValueError):
            m.validate_price(chosen,blocks,source,o)

    def test_duplicate_or_wrong_transaction_in_block_denied(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        source[m.BLOCK].append(source[m.BLOCK][0])
        with self.assertRaises(ValueError):
            m.validate_price(chosen,blocks,source,observation(chosen))

    def test_cashflow_reference_integer_floor_not_pnl(self):
        legs,receipts=fixtures()
        _,chosen=m.ranked_weth_rows(legs,receipts)
        blocks,source=sample(chosen)
        r=m.validate_price(chosen,blocks,source,observation(chosen))
        expected=(m.AFTER_ILLUSTRATIVE_5BPS_WEI*269012345678)//10**8
        self.assertEqual(int(r["conditional_remaining_usd_wad_preblock_reference"]),expected)


if __name__=="__main__":
    unittest.main()
