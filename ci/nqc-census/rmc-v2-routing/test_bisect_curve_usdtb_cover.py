#!/usr/bin/env python3
"""Offline tests: inverse quote does not turn historical prices into execution."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
sys.path.insert(0,str(HERE))
spec=importlib.util.spec_from_file_location("curve_inverse_v2",HERE/"bisect_curve_usdtb_cover.py")
assert spec is not None and spec.loader is not None
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def q(amount):
    return amount,(amount*10**12*999)//1000

def seed():
    return {
        "contract":"NQC_RMC_V2_CURVE_USDT_TO_USDTB_TWOHOP_RESEARCH",
        "block":m.BLOCK,"block_hash":m.HASH,"parent_hash":m.PARENT,
        "scope":"EXACT_HISTORICAL_SINGLE_ARCHIVE_RPC_ETH_CALL_ONLY",
        "threepool_address":m.CURVE_3POOL.lower(),
        "usdtb_usdc_pool_address":m.CURVE_USDTB_USDC.lower(),
        "gas_sponsorship_admitted":False,"strategy_implemented":False,
        "p2_shadow_certified":False,"commercial_score_upgrade":False,
        "usdtb_pool_coins":[m.USDtb.lower(),m.USDC.lower()],
        "usdc_pool_coin_index":1,"usdtb_pool_coin_index":0,
        "input_size_to_quote":[{} for _ in range(5)],
    }

class SizeTests(unittest.TestCase):
    def test_integer_minimal_quote_succeeds_with_neighbor_proof(self):
        target=472000*10**18
        amount,usdc,out,prior=m.minimal_input(target,q)
        self.assertEqual(usdc,amount)
        self.assertTrue(prior < target <=out)
        self.assertEqual(amount,q(amount)[0])
    def test_higher_target_requires_more_usdt(self):
        first=m.minimal_input(472000*10**18,q)[0]
        second=m.minimal_input(472236*10**18,q)[0]
        self.assertGreater(second,first)
        self.assertLessEqual(second,500000*10**6)
    def test_invalid_low_not_admitted(self):
        with self.assertRaises(m.QuoteEvidenceError):
            m.minimal_input(472000*10**18,q,low=-1)
    def test_no_bracket_rejected(self):
        with self.assertRaisesRegex(m.QuoteEvidenceError,"no strictly bracketed"):
            m.minimal_input(1,q)
    def test_wrong_upstream_block_rejected(self):
        x=seed();x["block"]=m.BLOCK+1
        with self.assertRaises(m.QuoteEvidenceError):
            m.verify_seed(x)
    def test_upstream_source_cannot_claim_sponsorship(self):
        x=seed();x["gas_sponsorship_admitted"]=True
        with self.assertRaises(m.QuoteEvidenceError):
            m.verify_seed(x)
    def test_wrong_pair_indices_rejected(self):
        x=seed();x["usdc_pool_coin_index"]=0
        with self.assertRaises(m.QuoteEvidenceError):
            m.verify_seed(x)
    def test_no_float_amounts_or_noncanonical_strings(self):
        for wrong in (10,1.1,True,None,"01","1e18","-1","+1"):
            with self.subTest(value=wrong),self.assertRaises(m.QuoteEvidenceError):
                m.int_string(wrong,"amount")
    def test_two_targets_have_different_semantics(self):
        self.assertEqual(len(m.TARGETS),2)
        self.assertEqual(m.TARGETS[0][1],472000*10**18)
        self.assertEqual(m.TARGETS[1][1],472236*10**18)
    def test_prospective_profit_is_never_part_of_sizing(self):
        self.assertNotIn("capture",m.minimal_input.__doc__ or "")
        self.assertEqual(m.LOW,472000*10**6)
        self.assertEqual(m.HIGH,500000*10**6)

if __name__=="__main__":unittest.main()
