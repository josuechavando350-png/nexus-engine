from __future__ import annotations

from typing import Any, Dict, Mapping

from .catalog import TOTAL_MODULES, module_registry
from .runner import run_new_200


def execute_avengers_600(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    """Execute M401-M600 while delegating M001-M400 to seo-avengers-400."""
    registry = module_registry()
    if config.get("CONFIG_SEO_AVENGERS_600") is not True:
        return {
            "enabled": False,
            "total_modules": TOTAL_MODULES,
            "delegated_runtime": "seo-avengers-400",
            "delegated_modules": 400,
            "executed_new_modules": 0,
            "receipts": {},
            "registry": registry,
        }
    receipts = run_new_200(payload, config)
    return {
        "enabled": True,
        "total_modules": TOTAL_MODULES,
        "delegated_runtime": "seo-avengers-400",
        "delegated_modules": 400,
        "executed_new_modules": len(receipts),
        "receipts": receipts,
        "registry": registry,
    }
