#!/usr/bin/env python3
"""Adversarial offline tests for no-trade Aave liquidation amount sensitivity.

Synthetic fixture numbers must NOT be presented as Ethereum attested state.
"""
from __future__ import annotations
from copy import deepcopy
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("nqc_aave_seizure",
    HERE/"aave_susde_exact_seizure.py")
assert spec and spec.loader
a=importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

COLL_ID=45
DEBT_ID=58

def reserve_config(fee_bps=1000,bonus=10500,active=True,decimals=18):
    return (
        9000+(9200<<16)+(bonus<<32)+(decimals<<48)
        +((1 if active else 0)<<56)
        +(fee_bps<<152)
    )

def fake_state(fee=1000,bonus=10500):
    return {
        "schema_version":1,
        "scope":"PINNED_SINGLE_ARCHIVE_RPC_NON_LIQUIDATABLE_PRESTATE",
        "chain_id":1,"block_number":a.BLOCK,"block_hash":a.BLOCK_HASH,
        "parent_hash":a.PARENT_HASH,"aave_pool":a.POOL,
        "borrower":a.BORROWER,"s_usde":a.SUSDE,"usdtb":a.USDTB,
        "susde_atoken":a.SUSDE_ATOKEN,
        "usdtb_variable_debt_token":a.USDTB_VTOKEN,
        "source_operator_count":1,
        "user_emode":24,
        "emode24":{"ltv_bps":9000,"liq_threshold_bps":9200,
                   "liq_bonus_bps":10310,"collateral_bitmap":1<<COLL_ID},
        "susde_reserve_config":reserve_config(fee,bonus),
        "usdtb_reserve_config":reserve_config(0,10500),
        "susde_reserve_id":COLL_ID,
        "usdtb_reserve_id":DEBT_ID,
        "user_configuration_bitmap":(1<<(2*COLL_ID))|(1<<(2*DEBT_ID+1)),
        "borrower_susde_atoken_balance_raw":5_000_000*10**18,
        "borrower_usdtb_variable_debt_raw":6_200_000*10**18,
        "oracle_susde_price_base":125127009,
        "oracle_usdtb_price_base":100000000,
        "total_collateral_base":675_898_401_759_728,
        "total_debt_base":621_732_317_282_068,
        "health_factor_wad":1_000_145_351_354_931_800,
        "liquidation_authorized_at_block":False,
        "full_route_executed":False,"flash_repayment_proven":False,
        "p2_certified":False,"realized_nqc_pnl_usd":"0",
    }

def abi(values):
    return "0x"+"".join(f"{x:064x}" for x in values)

