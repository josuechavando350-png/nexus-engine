#!/usr/bin/env python3
"""Offline adversarial tests for the bounded historical Curve inverse quote.
These tests are synthetic fixtures; they never prove swap execution or P&L.
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest import mock
from types import SimpleNamespace

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location(
    "nqc_curve_usdtb_inverse", HERE / "bisect_curve_usdtb_cover.py"
)
assert spec is not None and spec.loader is not None
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

SIZES = (1_000, 100_000, 472_000, 480_000, 500_000)
OFFSET = 461 * m.USDtb_UNIT

def deterministic_curve_quote(raw_input):
    # Only a mock: every USDT raw unit maps to 1e12 USDtb raw minus a
    # fixed absolute fee. The original blockchain quote is NOT this linear.
    return raw_input, raw_input * 10**12 - OFFSET

def synthetic_seed():
    return {
        "contract": "NQC_RMC_V2_CURVE_USDT_TO_USDTB_TWOHOP_RESEARCH",
        "block": m.BLOCK,
        "block_hash": m.HASH,
        "parent_hash": m.PARENT,
        "scope": "EXACT_HISTORICAL_SINGLE_ARCHIVE_RPC_ETH_CALL_ONLY",
        "threepool_address": m.CURVE_3POOL.lower(),
        "usdtb_usdc_pool_address": m.CURVE_USDTB_USDC.lower(),
        "usdtb_pool_coins": [m.USDC.lower(), m.USDtb.lower()],
        "usdc_pool_coin_index": 0,
        "usdtb_pool_coin_index": 1,
        "observed_usdtb_nominal_pool_balance_display": "11370000",
        "input_size_to_quote": [
            {
                "input_usdt_raw": str(v * m.USDT_UNIT),
                "usdc_after_3pool_raw": str(deterministic_curve_quote(v*m.USDT_UNIT)[0]),
                "usdtb_after_curve_pool_raw": str(deterministic_curve_quote(v*m.USDT_UNIT)[1]),
                "actual_swap_executed": False,
                "liquidation_executed": False,
                "full_input_consumed_onchain_proven": False,
            } for v in SIZES
        ],
        "gas_sponsorship_admitted": False,
        "strategy_implemented": False,
        "p2_shadow_certified": False,
        "commercial_score_upgrade": False,
    }

class ExactInverseQuoteTests(unittest.TestCase):
    def test_seed_rejects_no_bad_state_and_returns_token_indices(self):
        self.assertEqual(m.verify_seed(synthetic_seed()), (0, 1))

    def test_inverse_minimal_with_one_raw_usdt_unit_left_neighbor(self):
        minimum, usdc, result, previous = m.minimal_input(
            472_000*m.USDtb_UNIT, deterministic_curve_quote)
        self.assertEqual(minimum, 472_461*m.USDT_UNIT)
        self.assertEqual(usdc, minimum)
        self.assertEqual(result, 472_000*m.USDtb_UNIT)
        self.assertEqual(previous, result - 10**12)

    def test_premium_reacquisition_increases_usdt_input(self):
        first = m.minimal_input(472_000*m.USDtb_UNIT, deterministic_curve_quote)[0]
        second = m.minimal_input(472_236*m.USDtb_UNIT, deterministic_curve_quote)[0]
        self.assertEqual(second-first, 236*m.USDT_UNIT)

    def test_binary_search_integer_rounding_plateau(self):
        def plateau(x):
            return x, (x//3)*3*10**12-OFFSET
        needed, _, output, prior = m.minimal_input(472_000*m.USDtb_UNIT, plateau)
        self.assertEqual(needed%3, 0)
        self.assertLess(prior, 472_000*m.USDtb_UNIT)
        self.assertGreaterEqual(output, 472_000*m.USDtb_UNIT)

    def test_search_rejects_unbracketed_target(self):
        for target in (1, 600_000*m.USDtb_UNIT):
            with self.subTest(target=target), self.assertRaises(m.QuoteEvidenceError):
                m.minimal_input(target,deterministic_curve_quote)

    def test_search_rejects_non_integer_and_bad_bounds(self):
        cases = [
            (None, m.LOW, m.HIGH),
            (1.5, m.LOW, m.HIGH),
            (472_000*m.USDtb_UNIT, m.HIGH, m.LOW),
            (472_000*m.USDtb_UNIT, 0, m.HIGH),
            (472_000*m.USDtb_UNIT, m.LOW, m.LOW),
        ]
        for t,l,h in cases:
            with self.subTest(t=t,l=l,h=h),self.assertRaises(m.QuoteEvidenceError):
                m.minimal_input(t,deterministic_curve_quote,l,h)

    def test_search_rejects_malicious_neighbor(self):
        target=472_000*m.USDtb_UNIT
        def malicious(x):
            if x==472_461*m.USDT_UNIT-1:
                return x,target+1
            return deterministic_curve_quote(x)
        with self.assertRaisesRegex(m.QuoteEvidenceError,"nonminimal"):
            m.minimal_input(target,malicious)

    def test_source_header_and_pools_are_immutable(self):
        pairs=[
            ("block",m.BLOCK+1),
            ("block_hash","0x"+"1"*64),
            ("parent_hash","0x"+"2"*64),
            ("threepool_address","0x"+"3"*40),
            ("usdtb_usdc_pool_address","0x"+"4"*40),
            ("scope","EXECUTION_CERTIFIED"),
        ]
        for key,value in pairs:
            with self.subTest(key=key):
                s=synthetic_seed();s[key]=value
                with self.assertRaises(m.QuoteEvidenceError):m.verify_seed(s)

    def test_rejects_invalid_coin_indices_even_before_indexing(self):
        for field,value in (("usdc_pool_coin_index",-1),
                            ("usdc_pool_coin_index",3),
                            ("usdtb_pool_coin_index",2),
                            ("usdc_pool_coin_index",True),
                            ("usdc_pool_coin_index",1)):
            with self.subTest(field=field,value=value):
                s=synthetic_seed();s[field]=value
                with self.assertRaisesRegex(m.QuoteEvidenceError,"coin indices corrupted"):
                    m.verify_seed(s)

    def test_rejects_tampered_input_size_order(self):
        for v in ("01","1e5","-1",None,"12.3"):
            with self.subTest(v=v):
                with self.assertRaises(m.QuoteEvidenceError):
                    m.int_string(v,"uint")
        s=synthetic_seed()
        s["input_size_to_quote"][3]["input_usdt_raw"]="480000000001"
        with self.assertRaisesRegex(m.QuoteEvidenceError,"input series"):
            m.verify_seed(s)

    def test_rejects_false_quote_monotonicity_and_zero_output(self):
        for raw in ("0",synthetic_seed()["input_size_to_quote"][1]["usdtb_after_curve_pool_raw"]):
            s=synthetic_seed()
            s["input_size_to_quote"][2]["usdtb_after_curve_pool_raw"]=raw
            with self.subTest(raw=raw),self.assertRaisesRegex(m.QuoteEvidenceError,"strictly increase"):
                m.verify_seed(s)

    def test_rejects_claimed_swap_execution_in_seed(self):
        for rowfield in ("actual_swap_executed",
                         "liquidation_executed",
                         "full_input_consumed_onchain_proven"):
            s=synthetic_seed()
            s["input_size_to_quote"][0][rowfield]=True
            with self.subTest(field=rowfield),self.assertRaisesRegex(
                m.QuoteEvidenceError,"cannot claim actual execution"):
                m.verify_seed(s)

    def test_rejects_fake_terminal_or_sponsor_claims(self):
        for flag in ("gas_sponsorship_admitted","strategy_implemented",
                     "p2_shadow_certified","commercial_score_upgrade"):
            s=synthetic_seed();s[flag]=True
            with self.subTest(flag=flag), self.assertRaises(m.QuoteEvidenceError):
                m.verify_seed(s)

    def test_real_evaluate_identity_and_exact_neighbor_are_checked(self):
        valid = {"hash":m.HASH,"parentHash":m.PARENT,"number":hex(m.BLOCK)}
        reply = SimpleNamespace(returncode=0,stdout=json.dumps(valid))
        with mock.patch.object(m.subprocess,"run",return_value=reply) as rpc,             mock.patch.object(m,"output_amount",side_effect=lambda endpoint,dx,i,j: deterministic_curve_quote(dx)):
            result=m.evaluate("https://synthetic.invalid",synthetic_seed())
        self.assertEqual(rpc.call_count,2)
        self.assertEqual(len(result["minimum_usdt_quotes"]),2)
        self.assertEqual(result["minimum_usdt_quotes"][0]["required_usdt_display"],"472461")
        self.assertEqual(result["minimum_usdt_quotes"][1]["required_usdt_display"],"472697")
        self.assertFalse(result["global_quote_monotonicity_certified"])
        self.assertFalse(result["external_gas_nonrecourse_admitted"])
        self.assertFalse(result["route_executed_on_fork"])
        self.assertFalse(result["commercial_score_upgrade"])
        self.assertEqual(result["nqc_realized_pnl_usd"],"0")

    def test_rejects_header_reorg_at_completion(self):
        valid = {"hash":m.HASH,"parentHash":m.PARENT,"number":hex(m.BLOCK)}
        wrong = dict(valid,hash="0x"+"0"*64)
        replies = [
            SimpleNamespace(returncode=0,stdout=json.dumps(valid)),
            SimpleNamespace(returncode=0,stdout=json.dumps(wrong))
        ]
        with mock.patch.object(m.subprocess,"run",side_effect=replies),             mock.patch.object(m,"output_amount",side_effect=lambda endpoint,dx,i,j: deterministic_curve_quote(dx)):
            with self.assertRaisesRegex(m.QuoteEvidenceError,"changed during"):
                m.evaluate("https://synthetic.invalid",synthetic_seed())

    def test_rejects_quote_change_at_same_block(self):
        valid = {"hash":m.HASH,"parentHash":m.PARENT,"number":hex(m.BLOCK)}
        with mock.patch.object(m.subprocess,"run",return_value=SimpleNamespace(
                returncode=0,stdout=json.dumps(valid))),             mock.patch.object(m,"output_amount",side_effect=lambda endpoint,dx,i,j: (
                 dx,deterministic_curve_quote(dx)[1]+10**12)):
            with self.assertRaisesRegex(m.QuoteEvidenceError,"upstream quote changed"):
                m.evaluate("https://synthetic.invalid",synthetic_seed())

if __name__ == "__main__":
    unittest.main()
