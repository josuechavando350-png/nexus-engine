#!/usr/bin/env python3
"""Offline tests for the bounded real-block USDtb Uniswap V3 venue probe."""
from __future__ import annotations
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

PATH=Path(__file__).resolve().parent/"discover_uniswap_v3_usdtb.py"
spec=importlib.util.spec_from_file_location("usdtb_venues_v2",PATH)
assert spec is not None and spec.loader is not None
p=importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)

def header():
    return {"hash":p.BLOCK_HASH,"parentHash":p.PARENT_HASH,"number":hex(p.BLOCK)}

def synthetic_cast():
    return SimpleNamespace(returncode=0,stdout=json.dumps(header()))

class V3ProbeTests(unittest.TestCase):
    def test_fee_tiers_bounded_not_exhaustive(self):
        self.assertEqual(p.FEES,(100,500,3000,10000))
    def test_validate_block_header(self):
        p.assert_header(header())
    def test_falsified_block_identity_rejected(self):
        for field,new in (("hash","0x"+"1"*64),("parentHash","0x"+"2"*64),
                          ("number",hex(p.BLOCK+1))):
            with self.subTest(field=field):
                h=header();h[field]=new
                with self.assertRaises(p.BoundedProbeError):p.assert_header(h)
    def test_parse_uint_256_exact_integer(self):
        self.assertEqual(p.parse_uint(str(2**256-1)),2**256-1)
        self.assertEqual(p.parse_uint("0xabcdef"),0xabcdef)
        self.assertEqual(p.parse_uint("42 [42.0]"),42)
    def test_parse_uint_rejects_float_rounded_and_signs(self):
        for bad in ("", "-1", "1.0", "1e18", "+5", "NaN", str(2**256), "false"):
            with self.subTest(bad=bad):
                with self.assertRaises(p.BoundedProbeError):p.parse_uint(bad)
    def test_addresses_fail_closed(self):
        self.assertEqual(p.parse_address("0x"+"a"*40), "0x"+"a"*40)
        for bad in ("0x01","0x"+"x"*40,"", "0x"+"a"*41):
            with self.subTest(bad=bad):
                with self.assertRaises(p.BoundedProbeError):p.parse_address(bad)
    def test_zero_factory_pool_never_quotes(self):
        r=p.classify_result(p.output_row("USDC",p.USDC,500,p.ZERO))
        self.assertEqual(r["status"],"POOL_NOT_DEPLOYED_AT_FEE")
        self.assertEqual(r["quotes"],[])
        self.assertFalse(r["quoted_route_admitted"])
    def test_zero_pool_cannot_claim_quote(self):
        r=p.output_row("USDC",p.USDC,500,p.ZERO)
        r["quotes"].append({"quote_exact_input_returned":True})
        with self.assertRaises(p.BoundedProbeError):p.classify_result(r)
    def test_zero_active_liquidity_not_route(self):
        r=p.output_row("USDC",p.USDC,500,"0x"+"1"*40)
        r["pool_active_liquidity_raw"]="0"
        r["quotes"]=[]
        self.assertEqual(p.classify_result(r)["status"],
                         "DEPLOYED_BUT_ZERO_ACTIVE_LIQUIDITY")
    def test_historical_quote_not_execution(self):
        r=p.output_row("USDC",p.USDC,500,"0x"+"1"*40)
        r["pool_active_liquidity_raw"]="1000"
        r["quotes"]=[{"amount_out_usdtb_raw":"1000000000000000000",
                      "quote_exact_input_returned":True}]
        out=p.classify_result(r)
        self.assertEqual(out["status"],"HISTORICAL_QUOTER_RESPONSE_NONEXECUTABLE")
        self.assertFalse(out["capital_executable_admitted"])
    def test_fake_admission_rejected(self):
        for field in ("quoted_route_admitted","capital_executable_admitted"):
            r=p.output_row("USDC",p.USDC,500,"0x"+"1"*40)
            r["pool_active_liquidity_raw"]="1"
            r[field]=True
            with self.assertRaises(p.BoundedProbeError):p.classify_result(r)
    def test_mismatched_quote_asset_rejected(self):
        with self.assertRaises(p.BoundedProbeError):
            p.output_row("USDC",p.USDT,500,p.ZERO)
        with self.assertRaises(p.BoundedProbeError):
            p.output_row("USDtb",p.USDtb,500,p.ZERO)
    def test_invalid_fee_is_not_registered(self):
        with self.assertRaises(p.BoundedProbeError):
            p.output_row("USDC",p.USDC,200,p.ZERO)
    def test_deterministic_commitment(self):
        r={"b":1,"a":[2,3]}
        self.assertEqual(p.canonical_hash(r),p.canonical_hash({"a":[2,3],"b":1}))

    def test_mocked_rpc_one_real_quote_cannot_self_certify(self):
        pool="0x"+"1"*40
        def fake_call(rpc,args,may_fail=False):
            if args[0]=="code":return "0x"+"60"*40
            if args[0]=="call" and args[1]==p.UNISWAP_V3_FACTORY:
                return pool if args[-1]=="500" and args[-3]==p.USDC else p.ZERO
            if args[0]=="call" and args[1]==pool:
                if args[2].startswith("token0"):return p.USDC
                if args[2].startswith("token1"):return p.USDtb
                if args[2].startswith("liquidity"):return "999"
            if args[0]=="call" and args[1]==p.USDtb:return "1000000000000000000000000"
            if args[0]=="call" and args[1]==p.USDC:return "700000000000"
            if args[0]=="call" and args[1]==p.UNISWAP_V3_QUOTER:
                return "1000000000000000000000"
            raise AssertionError("unexpected mocked cast "+repr(args))
        with patch.object(p.subprocess,"run",return_value=synthetic_cast()),patch.object(p,"run_cmd",side_effect=fake_call):
            report=p.query("https://read-only.example")
        self.assertEqual(report["found_pool_count"],1)
        self.assertEqual(report["successful_quote_count"],2)
        self.assertFalse(report["exhaustive_all_dex_venues"])
        self.assertFalse(report["verified_route_profit"])
        self.assertFalse(report["p2_shadow_certified"])
        self.assertFalse(report["commercial_score_upgrade"])
        self.assertEqual(report["realized_nqc_pnl_usd"],"0")
        self.assertTrue(all(not x["quoted_route_admitted"] for x in report["pools"]))
    def test_missing_historical_rpc_is_not_empty_market(self):
        with patch.object(p.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            with self.assertRaisesRegex(p.BoundedProbeError,"canonical block unavailable"):
                p.query("https://read-only.example")
    def test_wrong_header_is_rejected_before_any_pool_call(self):
        h=header();h["hash"]="0x"+"7"*64
        with patch.object(p.subprocess,"run",return_value=SimpleNamespace(returncode=0,stdout=json.dumps(h))):
            with self.assertRaisesRegex(p.BoundedProbeError,"block hash mismatch"):
                p.query("https://read-only.example")
    def test_subprocess_failure_not_counted_as_pool_absence(self):
        with patch.object(p.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            with self.assertRaises(p.BoundedProbeError):
                p.run_cmd("https://read-only.example",["call","0x"+"a"*40,"getPool()"])
        with patch.object(p.subprocess,"run",return_value=SimpleNamespace(returncode=1,stdout="")):
            self.assertIsNone(p.run_cmd("https://read-only.example",["call","0x"+"a"*40,"quote()"],may_fail=True))
    def test_http_not_allowed(self):
        with self.assertRaises(p.BoundedProbeError):
            p.run_cmd("http://unauthorized.example",["call","x"])
        with self.assertRaises(p.BoundedProbeError):
            p.query("http://unauthorized.example")

if __name__=="__main__":
    unittest.main()
