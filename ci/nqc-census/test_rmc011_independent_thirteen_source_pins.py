#!/usr/bin/env python3
"""Adversarial 13-family source-only audit using REAL original 3 GH audit ZIPs.

No synthetic original source rows permitted as positives; mutations are negatives.
"""
from __future__ import annotations
import argparse
import copy
from pathlib import Path
import unittest
from unittest.mock import patch

import rmc011_independent_thirteen_source_pins as proof

cli=argparse.ArgumentParser(add_help=False)
for x in ("new-zip","d08-zip","dual-zip","new-run","d08-run","dual-run",
          "new-artifact","d08-artifact","dual-artifact"):
    cli.add_argument("--"+x,type=Path,required=True)


class ThirteenAuthenticatedSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sources={
            "new":(ARGS.new_zip.read_bytes(),
                   proof.parse(ARGS.new_run.read_bytes()),
                   proof.parse(ARGS.new_artifact.read_bytes())),
            "d08":(ARGS.d08_zip.read_bytes(),
                   proof.parse(ARGS.d08_run.read_bytes()),
                   proof.parse(ARGS.d08_artifact.read_bytes())),
            "dual":(ARGS.dual_zip.read_bytes(),
                    proof.parse(ARGS.dual_run.read_bytes()),
                    proof.parse(ARGS.dual_artifact.read_bytes())),
        }
        cls.universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()
        cls.gas=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes()
        cls.final=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes()

    def audit(self,**changes):
        kwargs=dict(
            new_zip=self.sources["new"][0],
            d08_zip=self.sources["d08"][0],
            dual_zip=self.sources["dual"][0],
            runs={key:copy.deepcopy(data[1]) for key,data in self.sources.items()},
            artifacts={key:copy.deepcopy(data[2]) for key,data in self.sources.items()},
            source_universe=self.universe,
            gas_registry=self.gas,
            final_lock=self.final,
        )
        kwargs.update(changes)
        return proof.verify(**kwargs)

    def rejection(self,match,**changes):
        with self.assertRaisesRegex(ValueError,match):
            self.audit(**changes)

    def change_universe(self,modifier):
        doc=proof.parse(self.universe)
        modifier(doc)
        return proof.canonical(doc)

    def test_three_original_audits_and_all_four_member_bytes(self):
        report=self.audit()
        self.assertEqual(report["source_family_evidence_rows_addressed"],13)
        self.assertEqual(report["source_family_count"],13)
        self.assertEqual(len(report["new_native_family_original_member_sha256"]),4)

    def test_actual_four_native_counts_without_executable_pnl(self):
        report=self.audit()
        self.assertEqual(report["original_native_flash_source_observation_counts"],
                         {k:v["count"] for k,v in sorted(proof.FAMILIES.items())})
        self.assertFalse(report["positive_executable_pnl_certified"])
        self.assertFalse(report["economic_feasibility_terminally_certified"])
        self.assertEqual(report["nqc_realized_usd_wad"],"0")

    def test_no_self_certified_discovery_or_D11_or_canary(self):
        report=self.audit()
        self.assertFalse(report["family_universe_discovery_authenticated"])
        self.assertFalse(report["d11_terminal_closed"])
        self.assertFalse(report["real_market_census_closed"])
        self.assertEqual(report["nqc_external_native_gas_provider_count"],0)

    def test_original_three_zip_outer_byte_hashes(self):
        self.assertEqual(proof.sha256(self.sources["new"][0]),proof.ORIGINAL_ZIP)
        self.assertEqual(proof.sha256(self.sources["d08"][0]),proof.D08_AUDIT["artifact_sha256"])
        self.assertEqual(proof.sha256(self.sources["dual"][0]),proof.DUAL_AUDIT["artifact_sha256"])

    def test_forged_original_four_native_zip_rejected(self):
        self.rejection("outer SHA256",new_zip=self.sources["new"][0]+b"z")

    def test_forged_original_d08_source_zip_rejected(self):
        self.rejection("outer SHA256",d08_zip=self.sources["d08"][0]+b"z")

    def test_forged_original_dual_provider_zip_rejected(self):
        self.rejection("outer SHA256",dual_zip=self.sources["dual"][0]+b"z")

    def test_forged_original_four_run_failed(self):
        runs={k:copy.deepcopy(v[1]) for k,v in self.sources.items()}
        runs["new"]["conclusion"]="failure"
        self.rejection("new: original producing run",runs=runs)

    def test_forged_original_four_artifact_head(self):
        arts={k:copy.deepcopy(v[2]) for k,v in self.sources.items()}
        arts["new"]["workflow_run"]["head_sha"]="f"*40
        self.rejection("new: original immutable artifact",artifacts=arts)

    def test_forged_upstream_d08_producer_status(self):
        runs={k:copy.deepcopy(v[1]) for k,v in self.sources.items()}
        runs["d08"]["conclusion"]="cancelled"
        self.rejection("d08: original producing run",runs=runs)

    def test_forged_upstream_dual_audit_digest(self):
        arts={k:copy.deepcopy(v[2]) for k,v in self.sources.items()}
        arts["dual"]["digest"]="sha256:"+"0"*64
        self.rejection("dual: original immutable artifact",artifacts=arts)

    def test_12_source_families_not_reported_as_13(self):
        def mutation(doc):
            doc["families"].pop()
        b=self.change_universe(mutation)
        with patch.object(proof,"SOURCE_BLOB",proof.gitblob(b)):
            self.rejection("13 source-family references are not bounded",
                           source_universe=b)

    def test_authentic_gas_registry_drift_rejected(self):
        self.rejection("gas funding registry diverged",gas_registry=self.gas+b" ")

    def test_pending_unresolved_family_fails_source_gate(self):
        def mutation(doc):
            f=next(r for r in doc["families"] if r["id"]=="UNISWAP_V2_FLASH_SWAP")
            f["terminally_resolved"]=False
            f["resolution_evidence"]=None
        raw=self.change_universe(mutation)
        with patch.object(proof,"SOURCE_BLOB",proof.gitblob(raw)):
            self.rejection("13 source-family references are not bounded",source_universe=raw)

    def test_fake_native_family_terminal_closure_rejected(self):
        raw=self.change_universe(lambda d:d.__setitem__("d11_terminal_closed",True))
        with patch.object(proof,"SOURCE_BLOB",proof.gitblob(raw)):
            self.rejection("13 source-family references are not bounded",source_universe=raw)

    def test_missing_family_discovery_stays_a_material_blocker(self):
        report=self.audit()
        self.assertEqual(report["status"],
          "RMC011_THIRTEEN_SOURCE_FAMILY_TRANSPORT_REAUTHENTICATED_DISCOVERY_PENDING")
        self.assertFalse(report["family_universe_discovery_authenticated"])

    def test_fake_four_original_family_hash_rejected(self):
        def mutation(doc):
            row=next(x for x in doc["families"] if x["id"]=="BALANCER_V2_FLASH_LOAN")
            row["resolution_evidence"]["sha256"]="a"*64
        raw=self.change_universe(mutation)
        with patch.object(proof,"SOURCE_BLOB",proof.gitblob(raw)):
            self.rejection("canonical RMC011 source row disagrees",source_universe=raw)

    def test_wrong_original_native_producer_workflow_fails(self):
        def mutation(doc):
            row=next(x for x in doc["families"] if x["id"]=="AAVE_V3_FLASH_LOAN")
            row["resolution_evidence"]["workflow_name"]="Synthesized witness"
        raw=self.change_universe(mutation)
        with patch.object(proof,"SOURCE_BLOB",proof.gitblob(raw)):
            self.rejection("canonical RMC011 source row disagrees",source_universe=raw)

    def test_double_replay_is_byte_exact(self):
        a=self.audit()
        b=self.audit()
        self.assertEqual(proof.canonical(a),proof.canonical(b))
        expected=a.pop("report_sha256")
        self.assertEqual(proof.sha256(proof.canonical(a)),expected)

    def test_reject_duplicated_json_field(self):
        with self.assertRaisesRegex(ValueError,"duplicate source JSON"):
            proof.parse(b'{"gas":0,"gas":1}')

    def test_aave_and_uni_v2_execution_eligibility_remains_unproven(self):
        self.assertFalse(self.audit()["original_d08_eligibility_for_aave_and_univ2_adjudicated"])

    def test_balancer_univ3_positive_eligible_count_remains_false(self):
        self.assertFalse(self.audit()["original_d11_eligibility_for_balancer_univ3_positive"])


if __name__=="__main__":
    ARGS,other=cli.parse_known_args()
    unittest.main(argv=[__file__]+other,verbosity=2)
