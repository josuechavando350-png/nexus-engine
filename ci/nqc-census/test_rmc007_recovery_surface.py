#!/usr/bin/env python3
"""Synthetic workflow-contract regressions; these tests do not certify chain data."""
import copy
import hashlib
import tempfile
import unittest
from pathlib import Path

from verify_rmc007_recovery_surface import (
    GENESIS, SurfaceError, load_json, verify_closeout, verify_surface,
)

NUMBER = 26095351
HASH = "0x0d7a15fbb72e69696a33c65bc20902fe08e5630862ada64b065a97405c70c781"


def fixture():
    def h(number, digit, parent, timestamp):
        return {"number": number, "hash": "0x" + digit * 64,
                "parent_hash": "0x" + parent * 64,
                "state_root": "0x" + "f" * 64, "timestamp": timestamp}
    anchor = h(NUMBER, "a", "b", 300)
    anchor["hash"] = HASH
    bootstrap = {"schema": "nqc-census-chain-bootstrap-report-v1", "anchor": {"anchor": anchor},
                 "chain_domain": {"chain_id": 1, "genesis_hash": GENESIS,
                                  "lineage_block": 1920000, "lineage_hash": "0x" + "c" * 64,
                                  "fork_lineage": "0x" + "d" * 64}}
    factory = "0x" + "1" * 40
    runtime = "2" * 64
    creation_header = h(10000835, "3", "4", 200)
    predecessor_header = h(10000834, "4", "5", 199)
    def historical(header, length, digest):
        return {"block": header["number"], "hash": header["hash"],
                "parent_hash": header["parent_hash"], "anchor": header,
                "code_len": length, "code_sha256": digest}
    current = {"schema": "nqc-rmc-007-v2-current-surface-v1", "status": "CURRENT_SURFACE_PASS",
               "bootstrap": bootstrap, "facts": {"factory": factory, "factory_runtime_sha256": runtime,
               "pair_count": 523424, "first_index": 0, "last_index": 523423}}
    boundary = {"schema": "nqc-rmc-007-v2-factory-boundary-v1", "status": "FACTORY_BOUNDARY_PASS",
                "bootstrap": copy.deepcopy(bootstrap), "factory": factory, "first_code_block": 10000835,
                "predecessor_block": 10000834, "proof": {"account": factory, "first_code_block": 10000835,
                "search_interval": [1, NUMBER], "boundary": historical(creation_header, 13859, runtime),
                "predecessor": historical(predecessor_header, 0, hashlib.sha256(b"").hexdigest())}}
    return current, boundary


