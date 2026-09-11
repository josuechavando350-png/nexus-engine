from __future__ import annotations

import json
from typing import Any, Dict, List

from .batch_601_802 import (
    run_m601,
    run_m602,
    run_m701,
    run_m702,
    run_m801,
    run_m802,
)
from .catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from .legacy_bridge import bridge_semantic200_module_evidence
from .seo_avengers_1200 import (
    canonical_hash,
    inspect_evidence_m1101,
    run_m901,
    run_m902,
    run_m1001,
    run_m1002,
    run_m1102,
)


def _resolve_legacy_evidence(effective_payload: Dict[str, Any]) -> Any:
    direct = effective_payload.pop("seo_avengers_200_module_evidence", None)
    transported = effective_payload.pop("seo_avengers_200_module_evidence_json", None)

    if direct is not None and transported is not None:
        return {
            "__bridge_conflict__": {
                "evidence_hash": "INVALID",
            }
        }
    if direct is not None:
        return direct
    if transported is None:
        return None
    if not isinstance(transported, str):
        return transported
    try:
        return json.loads(transported)
    except json.JSONDecodeError:
        return transported


def _upstream_rows(value: Any) -> List[Any]:
    if isinstance(value, list):
        return list(value)
    if value is None:
        return []
    return [value]


def _disabled_result() -> Dict[str, Any]:
    return {
        "suite": "SEO_AVENGERS_1200",
        "enabled": False,
        "bypassed": True,
        "registry_size": 1200,
        "modules_executed": 0,
        "receipts": {},
    }


def _invalid_payload_result() -> Dict[str, Any]:
    return {
        "suite": "SEO_AVENGERS_1200",
        "enabled": True,
        "bypassed": False,
        "registry_size": 1200,
        "modules_executed": 0,
        "error": "INVALID_INPUT_SCHEMA",
        "receipts": {},
    }


def execute_avengers_1200(payload: Any, config: Any) -> Dict[str, Any]:
    """Execute all currently promoted modules and exactly one evidence gateway.

    No reserved slot is dispatched. Every promoted pre-gate module contributes a
    receipt to the same M1101 integrity set, then M1102 evaluates the exact
    required manifest. The function is computation-only; deployment mutation is
    outside this runtime.
    """
    if not isinstance(config, dict) or config.get("CONFIG_SEO_AVENGERS_1200") is not True:
        return _disabled_result()
    if not isinstance(payload, dict):
        return _invalid_payload_result()

    effective_payload = dict(payload)
    legacy_value = _resolve_legacy_evidence(effective_payload)
    legacy_rows, bridge_summary = bridge_semantic200_module_evidence(legacy_value)

    receipts: Dict[str, Dict[str, Any]] = {}
    receipts["M601"] = run_m601(effective_payload.get("content_documents", []), config)
    receipts["M602"] = run_m602(effective_payload.get("content_decay_records", []), config)
    receipts["M701"] = run_m701(effective_payload.get("external_pages", []), config)
    receipts["M702"] = run_m702(effective_payload.get("external_pages", []), config)
    receipts["M801"] = run_m801(effective_payload.get("local_business_records", []), config)
    receipts["M802"] = run_m802(effective_payload.get("local_business_records", []), config)
    receipts["M901"] = run_m901(effective_payload.get("meta_telemetry", {}), config)
    receipts["M902"] = run_m902(effective_payload.get("meta_telemetry", {}), config)
    receipts["M1001"] = run_m1001(effective_payload.get("site_images_data", []), config)
    receipts["M1002"] = run_m1002(effective_payload.get("site_images_data", []), config)

    evidence_rows: List[Any] = _upstream_rows(effective_payload.get("upstream_evidence", []))
    evidence_rows.extend(legacy_rows)
    for module_id in PRE_GATE_MODULES:
        receipt = receipts[module_id]
        evidence_rows.append({
            "target_module_id": module_id,
            "reported_evidence_hash": receipt["evidence_hash"],
            "receipt_payload": receipt,
        })

    m1101_receipt, inspected, invalid_count, duplicate_count = inspect_evidence_m1101(evidence_rows)
    receipts["M1101"] = m1101_receipt

    required_manifest = config.get("m1102_required_module_ids", list(PRE_GATE_MODULES))
    gateway_raw_hash = canonical_hash({"raw_evidence": evidence_rows})
    receipts["M1102"] = run_m1102(
        inspected,
        invalid_count,
        duplicate_count,
        required_manifest,
        config,
        gateway_raw_hash,
    )

    executed = sum(
        1 for receipt in receipts.values()
        if receipt["execution_status"] == "SUCCESS"
    )
    return {
        "suite": "SEO_AVENGERS_1200",
        "enabled": True,
        "bypassed": False,
        "registry_size": 1200,
        "delegated_legacy_modules": 200,
        "implemented_extended_modules": sorted(
            IMPLEMENTED_EXTENDED_MODULES,
            key=lambda module_id: int(module_id[1:]),
        ),
        "reserved_extended_modules": 1000 - len(IMPLEMENTED_EXTENDED_MODULES),
        "modules_executed": executed,
        "legacy_evidence_bridge": bridge_summary,
        "receipts": receipts,
    }


class SeoAvengers1200Runtime:
    """Public runtime facade for the complete currently-promoted extension set."""

    def __init__(self) -> None:
        self.registry = module_registry()

    def execute(self, payload: Any, config: Any) -> Dict[str, Any]:
        return execute_avengers_1200(payload, config)
