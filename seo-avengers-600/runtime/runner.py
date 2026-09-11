from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import InvalidData, InsufficientData, _normalize, make_receipt, select_record
from .manifest import MODULE_SPECS, TARGET_MODULES
from . import semantic, html_stream, edge_gateway, neon_relational


def _module_config(module_id: str, spec: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    key = f"{module_id.lower()}_threshold_ppm"
    threshold = config.get(key, spec["threshold_ppm"])
    if isinstance(threshold, bool) or not isinstance(threshold, int):
        raise InvalidData(f"{key}_must_be_int")
    if threshold < 0 or threshold > 1_000_000:
        raise InvalidData(f"{key}_out_of_range")
    return {"activation_state": "deny_by_default", "threshold_ppm": threshold,
            "implementation_mode": "deterministic_evidence_audit_no_external_side_effects"}


def run_module(module_id: str, payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    spec = MODULE_SPECS.get(module_id)
    if spec is None:
        raise KeyError(module_id)
    source_id = str(spec["source_module"])
    try:
        module_config = _module_config(module_id, spec, config)
    except InvalidData as exc:
        module_config = {"activation_state": "deny_by_default", "threshold_ppm": spec["threshold_ppm"],
                         "implementation_mode": "deterministic_evidence_audit_no_external_side_effects"}
        return make_receipt(module_id=module_id, source_module=source_id, operation=str(spec["operation"]), family=str(spec["family"]),
                            raw_row=None, normalized_row=None, module_config=module_config, execution_status="ERROR",
                            finding_status="NOT_APPLICABLE", reason_code=str(exc), output={})

    raw_row = None
    normalized_row = None
    try:
        raw_row = select_record(payload, str(spec["dataset_key"]), module_id, source_id)
        normalized_row = _normalize(raw_row)
        threshold = int(module_config["threshold_ppm"])
        family = str(spec["family"])
        if family == "SEMANTIC_EAT":
            output = semantic.evaluate(str(spec["operation"]), normalized_row, threshold)
        elif family == "HTML_STREAM":
            output = html_stream.evaluate(str(spec["operation"]), normalized_row, threshold)
        elif family == "EDGE_GATEWAY":
            output = edge_gateway.evaluate(str(spec["operation"]), normalized_row, threshold)
        elif family == "NEON_RELATIONAL":
            effective_spec = dict(spec); effective_spec["threshold_ppm"] = threshold
            output = neon_relational.evaluate(str(spec["operation"]), normalized_row, effective_spec)
        else:
            raise InvalidData(f"unsupported_family:{family}")
        finding = "FINDING" if output.get("violation") is True else "NO_FINDING"
        reason = "POLICY_VIOLATION" if finding == "FINDING" else "POLICY_SATISFIED"
        return make_receipt(module_id=module_id, source_module=source_id, operation=str(spec["operation"]), family=family,
                            raw_row=raw_row, normalized_row=normalized_row, module_config=module_config,
                            execution_status="SUCCESS", finding_status=finding, reason_code=reason, output=output)
    except InsufficientData as exc:
        return make_receipt(module_id=module_id, source_module=source_id, operation=str(spec["operation"]), family=str(spec["family"]),
                            raw_row=raw_row, normalized_row=normalized_row, module_config=module_config,
                            execution_status="INSUFFICIENT_DATA", finding_status="NOT_APPLICABLE", reason_code=str(exc), output={})
    except InvalidData as exc:
        return make_receipt(module_id=module_id, source_module=source_id, operation=str(spec["operation"]), family=str(spec["family"]),
                            raw_row=raw_row, normalized_row=normalized_row, module_config=module_config,
                            execution_status="ERROR", finding_status="NOT_APPLICABLE", reason_code=str(exc), output={})


def run_new_200(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    return {module_id: run_module(module_id, payload, config) for module_id in TARGET_MODULES}
