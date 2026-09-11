from __future__ import annotations

from typing import Any, Dict

from .manifest import MODULE_SPECS

TOTAL_MODULES = 600
DELEGATED_MODULES = frozenset(f"M{i}" for i in range(1, 401))
NEW_MODULES = frozenset(MODULE_SPECS)


def module_registry() -> Dict[str, Dict[str, Any]]:
    registry: Dict[str, Dict[str, Any]] = {}
    for number in range(1, TOTAL_MODULES + 1):
        module_id = f"M{number}"
        if number <= 400:
            registry[module_id] = {
                "module": module_id,
                "status": "DELEGATED_PRODUCTION",
                "executable_here": False,
                "delegated_runtime": "seo-avengers-400",
            }
        else:
            spec = MODULE_SPECS[module_id]
            registry[module_id] = {
                "module": module_id,
                "status": "IMPLEMENTED_PRODUCTION",
                "executable_here": True,
                "source_module": spec["source_module"],
                "operation": spec["operation"],
                "family": spec["family"],
                "dataset_key": spec["dataset_key"],
                "input_fields": list(spec["input_fields"]),
                "threshold_ppm": spec["threshold_ppm"],
            }
    return registry
