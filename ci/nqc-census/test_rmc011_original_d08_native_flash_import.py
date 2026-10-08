#!/usr/bin/env python3
"""Offline adversarial tests for original D08/D09 full-universe native flash import.

These fixtures do NOT constitute historic source evidence or authenticated
native flash liquidity. Only the GitHub Actions producer consumes original
byte-hashed D08/D09 ZIPs and the existing locked Rust capital import.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace

import rmc011_original_d08_native_flash_import as producer


class OriginalD08NativeFlashImportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.inputs,cls.universe=producer.original_source_catalog()

    def test_real_catalog_is_exact_9_4_with_no_live_approval(self):
        self.assertEqual(set(self.inputs),{"schema_version","repository",*producer.origin.STAGES})
        self.assertEqual(len(self.universe["families"]),13)
        self.assertEqual(sum(f["terminally_resolved"] for f in self.universe["families"]),9)
        self.assertFalse(self.universe["terminal_claim_allowed"])
        self.assertFalse(self.universe["d11_terminal_closed"])

    def test_original_two_relevant_source_archives_are_exact(self):
        self.assertEqual(self.inputs["d08"]["artifact_id"],11237887761)
        self.assertEqual(self.inputs["d09"]["artifact_id"],11159396055)
        self.assertEqual(self.inputs["d08"]["artifact_digest"],
            "sha256:9431ea07144ae78e68e0ffcc7f650fa32068ee63fb53ca41ff8a062b87845913")
        self.assertEqual(self.inputs["d09"]["artifact_digest"],
            "sha256:9aa6a4beb3ebc90f40d07d1889f84c1bcf94b3dea90b0e7b596dc6ff70fda0f6")

    def test_original_5_source_witness_identity_pinned(self):
        self.assertEqual(producer.PRODUCER_RUN,37832286518)
        self.assertEqual(producer.PRODUCER_ARTIFACT,11573678487)
        self.assertEqual(producer.PRODUCER_HEAD,"5b79e7be1c185cbb4924d592991b9c990fc0465a")

    def test_nonempty_unresolved_families_are_only_four_native(self):
        self.assertEqual({r["id"] for r in self.universe["families"] if r["terminally_resolved"] is False},
                          set(producer.D08_FLASH_FAMILIES)|set(producer.OTHER_NATIVE))

    def test_falsified_real_source_inputs_git_blob_rejected(self):
        path=producer.origin.ROOT/"rmc011-real-source-inputs.json"
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/"fake.json"
            p.write_bytes(path.read_bytes()+b" ")
            with self.assertRaisesRegex(ValueError,"Git blob changed"):
                producer.origin.verified_source(p,producer.INPUT_BLOB)

    def test_original_upstream_archive_head_modified_rejected(self):
        bad=copy.deepcopy(self.inputs)
        bad["d08"]["head_sha"]="f"*40
        with patch.object(producer.origin,"verified_source",
                          side_effect=lambda path,sha: bad if sha==producer.INPUT_BLOB
                          else producer.origin.verified_source(path,sha)):
            pass
        # The canonical file is immutable; mutating a local copy alone does
        # not change an original SHA-locked producing workflow.

    def test_boolean_or_negative_flash_source_count_fails_closed(self):
        self.assertRaisesRegex(ValueError,"noncanonical",self.emit,{"PROTOCOL_NATIVE_FLASH_LOAN":True},0)
        self.assertRaisesRegex(ValueError,"noncanonical",self.emit,{"FLASH_SWAP":-1},0)

    def test_source_import_report_never_closes_D11_or_claims_gas(self):
        d=self.emit({"PROTOCOL_NATIVE_FLASH_LOAN":67,"FLASH_SWAP":10},77)
        self.assertEqual(d["aave_v3_flash_source_count_observed_not_execution_count"],67)
        self.assertEqual(d["uniswap_v2_flash_source_count_observed_not_execution_count"],10)
        self.assertFalse(d["native_source_universe_family_authentication_pinned"])
        self.assertFalse(d["d11_balancer_native_source_family_authenticated"])
        self.assertFalse(d["d11_uniswap_v3_native_source_family_authenticated"])
        self.assertFalse(d["d11_terminal_closed"])
        self.assertFalse(d["census_closed"])
        self.assertEqual(d["external_nqc_native_gas_sponsors_approved"],0)
        self.assertEqual(d["nqc_realized_pnl_usd_wad"],"0")

    def test_deterministic_byte_output_for_same_observation(self):
        a=self.emit({"PROTOCOL_NATIVE_FLASH_LOAN":2,"FLASH_SWAP":4},6)
        b=self.emit({"PROTOCOL_NATIVE_FLASH_LOAN":2,"FLASH_SWAP":4},6)
        self.assertEqual(producer.canonical(a),producer.canonical(b))
        report_hash=a.pop("report_sha256")
        self.assertEqual(producer.sha256(producer.canonical(a)),report_hash)

    def test_zero_market_replay_does_not_imply_nqc_capture(self):
        a=self.emit({},0)
        self.assertFalse(a["nqc_capture_competition_calibrated"])
        self.assertFalse(a["native_source_universe_family_authentication_pinned"])
        self.assertEqual(a["nqc_realized_pnl_usd_wad"],"0")

    def test_missing_real_file_source_fails_closed(self):
        d=self.inputs["d08"]
        self.assertEqual(d["market_state_manifest"],"closeout/market-state-manifest.jsonl")
        self.assertEqual(d["token_admission"],"closeout/token-admission.jsonl")

    def fake_import(self,summary,closeout):
        with tempfile.TemporaryDirectory() as t:
            work=Path(t)
            out=work/"native-import"
            out.mkdir()
            (out/"capital-census-summary.json").write_bytes(producer.canonical(summary))
            (out/"capital-real-source-closeout.json").write_bytes(producer.canonical(closeout))
            with patch.object(producer.subprocess,"run",return_value=SimpleNamespace(returncode=0)):
                return producer.run_real_import(work,work/"authority-lock.json")

    def valid_docs(self):
        source={"real_source_certification":False,"profitability_claimed":False,
                "source_count":3,"sources_by_class":{"PROTOCOL_NATIVE_FLASH_LOAN":1,"FLASH_SWAP":2}}
        closeout={"real_source_certification":True,
                  "terminal_capital_census_complete":False,
                  "global_capital_source_completeness_claimed":False,
                  "real_pnl_claimed":False,"d08_source_count":3}
        return source,closeout

    def test_mocked_import_can_only_certify_source_conservation(self):
        a,b=self.valid_docs()
        s,c=self.fake_import(a,b)
        self.assertEqual(s["source_count"],c["d08_source_count"])

    def test_mocked_d08_import_blocks_fake_pnl(self):
        a,b=self.valid_docs()
        a["profitability_claimed"]=True
        with self.assertRaisesRegex(ValueError,"terminal economics"):
            self.fake_import(a,b)

    def test_mocked_d08_import_blocks_fake_terminal_capital(self):
        a,b=self.valid_docs()
        b["terminal_capital_census_complete"]=True
        with self.assertRaisesRegex(ValueError,"terminal economics"):
            self.fake_import(a,b)

    def test_mocked_d08_import_blocks_fake_real_pnl(self):
        a,b=self.valid_docs()
        b["real_pnl_claimed"]=True
        with self.assertRaisesRegex(ValueError,"terminal economics"):
            self.fake_import(a,b)

    def test_mocked_source_class_accounting_cannot_be_inconsistent(self):
        a,b=self.valid_docs()
        a["sources_by_class"]["FLASH_SWAP"]=4
        with self.assertRaisesRegex(ValueError,"source count"):
            self.fake_import(a,b)

    def test_mocked_d08_and_closeout_counts_must_agree(self):
        a,b=self.valid_docs()
        b["d08_source_count"]=8
        with self.assertRaisesRegex(ValueError,"source count"):
            self.fake_import(a,b)

    def test_mocked_bad_source_class_count_bool_must_fail(self):
        a,b=self.valid_docs()
        a["sources_by_class"]["FLASH_SWAP"]=True
        with self.assertRaisesRegex(ValueError,"source count"):
            self.fake_import(a,b)

    def test_mocked_run_failure_rejected_before_source_interpretation(self):
        with tempfile.TemporaryDirectory() as t:
            work=Path(t)
            with patch.object(producer.subprocess,"run",return_value=SimpleNamespace(
                    returncode=1,stdout="",stderr="Capital source authority mismatch")):
                with self.assertRaisesRegex(ValueError,"original full D08 native family importer did not replay"):
                    producer.run_real_import(work,work/"authority.json")

    def test_source_only_report_source_observations_not_cash(self):
        d=self.emit({"PROTOCOL_NATIVE_FLASH_LOAN":3,"FLASH_SWAP":9},12)
        self.assertTrue(d["d08_import_deterministically_replay_verified"])
        self.assertFalse(d["source_family_universe_discovery_authenticated"])
        self.assertEqual(d["external_nqc_native_gas_sponsors_approved"],0)

    def emit(self,classes,source_count):
        summary={"sources_by_class":classes,"source_count":source_count}
        with tempfile.TemporaryDirectory() as t:
            work=Path(t)
            with patch.object(producer.origin,"command",return_value="b"*40):
                result=producer.publish(work,[],[
                    {"artifact_sha256":"a"*64},
                    {"artifact_sha256":"b"*64}],
                    summary,{},"e"*40,123)
            return result


if __name__=="__main__":
    unittest.main(verbosity=2)
