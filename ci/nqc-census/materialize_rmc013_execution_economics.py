#!/usr/bin/env python3
"""Deterministic RMC-013 physical-evidence -> economics materializer.

This module does not query a network and does not invent capture probability.
It consumes exact route, dual-provider execution, gas-price and D11 capital
source evidence and emits the terminal economics surface required by RMC-013.

Candidate cardinality and quote/variant cardinality are deliberately separate.
Shared gas sources are checked per candidate and emitted as conflict claims;
mutually exclusive future opportunities are never globally summed as if they
execute concurrently.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from pathlib import Path

WAD = 10**18
COST_KINDS = (
    "PROTOCOL_FEE",
    "CAPITAL_FEE",
    "SWAP_FEE",
    "PRICE_IMPACT",
    "GAS",
    "PRIORITY_FEE",
    "BUILDER_PAYMENT",
    "FINANCING",
    "HEDGING",
    "INVENTORY",
    "EXPECTED_FAILURE_REVERT",
    "OPPORTUNITY_COST",
    "MEV",
    "CHAIN_SPECIFIC",
)
SCHEMA = "nqc-rmc-013-materialized-economics-v1"
MODEL_DOMAIN = b"NQC-RMC013-MATERIALIZED-ECONOMICS-V1\0"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hash_obj(value: object) -> str:
    return hash_bytes(canonical(value))


def hash_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rows(path: Path) -> list[dict]:
    out: list[dict] = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number}: JSONL row is not an object")
            out.append(value)
    return out


def write_jsonl(path: Path, values: list[dict]) -> None:
    path.write_bytes(b"".join(canonical(value) for value in values))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def hex256(value: object, field: str) -> str:
    require(isinstance(value, str), f"{field}: expected string")
    raw = value[2:] if value.startswith("0x") else value
    require(len(raw) == 64, f"{field}: expected 32 bytes")
    int(raw, 16)
    return "0x" + raw.lower()


def uint256_hex(value: int) -> str:
    require(0 <= value < 1 << 256, "uint256 overflow")
    return "0x" + f"{value:064x}"


def uint256_from_hex(value: object, field: str) -> int:
    canonical_value = hex256(value, field)
    return int(canonical_value[2:], 16)


def unsigned_decimal(value: object, field: str) -> int:
    require(isinstance(value, str) and value.isdigit(), f"{field}: unsigned decimal required")
    return int(value)


def signed_decimal(value: int) -> str:
    return str(value)


def mul_div_floor(left: int, right: int, denominator: int) -> int:
    require(left >= 0 and right >= 0 and denominator > 0, "invalid mul-div input")
    return left * right // denominator


def evidence(kind: str, basis: object) -> dict:
    doc = {"kind": kind, "basis": basis}
    return {"sha256": hash_obj(doc), **doc}


def cost(kind: str, unconditional: int, on_capture: int, on_failure: int, basis: object) -> dict:
    require(kind in COST_KINDS, f"unknown cost kind {kind}")
    for value in (unconditional, on_capture, on_failure):
        require(value >= 0, f"{kind}: negative cost")
    ev = evidence(f"RMC013_COST_{kind}", basis)
    return {
        "kind": kind,
        "unconditional_usd_wad": str(unconditional),
        "on_capture_usd_wad": str(on_capture),
        "on_failure_usd_wad": str(on_failure),
        "evidence_sha256": ev["sha256"],
        "basis": basis,
    }


def load_unique(path: Path, key: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in rows(path):
        value = row.get(key)
        require(isinstance(value, str) and value, f"{path}: missing {key}")
        require(value not in out, f"{path}: duplicate {key}={value}")
        out[value] = row
    return out


def load_gas_sources(path: Path, anchor: dict) -> list[dict]:
    eligible = []
    for row in rows(path):
        if row.get("capital_class") != "GAS_FUNDING":
            continue
        if row.get("asset") != "NATIVE_GAS":
            continue
        if row.get("capital_ownership") == "OPERATOR_OWNED":
            continue
        if row.get("execution_eligible") is not True:
            continue
        blockers = row.get("execution_blockers")
        require(isinstance(blockers, list), "gas source blockers must be an array")
        if blockers:
            continue
        if row.get("anchor") != anchor:
            continue
        capacity = uint256_from_hex(row.get("executable_capacity"), "executable_capacity")
        if capacity <= 0:
            continue
        source_id = hex256(row.get("source_id"), "source_id")
        eligible.append({"source_id": source_id, "capacity": capacity, "row": row})
    eligible.sort(key=lambda item: item["source_id"])
    return eligible


def allocate_per_candidate(required: int, sources: list[dict]) -> list[dict] | None:
    remaining = required
    allocations = []
    for source in sources:
        if remaining == 0:
            break
        amount = min(remaining, source["capacity"])
        if amount:
            allocations.append({
                "source_id": source["source_id"],
                "amount": uint256_hex(amount),
                "source_executable_capacity": uint256_hex(source["capacity"]),
            })
            remaining -= amount
    return allocations if remaining == 0 else None


def quote_from_variant(
    route: dict,
    execution: dict,
    gas: dict,
    binding: dict,
    gas_evidence_sha: str,
) -> dict:
    semantic = execution.get("semantic_evidence")
    require(isinstance(semantic, dict), "PASS execution lacks semantic_evidence")
    valuation = route.get("valuation")
    require(isinstance(valuation, dict) and valuation.get("unit") == "USD_WAD", "route valuation is not USD_WAD")

    gross = unsigned_decimal(valuation.get("gross_value_usd_wad"), "gross_value_usd_wad")
    gross_deficit = unsigned_decimal(valuation.get("gross_deficit_usd_wad"), "gross_deficit_usd_wad")
    require(gross > 0 and gross_deficit == 0, "quote_from_variant requires strictly positive gross surplus")

    simulated_gas = semantic.get("simulated_gas_used")
    gas_requirement_units = semantic.get("gas_requirement_units")
    require(isinstance(simulated_gas, int) and simulated_gas > 0, "simulated_gas_used invalid")
    require(isinstance(gas_requirement_units, int) and gas_requirement_units >= simulated_gas, "gas_requirement_units invalid")

    base_fee = unsigned_decimal(gas.get("next_block_base_fee_upper_bound_wei"), "next_block_base_fee_upper_bound_wei")
    priority_fee = unsigned_decimal(gas.get("admission_priority_fee_wei"), "admission_priority_fee_wei")
    native = gas.get("native_price")
    require(isinstance(native, dict), "gas evidence lacks native_price")
    native_usd = unsigned_decimal(native.get("native_usd_wad"), "native_usd_wad")

    gas_base_usd = mul_div_floor(simulated_gas * base_fee, native_usd, WAD)
    priority_usd = mul_div_floor(simulated_gas * priority_fee, native_usd, WAD)
    max_loss_usd = mul_div_floor(
        gas_requirement_units * (base_fee + priority_fee), native_usd, WAD
    )

    protocol = unsigned_decimal(valuation.get("protocol_fee_cost_usd_wad"), "protocol_fee_cost_usd_wad")
    capital = unsigned_decimal(valuation.get("capital_fee_cost_usd_wad"), "capital_fee_cost_usd_wad")
    swap = unsigned_decimal(valuation.get("swap_fee_cost_usd_wad"), "swap_fee_cost_usd_wad")
    impact = unsigned_decimal(valuation.get("price_impact_cost_usd_wad"), "price_impact_cost_usd_wad")

    zero = {
        "BUILDER_PAYMENT": "NO_BUILDER_PAYMENT_IN_DECLARED_EXECUTION_PLAN",
        "FINANCING": "FLASH_PREMIUM_ALREADY_ACCOUNTED_AS_CAPITAL_FEE_NO_PERSISTENT_FINANCING",
        "HEDGING": "NO_HEDGE_LEG_IN_DECLARED_ATOMIC_EXECUTION_PLAN",
        "INVENTORY": "NO_OPERATOR_INVENTORY_CONSUMED_OWN_CAPITAL_ZERO",
        "EXPECTED_FAILURE_REVERT": "FAILURE_GAS_ALREADY_BOUNDED_BY_UNCONDITIONAL_GAS_PRIORITY_AND_TAIL_MAX_LOSS",
        "OPPORTUNITY_COST": "NO_OPERATOR_CAPITAL_LOCKED_BY_THIS_ATOMIC_PLAN",
        "MEV": "CAPTURE_AND_COMPETITION_UNCALIBRATED_SHADOW_REQUIRED_NOT_NO_MEV_CLAIM",
        "CHAIN_SPECIFIC": "NO_ADDITIONAL_ETHEREUM_CHAIN_SPECIFIC_FEE_IN_DECLARED_PLAN",
    }

    components = [
        cost("PROTOCOL_FEE", 0, protocol, 0, {"route_id": route["route_id"], "field": "protocol_fee_cost_usd_wad"}),
        cost("CAPITAL_FEE", 0, capital, 0, {"route_id": route["route_id"], "field": "capital_fee_cost_usd_wad"}),
        cost("SWAP_FEE", 0, swap, 0, {"route_id": route["route_id"], "field": "swap_fee_cost_usd_wad"}),
        cost("PRICE_IMPACT", 0, impact, 0, {"route_id": route["route_id"], "field": "price_impact_cost_usd_wad"}),
        cost("GAS", gas_base_usd, 0, 0, {"gas_evidence_sha256": gas_evidence_sha, "gas_used": simulated_gas, "base_fee_wei": str(base_fee)}),
        cost("PRIORITY_FEE", priority_usd, 0, 0, {"gas_evidence_sha256": gas_evidence_sha, "gas_used": simulated_gas, "priority_fee_wei": str(priority_fee)}),
    ]
    components.extend(cost(kind, 0, 0, 0, {"zero_basis": zero[kind]}) for kind in COST_KINDS[6:])
    require([row["kind"] for row in components] == list(COST_KINDS), "cost taxonomy ordering differs")

    success_cost = sum(int(row["unconditional_usd_wad"]) + int(row["on_capture_usd_wad"]) for row in components)
    success_net = gross - success_cost

    route_sha = hash_obj(route)
    execution_sha = hash_obj(execution)
    model_commitment = hash_bytes(MODEL_DOMAIN + bytes.fromhex(gas_evidence_sha))
    quote_core = {
        "candidate_id": route["candidate_id"],
        "route_id": route["route_id"],
        "route_sha256": route_sha,
        "execution_sha256": execution_sha,
        "gas_evidence_sha256": gas_evidence_sha,
        "gas_binding_sha256": hash_obj(binding),
        "model_commitment": model_commitment,
    }
    quote_id = "0x" + hash_obj(quote_core)
    return {
        "schema": SCHEMA,
        "quote_id": quote_id,
        "candidate_id": route["candidate_id"],
        "opportunity_id": route["actionable_candidate_id"],
        "route_id": route["route_id"],
        "execution_plan_commitment": route["route_id"],
        "economic_model_commitment": "0x" + model_commitment,
        "anchor": route["anchor"],
        "valuation_unit": "USD_WAD",
        "trade_size_collateral_units": route["trade_size_collateral_units"],
        "gross_value_usd_wad": str(gross),
        "costs": components,
        "success_cost_usd_wad": str(success_cost),
        "success_path_net_usd_wad": signed_decimal(success_net),
        "simulated_gas_used": simulated_gas,
        "gas_requirement_units": gas_requirement_units,
        "required_native_gas_amount": binding["required_native_gas_amount"],
        "capture": {
            "status": "UNCALIBRATED",
            "probability": None,
            "model_commitment": "0x" + hash_bytes(
                b"NQC-RMC013-CAPTURE-UNCALIBRATED-V1\0" + bytes.fromhex(model_commitment)
            ),
        },
        "tail": {
            "state": "DETERMINISTIC_ATOMIC_MAX_LOSS_BOUND_NO_PROBABILITY_CLAIM",
            "loss_at_confidence_usd_wad": None,
            "absolute_max_loss_usd_wad": str(max_loss_usd),
            "reserve_usd_wad": str(max_loss_usd),
            "evidence_sha256": hash_obj({
                "route_id": route["route_id"],
                "gas_requirement_units": gas_requirement_units,
                "effective_gas_price_budget_wei": gas["effective_gas_price_budget_wei"],
                "native_price": native,
                "atomic_failure_bound": "GAS_ONLY",
            }),
        },
        "evidence": [
            route_sha,
            execution_sha,
            gas_evidence_sha,
            hash_obj(binding),
        ],
    }


def materialize(
    route_plan: Path,
    route_rejections: Path,
    reconciled_path: Path,
    gas_path: Path,
    capital_sources_path: Path,
    d12_summary_path: Path,
    d12_artifact_digest: str,
    out_dir: Path,
) -> dict:
    require(d12_artifact_digest.startswith("sha256:") and len(d12_artifact_digest) == 71, "invalid D12 artifact digest")
    routes = load_unique(route_plan, "route_id")
    reconciled = load_unique(reconciled_path, "route_id")
    require(set(routes) == set(reconciled), "reconciled route set differs from exact route plan")
    route_rejects = rows(route_rejections)

    d12 = json.loads(d12_summary_path.read_text(encoding="utf-8"))
    require(isinstance(d12, dict) and d12.get("status") == "RMC_012_ACTIONABILITY_PASS", "D12 actionability summary is not PASS")
    anchor = d12.get("anchor")
    require(isinstance(anchor, dict), "D12 summary lacks anchor")
    d12_feasible = d12.get("principal_capital_feasible")
    require(isinstance(d12_feasible, int) and d12_feasible >= 0, "invalid D12 feasible count")

    gas = json.loads(gas_path.read_text(encoding="utf-8"))
    require(gas.get("status") == "RMC_013_GAS_PRICE_EVIDENCE_PASS", "gas evidence is not PASS")
    require(gas.get("anchor") == anchor, "gas evidence anchor differs from D12")
    require(gas.get("lookahead_used") is False, "gas evidence used lookahead")
    gas_evidence_sha = hash_file(gas_path)
    effective_gas_price = unsigned_decimal(gas.get("effective_gas_price_budget_wei"), "effective_gas_price_budget_wei")

    candidates: set[str] = set()
    routes_by_candidate: dict[str, list[dict]] = defaultdict(list)
    for route in routes.values():
        candidate = hex256(route.get("candidate_id"), "candidate_id")
        candidates.add(candidate)
        routes_by_candidate[candidate].append(route)
    route_reject_by_candidate = {}
    for row in route_rejects:
        candidate = hex256(row.get("candidate_id"), "candidate_id")
        require(candidate not in route_reject_by_candidate, "duplicate route-unavailable candidate")
        route_reject_by_candidate[candidate] = row
        candidates.add(candidate)
    require(len(candidates) == d12_feasible, f"D12 candidate conservation differs: {len(candidates)} != {d12_feasible}")

    gas_sources = load_gas_sources(capital_sources_path, anchor)

    quotes: list[dict] = []
    rejections: list[dict] = []
    bindings: list[dict] = []
    claims: list[dict] = []
    curves: list[dict] = []
    predictions: list[dict] = []

    for candidate in sorted(candidates):
        if candidate in route_reject_by_candidate:
            row = route_reject_by_candidate[candidate]
            reason = row.get("reason")
            require(isinstance(reason, str) and reason and reason != "UNKNOWN", "route rejection reason invalid")
            rejections.append({
                "candidate_id": candidate,
                "reason": reason,
                "stage": "ROUTE_DISCOVERY",
                "evidence_sha256": hash_obj(row),
            })
            continue

        candidate_routes = sorted(routes_by_candidate[candidate], key=lambda row: row["route_id"])
        physically_passed = []
        physical_reasons = []
        for route in candidate_routes:
            exec_row = reconciled[route["route_id"]]
            if exec_row.get("status") == "PASS":
                physically_passed.append((route, exec_row))
            else:
                reason = exec_row.get("reason")
                require(isinstance(reason, str) and reason and reason != "UNKNOWN", "execution rejection reason invalid")
                physical_reasons.append(reason)
        if not physically_passed:
            rejections.append({
                "candidate_id": candidate,
                "reason": "PHYSICAL_EXECUTION_REJECTED_ALL_VARIANTS",
                "stage": "FORK_EXECUTION",
                "variant_reasons": sorted(set(physical_reasons)),
                "evidence_sha256": hash_obj([reconciled[row["route_id"]] for row in candidate_routes]),
            })
            continue

        positive_gross = []
        for route, exec_row in physically_passed:
            valuation = route.get("valuation")
            require(isinstance(valuation, dict), "route missing valuation")
            gross = unsigned_decimal(valuation.get("gross_value_usd_wad"), "gross_value_usd_wad")
            deficit = unsigned_decimal(valuation.get("gross_deficit_usd_wad"), "gross_deficit_usd_wad")
            if gross > 0 and deficit == 0:
                positive_gross.append((route, exec_row))
        if not positive_gross:
            rejections.append({
                "candidate_id": candidate,
                "reason": "NON_POSITIVE_GROSS_VALUE",
                "stage": "ECONOMIC_DECOMPOSITION",
                "evidence_sha256": hash_obj([route for route, _ in physically_passed]),
            })
            continue

        max_required_wei = 0
        for _, exec_row in positive_gross:
            semantic = exec_row["semantic_evidence"]
            units = semantic.get("gas_requirement_units")
            require(isinstance(units, int) and units > 0, "gas_requirement_units invalid")
            max_required_wei = max(max_required_wei, units * effective_gas_price)
        allocations = allocate_per_candidate(max_required_wei, gas_sources)
        if allocations is None:
            rejections.append({
                "candidate_id": candidate,
                "reason": "INSUFFICIENT_EXTERNAL_GAS_FUNDING",
                "stage": "ZERO_OWN_CAPITAL_GAS",
                "required_native_gas_amount": uint256_hex(max_required_wei),
                "eligible_source_count": len(gas_sources),
                "evidence_sha256": hash_obj({
                    "candidate_id": candidate,
                    "required": uint256_hex(max_required_wei),
                    "sources": [{"source_id": row["source_id"], "capacity": uint256_hex(row["capacity"])} for row in gas_sources],
                }),
            })
            continue

        binding = {
            "candidate_id": candidate,
            "required_native_gas_amount": uint256_hex(max_required_wei),
            "allocations": allocations,
            "allocation_semantics": "PER_CANDIDATE_FEASIBILITY_NOT_GLOBAL_CONCURRENT_CONSUMPTION",
            "evidence": [
                gas_evidence_sha,
                hash_file(capital_sources_path),
            ],
        }
        bindings.append(binding)
        for allocation in allocations:
            claims.append({
                "candidate_id": candidate,
                "resource_kind": "SHARED_EXTERNAL_GAS_SOURCE",
                "resource_id": allocation["source_id"],
                "amount": allocation["amount"],
                "source_executable_capacity": allocation["source_executable_capacity"],
            })

        candidate_quotes = [
            quote_from_variant(route, exec_row, gas, binding, gas_evidence_sha)
            for route, exec_row in positive_gross
        ]
        candidate_quotes.sort(key=lambda row: row["quote_id"])
        quotes.extend(candidate_quotes)
        positive = [row for row in candidate_quotes if int(row["success_path_net_usd_wad"]) > 0]
        variants = [
            {
                "quote_id": row["quote_id"],
                "route_id": row["route_id"],
                "trade_size_collateral_units": row["trade_size_collateral_units"],
                "success_path_net_usd_wad": row["success_path_net_usd_wad"],
            }
            for row in candidate_quotes
        ]
        curve = {
            "candidate_id": candidate,
            "valuation_unit": "USD_WAD",
            "variants": variants,
            "measured_size_points_only": True,
            "interpolation_allowed": False,
            "extrapolation_allowed": False,
            "positive_variant_count": len(positive),
            "capacity_material": bool(positive),
            "commitment": "0x" + hash_obj({"candidate_id": candidate, "variants": variants}),
        }
        curves.append(curve)
        if positive:
            best = sorted(
                positive,
                key=lambda row: (-int(row["success_path_net_usd_wad"]), row["quote_id"]),
            )[0]
            predictions.append({
                "candidate_id": candidate,
                "selected_quote_id": best["quote_id"],
                "selected_route_id": best["route_id"],
                "success_path_net_usd_wad": best["success_path_net_usd_wad"],
                "capture_status": "UNCALIBRATED",
                "capture_probability": None,
                "shadow_calibration_required": True,
                "commitment": "0x" + hash_obj({
                    "candidate_id": candidate,
                    "quote_id": best["quote_id"],
                    "capture_status": "UNCALIBRATED",
                }),
            })

    quotes.sort(key=lambda row: (row["candidate_id"], row["quote_id"]))
    rejections.sort(key=lambda row: row["candidate_id"])
    bindings.sort(key=lambda row: row["candidate_id"])
    claims.sort(key=lambda row: (row["resource_id"], row["candidate_id"]))
    curves.sort(key=lambda row: row["candidate_id"])
    predictions.sort(key=lambda row: row["candidate_id"])

    simulatable_candidates = {row["candidate_id"] for row in quotes}
    rejected_candidates = {row["candidate_id"] for row in rejections}
    require(not (simulatable_candidates & rejected_candidates), "candidate both admitted and rejected")
    require(simulatable_candidates | rejected_candidates == candidates, "candidate coverage incomplete")
    require({row["candidate_id"] for row in bindings} == simulatable_candidates, "gas binding candidate set differs")
    require({row["candidate_id"] for row in curves} == simulatable_candidates, "curve candidate set differs")

    positive_gross_candidates = simulatable_candidates
    positive_net_candidates = {
        row["candidate_id"] for row in quotes if int(row["success_path_net_usd_wad"]) > 0
    }
    shadow_candidates = {row["candidate_id"] for row in predictions}
    require(shadow_candidates == positive_net_candidates, "Shadow handoff differs from positive success-path candidates")

    out_dir.mkdir(parents=True, exist_ok=True)
    output_paths = {
        "execution-economics.jsonl": quotes,
        "execution-rejection-ledger.jsonl": rejections,
        "capacity-curves.jsonl": curves,
        "shadow-predictions.jsonl": predictions,
        "gas-funding-bindings.jsonl": bindings,
        "gas-conflict-claims.jsonl": claims,
    }
    for name, values in output_paths.items():
        write_jsonl(out_dir / name, values)

    input_hashes = {
        "route_plan_sha256": hash_file(route_plan),
        "route_rejections_sha256": hash_file(route_rejections),
        "reconciled_execution_sha256": hash_file(reconciled_path),
        "gas_price_evidence_sha256": gas_evidence_sha,
        "capital_sources_sha256": hash_file(capital_sources_path),
        "d12_summary_sha256": hash_file(d12_summary_path),
    }
    artifact_hashes = {name: hash_file(out_dir / name) for name in output_paths}
    coverage_commitment = "0x" + hash_obj({
        "d12_candidate_ids": sorted(candidates),
        "simulatable_candidate_ids": sorted(simulatable_candidates),
        "rejected_candidate_ids": sorted(rejected_candidates),
    })
    authority_commitment = "0x" + hash_obj({
        "schema": SCHEMA,
        "d12_artifact_digest": d12_artifact_digest,
        "inputs": input_hashes,
        "artifacts": artifact_hashes,
        "coverage_commitment": coverage_commitment,
    })

    summary = {
        "schema_version": 1,
        "status": "RMC_013_REAL_EXECUTION_ECONOMICS_PASS",
        "d12_artifact_digest": d12_artifact_digest,
        "input_candidate_count": len(candidates),
        "execution_simulatable_count": len(simulatable_candidates),
        "explicit_rejection_count": len(rejected_candidates),
        "economics_candidate_count": len(simulatable_candidates),
        "economics_quote_count": len(quotes),
        "execution_variant_count": len(quotes),
        "positive_gross_value_count": len(positive_gross_candidates),
        "positive_success_path_net_count": len(positive_net_candidates),
        "capacity_material_count": len(positive_net_candidates),
        "shadow_prediction_count": len(predictions),
        "capture_calibrated_count": 0,
        "gas_funding_candidate_count": len(bindings),
        "operator_owned_gas_funding_count": 0,
        "zero_own_capital_proven": bool(simulatable_candidates),
        "coverage_complete": True,
        "unresolved_mismatch_count": 0,
        "unknown_rejection_count": 0,
        "realized_profitability_proven": False,
        "monthly_target_probability_proven": False,
        "capture_probability_invented": False,
        "global_concurrent_gas_capacity_claimed": False,
        "shared_gas_conflict_claim_count": len(claims),
        "coverage_commitment": coverage_commitment,
        "authority_commitment": authority_commitment,
    }
    if not simulatable_candidates:
        summary["zero_own_capital_proven"] = False

    (out_dir / "execution-evidence-summary.json").write_bytes(canonical(summary))
    artifact_hashes["execution-evidence-summary.json"] = hash_file(out_dir / "execution-evidence-summary.json")
    manifest = {
        "schema_version": 1,
        "stage": "RMC-013",
        "kind": "REAL_EXECUTION_ECONOMICS",
        "d12_artifact_digest": d12_artifact_digest,
        "input_artifacts": input_hashes,
        "output_artifacts": artifact_hashes,
        "coverage_commitment": coverage_commitment,
        "authority_commitment": authority_commitment,
        "non_claims": [
            "CAPTURE_PROBABILITY_NOT_CALIBRATED",
            "REALIZED_PNL_NOT_CERTIFIED",
            "MONTH1_TARGET_NOT_CERTIFIED",
            "GLOBAL_CONCURRENT_GAS_CAPACITY_NOT_CLAIMED",
        ],
    }
    (out_dir / "evidence-manifest.json").write_bytes(canonical(manifest))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--routes", type=Path, required=True)
    parser.add_argument("--route-rejections", type=Path, required=True)
    parser.add_argument("--reconciled", type=Path, required=True)
    parser.add_argument("--gas-evidence", type=Path, required=True)
    parser.add_argument("--capital-sources", type=Path, required=True)
    parser.add_argument("--d12-summary", type=Path, required=True)
    parser.add_argument("--d12-artifact-digest", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    summary = materialize(
        args.routes,
        args.route_rejections,
        args.reconciled,
        args.gas_evidence,
        args.capital_sources,
        args.d12_summary,
        args.d12_artifact_digest,
        args.out,
    )
    print(
        "RMC013_MATERIALIZED_EXECUTION_ECONOMICS_PASS",
        f"candidates={summary['economics_candidate_count']}",
        f"quotes={summary['economics_quote_count']}",
        f"rejected={summary['explicit_rejection_count']}",
        f"shadow={summary['shadow_prediction_count']}",
    )


if __name__ == "__main__":
    main()
