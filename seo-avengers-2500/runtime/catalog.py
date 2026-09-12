from __future__ import annotations

from typing import Any, Dict

from .manifest import MODULE_SPECS

TOTAL_TARGET_MODULES = 2500
DELEGATED_MODULES = tuple(f"M{i}" for i in range(1, 1001))
IMPLEMENTED_MODULES = tuple(f"M{i}" for i in range(1001, 1401))
RESERVED_MODULES = tuple(f"M{i}" for i in range(1401, 2501))

def module_registry() -> Dict[str, Dict[str, Any]]:
    registry: Dict[str, Dict[str, Any]] = {}
    for number in range(1, TOTAL_TARGET_MODULES + 1):
        module_id = f"M{number}"
        if number <= 1000:
            registry[module_id] = {
                "module": module_id,
                "status": "DELEGATED_PRODUCTION",
                "executable_here": False,
                "delegated_runtime": "seo-avengers-1000",
            }
        elif number <= 1400:
            spec = MODULE_SPECS[module_id]
            registry[module_id] = {
                "module": module_id,
                "status": "IMPLEMENTED_PRODUCTION",
                "executable_here": True,
                "source_module": spec["source_module"],
                "operation": spec["operation"],
                "family": spec["family"],
                "dataset_key": spec["dataset_key"],
                "kernel": spec["kernel"],
                "policy_status": spec["policy_status"],
                "action_mode": spec["action_mode"],
            }
        else:
            registry[module_id] = {
                "module": module_id,
                "status": "RESERVED_NOT_EXECUTABLE",
                "executable_here": False,
                "reason": "future reviewed batch; never counted as an implemented capability",
            }
    expected = tuple(f"M{i}" for i in range(1, 2501))
    if tuple(registry) != expected:
        raise RuntimeError("registry range drift")
    if "M2501" in registry:
        raise RuntimeError("M2501 forbidden")
    if sum(1 for v in registry.values() if v["status"] == "IMPLEMENTED_PRODUCTION") != 400:
        raise RuntimeError("implemented cardinality drift")
    if any(registry[mid]["executable_here"] for mid in RESERVED_MODULES):
        raise RuntimeError("reserved module became executable")
    return registry
