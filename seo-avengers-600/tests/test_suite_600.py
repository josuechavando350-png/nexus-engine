from __future__ import annotations

import copy
import json
import unittest

from runtime.catalog import TOTAL_MODULES, module_registry
from runtime.manifest import MODULE_SPECS, TARGET_MODULES, source_to_target_map
from runtime.runner import run_module, run_new_200
from runtime.service import execute_avengers_600
from fixture import rich_payload


class Avengers600Tests(unittest.TestCase):
    def test_registry_is_exactly_600(self):
        registry = module_registry()
        self.assertEqual(TOTAL_MODULES, 600)
        self.assertEqual(list(registry), [f"M{i}" for i in range(1, 601)])
        self.assertNotIn("M601", registry)
        self.assertTrue(all(registry[f"M{i}"]["status"] == "DELEGATED_PRODUCTION" for i in range(1, 401)))
        self.assertTrue(all(registry[f"M{i}"]["status"] == "IMPLEMENTED_PRODUCTION" for i in range(401, 601)))

    def test_source_mapping_is_exact_and_sequential(self):
        mapping = source_to_target_map()
        self.assertEqual(len(mapping), 200)
        self.assertEqual(mapping, {f"M{1401+i}": f"M{401+i}" for i in range(200)})

    def test_200_operations_are_unique(self):
        self.assertEqual(len(MODULE_SPECS), 200)
        self.assertEqual(len({s["operation"] for s in MODULE_SPECS.values()}), 200)
        self.assertEqual(tuple(MODULE_SPECS), TARGET_MODULES)

    def test_all_new_200_execute_successfully(self):
        receipts = run_new_200(rich_payload(), {})
        self.assertEqual(len(receipts), 200)
        self.assertEqual(sum(r["execution_status"] == "SUCCESS" for r in receipts.values()), 200)
        self.assertEqual(len({r["algorithm"] for r in receipts.values()}), 200)
        for module_id, receipt in receipts.items():
            self.assertEqual(receipt["module"], module_id)
            self.assertTrue(receipt["evidence_hash"].startswith("sha256:"))

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        a = run_new_200(payload, {})
        b = run_new_200(copy.deepcopy(payload), {})
        self.assertEqual(json.dumps(a, sort_keys=True, ensure_ascii=False, separators=(",", ":")),
                         json.dumps(b, sort_keys=True, ensure_ascii=False, separators=(",", ":")))

    def test_missing_evidence_is_insufficient_not_fake_no_finding(self):
        receipt = run_module("M401", {}, {})
        self.assertEqual(receipt["execution_status"], "INSUFFICIENT_DATA")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")

    def test_float_is_rejected(self):
        payload = rich_payload(); payload["semantic_eat_records"][0]["rogue_float"] = 0.5
        receipt = run_module("M401", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertEqual(receipt["finding_status"], "NOT_APPLICABLE")
        self.assertIn("floats_not_allowed", receipt["reason_code"])

    def test_conflicting_duplicate_fails_closed(self):
        payload = rich_payload(); row = copy.deepcopy(payload["semantic_eat_records"][0]); conflicting = copy.deepcopy(row)
        conflicting["bio_text"] += " conflict"; payload["semantic_eat_records"].append(conflicting)
        receipt = run_module("M401", payload, {})
        self.assertEqual(receipt["execution_status"], "ERROR")
        self.assertIn("conflicting_duplicate", receipt["reason_code"])

    def test_config_is_hash_bound(self):
        payload = rich_payload(); a = run_module("M401", payload, {}); b = run_module("M401", payload, {"m401_threshold_ppm": 700000})
        self.assertNotEqual(a["module_config_hash"], b["module_config_hash"])
        self.assertNotEqual(a["evidence_hash"], b["evidence_hash"])

    def test_service_is_deny_by_default_and_delegates_first_400(self):
        disabled = execute_avengers_600({}, {})
        self.assertFalse(disabled["enabled"]); self.assertEqual(disabled["delegated_modules"], 400); self.assertEqual(disabled["executed_new_modules"], 0)
        enabled = execute_avengers_600(rich_payload(), {"CONFIG_SEO_AVENGERS_600": True})
        self.assertTrue(enabled["enabled"]); self.assertEqual(enabled["total_modules"], 600)
        self.assertEqual(enabled["delegated_runtime"], "seo-avengers-400"); self.assertEqual(enabled["executed_new_modules"], 200)

    def test_representative_exact_metrics(self):
        payload = rich_payload()
        self.assertEqual(run_module("M402", payload, {})["output"]["metric_ppm"], 1_000_000)
        self.assertEqual(run_module("M426", payload, {})["output"]["metric_ppm"], 1_000_000)
        self.assertEqual(run_module("M451", payload, {})["output"]["metric_ppm"], 1_000_000)
        self.assertEqual(run_module("M476", payload, {})["output"]["metric_ppm"], 1_000_000)
        self.assertEqual(run_module("M600", payload, {})["output"]["metric_ppm"], 1_000_000)


if __name__ == "__main__":
    unittest.main()
