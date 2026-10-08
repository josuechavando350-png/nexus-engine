#!/usr/bin/env python3
"""Adversarial offline tests: negative RMC012 claims must not become executable."""
from __future__ import annotations
from collections import Counter
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path
import rmc012_execution_blocker_root_cause as m


def fixtures():
    tokens=[f"0x{i:040x}" for i in range(1,44)]
    actions=[];promotions=[]
    for i in range(m.EXPECTED_ACTIONABLE):
        debt=tokens[i % 27]
        collateral=tokens[10+i % 33]
        tid=f"{i+1:064x}"
        actions.append({"status":"ADMITTED","candidate_id":tid,
                        "debt_asset":debt,"collateral_asset":collateral,
                        "oracle_collateral_value_base_wad":"110" if i % 5 else "90",
                        "oracle_repayment_value_base_wad":"100"})
        promotions.append({"actionable_candidate_id":tid,"capital_status":"REJECTED",
                           "rejection_reason":"EXECUTION_BLOCKED",
                           "funding_scope":"PRINCIPAL_AND_FLASH_SETTLEMENT_ONLY_GAS_UNCERTIFIED",
                           "gas_funding_certified":False,"allocations":[]})
    for i in range(m.EXPECTED_REJECTED_ACTIONABILITY):
        actions.append({"status":"REJECTED","candidate_id":f"{i+1000:064x}"})
    found={k:{"AAVE_RESERVE_UNDERLYING":{"status":"BLOCKED","blockers":[
        "FEE_ON_TRANSFER_UNPROVEN","TRANSFER_HOOKS_UNPROVEN",
        "REBASING_UNPROVEN","UPGRADEABLE_UNPROVEN"]}} for k in tokens}
    for t in tokens[:32]:
        found[t]["UNISWAP_V2_TOKEN"]={"status":"BLOCKED","blockers":[
            "FEE_ON_TRANSFER_UNPROVEN","TRANSFER_HOOKS_UNPROVEN","RUNTIME_CODE_IDENTITY_NOT_ACQUIRED"]}
    return actions,promotions,found


