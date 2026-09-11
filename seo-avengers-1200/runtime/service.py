from __future__ import annotations

import json
from typing import Any, Dict, List

from .batch_201_502 import (
    run_m201, run_m202, run_m301, run_m302, run_m401, run_m402, run_m501, run_m502,
)
from .batch_203_504 import (
    run_m203, run_m204, run_m303, run_m304, run_m403, run_m404, run_m503, run_m504,
)
from .batch_205_506 import (
    run_m205, run_m206, run_m305, run_m306, run_m405, run_m406, run_m505, run_m506,
)
from .batch_207_508 import (
    run_m207, run_m208, run_m307, run_m308, run_m407, run_m408, run_m507, run_m508,
)
from .batch_209_214 import (
    run_m209, run_m210, run_m211, run_m212, run_m213, run_m214,
)
from .batch_309_314 import run_m309, run_m310, run_m311, run_m312
from .batch_313_314 import run_m313, run_m314
from .batch_315_320 import run_m315
from .batch_601_802 import (
    run_m601, run_m602, run_m701, run_m702, run_m801, run_m802,
)
from .batch_603_1004 import (
    run_m603, run_m604, run_m703, run_m704, run_m803, run_m804, run_m1003, run_m1004,
)
from .batch_605_1006 import (
    run_m605, run_m606, run_m705, run_m706, run_m805, run_m806, run_m1005, run_m1006,
)
from .catalog import IMPLEMENTED_EXTENDED_MODULES, PRE_GATE_MODULES, module_registry
from .legacy_bridge import bridge_semantic200_module_evidence
from .seo_avengers_1200 import (
    canonical_hash, inspect_evidence_m1101, run_m901, run_m902, run_m1001, run_m1002, run_m1102,
)


def _resolve_legacy_evidence(effective_payload: Dict[str, Any]) -> Any:
    direct = effective_payload.pop("seo_avengers_200_module_evidence", None)
    transported = effective_payload.pop("seo_avengers_200_module_evidence_json", None)
    if direct is not None and transported is not None:
        return {"__bridge_conflict__": {"evidence_hash": "INVALID"}}
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
        "suite": "SEO_AVENGERS_1200", "enabled": False, "bypassed": True,
        "registry_size": 1200, "modules_executed": 0, "receipts": {},
    }


def _invalid_payload_result() -> Dict[str, Any]:
    return {
        "suite": "SEO_AVENGERS_1200", "enabled": True, "bypassed": False,
        "registry_size": 1200, "modules_executed": 0,
        "error": "INVALID_INPUT_SCHEMA", "receipts": {},
    }


