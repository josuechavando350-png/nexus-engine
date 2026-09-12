from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

RELATIONAL_ROWS: Sequence[Tuple[str, Sequence[str], int]] = (
    ('primary_key_presence_coverage', ('row_count', 'rows_with_primary_key'), 1000000),
    ('unique_constraint_violation_resistance', ('row_count', 'unique_constraint_violation_count'), 1000000),
    ('foreign_key_resolution_coverage', ('foreign_key_count', 'resolved_foreign_key_count'), 990000),
    ('orphan_record_resistance', ('row_count', 'orphan_record_count'), 1000000),
    ('nullability_contract_coverage', ('checked_value_count', 'valid_nullability_value_count'), 990000),
    ('row_digest_integrity', ('expected_row_digest', 'observed_row_digest'), 1000000),
    ('schema_version_consistency', ('expected_schema_version', 'observed_schema_version'), 1000000),
    ('migration_sequence_monotonicity', ('migration_step_count', 'ordered_migration_step_count'), 1000000),
    ('transaction_id_uniqueness', ('transaction_count', 'unique_transaction_id_count'), 1000000),
    ('write_audit_completeness', ('write_event_count', 'audited_write_event_count'), 1000000),
    ('source_record_linkage_coverage', ('source_record_count', 'linked_source_record_count'), 990000),
    ('evidence_timestamp_order_validity', ('timestamp_pair_count', 'ordered_timestamp_pair_count'), 1000000),
    ('partition_key_coverage', ('row_count', 'rows_with_partition_key'), 1000000),
    ('index_reference_coverage', ('reference_count', 'indexed_reference_count'), 950000),
    ('relation_cardinality_consistency', ('relation_count', 'cardinality_valid_relation_count'), 1000000),
    ('participant_cardinality_match', ('expected_participant_count', 'confirmed_participant_count'), 1000000),
    ('dataset_row_count_consistency', ('expected_row_count', 'observed_row_count'), 1000000),
    ('record_checksum_coverage', ('row_count', 'rows_with_valid_checksum'), 1000000),
    ('canonical_key_normalization', ('key_count', 'normalized_key_count'), 1000000),
    ('enum_value_validity_coverage', ('enum_value_count', 'valid_enum_value_count'), 1000000),
    ('boolean_field_type_integrity', ('boolean_field_count', 'valid_boolean_field_count'), 1000000),
    ('numeric_range_validity_coverage', ('numeric_value_count', 'in_range_numeric_value_count'), 1000000),
    ('text_encoding_validity_coverage', ('text_value_count', 'valid_encoding_text_value_count'), 1000000),
    ('json_shape_validity_coverage', ('json_record_count', 'valid_shape_json_record_count'), 1000000),
    ('duplicate_key_resistance', ('key_count', 'duplicate_key_count'), 1000000),
    ('stale_snapshot_resistance', ('snapshot_count', 'stale_snapshot_count'), 950000),
    ('replica_row_digest_parity', ('primary_replica_digest', 'secondary_replica_digest'), 1000000),
    ('logical_sequence_contiguity', ('sequence_edge_count', 'contiguous_sequence_edge_count'), 1000000),
    ('reference_graph_acyclicity', ('graph_edge_count', 'cycle_edge_count'), 1000000),
    ('source_target_row_parity', ('source_row_digest', 'target_row_digest'), 1000000),
    ('expected_column_coverage', ('expected_columns', 'observed_columns'), 1000000),
    ('unexpected_column_resistance', ('observed_column_count', 'unexpected_column_count'), 1000000),
    ('key_spec_module_consistency', ('record_key_module_id', 'record_spec_module_id'), 1000000),
    ('receipt_module_linkage_coverage', ('receipt_count', 'linked_receipt_count'), 1000000),
    ('evidence_hash_format_coverage', ('receipt_count', 'valid_evidence_hash_count'), 1000000),
    ('config_hash_format_coverage', ('receipt_count', 'valid_config_hash_count'), 1000000),
    ('source_module_linkage_coverage', ('receipt_count', 'valid_source_module_link_count'), 1000000),
    ('operation_name_presence_coverage', ('receipt_count', 'named_operation_count'), 1000000),
    ('execution_status_domain_coverage', ('receipt_count', 'valid_execution_status_count'), 1000000),
    ('finding_status_domain_coverage', ('receipt_count', 'valid_finding_status_count'), 1000000),
    ('reason_code_presence_coverage', ('receipt_count', 'reason_code_count'), 1000000),
    ('output_object_shape_coverage', ('receipt_count', 'valid_output_object_count'), 1000000),
    ('receipt_schema_version_consistency', ('receipt_count', 'schema_version_match_count'), 1000000),
    ('algorithm_namespace_coverage', ('receipt_count', 'namespace_match_count'), 1000000),
    ('batch_source_map_coverage', ('expected_source_mappings', 'observed_source_mappings'), 1000000),
    ('delegated_module_proof_coverage', ('expected_delegated_count', 'confirmed_delegated_count'), 1000000),
    ('implemented_module_proof_coverage', ('expected_implemented_count', 'confirmed_implemented_count'), 1000000),
    ('no_extra_module_resistance', ('catalog_module_count', 'unexpected_module_count'), 1000000),
    ('terminal_input_completeness', ('required_terminal_fields', 'observed_terminal_fields'), 1000000),
    ('terminal_composition_certifier', ('delegated_runtime', 'delegated_modules', 'observed_catalog_modules', 'observed_source_map', 'observed_operation_names'), 1000000),
)

RELATIONAL_SPECS: Dict[str, Dict[str, Any]] = {}
for offset, (operation, fields, threshold_ppm) in enumerate(RELATIONAL_ROWS):
    target_number = 951 + offset
    source_number = target_number + 1000
    module_id = f"M{target_number}"
    RELATIONAL_SPECS[module_id] = {
        "module_id": module_id,
        "source_module": f"M{source_number}",
        "family": "RELATIONAL_TERMINAL",
        "operation": operation,
        "dataset_key": "relational_evidence_records",
        "input_fields": tuple(fields),
        "threshold_ppm": threshold_ppm,
    }

TARGET_MODULES = tuple(f"M{i}" for i in range(951, 1001))
SOURCE_MODULES = tuple(f"M{i}" for i in range(1951, 2001))

if tuple(RELATIONAL_SPECS) != TARGET_MODULES:
    raise RuntimeError("relational target range drift")
if {spec["source_module"] for spec in RELATIONAL_SPECS.values()} != set(SOURCE_MODULES):
    raise RuntimeError("relational source range drift")
if len({spec["operation"] for spec in RELATIONAL_SPECS.values()}) != 50:
    raise RuntimeError("relational operation collision")
for target, spec in RELATIONAL_SPECS.items():
    if target != spec["module_id"]:
        raise RuntimeError("relational key/spec mismatch")
    if int(spec["source_module"][1:]) != int(target[1:]) + 1000:
        raise RuntimeError("relational source mapping drift")
    threshold = spec["threshold_ppm"]
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise RuntimeError("relational threshold range")
    fields = spec["input_fields"]
    if not fields or len(fields) != len(set(fields)) or any(not isinstance(field, str) or not field for field in fields):
        raise RuntimeError("relational input field contract invalid")
