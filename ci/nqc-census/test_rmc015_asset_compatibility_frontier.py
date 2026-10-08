#!/usr/bin/env python3
"""Adversarial checks for execution-compatibility work triage, never authority."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from rmc015_asset_compatibility_frontier import create, participation, rank_asset_rows
from rmc015_material_frontier import UINT256_MAX, WAD, canonical_bytes
from test_rmc015_material_frontier import (
    ANCHOR, BASE, D08_COMMIT, D09_COMMIT, METRICS, build_zip, records,
)

A="0x"+"1"*40
B="0x"+"2"*40


def token(asset,*,status="BLOCKED", blockers=None, role="AAVE_RESERVE_UNDERLYING"):
    if blockers is None: blockers=["TRANSFER_HOOKS_UNPROVEN"] if status=="BLOCKED" else []
    return {"token":asset,"roles":[role],"execution_compatibility":{"status":status,"blockers":blockers},
            "runtime":{"kind":"CODE_SHA256","sha256":"a"*64},
            "proxy":{"kind":"NO_STANDARD_SLOT"}}


class AssetTriageTests(unittest.TestCase):
    def fixture(self,*,token_rows=None, rows=None):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup);root=Path(t.name)
        state={"status":"RMC_008_PASS_CANDIDATE","mismatches":0,"unexplained_mismatches":0,
               "aave_oracle_rows":1,
               "observation_anchor":{"chain_id":1,"block_number":26095351,
                                     "block_hash":ANCHOR,"timestamp":1790832215}}
        r=copy.deepcopy(records() if rows is None else rows)
        for acc in r:
            for leg in acc.get("debt_positions",[]):leg.setdefault("balance","1")
            for leg in acc.get("supply_positions",[]):leg.setdefault("balance","1")
        summary={"status":"RMC_009_PASS_CANDIDATE","mismatches":0,"unexplained_mismatches":0,
                 "anchor_timestamp":1790832215,"anchor":{"number":26095351,"hash":ANCHOR},
                 "metrics":METRICS}
        d08={"closeout/state-summary.json":canonical_bytes(state),
             "closeout/oracle-manifest.jsonl":canonical_bytes({"base_currency_unit":str(BASE)}),
             "closeout/token-admission.jsonl":b"".join(canonical_bytes(v) for v in
                 (token_rows if token_rows is not None else [token(A),token(B)]))}
        d09={"closeout/account-summary.json":canonical_bytes(summary),
             "closeout/account-manifest.jsonl":b"".join(canonical_bytes(v) for v in r)}
        z08=root/"d08.zip";z09=root/"d09.zip"
        h08=build_zip(z08,d08,D08_COMMIT);h09=build_zip(z09,d09,D09_COMMIT)
        return z08,z09,h08,h09

    def create(self,inputs,**kwargs):
        z08,z09,h08,h09=inputs
        return create(z08,z09,h08,h09,d08_commit=D08_COMMIT,d09_commit=D09_COMMIT,
                      evaluation_start_block=26095352,**kwargs)

    def test_integrated_zero_execution_claim(self):
        r=self.create(self.fixture());self.assertEqual(r["unique_watchlist_accounts"],2)
        self.assertEqual(r["focus_unique_account_count"],2)
        self.assertEqual(r["distinct_debt_underlyings"],1)
        self.assertEqual(r["distinct_supply_underlyings"],1)
        self.assertEqual(r["token_admission_record_count"],2)
        self.assertEqual(r["blocked_token_admission_record_count"],2)
        self.assertEqual(r["top_debt_underlyings"][0]["asset"],A)
        self.assertFalse(r["execution_eligibility_certified"])
        self.assertFalse(r["terminal_authority"])
        self.assertFalse(r["retrospective_backtest_admitted"])
        self.assertEqual(r["earliest_ex_ante_evaluation_block"],26095352)
        self.assertEqual(r["top_debt_underlyings"][0]["unresolved_execution_evidence"],
                         ["TRANSFER_HOOKS_UNPROVEN"])

    def test_exact_deterministic_hash(self):
        inputs=self.fixture();a=self.create(inputs);b=self.create(inputs)
        self.assertEqual(canonical_bytes(a),canonical_bytes(b))
        self.assertRegex(a["triage_commitment_sha256"],r"^[0-9a-f]{64}$")

    def test_missing_underlying_witness_fail_closed(self):
        inputs=self.fixture(token_rows=[token(B)])
        with self.assertRaisesRegex(ValueError,"missing Aave underlying"):
            self.create(inputs)

    def test_malformed_status_or_blocker_rejected(self):
        for row in (token(A,status="ADMITTED",blockers=["STILL_UNKNOWN"]),
                    token(A,status="BLOCKED",blockers=[]),
                    token(A,status="UNKNOWN",blockers=[])):
            inputs=self.fixture(token_rows=[row,token(B)])
            with self.assertRaises(ValueError):self.create(inputs)

    def test_foreign_token_role_not_accepted(self):
        inputs=self.fixture(token_rows=[token(A,role="V2_TOKEN0"),token(B)])
        with self.assertRaisesRegex(ValueError,"missing Aave underlying"):
            self.create(inputs)

    def test_duplicate_underlying_witness_rejected(self):
        inputs=self.fixture(token_rows=[token(A),token(A),token(B)])
        with self.assertRaisesRegex(ValueError,"duplicate underlying"):
            self.create(inputs)

    def test_invalid_top_k_fail_closed(self):
        for value in (0,65,1.0,True):
            with self.assertRaisesRegex(ValueError,"top_k"):
                self.create(self.fixture(),top_k=value)

    def test_lookahead_rejected(self):
        z08,z09,h08,h09=self.fixture()
        with self.assertRaisesRegex(ValueError,"LOOKAHEAD"):
            create(z08,z09,h08,h09,d08_commit=D08_COMMIT,d09_commit=D09_COMMIT,
                   evaluation_start_block=26095351)

    def test_outer_artifact_substitution_rejected(self):
        z08,z09,h08,h09=self.fixture()
        with self.assertRaisesRegex(ValueError,"artifact SHA-256 differs"):
            create(z08,z09,"f"*64,h09,d08_commit=D08_COMMIT,d09_commit=D09_COMMIT,
                   evaluation_start_block=26095352)

    def test_collateral_debt_are_account_participation_not_sum_of_value(self):
        # Two different debt assets in the same watched account are not two
        # separate accounts in the selected union.
        watch=[{"account":"0x"+"3"*40,"debt_position_count":2,
                "supply_position_count":1,"debt_base_units":"1000000000000"}]
        rows=[{"account":watch[0]["account"],"classification":"POSITION_HOLDER",
               "account_data":["0","1000000000000","0","0","0",str(WAD)],
               "debt_positions":[{"asset":A,"balance":"100"},{"asset":B,"balance":"200"}],
               "supply_positions":[{"asset":A,"balance":"10"}]}]
        d,s,sets=participation(rows,watch)
        self.assertEqual(sum(d.values()),2)
        self.assertEqual(len(set.union(*sets.values())),1)
        self.assertEqual(s[A],1)

    def test_invalid_account_position_cardinality_fails_closed(self):
        watch=[{"account":"0x"+"3"*40,"debt_position_count":2,
                "supply_position_count":0,"debt_base_units":"1"}]
        rows=[{"account":watch[0]["account"],"classification":"POSITION_HOLDER",
               "account_data":["0","1","0","0","0",str(WAD)],
               "debt_positions":[{"asset":A,"balance":"1"}],"supply_positions":[]}]
        with self.assertRaisesRegex(ValueError,"cardinality"):
            participation(rows,watch)


if __name__=="__main__":unittest.main()
