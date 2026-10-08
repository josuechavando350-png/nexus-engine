#!/usr/bin/env python3
"""Adversarial tests against one genuine successful D11 acquisition-job ZIP.

The full original archive is the only positive fixture. Synthetic metadata
mutations are always rejected; none may be promoted to terminal D11 or revenue.
"""
from __future__ import annotations
import argparse
import copy
from pathlib import Path
import tempfile
import unittest

import rmc011_original_native_dual_provider_source_audit as proof

cli=argparse.ArgumentParser(add_help=False)
for name in ("zip","run-meta","job-meta","artifact-meta","commit-meta"):
    cli.add_argument("--"+name,type=Path,required=True)


class SourceAuthorityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.original_zip=ARGS.zip
        cls.original_run_metadata=proof.json_obj(ARGS.run_meta.read_bytes())
        cls.job=proof.json_obj(ARGS.job_meta.read_bytes())
        cls.artifact=proof.json_obj(ARGS.artifact_meta.read_bytes())
        cls.commit=proof.json_obj(ARGS.commit_meta.read_bytes())
        cls.universe=Path("ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()
        cls.registry=Path("ci/nqc-census/rmc011-external-capital-provider-registry.json").read_bytes()
        cls.final=Path("ci/nqc-census/final-census-authority-lock.json").read_bytes()
        cls.verified=proof.audit(
            archive_path=cls.original_zip,run=cls.original_run_metadata,job=cls.job,
            artifact=cls.artifact,commit=cls.commit,
            capital_source_universe=cls.universe,
            provider_registry=cls.registry,
            final_census_lock=cls.final,
        )

    def test_full_actual_original_30030_file_manifest_is_authenticated(self):
        self.assertEqual(self.verified["original_internal_sha256_manifest_entries"],30030)
        self.assertEqual(self.verified["original_artifact_zip_sha256"],proof.SOURCE_ZIP_SHA256)

    def test_two_distinct_original_provider_pairs(self):
        a=self.verified["original_source_family_evidence"]
        for family in proof.FAMILIES:
            captures=a[family]["capture_witnesses"]
            self.assertEqual(len(captures),2)
            self.assertNotEqual(captures[0]["provider_operator"],captures[1]["provider_operator"])
            self.assertNotEqual(captures[0]["rpc_endpoint_hash"],captures[1]["rpc_endpoint_hash"])

    def test_original_balancer_count_and_execution_ineligibility(self):
        x=self.verified["original_source_family_evidence"]["BALANCER_V2_FLASH_LOAN"]
        self.assertEqual(x["source_count_historical"],67)
        self.assertEqual(x["source_id_unique_count"],67)
        self.assertEqual(x["source_key_unique_count"],67)
        self.assertEqual(x["currently_execution_eligible_count"],0)
        self.assertEqual(x["positive_executable_capital_sources"],0)

    def test_original_uniswap_v3_count_and_zero_liquidity_semantics(self):
        x=self.verified["original_source_family_evidence"]["UNISWAP_V3_FLASH"]
        self.assertEqual(x["source_count_historical"],69748)
        self.assertEqual(x["source_id_unique_count"],69748)
        self.assertEqual(x["source_key_unique_count"],69748)
        self.assertEqual(x["execution_blocker_counts"]["UNISWAP_V3_ZERO_ACTIVE_LIQUIDITY"],28235)
        self.assertEqual(x["positive_executable_capital_sources"],0)

    def test_token_behavior_without_proof_cannot_claim_capital(self):
        for a in self.verified["original_source_family_evidence"].values():
            for b in proof.REQUIRED_TOKEN_BLOCKERS:
                self.assertEqual(a["execution_blocker_counts"][b],a["source_count_historical"])

    def test_source_rows_are_not_monthly_revenue(self):
        v=self.verified
        self.assertEqual(v["total_native_historical_sources"],69815)
        self.assertEqual(v["historical_sources_recorded_execution_eligible"],0)
        self.assertEqual(v["historical_sources_recorded_executable_capital"],0)
        self.assertEqual(v["nqc_externally_authorized_gas_sponsors"],0)
        self.assertEqual(v["nqc_realized_profit_usd_wad"],"0")
        self.assertFalse(v["rmc011_terminal_closed"])
        self.assertFalse(v["real_market_census_closed"])

    def test_old_failed_overall_run_must_not_be_reported_as_success(self):
        self.assertEqual(self.verified["original_workflow_conclusion"],"failure")
        self.assertEqual(self.verified["original_acquisition_job_conclusion"],"success")
        forged=copy.deepcopy(self.original_run_metadata)
        forged["conclusion"]="success"
        with self.assertRaisesRegex(ValueError,"overall run must be recorded as FAILED"):
            proof.verify_producer(forged,self.job,self.artifact,self.commit)

    def test_old_acquisition_job_failure_cannot_be_accepted(self):
        forged=copy.deepcopy(self.job)
        forged["conclusion"]="failure"
        with self.assertRaisesRegex(ValueError,"acquisition producing job"):
            proof.verify_producer(self.original_run_metadata,forged,self.artifact,self.commit)

    def test_artifact_sha_mutation_cannot_be_promoted(self):
        forged=copy.deepcopy(self.artifact)
        forged["digest"]="sha256:"+"a"*64
        with self.assertRaisesRegex(ValueError,"artifact identity"):
            proof.verify_producer(self.original_run_metadata,self.job,forged,self.commit)

    def test_expired_original_artifact_is_not_source_authority(self):
        forged=copy.deepcopy(self.artifact)
        forged["expired"]=True
        with self.assertRaisesRegex(ValueError,"artifact identity"):
            proof.verify_producer(self.original_run_metadata,self.job,forged,self.commit)

    def test_wrong_code_tree_rejected(self):
        forged=copy.deepcopy(self.commit)
        forged["tree"]["sha"]="f"*40
        with self.assertRaisesRegex(ValueError,"code commit/tree"):
            proof.verify_producer(self.original_run_metadata,self.job,self.artifact,forged)

    def test_bool_original_job_identifier_cannot_pass(self):
        forged=copy.deepcopy(self.job)
        forged["id"]=True
        with self.assertRaisesRegex(ValueError,"acquisition producing job"):
            proof.verify_producer(self.original_run_metadata,forged,self.artifact,self.commit)

    def test_missing_original_archive_never_produces_a_certificate(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError,"original ZIP unavailable"):
                proof.verify_archive(Path(temp)/"missing.zip")

    def test_changed_source_provider_catalog_fails_before_archive_read(self):
        with self.assertRaisesRegex(ValueError,"provider source changed"):
            proof.audit(
                archive_path=self.original_zip,
                run=self.original_run_metadata,job=self.job,artifact=self.artifact,commit=self.commit,
                capital_source_universe=self.universe,
                provider_registry=self.registry+b" ",
                final_census_lock=self.final,
            )

    def test_report_is_content_addressed_deterministically(self):
        report=copy.deepcopy(self.verified)
        observed=report.pop("report_sha256")
        self.assertEqual(proof.sha256(proof.canonical(report)),observed)

    def test_duplicate_json_keys_refused(self):
        with self.assertRaisesRegex(ValueError,"duplicate JSON"):
            proof.json_obj(b'{"source_count":0,"source_count":69748}')

    def test_nonclaims_leave_other_two_native_families_unresolved(self):
        v=self.verified
        self.assertFalse(v["independently_admitted_family_terminal_closeout"])
        self.assertFalse(v["current_market_capture_claimed"])
        self.assertFalse(v["global_protocol_liquidity_nonexistence_claimed"])
        self.assertEqual(set(v["native_families_present_in_historic_capture_only"]),
                         set(proof.FAMILIES))


if __name__=="__main__":
    ARGS,remaining=cli.parse_known_args()
    unittest.main(argv=[__file__]+remaining,verbosity=2)
