from __future__ import annotations

import copy
import unittest

from runtime.common import InvalidData, select_record
from runtime.edge_specs import EDGE_SPECS, SOURCE_MODULES, TARGET_MODULES
from runtime.main import REQUIRED_FIELDS, evaluate
from edge_fixture import EDGE_ROWS, edge_payload


class EdgeSliceTests(unittest.TestCase):
    def test_exact_range_and_source_mapping(self) -> None:
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(901, 951)))
        self.assertEqual(SOURCE_MODULES, tuple(f"M{i}" for i in range(1901, 1951)))
        self.assertEqual(len(EDGE_SPECS), 50)
        self.assertEqual(len({spec["operation"] for spec in EDGE_SPECS.values()}), 50)

    def test_all_50_are_observational_and_executable(self) -> None:
        self.assertEqual(set(REQUIRED_FIELDS), {str(spec["operation"]) for spec in EDGE_SPECS.values()})
        for module_id, spec in EDGE_SPECS.items():
            row = EDGE_ROWS[module_id]
            before = copy.deepcopy(row)
            output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
            self.assertFalse(output["violation"])
            self.assertEqual(row, before)

    def test_crawler_content_parity_is_symmetric(self) -> None:
        spec = EDGE_SPECS["M948"]
        row = dict(EDGE_ROWS["M948"])
        first = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        swapped = dict(row)
        swapped["human_body_bytes"], swapped["crawler_body_bytes"] = row["crawler_body_bytes"], row["human_body_bytes"]
        second = evaluate(str(spec["operation"]), swapped, int(spec["threshold_ppm"]))
        self.assertEqual(first, second)

    def test_crawler_difference_is_finding_not_special_content(self) -> None:
        spec = EDGE_SPECS["M942"]
        row = dict(EDGE_ROWS["M942"])
        row["crawler_status"] = 403
        output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        self.assertTrue(output["violation"])
        self.assertEqual(output["score_ppm"], 0)

    def test_identity_evidence_is_only_coincidence_score(self) -> None:
        spec = EDGE_SPECS["M940"]
        row = dict(EDGE_ROWS["M940"])
        row["coincident_signal_count"] = 1
        output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        self.assertTrue(output["violation"])
        self.assertNotIn("definitive_identity", output)

    def test_impossible_cookie_coverage_fails_closed(self) -> None:
        spec = EDGE_SPECS["M928"]
        row = dict(EDGE_ROWS["M928"])
        row["secure_cookie_count"] = 3
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_target_source_conflict_fails_closed(self) -> None:
        payload = edge_payload()
        source = copy.deepcopy(EDGE_ROWS["M901"])
        source["module_id"] = "M1901"
        source["secondary_status"] = 201
        payload["edge_perimeter_records"].append(source)
        with self.assertRaises(InvalidData):
            select_record(payload, "edge_perimeter_records", "M901", "M1901")


if __name__ == "__main__":
    unittest.main()
