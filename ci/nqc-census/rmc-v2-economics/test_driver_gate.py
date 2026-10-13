#!/usr/bin/env python3
"""Offline adversarial tests for the retrospective economic negative preflight."""
from __future__ import annotations
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
from driver_gate import audit, uint, InvalidEvidence, WAD, ROUTES

def case():
    return json.loads((ROOT/"fixtures"/"ethereum-26184415-research-only.json").read_text())

class GateTests(unittest.TestCase):
    def test_actual_fixture_is_only_blocked_research(self):
        a=audit(case())
        self.assertEqual(a["admitted_count"],0)
        self.assertFalse(a["commercial_score_upgrade"])
        self.assertFalse(a["prospective_shadow_p2_certified"])
        self.assertFalse(a["rmc_closed"])
        self.assertEqual(a["realized_nqc_pnl_usd"],"0")
        self.assertTrue(a["hf_above_one"])
        self.assertEqual({v["topology"] for v in a["variants"]},set(ROUTES))
        self.assertTrue(all(v["status"]=="BLOCKED" and not v["execution_admitted"] for v in a["variants"]))
    def test_observed_carry_and_collateral_decomposition(self):
        d=audit(case())["driver_decomposition"]
        self.assertEqual(d["collateral_usd_base_delta"],"-1178.11750102")
        self.assertEqual(d["debt_usd_base_delta"],"49.55335624")
        self.assertEqual(d["hf_delta_bps_approx"],"-1.823032141124")
        self.assertEqual(d["collateral_loss_to_hf_one_usd_base_sensitivity_only"],"1024.03396744")
        self.assertEqual(d["debt_growth_to_hf_one_usd_base_sensitivity_only"],"942.11124821")
        self.assertTrue(d["no_etiology_or_forecast_claim"])
    def test_illustrative_fee_is_not_executable(self):
        result=audit(case())
        self.assertEqual(result["illustrative_aave_premium_bps"],5)
        self.assertEqual(result["illustrative_aave_flash_fee_raw_usdtb"],str(236*10**18))
        self.assertIsNone(result["aave_usdtb_available_raw"])
        self.assertFalse(result["morpho_executable"])
    def test_aave_must_reacquire_usdtb_after_fluid_exit(self):
        a=audit(case())["variants"]
        path=next(v["asset_sequence"] for v in a if v["topology"]=="AAVE_USDTB")
        self.assertEqual(path,["USDtb","sUSDe","USDT","USDtb"])
        self.assertTrue(any("REPAYMENT_UNQUOTED" in b for v in a for b in v["blockers"]))
    def test_morpho_flash_returns_original_usdt(self):
        a=audit(case())["variants"]
        path=next(v["asset_sequence"] for v in a if v["topology"]=="MORPHO_USDT")
        self.assertEqual(path,["USDT","USDC","USDtb","sUSDe","USDT"])
        self.assertTrue(any("MORPHO_NOMINAL_NOT_EXECUTABLE" in b for v in a for b in v["blockers"]))
    def test_deterministic_report(self):
        self.assertEqual(audit(case()),audit(case()))

    def test_reject_noncanonical_unsigned(self):
        for v in (None,1,1.0,True,"-1","01","+1","1.0","1e5",""," 1","\u0661","9" * 100):
            with self.subTest(v=v),self.assertRaises(InvalidEvidence):
                uint(v,"n")
    def test_uint256_boundary(self):
        self.assertEqual(uint(str(2**256-1),"max"),2**256-1)
        with self.assertRaises(InvalidEvidence):
            uint(str(2**256),"overflow")

    def test_reject_tampering(self):
        paths=[
            ("schema_version",2),("claim_scope","anything"),
            ("evidence_tier","LIVE"),("chain_id",137),
            ("borrower","0x"+"1"*40),("live_transactions",1),
            ("realized_nqc_pnl_usd","250"),("certifies_p2",True),
            ("certifies_rmc",True),("independent_rpc_operator_count",2),
            ("prospective_trigger_seen",True),
            ("gas_sponsor_nonrecourse_proven",True),
            ("builder_terms_proven",True),
            ("competition_survival_proven",True),
            ("external_liabilities_proven_zero",True),
        ]
        for name,value in paths:
            with self.subTest(name=name):
                data=case();data[name]=value
                with self.assertRaises(InvalidEvidence):audit(data)
    def test_reject_route_truth_forgery(self):
        for name in case()["route_evidence"]:
            with self.subTest(field=name):
                data=case();data["route_evidence"][name]=True
                with self.assertRaises(InvalidEvidence):audit(data)
    def test_reject_funding_forgery(self):
        for name,value in (
            ("morpho_usdt.executable_capital_proven",True),
            ("morpho_usdt.committed_to_nqc",True),
            ("aave_usdtb.executable_capital_proven",True),
            ("aave_usdtb.underlying_balance_raw_18_decimals","1"),
        ):
            with self.subTest(field=name):
                data=case();parent,field=name.split(".");data[parent][field]=value
                with self.assertRaises(InvalidEvidence):audit(data)
    def test_reject_wrong_block_state(self):
        mutations=[
            ("previous","block_number",26184416),
            ("current","block_number",26184199),
            ("current","block_hash","0x"+"a"*64),
            ("previous","raw_abi_certified",True),
            ("current","liquidation_threshold_display_bps",9200),
            ("current","health_factor_wad_approx","1000151530053078500"),
            ("current","total_debt_base","621732317282168"),
            ("previous","total_collateral_base","676016213519830"),
        ]
        for parent,field,value in mutations:
            with self.subTest(field=parent+"."+field):
                data=case();data[parent][field]=value
                with self.assertRaises(InvalidEvidence):audit(data)
    def test_reject_premium_outside_bps(self):
        for v in (-1,10001,1.2,True,"5"):
            with self.subTest(v=v):
                data=case();data["aave_usdtb"]["premium_total_bps"]=v
                with self.assertRaises(InvalidEvidence):audit(data)
    def test_rounded_transport_prohibited_from_raw_certification(self):
        data=case();data["current"]["raw_abi_certified"]=True
        with self.assertRaisesRegex(InvalidEvidence,"overclaim"):audit(data)
    def test_half_up_fee_formula_rounding(self):
        # fee rounded by Aave's percentageMul; reference amount is an exact multiple.
        a=audit(case())
        amount=int(a["illustrative_usdtb_cover_raw"])
        fee=(amount*5+5000)//10000
        self.assertEqual(int(a["illustrative_aave_flash_fee_raw_usdtb"]),fee)

if __name__=="__main__":
    unittest.main()
