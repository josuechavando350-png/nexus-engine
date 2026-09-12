from __future__ import annotations

from typing import Any, Dict, Mapping

from .catalog import TOTAL_MODULES, module_registry
from .runner import run_new_200


def execute_avengers_800(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    """Execute M601-M800 while delegating M001-M600 to seo-avengers-600."""
    registry = module_registry()
    if config.get("CONFIG_SEO_AVENGERS_800") is not True:
        return {
            "enabled": False,
            "total_modules": TOTAL_MODULES,
            "delegated_runtime": "seo-avengers-600",
            "delegated_modules": 600,
            "executed_new_modules": 0,
            "receipts": {},
            "registry": registry,
        }
    receipts = run_new_200(payload, config)
    return {
        "enabled": True,
        "total_modules": TOTAL_MODULES,
        "delegated_runtime": "seo-avengers-600",
        "delegated_modules": 600,
        "executed_new_modules": len(receipts),
        "receipts": receipts,
        "registry": registry,
    }
