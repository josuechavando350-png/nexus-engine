#!/usr/bin/env python3
"""Fail-closed two-provider reconciliation for RMC-013 fork evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

SCHEMA = "nqc-rmc-013-provider-reconciliation-v1"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def rows(path: Path) -> list[dict]:
    values = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{number}: JSONL row is not an object")
            values.append(row)
    return values


def unique_by_route(path: Path) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for row in rows(path):
        route_id = row.get("route_id")
        if not isinstance(route_id, str) or not route_id.startswith("0x"):
            raise ValueError(f"{path}: invalid route_id")
        if route_id in out:
            raise ValueError(f"{path}: duplicate route_id {route_id}")
        out[route_id] = row
    return out


def row_sha256(row: dict) -> str:
    return hashlib.sha256(canonical(row)).hexdigest()


PASS_FIELDS = (
    "candidate_id",
    "route_id",
    "status",
    "anchor",
    "executor",
    "executor_runtime_sha256",
    "executor_runtime_keccak256",
    "calldata_sha256",
    "realized_profit_debt_units_before_gas",
    "simulated_gas_used",
    "simulated_gas_used_basis",
    "gas_requirement_units",
    "gas_requirement_basis",
    "fork_local_executor_code_injected",
    "fork_local_operator_balance_overridden",
    "operator_balance_override_is_capital_evidence",
    "live_transaction_sent",
    "own_capital_used",
)

STATIC_REJECTION_FIELDS = (
    "candidate_id",
    "route_id",
    "status",
    "reason",
    "modeled_profit_debt_units",
)

REVERT_REJECTION_FIELDS = (
    "candidate_id",
    "route_id",
    "status",
    "reason",
    "revert_selector",
    "revert_data_sha256",
    "anchor",
    "executor",
    "executor_runtime_sha256",
    "calldata_sha256",
)


def projection(row: dict) -> dict:
    status = row.get("status")
    if status == "PASS":
        return {field: row.get(field) for field in PASS_FIELDS}
    if status != "REJECTED":
        raise ValueError(f"unknown execution status {status!r}")
    reason = row.get("reason")
    if reason == "FORK_EXECUTION_REVERTED":
        if not row.get("revert_data_sha256"):
            raise ValueError("fork revert has no content-addressed revert data")
        return {field: row.get(field) for field in REVERT_REJECTION_FIELDS}
    return {field: row.get(field) for field in STATIC_REJECTION_FIELDS}


def reconcile(
    route_plan: Path,
    left_path: Path,
    right_path: Path,
    left_summary_path: Path,
    right_summary_path: Path,
) -> tuple[list[dict], dict]:
    planned = unique_by_route(route_plan)
    left = unique_by_route(left_path)
    right = unique_by_route(right_path)
    expected = set(planned)
    if set(left) != expected or set(right) != expected:
        raise ValueError(
            "provider route identity sets differ from exact route plan "
            f"planned={len(expected)} left={len(left)} right={len(right)}"
        )

    left_summary = json.loads(left_summary_path.read_text(encoding="utf-8"))
    right_summary = json.loads(right_summary_path.read_text(encoding="utf-8"))
    for summary in (left_summary, right_summary):
        if summary.get("status") != "RMC_013_ANVIL_BATCH_PASS":
            raise ValueError("provider batch summary is not PASS")
        if summary.get("route_conserved") is not True:
            raise ValueError("provider batch did not conserve route set")
        if summary.get("route_plan_count") != len(expected):
            raise ValueError("provider batch route count differs from plan")
    if left_summary.get("provider_id") == right_summary.get("provider_id"):
        raise ValueError("provider reconciliation received duplicate provider id")

    reconciled = []
    for route_id in sorted(expected):
        lrow = left[route_id]
        rrow = right[route_id]
        lproj = projection(lrow)
        rproj = projection(rrow)
        if lproj != rproj:
            raise ValueError(
                f"provider semantic mismatch route={route_id} "
                f"left={json.dumps(lproj, sort_keys=True)} "
                f"right={json.dumps(rproj, sort_keys=True)}"
            )
        plan = planned[route_id]
        if lrow.get("candidate_id") != plan.get("candidate_id"):
            raise ValueError(f"candidate identity mismatch route={route_id}")
        if lrow.get("status") == "PASS":
            modeled = int(plan["pre_gas_success_net_debt_units"])
            realized = int(lrow["realized_profit_debt_units_before_gas"])
            if modeled != realized:
                raise ValueError(
                    f"reconciled fork/model profit mismatch route={route_id}"
                )
        reconciled.append(
            {
                "schema": SCHEMA,
                "candidate_id": lrow["candidate_id"],
                "route_id": route_id,
                "status": lrow["status"],
                "reason": lrow.get("reason"),
                "provider_consensus": True,
                "semantic_evidence": lproj,
                "provider_evidence": [
                    {
                        "provider_id": left_summary["provider_id"],
                        "row_sha256": row_sha256(lrow),
                    },
                    {
                        "provider_id": right_summary["provider_id"],
                        "row_sha256": row_sha256(rrow),
                    },
                ],
            }
        )

    passed = sum(row["status"] == "PASS" for row in reconciled)
    rejected = len(reconciled) - passed
    summary = {
        "schema_version": 1,
        "schema": SCHEMA,
        "status": "RMC_013_PROVIDER_RECONCILIATION_PASS",
        "provider_ids": sorted(
            [left_summary["provider_id"], right_summary["provider_id"]]
        ),
        "route_plan_count": len(expected),
        "reconciled_route_count": len(reconciled),
        "execution_pass_count": passed,
        "execution_rejection_count": rejected,
        "provider_mismatch_count": 0,
        "unexplained_mismatch_count": 0,
        "route_conserved": len(reconciled) == len(expected),
    }
    return reconciled, summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--routes", type=Path, required=True)
    parser.add_argument("--left", type=Path, required=True)
    parser.add_argument("--right", type=Path, required=True)
    parser.add_argument("--left-summary", type=Path, required=True)
    parser.add_argument("--right-summary", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    args = parser.parse_args()

    reconciled, summary = reconcile(
        args.routes,
        args.left,
        args.right,
        args.left_summary,
        args.right_summary,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(b"".join(canonical(row) for row in reconciled))
    args.summary.write_bytes(canonical(summary))
    print(
        "RMC013_PROVIDER_RECONCILIATION_PASS",
        f"routes={summary['route_plan_count']}",
        f"pass={summary['execution_pass_count']}",
        f"rejected={summary['execution_rejection_count']}",
    )


if __name__ == "__main__":
    main()
