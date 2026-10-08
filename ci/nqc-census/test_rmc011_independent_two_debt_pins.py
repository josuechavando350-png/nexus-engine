#!/usr/bin/env python3
"""Adversarial independent review against the REAL original #661 Actions archive."""
from __future__ import annotations
import argparse
import copy
import io
from pathlib import Path
import unittest
from zipfile import ZipFile
from unittest.mock import patch

import rmc011_independent_two_debt_pins as gate

parser=argparse.ArgumentParser(add_help=False)
for label in ("original-zip","run-meta","artifact-meta","commit-meta","original-upstream-dir"):
    parser.add_argument("--"+label,required=True,type=Path)


class IndependentOriginalD08DebtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.zip=ARGS.original_zip.read_bytes()
        cls.universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()
        cls.original_input=Path("ci/nqc-census/rmc011-real-source-inputs.json").read_bytes()
        cls.providers=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes()
        cls.permissionless=Path("ci/nqc-census/rmc011-permissionless-debt-facility-catalog.json").read_bytes()
        cls.collateral=Path("ci/nqc-census/rmc011-collateral-funding-path-catalog.json").read_bytes()
        cls.final=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes()
        cls.run_meta=gate.parse(ARGS.run_meta.read_bytes())
        cls.artifact=gate.parse(ARGS.artifact_meta.read_bytes())
        cls.commit=gate.parse(ARGS.commit_meta.read_bytes())
        cls.upstream={
            key:{
                "run":gate.parse((ARGS.original_upstream_dir/f"{key}.run.json").read_bytes()),
                "artifact":gate.parse((ARGS.original_upstream_dir/f"{key}.artifact.json").read_bytes()),
                "commit":gate.parse((ARGS.original_upstream_dir/f"{key}.commit.json").read_bytes()),
            }
            for key in gate.STAGES
        }

    def check(self,**overrides):
        d={
            "archive_raw":self.zip,
            "source_raw":self.universe,
            "original_input_raw":self.original_input,
            "provider_raw":self.providers,
            "permissionless_raw":self.permissionless,
            "collateral_raw":self.collateral,
            "final_raw":self.final,
            "original_run":copy.deepcopy(self.run_meta),
            "original_artifact":copy.deepcopy(self.artifact),
            "original_commit":copy.deepcopy(self.commit),
            "original_upstream_metadata":copy.deepcopy(self.upstream),
        }
        d.update(overrides)
        return gate.audit(**d)

    def fail(self,match,**overrides):
        with self.assertRaisesRegex(ValueError,match):
            self.check(**overrides)

    def source_edit(self,fn):
        d=gate.parse(self.universe)
        fn(d)
        return gate.canonical(d)

    def test_real_five_original_and_two_debt_source_pins_replay(self):
        a=self.check()
        self.assertEqual(a["bounded_capital_families_with_original_source_evidence"],9)
        self.assertEqual(a["remaining_unresolved_count"],4)
        self.assertFalse(a["rmc011_terminal_closed"])
        self.assertFalse(a["real_market_census_closed"])
        self.assertEqual(a["original_d08_historical_aave_facility_count"],67)
        self.assertEqual(a["nqc_authorized_native_eth_gas_source_count"],0)

    def test_output_bytes_deterministic_and_report_is_addressed(self):
        a=self.check()
        b=self.check()
        self.assertEqual(gate.canonical(a),gate.canonical(b))
        digest=a.pop("report_sha256")
        self.assertEqual(gate.sha256(gate.canonical(a)),digest)

    def test_original_producer_zip_byte_tamper_rejected(self):
        self.fail("outer SHA256",archive_raw=self.zip+b"x")

    def test_original_producer_status_failure_rejected(self):
        r=copy.deepcopy(self.run_meta)
        r["conclusion"]="failure"
        self.fail("not exact-head success",original_run=r)

    def test_original_producer_wrong_head_rejected(self):
        r=copy.deepcopy(self.run_meta)
        r["head_sha"]="f"*40
        self.fail("not exact-head success",original_run=r)

    def test_original_artifact_expiry_rejected(self):
        a=copy.deepcopy(self.artifact)
        a["expired"]=True
        self.fail("archive GH metadata",original_artifact=a)

    def test_synthetic_same_name_wrong_sha_rejected(self):
        a=copy.deepcopy(self.artifact)
        a["digest"]="sha256:"+"a"*64
        self.fail("archive GH metadata",original_artifact=a)

    def test_unverified_original_D08_run_rejected(self):
        p=copy.deepcopy(self.upstream)
        p["d08"]["run"]["conclusion"]="failure"
        self.fail("d08: independent run",original_upstream_metadata=p)

    def test_original_D08_archive_sha_mismatch_rejected(self):
        p=copy.deepcopy(self.upstream)
        p["d08"]["artifact"]["digest"]="sha256:"+"b"*64
        self.fail("d08: independent original artifact",original_upstream_metadata=p)

    def test_original_D08_code_tree_mismatch_rejected(self):
        p=copy.deepcopy(self.upstream)
        p["d08"]["commit"]["tree"]["sha"]="f"*40
        self.fail("d08: original code tree",original_upstream_metadata=p)

    def test_borrowing_and_persistent_debt_member_hashes_unique(self):
        parsed=gate.verify_original_zip(self.zip)
        for family,expected in gate.ORIGINAL_FAMILY_BLOBS.items():
            f=f"debt-family-evidence/families/{family}/evidence.json"
            self.assertEqual(gate.sha256(parsed[f]),expected)
        self.assertEqual(len(set(gate.ORIGINAL_FAMILY_BLOBS.values())),2)

    def test_evergreen_D11_cannot_be_promoted_by_two_debt_rejections(self):
        doc=self.source_edit(lambda d: d.__setitem__("terminal_claim_allowed",True))
        with patch.object(gate,"CURRENT_SOURCE_BLOB",gate.gitblob(doc)):
            self.fail("only nine families",source_raw=doc)

    def test_four_unresolved_native_families_cannot_be_omitted(self):
        doc=self.source_edit(lambda d:d["families"].pop(0))
        with patch.object(gate,"CURRENT_SOURCE_BLOB",gate.gitblob(doc)):
            self.fail("missing/malformed capital family",source_raw=doc)

    def test_forged_one_debt_family_status_rejected(self):
        def mutation(doc):
            for f in doc["families"]:
                if f["id"]=="COLLATERALIZED_BORROWING":
                    f["status"]="AUTHENTICATED_REAL_SOURCE"
        raw=self.source_edit(mutation)
        with patch.object(gate,"CURRENT_SOURCE_BLOB",gate.gitblob(raw)):
            self.fail("not exact original authenticated bytes",source_raw=raw)

    def test_missing_evidence_member_sha_rejected(self):
        def mutation(doc):
            for f in doc["families"]:
                if f["id"]=="PERSISTENT_DEBT":
                    f["resolution_evidence"]["sha256"]="0"*64
        raw=self.source_edit(mutation)
        with patch.object(gate,"CURRENT_SOURCE_BLOB",gate.gitblob(raw)):
            self.fail("not exact original authenticated bytes",source_raw=raw)

    def test_forged_collateral_funding_catalog_rejected(self):
        raw=self.collateral+b" "
        self.fail("Git blob drift",collateral_raw=raw)

    def test_forged_extra_gas_provider_rejected(self):
        doc=gate.parse(self.providers)
        doc["provider_count"]=1
        doc["providers"]=[{"pretend":"unauthorized"}]
        raw=gate.canonical(doc)
        with patch.object(gate,"REGISTRY_BLOB",gate.gitblob(raw)):
            self.fail("capital or Census source availability changed",provider_raw=raw)

    def test_other_original_D08_family_synthetic_presence_cannot_close_census(self):
        assert self.check()["global_debt_facility_nonexistence_proven"] is False

    def test_duplicate_JSON_key_attack_rejected(self):
        with self.assertRaisesRegex(ValueError,"duplicate JSON field"):
            gate.parse(b'{"status":"PASS","status":"BLOCKED"}')

    def test_nonrecourse_native_gas_not_inferred_from_no_registration(self):
        d=self.check()
        self.assertTrue(d["no_external_nqc_gas_credit_or_sponsor_admitted"])
        self.assertFalse(d["family_universe_discovery_authenticated"])
        self.assertEqual(d["nqc_realized_usd_wad"],"0")


if __name__=="__main__":
    ARGS,OTHER=parser.parse_known_args()
    unittest.main(argv=[__file__]+OTHER,verbosity=2)
