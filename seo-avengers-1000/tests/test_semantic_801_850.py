from __future__ import annotations

import copy
import unittest

from runtime.common import (
    InvalidData,
    _normalize,
    canonical_json,
    hash_value,
    make_receipt,
    select_record,
)
from runtime.semantic_nlp import EVALUATORS, evaluate
from runtime.semantic_specs import SEMANTIC_SPECS, SOURCE_MODULES, TARGET_MODULES
from semantic_fixture import SEMANTIC_ROWS, semantic_payload


class SemanticSliceTests(unittest.TestCase):
    def test_exact_range_and_source_mapping(self) -> None:
        self.assertEqual(TARGET_MODULES, tuple(f"M{i}" for i in range(801, 851)))
        self.assertEqual(SOURCE_MODULES, tuple(f"M{i}" for i in range(1801, 1851)))
        self.assertEqual(len(SEMANTIC_SPECS), 50)
        self.assertEqual(len({s["operation"] for s in SEMANTIC_SPECS.values()}), 50)
        for target, spec in SEMANTIC_SPECS.items():
            self.assertEqual(target, spec["module_id"])
            self.assertEqual(int(spec["source_module"][1:]), int(target[1:]) + 1000)

    def test_all_50_have_executable_evaluator_and_typed_fixture(self) -> None:
        self.assertEqual(set(EVALUATORS), {str(s["operation"]) for s in SEMANTIC_SPECS.values()})
        for module_id, spec in SEMANTIC_SPECS.items():
            row = SEMANTIC_ROWS[module_id]
            for field in spec["input_fields"]:
                self.assertIn(field, row)
            output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
            self.assertEqual(output["violation"], False)
            self.assertGreaterEqual(output["score_ppm"], spec["threshold_ppm"])

    def test_missing_field_is_insufficient_not_no_finding(self) -> None:
        module_id = "M801"
        spec = SEMANTIC_SPECS[module_id]
        row = dict(SEMANTIC_ROWS[module_id])
        row.pop("required_entities")
        with self.assertRaises(Exception) as ctx:
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        self.assertIn("required_entities_missing", str(ctx.exception))

    def test_malformed_bool_as_int_fails_closed(self) -> None:
        module_id = "M804"
        spec = SEMANTIC_SPECS[module_id]
        row = dict(SEMANTIC_ROWS[module_id])
        row["total_claims"] = True
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_ppm_out_of_range_fails_closed(self) -> None:
        module_id = "M841"
        spec = SEMANTIC_SPECS[module_id]
        row = dict(SEMANTIC_ROWS[module_id])
        row["baseline_polarity_ppm"] = 1_000_001
        with self.assertRaises(InvalidData):
            evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))

    def test_target_source_conflict_fails_closed(self) -> None:
        payload = semantic_payload()
        target = copy.deepcopy(SEMANTIC_ROWS["M801"])
        source = copy.deepcopy(target)
        source["module_id"] = "M1801"
        source["aligned_entities"] = ["different"]
        payload["semantic_nlp_records"].append(source)
        with self.assertRaises(InvalidData):
            select_record(payload, "semantic_nlp_records", "M801", "M1801")

    def test_duplicate_conflict_fails_closed(self) -> None:
        payload = semantic_payload()
        duplicate = copy.deepcopy(SEMANTIC_ROWS["M801"])
        duplicate["aligned_entities"] = ["different"]
        payload["semantic_nlp_records"].append(duplicate)
        with self.assertRaises(InvalidData):
            select_record(payload, "semantic_nlp_records", "M801", "M1801")

    def test_float_and_int64_overflow_rejected_nested(self) -> None:
        with self.assertRaises(InvalidData):
            _normalize({"nested": [0.5]})
        with self.assertRaises(InvalidData):
            _normalize({"nested": [2**63]})

    def test_mixed_mapping_keys_fail_closed_as_invalid_data(self) -> None:
        with self.assertRaisesRegex(InvalidData, "mapping_keys_must_be_strings"):
            _normalize({"valid": 1, 2: "invalid"})

    def test_receipt_is_byte_deterministic_and_namespaced(self) -> None:
        spec = SEMANTIC_SPECS["M801"]
        row = SEMANTIC_ROWS["M801"]
        normalized = _normalize(row)
        config = {
            "activation_state": "deny_by_default",
            "threshold_ppm": spec["threshold_ppm"],
            "implementation_mode": "deterministic_evidence_audit_no_external_side_effects",
        }
        output = evaluate(str(spec["operation"]), row, int(spec["threshold_ppm"]))
        args = dict(
            module_id="M801",
            source_module="M1801",
            operation=str(spec["operation"]),
            family=str(spec["family"]),
            raw_row=row,
            normalized_row=normalized,
            module_config=config,
            execution_status="SUCCESS",
            finding_status="NO_FINDING",
            reason_code="POLICY_SATISFIED",
            output=output,
        )
        first = make_receipt(**args)
        second = make_receipt(**args)
        self.assertEqual(canonical_json(first), canonical_json(second))
        self.assertEqual(first["evidence_hash"], second["evidence_hash"])
        self.assertTrue(first["algorithm"].startswith("avengers1000_v1_m801_"))

    def test_output_affecting_config_changes_hash(self) -> None:
        spec = SEMANTIC_SPECS["M801"]
        row = SEMANTIC_ROWS["M801"]
        normalized = _normalize(row)
        base = {
            "activation_state": "deny_by_default",
            "threshold_ppm": spec["threshold_ppm"],
            "implementation_mode": "deterministic_evidence_audit_no_external_side_effects",
        }
        changed = dict(base)
        changed["threshold_ppm"] = int(base["threshold_ppm"]) - 1
        self.assertNotEqual(hash_value(base), hash_value(changed))
        r1 = make_receipt(
            module_id="M801",
            source_module="M1801",
            operation=str(spec["operation"]),
            family=str(spec["family"]),
            raw_row=row,
            normalized_row=normalized,
            module_config=base,
            execution_status="SUCCESS",
            finding_status="NO_FINDING",
            reason_code="POLICY_SATISFIED",
            output=evaluate(str(spec["operation"]), row, int(base["threshold_ppm"])),
        )
        r2 = make_receipt(
            module_id="M801",
            source_module="M1801",
            operation=str(spec["operation"]),
            family=str(spec["family"]),
            raw_row=row,
            normalized_row=normalized,
            module_config=changed,
            execution_status="SUCCESS",
            finding_status="NO_FINDING",
            reason_code="POLICY_SATISFIED",
            output=evaluate(str(spec["operation"]), row, int(changed["threshold_ppm"])),
        )
        self.assertNotEqual(r1["module_config_hash"], r2["module_config_hash"])
        self.assertNotEqual(r1["evidence_hash"], r2["evidence_hash"])


if __name__ == "__main__":
    unittest.main()
