#!/usr/bin/env python3
"""Offline adversarial evidence-discovery tests: real byte hashes, no invented ledger."""
import gzip
import hashlib
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
P=Path(__file__).with_name("rmc016_snapshot_evidence_finder.py")
S=importlib.util.spec_from_file_location("finder",P)
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)

class SnapshotRecoveryTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.root=Path(t.name)
        self.data=b'{"one":"historical-observation"}\n'
        self.sha=hashlib.sha256(self.data).hexdigest()
        self.targets={"D16_TRANSACTION_ECONOMICS":self.sha}
    def scan(self):
        return M.find([str(self.root)],targets=self.targets,max_bytes=1024*1024)
    def test_exact_source_file_found(self):
        (self.root/"source.jsonl").write_bytes(self.data)
        a=self.scan()
        self.assertEqual(a["found_target_labels"],["D16_TRANSACTION_ECONOMICS"])
        self.assertEqual(a["matches"]["D16_TRANSACTION_ECONOMICS"][0]["container_kind"],"file")
        self.assertFalse(a["source_replay_completed"])
        self.assertFalse(a["terminal_authority"])
        self.assertFalse(a["nexus_profitability_proven"])
    def test_forged_or_changed_byte_rejected(self):
        (self.root/"source.jsonl").write_bytes(self.data+b'\n')
        a=self.scan()
        self.assertEqual(a["found_target_labels"],[])
        self.assertEqual(a["status"],"RMC016_ORIGINAL_SOURCE_BYTES_NOT_FOUND")
    def test_zip_member_must_match_raw_sha(self):
        with zipfile.ZipFile(self.root/"bundle.zip","w") as z:
            z.writestr("archive/transaction-economics.jsonl",self.data)
            z.writestr("other.bin",b"unrelated")
        a=self.scan()
        matches=a["matches"]["D16_TRANSACTION_ECONOMICS"]
        self.assertEqual(len(matches),1)
        self.assertEqual(matches[0]["container_kind"],"zip_member")
        self.assertEqual(matches[0]["archive_member"],"archive/transaction-economics.jsonl")
    def test_gzip_member_must_match_decompressed_bytes(self):
        with gzip.open(self.root/"bundle.jsonl.gz","wb") as f:f.write(self.data)
        a=self.scan()
        matches=a["matches"]["D16_TRANSACTION_ECONOMICS"]
        self.assertEqual(len(matches),1)
        self.assertEqual(matches[0]["container_kind"],"gzip_uncompressed")
    def test_two_copies_are_not_silently_deduped(self):
        (self.root/"a.jsonl").write_bytes(self.data)
        (self.root/"b.jsonl").write_bytes(self.data)
        a=self.scan()
        self.assertEqual(len(a["matches"]["D16_TRANSACTION_ECONOMICS"]),2)
    def test_symlink_file_not_followed(self):
        original=self.root/"not-in-root"
        original.write_bytes(self.data)
        (self.root/"symlink.jsonl").symlink_to(original)
        original.rename(self.root/".env")
        a=self.scan()
        self.assertEqual(a["found_target_labels"],[])
    def test_sensitive_dotenv_skipped(self):
        (self.root/".env").write_bytes(self.data)
        (self.root/"config.pem").write_bytes(self.data)
        a=self.scan()
        self.assertEqual(a["found_target_labels"],[])
    def test_ignored_git_and_node_modules(self):
        for name in [".git","node_modules",".ssh"]:
            p=self.root/name
            p.mkdir()
            (p/"objects.jsonl").write_bytes(self.data)
        self.assertEqual(self.scan()["found_target_labels"],[])
    def test_zip_path_traversal_fail_closed(self):
        with zipfile.ZipFile(self.root/"bundle.zip","w") as z:
            z.writestr("../escaped.jsonl",self.data)
        a=self.scan()
        self.assertEqual(a["found_target_labels"],[])
        self.assertEqual(a["file_errors"][0]["error_class"],"ValueError")
    def test_corrupt_archive_is_recorded_not_admitted(self):
        (self.root/"bundle.zip").write_bytes(b"not-a-ZIP")
        a=self.scan()
        self.assertEqual(a["found_target_labels"],[])
        self.assertEqual(a["file_errors"][0]["error_class"],"BadZipFile")
    def test_missing_root_rejected(self):
        with self.assertRaises(ValueError):
            M.find([],targets=self.targets)
    def test_duplicate_roots_rejected(self):
        with self.assertRaises(ValueError):
            M.find([str(self.root),str(self.root)],targets=self.targets)
    def test_deterministic_order_and_commitment(self):
        (self.root/"b.jsonl").write_bytes(self.data)
        (self.root/"a.jsonl").write_bytes(self.data)
        a,b=self.scan(),self.scan()
        self.assertEqual(M.canonical(a),M.canonical(b))
        self.assertEqual(a["matches"]["D16_TRANSACTION_ECONOMICS"][0]["relative_path"],"a.jsonl")
    def test_max_bytes_limits_decompression(self):
        with gzip.open(self.root/"bundle.jsonl.gz","wb") as f:
            f.write(b"x"*8192)
        a=M.find([str(self.root)],targets=self.targets,max_bytes=40)
        self.assertEqual(a["found_target_labels"],[])
        self.assertTrue(a["file_errors"])
    def test_raw_contents_never_appear_in_report(self):
        (self.root/"a.jsonl").write_bytes(self.data)
        a=self.scan()
        self.assertNotIn(self.data.decode().strip(),M.canonical(a).decode())
        self.assertTrue(a["source_digest_only_not_semantic_evidence"])

if __name__=="__main__":
    unittest.main()