class ExactAaveSeizureTests(unittest.TestCase):
    def test_1000bps_fee_insufficient_for_388k(self):
        r=a.validate(fake_state())
        self.assertEqual(r["effective_liquidation_bonus_bps"],10310)
        self.assertEqual(r["protocol_fee_on_bonus_bps"],1000)
        self.assertFalse(r[
            "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger"])
        self.assertEqual(r["actual_price_susde_in_aave_base_units"],"125127009")
        self.assertEqual(r["gross_susde_before_protocol_fee_raw"],
                         "388910438992432081550034")
        self.assertEqual(r["hypothetical_net_susde_raw"],
                         "387741067158410219811134")
        self.assertFalse(r["is_liquidatable_at_block"])
        self.assertFalse(r["integrated_morpho_curve_aave_fluid_repay_proven"])
        self.assertEqual(r["realized_nqc_pnl_usd"],"0")
    def test_no_protocol_fee_can_exceed_388k(self):
        r=a.validate(fake_state(fee=0))
        self.assertTrue(r[
            "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger"])
        self.assertEqual(int(r["hypothetical_net_susde_raw"]),
                         int(r["gross_susde_before_protocol_fee_raw"]))
    def test_near_protocol_fee_threshold(self):
        ok=a.validate(fake_state(fee=750))
        bad=a.validate(fake_state(fee=800))
        self.assertTrue(ok[
            "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger"])
        self.assertFalse(bad[
            "388k_susde_counterfactual_attainable_given_static_state_prices_and_valid_trigger"])
        self.assertGreater(int(ok["hypothetical_net_susde_raw"]),388000*10**18)
        self.assertLess(int(bad["hypothetical_net_susde_raw"]),388000*10**18)
    def test_non_emode_susde_uses_native_bonus_not_10310(self):
        s=fake_state()
        s["emode24"]["collateral_bitmap"]=1<<(COLL_ID-1)
        result=a.validate(s)
        self.assertFalse(result["emode_applies_to_susde"])
        self.assertEqual(result["effective_liquidation_bonus_bps"],10500)
    def test_native_liquidation_protocol_fee_is_not_emode_bonus_fee(self):
        x=a.validate(fake_state(fee=500))
        y=a.validate(fake_state(fee=1000))
        self.assertEqual(x["effective_liquidation_bonus_bps"],10310)
        self.assertEqual(y["effective_liquidation_bonus_bps"],10310)
        self.assertLess(int(y["hypothetical_net_susde_raw"]),
                        int(x["hypothetical_net_susde_raw"]))
    def test_rounding_functions_truncate_and_ceil(self):
        self.assertEqual(a.percent_mul_floor(3,15000),4)
        self.assertEqual(a.percent_div_floor(7,10310),6)
        self.assertEqual(a.percent_mul_ceil(1,1),1)
        self.assertEqual(a.percent_mul_ceil(10000,0),0)
        self.assertEqual(a.percent_mul_half_up(1,5000),1)
        self.assertEqual(a.percent_mul_half_up(1,4999),0)
    def test_can_never_fake_liquidation_and_pnl_in_input(self):
        for key,value in (
            ("liquidation_authorized_at_block",True),
            ("full_route_executed",True),("flash_repayment_proven",True),
            ("p2_certified",True),("realized_nqc_pnl_usd","1"),
            ("source_operator_count",2),
        ):
            with self.subTest(key=key):
                d=fake_state();d[key]=value
                with self.assertRaises(a.EvidenceError):a.validate(d)
    def test_wrong_contract_or_block_or_emode(self):
        for key,value in (("chain_id",10),("block_number",a.BLOCK+1),
                          ("block_hash","0x"+"1"*64),
                          ("aave_pool","0x"+"1"*40),
                          ("s_usde","0x"+"2"*40),("usdtb","0x"+"3"*40),
                          ("user_emode",0)):
            with self.subTest(key=key):
                d=fake_state();d[key]=value
                with self.assertRaises(a.EvidenceError):a.validate(d)
    def test_hf_above_one_prestate_mandatory(self):
        for value in (a.WAD,a.WAD-1,0):
            d=fake_state();d["health_factor_wad"]=value
            with self.subTest(hf=value),self.assertRaises(a.EvidenceError):
                a.validate(d)
    def test_unregistered_or_changed_emode_bonus(self):
        d=fake_state();d["emode24"]["liq_bonus_bps"]=10400
        with self.assertRaises(a.EvidenceError):a.validate(d)
    def test_wrong_user_config_collateral_and_debt(self):
        for change in (1<<(2*COLL_ID),1<<(2*DEBT_ID+1)):
            d=fake_state()
            d["user_configuration_bitmap"]^=change
            with self.subTest(mask=change),self.assertRaises(a.EvidenceError):
                a.validate(d)
    def test_close_factor_rejects_overlarge_requested_cover(self):
        d=fake_state()
        d["borrower_usdtb_variable_debt_raw"]=1*10**18
        with self.assertRaisesRegex(a.EvidenceError,"debt/close factor"):
            a.validate(d)
    def test_rejects_insufficient_collateral_without_implying_full_cover(self):
        d=fake_state()
        d["borrower_susde_atoken_balance_raw"]=100*10**18
        with self.assertRaisesRegex(a.EvidenceError,"collateral caps"):
            a.validate(d)
    def test_reserve_paused_or_decimals_changed(self):
        cases=[
            {"active":False}, {"decimals":6},
        ]
        for case in cases:
            d=fake_state();d["susde_reserve_config"]=reserve_config(**case)
            with self.subTest(case=case),self.assertRaises(a.EvidenceError):
                a.validate(d)
        d=fake_state();d["susde_reserve_config"]|=1<<60
        with self.assertRaises(a.EvidenceError):a.validate(d)
    def test_uint_strict_and_config_bitfields(self):
        self.assertEqual(a.reserve_flags(reserve_config(1000))[
            "liquidation_protocol_fee_bps"],1000)
        self.assertEqual(a.reserve_flags(reserve_config(1000))[
            "liquidation_bonus_bps"],10500)
        for bad in ("1",1.0,True,-1):
            with self.subTest(bad=bad),self.assertRaises(a.EvidenceError):
                a.nat(bad,"value")
    def test_abi_uint256_exact_32_bytes(self):
        raw=abi([125127009])
        self.assertEqual(a.decode_rpc_uint(raw),125127009)
        self.assertEqual(a.abi_words(abi([1,2,3]),3),[1,2,3])
        with self.assertRaises(a.EvidenceError):
            a.decode_rpc_uint("125127009")
        with self.assertRaises(a.EvidenceError):
            a.abi_words(abi([1,2]),3)
    def test_abi_addresses_upper_bytes_rejected(self):
        raw=int(a.SUSDE,16)
        self.assertEqual(a.typed_address(raw),a.SUSDE)
        with self.assertRaises(a.EvidenceError):
            a.typed_address((1<<160)|raw)
    def test_end_to_end_fake_archive_read_reconciles_exact_fields(self):
        d=fake_state()
        coll=[0]*15;coll[0]=d["susde_reserve_config"]
        coll[7]=COLL_ID;coll[8]=int(a.SUSDE_ATOKEN,16)
        debt=[0]*15;debt[0]=d["usdtb_reserve_config"]
        debt[7]=DEBT_ID;debt[10]=int(a.USDTB_VTOKEN,16)
        account=[d["total_collateral_base"],d["total_debt_base"],0,9199,8999,
                 d["health_factor_wad"]]
        def fake_call(rpc,contract,function,*args):
            selector_and_contract=(contract,function)
            table={
                (a.POOL,"getUserAccountData(address)"):abi(account),
                (a.POOL,"getUserEMode(address)"):abi([24]),
                (a.POOL,"getEModeCategoryCollateralConfig(uint8)"):abi([9000,9200,10310]),
                (a.POOL,"getEModeCategoryCollateralBitmap(uint8)"):abi([1<<COLL_ID]),
                (a.POOL,"getConfiguration(address)"):abi([
                    d["susde_reserve_config"] if args[0]==a.SUSDE else d["usdtb_reserve_config"]
                ]),
                (a.POOL,"getReserveData(address)"):abi(coll if args[0]==a.SUSDE else debt),
                (a.POOL,"getUserConfiguration(address)"):abi([d["user_configuration_bitmap"]]),
                (a.SUSDE_ATOKEN,"balanceOf(address)"):abi([d["borrower_susde_atoken_balance_raw"]]),
                (a.USDTB_VTOKEN,"balanceOf(address)"):abi([d["borrower_usdtb_variable_debt_raw"]]),
                (a.ORACLE,"getAssetPrice(address)"):abi([
                  d["oracle_susde_price_base"] if args[0]==a.SUSDE else d["oracle_usdtb_price_base"]
                ]),
            }
            return table[selector_and_contract]
        with patch.object(a,"call",side_effect=fake_call) as calls,\
             patch.object(a,"header",return_value={
                "number":a.BLOCK,"hash":a.BLOCK_HASH,"parent":a.PARENT_HASH
             }) as headers:
            s=a.read_state("https://fake.invalid")
        self.assertEqual(headers.call_count,2)
        self.assertEqual(s["borrower_susde_atoken_balance_raw"],
                         d["borrower_susde_atoken_balance_raw"])
        self.assertEqual(s["oracle_susde_price_base"],125127009)
        self.assertFalse(a.validate(s)["is_liquidatable_at_block"])
    def test_static_token_config_and_no_future_claim(self):
        r=a.validate(fake_state())
        self.assertIsNone(r["end_to_end_net_pnl_usd"])
        self.assertFalse(r["future_liquidation_reward_attested"])
        self.assertTrue(r["amount_depends_on_real_future_state_and_trigger"])
        self.assertEqual(r["illustrative_requested_debt_cover_usdtb_raw"],str(a.COVER))
        self.assertFalse(r["p2_shadow_certified"])

if __name__=="__main__":unittest.main()
