#!/usr/bin/env python3
"""Adversarial OFFLINE tests for historical D08 debt evidence acquisition.

All metadata/ZIPs created inside these tests are synthetic, never original
Aave/Nexus execution evidence. The actual CI producer separately downloads,
hash-verifies and semantically replays five real immutable archive ZIP files.
"""
from __future__ import annotations

import copy
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

import rmc011_original_d08_debt_producer as p


class D08OriginalDebtSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.docs=p.validate_sources()
        cls.src=cls.docs["inputs"]["d08"]

    def run_meta(self):
        return {
            "id":self.src["run_id"],"name":self.src["workflow_name"],
            "head_sha":self.src["head_sha"],"status":"completed",
            "conclusion":"success",
        }

    def artifact_meta(self):
        return {
            "id":self.src["artifact_id"],"name":self.src["artifact_name"],
            "digest":self.src["artifact_digest"],"expired":False,
            "workflow_run":{
                "id":self.src["run_id"],"head_sha":self.src["head_sha"],
            },
        }

    def test_real_original_source_file_catalog_exact_and_bounded(self):
        d=self.docs
        self.assertEqual(set(d["inputs"]),{"repository","schema_version",*p.STAGES})
        self.assertEqual(len(d["universe"]["families"]),13)
        self.assertEqual(d["final"]["status"],"BLOCKED")
        self.assertEqual(d["providers"]["provider_count"],0)
        self.assertEqual(d["permissionless"]["facility_count"],0)
        self.assertEqual(d["collateral"]["path_count"],0)

    def test_five_original_published_artifact_metadata_refs_pinned(self):
        d=self.docs["inputs"]
        self.assertEqual([d[k]["run_id"] for k in p.STAGES],
                         [36820687233,36952216731,36964016388,36823489219,37053225954])
        self.assertEqual(d["d08"]["artifact_id"],11237887761)
        self.assertEqual(d["d08"]["artifact_digest"],
                         "sha256:9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913")

    def test_original_d10_authority_may_be_at_archive_root(self):
        self.assertEqual(self.docs["inputs"]["d10"]["authority_file"],
                         "rmc010-certification.json")

    def test_13_family_identity_conserves_six_unresolved(self):
        universe=self.docs["universe"]
        self.assertEqual({x["id"] for x in universe["families"] if not x["terminally_resolved"]},
                         p.NATIVE_OR_DEBT)
        self.assertFalse(universe["terminal_claim_allowed"])
        self.assertFalse(universe["d11_terminal_closed"])

    def test_original_source_mutation_fails_blob_lock(self):
        src=p.ROOT/"rmc011-real-source-inputs.json"
        with tempfile.TemporaryDirectory() as t:
            f=Path(t)/"source.json"
            f.write_bytes(src.read_bytes()+b" ")
            with self.assertRaisesRegex(ValueError,"source Git blob changed"):
                p.verified_source(f,p.SOURCE_INPUT_BLOB)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate authoritative JSON"):
            p.json_object(b'{"status":1,"status":2}')

    def test_validate_genuine_metadata_shape_syntactically(self):
        self.assertIsNone(p.original_run_and_artifact(
            self.run_meta(),self.artifact_meta(),self.src))

    def test_original_run_failure_cannot_promote(self):
        run=self.run_meta()
        run["conclusion"]="failure"
        with self.assertRaisesRegex(ValueError,"workflow/head"):
            p.original_run_and_artifact(run,self.artifact_meta(),self.src)

    def test_different_head_cannot_promote(self):
        run=self.run_meta()
        run["head_sha"]="f"*40
        with self.assertRaisesRegex(ValueError,"workflow/head"):
            p.original_run_and_artifact(run,self.artifact_meta(),self.src)

    def test_bool_run_id_is_not_integer(self):
        run=self.run_meta()
        run["id"]=True
        with self.assertRaisesRegex(ValueError,"workflow/head"):
            p.original_run_and_artifact(run,self.artifact_meta(),self.src)

    def test_wrong_workflow_identity_rejected(self):
        run=self.run_meta()
        run["name"]="RMC-015 Other Source"
        with self.assertRaisesRegex(ValueError,"workflow/head"):
            p.original_run_and_artifact(run,self.artifact_meta(),self.src)

    def test_forged_artifact_digest_rejected(self):
        artifact=self.artifact_meta()
        artifact["digest"]="sha256:"+"0"*64
        with self.assertRaisesRegex(ValueError,"original ZIP identity"):
            p.original_run_and_artifact(self.run_meta(),artifact,self.src)

    def test_expired_zip_is_not_authenticated(self):
        artifact=self.artifact_meta()
        artifact["expired"]=True
        with self.assertRaisesRegex(ValueError,"original ZIP identity"):
            p.original_run_and_artifact(self.run_meta(),artifact,self.src)

    def test_artifact_run_id_mismatch_rejected(self):
        artifact=self.artifact_meta()
        artifact["workflow_run"]["id"]=123456
        with self.assertRaisesRegex(ValueError,"original ZIP identity"):
            p.original_run_and_artifact(self.run_meta(),artifact,self.src)

    def test_artifact_source_head_mismatch_rejected(self):
        artifact=self.artifact_meta()
        artifact["workflow_run"]["head_sha"]="f"*40
        with self.assertRaisesRegex(ValueError,"original ZIP identity"):
            p.original_run_and_artifact(self.run_meta(),artifact,self.src)

    def test_synthetic_safe_zip_member_structure_only(self):
        b=io.BytesIO()
        with ZipFile(b,"w") as z:z.writestr("closeout/manifest.json","{}\n")
        with ZipFile(io.BytesIO(b.getvalue())) as z:
            self.assertIsNone(p.verified_zip_members(z))

    def test_archive_directory_traversal_rejected(self):
        b=io.BytesIO()
        with ZipFile(b,"w") as z:z.writestr("../escape.json","{}\n")
        with ZipFile(io.BytesIO(b.getvalue())) as z:
            with self.assertRaisesRegex(ValueError,"member path"):
                p.verified_zip_members(z)

    def test_duplicate_archive_members_rejected(self):
        b=io.BytesIO()
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with ZipFile(b,"w") as z:
                z.writestr("evidence.json","{}\n")
                z.writestr("evidence.json","{}\n")
        with ZipFile(io.BytesIO(b.getvalue())) as z:
            with self.assertRaisesRegex(ValueError,"duplicates"):
                p.verified_zip_members(z)

    def test_synthetic_rejection_publication_never_certifies_census(self):
        fake_rows=[
            {"key":key,"stage":f"RMC-{int(key[1:]):03d}",
             "artifact_sha256":"a"*64,"run_id":i+100}
            for i,key in enumerate(p.STAGES)
        ]
        fake={
          "aave_candidate_count":3,"aave_facility_count":2,
          "aave_rejected_count":1,
          "d08_authority_artifact_sha256":"0x"+"b"*64,
          "aave_coverage_commitment":"c"*64,
          "families":[
              {"family":family,"outcome":"EXHAUSTIVE_REJECTION",
               "scope":"NQC_ZERO_OWN_CAPITAL_EXECUTABLE_DEBT_UNIVERSE_AT_THIS_HEAD",
               "basis":["SIMULATED_TEST_NOT_REAL"]}
              for family in sorted(p.DEBT)
          ],
        }
        with tempfile.TemporaryDirectory() as td:
            with patch.dict(os.environ,{"GITHUB_WORKFLOW":"OFFLINE_SYNTHETIC_TEST_DO_NOT_AUTHENTICATE"}):
                with patch.object(p,"command",return_value="d"*40):
                    p.publish(Path(td),fake_rows,fake,"e"*40,234,1)
            public=Path(td)/"public"
            report=p.json_object((public/"original-source-report.json").read_bytes())
            self.assertFalse(report["rmc011_terminal_closed"])
            self.assertFalse(report["real_market_census_closed"])
            self.assertFalse(report["nqc_external_debt_executable_capacity_claimed"])
            self.assertFalse(report["global_external_credit_nonexistence_claimed"])
            self.assertEqual(report["nqc_authorized_external_gas_providers"],0)
            self.assertEqual(len(report["original_two_bounded_debt_evidence_sha256"]),2)
            self.assertEqual(report["nqc_realized_usd_wad"],"0")
            self.assertEqual(report["source_workflow_name"],
                             "OFFLINE_SYNTHETIC_TEST_DO_NOT_AUTHENTICATE")

    def test_unavailable_authority_is_not_synthesized(self):
        expected=self.docs["inputs"]["d08"]
        self.assertTrue(expected["authority_file"].startswith("closeout/"))
        self.assertEqual(expected["head_sha"],
                         "36c732a36789e1967ce7178010889427ad7cf0f2")


if __name__=="__main__":
    unittest.main(verbosity=2)
