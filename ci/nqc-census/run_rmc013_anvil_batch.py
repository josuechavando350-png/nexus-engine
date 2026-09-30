#!/usr/bin/env python3
"""Run every retained RMC-013 route on one immutable Anvil fork per provider."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_rmc013_anvil_candidate.py")
SPEC = importlib.util.spec_from_file_location("rmc013_anvil_candidate", MODULE_PATH)
assert SPEC and SPEC.loader
candidate = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = candidate
SPEC.loader.exec_module(candidate)

SCHEMA = "nqc-rmc-013-anvil-batch-v1"


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_file(path: Path) -> str:
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
            row = json.loads(line)
            if not isinstance(row, dict):
                raise ValueError(f"{path}:{number}: route row is not an object")
            out.append(row)
    out.sort(
        key=lambda row: (
            str(row.get("candidate_id", "")),
            int(row.get("route_rank", 0)),
            str(row.get("route_id", "")),
        )
    )
    route_ids = [row.get("route_id") for row in out]
    if len(route_ids) != len(set(route_ids)):
        raise ValueError("duplicate route_id in route plan")
    return out


def static_rejection(route: dict, provider_id: str) -> dict | None:
    if route.get("executor_compatibility") != "PFT_AAVE_V3_EXECUTOR_V2_ROUTE":
        return {
            "schema": candidate.SCHEMA,
            "provider_id": provider_id,
            "candidate_id": route["candidate_id"],
            "route_id": route["route_id"],
            "status": "REJECTED",
            "reason": "PFT_EXECUTOR_ROUTE_UNSUPPORTED",
        }
    modeled = int(route["pre_gas_success_net_debt_units"])
    if modeled <= 0:
        return {
            "schema": candidate.SCHEMA,
            "provider_id": provider_id,
            "candidate_id": route["candidate_id"],
            "route_id": route["route_id"],
            "status": "REJECTED",
            "reason": "NON_POSITIVE_PRE_GAS_SUCCESS_NET",
            "modeled_profit_debt_units": str(modeled),
        }
    return None


def batch(
    routes_path: Path,
    rpc_url: str,
    provider_id: str,
    anvil: str,
    cast: str,
    creation_bytecode: str,
    port: int,
    log_path: Path,
) -> tuple[list[dict], dict]:
    planned = rows(routes_path)
    evidence: list[dict] = []
    active: list[dict] = []
    for route in planned:
        rejected = static_rejection(route, provider_id)
        if rejected is None:
            active.append(route)
        else:
            evidence.append(rejected)

    runtime_sha256 = None
    executor = None
    observed_anchor = None
    process: subprocess.Popen[str] | None = None
    log_handle = None

    if active:
        first = active[0]
        anchor_bytes = canonical(first["anchor"])
        pool = candidate.address(first["aave_pool"], "aave_pool")
        for route in active:
            if canonical(route["anchor"]) != anchor_bytes:
                raise ValueError("route batch mixes observation anchors")
            if candidate.address(route["aave_pool"], "aave_pool") != pool:
                raise ValueError("route batch mixes Aave pools")

        block_number = candidate.hex_int(
            first["anchor"]["block_number"], "anchor.block_number"
        )
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_handle = log_path.open("w", encoding="utf-8")
        process = subprocess.Popen(
            [
                anvil,
                "--fork-url",
                rpc_url,
                "--fork-block-number",
                str(block_number),
                "--chain-id",
                str(candidate.hex_int(first["anchor"]["chain_id"], "anchor.chain_id")),
                "--host",
                "127.0.0.1",
                "--port",
                str(port),
                "--silent",
            ],
            stdout=log_handle,
            stderr=subprocess.STDOUT,
            text=True,
        )
        rpc = candidate.Rpc(f"http://127.0.0.1:{port}")
        try:
            candidate.wait_rpc(rpc, process)
            observed_anchor = candidate.verify_anchor(rpc, first)
            executor, runtime = candidate.deploy_runtime(
                rpc,
                creation_bytecode,
                cast,
                candidate.OPERATOR,
                pool,
            )
            if candidate.verify_anchor(rpc, first) != observed_anchor:
                raise RuntimeError("anchor changed while loading executor runtime")
            runtime_sha256 = hashlib.sha256(bytes.fromhex(runtime[2:])).hexdigest()

            for route in active:
                row = candidate.simulate_loaded_fork(
                    route,
                    rpc,
                    provider_id,
                    cast,
                    executor,
                    runtime,
                    observed_anchor,
                )
                evidence.append(row)
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            log_handle.close()

    evidence.sort(
        key=lambda row: (
            str(row["candidate_id"]),
            str(row["route_id"]),
            str(row["provider_id"]),
        )
    )
    if len(evidence) != len(planned):
        raise RuntimeError(
            f"route evidence conservation failed: planned={len(planned)} evidence={len(evidence)}"
        )
    if {row["route_id"] for row in evidence} != {
        row["route_id"] for row in planned
    }:
        raise RuntimeError("route evidence identity set differs from route plan")

    passed = sum(row["status"] == "PASS" for row in evidence)
    rejected = sum(row["status"] == "REJECTED" for row in evidence)
    summary = {
        "schema_version": 1,
        "schema": SCHEMA,
        "status": "RMC_013_ANVIL_BATCH_PASS",
        "provider_id": provider_id,
        "route_plan_count": len(planned),
        "execution_pass_count": passed,
        "execution_rejection_count": rejected,
        "route_conserved": passed + rejected == len(planned),
        "executor": executor,
        "executor_runtime_sha256": runtime_sha256,
        "anchor": observed_anchor,
        "input_sha256": sha256_file(routes_path),
        "live_transaction_sent": False,
        "own_capital_used": False,
    }
    return evidence, summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--routes", type=Path, required=True)
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument("--provider-id", required=True)
    parser.add_argument("--creation-bytecode", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--summary", type=Path, required=True)
    parser.add_argument("--anvil-log", type=Path, required=True)
    parser.add_argument("--anvil", default="anvil")
    parser.add_argument("--cast", default="cast")
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    creation = args.creation_bytecode.read_text(encoding="utf-8").strip()
    evidence, summary = batch(
        args.routes,
        args.rpc_url,
        args.provider_id,
        args.anvil,
        args.cast,
        creation,
        args.port,
        args.anvil_log,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(b"".join(canonical(row) for row in evidence))
    args.summary.write_bytes(canonical(summary))
    print(
        "RMC013_ANVIL_BATCH_PASS",
        f"provider={args.provider_id}",
        f"routes={summary['route_plan_count']}",
        f"pass={summary['execution_pass_count']}",
        f"rejected={summary['execution_rejection_count']}",
    )


if __name__ == "__main__":
    main()
