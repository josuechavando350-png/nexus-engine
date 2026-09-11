#!/usr/bin/env python3
"""Stdin/stdout boundary for the isolated SEO Avengers 1200 runtime.

Input JSON:
  {"payload": {...}, "config": {...}}

The CLI writes exactly one JSON result to stdout. It does not touch Nexus source,
client applications, network resources, or deployment state.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from runtime.seo_avengers_1200 import SeoAvengers1200Runtime  # noqa: E402


def main() -> int:
    try:
        request = json.load(sys.stdin)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        json.dump(
            {"suite": "SEO_AVENGERS_1200", "status": "ERROR", "reason": "INVALID_JSON", "detail": str(exc)},
            sys.stdout,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        )
        sys.stdout.write("\n")
        return 2

    if not isinstance(request, dict):
        result = {"suite": "SEO_AVENGERS_1200", "status": "ERROR", "reason": "INVALID_REQUEST_SCHEMA"}
        json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        sys.stdout.write("\n")
        return 2

    payload = request.get("payload", {})
    config = request.get("config", {})
    result = SeoAvengers1200Runtime().execute(payload, config)
    json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    sys.stdout.write("\n")

    if result.get("enabled") is False and result.get("bypassed") is True:
        return 0
    if result.get("error"):
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
