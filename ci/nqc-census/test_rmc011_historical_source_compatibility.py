#!/usr/bin/env python3
"""Offline adversarial historical/current scope and workflow regressions."""
from __future__ import annotations

import copy
import hashlib
import os
from pathlib import Path
import re
import subprocess
import tempfile
import unittest

import rmc011_historical_source_compatibility as gate

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_ROOT = Path(os.environ.get("RMC011_WORKFLOW_ROOT", ROOT))
WORKFLOWS = (
    "nqc-rmc011-seven-original-source-pins.yml",
    "nqc-rmc011-two-original-debt-source-pins.yml",
)


class HistoricalCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.historical = gate.HISTORICAL_FIXTURE.read_bytes()
        cls.current = (ROOT / "ci/nqc-census/rmc011-capital-source-universe.json").read_bytes()

    def edited_current(self, family, key, value):
        doc = gate.decode(self.current)
        row = next(row for row in doc["families"] if row["id"] == family)
        row[key] = value
        return gate.canonical(doc)

    def test_historical_fixture_is_exact_original_blob(self):
        self.assertEqual(gate.gitblob(self.historical), "c1b9f136a13f220af9dceaae50e5caa3105121eb")

    def test_original_nine_family_state_remains_compatible(self):
        report = gate.audit(self.historical, self.historical)
        self.assertEqual(len(report["historical_family_rows_verified_unchanged"]), 9)

    def test_current_registry_preserves_original_nine_rows(self):
        report = gate.audit(self.historical, self.current)
        self.assertEqual(report["historical_replay"]["resolved_family_count"], 9)
        self.assertEqual(report["historical_replay"]["unresolved_family_count"], 4)
        current = gate.decode(self.current)
        self.assertEqual(report["current_registry_observation_only"]["resolved_family_count"],
                         sum(row["terminally_resolved"] is True for row in current["families"]))

    def test_current_native_resolution_does_not_rewrite_historical_counts(self):
        doc = gate.decode(self.historical)
        for row in doc["families"]:
            if row["id"] in gate.NATIVE:
                row["terminally_resolved"] = True
        report = gate.audit(self.historical, gate.canonical(doc))
        self.assertEqual(report["current_registry_observation_only"]["resolved_family_count"], 13)
        self.assertEqual(report["historical_replay"]["resolved_family_count"], 9)
        self.assertEqual(report["historical_replay"]["unresolved_family_count"], 4)
        self.assertFalse(report["current_global_discovery_authenticated_by_this_audit"])

    def test_current_global_discovery_is_separate_from_historical_proof(self):
        doc = gate.decode(self.current)
        doc["status"] = "CAPITAL_SOURCE_UNIVERSE_COMPLETE"
        doc["terminal_claim_allowed"] = True
        doc["family_universe_discovery"] = {"status": "AUTHENTICATED_COMPLETE"}
        report = gate.audit(self.historical, gate.canonical(doc))
        self.assertEqual(report["historical_replay"]["family_universe_discovery_status"], "NOT_CERTIFIED")
        self.assertFalse(report["historical_replay"]["terminal_claim_allowed"])
        self.assertFalse(report["current_global_discovery_authenticated_by_this_audit"])
        self.assertFalse(report["d11_terminal_closed_by_this_audit"])
        self.assertFalse(report["real_market_census_closed_by_this_audit"])

    def test_wrong_historical_blob_even_whitespace_fails(self):
        with self.assertRaisesRegex(ValueError, "historical.*Git blob drift"):
            gate.audit(self.historical + b"\n", self.current)

    def test_current_registry_cannot_substitute_for_historical_blob(self):
        changed = gate.decode(self.historical)
        changed["families"][0]["terminally_resolved"] = True
        with self.assertRaisesRegex(ValueError, "historical.*Git blob drift"):
            gate.audit(gate.canonical(changed), self.current)

    def test_missing_historical_family_fails(self):
        doc = gate.decode(self.historical)
        doc["families"] = [row for row in doc["families"] if row["id"] != "PERSISTENT_DEBT"]
        with self.assertRaisesRegex(ValueError, "historical.*Git blob drift"):
            gate.audit(gate.canonical(doc), self.current)

    def test_altered_historical_provenance_fails(self):
        doc = gate.decode(self.historical)
        doc["families"][4]["resolution_evidence"]["run_id"] += 1
        with self.assertRaisesRegex(ValueError, "historical.*Git blob drift"):
            gate.audit(gate.canonical(doc), self.current)

    def test_missing_each_original_current_family_fails(self):
        for family in gate.BOUNDED | gate.DEBT:
            with self.subTest(family=family):
                doc = gate.decode(self.current)
                doc["families"] = [row for row in doc["families"] if row["id"] != family]
                with self.assertRaisesRegex(ValueError, "thirteen named"):
                    gate.audit(self.historical, gate.canonical(doc))

    def test_every_original_family_status_source_and_type_change_fails(self):
        for family in gate.BOUNDED | gate.DEBT:
            for key, value in (("status", "AUTHENTICATED_REAL_SOURCE"),
                               ("real_source_path", "replacement"),
                               ("capital_class", "replacement"),
                               ("terminally_resolved", 1),
                               ("terminally_resolved", False),
                               ("resolution_evidence", None)):
                with self.subTest(family=family, key=key, value=value):
                    with self.assertRaisesRegex(ValueError, "binding changed"):
                        gate.audit(self.historical, self.edited_current(family, key, value))

    def test_every_original_family_provenance_field_is_immutable(self):
        for family in gate.BOUNDED | gate.DEBT:
            doc = gate.decode(self.current)
            row = next(row for row in doc["families"] if row["id"] == family)
            for key in row["resolution_evidence"]:
                with self.subTest(family=family, provenance=key):
                    changed = copy.deepcopy(row["resolution_evidence"])
                    changed[key] = 1 if type(changed[key]) is int else "replacement"
                    with self.assertRaisesRegex(ValueError, "binding changed"):
                        gate.audit(self.historical, self.edited_current(family, "resolution_evidence", changed))

    def test_family_row_addition_and_missing_field_fail(self):
        for add in (True, False):
            doc = gate.decode(self.current)
            row = next(row for row in doc["families"] if row["id"] == "EXTERNAL_GAS_SPONSOR")
            if add:
                row["new_claim"] = True
            else:
                del row["capital_class"]
            with self.assertRaisesRegex(ValueError, "binding changed"):
                gate.audit(self.historical, gate.canonical(doc))

    def test_duplicate_and_unexpected_current_families_fail(self):
        for identity in ("PERSISTENT_DEBT", "FABRICATED_FAMILY"):
            doc = gate.decode(self.current)
            doc["families"][0]["id"] = identity
            with self.assertRaisesRegex(ValueError, "family identities"):
                gate.audit(self.historical, gate.canonical(doc))

    def test_wrong_schema_stage_and_contract_fail(self):
        for key, value in (("schema_version", True), ("schema_version", 3),
                           ("stage", "RMC-014"), ("contract", "OTHER")):
            doc = gate.decode(self.current)
            doc[key] = value
            with self.assertRaisesRegex(ValueError, "schema, stage or contract"):
                gate.audit(self.historical, gate.canonical(doc))

    def test_duplicate_json_keys_fail(self):
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            gate.audit(self.historical, b'{"families":[],"families":[]}')

    def test_malformed_current_discovery_declaration_fails(self):
        doc = gate.decode(self.current)
        doc["family_universe_discovery"] = None
        with self.assertRaisesRegex(ValueError, "discovery declaration"):
            gate.audit(self.historical, gate.canonical(doc))

    def test_nonfinite_json_fails(self):
        with self.assertRaisesRegex(ValueError, "non-finite"):
            gate.audit(self.historical, b'{"value":NaN}')

    def test_report_is_deterministic_self_hashed_and_inputs_unchanged(self):
        before = (self.historical, self.current)
        first = gate.audit(*before)
        second = gate.audit(*before)
        self.assertEqual(gate.canonical(first), gate.canonical(second))
        digest = first.pop("report_sha256")
        self.assertEqual(hashlib.sha256(gate.canonical(first)).hexdigest(), digest)
        self.assertEqual(before, (self.historical, self.current))

    def test_cli_is_append_only_and_does_not_mutate_inputs(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "compatibility.json"
            command = ["python3", str(Path(gate.__file__)), "--out", str(path),
                       "--current-source-universe", str(ROOT / "ci/nqc-census/rmc011-capital-source-universe.json")]
            subprocess.run(command, check=True, capture_output=True)
            report = path.read_bytes()
            repeat = subprocess.run(command, capture_output=True)
            self.assertNotEqual(repeat.returncode, 0)
            self.assertEqual(path.read_bytes(), report)
            self.assertEqual(gate.HISTORICAL_FIXTURE.read_bytes(), self.historical)
            self.assertEqual((ROOT / "ci/nqc-census/rmc011-capital-source-universe.json").read_bytes(), self.current)


class HistoricalWorkflowTests(unittest.TestCase):
    def workflows(self):
        for name in WORKFLOWS:
            yield name, (WORKFLOW_ROOT / ".github/workflows" / name).read_text()

    def test_current_validation_is_separate_and_not_pinned_to_historical_blob(self):
        for name, workflow in self.workflows():
            with self.subTest(workflow=name):
                self.assertNotIn('git hash-object ci/nqc-census/rmc011-capital-source-universe.json', workflow)
                self.assertIn('python3 ci/nqc-census/verify-rmc011-capital-source-universe.py\n', workflow)
                # Current global verification reads current scope/implementation
                # files; it must never be rerun on the isolated old universe.
                self.assertEqual(workflow.count('python3 ci/nqc-census/verify-rmc011-capital-source-universe.py'), 1)
                self.assertIn('python3 ci/nqc-census/rmc011_historical_source_compatibility.py', workflow)
                self.assertIn('python3 ci/nqc-census/test_rmc011_historical_source_compatibility.py -v', workflow)

    def test_original_producers_run_only_in_explicit_historical_replay(self):
        for name, workflow in self.workflows():
            with self.subTest(workflow=name):
                self.assertIn('cp -a ci/nqc-census "$WORK/private/historical/ci/"', workflow)
                self.assertIn('"$WORK/private/historical/ci/nqc-census/rmc011-capital-source-universe.json"', workflow)
                self.assertRegex(workflow, r'cd "\$(?:WORK|ROOT)/private/historical"\n')
                self.assertIn("([.families[]|select(.terminally_resolved==true)]|length)==9", workflow)
                self.assertIn("([.families[]|select(.terminally_resolved==false)]|length)==4", workflow)
                self.assertIn('historical-current-compatibility.json', workflow)

    def test_new_guard_fixture_and_tests_trigger_both_workflows(self):
        for name, workflow in self.workflows():
            with self.subTest(workflow=name):
                for path in ("rmc011_historical_source_compatibility.py",
                             "test_rmc011_historical_source_compatibility.py",
                             "fixtures/rmc011-source-universe-nine-original-pins.json"):
                    self.assertIn("      - 'ci/nqc-census/" + path + "'", workflow)
                self.assertNotIn("continue-on-error", workflow)

    def test_every_workflow_bash_block_parses(self):
        for name, workflow in self.workflows():
            for index, block in enumerate(re.findall(r"        run: \|\n((?:          .*\n|\n)+)", workflow)):
                with self.subTest(workflow=name, block=index):
                    shell = "\n".join(line[10:] for line in block.splitlines())
                    shell = re.sub(r"\$\{\{.*?\}\}", "test-head", shell)
                    result = subprocess.run(["bash", "-n"], input=shell, text=True, capture_output=True)
                    self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
