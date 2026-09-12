from __future__ import annotations

from typing import Any, Dict, Mapping

from .runner import run_batch_1001_2500, suite_state


FLAG = "CONFIG_SEO_AVENGERS_2500"


def execute_avengers_2500(payload: Mapping[str, Any], config: Mapping[str, Any]) -> Dict[str, Any]:
    """Execute the local M1001-M2500 slice behind an explicit per-client gate.

    M001-M1000 remain delegated to their audited predecessor runtime. This
    service never mutates a client site and performs no network/provider writes.
    """
    state = suite_state()
    if not isinstance(config, Mapping) or config.get(FLAG) is not True:
        return {
            "enabled": False,
            "suite": state["suite"],
            "target_registry_size": state["target_registry_size"],
            "delegated_production_count": state["delegated_production_count"],
            "executed_local_modules": 0,
            "receipts": {},
            "release_safe": False,
            "reason": "CLIENT_DISABLED",
        }

    receipts = run_batch_1001_2500(payload, config)
    terminal = receipts["M2500"]
    release_safe = bool(terminal.get("output", {}).get("release_safe"))
    return {
        "enabled": True,
        "suite": state["suite"],
        "target_registry_size": state["target_registry_size"],
        "delegated_production_count": state["delegated_production_count"],
        "executed_local_modules": len(receipts),
        "receipts": receipts,
        "release_safe": release_safe,
        "reason": "PASS" if release_safe else "TERMINAL_BLOCKED",
    }
