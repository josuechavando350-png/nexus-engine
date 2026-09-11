from __future__ import annotations

from typing import Any, Dict, Mapping

from .catalog import TOTAL_MODULES, module_registry
from .mass_lot import run_mass_lot


def execute_avengers_400(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    """Execute the new M201-M400 layer while preserving M001-M200 delegation.

    The original 200 remain owned by the existing seo-avengers-200 sidecar.
    This function never fabricates receipts for that delegated runtime.
    """
    registry = module_registry()
    if config.get("CONFIG_SEO_AVENGERS_400") is not True:
        return {
            "enabled": False,
            "total_modules": TOTAL_MODULES,
            "original_runtime": "seo-avengers-200",
            "delegated_original_modules": 200,
            "executed_new_modules": 0,
            "receipts": {},
            "registry": registry,
        }
    receipts = run_mass_lot(payload, config)
    return {
        "enabled": True,
        "total_modules": TOTAL_MODULES,
        "original_runtime": "seo-avengers-200",
        "delegated_original_modules": 200,
        "executed_new_modules": len(receipts),
        "receipts": receipts,
        "registry": registry,
    }
