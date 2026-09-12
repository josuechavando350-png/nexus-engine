from __future__ import annotations

from typing import Any, Dict, Mapping

from .catalog import module_registry
from .module_runtime import execute_module

def run_module(module_id: str, payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    if module_id == "M1200":
        raise ValueError("M1200 requires the exact M1176-M1199 policy receipt set; use run_batch_1001_1200")
    return execute_module(module_id, payload, config)

def run_batch_1001_1200(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Dict[str, Any]]:
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")
    receipts: Dict[str, Dict[str, Any]] = {}
    for number in range(1001, 1200):
        module_id = f"M{number}"
        receipts[module_id] = execute_module(module_id, payload, config)
    policy_receipts = {f"M{i}": receipts[f"M{i}"] for i in range(1176, 1200)}
    receipts["M1200"] = execute_module("M1200", payload, config, prior_receipts=policy_receipts)
    if tuple(receipts) != tuple(f"M{i}" for i in range(1001, 1201)):
        raise RuntimeError("batch receipt range drift")
    return receipts

def suite_state() -> Dict[str, Any]:
    registry = module_registry()
    return {
        "suite": "SEO_AVENGERS_2500",
        "target_registry_size": 2500,
        "delegated_production_count": 1000,
        "implemented_local_count": 200,
        "reserved_not_executable_count": 1300,
        "current_implemented_range": ["M1001", "M1200"],
        "final_target_range": ["M1", "M2500"],
        "m2501_present": False,
        "registry": registry,
    }
