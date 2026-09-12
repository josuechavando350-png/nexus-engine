from __future__ import annotations

from typing import Any, Dict, Mapping

from .common import InvalidData, InsufficientData, make_receipt
from .kernels import evaluate_spec
from .manifest import MODULE_SPECS

def _config_for(spec: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    module_id = str(spec["module_id"])
    key = f"{module_id.lower()}_threshold_ppm"
    threshold = config.get(key, spec["threshold_ppm"])
    if isinstance(threshold, bool) or not isinstance(threshold, int) or not 0 <= threshold <= 1_000_000:
        raise InvalidData(f"{key}_invalid")
    return {
        "threshold_ppm": threshold,
        "policy_status": "SAFE_WHITE_HAT",
        "action_mode": "OBSERVE_ONLY",
        "new_external_api_required": False,
        "new_database_required": False,
        "new_queue_required": False,
        "new_secret_required": False,
    }

def _runtime_contract() -> Dict[str, bool]:
    return {
        "new_external_api_required": False,
        "new_database_required": False,
        "new_queue_required": False,
        "new_secret_required": False,
        "new_cloud_resource_required": False,
        "new_daemon_required": False,
    }

def execute_module(
    module_id: str,
    payload: Mapping[str, Any],
    config: Mapping[str, Any],
    *,
    prior_receipts: Mapping[str, Mapping[str, Any]] | None = None,
) -> Dict[str, Any]:
    spec = MODULE_SPECS.get(module_id)
    if spec is None:
        raise KeyError(module_id)
    try:
        module_config = _config_for(spec, config)
    except InvalidData as exc:
        module_config = {
            "threshold_ppm": spec["threshold_ppm"],
            "policy_status": "SAFE_WHITE_HAT",
            "action_mode": "OBSERVE_ONLY",
            "config_validation": "invalid",
        }
        return make_receipt(
            module_id=module_id, source_module=spec["source_module"], operation=spec["operation"],
            family=spec["family"], raw_input=None, normalized_input=None,
            module_config=module_config, execution_status="ERROR",
            finding_status="NOT_APPLICABLE", reason_code=str(exc), output={},
        )
    try:
        raw_input, normalized_input, output = evaluate_spec(
            spec, payload, config, prior_receipts=prior_receipts,
        )
        output = {**output, "runtime_contract": _runtime_contract()}
        finding = "FINDING" if output.get("violation") is True else "NO_FINDING"
        reason = (
            f"{spec['operation'].upper()}_FINDING"
            if finding == "FINDING"
            else f"{spec['operation'].upper()}_SATISFIED"
        )
        return make_receipt(
            module_id=module_id, source_module=spec["source_module"], operation=spec["operation"],
            family=spec["family"], raw_input=raw_input, normalized_input=normalized_input,
            module_config=module_config, execution_status="SUCCESS",
            finding_status=finding, reason_code=reason, output=output,
        )
    except InsufficientData as exc:
        return make_receipt(
            module_id=module_id, source_module=spec["source_module"], operation=spec["operation"],
            family=spec["family"], raw_input=None, normalized_input=None,
            module_config=module_config, execution_status="INSUFFICIENT_DATA",
            finding_status="NOT_APPLICABLE", reason_code=str(exc), output={},
        )
    except InvalidData as exc:
        return make_receipt(
            module_id=module_id, source_module=spec["source_module"], operation=spec["operation"],
            family=spec["family"], raw_input=None, normalized_input=None,
            module_config=module_config, execution_status="ERROR",
            finding_status="NOT_APPLICABLE", reason_code=str(exc), output={},
        )
