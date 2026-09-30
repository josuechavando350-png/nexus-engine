#!/usr/bin/env python3
"""Execute one RMC-013 Aave/V2 route against one exact Anvil fork.

The executor is first deployed only to materialize its immutable-bearing runtime.
The deployment is then reverted back to the exact Census anchor and that runtime
is injected with anvil_setCode. The economic call and gas estimate therefore run
against the original block number/timestamp/protocol state, not a post-deploy
block.

No live transaction is signed or broadcast. The only upstream is the declared
archive RPC used by the local fork.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

SCHEMA = "nqc-rmc-013-anvil-candidate-v1"
EXECUTE_SIG = (
    "execute((uint256,uint256,address,address,address,uint256,uint256,"
    "(address,address,address,uint256,uint256)[]))"
)
OPERATOR = "0x00000000000000000000000000000000000a11ce"
DEPLOY_GAS = 8_000_000


class RpcError(RuntimeError):
    def __init__(self, method: str, error: object):
        super().__init__(f"{method}: {error}")
        self.method = method
        self.error = error


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def hex_int(value: object, field: str) -> int:
    if isinstance(value, int):
        if value < 0:
            raise ValueError(f"{field} is negative")
        return value
    if isinstance(value, str):
        try:
            parsed = int(value, 0)
        except ValueError as error:
            raise ValueError(f"{field} is not an integer") from error
        if parsed < 0:
            raise ValueError(f"{field} is negative")
        return parsed
    raise ValueError(f"{field} is not an integer")


def address(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} is not an address string")
    value = value.lower()
    if len(value) != 42 or not value.startswith("0x"):
        raise ValueError(f"{field} is not a 20-byte address")
    int(value[2:], 16)
    return value


def hash32(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} is not a hash string")
    value = value.lower()
    if len(value) != 66 or not value.startswith("0x"):
        raise ValueError(f"{field} is not 32 bytes")
    int(value[2:], 16)
    return value


class Rpc:
    def __init__(self, url: str):
        self.url = url
        self.request_id = 0

    def call(self, method: str, params: list[Any]) -> Any:
        self.request_id += 1
        payload = json.dumps(
            {
                "jsonrpc": "2.0",
                "id": self.request_id,
                "method": method,
                "params": params,
            }
        ).encode()
        request = urllib.request.Request(
            self.url,
            data=payload,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                body = json.loads(response.read())
        except urllib.error.URLError as error:
            raise RpcError(method, str(error)) from error
        if "error" in body:
            raise RpcError(method, body["error"])
        if "result" not in body:
            raise RpcError(method, body)
        return body["result"]


def command(args: list[str]) -> str:
    result = subprocess.run(args, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def wait_rpc(rpc: Rpc, process: subprocess.Popen[str]) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"anvil exited early with code {process.returncode}")
        try:
            rpc.call("eth_chainId", [])
            return
        except (RpcError, ConnectionError):
            time.sleep(0.1)
    raise TimeoutError("anvil did not become ready")


def receipt(rpc: Rpc, tx_hash: str) -> dict:
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        value = rpc.call("eth_getTransactionReceipt", [tx_hash])
        if value is not None:
            if not isinstance(value, dict):
                raise ValueError("receipt is not an object")
            return value
        time.sleep(0.05)
    raise TimeoutError(f"receipt not mined: {tx_hash}")


def append_constructor(bytecode: str, cast: str, operator: str, pool: str) -> str:
    if not bytecode.startswith("0x"):
        raise ValueError("creation bytecode must start with 0x")
    encoded = command([cast, "abi-encode", "f(address,address)", operator, pool])
    if not encoded.startswith("0x"):
        raise ValueError("cast abi-encode did not return hex")
    return bytecode + encoded[2:]


def plan_tuple(route: dict) -> str:
    anchor = route["anchor"]
    hops = route["hops"]
    hop_text = ",".join(
        "("
        + ",".join(
            [
                address(hop["pair"], "hop.pair"),
                address(hop["token_in"], "hop.token_in"),
                address(hop["token_out"], "hop.token_out"),
                str(hex_int(hop["amount_in"], "hop.amount_in")),
                str(hex_int(hop["amount_out"], "hop.amount_out")),
            ]
        )
        + ")"
        for hop in hops
    )
    return (
        "("
        + ",".join(
            [
                str(hex_int(anchor["chain_id"], "anchor.chain_id")),
                str(hex_int(anchor["block_number"], "anchor.block_number")),
                address(route["borrower"], "borrower"),
                address(route["collateral_asset"], "collateral_asset"),
                address(route["debt_asset"], "debt_asset"),
                str(hex_int(route["principal_debt_units"], "principal_debt_units")),
                "1",
                f"[{hop_text}]",
            ]
        )
        + ")"
    )


def execute_calldata(route: dict, cast: str) -> str:
    value = plan_tuple(route)
    data = command([cast, "calldata", EXECUTE_SIG, value])
    if not data.startswith("0x"):
        raise ValueError("cast calldata did not return hex")
    return data


def verify_anchor(rpc: Rpc, route: dict) -> dict:
    anchor = route.get("anchor")
    if not isinstance(anchor, dict):
        raise ValueError("route has no anchor object")
    number = hex_int(anchor["block_number"], "anchor.block_number")
    chain = hex_int(anchor["chain_id"], "anchor.chain_id")
    observed_chain = int(rpc.call("eth_chainId", []), 16)
    if observed_chain != chain:
        raise ValueError(f"chain id mismatch: {observed_chain} != {chain}")
    block = rpc.call("eth_getBlockByNumber", [hex(number), False])
    if not isinstance(block, dict):
        raise ValueError("anchor block unavailable")
    expected = {
        "number": number,
        "hash": hash32(anchor["block_hash"], "anchor.block_hash"),
        "parentHash": hash32(anchor["parent_hash"], "anchor.parent_hash"),
        "stateRoot": hash32(anchor["state_root"], "anchor.state_root"),
        "timestamp": hex_int(anchor["timestamp"], "anchor.timestamp"),
    }
    observed = {
        "number": int(block["number"], 16),
        "hash": str(block["hash"]).lower(),
        "parentHash": str(block["parentHash"]).lower(),
        "stateRoot": str(block["stateRoot"]).lower(),
        "timestamp": int(block["timestamp"], 16),
    }
    if observed != expected:
        raise ValueError(f"fork anchor mismatch: observed={observed} expected={expected}")
    return {
        **observed,
        "baseFeePerGas": int(block.get("baseFeePerGas", "0x0"), 16),
    }


def deploy_runtime(
    rpc: Rpc,
    creation_bytecode: str,
    cast: str,
    operator: str,
    pool: str,
) -> tuple[str, str]:
    original_code = rpc.call("eth_getCode", [operator, "latest"])
    original_nonce = int(rpc.call("eth_getTransactionCount", [operator, "latest"]), 16)
    original_balance = rpc.call("eth_getBalance", [operator, "latest"])
    if original_code not in {"0x", "0x0"} or original_nonce != 0:
        raise RuntimeError("local operator address is occupied at the Census anchor")
    snapshot = rpc.call("evm_snapshot", [])
    rpc.call("anvil_impersonateAccount", [operator])
    rpc.call("anvil_setBalance", [operator, hex(10**30)])
    creation = append_constructor(creation_bytecode, cast, operator, pool)
    tx = {
        "from": operator,
        "data": creation,
        "gas": hex(DEPLOY_GAS),
    }
    tx_hash = rpc.call("eth_sendTransaction", [tx])
    deployed = receipt(rpc, tx_hash)
    if int(deployed["status"], 16) != 1:
        raise RuntimeError("executor deployment reverted")
    contract = address(deployed.get("contractAddress"), "contractAddress")
    runtime = rpc.call("eth_getCode", [contract, "latest"])
    if not isinstance(runtime, str) or runtime in {"0x", "0x0"}:
        raise RuntimeError("executor deployment produced no runtime")
    if rpc.call("evm_revert", [snapshot]) is not True:
        raise RuntimeError("failed to revert executor deployment")
    if rpc.call("eth_getCode", [operator, "latest"]) != original_code:
        raise RuntimeError("operator code changed across deployment revert")
    if int(rpc.call("eth_getTransactionCount", [operator, "latest"]), 16) != original_nonce:
        raise RuntimeError("operator nonce changed across deployment revert")
    if rpc.call("eth_getBalance", [operator, "latest"]) != original_balance:
        raise RuntimeError("operator balance changed across deployment revert")
    preexisting = rpc.call("eth_getCode", [contract, "latest"])
    if preexisting not in {"0x", "0x0"}:
        raise RuntimeError("derived executor address already has code at the Census anchor")
    rpc.call("anvil_setCode", [contract, runtime])
    # eth_estimateGas enforces sender funding; this local override is transport
    # only and is never accepted as OWN_CAPITAL evidence.
    rpc.call("anvil_setBalance", [operator, hex(10**30)])
    if rpc.call("eth_getCode", [contract, "latest"]).lower() != runtime.lower():
        raise RuntimeError("anvil_setCode runtime readback mismatch")
    return contract, runtime


def simulate(
    route: dict,
    rpc_url: str,
    provider_id: str,
    anvil: str,
    cast: str,
    creation_bytecode: str,
    port: int,
    log_path: Path,
) -> dict:
    if route.get("executor_compatibility") != "PFT_AAVE_V3_EXECUTOR_V2_ROUTE":
        return {
            "schema": SCHEMA,
            "provider_id": provider_id,
            "candidate_id": route["candidate_id"],
            "route_id": route["route_id"],
            "status": "REJECTED",
            "reason": "PFT_EXECUTOR_ROUTE_UNSUPPORTED",
        }
    if not route.get("hops"):
        raise ValueError("PFT executor route unexpectedly has zero hops")

    block_number = hex_int(route["anchor"]["block_number"], "anchor.block_number")
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
            str(hex_int(route["anchor"]["chain_id"], "anchor.chain_id")),
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
    local_url = f"http://127.0.0.1:{port}"
    rpc = Rpc(local_url)
    try:
        wait_rpc(rpc, process)
        observed_anchor = verify_anchor(rpc, route)
        pool = address(route["aave_pool"], "aave_pool")
        executor, runtime = deploy_runtime(
            rpc, creation_bytecode, cast, OPERATOR, pool
        )
        # Deployment was reverted; anchor must still be exact after injecting code.
        readback_anchor = verify_anchor(rpc, route)
        if readback_anchor != observed_anchor:
            raise RuntimeError("anchor changed while materializing executor runtime")

        calldata = execute_calldata(route, cast)
        call = {
            "from": OPERATOR,
            "to": executor,
            "data": calldata,
        }
        try:
            returned = rpc.call("eth_call", [call, "latest"])
        except RpcError as error:
            return {
                "schema": SCHEMA,
                "provider_id": provider_id,
                "candidate_id": route["candidate_id"],
                "route_id": route["route_id"],
                "status": "REJECTED",
                "reason": "FORK_EXECUTION_REVERTED",
                "rpc_error": error.error,
                "anchor": observed_anchor,
                "executor": executor,
                "executor_runtime_sha256": hashlib.sha256(
                    bytes.fromhex(runtime[2:])
                ).hexdigest(),
                "calldata_sha256": hashlib.sha256(
                    bytes.fromhex(calldata[2:])
                ).hexdigest(),
            }

        if not isinstance(returned, str) or not returned.startswith("0x"):
            raise RuntimeError("eth_call returned non-hex data")
        raw = returned[2:]
        if len(raw) != 64:
            raise RuntimeError(f"executor return is not one uint256 word: {returned}")
        realized_profit = int(raw, 16)
        modeled_profit = int(route["pre_gas_success_net_debt_units"])
        if modeled_profit <= 0:
            raise RuntimeError("non-positive modeled route unexpectedly executed")
        if realized_profit != modeled_profit:
            raise RuntimeError(
                f"fork/model profit mismatch: fork={realized_profit} model={modeled_profit}"
            )

        gas_estimate = int(rpc.call("eth_estimateGas", [call, "latest"]), 16)
        if gas_estimate <= 21_000:
            raise RuntimeError(f"implausible gas estimate {gas_estimate}")
        trace = rpc.call("debug_traceCall", [call, "latest", {}])
        if not isinstance(trace, dict) or trace.get("failed") is True:
            raise RuntimeError("debug_traceCall did not return a successful trace")
        traced_gas = hex_int(trace.get("gas"), "debug_traceCall.gas")
        if traced_gas <= 0 or traced_gas > gas_estimate:
            raise RuntimeError(
                f"trace/estimate gas invariant failed: trace={traced_gas} estimate={gas_estimate}"
            )
        code_hash = command([cast, "keccak", runtime])

        return {
            "schema": SCHEMA,
            "provider_id": provider_id,
            "candidate_id": route["candidate_id"],
            "route_id": route["route_id"],
            "status": "PASS",
            "anchor": observed_anchor,
            "executor": executor,
            "executor_runtime_sha256": hashlib.sha256(
                bytes.fromhex(runtime[2:])
            ).hexdigest(),
            "executor_runtime_keccak256": code_hash.lower(),
            "calldata_sha256": hashlib.sha256(
                bytes.fromhex(calldata[2:])
            ).hexdigest(),
            "realized_profit_debt_units_before_gas": str(realized_profit),
            "simulated_gas_used": traced_gas,
            "simulated_gas_used_basis": "DEBUG_TRACECALL_EXACT_ANVIL_FORK_ANCHOR",
            "gas_requirement_units": gas_estimate,
            "gas_requirement_basis": "ETH_ESTIMATE_GAS_EXACT_ANVIL_FORK_ANCHOR",
            "fork_local_executor_code_injected": True,
            "fork_local_operator_balance_overridden": True,
            "operator_balance_override_is_capital_evidence": False,
            "live_transaction_sent": False,
            "own_capital_used": False,
        }
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        log_handle.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--route", type=Path, required=True)
    parser.add_argument("--rpc-url", required=True)
    parser.add_argument("--provider-id", required=True)
    parser.add_argument("--creation-bytecode", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--anvil", default="anvil")
    parser.add_argument("--cast", default="cast")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--anvil-log", type=Path, required=True)
    args = parser.parse_args()

    route = json.loads(args.route.read_text(encoding="utf-8"))
    if not isinstance(route, dict):
        raise ValueError("route file is not one JSON object")
    creation_bytecode = args.creation_bytecode.read_text(encoding="utf-8").strip()
    evidence = simulate(
        route,
        args.rpc_url,
        args.provider_id,
        args.anvil,
        args.cast,
        creation_bytecode,
        args.port,
        args.anvil_log,
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(canonical(evidence))
    print(
        "RMC013_ANVIL_CANDIDATE",
        f"provider={args.provider_id}",
        f"candidate={route.get('candidate_id')}",
        f"route={route.get('route_id')}",
        f"status={evidence['status']}",
    )


if __name__ == "__main__":
    main()
