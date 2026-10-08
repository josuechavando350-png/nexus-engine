#!/usr/bin/env python3
"""Negative tests for bounded GH Actions D16 original-ledger recovery.

Synthetic archives in these tests do not represent original market evidence.
"""
from __future__ import annotations

import copy
import io
import tempfile
import unittest
import zipfile
from pathlib import Path

import rmc016_source_artifact_recovery as rec


def row(n=101, name="rmc016-winner-real", digest=None, size=2200, expired=False):
    return {
        "id": n, "run_id": 9000+n, "head_sha": "a"*40,
        "name": name, "digest": digest or "sha256:" + "1"*64,
        "size_in_bytes": size, "expired": expired,
    }


def zip_with(name, content):
    b = io.BytesIO()
    with zipfile.ZipFile(b, "w") as zip_:
        zip_.writestr(name, content)
    return b.getvalue()


class ArtifactRecoveryTests(unittest.TestCase):
    def test_original_D16_git_object_source_is_exact(self):
        source = Path("ci/nqc-census/rmc016-production-evidence.json")
        got = rec.verify_source(source.read_bytes())
        self.assertEqual(got["transaction_economics_sha256"], rec.ORIGINAL_LEDGER_SHA256)
        self.assertEqual(got["definite_transaction_count"], 127)

    def test_source_tamper_does_not_become_authority(self):
        with self.assertRaisesRegex(ValueError, "Git blob"):
            rec.verify_source(b'{}\n')

    def test_zero_unknown_index_is_not_false_zero_evidence(self):
        with self.assertRaisesRegex(ValueError, "missing or oversized"):
            rec.load_index(b"")

    def test_index_duplicate_artifacts_fail_closed(self):
        r = rec.canonical(row())
        with self.assertRaisesRegex(ValueError, "duplicated artifact"):
            rec.load_index(r+r)

    def test_invalid_artifact_id_rejected(self):
        x = row(n=0)
        with self.assertRaisesRegex(ValueError, "malformed"):
            rec.artifact_row(x)

    def test_bool_numeric_ids_rejected(self):
        x = row()
        x["id"] = True
        with self.assertRaisesRegex(ValueError, "malformed"):
            rec.artifact_row(x)

    def test_invalid_original_run_sha_rejected(self):
        x = row()
        x["head_sha"] = "0"*64
        with self.assertRaisesRegex(ValueError, "malformed"):
            rec.artifact_row(x)

    def test_expired_and_oversized_cannot_be_selected(self):
        x = rec.select([
            row(1, expired=True), row(2, size=rec.MAX_ZIP_BYTES+1),
            row(3, name="unrelated-build"),
            row(4),
        ])
        self.assertEqual([v["id"] for v in x["selected"]], [4])
        self.assertTrue(x["no_global_absence_claim"])
        self.assertEqual(x["excluded_expired_or_unverifiable_or_oversized"], 2)

    def test_prioritizes_original_and_economics_artifacts(self):
        x = rec.select([
            row(900, name="rmc015-cohort"), row(11505504820, name="rmc016-capacity"),
            row(77, name="transaction-economics-ledger-source"),
        ])
        self.assertEqual([v["id"] for v in x["selected"]], [77,11505504820,900])

    def test_oversubscribed_search_preserves_unsearched_scope(self):
        x = rec.select([row(1000+i) for i in range(5)],limit=2)
        self.assertEqual(len(x["selected"]), 2)
        self.assertEqual(x["eligible_not_selected_due_to_scan_budget"], 3)
        self.assertFalse(x["all_artifacts_recovered_and_scanned"])

    def test_changed_selection_report_hash_rejected(self):
        x = rec.select([row()])
        x["eligible_unexpired_small_archives"] = 2
        with self.assertRaisesRegex(ValueError, "selection commitment"):
            rec.scan(x, "/anywhere")

    def test_scan_nonmatching_realist_jsonl_stays_not_found(self):
        sample = b'{"transaction_hash":"0x123"}\n'
        zip_ = zip_with("transaction-economics.jsonl", sample)
        x = rec.select([row(digest="sha256:" + rec.sha256(zip_))])
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            (root/"101.zip").write_bytes(zip_)
            r = rec.scan(x, root)
        self.assertFalse(r["original_source_located_in_this_sample"])
        self.assertEqual(r["zip_sha256_authenticated_archives_scanned"], 1)
        self.assertEqual(r["nqc_realized_net_usd_wad"], "0")
        self.assertFalse(r["source_absent_globally_proven"])
        self.assertFalse(r["real_market_census_closed"])

    def test_sha_matched_source_only_after_exact_byte_equality(self):
        sample = b'{"economic_source":1}\n'
        raw = zip_with("subdir/transaction-economics.jsonl", sample)
        matches = rec.scan_zip(raw, rec.sha256(raw), expected_member=rec.sha256(sample))
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0]["original_ledger_sha256"], rec.sha256(sample))

    def test_bogus_github_outer_archive_digest_rejected(self):
        raw = zip_with("transaction-economics.jsonl", b"hello\n")
        with self.assertRaisesRegex(ValueError, "outer SHA256"):
            rec.scan_zip(raw,"0"*64)

    def test_nested_path_traversal_refused(self):
        raw = zip_with("../transaction-economics.jsonl", b"data\n")
        with self.assertRaisesRegex(ValueError, "unsafe"):
            rec.scan_zip(raw,rec.sha256(raw))

    def test_duplicate_zip_member_refused(self):
        b = io.BytesIO()
        with zipfile.ZipFile(b, "w") as a:
            a.writestr("a.jsonl", b"{}\n")
            a.writestr("a.jsonl", b"{}\n")
        raw = b.getvalue()
        with self.assertRaisesRegex(ValueError, "duplicate"):
            rec.scan_zip(raw,rec.sha256(raw))

    def test_no_source_when_archive_missing_is_censored(self):
        x = rec.select([row()])
        r = rec.scan(x, "/directory-does-not-exist")
        self.assertEqual(r["selected_archives_not_scanned"], [101])
        self.assertEqual(r["zip_sha256_authenticated_archives_scanned"], 0)
        self.assertFalse(r["source_absent_globally_proven"])

    def test_report_replay_is_deterministic(self):
        raw = zip_with("source.txt", b"archive")
        x = rec.select([row(digest="sha256:"+rec.sha256(raw))])
        with tempfile.TemporaryDirectory() as temp:
            (Path(temp)/"101.zip").write_bytes(raw)
            first = rec.scan(x,temp)
            second = rec.scan(x,temp)
        self.assertEqual(rec.canonical(first),rec.canonical(second))
        self.assertEqual(first["report_sha256"],
                         rec.sha256(rec.canonical({k:v for k,v in first.items()
                                                   if k!="report_sha256"})))

    def test_gas_and_revenue_are_never_deduced_from_empty_sample(self):
        r = rec.scan(rec.select([row()]),"/nonexistent")
        self.assertFalse(r["nonrecourse_native_gas_funding_authorized"])
        self.assertFalse(r["nqc_capture_probability_calibrated"])
        self.assertFalse(r["original_127_row_economics_certified_by_this_search"])

    def test_malformed_index_digest_is_not_trusted(self):
        x = row()
        x["digest"]="sha256:"+"z"*64
        with self.assertRaisesRegex(ValueError,"malformed"):
            rec.artifact_row(x)

    def test_noncanonical_duplicate_keys_in_index_refused(self):
        raw = b'{"id":101,"id":102}\n'
        with self.assertRaisesRegex(ValueError,"duplicate"):
            rec.load_index(raw)

    def test_archive_zip_slash_filename_rejected(self):
        raw = zip_with("/absolute.jsonl",b"{}\n")
        with self.assertRaisesRegex(ValueError,"unsafe"):
            rec.scan_zip(raw,rec.sha256(raw))

    def test_member_not_an_economic_ledger_cannot_be_claimed(self):
        sample=b'{"arbitrary":"x"}\n'
        raw=zip_with("readme.txt",sample)
        self.assertEqual(rec.scan_zip(raw,rec.sha256(raw),
                                     expected_member=rec.sha256(sample)),[])

    def test_no_invented_100percent_coverage_when_indexed_many(self):
        x=rec.select([row(100+i) for i in range(70)])
        self.assertEqual(x["eligible_not_selected_due_to_scan_budget"],22)
        self.assertTrue(x["unscanned_global_repo_artifacts_may_contain_source"])


if __name__=="__main__":
    unittest.main(verbosity=2)
