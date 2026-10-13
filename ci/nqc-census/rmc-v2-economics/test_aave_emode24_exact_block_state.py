#!/usr/bin/env python3
"""Offline Aave liquidation ceiling adversarial regressions; no RPC traffic."""
from __future__ import annotations
from copy import deepcopy
import importlib.util
import unittest
from pathlib import Path

SCRIPT=Path(__file__).with_name("aave_emode24_exact_block_state.py")
SPEC=importlib.util.spec_from_file_location("nqc_aave_exact_state",SCRIPT)
assert SPEC is not None and SPEC.loader is not None
m=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

COL_ID=60
DEBT_ID=61
TS=1791917224

def reserve_config(fee=1000,active=True,paused=False,decimals=18):
    return decimals<<48 | int(active)<<56 | int(paused)<<60 | fee<<152

def make_fake():
    values={}
    def insert(to,method,result):
        values[(to,method)]=result
    col=[0]*15
    col[7]=COL_ID
    col[8]=int(m.SUSDE_ATOKEN,16)
    debt=[0]*15
    debt[7]=DEBT_ID
    debt[8]=int(m.USDTB_ATOKEN,16)
    debt[10]=int(m.USDTB_VTOKEN,16)
    insert(m.POOL,"getUserEMode(address)",24)
    insert(m.POOL,"getEModeCategoryCollateralConfig(uint8)",[9000,9200,10310])
    insert(m.POOL,"getEModeCategoryCollateralBitmap(uint8)",1<<COL_ID)
    insert(m.POOL,"getUserConfiguration(address)",
           (1<<(2*COL_ID+1)) | (1<<(2*DEBT_ID)))
    insert(m.POOL,"getUserAccountData(address)",
           [6_758_000*10**8,6_217_000*10**8,0,9199,8999,1000145351354931800])
    insert(m.POOL,"getConfiguration(address)@sUSDe",reserve_config())
    insert(m.POOL,"getConfiguration(address)@USDtb",reserve_config())
    insert(m.POOL,"getReserveData(address)@sUSDe",col)
    insert(m.POOL,"getReserveData(address)@USDtb",debt)
    insert(m.SUSDE_ATOKEN,"balanceOf(address)",5_000_000*m.WAD)
    insert(m.SUSDE,"balanceOf(address)",2_000_000*m.WAD)
    insert(m.USDTB_VTOKEN,"balanceOf(address)",6_200_000*m.WAD)
    insert(m.USDTB,"balanceOf(address)",2_282_160*m.WAD)
    insert(m.ORACLE,"getAssetPrice(address)@sUSDe",m.EXPECTED_PRICE_SUSDE)
    insert(m.ORACLE,"getAssetPrice(address)@USDtb",m.EXPECTED_PRICE_USDTB)
    insert(m.POOL,"getLiquidationGracePeriod(address)@sUSDe",0)
    insert(m.POOL,"getLiquidationGracePeriod(address)@USDtb",0)
    insert(m.FLUID_RESOLVER,"estimateSwapIn(address,bool,uint256,uint256)",484_800_000_000)
    return FakeCast(values)

class FakeCast:
    def __init__(self,values):
        self.values=deepcopy(values)
        self.transcript=[]
        self.calls=[]
        self.timestamp=TS
        self.fail_estimate=False
        self.second_header_change=False
        self.headers=0
    def header(self):
        self.headers+=1
        return self.timestamp+int(self.second_header_change and self.headers>1)
    def call(self,to,method,*args,n=1):
        tag=None
        if method in ("getConfiguration(address)","getReserveData(address)",
                      "getAssetPrice(address)","getLiquidationGracePeriod(address)"):
            tag="@sUSDe" if args[0].lower()==m.SUSDE else "@USDtb"
        if method=="estimateSwapIn(address,bool,uint256,uint256)" and self.fail_estimate:
            raise m.GateError("simulated Fluid estimator RPC failure")
        k=(to,method+(tag or ""))
        if k not in self.values: k=(to,method)
        if k not in self.values: raise AssertionError("unmodelled read "+str(k))
        result=deepcopy(self.values[k])
        self.calls.append(k)
        self.transcript.append({"target":to,"method":method,"args":list(map(str,args)),"result":str(result)})
        return result

