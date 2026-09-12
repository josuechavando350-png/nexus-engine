from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import (
    PPM,
    InvalidData,
    bounded_ratio_ppm,
    complement_ppm,
    coverage_ppm,
    exact_text_match_ppm,
    hash_value,
    need_int,
    need_sha256,
    need_str,
    need_str_list,
    validate_required_fields,
)
from .relational_specs import RELATIONAL_SPECS

REQUIRED_FIELDS = {
    str(spec["operation"]): tuple(spec["input_fields"])
    for spec in RELATIONAL_SPECS.values()
}


def _result(score: int, threshold_ppm: int, **extra: Any) -> Dict[str, Any]:
    if isinstance(score, bool) or not isinstance(score, int) or not 0 <= score <= PPM:
        raise InvalidData("relational_score_out_of_range")
    if isinstance(threshold_ppm, bool) or not isinstance(threshold_ppm, int) or not 0 <= threshold_ppm <= PPM:
        raise InvalidData("threshold_ppm_out_of_range")
    out: Dict[str, Any] = {
        "score_ppm": score,
        "threshold_ppm": threshold_ppm,
        "violation": score < threshold_ppm,
    }
    out.update(extra)
    return out


def _require_exact_sequence(name: str, observed: list[str], expected: tuple[str, ...]) -> None:
    if len(observed) != len(set(observed)):
        raise InvalidData(f"{name}_contains_duplicates")
    if tuple(observed) != expected:
        raise InvalidData(f"{name}_mismatch")


def certify_composition(
    row: Mapping[str, Any],
    registry: Mapping[str, Mapping[str, Any]],
    module_specs: Mapping[str, Mapping[str, Any]],
) -> Dict[str, Any]:
    expected_catalog = tuple(f"M{i}" for i in range(1, 1001))
    expected_new = tuple(f"M{i}" for i in range(801, 1001))
    expected_delegated = tuple(f"M{i}" for i in range(1, 801))
    expected_sources = tuple(f"M{i}" for i in range(1801, 2001))

    if "M1001" in registry:
        raise InvalidData("M1001_forbidden")
    if tuple(registry) != expected_catalog:
        raise InvalidData("catalog_range_drift")
    if tuple(module_specs) != expected_new:
        raise InvalidData("implemented_range_drift")

    operations: list[str] = []
    source_map: list[str] = []
    sources: list[str] = []
    for module_id in expected_new:
        spec = module_specs[module_id]
        if spec.get("module_id") != module_id:
            raise InvalidData(f"module_key_spec_mismatch:{module_id}")
        source = spec.get("source_module")
        operation = spec.get("operation")
        if not isinstance(source, str) or not isinstance(operation, str):
            raise InvalidData(f"module_spec_shape:{module_id}")
        if int(source[1:]) != int(module_id[1:]) + 1000:
            raise InvalidData(f"source_mapping_drift:{module_id}")
        sources.append(source)
        operations.append(operation)
        source_map.append(f"{source}->{module_id}")

    if tuple(sources) != expected_sources:
        raise InvalidData("source_range_drift")
    if len(set(operations)) != 200:
        raise InvalidData("operation_collision")

    for module_id in expected_delegated:
        entry = registry[module_id]
        if entry.get("status") != "DELEGATED_PRODUCTION":
            raise InvalidData(f"delegated_status_drift:{module_id}")
        if entry.get("delegated_runtime") != "seo-avengers-800":
            raise InvalidData(f"delegated_runtime_drift:{module_id}")
        if entry.get("executable_here") is not False:
            raise InvalidData(f"delegated_execution_drift:{module_id}")
    for module_id in expected_new:
        entry = registry[module_id]
        if entry.get("status") != "IMPLEMENTED_PRODUCTION":
            raise InvalidData(f"implemented_status_drift:{module_id}")
        if entry.get("executable_here") is not True:
            raise InvalidData(f"implemented_execution_drift:{module_id}")

    delegated_runtime = need_str(row, "delegated_runtime")
    if delegated_runtime != "seo-avengers-800":
        raise InvalidData("delegated_runtime_evidence_mismatch")
    delegated_modules = need_str_list(row, "delegated_modules")
    observed_catalog = need_str_list(row, "observed_catalog_modules")
    observed_source_map = need_str_list(row, "observed_source_map")
    observed_operations = need_str_list(row, "observed_operation_names")

    _require_exact_sequence("delegated_modules", delegated_modules, expected_delegated)
    _require_exact_sequence("observed_catalog_modules", observed_catalog, expected_catalog)
    _require_exact_sequence("observed_source_map", observed_source_map, tuple(source_map))
    _require_exact_sequence("observed_operation_names", observed_operations, tuple(operations))

    descriptor = {
        "catalog_modules": list(expected_catalog),
        "delegated_runtime": "seo-avengers-800",
        "delegated_modules": list(expected_delegated),
        "implemented_modules": list(expected_new),
        "source_map": source_map,
        "operations": operations,
    }
    composition_hash = hash_value(descriptor)
    return {
        "score_ppm": PPM,
        "threshold_ppm": PPM,
        "violation": False,
        "composition_hash": composition_hash,
        "catalog_module_count": 1000,
        "delegated_module_count": 800,
        "implemented_module_count": 200,
        "source_mapping_count": 200,
        "operation_count": 200,
    }


