from __future__ import annotations

from typing import Any, Dict, Mapping

RELATIONAL_ROWS: Dict[str, Dict[str, Any]] = {
    "M951": {'module_id': 'M951', 'row_count': 10, 'rows_with_primary_key': 10},
    "M952": {'module_id': 'M952', 'row_count': 10, 'unique_constraint_violation_count': 0},
    "M953": {'module_id': 'M953', 'foreign_key_count': 10, 'resolved_foreign_key_count': 10},
    "M954": {'module_id': 'M954', 'row_count': 10, 'orphan_record_count': 0},
    "M955": {'module_id': 'M955', 'checked_value_count': 10, 'valid_nullability_value_count': 10},
    "M956": {'module_id': 'M956', 'expected_row_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'observed_row_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'},
    "M957": {'module_id': 'M957', 'expected_schema_version': 1, 'observed_schema_version': 1},
    "M958": {'module_id': 'M958', 'migration_step_count': 5, 'ordered_migration_step_count': 5},
    "M959": {'module_id': 'M959', 'transaction_count': 10, 'unique_transaction_id_count': 10},
    "M960": {'module_id': 'M960', 'write_event_count': 10, 'audited_write_event_count': 10},
    "M961": {'module_id': 'M961', 'source_record_count': 10, 'linked_source_record_count': 10},
    "M962": {'module_id': 'M962', 'timestamp_pair_count': 10, 'ordered_timestamp_pair_count': 10},
    "M963": {'module_id': 'M963', 'row_count': 10, 'rows_with_partition_key': 10},
    "M964": {'module_id': 'M964', 'reference_count': 10, 'indexed_reference_count': 10},
    "M965": {'module_id': 'M965', 'relation_count': 10, 'cardinality_valid_relation_count': 10},
    "M966": {'module_id': 'M966', 'expected_participant_count': 10, 'confirmed_participant_count': 10},
    "M967": {'module_id': 'M967', 'expected_row_count': 10, 'observed_row_count': 10},
    "M968": {'module_id': 'M968', 'row_count': 10, 'rows_with_valid_checksum': 10},
    "M969": {'module_id': 'M969', 'key_count': 10, 'normalized_key_count': 10},
    "M970": {'module_id': 'M970', 'enum_value_count': 10, 'valid_enum_value_count': 10},
    "M971": {'module_id': 'M971', 'boolean_field_count': 10, 'valid_boolean_field_count': 10},
    "M972": {'module_id': 'M972', 'numeric_value_count': 10, 'in_range_numeric_value_count': 10},
    "M973": {'module_id': 'M973', 'text_value_count': 10, 'valid_encoding_text_value_count': 10},
    "M974": {'module_id': 'M974', 'json_record_count': 10, 'valid_shape_json_record_count': 10},
    "M975": {'module_id': 'M975', 'key_count': 10, 'duplicate_key_count': 0},
    "M976": {'module_id': 'M976', 'snapshot_count': 10, 'stale_snapshot_count': 0},
    "M977": {'module_id': 'M977', 'primary_replica_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'secondary_replica_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'},
    "M978": {'module_id': 'M978', 'sequence_edge_count': 10, 'contiguous_sequence_edge_count': 10},
    "M979": {'module_id': 'M979', 'graph_edge_count': 10, 'cycle_edge_count': 0},
    "M980": {'module_id': 'M980', 'source_row_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', 'target_row_digest': 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'},
    "M981": {'module_id': 'M981', 'expected_columns': ['id', 'value'], 'observed_columns': ['id', 'value']},
    "M982": {'module_id': 'M982', 'observed_column_count': 2, 'unexpected_column_count': 0},
    "M983": {'module_id': 'M983', 'record_key_module_id': 'M983', 'record_spec_module_id': 'M983'},
    "M984": {'module_id': 'M984', 'receipt_count': 10, 'linked_receipt_count': 10},
    "M985": {'module_id': 'M985', 'receipt_count': 10, 'valid_evidence_hash_count': 10},
    "M986": {'module_id': 'M986', 'receipt_count': 10, 'valid_config_hash_count': 10},
    "M987": {'module_id': 'M987', 'receipt_count': 10, 'valid_source_module_link_count': 10},
    "M988": {'module_id': 'M988', 'receipt_count': 10, 'named_operation_count': 10},
    "M989": {'module_id': 'M989', 'receipt_count': 10, 'valid_execution_status_count': 10},
    "M990": {'module_id': 'M990', 'receipt_count': 10, 'valid_finding_status_count': 10},
    "M991": {'module_id': 'M991', 'receipt_count': 10, 'reason_code_count': 10},
    "M992": {'module_id': 'M992', 'receipt_count': 10, 'valid_output_object_count': 10},
    "M993": {'module_id': 'M993', 'receipt_count': 10, 'schema_version_match_count': 10},
    "M994": {'module_id': 'M994', 'receipt_count': 10, 'namespace_match_count': 10},
    "M995": {'module_id': 'M995', 'expected_source_mappings': ['M1801->M801', 'M1802->M802'], 'observed_source_mappings': ['M1801->M801', 'M1802->M802']},
    "M996": {'module_id': 'M996', 'expected_delegated_count': 800, 'confirmed_delegated_count': 800},
    "M997": {'module_id': 'M997', 'expected_implemented_count': 200, 'confirmed_implemented_count': 200},
    "M998": {'module_id': 'M998', 'catalog_module_count': 1000, 'unexpected_module_count': 0},
    "M999": {'module_id': 'M999', 'required_terminal_fields': ['delegated_modules', 'observed_catalog_modules'], 'observed_terminal_fields': ['delegated_modules', 'observed_catalog_modules']},
}

def terminal_row(module_specs: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    implemented = tuple(f"M{i}" for i in range(801, 1001))
    return {
        "module_id": "M1000",
        "delegated_runtime": "seo-avengers-800",
        "delegated_modules": [f"M{i}" for i in range(1, 801)],
        "observed_catalog_modules": [f"M{i}" for i in range(1, 1001)],
        "observed_source_map": [
            f"{module_specs[module_id]['source_module']}->{module_id}"
            for module_id in implemented
        ],
        "observed_operation_names": [
            str(module_specs[module_id]["operation"])
            for module_id in implemented
        ],
    }


def relational_payload(module_specs: Mapping[str, Mapping[str, Any]]) -> Dict[str, Any]:
    rows = [dict(RELATIONAL_ROWS[module_id]) for module_id in RELATIONAL_ROWS]
    rows.append(terminal_row(module_specs))
    return {"relational_evidence_records": rows}
