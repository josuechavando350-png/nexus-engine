#!/usr/bin/env python3
"""Synthetic archive regressions; not a Census or on-chain certificate."""
import hashlib
from pathlib import Path
import stat
import tempfile
import unittest
import warnings
import zipfile
import verify_rmc007_recovery_archive as verify


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.archive = self.root / "evidence.zip"
        self.out = self.root / "out"

    def package(self, entries):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)
            with zipfile.ZipFile(self.archive, "w") as z:
                for name, value in entries:
                    z.writestr(name, value)
        return hashlib.sha256(self.archive.read_bytes()).hexdigest()

    def test_authenticated_archive_preserves_exact_bytes(self):
        sha = self.package([("store/STORE", b"\x00\xff"), ("facts.json", b"{}\n")])
        verify.unpack(self.archive, "sha256:" + sha, self.out)
        self.assertEqual((self.out / "store/STORE").read_bytes(), b"\x00\xff")
        self.assertEqual((self.out / "facts.json").read_bytes(), b"{}\n")

    def test_wrong_zero_or_uppercase_digest_rejected_before_extraction(self):
        sha = self.package([("facts.json", b"{}")])
        for value in ("1" * 64, "0" * 64, sha.upper()):
            with self.assertRaises(verify.InvalidEvidence):
                verify.unpack(self.archive, value, self.out)
            self.assertFalse(self.out.exists())

    def test_nonempty_destination_is_unchanged(self):
        sha = self.package([("facts.json", b"{}")])
        self.out.mkdir()
        (self.out / "keep").write_bytes(b"unchanged")
        with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)
        self.assertEqual((self.out / "keep").read_bytes(), b"unchanged")

    def test_traversal_absolute_backslash_and_drive_paths_rejected(self):
        for name in ("../outside", "/outside", "a/../../outside", "a//b", "./a", "a\\b", "C:/x"):
            with self.subTest(name=name):
                sha = self.package([(name, b"x")])
                with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)
                self.assertFalse(self.out.exists())

    def test_duplicate_and_file_directory_collisions_rejected(self):
        for entries in ([('a', b'1'), ('a', b'2')], [('a', b'1'), ('a/b', b'2')],
                        [('a/b', b'2'), ('a', b'1')], [('a/', b''), ('a', b'1')]):
            sha = self.package(entries)
            with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)
            self.assertFalse(self.out.exists())

    def test_symlink_member_or_destination_rejected(self):
        info = zipfile.ZipInfo("link")
        info.create_system = 3
        info.external_attr = (stat.S_IFLNK | 0o777) << 16
        sha = self.package([(info, b"target")])
        with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)
        self.out.symlink_to(self.root / "other")
        sha = self.package([("plain", b"x")])
        with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)

    def test_corrupt_zip_never_promotes_partial_evidence(self):
        self.package([("first", b"unique-payload-12345"), ("second", b"second")])
        data = self.archive.read_bytes().replace(b"unique-payload-12345", b"broken-payload-12345", 1)
        self.archive.write_bytes(data)
        with self.assertRaises(zipfile.BadZipFile):
            verify.unpack(self.archive, hashlib.sha256(data).hexdigest(), self.out)
        self.assertFalse(self.out.exists())
        self.assertFalse(list(self.root.glob("rmc007-unpack-*")))

    def test_empty_archive_is_rejected(self):
        sha = self.package([])
        with self.assertRaises(verify.InvalidEvidence): verify.unpack(self.archive, sha, self.out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
