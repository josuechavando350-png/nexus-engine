from __future__ import annotations

import copy
import unittest

from runtime.catalog import module_registry
from runtime.common import InvalidData
from runtime.manifest import MODULE_SPECS
from runtime.neon_store import certify_composition, evaluate
from runtime.relational_specs import RELATIONAL_SPECS, SOURCE_MODULES, TARGET_MODULES
from relational_fixture import RELATIONAL_ROWS, terminal_row


class RelationalSliceTests(unittest.TestCase):
    def test_exact_range_and_source_mapping(self) -> None:
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(951, 1001)))
        self.assertEqual(SOURCE_MODULES, tuple(f"M{i}" for i in range(1951, 2001)))
        self.assertEqual(len(RELATIONAL_SPECS), 50)
        self.assertEqual(len({spec["operation"] for spec in RELATIONAL_SPECS.values()}), 50)

    def test_first_49_are_observational_and_executable(self) -> None:
        for module_id in tuple(f"M{i}" for i in range(951, 1000)):
            spec = RELATIONAL_SPECS[module_id]
            row = RELATIONAL_ROWS[module_id]
            before = copy.deepcopy(row)
            output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
            self.assertFalse(output["violation"], module_id)
            self.assertEqual(row, before)

    def test_m983_key_spec_mismatch_fails_closed(self) -> None:
        spec = RELATIONAL_SPECS["M983"]
        row = dict(RELATIONAL_ROWS["M983"])
        row["record_spec_module_id"] = "M982"
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_m1000_certifies_exact_internal_composition(self) -> None:
        row = terminal_row(MODULE_SPECS)
        output = certify_composition(row, module_registry(), MODULE_SPECS)
        self.assertFalse(output["violation"])
        self.assertEqual(output["catalog_module_count"], 1000)
        self.assertEqual(output["delegated_module_count"], 800)
        self.assertEqual(output["implemented_module_count"], 200)
        self.assertEqual(output["source_mapping_count"], 200)
        self.assertEqual(output["operation_count"], 200)
        self.assertTrue(str(output["composition_hash"]).startswith("sha256:"))

    def test_m1000_fails_missing_delegated_proof(self) -> None:
        row = terminal_row(MODULE_SPECS)
        row["delegated_modules"] = row["delegated_modules"][:-1]
        with self.assertRaises(InvalidData):
            certify_composition(row, module_registry(), MODULE_SPECS)

    def test_m1000_fails_extra_catalog_module(self) -> None:
        row = terminal_row(MODULE_SPECS)
        row["observed_catalog_modules"].append("M1001")
        with self.assertRaises(InvalidData):
            certify_composition(row, module_registry(), MODULE_SPECS)

    def test_m1000_fails_wrong_source_map(self) -> None:
        row = terminal_row(MODULE_SPECS)
        row["observed_source_map"][0] = "M1801->M802"
        with self.assertRaises(InvalidData):
            certify_composition(row, module_registry(), MODULE_SPECS)

    def test_m1000_rejects_m1001_in_internal_registry(self) -> None:
        row = terminal_row(MODULE_SPECS)
        registry = module_registry()
        registry["M1001"] = {"module": "M1001"}
        with self.assertRaisesRegex(InvalidData, "M1001_forbidden"):
            certify_composition(row, registry, MODULE_SPECS)

    def test_m1000_rejects_operation_collision(self) -> None:
        row = terminal_row(MODULE_SPECS)
        specs = {key: dict(value) for key, value in MODULE_SPECS.items()}
        specs["M802"]["operation"] = specs["M801"]["operation"]
        row["observed_operation_names"][1] = row["observed_operation_names"][0]
        with self.assertRaisesRegex(InvalidData, "operation_collision"):
            certify_composition(row, module_registry(), specs)

    def test_m1000_composition_hash_is_deterministic(self) -> None:
        row = terminal_row(MODULE_SPECS)
        first = certify_composition(row, module_registry(), MODULE_SPECS)
        second = certify_composition(copy.deepcopy(row), module_registry(), MODULE_SPECS)
        self.assertEqual(first["composition_hash"], second["composition_hash"])


if __name__ == "__main__":
    unittest.main()
