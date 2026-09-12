from __future__ import annotations
from typing import Any, Mapping

def add(
    rows: list[dict[str, Any]],
    family: str,
    operation: str,
    dataset_key: str,
    kernel: str,
    params: Mapping[str, Any],
    purpose: str,
    config_terms: tuple[str, ...] = (),
    threshold_ppm: int = 500_000,
) -> None:
    number = 1001 + len(rows)
    rows.append({
        "module_id": f"M{number}",
        "source_module": f"M{number + 1000}",
        "family": family,
        "operation": operation,
        "dataset_key": dataset_key,
        "kernel": kernel,
        "params": dict(params),
        "purpose": purpose,
        "config_terms": list(config_terms),
        "threshold_ppm": threshold_ppm,
        "policy_status": "SAFE_WHITE_HAT",
        "action_mode": "OBSERVE_ONLY",
    })