class RecoverySurfaceTests(unittest.TestCase):
    def setUp(self):
        self.current, self.boundary = fixture()

    def check(self):
        return verify_surface(self.current, self.boundary, NUMBER, HASH)

    def test_current_anchor_and_legitimate_historical_creation_are_distinct(self):
        self.assertEqual(self.check(), 523424)

    def test_pair_count_is_derived_not_an_a0_or_a1_constant(self):
        for count in (1, 514624, 523424, 1000000):
            with self.subTest(count=count):
                self.current["facts"].update(pair_count=count, last_index=count - 1)
                self.assertEqual(self.check(), count)

    def test_wrong_observation_anchor(self):
        self.current["bootstrap"]["anchor"]["anchor"]["number"] -= 1
        with self.assertRaises(SurfaceError): self.check()

    def test_missing_typed_anchor_cannot_be_replaced_by_decoy_fields(self):
        del self.current["bootstrap"]["anchor"]
        self.current["decoy"] = {"block_number": NUMBER, "block_hash": HASH}
        with self.assertRaises(SurfaceError): self.check()

    def test_mixed_anchor_header(self):
        for key, value in (("timestamp", 301), ("state_root", "0x" + "9" * 64),
                           ("parent_hash", "0x" + "8" * 64)):
            with self.subTest(key=key):
                self.setUp()
                self.boundary["bootstrap"]["anchor"]["anchor"][key] = value
                with self.assertRaises(SurfaceError): self.check()

    def test_mixed_chain_domain(self):
        self.boundary["bootstrap"]["chain_domain"]["fork_lineage"] = "0x" + "7" * 64
        with self.assertRaises(SurfaceError): self.check()

    def test_wrong_chain_even_if_both_reports_agree(self):
        for report in (self.current, self.boundary):
            report["bootstrap"]["chain_domain"]["chain_id"] = 10
        with self.assertRaises(SurfaceError): self.check()

    def test_missing_or_nonpass_schema_status(self):
        for report, key in ((self.current, "schema"), (self.boundary, "status")):
            with self.subTest(key=key):
                saved = report.pop(key)
                with self.assertRaises(SurfaceError): self.check()
                report[key] = saved

    def test_invalid_integer_counts(self):
        for value in (True, False, 0, -1, "523424", 523424.0, None, 2**256):
            with self.subTest(value=value):
                self.current["facts"]["pair_count"] = value
                with self.assertRaises(SurfaceError): self.check()

    def test_off_by_one_last_index(self):
        self.current["facts"]["last_index"] += 1
        with self.assertRaises(SurfaceError): self.check()

    def test_boolean_zero_index(self):
        self.current["facts"]["first_index"] = False
        with self.assertRaises(SurfaceError): self.check()

    def test_factory_substitution(self):
        self.boundary["proof"]["account"] = "0x" + "9" * 40
        with self.assertRaises(SurfaceError): self.check()

    def test_historical_parent_discontinuity(self):
        self.boundary["proof"]["boundary"]["parent_hash"] = "0x" + "8" * 64
        with self.assertRaises(SurfaceError): self.check()

    def test_historical_block_alias(self):
        self.boundary["proof"]["boundary"]["anchor"]["number"] = NUMBER
        with self.assertRaises(SurfaceError): self.check()

    def test_runtime_digest_mismatch(self):
        self.boundary["proof"]["boundary"]["code_sha256"] = "6" * 64
        with self.assertRaises(SurfaceError): self.check()

    def test_predecessor_with_existing_code(self):
        self.boundary["proof"]["predecessor"]["code_len"] = 1
        with self.assertRaises(SurfaceError): self.check()

    def test_search_interval_not_bound_to_a1(self):
        self.boundary["proof"]["search_interval"][1] -= 1
        with self.assertRaises(SurfaceError): self.check()

    def test_closeout_uses_observed_count_and_exact_conservation(self):
        verify_closeout("RMC007_CLOSEOUT_PASS pairs=523424 unexplained=0 mismatches=0 records=48 agreement={}\n", self.check())

    def test_a0_count_cannot_close_a1(self):
        with self.assertRaises(SurfaceError):
            verify_closeout("RMC007_CLOSEOUT_PASS pairs=514624 unexplained=0 mismatches=0 records=48 agreement={}", self.check())

    def test_closeout_mismatch_missing_duplicate_or_prefixed_pass(self):
        good = "RMC007_CLOSEOUT_PASS pairs=523424 unexplained=0 mismatches=0 records=48 agreement={}"
        for bad in ("", good + "\n" + good, "UNTRUSTED " + good,
                    good.replace("mismatches=0", "mismatches=1"),
                    good.replace("unexplained=0", "unexplained=1"),
                    good.replace("records=48", "records=47"),
                    good.replace("agreement={}", "agreement=[]"),
                    good.replace("agreement={}", "agreement={")):
            with self.subTest(log=bad):
                with self.assertRaises(SurfaceError): verify_closeout(bad, self.check())

    def test_json_duplicate_keys_and_nonfinite_constants_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "input.json"
            for text in ('{"a":1,"a":2}', '{"a":NaN}', '{"a":Infinity}', '[]', '{'):
                with self.subTest(text=text):
                    path.write_text(text)
                    with self.assertRaises(ValueError): load_json(path)

    def test_contract_checks_survive_python_optimization(self):
        import subprocess
        script = Path(__file__).with_name("verify_rmc007_recovery_surface.py")
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "bad.json"
            path.write_text('{}')
            result = subprocess.run(["python3", "-O", str(script), "--current", str(path),
                                     "--boundary", str(path), "--number", str(NUMBER), "--hash", HASH],
                                    capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn("_PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
