#!/usr/bin/env python3
"""Controlled CI-only evidence fixture for the read-only production-canary path.

This imports the existing deterministic Avengers test fixture. It does not read a
client app, call a provider, crawl a site, or represent production measurements.
"""
from __future__ import annotations

import json
from pathlib import Path
import sys

SUITE_ROOT = Path(__file__).resolve().parents[1]
if str(SUITE_ROOT) not in sys.path:
    sys.path.insert(0, str(SUITE_ROOT))

from test_batch_2201_2400 import fixture as base_fixture


def fixture():
    payload, config = base_fixture()
    for document in payload.get("content_documents", []):
        document["text"] = document["text"] + (
            " Orientacion informativa sobre que hacer, como prepararse y cuando solicitar apoyo "
            "ante una situacion urgente o inmediata, siempre segun los hechos y la evidencia disponible."
        )
    payload["search_performance_records"] = list(payload.get("search_performance_records", [])) + [
        {"query": "que hacer abogado penal urgente cdmx", "page_url": "/penal-cdmx", "clicks": 0, "impressions": 80, "average_position_milli": 2000},
        {"query": "como actuar audiencia inicial cdmx", "page_url": "/audiencia-inicial-cdmx", "clicks": 0, "impressions": 80, "average_position_milli": 6000},
        {"query": "cuando contratar abogado fraude urgente cdmx", "page_url": "/fraude-cdmx", "clicks": 0, "impressions": 80, "average_position_milli": 25000},
        {"query": "cano estrategia penal penal cdmx", "page_url": "/penal-cdmx", "clicks": 4, "impressions": 80, "average_position_milli": 6000},
        {"query": "cano estrategia penal fraude cdmx", "page_url": "/fraude-cdmx", "clicks": 0, "impressions": 80, "average_position_milli": 6000},
        {"query": "cano estrategia penal audiencia inicial cdmx", "page_url": "/audiencia-inicial-cdmx", "clicks": 4, "impressions": 80, "average_position_milli": 6000},
    ]
    return payload, config


if __name__ == "__main__":
    payload, config = fixture()
    print(json.dumps({"payload": payload, "config": config}, sort_keys=True, separators=(",", ":")))
