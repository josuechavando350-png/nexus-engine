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

def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")

def sha256_bytes(value: bytes) -> str:
    return "sha256:" + hashlib.sha256(value).hexdigest()

def normalize_status(receipt: Mapping[str, Any]) -> str:
    raw = str(receipt.get("execution_status", receipt.get("status", ""))).upper()
    if raw == "SUCCESS":
        return "SUCCESS"
    if raw in {"INSUFFICIENT_DATA", "BLOCKED", "STALE", "UNAVAILABLE", "NOT_APPLICABLE"}:
        return "INSUFFICIENT_DATA"
    return "ERROR"

def execute(repo: Path, portfolio: Mapping[str, Any], market: Mapping[str, Any], audit: Mapping[str, Any]) -> Mapping[str, Any]:
    intent_rows = []
    for row in portfolio["keywords"]:
        intent_rows.append({
            "query": row["query"],
            "intent_labels": [row["funnelStage"], row["theme"], row["targetRankBucket"]],
            "age_days": 0,
            "niche": "criminal-law-mexico",
            "silo": row["clusterId"],
            "internal_anchors": [],
            "navigation_entities": [],
            "internal_link_targets": [],
            "conversion_synonyms": {},
        })
    documents = list(market["currentPublicContentDocuments"])
    documents.extend({"document_id": f"audit:{row['id']}", "text": str(row["claim"])} for row in audit["signals"])

    payload = {
        "search_performance_records": [],
        "content_documents": documents,
        "local_business_records": [],
        "search_intent_records": intent_rows,
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
        "local_commercial_terms": ["abogado", "defensa", "consulta", "honorarios", "diagnostico", "precio"],
        "local_service_terms": ["defensa penal", "delitos fiscales", "defraudacion fiscal", "citatorio", "detenido", "audiencia inicial", "fraude", "delitos financieros"],
        "local_location_terms": ["cdmx", "ciudad de mexico", "mexico"],
        "local_urgency_terms": ["urgente", "detenido", "citatorio", "audiencia inicial", "inmediato"],
        "local_question_terms": ["como", "que", "cuando", "cuanto"],
        "local_brand_terms": ["cano", "cano estrategia penal", "eduardo cano"],
        "local_verified_service_terms": ["defensa penal", "delitos fiscales", "defraudacion fiscal", "citatorio", "detenido", "audiencia inicial"],
        "local_verified_location_terms": ["cdmx", "ciudad de mexico"],
        "local_service_groups": {
            "generic_penal": ["defensa penal", "abogado penalista"],
            "penal_fiscal": ["delitos fiscales", "defraudacion fiscal"],
            "urgent": ["citatorio", "detenido", "audiencia inicial"],
            "business": ["fraude", "delitos financieros"],
        },
        "local_location_groups": {"cdmx": ["cdmx", "ciudad de mexico"]},
        "organic_funnel_source_ids": ["organic-search"],
    }
    request = {"schema_version": 1, "payload": payload, "config": config}
    request_path = repo / ".git" / "cano-round2-organic-request.json"
    request_path.write_bytes(canonical_bytes(request))
    try:
        source = r"""
import json,sys
from sidecar.execute_suite import execute_request
request=json.load(open(sys.argv[1],encoding="utf-8"))
result=execute_request(request)
print(json.dumps(result,sort_keys=True,separators=(",",":")))
"""
        suite_root = repo / "seo-avengers-2500"
        env = dict(os.environ)
        env["PYTHONPATH"] = str(suite_root)
        result = subprocess.run(
            [sys.executable, "-c", source, str(request_path)],
            cwd=suite_root, env=env, check=False, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=240,
        )
        if result.returncode != 0:
            raise RuntimeError(f"seo-avengers-2500 organic execution failed:{result.returncode}:{result.stderr[-4000:]}")
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError("seo-avengers-2500 organic execution returned no JSON")
        return json.loads(lines[-1])
    finally:
        request_path.unlink(missing_ok=True)

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--audit", required=True)
    parser.add_argument("--portfolio", required=True)
    parser.add_argument("--market", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    repo = Path(args.repo_root).resolve()
    audit_bytes = Path(args.audit).read_bytes()
    portfolio_bytes = Path(args.portfolio).read_bytes()
    market_bytes = Path(args.market).read_bytes()
    audit = json.loads(audit_bytes)
    portfolio = json.loads(portfolio_bytes)
    market = json.loads(market_bytes)

    if audit.get("siteId") != "cano-penal" or portfolio.get("siteId") != "cano-penal" or market.get("siteId") != "cano-penal":
        raise RuntimeError("CANO organic evidence identity mismatch")
    if portfolio.get("keywordCount") != 42 or len(portfolio.get("keywords", [])) != 42:
        raise RuntimeError("CANO organic portfolio must contain exactly 42 queries")
    if any(row.get("currentRankStatus") != "UNVERIFIED_NO_GSC_OR_SERP_TRACKER" for row in portfolio["keywords"]):
        raise RuntimeError("portfolio must not smuggle current rank claims")

    receipts = execute(repo, portfolio, market, audit).get("receipts", {})
    expected = [f"M{i}" for i in range(1001, 2501)]
    ids = sorted(receipts, key=lambda value: int(value[1:]))
    if ids != expected:
        raise RuntimeError("M1001-M2500 organic receipt range mismatch")

    success = insufficient = errors = 0
    normalized = {}
    for module_id in ids:
        receipt = receipts[module_id]
        status = normalize_status(receipt)
        if status == "SUCCESS":
            success += 1
        elif status == "INSUFFICIENT_DATA":
            insufficient += 1
        else:
            errors += 1
        normalized[module_id] = {"status": status, "receiptSha256": sha256_bytes(canonical_bytes(receipt))}
    if errors:
        raise RuntimeError(f"organic Avengers runtime errors present:{errors}")

    evidence_binding = {
        "auditSha256": sha256_bytes(audit_bytes),
        "portfolioSha256": sha256_bytes(portfolio_bytes),
        "marketSha256": sha256_bytes(market_bytes),
    }
    unsigned = {
        "schemaVersion": 1,
        "engineId": "SEO_AVENGERS_1500_CANO_ROUND2_ORGANIC",
        "siteId": "cano-penal",
        **evidence_binding,
        "moduleRange": "M1001-M2500",
        "moduleCount": 1500,
        "receiptCount": 1500,
        "successCount": success,
        "insufficientDataCount": insufficient,
        "errorCount": errors,
        "plannedKeywordCount": 42,
        "searchPerformanceRecordCount": 0,
        "currentRankClaim": "FORBIDDEN",
        "searchVolumeClaim": "FORBIDDEN",
        "productionMutation": "FORBIDDEN",
        "interpretation": "ORGANIC_PORTFOLIO_AND_PUBLIC_CONTENT_DIAGNOSTIC; NO_GSC_RANK_OR_CLIENT_OUTCOME_EVIDENCE",
        "receipts": normalized,
    }
    summary = {**unsigned, "summarySha256": sha256_bytes(canonical_bytes(unsigned))}
    Path(args.out).write_bytes(canonical_bytes(summary) + b"\n")
    print(json.dumps({k: summary[k] for k in (
        "engineId","moduleCount","successCount","insufficientDataCount","errorCount",
        "portfolioSha256","marketSha256","summarySha256"
    )}, ensure_ascii=False, sort_keys=True))

if __name__ == "__main__":
    main()
