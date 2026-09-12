from __future__ import annotations

import json
import sys
from collections.abc import Mapping
from typing import Any, Dict

from runtime.common import canonical_json, hash_value
from runtime.runner import run_batch_1001_2500

_SCHEMA_VERSION = 1
_FIRST_MODULE = "M1001"
_LAST_MODULE = "M2500"
_RECEIPT_COUNT = 1500


def _assert_exact_keys(value: Mapping[str, Any], expected: set[str], label: str) -> None:
    if set(value) != expected:
        raise ValueError(f"unexpected_{label}_keys")


def execute_request(request: Mapping[str, Any]) -> Dict[str, Any]:
    if not isinstance(request, Mapping):
        raise TypeError("request_must_be_mapping")
    _assert_exact_keys(request, {"schema_version", "payload", "config"}, "request")
    if request["schema_version"] != _SCHEMA_VERSION:
        raise ValueError("unsupported_request_schema")
    payload = request["payload"]
    config = request["config"]
    if not isinstance(payload, Mapping):
        raise TypeError("payload_must_be_mapping")
    if not isinstance(config, Mapping):
        raise TypeError("config_must_be_mapping")

    receipts = run_batch_1001_2500(payload, config)
    expected = tuple(f"M{i}" for i in range(1001, 2501))
    if tuple(receipts) != expected:
        raise RuntimeError("sidecar_receipt_range_drift")
    terminal = receipts[_LAST_MODULE]
    terminal_hash = terminal.get("evidence_hash")
    if not isinstance(terminal_hash, str):
        raise RuntimeError("terminal_evidence_hash_missing")

    return {
        "schema_version": _SCHEMA_VERSION,
        "receipt_count": _RECEIPT_COUNT,
        "first_module": _FIRST_MODULE,
        "last_module": _LAST_MODULE,
        "execution_hash": hash_value(receipts),
        "terminal_evidence_hash": terminal_hash,
        "receipts": receipts,
    }


def main() -> int:
    try:
        raw = sys.stdin.read()
        request = json.loads(raw)
        response = execute_request(request)
    except Exception as exc:
        error = {
            "schema_version": _SCHEMA_VERSION,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc),
            },
        }
        sys.stderr.write(canonical_json(error) + "\n")
        return 1
    sys.stdout.write(canonical_json(response) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