class CoreMath(unittest.TestCase):
    def test_exact_aave_percent_floor(self):
        self.assertEqual(m.pct_floor(10_011,10_310),10_321)
    def test_ceiling_and_half_up_rounding(self):
        self.assertEqual(m.pct_ceil(10_001,1000),1001)
        self.assertEqual(m.pct_half_up(1,5000),1)
        self.assertEqual(m.pct_half_up(3,5000),2)
    def test_actual_stated_472k_gross(self):
        x=m.collateral_math(m.COVER,m.EXPECTED_PRICE_SUSDE,
              m.EXPECTED_PRICE_USDTB,18,18,10310,0,5_000_000*m.WAD)
        self.assertTrue(388000*m.WAD < int(x["gross_susde_raw"]) < 390000*m.WAD)
        self.assertTrue(x["at_least_388k_susde"])
    def test_1000_bps_fee_lower_than_388k(self):
        x=m.collateral_math(m.COVER,m.EXPECTED_PRICE_SUSDE,
              m.EXPECTED_PRICE_USDTB,18,18,10310,1000,5_000_000*m.WAD)
        self.assertFalse(x["at_least_388k_susde"])
        self.assertTrue(x["at_least_387k_susde"])
    def test_500_bps_still_at_least_388k(self):
        x=m.collateral_math(m.COVER,m.EXPECTED_PRICE_SUSDE,
              m.EXPECTED_PRICE_USDTB,18,18,10310,500,5_000_000*m.WAD)
        self.assertTrue(x["at_least_388k_susde"])
    def test_collateral_capped_refuses_executable_472k(self):
        x=m.collateral_math(m.COVER,m.EXPECTED_PRICE_SUSDE,
              m.EXPECTED_PRICE_USDTB,18,18,10310,1000,300_000*m.WAD)
        self.assertEqual(x["status"],"COLLATERAL_CAPPED_RECOMPUTE_DEBT")
        self.assertIsNone(x["conditional_net_susde_raw"])
    def test_zero_or_floating_point_cover_rejected(self):
        for v in (0,-1,1.2,True):
            with self.subTest(v=v),self.assertRaises(m.GateError):
                m.collateral_math(v,m.EXPECTED_PRICE_SUSDE,m.EXPECTED_PRICE_USDTB,
                                  18,18,10310,1000,5_000_000*m.WAD)
    def test_protocol_fee_rejected_when_over_bps(self):
        with self.assertRaises(m.GateError):
            m.collateral_math(m.COVER,m.EXPECTED_PRICE_SUSDE,m.EXPECTED_PRICE_USDTB,
                              18,18,10310,10001,5_000_000*m.WAD)
    def test_decode_unsigned_256_exact(self):
        n=2**256-1
        self.assertEqual(m.exact_uint(str(n)),n)
        self.assertEqual(m.abi_words("0x"+format(n,"064x"),1),[n])
    def test_malformed_abi_fails_closed(self):
        for v in ("0x","0x1234","not a number","0x"+"aa"*33):
            with self.subTest(v=v),self.assertRaises(m.GateError):
                m.abi_words(v,1)
    def test_address_padding_rejects_non_address(self):
        with self.assertRaises(m.GateError):m.addr_word(2**160)
    def test_missing_or_changed_canonical_header(self):
        good={"hash":m.BLOCK_HASH,"parentHash":m.PARENT_HASH,
              "number":hex(m.BLOCK),"timestamp":hex(TS)}
        self.assertEqual(m.canonical_header(good),TS)
        bad=deepcopy(good);bad["parentHash"]="0x"+"0"*64
        with self.assertRaises(m.GateError):m.canonical_header(bad)

