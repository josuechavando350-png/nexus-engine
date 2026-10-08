#!/usr/bin/env python3
"""Adversarial regressions against one exact independently downloaded GH ZIP.

Positive source fixture is the *real* successful seven-family Actions archive.
Every other test mutates a copy and requires fail-closed behavior.
"""
from __future__ import annotations
import argparse
import copy
import io
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import rmc011_independent_seven_bounded_rejections as mod

parser=argparse.ArgumentParser(add_help=False)
parser.add_argument("--archive",required=True,type=Path)
parser.add_argument("--run-meta",required=True,type=Path)
parser.add_argument("--artifact-meta",required=True,type=Path)


class RealSourceSevenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.archive=ARGS.archive.read_bytes()
        cls.source=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()
        cls.provider=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes()
        cls.plans=Path("ci/nqc-census/rmc011-execution-plan-requirement-catalog.json").read_bytes()
        cls.run_metadata=mod.decode(ARGS.run_meta.read_bytes())
        cls.artifact=mod.decode(ARGS.artifact_meta.read_bytes())

    def gate(self,**overrides):
        args={
            "original_zip":self.archive,
            "source_bytes":self.source,
            "provider_bytes":self.provider,
            "plan_bytes":self.plans,
            "run":copy.deepcopy(self.run_metadata),
            "artifact":copy.deepcopy(self.artifact),
        }
        args.update(overrides)
        return mod.audit(**args)

    def fail(self,message,**changes):
        with self.assertRaisesRegex(ValueError,message):
            self.gate(**changes)

    def mutated_source(self,change):
        doc=mod.decode(self.source)
        change(doc)
        return mod.canonical(doc)

    def test_exact_immutable_original_is_only_partial_source_authority(self):
        report=self.gate()
        self.assertEqual(report["status"],
            "RMC011_SEVEN_BOUNDED_REJECTIONS_INDEPENDENTLY_REAUTHENTICATED_NOT_D11")
        self.assertEqual(report["rejected_families_within_nqc_configured_scope"],7)
        self.assertEqual(report["remaining_unresolved_families"],4)
        self.assertFalse(report["capital_truth_D11_terminal_closed"])
        self.assertFalse(report["global_external_funding_nonexistence_proven"])
        self.assertFalse(report["nqc_nonrecourse_native_gas_authorized"])
        self.assertFalse(report["real_market_census_closed"])

    def test_report_deterministic_and_content_addressed(self):
        a=self.gate()
        b=self.gate()
        self.assertEqual(mod.canonical(a),mod.canonical(b))
        digest=a.pop("report_sha256")
        self.assertEqual(mod.sha256(mod.canonical(a)),digest)

    def test_original_zip_sha_must_match_pinned_digest(self):
        self.fail("outer SHA-256",original_zip=self.archive+b"\x00")

    def test_original_successful_run_required(self):
        run=copy.deepcopy(self.run_metadata)
        run["conclusion"]="failure"
        self.fail("producing run",run=run)

    def test_no_boolean_run_id(self):
        run=copy.deepcopy(self.run_metadata)
        run["id"]=True
        self.fail("producing run",run=run)

    def test_github_synthetic_merge_sha_is_not_source_head(self):
        run=copy.deepcopy(self.run_metadata)
        run["head_sha"]="5eec64fb169cf99b649ba727a8ebc603bd950c8a"
        self.fail("producing run",run=run)

    def test_expired_zip_cannot_certify_a_family(self):
        art=copy.deepcopy(self.artifact)
        art["expired"]=True
        self.fail("artifact name/head",artifact=art)

    def test_renamed_archive_disagrees_with_producing_head(self):
        art=copy.deepcopy(self.artifact)
        art["name"]="rmc011-bounded-family-rejections-"+"5eec64fb169cf99b649ba727a8ebc603bd950c8a"+"-37826819250-1"
        self.fail("artifact name/head",artifact=art)

    def test_zero_or_replaced_archive_metadata_sha(self):
        art=copy.deepcopy(self.artifact)
        art["digest"]="sha256:"+"0"*64
        self.fail("artifact name/head",artifact=art)

    def test_original_source_blob_tamper_rejected(self):
        self.fail("source Git blob changed",source_bytes=self.source+b"\n")

    def test_external_registry_blob_drift_rejected(self):
        self.fail("provider registry changed",provider_bytes=self.provider+b" ")

    def test_execution_plan_catalog_blob_drift_rejected(self):
        self.fail("plan requirements changed",plan_bytes=self.plans+b" ")

    def test_one_pinned_family_file_digest_forged_fails(self):
        raw=self.mutated_source(lambda d:
            d["families"][4]["resolution_evidence"].__setitem__("sha256","a"*64))
        with patch.object(mod,"SOURCE_UNIVERSE_BLOB",mod.gitblob(raw)):
            self.fail("does not match authenticated original member",source_bytes=raw)

    def test_one_pinned_family_status_forged_fails(self):
        def change(d):
            for r in d["families"]:
                if r["id"]=="EXTERNAL_GAS_SPONSOR":
                    r["status"]="AUTHENTICATED_REAL_SOURCE"
        raw=self.mutated_source(change)
        with patch.object(mod,"SOURCE_UNIVERSE_BLOB",mod.gitblob(raw)):
            self.fail("does not match authenticated original member",source_bytes=raw)

    def test_seven_family_evidence_cannot_close_D11(self):
        raw=self.mutated_source(lambda d: d.__setitem__("d11_terminal_closed",True))
        with patch.object(mod,"SOURCE_UNIVERSE_BLOB",mod.gitblob(raw)):
            self.fail("falsely promotes terminal family",source_bytes=raw)

    def test_seven_families_cannot_claim_universe_complete(self):
        raw=self.mutated_source(lambda d: d.__setitem__("terminal_claim_allowed",True))
        with patch.object(mod,"SOURCE_UNIVERSE_BLOB",mod.gitblob(raw)):
            self.fail("falsely promotes terminal family",source_bytes=raw)

    def test_four_unresolved_native_families_cannot_be_removed(self):
        raw=self.mutated_source(lambda d: d["families"].pop())
        with patch.object(mod,"SOURCE_UNIVERSE_BLOB",mod.gitblob(raw)):
            self.fail("family population invalid",source_bytes=raw)

    def test_simulated_available_gas_not_supported(self):
        providers=mod.decode(self.provider)
        providers["provider_count"]=1
        providers["providers"]=[{"name":"invented"}]
        raw=mod.canonical(providers)
        with patch.object(mod,"PROVIDER_BLOB",mod.gitblob(raw)):
            self.fail("zero NQC-authorized providers",provider_bytes=raw)

    def test_simulated_live_execution_plan_not_supported(self):
        plans=mod.decode(self.plans)
        plans["plan_count"]=1
        plans["plans"]=[{"id":"invented"}]
        raw=mod.canonical(plans)
        with patch.object(mod,"PLANS_BLOB",mod.gitblob(raw)):
            self.fail("zero supported plans",plan_bytes=raw)

    def test_exact_internal_member_digest_rechecked_independently(self):
        names=mod.verified_zip(self.archive)
        target="families/EXTERNAL_GAS_CREDIT/evidence.json"
        names[target]=names[target]+b" "
        stream=io.BytesIO()
        with zipfile.ZipFile(stream,"w") as z:
            for name,payload in names.items():
                z.writestr(name,payload)
        modified=stream.getvalue()
        art=copy.deepcopy(self.artifact)
        art["digest"]="sha256:"+mod.sha256(modified)
        with patch.object(mod,"ARCHIVE_SHA",mod.sha256(modified)):
            self.fail("internal archive SHA-256 manifest mismatch",
                      original_zip=modified,artifact=art)

    def test_duplicate_json_source_keys_cannot_be_trusted(self):
        with self.assertRaisesRegex(ValueError,"duplicate JSON key"):
            mod.decode(b'{"status":1,"status":2}\n')

    def test_original_source_has_zero_real_gas_sponsors_not_global_absence(self):
        report=self.gate()
        self.assertEqual(report["nqc_approved_external_gas_provider_count"],0)
        self.assertEqual(report["nqc_realized_net_usd_wad"],"0")
        self.assertFalse(report["family_universe_discovery_certified"])


if __name__=="__main__":
    ARGS,OTHER=parser.parse_known_args()
    unittest.main(argv=[__file__]+OTHER,verbosity=2)