class Rmc012BlockerTests(unittest.TestCase):
    def classify(self):
        a,p,t=fixtures()
        required,debt,collateral,gross=m.parse_actionability(a,p)
        return m.summarize(required,debt,collateral,gross,t,Counter({"BLOCKED":514279}))

    def test_complete_negative_with_no_pnl_promotion(self):
        z=self.classify()
        self.assertEqual(z["d12_principal_capital_feasible"],0)
        self.assertEqual(z["d12_principal_rejection_count"],432)
        self.assertEqual(z["required_underlying_source_status"],"ALL_BLOCKED_NOT_ADMITTED")
        self.assertEqual(z["distinct_required_underlying_count"],43)
        self.assertEqual(z["debt_underlying_count"],27)
        self.assertEqual(z["collateral_underlying_count"],33)
        self.assertFalse(z["nexus_executable_trades_proven"])
        self.assertFalse(z["real_market_census_closed"])

    def test_order_independent_commitment(self):
        a,p,t=fixtures()
        req,deb,col,gross=m.parse_actionability(a,p)
        z=m.summarize(req,deb,col,gross,t,Counter({"BLOCKED":514279}))
        self.assertEqual(z,self.classify())
        self.assertEqual(m.digest(m.canonical(z)),m.digest(m.canonical(self.classify())))

    def test_reject_nonexecution_blocked_false_history(self):
        a,p,t=fixtures()
        p[0]["rejection_reason"]="NO_COMPATIBLE_SOURCE"
        with self.assertRaisesRegex(ValueError,"execution-blocked"):
            m.parse_actionability(a,p)

    def test_invented_gas_funding_rejected(self):
        a,p,t=fixtures()
        p[0]["gas_funding_certified"]=True
        with self.assertRaisesRegex(ValueError,"execution-blocked"):
            m.parse_actionability(a,p)

    def test_candidate_id_substitution_rejected(self):
        a,p,t=fixtures()
        p[0]["actionable_candidate_id"]="f"*64
        with self.assertRaisesRegex(ValueError,"identities"):
            m.parse_actionability(a,p)

    def test_duplicate_candidate_rejected(self):
        a,p,t=fixtures()
        a[1]["candidate_id"]=a[0]["candidate_id"]
        with self.assertRaisesRegex(ValueError,"duplicate"):
            m.parse_actionability(a,p)

    def test_unsafe_admission_rejected(self):
        a,p,t=fixtures()
        t[a[0]["debt_asset"]]["AAVE_RESERVE_UNDERLYING"]["status"]="PROVEN_COMPATIBLE"
        with self.assertRaisesRegex(ValueError,"unexpectedly promoted"):
            required,debt,collateral,gross=m.parse_actionability(a,p)
            m.summarize(required,debt,collateral,gross,t,Counter({"BLOCKED":514279}))

    def test_missing_debt_asset_rejected(self):
        a,p,t=fixtures()
        del t[a[0]["debt_asset"]]
        required,debt,collateral,gross=m.parse_actionability(a,p)
        with self.assertRaises(ValueError):
            m.summarize(required,debt,collateral,gross,t,Counter({"BLOCKED":514279}))

    def test_dropped_actionability_row_rejected(self):
        a,p,t=fixtures()
        with self.assertRaisesRegex(ValueError,"conservation"):
            m.parse_actionability(a[:-1],p)

    def test_wrong_collateral_universe_rejected(self):
        a,p,t=fixtures()
        a[0]["collateral_asset"]="0x"+"0"*39+"0"
        with self.assertRaises(ValueError):
            m.parse_actionability(a,p)

    def test_arithmetic_spreads_never_report_as_profit(self):
        z=self.classify()
        self.assertTrue(z["arithmetic_pair_spreads_not_portfolio_profit"])
        self.assertFalse(z["nexus_net_profitability_proven"])
        self.assertEqual(z["positive_arithmetic_oracle_spread_pairs"],345)
        self.assertEqual(z["nonpositive_arithmetic_oracle_spread_pairs"],87)

    def test_manifest_tamper_rejected(self):
        blob={"a.json":b'{"a":1}\n'}
        h=m.digest(blob["a.json"])
        m.verify_manifest(h+"  a.json",blob,{"a.json":h})
        with self.assertRaisesRegex(ValueError,"SHA"):
            m.verify_manifest("0"*64+"  a.json",blob,{"a.json":h})
        with self.assertRaisesRegex(ValueError,"duplicate"):
            m.verify_manifest(h+"  a.json\n"+h+"  a.json\n",blob,{"a.json":h})

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate"):
            m.parse_unique(b'{"candidate":"x","candidate":"y"}')

    def test_archive_digest_must_match(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/"data.zip"
            path.write_bytes(b"abc")
            self.assertEqual(m.archive_sha(path,hashlib.sha256(b"abc").hexdigest()),
                             hashlib.sha256(b"abc").hexdigest())
            with self.assertRaisesRegex(ValueError,"SHA256"):
                m.archive_sha(path,"f"*64)

    def test_change_one_reason_changes_commitment(self):
        a,p,t=fixtures()
        req,deb,col,gross=m.parse_actionability(a,p)
        original=m.summarize(req,deb,col,gross,t,Counter({"BLOCKED":514279}))
        mutated=copy.deepcopy(t)
        mutated[a[0]["debt_asset"]]["AAVE_RESERVE_UNDERLYING"]["blockers"].append("NEW_UNPROVEN")
        again=m.summarize(req,deb,col,gross,mutated,Counter({"BLOCKED":514279}))
        self.assertNotEqual(m.digest(m.canonical(original)),m.digest(m.canonical(again)))

    def test_multiple_token_roles_are_independent_observations(self):
        z=self.classify()
        self.assertEqual(z["source_role_d08_required_aave_rows"],43)
        self.assertEqual(z["source_role_d08_required_uniswap_v2_rows"],32)
        self.assertEqual(z["source_role_d08_required_total_rows"],75)
        self.assertTrue(z["source_role_comparison_not_token_deduplication"])
        self.assertEqual(z["required_asset_blocker_frequency"]["FEE_ON_TRANSFER_UNPROVEN"],43)
        self.assertEqual(z["additional_v2_source_blocker_frequency"]["RUNTIME_CODE_IDENTITY_NOT_ACQUIRED"],32)

    def test_v2_only_code_flags_never_promote_aave_compatibility(self):
        a,p,t=fixtures()
        req,debt,collateral,gross=m.parse_actionability(a,p)
        original=m.summarize(req,debt,collateral,gross,t,Counter({"BLOCKED":514279}))
        changed=copy.deepcopy(t)
        token=a[0]["debt_asset"]
        changed[token]["UNISWAP_V2_TOKEN"]["blockers"].append("V2_CHAIN_EVIDENCE_MISSING")
        new=m.summarize(req,debt,collateral,gross,changed,Counter({"BLOCKED":514279}))
        self.assertEqual(original["required_asset_blocker_frequency"],
                         new["required_asset_blocker_frequency"])
        self.assertNotEqual(original["additional_v2_source_blocker_frequency"],
                            new["additional_v2_source_blocker_frequency"])

    def test_missing_aave_surface_rejected_even_if_v2_exists(self):
        a,p,t=fixtures()
        req,debt,collateral,gross=m.parse_actionability(a,p)
        del t[a[0]["debt_asset"]]["AAVE_RESERVE_UNDERLYING"]
        with self.assertRaisesRegex(ValueError,"Aave reserve"):
            m.summarize(req,debt,collateral,gross,t,Counter({"BLOCKED":514279}))


if __name__=="__main__":
    unittest.main()
