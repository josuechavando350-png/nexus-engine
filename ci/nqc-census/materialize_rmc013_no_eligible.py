#!/usr/bin/env python3
"""Fail-closed RMC-013 terminal coverage of an authentically EMPTY D12 universe.

No RPC data, quote, fork execution or gas price is synthesized. This negative
certificate is legal only when every admitted D12 opportunity was independently
rejected by the capital principal/flash feasibility gate.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


def require(condition: bool, reason: str) -> None:
    if not condition:
        raise ValueError(reason)


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def read_object(path: Path) -> dict:
    result = json.loads(path.read_bytes())
    require(isinstance(result, dict), f"{path.name}: JSON object required")
    return result


def read_jsonl(path: Path) -> list[dict]:
    raw = path.read_bytes()
    require(not raw or raw.endswith(b"\n"), f"{path.name}: missing final newline")
    entries: list[dict] = []
    for line in raw.splitlines():
        require(bool(line), f"{path.name}: empty row")
        value = json.loads(line)
        require(isinstance(value, dict), f"{path.name}: invalid row")
        entries.append(value)
    return entries


def create(
    cert_path: Path,
    summary_path: Path,
    records_path: Path,
    promotions_path: Path,
    sources_path: Path,
    d12_artifact_digest: str,
    code_commit: str,
    code_tree: str,
    output_dir: Path,
) -> dict:
    require(re.fullmatch(r"sha256:[0-9a-f]{64}", d12_artifact_digest) is not None, "invalid D12 artifact digest")
    for label, value, width in [("commit", code_commit, 40), ("tree", code_tree, 40)]:
        require(len(value) == width and re.fullmatch(r"[0-9a-f]+", value) is not None, f"invalid code {label}")
    cert = read_object(cert_path)
    summary = read_object(summary_path)
    require(cert.get("status") == "RMC_012_TERMINAL_ACTIONABILITY_CERTIFIED", "D12 certificate not terminal")
    require(cert.get("schema_version") == 2, "D12 certificate schema mismatch")
    require(summary.get("status") == "RMC_012_ACTIONABILITY_PASS", "D12 summary not certified")
    require(summary.get("principal_capital_conserved") is True, "D12 principal not conserved")
    require(cert.get("principal_capital_promotion_certified") is True, "D12 promotions not certified")
    require(cert.get("gas_funding_certified") is False, "unexpected D12 gas claim")
    require(cert.get("portfolio_concurrent_capacity_certified") is False, "unexpected D12 capacity claim")
    require(cert.get("realized_pnl_certified") is False, "unexpected D12 P&L claim")
    require(cert.get("economics_certified") is False, "unexpected preexisting economics claim")
    require(summary.get("portfolio_simultaneously_feasible") is False, "D12 portfolio claims feasible")
    require(cert.get("portfolio_simultaneously_feasible") is False, "D12 certificate claims feasible")
    require(isinstance(summary.get("anchor"), dict), "D12 anchor missing")
    for key in ["code_commit", "code_tree", "expected_pairs", "admitted", "rejected",
                "principal_capital_feasible", "principal_capital_rejected",
                "principal_capital_promoted", "d11_capital_sources_sha256"]:
        require(cert.get(key) == summary.get(key), f"D12 summary/certificate {key} mismatch")

    expected = summary["expected_pairs"]
    admitted = summary["admitted"]
    rejected = summary["rejected"]
    promoted = summary["principal_capital_promoted"]
    for name, count in [("expected", expected), ("admitted", admitted),
                        ("rejected", rejected), ("promoted", promoted)]:
        require(type(count) is int and count >= 0, f"{name} count invalid")
    require(expected == admitted + rejected, "D12 actionability count nonconservation")
    require(promoted == admitted, "D12 capital promotion nonconservation")
    require(summary["principal_capital_feasible"] == 0, "positive capital-feasible universe requires actual gas/route/fork evidence")
    require(summary["principal_capital_rejected"] == admitted, "not all admitted opportunities rejected for principal")
    require(cert.get("portfolio_candidate_claim_count") == admitted, "D12 portfolio claims do not cover admitted set")

    require(sha_file(sources_path) == summary["d11_capital_sources_sha256"].removeprefix("sha256:"),
            "D11 source bytes do not match D12 authority")
    require(sha_file(records_path) == summary["records_sha256"].removeprefix("sha256:"),
            "D12 records changed from certified summary")
    require(sha_file(promotions_path) == summary["capital_promotions_sha256"].removeprefix("sha256:"),
            "D12 promotions changed from certified summary")

    records = read_jsonl(records_path)
    promotions = read_jsonl(promotions_path)
    require(len(records) == expected, "D12 actionability records incomplete")
    require(len(promotions) == admitted, "D12 capital promotion records incomplete")
    admitted_ids: set[str] = set()
    seen_pairs: set[str] = set()
    rejected_count = 0
    for row in records:
        pair_id = row.get("pair_id")
        require(isinstance(pair_id, str) and re.fullmatch(r"[0-9a-f]{64}", pair_id) is not None,
                "D12 pair id invalid")
        require(pair_id not in seen_pairs, "D12 duplicate pair")
        seen_pairs.add(pair_id)
        if row.get("status") == "ADMITTED":
            candidate = row.get("candidate_id")
            require(isinstance(candidate, str) and re.fullmatch(r"[0-9a-f]{64}", candidate) is not None,
                    "D12 admitted candidate id invalid")
            require(candidate not in admitted_ids, "D12 duplicate admitted candidate")
            admitted_ids.add(candidate)
        else:
            require(row.get("status") == "REJECTED", "D12 record unclassified")
            reason = row.get("reason")
            require(isinstance(reason, str) and reason and reason != "UNKNOWN",
                    "D12 unclassified actionability rejection")
            rejected_count += 1
    require(len(admitted_ids) == admitted and rejected_count == rejected, "D12 actionability classification differs")
    seen_promotions: set[str] = set()
    rejection_reasons: dict[str, int] = {}
    for row in promotions:
        candidate = row.get("actionable_candidate_id")
        require(candidate in admitted_ids and candidate not in seen_promotions, "D12 candidate promotion is missing or duplicate")
        seen_promotions.add(candidate)
        require(row.get("capital_status") == "REJECTED", "capital-feasible promotion violates empty scope")
        reason = row.get("rejection_reason")
        require(isinstance(reason, str) and reason and reason != "UNKNOWN", "unknown D12 capital rejection")
        require(row.get("allocations") == [], "rejected D12 promotion carries capital allocation")
        require(row.get("gas_funding_certified") is False, "D12 promotion claims gas funding")
        rejection_reasons[reason] = rejection_reasons.get(reason, 0) + 1
    require(seen_promotions == admitted_ids, "D12 admitted candidate not exhaustively capital classified")

    proof = {
        "schema_version": 1,
        "status": "RMC_013_EXACT_EMPTY_CAPITAL_FEASIBLE_UNIVERSE",
        "source_stage": "RMC-012",
        "d12_artifact_digest": d12_artifact_digest,
        "d12_terminal_certificate_sha256": "sha256:" + sha_file(cert_path),
        "d12_actionability_summary_sha256": "sha256:" + sha_file(summary_path),
        "d12_records_sha256": "sha256:" + sha_file(records_path),
        "d12_promotions_sha256": "sha256:" + sha_file(promotions_path),
        "d11_sources_sha256": "sha256:" + sha_file(sources_path),
        "anchor": summary["anchor"],
        "d12_admitted": admitted,
        "d12_rejected": rejected,
        "d12_principal_capital_rejected": admitted,
        "d12_capital_feasible_count": 0,
        "d12_rejection_reason_counts": dict(sorted(rejection_reasons.items())),
        "no_routes_eligible_to_simulate": True,
        "no_physical_fork_executions_performed": True,
        "no_rpc_gas_evidence_collected": True,
        "reason": "D12_PROVEN_ZERO_PRINCIPAL_CAPITAL_FEASIBLE_CANDIDATES",
        "capture_probability_calibrated": False,
        "realized_nexus_pnl_proven": False,
        "zero_own_capital_execution_proven": False,
        "no_global_opportunity_absence_claim": True,
        "code_commit": code_commit,
        "code_tree": code_tree,
    }
    proof_bytes = canonical(proof)
    authority = "0x" + digest(b"NQC_RMC013_ZERO_ELIGIBLE_AUTHORITY_V1\0" + proof_bytes)
    coverage = "0x" + digest(b"NQC_RMC013_ZERO_ELIGIBLE_COVERAGE_V1\0" + proof_bytes)
    counts = ["input_candidate_count", "execution_simulatable_count", "explicit_rejection_count",
              "economics_candidate_count", "economics_quote_count", "execution_variant_count",
              "positive_gross_value_count", "positive_success_path_net_count",
              "capacity_material_count", "shadow_prediction_count", "capture_calibrated_count",
              "gas_funding_candidate_count", "operator_owned_gas_funding_count",
              "shared_gas_conflict_claim_count", "unknown_rejection_count",
              "unresolved_mismatch_count"]
    summary_out = {key: 0 for key in counts}
    summary_out.update({
        "schema_version": 1,
        "status": "RMC_013_NO_EXECUTION_ELIGIBLE_CANDIDATES_PROVEN",
        "d12_artifact_digest": d12_artifact_digest,
        "authority_commitment": authority,
        "coverage_commitment": coverage,
        "coverage_complete": True,
        "capture_probability_invented": False,
        "global_concurrent_gas_capacity_claimed": False,
        "gas_price_evidence_collected": False,
        "fork_simulations_executed": 0,
        "physical_execution_claimed": False,
        "capture_calibrated_count": 0,
        "zero_own_capital_proven": False,
        "realized_profitability_proven": False,
        "monthly_target_probability_proven": False,
        "own_capital_used": False,
        "not_a_profitability_certificate": True,
        "scope": "EXACT_EMPTY_D12_CAPITAL_FEASIBLE_SET_ONLY",
        "zero_input_proof_sha256": "sha256:" + digest(proof_bytes),
    })
    physical = {
        "schema_version": 1,
        "status": "RMC_013_NO_PHYSICAL_EXECUTION_REQUIRED_EMPTY_UNIVERSE",
        "code_commit": code_commit,
        "code_tree": code_tree,
        "d12_artifact_digest": d12_artifact_digest,
        "gas_price_evidence_collected": False,
        "provider_consensus": False,
        "fork_simulations_executed": 0,
        "onchain_transactions_sent": 0,
        "physical_execution_claimed": False,
        "own_capital_used": False,
        "realized_pnl_certified": False,
        "zero_input_proof_sha256": "sha256:" + digest(proof_bytes),
    }
    require(not output_dir.exists() or not list(output_dir.iterdir()), "output must be empty")
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "zero-capital-feasible-proof.json").write_bytes(proof_bytes)
    empty_files = ["execution-economics.jsonl", "execution-rejection-ledger.jsonl",
                   "capacity-curves.jsonl", "shadow-predictions.jsonl",
                   "gas-funding-bindings.jsonl", "gas-conflict-claims.jsonl"]
    for name in empty_files:
        (output_dir / name).write_bytes(b"")
    (output_dir / "execution-evidence-summary.json").write_bytes(canonical(summary_out))
    (output_dir / "physical-execution-summary.json").write_bytes(canonical(physical))
    included = ["zero-capital-feasible-proof.json", "execution-evidence-summary.json",
                "physical-execution-summary.json", *empty_files]
    manifest = {
        "schema_version": 1,
        "status": "RMC_013_EMPTY_SET_EVIDENCE_COMPLETE",
        "d12_artifact_digest": d12_artifact_digest,
        "authority_commitment": authority,
        "coverage_commitment": coverage,
        "artifact_digests": [{"name": name, "sha256": "sha256:" + sha_file(output_dir / name)}
                             for name in sorted(included)],
        "non_claims": ["NO_EXECUTION_SIMULATIONS_PERFORMED", "NO_HISTORICAL_GAS_PRICES_MEASURED",
                       "NO_SHADOW_CAPTURE_CALIBRATION", "NO_REALIZED_PNL",
                       "NO_PROFITABILITY_OR_RELIABILITY_PROOF"],
    }
    (output_dir / "evidence-manifest.json").write_bytes(canonical(manifest))
    all_files = sorted([p for p in output_dir.iterdir() if p.is_file()])
    (output_dir / "archive.sha256").write_text("".join(f"{sha_file(path)}  {path.name}\n" for path in all_files))
    print("RMC013_EMPTY_D12_FEASIBLE_SET=PROVEN", f"admitted={admitted}", f"rejected={rejected}",
          f"capital_feasible=0", f"authority={authority}")
    return summary_out


def main() -> None:
    parser = argparse.ArgumentParser()
    for name in ["d12-certificate", "d12-summary", "d12-records",
                 "d12-promotions", "d11-sources", "d12-artifact-digest",
                 "code-commit", "code-tree", "out"]:
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    create(
        Path(args.d12_certificate), Path(args.d12_summary), Path(args.d12_records),
        Path(args.d12_promotions), Path(args.d11_sources), args.d12_artifact_digest,
        args.code_commit, args.code_tree, Path(args.out),
    )


if __name__ == "__main__":
    main()
