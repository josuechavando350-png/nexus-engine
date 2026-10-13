#!/usr/bin/env python3
"""Adversarial offline tests: research topology cannot self-certify D11/Shadow."""
from __future__ import annotations

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "verify_rmc011_execution_topologies_v2.py"
SPEC = importlib.util.spec_from_file_location("rmc_v2_topology", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
model = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(model)

def fixture():
    catalog = json.loads((HERE/"rmc011-execution-topologies-v2-research.json").read_text())
    scope = json.loads((HERE/"capital-census-scope.json").read_text())
    universe = json.loads((HERE/"rmc011-capital-source-universe.json").read_text())
    return catalog, scope, universe

def calc(c, s, u):
    return model.audit(c, s, u)

class TopologyContracts(unittest.TestCase):
    def test_exact_original_d11_source_gap(self):
        c,s,u=fixture()
        r=calc(c,s,u)
        self.assertEqual(r["contract"],"NQC_RMC011_TOPOLOGY_V2_DIAGNOSTIC_NO_TERMINAL")
        self.assertEqual(r["d11_missing_source_families"],["MORPHO_BLUE_FLASH_LOAN"])
        self.assertEqual(r["topology_count"],2)
        self.assertEqual(r["required_source_families"],
                         ["AAVE_V3_FLASH_LOAN","EXTERNAL_GAS_SPONSOR","MORPHO_BLUE_FLASH_LOAN"])
        self.assertEqual(r["required_venue_families"],
                         ["AAVE_V3_LIQUIDATION","CURVE_3POOL_USDT_USDC","FLUID_SUSDE_USDT"])
        self.assertEqual(r["execution_admitted"],0)
        self.assertFalse(r["rmc_closed"])
        self.assertFalse(r["p2_shadow_certified"])
        self.assertFalse(r["commercial_upgrade_authorized"])
        self.assertEqual(r["realized_nqc_pnl_usd"],"0")
    def test_registry_insertion_cannot_prove_flash_liquidity(self):
        c,s,u=fixture()
        s["required_source_families"].append("MORPHO_BLUE_FLASH_LOAN")
        u["families"].append({"id":"MORPHO_BLUE_FLASH_LOAN",
                              "status":"MODEL_ONLY",
                              "terminally_resolved":False})
        r=calc(c,s,u)
        self.assertEqual(r["d11_missing_source_families"],[])
        self.assertEqual(r["execution_admitted"],0)
        self.assertFalse(r["capital_executable_verified"])
        self.assertTrue(any(x.startswith("CAPITAL_GAS_BUILDER_COMPETITION_UNPROVEN:")
                            for x in r["blockers"]))
    def test_no_unknown_venue_masquerading_as_real_venue(self):
        c,s,u=fixture()
        r=calc(c,s,u)
        self.assertNotIn("USDTB_ACQUISITION_UNRESOLVED",r["required_venue_families"])
        self.assertEqual(r["required_unresolved_acquisition_routes"],
                        ["USDtb_ACQUISITION_USDC_TO_USDtb","USDtb_REACQUISITION_USDT_TO_USDtb"])
    def test_hashes_deterministic(self):
        c,s,u=fixture()
        self.assertEqual(calc(c,s,u),calc(deepcopy(c),deepcopy(s),deepcopy(u)))
    def test_duplicate_family_in_d11_fail_closed(self):
        c,s,u=fixture()
        s["required_source_families"].append(s["required_source_families"][0])
        with self.assertRaisesRegex(model.TopologyError,"duplicates"):
            calc(c,s,u)
    def test_d11_scope_and_universe_generation_mismatch(self):
        c,s,u=fixture()
        u["families"].pop()
        with self.assertRaisesRegex(model.TopologyError,"mismatch"):
            calc(c,s,u)
    def test_d11_universe_cannot_claim_terminal_closed(self):
        c,s,u=fixture()
        u["d11_terminal_closed"]=True
        with self.assertRaisesRegex(model.TopologyError,"not authenticated terminal"):
            calc(c,s,u)
    def test_cannot_remove_morpho_plan_to_hide_gap(self):
        c,s,u=fixture()
        c["topologies"].pop(0)
        with self.assertRaisesRegex(model.TopologyError,"two audited"):
            calc(c,s,u)
    def test_opportunity_identity_cannot_contain_flash_fee(self):
        c,s,u=fixture()
        c["opportunity_identity"]["required"].append("flash_premium")
        with self.assertRaisesRegex(model.TopologyError,"opportunity identity"):
            calc(c,s,u)
    def test_variant_cannot_use_future_competitor_outcome(self):
        c,s,u=fixture()
        c["execution_variant_identity"]["required"].append("post_event_pnl")
        with self.assertRaisesRegex(model.TopologyError,"variant identity"):
            calc(c,s,u)
    def test_morpho_callback_and_code_pin_strict(self):
        for field,value in (
            ("callback","executeOperation"),
            ("source_code_commit","0"*40),
            ("premium","HARDCODE_ZERO"),
            ("provider_address","0x"+"1"*40)):
            with self.subTest(field=field):
                c,s,u=fixture()
                c["topologies"][0]["funding"][field]=value
                with self.assertRaises(model.TopologyError):
                    calc(c,s,u)
    def test_aave_premium_must_remain_dynamic(self):
        c,s,u=fixture()
        c["topologies"][1]["funding"]["premium"]=5
        with self.assertRaisesRegex(model.TopologyError,"cannot be hardcoded"):
            calc(c,s,u)
    def test_forged_gas_or_external_guarantee(self):
        for path,value in (("eligibility","PROVEN"),("recourse","RECOURSE_ACCEPTED"),
                           ("capital_committed",True),("prepaid_by_operator",True)):
            with self.subTest(field=path):
                c,s,u=fixture()
                c["topologies"][0]["gas"][path]=value
                with self.assertRaisesRegex(model.TopologyError,"gas/recourse"):
                    calc(c,s,u)
    def test_forged_quote_or_profit_claim(self):
        for key in ("borrower_hf_under_one","exact_flash_capacity",
                    "executor_callback_fork_pass","all_route_quotes_block_pinned",
                    "gas_sponsorship_terms_accepted","competition_survival_proven",
                    "profit_net_after_full_cost_proven"):
            with self.subTest(field=key):
                c,s,u=fixture()
                c["topologies"][0]["evidence"][key]=True
                with self.assertRaisesRegex(model.TopologyError,"evidence flag"):
                    calc(c,s,u)
    def test_forged_builder_competition_calibration(self):
        c,s,u=fixture()
        c["topologies"][1]["builder"]["probability_calibrated"]=True
        with self.assertRaisesRegex(model.TopologyError,"builder/competition"):
            calc(c,s,u)
    def test_morpho_wrong_intermediate_token_fails(self):
        c,s,u=fixture()
        c["topologies"][0]["steps"][2]["input_asset"]="DAI"
        with self.assertRaisesRegex(model.TopologyError,"discontinuous route"):
            calc(c,s,u)
    def test_aave_usdtb_repayment_conversion_cannot_disappear(self):
        c,s,u=fixture()
        c["topologies"][1]["steps"].pop(3)
        with self.assertRaisesRegex(model.TopologyError,"route leg"):
            calc(c,s,u)
    def test_aave_repayment_in_usdt_not_usdtb_rejected(self):
        c,s,u=fixture()
        c["topologies"][1]["steps"][-1]["asset"]="USDT"
        with self.assertRaisesRegex(model.TopologyError,"repayment mismatch"):
            calc(c,s,u)
    def test_undeclared_swap_venue_rejected(self):
        c,s,u=fixture()
        c["topologies"][0]["steps"][2]["venue_family"]="UNISWAP_V2"
        with self.assertRaisesRegex(model.TopologyError,"invented venue"):
            calc(c,s,u)
    def test_unresolved_swap_promoted_to_quote_rejected(self):
        c,s,u=fixture()
        c["topologies"][1]["steps"][3]["kind"]="SWAP"
        c["topologies"][1]["steps"][3]["venue_family"]="UNISWAP_V3"
        with self.assertRaises(model.TopologyError):
            calc(c,s,u)
    def test_source_family_must_be_derived(self):
        c,s,u=fixture()
        c["required_source_families"].remove("MORPHO_BLUE_FLASH_LOAN")
        with self.assertRaisesRegex(model.TopologyError,"source-family universe"):
            calc(c,s,u)
    def test_missing_usdtb_venue_requirements_cannot_be_silenced(self):
        c,s,u=fixture()
        c["missing_venue_requirements"]=[]
        with self.assertRaisesRegex(model.TopologyError,"missing USDtb route"):
            calc(c,s,u)
    def test_claims_and_funding_guarantees_cannot_upgrade(self):
        for path,value in (("terminal",True),("status","D11_CLOSED")):
            with self.subTest(field=path):
                c,s,u=fixture()
                c[path]=value
                with self.assertRaises(model.TopologyError):
                    calc(c,s,u)
        c,s,u=fixture()
        c["topologies"][0]["own_capital_exposure"]["guarantees"]="OPERATOR_RECOURSE_ALLOWED"
        with self.assertRaisesRegex(model.TopologyError,"OWN_CAPITAL=0"):
            calc(c,s,u)
    def test_nonclaims_cannot_remove_zero_realized_pnl(self):
        c,s,u=fixture()
        c["nonclaims"].remove("NQC_REALIZED_PNL_ZERO")
        with self.assertRaisesRegex(model.TopologyError,"nonclaims"):
            calc(c,s,u)

if __name__=="__main__":
    unittest.main()
