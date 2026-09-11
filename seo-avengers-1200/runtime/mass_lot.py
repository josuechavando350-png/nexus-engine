from __future__ import annotations

from typing import Any, Dict, Mapping

from .mass_lot_common import (
    _InvalidConfig,
    _InvalidData,
    _InsufficientData,
    _canonicalize,
    _prepare_records,
)
from .mass_lot_edge_structural import _edge_structural
from .mass_lot_semantic_graph import _semantic_graph
from .mass_lot_persistence_state import _persistence_state
from .mass_lot_edge_gateway import _edge_gateway
from .mass_lot_search_intent import _search_intent
from .mass_lot_cwv_edge import _cwv_edge
from .mass_lot_canonicalization import _canonicalization
from .mass_lot_policy_compliance import _policy_compliance
from .mass_lot_manifest import MASS_LOT_SPECS, SOURCE_SPEC_SHA256
from .seo_avengers_1200 import canonical_hash, compile_receipt

FAMILY_HANDLERS = {
    "EDGE_STRUCTURAL": _edge_structural,
    "SEMANTIC_GRAPH": _semantic_graph,
    "PERSISTENCE_STATE": _persistence_state,
    "EDGE_GATEWAY": _edge_gateway,
    "SEARCH_INTENT": _search_intent,
    "CORE_WEB_VITALS": _cwv_edge,
    "CANONICALIZATION": _canonicalization,
    "POLICY_COMPLIANCE": _policy_compliance,
}

FAMILY_STARTS = {
    "EDGE_STRUCTURAL": 1201,
    "SEMANTIC_GRAPH": 1226,
    "PERSISTENCE_STATE": 1251,
    "EDGE_GATEWAY": 1276,
    "SEARCH_INTENT": 1301,
    "CORE_WEB_VITALS": 1326,
    "CANONICALIZATION": 1351,
    "POLICY_COMPLIANCE": 1376,
}


def _safe_config_value(config: Mapping[str, Any], key: str) -> Any:
    if key not in config:
        return "__DEFAULT__"
    try:
        return _canonicalize(config[key])
    except _InvalidData:
        return "__INVALID__"


def run_mass_lot_module(module_id: str, records: Any, config: Mapping[str, Any]) -> Dict[str, Any]:
    spec = MASS_LOT_SPECS.get(module_id)
    if spec is None:
        return compile_receipt(
            module_id, "mass_lot_unknown_module", 1, 1, None, None, None,
            "ERROR", "NOT_APPLICABLE", "UNKNOWN_MASS_LOT_MODULE", {},
        )

    source_id, source_name, family, dataset_key, operation_slug = spec
    algorithm = f"mass_lot_{family.casefold()}_{operation_slug}"
    threshold_key = f"{module_id.casefold()}_policy_threshold"
    raw_hash, dataset, invalid_count, conflicts = _prepare_records(records, "record_id")
    norm_hash = canonical_hash({
        "records": dataset,
        "invalid_records_count": invalid_count,
        "duplicate_conflicts": conflicts,
    })
    cfg_hash = canonical_hash({
        "source_spec_sha256": SOURCE_SPEC_SHA256,
        "source_module": source_id,
        "target_module": module_id,
        "source_name": source_name,
        "family": family,
        "dataset_key": dataset_key,
        "operation_slug": operation_slug,
        "policy_threshold": _safe_config_value(config, threshold_key),
        "contract_version": 1,
    })

    if raw_hash is None:
        return compile_receipt(
            module_id, algorithm, 1, 1, None, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "NON_CANONICAL_INPUT", {},
        )
    if not isinstance(records, list):
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_INPUT_SCHEMA", {},
        )
    if conflicts:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "FINDING", "DUPLICATE_MASS_LOT_RECORD_CONFLICT",
            {"conflicting_record_ids": conflicts, "invalid_records_count": invalid_count},
        )
    if invalid_count:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_MASS_LOT_RECORDS",
            {"invalid_records_count": invalid_count},
        )
    if not dataset:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_MASS_LOT_RECORDS",
            {"dataset_key": dataset_key},
        )

    source_number = int(source_id[1:])
    operation_index = source_number - FAMILY_STARTS[family] + 1
    handler = FAMILY_HANDLERS[family]
    try:
        result = handler(operation_index, dataset, module_id, config)
    except _InsufficientData as error:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "INSUFFICIENT_DATA", "NOT_APPLICABLE", "INSUFFICIENT_OPERATION_EVIDENCE",
            {"dataset_key": dataset_key, "required_signal": str(error)},
        )
    except _InvalidConfig as error:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_MODULE_CONFIG",
            {"config_key": str(error)},
        )
    except _InvalidData as error:
        return compile_receipt(
            module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
            "ERROR", "NOT_APPLICABLE", "INVALID_OPERATION_EVIDENCE",
            {"dataset_key": dataset_key, "invalid_signal": str(error)},
        )

    output = {
        "source_module": source_id,
        "source_name": source_name,
        "source_spec_sha256": SOURCE_SPEC_SHA256,
        "family": family,
        "dataset_key": dataset_key,
        "operation_index": operation_index,
        "metric_name": result.metric_name,
        "metric_value": result.metric_value,
        "policy": result.policy,
        "details": result.details,
        "analyzed_records_count": len(dataset),
    }
    return compile_receipt(
        module_id, algorithm, 1, 1, raw_hash, norm_hash, cfg_hash,
        "SUCCESS", "FINDING" if result.finding else "NO_FINDING",
        result.finding_reason if result.finding else result.okay_reason,
        output,
    )


def run_mass_lot(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    receipts: Dict[str, Dict[str, Any]] = {}
    for module_id in sorted(MASS_LOT_SPECS, key=lambda value: int(value[1:])):
        _source_id, _source_name, _family, dataset_key, _operation_slug = MASS_LOT_SPECS[module_id]
        records = payload.get(dataset_key, []) if isinstance(payload, Mapping) else []
        receipts[module_id] = run_mass_lot_module(module_id, records, config)
    return receipts
