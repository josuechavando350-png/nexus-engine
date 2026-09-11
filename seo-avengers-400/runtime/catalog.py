from __future__ import annotations

from typing import Any, Dict

from .mass_lot_runtime_manifest import RUNTIME_MASS_LOT_SPECS

TOTAL_MODULES = 400
ORIGINAL_MODULES = frozenset(f"M{i}" for i in range(1, 201))
NEW_MODULES = frozenset(RUNTIME_MASS_LOT_SPECS)


def module_registry() -> Dict[str, Dict[str, Any]]:
    registry: Dict[str, Dict[str, Any]] = {}
    for number in range(1, TOTAL_MODULES + 1):
        module_id = f"M{number}"
        if number <= 200:
            registry[module_id] = {
                "module": module_id,
                "status": "DELEGATED_PRODUCTION",
                "executable_here": False,
                "delegated_runtime": "seo-avengers-200",
            }
        else:
            source_id, source_name, family, dataset_key, operation_slug = RUNTIME_MASS_LOT_SPECS[module_id]
            registry[module_id] = {
                "module": module_id,
                "status": "IMPLEMENTED_PRODUCTION",
                "executable_here": True,
                "source_module": source_id,
                "source_name": source_name,
                "family": family,
                "dataset_key": dataset_key,
                "operation_slug": operation_slug,
            }
    return registry
