"""Compatibility helpers for the reviewed mass-lot engine.

The filename is retained because the audited family modules import it by this
name. This package exposes exactly M001-M400; it does not create a 1200-slot
registry.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

INT64_MAX = 9_223_372_036_854_775_807


def canonical_hash(payload: Any) -> str:
    raw = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def normalize_integer(value: Any, max_limit: Optional[int] = None) -> Optional[int]:
    if value is None or type(value) is bool or not isinstance(value, int):
        return None
    limit = INT64_MAX if max_limit is None else max_limit
    if limit < 0 or not (0 <= value <= limit):
        return None
    return value


def compile_receipt(
    module_id: str,
    algorithm: str,
    algorithm_version: int,
    schema_version: int,
    raw_input_hash: Optional[str],
    normalized_input_hash: Optional[str],
    module_config_hash: Optional[str],
    execution_status: str,
    finding_status: str,
    reason_code: str,
    output: Any,
) -> Dict[str, Any]:
    receipt = {
        "module": module_id,
        "algorithm": algorithm,
        "algorithm_version": algorithm_version,
        "schema_version": schema_version,
        "raw_input_hash": raw_input_hash,
        "normalized_input_hash": normalized_input_hash,
        "module_config_hash": module_config_hash,
        "execution_status": execution_status,
        "finding_status": finding_status,
        "reason_code": reason_code,
        "output": output,
    }
    receipt["evidence_hash"] = canonical_hash(receipt)
    return receipt
