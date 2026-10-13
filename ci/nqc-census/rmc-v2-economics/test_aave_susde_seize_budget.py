#!/usr/bin/env python3
"""RMC V2 negative cases: conditional Aave collateral is NOT a realized trade."""
import importlib.util
from pathlib import Path
import unittest
from copy import deepcopy

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location("aave_susde_budget",HERE/"aave_susde_seize_budget.py")
assert spec is not None and spec.loader is not None
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def w(items):
    return "0x"+"".join(format(int(x),"064x") for x in items)

def reserve(atoken,vtoken,fee=1000,id=32,bonus=10310,decimals=18):
    data=(fee<<152)|(1<<56)|(decimals<<48)|(bonus<<32)
    v=[0]*15
    v[0]=data;v[7]=id;v[8]=int(atoken,16);v[10]=int(vtoken,16)
    return w(v)

def fixture(fee=1000):
    return {
      "schema_version":1,"evidence_scope":"SINGLE_ARCHIVE_RPC_EXACT_BLOCK_RESEARCH_ONLY",
      "chain_id":1,"block_number":m.BLOCK,"block_hash":m.BLOCK_HASH,
      "parent_hash":m.PARENT_HASH,"research_only":True,
      "nqc_realized_pnl_usd":"0","prospective_trigger_seen":False,
      "independent_rpc_quorum":False,"gas_sponsor_admitted":False,
      "p2_certified":False,"rmc_closed":False,
      "state":{
        "sUSDe_reserve":reserve(m.ATOKEN,"0x"+"1"*40,fee,32),
        "USDtb_reserve":reserve("0x"+"2"*40,m.VTOKEN,0,53),
        "emode":"24","emode_collateral_bitmap":str(1<<32),
        "emode_collateral_config":w([9000,9200,10310]),
        "sUSDe_price_1e8":"125127009","USDtb_price_1e8":"100000000",
        "borrower_sUSDe_aToken_balance":str(5350000*10**18),
        "borrower_USDtb_vToken_balance":str(6217300*10**18),
        "borrower_account":w([6759000*10**8,6217300*10**8,0,9199,8999,
                             1000143532463232600])
      }
    }

