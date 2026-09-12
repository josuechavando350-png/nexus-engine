from __future__ import annotations

import copy
import unittest

from runtime.common import InvalidData, select_record
from runtime.html_specs import HTML_SPECS, SOURCE_MODULES, TARGET_MODULES
from runtime.site_bootstrap import REQUIRED_FIELDS, evaluate
from html_fixture import HTML_ROWS, html_payload


class HtmlSliceTests(unittest.TestCase):
    def test_exact_range_and_source_mapping(self) -> None:
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(851, 901)))
        self.assertEqual(SOURCE_MODULES, tuple(f"M{i}" for i in range(1851, 1901)))
        self.assertEqual(len(HTML_SPECS), 50)
        self.assertEqual(len({spec["operation"] for spec in HTML_SPECS.values()}), 50)
        for target, spec in HTML_SPECS.items():
            self.assertEqual(target, spec["module_id"])
            self.assertEqual(int(spec["source_module"][1:]), int(target[1:]) + 1000)

    def test_all_50_are_observational_and_executable(self) -> None:
        self.assertEqual(set(REQUIRED_FIELDS), {str(spec["operation"]) for spec in HTML_SPECS.values()})
        for module_id, spec in HTML_SPECS.items():
            row = HTML_ROWS[module_id]
            before = copy.deepcopy(row)
            output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
            self.assertFalse(output["violation"])
            self.assertEqual(row, before)

    def test_impossible_ratio_is_error(self) -> None:
        spec = HTML_SPECS["M859"]
        row = dict(HTML_ROWS["M859"])
        row["quoted_attribute_count"] = 11
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_bad_digest_format_is_error(self) -> None:
        spec = HTML_SPECS["M878"]
        row = dict(HTML_ROWS["M878"])
        row["observed_document_digest"] = "not-a-sha"
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_duplicate_target_source_conflict_is_error(self) -> None:
        payload = html_payload()
        source = copy.deepcopy(HTML_ROWS["M851"])
        source["module_id"] = "M1851"
        source["valid_chunk_boundary_count"] = 9
        payload["html_stream_records"].append(source)
        with self.assertRaises(InvalidData):
            select_record(payload, "html_stream_records", "M851", "M1851")

    def test_findings_are_real_not_constant_success(self) -> None:
        spec = HTML_SPECS["M854"]
        row = dict(HTML_ROWS["M854"])
        row["canonical_tag_count"] = 2
        output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        self.assertTrue(output["violation"])
        self.assertEqual(output["score_ppm"], 0)


if __name__ == "__main__":
    unittest.main()
