#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any, Mapping

RANGES = (
    ("M001-M200", 1, 200),
    ("M201-M400", 201, 400),
    ("M401-M600", 401, 600),
    ("M601-M800", 601, 800),
    ("M801-M1000", 801, 1000),
    ("M1001-M2500", 1001, 2500),
)

def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()

def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(value) + b"\n")

def module_number(module_id: str) -> int:
    if not isinstance(module_id, str) or not module_id.startswith("M") or not module_id[1:].isdigit():
        raise ValueError(f"invalid module id:{module_id}")
    return int(module_id[1:])

def exact_ids(start: int, end: int) -> list[str]:
    return [f"M{i}" for i in range(start, end + 1)]

def normalize_status(receipt: Mapping[str, Any]) -> str:
    raw = str(receipt.get("execution_status", receipt.get("status", ""))).upper()
    if raw == "SUCCESS":
        return "SUCCESS"
    if raw in {"INSUFFICIENT_DATA", "BLOCKED", "STALE", "UNAVAILABLE", "NOT_APPLICABLE"}:
        return "INSUFFICIENT_DATA"
    if raw in {"ERROR", "FAILED", "FAIL", "FAILURE"}:
        return "ERROR"
    return "ERROR"

def subprocess_json(repo: Path, suite: str, source: str) -> Mapping[str, Any]:
    suite_root = repo / suite
    env = dict(os.environ)
    env["PYTHONPATH"] = str(suite_root)
    result = subprocess.run(
        [sys.executable, "-c", source],
        cwd=suite_root,
        env=env,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=180,
    )
    if result.returncode != 0:
        raise RuntimeError(f"{suite} execution failed:{result.returncode}:{result.stderr[-4000:]}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"{suite} returned no JSON")
    return json.loads(lines[-1])

def run_201_400(repo: Path) -> Mapping[str, Any]:
    return subprocess_json(repo, "seo-avengers-400", r'''
import json
from runtime.mass_lot_runtime_manifest import RUNTIME_MASS_LOT_SPECS
from runtime.service import execute_avengers_400
payload={spec[3]:[] for spec in RUNTIME_MASS_LOT_SPECS.values()}
result=execute_avengers_400(payload,{"CONFIG_SEO_AVENGERS_400":True})
print(json.dumps(result,sort_keys=True,separators=(",",":")))
''')

def run_extension(repo: Path, suite: str, function_name: str, flag: str) -> Mapping[str, Any]:
    source = f'''
import json
from runtime.manifest import MODULE_SPECS
from runtime.service import {function_name}
payload={{spec["dataset_key"]:[] for spec in MODULE_SPECS.values()}}
result={function_name}(payload,{{"{flag}":True}})
print(json.dumps(result,sort_keys=True,separators=(",",":")))
'''
    return subprocess_json(repo, suite, source)

def run_1001_2500(repo: Path, audit: Mapping[str, Any]) -> Mapping[str, Any]:
    documents = [
        {"document_id": f"audit:{row['id']}", "text": str(row["claim"])}
        for row in audit["signals"]
    ]
    payload = {
        "search_performance_records": [],
        "content_documents": documents,
        "local_business_records": [],
        "search_intent_records": [],
        "canonicalization_records": [],
        "persistence_state_records": [],
        "edge_gateway_records": [],
        "cwv_edge_records": [],
        "policy_audit_records": [],
        "semantic_text_records": [],
        "revenue_funnel_records": [],
        "revenue_attribution_records": [],
        "keyword_coverage_records": [],
        "traffic_window_records": [],
        "traffic_series_records": [],
        "content_decay_records": [],
        "upstream_evidence": [],
    }
    config = {
        "project_locale": "es-MX",
        "local_commercial_terms": ["abogado", "defensa", "diagnostico", "honorarios", "consulta"],
        "local_service_terms": ["defensa penal", "delitos fiscales", "defraudacion fiscal", "citatorio", "detenido", "audiencia inicial"],
        "local_location_terms": ["cdmx", "ciudad de mexico"],
        "local_urgency_terms": ["urgente", "detenido", "citatorio", "inmediato"],
        "local_question_terms": ["como", "que", "cuando", "cuanto"],
        "local_brand_terms": ["cano", "cano estrategia penal"],
        "local_verified_service_terms": ["defensa penal", "delitos fiscales", "defraudacion fiscal"],
        "local_verified_location_terms": ["cdmx", "ciudad de mexico"],
        "local_service_groups": {
            "penal": ["defensa penal", "citatorio", "detenido", "audiencia inicial"],
            "penal_fiscal": ["delitos fiscales", "defraudacion fiscal"],
        },
        "local_location_groups": {"cdmx": ["cdmx", "ciudad de mexico"]},
        "organic_funnel_source_ids": ["organic-search"],
    }
    request = {"schema_version": 1, "payload": payload, "config": config}
    request_path = repo / ".git" / "cano-round0-sidecar-request.json"
    request_path.write_bytes(canonical_bytes(request))
    try:
        source = r'''
import json,sys
from sidecar.execute_suite import execute_request
request=json.load(open(sys.argv[1],encoding="utf-8"))
result=execute_request(request)
print(json.dumps(result,sort_keys=True,separators=(",",":")))
'''
        suite_root = repo / "seo-avengers-2500"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(suite_root)
        result = subprocess.run(
            [sys.executable, "-c", source, str(request_path)],
            cwd=suite_root, env=env, check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240,
        )
        if result.returncode != 0:
            raise RuntimeError(f"seo-avengers-2500 execution failed:{result.returncode}:{result.stderr[-4000:]}")
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("seo-avengers-2500 returned no JSON")
        return json.loads(lines[-1])
    finally:
        request_path.unlink(missing_ok=True)

def normalize_range(label: str, start: int, end: int, audit_sha: str, receipts: Mapping[str, Any], source: str) -> Mapping[str, Any]:
    ids = sorted(receipts.keys(), key=module_number)
    expected = exact_ids(start, end)
    if ids != expected:
        raise RuntimeError(f"{label} receipt range mismatch")
    normalized: dict[str, Any] = {}
    success = insufficient = errors = 0
    for module_id in ids:
        receipt = receipts[module_id]
        if label == "M001-M200":
            error = str(receipt.get("error", ""))
            status = "ERROR" if error else "SUCCESS"
        else:
            status = normalize_status(receipt)
        if status == "SUCCESS":
            success += 1
        elif status == "INSUFFICIENT_DATA":
            insufficient += 1
        else:
            errors += 1
        normalized[module_id] = {
            "status": status,
            "receiptSha256": sha256_bytes(canonical_bytes(receipt)),
        }
    value = {
        "schemaVersion": 1,
        "range": label,
        "siteId": "cano-penal",
        "auditSha256": audit_sha,
        "source": source,
        "receiptCount": len(ids),
        "successCount": success,
        "insufficientDataCount": insufficient,
        "errorCount": errors,
        "receipts": normalized,
    }
    return {**value, "rangeSha256": sha256_bytes(canonical_bytes(value))}

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--audit", required=True)
    parser.add_argument("--m200-evidence", required=True)
    parser.add_argument("--evidence-dir", required=True)
    parser.add_argument("--summary", required=True)
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    audit_path = Path(args.audit).resolve()
    evidence_dir = Path(args.evidence_dir).resolve()
    summary_path = Path(args.summary).resolve()
    audit_bytes = audit_path.read_bytes()
    audit_sha = sha256_bytes(audit_bytes)
    audit = json.loads(audit_bytes)
    if audit.get("tournamentId") != "CANO_PENAL_CDMX_ZERO" or audit.get("siteId") != "cano-penal":
        raise RuntimeError("CANO audit identity mismatch")

    m200_raw = json.loads(Path(args.m200_evidence).read_text(encoding="utf-8"))
    if m200_raw.get("audit_sha256") != audit_sha or m200_raw.get("input_hash") != audit_sha:
        raise RuntimeError("M001-M200 audit binding mismatch")
    m200_receipts = m200_raw.get("receipts")
    if not isinstance(m200_receipts, dict):
        raise RuntimeError("M001-M200 receipts missing")

    raw_ranges = [
        ("M001-M200", 1, 200, m200_receipts, "seo-avengers-200-local-mirror"),
    ]
    r400 = run_201_400(repo)
    raw_ranges.append(("M201-M400", 201, 400, r400.get("receipts", {}), "seo-avengers-400"))
    r600 = run_extension(repo, "seo-avengers-600", "execute_avengers_600", "CONFIG_SEO_AVENGERS_600")
    raw_ranges.append(("M401-M600", 401, 600, r600.get("receipts", {}), "seo-avengers-600"))
    r800 = run_extension(repo, "seo-avengers-800", "execute_avengers_800", "CONFIG_SEO_AVENGERS_800")
    raw_ranges.append(("M601-M800", 601, 800, r800.get("receipts", {}), "seo-avengers-800"))
    r1000 = run_extension(repo, "seo-avengers-1000", "execute_avengers_1000", "CONFIG_SEO_AVENGERS_1000")
    raw_ranges.append(("M801-M1000", 801, 1000, r1000.get("receipts", {}), "seo-avengers-1000"))
    r2500 = run_1001_2500(repo, audit)
    raw_ranges.append(("M1001-M2500", 1001, 2500, r2500.get("receipts", {}), "seo-avengers-2500-sidecar"))

    ranges = []
    for label, start, end, receipts, source in raw_ranges:
        normalized = normalize_range(label, start, end, audit_sha, receipts, source)
        write_json(evidence_dir / (label.lower() + ".json"), normalized)
        ranges.append({
            "range": label,
            "source": source,
            "receiptCount": normalized["receiptCount"],
            "successCount": normalized["successCount"],
            "insufficientDataCount": normalized["insufficientDataCount"],
            "errorCount": normalized["errorCount"],
            "rangeSha256": normalized["rangeSha256"],
        })

    receipt_count = sum(row["receiptCount"] for row in ranges)
    success_count = sum(row["successCount"] for row in ranges)
    insufficient_count = sum(row["insufficientDataCount"] for row in ranges)
    error_count = sum(row["errorCount"] for row in ranges)
    if receipt_count != 2500:
        raise RuntimeError(f"expected 2500 receipts, got {receipt_count}")
    if error_count != 0:
        raise RuntimeError(f"Avengers runtime errors present:{error_count}")

    unsigned = {
        "schemaVersion": 1,
        "engineId": "SEO_AVENGERS_2500_CANO_ROUND0",
        "siteId": "cano-penal",
        "auditSha256": audit_sha,
        "moduleCount": 2500,
        "receiptCount": receipt_count,
        "successCount": success_count,
        "insufficientDataCount": insufficient_count,
        "errorCount": error_count,
        "ranges": ranges,
        "interpretation": "ALL_2500_RANGES_BOUND_TO_CANO_AUDIT_MISSING_EVIDENCE_REMAINS_INSUFFICIENT_NOT_SUCCESS",
        "productionMutation": "FORBIDDEN",
        "rankingGuarantee": "FORBIDDEN",
        "clientOutcomeForecast": "FORBIDDEN",
    }
    summary = {**unsigned, "summarySha256": sha256_bytes(canonical_bytes(unsigned))}
    write_json(summary_path, summary)
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    main()
