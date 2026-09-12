from __future__ import annotations

import copy
import unittest

from runtime.catalog import module_registry
from runtime.common import canonical_json
from runtime.manifest import MODULE_SPECS, SOURCE_MODULES, TARGET_MODULES, source_to_target_map
from runtime.runner import run_module
from runtime.service import execute_avengers_1000
from fixture import full_payload


class Suite1000Tests(unittest.TestCase):
    def test_exact_manifest_and_source_map(self) -> None:
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(801, 1001)))
        self.assertEqual(SOURCE_MODULES, tuple(f"M{i}" for i in range(1801, 2001)))
        self.assertEqual(len(MODULE_SPECS), 200)
        self.assertEqual(len({spec["operation"] for spec in MODULE_SPECS.values()}), 200)
        mapping = source_to_target_map()
        for source in SOURCE_MODULES:
            self.assertEqual(mapping[source], f"M{int(source[1:]) - 1000}")

    def test_catalog_is_exactly_m001_m1000(self) -> None:
        registry = module_registry()
        self.assertEqual(tuple(registry), tuple(f"M{i}" for i in range(1, 1001)))
        self.assertNotIn("M1001", registry)
        for number in range(1, 801):
            entry = registry[f"M{number}"]
            self.assertEqual(entry["status"], "DELEGATED_PRODUCTION")
            self.assertEqual(entry["delegated_runtime"], "seo-avengers-800")
            self.assertFalse(entry["executable_here"])
        for number in range(801, 1001):
            entry = registry[f"M{number}"]
            self.assertEqual(entry["status"], "IMPLEMENTED_PRODUCTION")
            self.assertTrue(entry["executable_here"])

    def test_deny_by_default_executes_no_new_modules(self) -> None:
        result = execute_avengers_1000(full_payload(), {})
        self.assertFalse(result["enabled"])
        self.assertEqual(result["delegated_modules"], 800)
        self.assertEqual(result["executed_new_modules"], 0)
        self.assertEqual(result["receipts"], {})

    def test_enabled_executes_exactly_200_typed_fixtures(self) -> None:
        result = execute_avengers_1000(full_payload(), {"CONFIG_SEO_AVENGERS_1000": True})
        self.assertTrue(result["enabled"])
        self.assertEqual(result["executed_new_modules"], 200)
        self.assertEqual(tuple(result["receipts"]), TARGET_MODULES)
        for module_id, receipt in result["receipts"].items():
            self.assertEqual(receipt["execution_status"], "SUCCESS", module_id)
            self.assertEqual(receipt["finding_status"], "NO_FINDING", module_id)
            self.assertTrue(receipt["algorithm"].startswith(f"avengers1000_v1_{module_id.lower()}_"))

    def test_missing_evidence_is_insufficient_data(self) -> None:
        payload = full_payload()
        payload["semantic_nlp_records"] = [
            row for row in payload["semantic_nlp_records"] if row["module_id"] != "M801"
        ]
        receipt = run_module("M801", payload, {})
        self.assertEqual(receipt["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")

    def test_malformed_evidence_is_error(self) -> None:
        payload = full_payload()
        for row in payload["semantic_nlp_records"]:
            if row["module_id"] == "M804":
                row["total_claims"] = True
        receipt = run_module("M804", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")

    def test_enabled_run_is_byte_deterministic(self) -> None:
        payload = full_payload()
        config = {"CONFIG_SEO_AVENGERS_1000": True}
        first = execute_avengers_1000(payload, config)
        second = execute_avengers_1000(copy.deepcopy(payload), dict(config))
        self.assertEqual(canonical_json(first["receipts"]), canonical_json(second["receipts"]))

    def test_valid_config_change_is_bound_to_receipt(self) -> None:
        payload = full_payload()
        base = run_module("M801", payload, {})
        changed = run_module("M801", payload, {"m801_threshold_ppm": 899999})
        self.assertNotEqual(base["module_config_hash"], changed["module_config_hash"])
        self.assertNotEqual(base["evidence_hash"], changed["evidence_hash"])

    def test_terminal_cannot_self_certify_without_prior_receipts(self) -> None:
        receipt = run_module("M1000", full_payload(), {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["reason_code"], "prior_receipts_required")

    def test_terminal_threshold_cannot_be_relaxed(self) -> None:
        receipt = run_module("M1000", full_payload(), {"m1000_threshold_ppm": 999999})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")
        self.assertEqual(receipt["reason_code"], "m1000_threshold_immutable")


if __name__ == "__main__":
    unittest.main()
