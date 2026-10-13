#!/usr/bin/env python3
"""No-network adversarial tests for Curve USDT->USDC->USDtb research quotes."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import unittest

module_path=Path(__file__).resolve().parent/"quote_curve_usdtb_twohop.py"
spec=importlib.util.spec_from_file_location("nqc_curve_usdtb",module_path)
assert spec is not None and spec.loader is not None
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class CurveQuoteTests(unittest.TestCase):
    def test_uint256_decimal_precision(self):
        self.assertEqual(m.parse_number(str(2**256-1)),2**256-1)
        self.assertEqual(m.parse_number("0xffff"),65535)
        self.assertEqual(m.parse_number("42 [4.2e1]"),42)
    def test_malformed_numeric_rejected(self):
        for raw in ("","1e6","1.0","-3",str(2**256),"+4","null","NaN"):
            with self.subTest(raw=raw),self.assertRaises(m.QuoteEvidenceError):
                m.parse_number(raw)
    def test_different_coin_decimal_units(self):
        self.assertEqual(m.display(1234567,6),"1.234567")
        self.assertEqual(m.display(1234567000000000000,18),"1.234567")
        with self.assertRaises(m.QuoteEvidenceError):m.display(1,10)
    def test_address_canonicalization(self):
        self.assertEqual(m.parse_address(m.USDC),m.USDC.lower())
        with self.assertRaises(m.QuoteEvidenceError):m.parse_address("0x0")
    def test_inputs_bounded(self):
        self.assertEqual(m.SIZES,(1000,100000,472000,480000,500000))
    def test_rpc_requires_https(self):
        with self.assertRaises(m.QuoteEvidenceError):
            m.cast("http://bad.endpoint",["call","foo"])
    def test_cast_failure_not_zero_quote(self):
        with patch.object(m.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            with self.assertRaises(m.QuoteEvidenceError):
                m.cast("https://mock.example",["call","foo"])
    def test_optional_fee_missing_stays_unknown(self):
        with patch.object(m.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            self.assertIsNone(m.cast("https://mock.example",["call","foo"],may_fail=True))
    def test_unknown_quote_fails_before_returning_pnl(self):
        with patch.object(m,"read_int",return_value=0):
            with self.assertRaisesRegex(m.QuoteEvidenceError,"quote zero"):
                m.get_dy("https://mock.example",m.CURVE_USDTB_USDC,0,1,100000)
    def test_wrong_block_hash_rejected_before_route(self):
        bad={"number":hex(m.BLOCK),"hash":"0x"+"0"*64,"parentHash":m.PARENT}
        with patch.object(m.subprocess,"run",return_value=SimpleNamespace(returncode=0,stdout=json.dumps(bad))):
            with self.assertRaisesRegex(m.QuoteEvidenceError,"canonical header"):
                m.evaluate("https://mock.example")
    def test_mocked_twohop_route_quotes_never_admit_execution(self):
        header={"number":hex(m.BLOCK),"hash":m.HASH,"parentHash":m.PARENT}
        pair=[m.USDtb.lower(),m.USDC.lower()]
        def fake_cast(rpc,args,may_fail=False):
            if args[0]=="code":return "0x606060"
            if args[0]=="call" and args[2]=="coins(uint256)(address)":
                index=int(args[3])
                if args[1]==m.CURVE_3POOL:return [m.DAI,m.USDC,m.USDT][index]
                if args[1]==m.CURVE_USDTB_USDC:return pair[index]
            raise AssertionError("unexpected cast "+repr(args))
        def fake_int(rpc,address,fn,*args,may_fail=False):
            if fn.startswith("balances"):
                if address==m.CURVE_3POOL:return [10**25,10**13,10**13][args[0]]
                if address==m.CURVE_USDTB_USDC:return [10**25,10**13][args[0]]
            if fn.startswith("fee"):
                return 1000000
            if fn.startswith("get_dy"):
                if address==m.CURVE_3POOL:
                    return args[2]
                if address==m.CURVE_USDTB_USDC:
                    return args[2]*10**12
            raise AssertionError("unknown quote")
        with patch.object(m.subprocess,"run",return_value=SimpleNamespace(returncode=0,stdout=json.dumps(header))),patch.object(m,"cast",side_effect=fake_cast),patch.object(m,"read_int",side_effect=fake_int):
            result=m.evaluate("https://mock.example")
        self.assertEqual(len(result["input_size_to_quote"]),5)
        self.assertEqual(result["input_size_to_quote"][2]["usdtb_after_curve_pool_raw"],str(472000*10**18))
        self.assertFalse(result["strategy_implemented"])
        self.assertFalse(result["p2_shadow_certified"])
        self.assertFalse(result["gas_sponsorship_admitted"])
        self.assertFalse(result["commercial_score_upgrade"])
        self.assertEqual(result["realized_nqc_pnl_usd"],"0")
    def test_fake_wrong_curve_pair_rejected(self):
        header={"number":hex(m.BLOCK),"hash":m.HASH,"parentHash":m.PARENT}
        def fake_cast(rpc,args,may_fail=False):
            if args[0]=="code":return "0x606060"
            if args[0]=="call" and args[2]=="coins(uint256)(address)":
                return [m.USDC,m.USDT,m.DAI][int(args[-1])]
            raise AssertionError("should fail before quote")
        with patch.object(m.subprocess,"run",return_value=SimpleNamespace(returncode=0,stdout=json.dumps(header))),patch.object(m,"cast",side_effect=fake_cast):
            with self.assertRaisesRegex(m.QuoteEvidenceError,"canonical token"):
                m.evaluate("https://mock.example")

if __name__=="__main__":unittest.main()