def execute_avengers_1200(payload: Any, config: Any) -> Dict[str, Any]:
    """Execute all currently promoted modules and exactly one evidence gateway."""
    if not isinstance(config, dict) or config.get("CONFIG_SEO_AVENGERS_1200") is not True:
        return _disabled_result()
    if not isinstance(payload, dict):
        return _invalid_payload_result()

    effective_payload = dict(payload)
    legacy_value = _resolve_legacy_evidence(effective_payload)
    legacy_rows, bridge_summary = bridge_semantic200_module_evidence(legacy_value)

    receipts: Dict[str, Dict[str, Any]] = {}
    search_records = effective_payload.get("search_performance_records", [])
    keyword_records = effective_payload.get("keyword_coverage_records", [])
    traffic_windows = effective_payload.get("traffic_window_records", [])
    traffic_series = effective_payload.get("traffic_series_records", [])
    funnel_records = effective_payload.get("revenue_funnel_records", [])
    attribution_records = effective_payload.get("revenue_attribution_records", [])
    content_documents = effective_payload.get("content_documents", [])
    external_pages = effective_payload.get("external_pages", [])
    local_records = effective_payload.get("local_business_records", [])
    image_records = effective_payload.get("site_images_data", [])

    receipts["M201"] = run_m201(search_records, config)
    receipts["M202"] = run_m202(search_records, config)
    receipts["M203"] = run_m203(search_records, config)
    receipts["M204"] = run_m204(search_records, config)
    receipts["M205"] = run_m205(search_records, config)
    receipts["M206"] = run_m206(search_records, config)
    receipts["M207"] = run_m207(search_records, config)
    receipts["M208"] = run_m208(search_records, config)
    receipts["M209"] = run_m209(search_records, config)
    receipts["M210"] = run_m210(search_records, config)
    receipts["M211"] = run_m211(search_records, config)
    receipts["M212"] = run_m212(search_records, config)
    receipts["M213"] = run_m213(search_records, config)
    receipts["M214"] = run_m214(search_records, config)

    receipts["M301"] = run_m301(keyword_records, config)
    receipts["M302"] = run_m302(keyword_records, config)
    receipts["M303"] = run_m303(keyword_records, config)
    receipts["M304"] = run_m304(keyword_records, config)
    receipts["M305"] = run_m305(keyword_records, config)
    receipts["M306"] = run_m306(keyword_records, config)
    receipts["M307"] = run_m307(keyword_records, config)
    receipts["M308"] = run_m308(keyword_records, config)
    receipts["M309"] = run_m309(keyword_records, config)
    receipts["M310"] = run_m310(keyword_records, config)
    receipts["M311"] = run_m311(keyword_records, config)
    receipts["M312"] = run_m312(keyword_records, config)
    receipts["M313"] = run_m313(keyword_records, config)
    receipts["M314"] = run_m314(keyword_records, config)
    receipts["M315"] = run_m315(keyword_records, config)

    receipts["M401"] = run_m401(traffic_windows, config)
    receipts["M402"] = run_m402(traffic_series, config)
    receipts["M403"] = run_m403(traffic_series, config)
    receipts["M404"] = run_m404(traffic_series, config)
    receipts["M405"] = run_m405(traffic_series, config)
    receipts["M406"] = run_m406(traffic_series, config)
    receipts["M407"] = run_m407(traffic_series, config)
    receipts["M408"] = run_m408(traffic_series, config)

    receipts["M501"] = run_m501(funnel_records, config)
    receipts["M502"] = run_m502(attribution_records, config)
    receipts["M503"] = run_m503(funnel_records, config)
    receipts["M504"] = run_m504(attribution_records, config)
    receipts["M505"] = run_m505(funnel_records, config)
    receipts["M506"] = run_m506(attribution_records, config)
    receipts["M507"] = run_m507(attribution_records, config)
    receipts["M508"] = run_m508(attribution_records, config)

    receipts["M601"] = run_m601(content_documents, config)
    receipts["M602"] = run_m602(effective_payload.get("content_decay_records", []), config)
    receipts["M603"] = run_m603(content_documents, config)
    receipts["M604"] = run_m604(content_documents, config)
    receipts["M605"] = run_m605(content_documents, config)
    receipts["M606"] = run_m606(content_documents, config)

    receipts["M701"] = run_m701(external_pages, config)
    receipts["M702"] = run_m702(external_pages, config)
    receipts["M703"] = run_m703(external_pages, config)
    receipts["M704"] = run_m704(external_pages, config)
    receipts["M705"] = run_m705(external_pages, config)
    receipts["M706"] = run_m706(external_pages, config)

    receipts["M801"] = run_m801(local_records, config)
    receipts["M802"] = run_m802(local_records, config)
    receipts["M803"] = run_m803(local_records, config)
    receipts["M804"] = run_m804(local_records, config)
    receipts["M805"] = run_m805(local_records, config)
    receipts["M806"] = run_m806(local_records, config)

    receipts["M901"] = run_m901(effective_payload.get("meta_telemetry", {}), config)
    receipts["M902"] = run_m902(effective_payload.get("meta_telemetry", {}), config)

    receipts["M1001"] = run_m1001(image_records, config)
    receipts["M1002"] = run_m1002(image_records, config)
    receipts["M1003"] = run_m1003(image_records, config)
    receipts["M1004"] = run_m1004(image_records, config)
    receipts["M1005"] = run_m1005(image_records, config)
    receipts["M1006"] = run_m1006(image_records, config)

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
        inspected, invalid_count, duplicate_count, required_manifest, config, gateway_raw_hash,
    )

    executed = sum(1 for receipt in receipts.values() if receipt["execution_status"] == "SUCCESS")
    return {
        "suite": "SEO_AVENGERS_1200", "enabled": True, "bypassed": False,
        "registry_size": 1200, "delegated_legacy_modules": 200,
        "implemented_extended_modules": sorted(
            IMPLEMENTED_EXTENDED_MODULES, key=lambda module_id: int(module_id[1:]),
        ),
        "reserved_extended_modules": 1000 - len(IMPLEMENTED_EXTENDED_MODULES),
        "modules_executed": executed, "legacy_evidence_bridge": bridge_summary,
        "receipts": receipts,
    }


class SeoAvengers1200Runtime:
    """Public runtime facade for the complete currently-promoted extension set."""

    def __init__(self) -> None:
        self.registry = module_registry()

    def execute(self, payload: Any, config: Any) -> Dict[str, Any]:
        return execute_avengers_1200(payload, config)