def evaluate(
    operation: str,
    row: Mapping[str, Any],
    threshold_ppm: int,
    *,
    registry: Mapping[str, Mapping[str, Any]] | None = None,
    module_specs: Mapping[str, Mapping[str, Any]] | None = None,
) -> Dict[str, Any]:
    fields = REQUIRED_FIELDS.get(operation)
    if fields is None:
        raise InvalidData(f"unsupported_relational_operation:{operation}")
    validate_required_fields(row, fields)

    if operation == "terminal_composition_certifier":
        if registry is None or module_specs is None:
            raise InvalidData("terminal_composition_context_required")
        return certify_composition(row, registry, module_specs)
    if operation == "primary_key_presence_coverage":
        score = bounded_ratio_ppm(need_int(row, "rows_with_primary_key", minimum=0), need_int(row, "row_count", minimum=1))
    elif operation == "unique_constraint_violation_resistance":
        total = need_int(row, "row_count", minimum=1); bad = need_int(row, "unique_constraint_violation_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "foreign_key_resolution_coverage":
        score = bounded_ratio_ppm(need_int(row, "resolved_foreign_key_count", minimum=0), need_int(row, "foreign_key_count", minimum=1))
    elif operation == "orphan_record_resistance":
        total = need_int(row, "row_count", minimum=1); bad = need_int(row, "orphan_record_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "nullability_contract_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_nullability_value_count", minimum=0), need_int(row, "checked_value_count", minimum=1))
    elif operation == "row_digest_integrity":
        score = PPM if need_sha256(row, "expected_row_digest") == need_sha256(row, "observed_row_digest") else 0
    elif operation == "schema_version_consistency":
        score = PPM if need_int(row, "expected_schema_version", minimum=1) == need_int(row, "observed_schema_version", minimum=1) else 0
    elif operation == "migration_sequence_monotonicity":
        score = bounded_ratio_ppm(need_int(row, "ordered_migration_step_count", minimum=0), need_int(row, "migration_step_count", minimum=1))
    elif operation == "transaction_id_uniqueness":
        score = bounded_ratio_ppm(need_int(row, "unique_transaction_id_count", minimum=0), need_int(row, "transaction_count", minimum=1))
    elif operation == "write_audit_completeness":
        score = bounded_ratio_ppm(need_int(row, "audited_write_event_count", minimum=0), need_int(row, "write_event_count", minimum=1))
    elif operation == "source_record_linkage_coverage":
        score = bounded_ratio_ppm(need_int(row, "linked_source_record_count", minimum=0), need_int(row, "source_record_count", minimum=1))
    elif operation == "evidence_timestamp_order_validity":
        score = bounded_ratio_ppm(need_int(row, "ordered_timestamp_pair_count", minimum=0), need_int(row, "timestamp_pair_count", minimum=1))
    elif operation == "partition_key_coverage":
        score = bounded_ratio_ppm(need_int(row, "rows_with_partition_key", minimum=0), need_int(row, "row_count", minimum=1))
    elif operation == "index_reference_coverage":
        score = bounded_ratio_ppm(need_int(row, "indexed_reference_count", minimum=0), need_int(row, "reference_count", minimum=1))
    elif operation == "relation_cardinality_consistency":
        score = bounded_ratio_ppm(need_int(row, "cardinality_valid_relation_count", minimum=0), need_int(row, "relation_count", minimum=1))
    elif operation == "participant_cardinality_match":
        score = PPM if need_int(row, "expected_participant_count", minimum=0) == need_int(row, "confirmed_participant_count", minimum=0) else 0
    elif operation == "dataset_row_count_consistency":
        score = PPM if need_int(row, "expected_row_count", minimum=0) == need_int(row, "observed_row_count", minimum=0) else 0
    elif operation == "record_checksum_coverage":
        score = bounded_ratio_ppm(need_int(row, "rows_with_valid_checksum", minimum=0), need_int(row, "row_count", minimum=1))
    elif operation == "canonical_key_normalization":
        score = bounded_ratio_ppm(need_int(row, "normalized_key_count", minimum=0), need_int(row, "key_count", minimum=1))
    elif operation == "enum_value_validity_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_enum_value_count", minimum=0), need_int(row, "enum_value_count", minimum=1))
    elif operation == "boolean_field_type_integrity":
        score = bounded_ratio_ppm(need_int(row, "valid_boolean_field_count", minimum=0), need_int(row, "boolean_field_count", minimum=1))
    elif operation == "numeric_range_validity_coverage":
        score = bounded_ratio_ppm(need_int(row, "in_range_numeric_value_count", minimum=0), need_int(row, "numeric_value_count", minimum=1))
    elif operation == "text_encoding_validity_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_encoding_text_value_count", minimum=0), need_int(row, "text_value_count", minimum=1))
    elif operation == "json_shape_validity_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_shape_json_record_count", minimum=0), need_int(row, "json_record_count", minimum=1))
    elif operation == "duplicate_key_resistance":
        total = need_int(row, "key_count", minimum=1); bad = need_int(row, "duplicate_key_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "stale_snapshot_resistance":
        total = need_int(row, "snapshot_count", minimum=1); bad = need_int(row, "stale_snapshot_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "replica_row_digest_parity":
        score = PPM if need_sha256(row, "primary_replica_digest") == need_sha256(row, "secondary_replica_digest") else 0
    elif operation == "logical_sequence_contiguity":
        score = bounded_ratio_ppm(need_int(row, "contiguous_sequence_edge_count", minimum=0), need_int(row, "sequence_edge_count", minimum=1))
    elif operation == "reference_graph_acyclicity":
        total = need_int(row, "graph_edge_count", minimum=1); bad = need_int(row, "cycle_edge_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "source_target_row_parity":
        score = PPM if need_sha256(row, "source_row_digest") == need_sha256(row, "target_row_digest") else 0
    elif operation == "expected_column_coverage":
        score = coverage_ppm(need_str_list(row, "expected_columns"), need_str_list(row, "observed_columns"))
    elif operation == "unexpected_column_resistance":
        total = need_int(row, "observed_column_count", minimum=1); bad = need_int(row, "unexpected_column_count", minimum=0); score = complement_ppm(bounded_ratio_ppm(bad, total))
    elif operation == "key_spec_module_consistency":
        key_module = need_str(row, "record_key_module_id")
        spec_module = need_str(row, "record_spec_module_id")
        if key_module != spec_module:
            raise InvalidData("key_spec_module_mismatch")
        score = PPM
    elif operation == "receipt_module_linkage_coverage":
        score = bounded_ratio_ppm(need_int(row, "linked_receipt_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "evidence_hash_format_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_evidence_hash_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "config_hash_format_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_config_hash_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "source_module_linkage_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_source_module_link_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "operation_name_presence_coverage":
        score = bounded_ratio_ppm(need_int(row, "named_operation_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "execution_status_domain_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_execution_status_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "finding_status_domain_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_finding_status_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "reason_code_presence_coverage":
        score = bounded_ratio_ppm(need_int(row, "reason_code_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "output_object_shape_coverage":
        score = bounded_ratio_ppm(need_int(row, "valid_output_object_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "receipt_schema_version_consistency":
        score = bounded_ratio_ppm(need_int(row, "schema_version_match_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "algorithm_namespace_coverage":
        score = bounded_ratio_ppm(need_int(row, "namespace_match_count", minimum=0), need_int(row, "receipt_count", minimum=1))
    elif operation == "batch_source_map_coverage":
        score = coverage_ppm(need_str_list(row, "expected_source_mappings"), need_str_list(row, "observed_source_mappings"))
    elif operation == "delegated_module_proof_coverage":
        score = PPM if need_int(row, "expected_delegated_count", minimum=0) == need_int(row, "confirmed_delegated_count", minimum=0) else 0
    elif operation == "implemented_module_proof_coverage":
        score = PPM if need_int(row, "expected_implemented_count", minimum=0) == need_int(row, "confirmed_implemented_count", minimum=0) else 0
    elif operation == "no_extra_module_resistance":
        count = need_int(row, "catalog_module_count", minimum=0); unexpected = need_int(row, "unexpected_module_count", minimum=0); score = PPM if count == 1000 and unexpected == 0 else 0
    elif operation == "terminal_input_completeness":
        score = coverage_ppm(need_str_list(row, "required_terminal_fields"), need_str_list(row, "observed_terminal_fields"))
    else:
        raise InvalidData(f"unsupported_relational_operation:{operation}")
    return _result(score, threshold_ppm)