class NegativeState(unittest.TestCase):
    def test_research_success_is_not_liquidation(self):
        f=make_fake();x=m.run(f)
        self.assertEqual(x["liquidation_protocol_fee_bps"],1000)
        self.assertFalse(x["collateral_seizure_sensitivity"]["at_least_388k_susde"])
        self.assertTrue(x["472000_usdtb_size_within_conditional_close_factor"])
        self.assertFalse(x["hf_below_one"])
        self.assertFalse(x["aave_actual_liquidation_admitted"])
        self.assertFalse(x["atomic_morpho_repayment_verified"])
        self.assertIsNone(x["actual_nqc_net_pnl_usd"])
        self.assertEqual(x["realized_nqc_pnl_usd"],"0")
        self.assertFalse(x["shadow_p2_certified"])
    def test_forged_lower_hf_rejected(self):
        f=make_fake()
        key=(m.POOL,"getUserAccountData(address)")
        f.values[key][-1]=m.WAD-1
        with self.assertRaisesRegex(m.GateError,"not an admissible"):
            m.run(f)
    def test_wrong_emode_or_bonus_rejected(self):
        for item in ("emode","bonus"):
            with self.subTest(item=item):
                f=make_fake()
                if item=="emode":f.values[(m.POOL,"getUserEMode(address)")]=21
                else:f.values[(m.POOL,"getEModeCategoryCollateralConfig(uint8)")][-1]=10200
                with self.assertRaises(m.GateError):m.run(f)
    def test_fee_cannot_be_out_of_range(self):
        f=make_fake()
        f.values[(m.POOL,"getConfiguration(address)@sUSDe")]=reserve_config(fee=15000)
        with self.assertRaisesRegex(m.GateError,"fee out of range"):m.run(f)
    def test_no_susde_in_emode_bitmap(self):
        f=make_fake();f.values[(m.POOL,"getEModeCategoryCollateralBitmap(uint8)")]=0
        with self.assertRaisesRegex(m.GateError,"excluded"):m.run(f)
    def test_user_must_enable_susde_collateral(self):
        f=make_fake();f.values[(m.POOL,"getUserConfiguration(address)")]=1<<(2*DEBT_ID)
        with self.assertRaisesRegex(m.GateError,"not using sUSDe"):m.run(f)
    def test_borrower_must_have_usdtb_debt_bit(self):
        f=make_fake();f.values[(m.POOL,"getUserConfiguration(address)")]=1<<(2*COL_ID+1)
        with self.assertRaisesRegex(m.GateError,"not recorded as owing"):m.run(f)
    def test_wrong_token_deployment_rejected(self):
        f=make_fake()
        f.values[(m.POOL,"getReserveData(address)@sUSDe")][8]=int(m.USDTB_ATOKEN,16)
        with self.assertRaisesRegex(m.GateError,"differs"):m.run(f)
    def test_paused_reserve_rejected(self):
        f=make_fake()
        f.values[(m.POOL,"getConfiguration(address)@USDtb")]=reserve_config(paused=True)
        with self.assertRaisesRegex(m.GateError,"paused"):m.run(f)
    def test_wrong_decimals_rejected(self):
        f=make_fake()
        f.values[(m.POOL,"getConfiguration(address)@sUSDe")]=reserve_config(decimals=6)
        with self.assertRaisesRegex(m.GateError,"precision"):m.run(f)
    def test_oracle_change_rejected(self):
        f=make_fake();f.values[(m.ORACLE,"getAssetPrice(address)@sUSDe")]+=1
        with self.assertRaisesRegex(m.GateError,"oracle price"):m.run(f)
    def test_grace_period_rejected(self):
        f=make_fake()
        f.values[(m.POOL,"getLiquidationGracePeriod(address)@sUSDe")]=TS+1
        with self.assertRaisesRegex(m.GateError,"grace"):m.run(f)
    def test_no_liquidatable_collateral_does_not_admit_profit(self):
        f=make_fake();f.values[(m.SUSDE_ATOKEN,"balanceOf(address)")]=200_000*m.WAD
        out=m.run(f)
        self.assertEqual(out["collateral_seizure_sensitivity"]["status"],
                         "COLLATERAL_CAPPED_RECOMPUTE_DEBT")
        self.assertIsNone(out["collateral_seizure_sensitivity"]["fluid_estimate_usdt_raw"])
    def test_borrower_atoken_claim_is_not_physical_cash(self):
        f=make_fake()
        f.values[(m.SUSDE,"balanceOf(address)")]=100*m.WAD
        out=m.run(f)
        claim=int(out["borrower_susde_atoken_balance_raw"])
        cash=int(out["aave_susde_underlying_cash_at_atoken_raw"])
        self.assertGreater(claim,cash)
        self.assertFalse(out["collateral_seizure_sensitivity"][
            "physical_cash_covers_hypothetical_net_susde"])
        self.assertFalse(out["aave_actual_liquidation_admitted"])

    def test_reserve_with_sufficient_physical_cash_is_still_not_liquidatable(self):
        out=m.run(make_fake())
        self.assertTrue(out["collateral_seizure_sensitivity"][
            "physical_cash_covers_hypothetical_net_susde"])
        self.assertTrue(out["aave_receive_underlying_cash_not_execution_guarantee"])
        self.assertFalse(out["aave_actual_liquidation_admitted"])

    def test_insufficient_usdtb_debt_marks_cover_unavailable(self):
        f=make_fake();f.values[(m.USDTB_VTOKEN,"balanceOf(address)")]=1_000*m.WAD
        out=m.run(f)
        self.assertFalse(out["472000_usdtb_size_within_conditional_close_factor"])
        self.assertEqual(out["collateral_seizure_sensitivity"]["fluid_estimate_status"],
                         "NOT_QUOTED_COLLATERAL_OR_CLOSE_FACTOR_LIMIT")
    def test_fluid_estimate_unavailable_not_proven_zero(self):
        f=make_fake();f.fail_estimate=True
        out=m.run(f)
        self.assertEqual(out["collateral_seizure_sensitivity"]["fluid_estimate_status"],
                         "UNKNOWN_CALL_FAILED")
        self.assertIsNone(out["collateral_seizure_sensitivity"]["fluid_estimate_usdt_raw"])
    def test_zero_quote_does_not_mean_global_no_liquidity(self):
        f=make_fake()
        f.values[(m.FLUID_RESOLVER,"estimateSwapIn(address,bool,uint256,uint256)")]=0
        out=m.run(f)
        self.assertEqual(out["collateral_seizure_sensitivity"]["fluid_estimate_status"],
                         "ZERO_NOT_PROOF_OF_GLOBAL_NO_LIQUIDITY")
    def test_block_changes_during_reads_rejected(self):
        f=make_fake();f.second_header_change=True
        with self.assertRaisesRegex(m.GateError,"header changed"):m.run(f)

if __name__=="__main__":unittest.main()
