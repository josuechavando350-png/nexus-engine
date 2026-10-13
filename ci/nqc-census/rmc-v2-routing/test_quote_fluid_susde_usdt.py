#!/usr/bin/env python3
"""No-network tests; NEVER convert Fluid quote into executable-capital proof."""
from __future__ import annotations
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("fluid_susde_census",
    HERE/"quote_fluid_susde_usdt.py")
assert spec is not None and spec.loader is not None
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def make_constants(token0=None,token1=None,dex_id=15,factory=None, liquidity=None):
    v=[0]*18
    v[0]=dex_id
    for i,a in ((1,liquidity or "0x"+"3"*40),
                (2,factory or m.FACTORY),
                (8,"0x"+"4"*40),
                (9,token0 or m.SUSDE),
                (10,token1 or m.USDT)):
        v[i]=int(a,16)
    return "0x"+"".join(format(n,"064x") for n in v)

def mock_rpc(endpoint,args,timeout=35):
    if args==["chain-id"]:return "1"
    if args[:2]==["block",str(m.BLOCK)]:
        import json
        return json.dumps({"number":hex(m.BLOCK),"hash":m.HASH,"parentHash":m.PARENT})
    raise AssertionError(f"unexpected unpinned RPC {args!r}")

def mock_on_block(endpoint,args):
    if args[0]=="code":return "0x"+"ab"*30
    if args[:3]==["call",m.POOL,"constantsView()"]:
        return make_constants()
    if args[:3]==["call",m.POOL,"DEX_ID()(uint256)"]:
        return "15"
    if len(args)>=4 and args[0]=="call" and args[2]=="balanceOf(address)(uint256)":
        if args[1]==m.USDT and args[3]==m.MORPHO:return "65666477002958"
        return "10000000000000000000000"
    if len(args)>=6 and args[0]=="call" and args[1]==m.RESOLVER and args[2].startswith("estimateSwapIn"):
        if args[4] != 'true': raise AssertionError('only sUSDe->USDT direction admitted')
        value=int(args[5])
        return str(value//10**12)
    raise AssertionError(f"unexpected call {args!r}")

class FluidCensusTests(unittest.TestCase):
    def test_exact_abi_metadata_decode(self):
        v=m.decode_fluid_constant_views(make_constants())
        self.assertEqual(v["dex_id"],15)
        self.assertEqual(v["factory"],m.FACTORY)
        self.assertEqual(v["token0"],m.SUSDE)
        self.assertEqual(v["token1"],m.USDT)
        m.verify_deployment(v)
    def test_token_order_cannot_be_swapped(self):
        for t0,t1 in ((m.USDT,m.SUSDE),(m.SUSDE,m.SUSDE)):
            with self.subTest(t0=t0):
                with self.assertRaisesRegex(m.EvidenceError,"tokens reversed"):
                    m.verify_deployment(m.decode_fluid_constant_views(
                        make_constants(token0=t0,token1=t1)))
    def test_reject_wrong_pool_factory_and_dex_id(self):
        for cfg in ({"dex_id":0},{"dex_id":14},{"dex_id":16},
                    {"factory":"0x"+"2"*40},{"liquidity":"0x"+"0"*40}):
            with self.subTest(cfg=cfg):
                with self.assertRaises(m.EvidenceError):
                    m.verify_deployment(m.decode_fluid_constant_views(make_constants(**cfg)))
    def test_reject_nonstatic_or_short_abi(self):
        for value in (None,"0x","0x"+"0"*64,
                      "0x"+"0"*64*17,"0x"+"0"*64*19,
                      "0x"+"gg"*576):
            with self.subTest(v=str(value)[:30]),self.assertRaises(m.EvidenceError):
                m.decode_fluid_constant_views(value)
    def test_address_word_padding_must_be_zero(self):
        with self.assertRaisesRegex(m.EvidenceError,"nonzero high bytes"):
            m.address_from_word("f"*64)
    def test_uint256_canonical_and_full_precision(self):
        self.assertEqual(m.uint_from_rpc(str(2**256-1)),2**256-1)
        self.assertEqual(m.uint_from_rpc("0x"+format(2**256-1,"x")),2**256-1)
        self.assertEqual(m.uint_from_rpc("15 [1.5e1]"),15)
    def test_uint256_malformed_rejected(self):
        for v in (None,1,True,"-1","01","1.0","1e5","+1",
                  "0Xff","0xzz","","0x"+("f"*65)):
            with self.subTest(v=v),self.assertRaises(m.EvidenceError):
                m.uint_from_rpc(v)
    def test_https_only_and_error_not_cast_as_zero(self):
        with self.assertRaises(m.EvidenceError):
            m.rpc("http://not-allowed.invalid",["call",m.POOL,"DEX_ID()"])
        with patch.object(m.subprocess,"run",side_effect=OSError("offline")):
            with self.assertRaisesRegex(m.EvidenceError,"timed out"):
                m.rpc("https://provider.invalid",["call",m.POOL,"DEX_ID()"])
    def test_bad_chain_or_block_hash_rejected(self):
        with patch.object(m,"rpc",return_value="2"):
            with self.assertRaises(m.EvidenceError):
                m.header("https://fake.invalid")
        import json
        bad={"number":hex(m.BLOCK),"hash":"0x"+"0"*64,"parentHash":m.PARENT}
        with patch.object(m,"rpc",return_value=json.dumps(bad)):
            with self.assertRaisesRegex(m.EvidenceError,"canonical block"):
                m.header("https://fake.invalid")
    def test_unavailable_estimate_never_equals_zero_liquidity(self):
        with patch.object(m,"on_block",side_effect=m.EvidenceError("RPC no archive")):
            x=m.estimate("https://fake.invalid",10**18)
        self.assertEqual(x["status"],"ESTIMATOR_UNAVAILABLE_OR_REVERT")
        self.assertIsNone(x["output_usdt_raw"])
        self.assertFalse(x["zero_meaning_full_route_unavailable"])
    def test_zero_estimate_is_not_executable_capacity_proof(self):
        with patch.object(m,"on_block",return_value="0"):
            x=m.estimate("https://fake.invalid",10**18)
        self.assertEqual(x["status"],"QUOTE_ZERO_NOT_CAPACITY")
        self.assertEqual(x["output_usdt_raw"],"0")
        self.assertFalse(x["zero_meaning_full_route_unavailable"])
    def test_positive_estimate_keeps_research_tier(self):
        with patch.object(m,"on_block",return_value="1000000"):
            x=m.estimate("https://fake.invalid",10**18)
        self.assertEqual(x["status"],"QUOTE_RETURNED")
        self.assertNotIn("execution_admitted",x)
    def test_size_outside_bounds_rejected(self):
        for amt in (0,-1,1.0,True,400001*10**18):
            with self.subTest(amt=amt),self.assertRaises(m.EvidenceError):
                m.estimate("https://fake.invalid",amt)
    def test_synthetic_full_census_never_proves_execution(self):
        with patch.object(m,"rpc",side_effect=mock_rpc) as rp,\
             patch.object(m,"on_block",side_effect=mock_on_block) as ob:
            out=m.evaluate("https://fake.invalid")
        self.assertEqual(rp.call_count,3)
        self.assertEqual(out["block"],m.BLOCK)
        self.assertEqual(out["fluid_dex_constants"]["dex_id"],15)
        self.assertEqual(len(out["estimator_quotes"]),len(m.SIZES))
        self.assertEqual(out["quote_positive_count"],len(m.SIZES))
        self.assertFalse(out["actual_swap_executed"])
        self.assertFalse(out["s_usde_seized"])
        self.assertFalse(out["external_gas_sponsor_admitted"])
        self.assertFalse(out["shadow_p2_certified"])
        self.assertFalse(out["rmc_closed"])
        self.assertFalse(out["commercial_score_upgrade"])
        self.assertEqual(out["realized_nqc_pnl_usd"],"0")
    def test_morpho_snapshot_difference_blocks_research(self):
        def broken(endpoint,args):
            x=mock_on_block(endpoint,args)
            if args==["call",m.USDT,"balanceOf(address)(uint256)",m.MORPHO]:
                return "1"
            return x
        with patch.object(m,"rpc",side_effect=mock_rpc),\
             patch.object(m,"on_block",side_effect=broken):
            with self.assertRaisesRegex(m.EvidenceError,"Morpho USDT balance mismatch"):
                m.evaluate("https://fake.invalid")
    def test_reorg_after_quotes_rejected(self):
        import json
        calls=0
        def changed(endpoint,args,timeout=35):
            nonlocal calls
            if args[0]=="block":
                calls+=1
                if calls==2:
                    return json.dumps({"number":hex(m.BLOCK),
                        "hash":"0x"+"3"*64,"parentHash":m.PARENT})
            return mock_rpc(endpoint,args,timeout)
        with patch.object(m,"rpc",side_effect=changed),\
             patch.object(m,"on_block",side_effect=mock_on_block):
            with self.assertRaisesRegex(m.EvidenceError,"canonical block"):
                m.evaluate("https://fake.invalid")
    def test_no_float_math_and_nonclaims_are_explicit(self):
        from pathlib import Path
        s=(HERE/"quote_fluid_susde_usdt.py").read_text()
        self.assertNotIn("float(",s)
        self.assertIn('"end_to_end_net_pnl_usd":None',s)
        self.assertIn('"quote_positive_count"',s)
        self.assertIn('"raw_erc20_balances_not_total_liquidity"',s)

if __name__=="__main__":
    unittest.main()