class SeizeBudget(unittest.TestCase):
    def test_structural_and_integer_rounding(self):
        d=fixture()
        x=m.budget(d)
        self.assertEqual(x["contract"],"NQC_RMC_V2_AAVE_SUSDE_SEIZE_BUDGET_CONDITIONAL_RESEARCH")
        self.assertEqual(x["sUSDe_protocol_liquidation_fee_bps"],1000)
        self.assertEqual(x["emode_bonus_bps"],10310)
        gross=int(x["conditional_gross_collateral_susde_raw"])
        fee=int(x["conditional_protocol_fee_susde_raw"])
        net=int(x["conditional_liquidator_net_susde_raw"])
        self.assertEqual(net,gross-fee)
        self.assertGreater(gross,388000*10**18)
        self.assertLess(net,388000*10**18)
        self.assertFalse(x["net_388k_susde_possible"])
        self.assertFalse(x["liquidation_executed"])
        self.assertFalse(x["commercial_score_upgrade"])
        self.assertEqual(x["nqc_realized_pnl_usd"],"0")
    def test_zero_fee_changes_388k_boundary_only_conditionally(self):
        x=m.budget(fixture(0))
        y=m.budget(fixture(1000))
        self.assertTrue(x["net_388k_susde_possible"])
        self.assertFalse(y["net_388k_susde_possible"])
        self.assertEqual(x["conditional_protocol_fee_susde_raw"],"0")
    def test_fee_applies_to_bonus_not_total_seizure(self):
        x=m.budget(fixture(1000))
        gross=int(x["conditional_gross_collateral_susde_raw"])
        bonus=gross-gross*10000//10310
        self.assertEqual(int(x["conditional_protocol_fee_susde_raw"]),
                         m.ceil_div(bonus*1000,10000))
    def test_close_factor_not_binding_at_472k(self):
        x=m.budget(fixture())
        self.assertGreater(int(x["conditional_close_factor_max_cover_raw"]),m.COVER)
    def test_exact_token_base_units_and_no_float(self):
        self.assertEqual(m.ceil_div(3,2),2)
        self.assertEqual(m.natural(str((1<<256)-1),"uint"),(1<<256)-1)
        for v in (1,1.0,True,None,"01","-1","1e18","",str(1<<256)):
            with self.subTest(v=v),self.assertRaises(m.Reject):m.natural(v,"uint")
    def test_abi_static_precision(self):
        self.assertEqual(m.words(w([0,2**256-1]),2,"test"),[0,2**256-1])
        for s in ("0x",w([4]),w([1,2,3]),"0x"+"GG"*64):
            with self.subTest(s=s[:30]),self.assertRaises(m.Reject):
                m.words(s,2,"test")
        with self.assertRaises(m.Reject):m.addr_from_word(2**200)
    def test_immutable_canonical_source_or_terminal_tamper_rejected(self):
        for field,bad in [
            ("block_number",m.BLOCK+1),("block_hash","0x"+"0"*64),
            ("parent_hash","0x"+"1"*64),("chain_id",137),
            ("evidence_scope","LIVE_EXECUTION_AUTHORIZED"),("research_only",False),
            ("independent_rpc_quorum",True),("gas_sponsor_admitted",True),
            ("p2_certified",True),("rmc_closed",True),
            ("prospective_trigger_seen",True),("nqc_realized_pnl_usd","1")
        ]:
            with self.subTest(field=field):
                d=fixture();d[field]=bad
                with self.assertRaises(m.Reject):m.budget(d)
    def test_bad_account_health_factor_rejected(self):
        d=fixture()
        d["state"]["borrower_account"]=w([6759000*10**8,6217300*10**8,0,9199,8999,10**18-1])
        with self.assertRaisesRegex(m.Reject,"HF<1"):m.budget(d)
    def test_emode_and_bitmap_must_match(self):
        for field,bad in (("emode","0"),("emode_collateral_bitmap","0"),
                          ("emode_collateral_config",w([9000,9200,10200]))):
            with self.subTest(field=field):
                d=fixture();d["state"][field]=bad
                with self.assertRaises(m.Reject):m.budget(d)
    def test_oracle_zero_rejected(self):
        for field in ("sUSDe_price_1e8","USDtb_price_1e8"):
            d=fixture();d["state"][field]="0"
            with self.assertRaises(m.Reject):m.budget(d)
    def test_debt_smaller_than_cover_rejected(self):
        d=fixture();d["state"]["borrower_USDtb_vToken_balance"]=str(100*10**18)
        with self.assertRaises(m.Reject):m.budget(d)
    def test_collateral_atoken_mismatch_rejected(self):
        d=fixture()
        d["state"]["sUSDe_reserve"]=reserve("0x"+"f"*40,"0x"+"1"*40)
        with self.assertRaises(m.Reject):m.budget(d)
    def test_variable_debt_token_mismatch_rejected(self):
        d=fixture()
        d["state"]["USDtb_reserve"]=reserve("0x"+"2"*40,"0x"+"f"*40)
        with self.assertRaises(m.Reject):m.budget(d)
    def test_wrong_liquidation_fee_rejected(self):
        d=fixture(12000)
        with self.assertRaises(m.Reject):m.budget(d)
    def test_wrong_decimals_rejected(self):
        d=fixture()
        d["state"]["sUSDe_reserve"]=reserve(m.ATOKEN,"0x"+"1"*40,decimals=6)
        with self.assertRaises(m.Reject):m.budget(d)
    def test_source_hash_is_sensitive_and_deterministic(self):
        a=fixture();b=deepcopy(a)
        self.assertEqual(m.budget(a),m.budget(b))
        b["state"]["sUSDe_price_1e8"]="125127010"
        self.assertNotEqual(m.canonical_hash(a),m.canonical_hash(b))
    def test_sampled_fluid_is_never_integrated_pnl(self):
        r=m.budget(fixture())
        self.assertEqual(set(r["separate_fluid_fork_sizes"]),{"378000","380000","387000","388000"})
        self.assertTrue(r["no_interpolation_between_samples"])
        self.assertTrue(all(v["separate_reverted_historical_fork"]
                            for v in r["separate_fluid_fork_sizes"].values()))
        self.assertIsNone(r["economic_net_pnl_usd"])
        self.assertFalse(r["route_settled"])

if __name__=="__main__": unittest.main()
