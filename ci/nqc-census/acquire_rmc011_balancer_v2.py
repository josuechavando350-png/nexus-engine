#!/usr/bin/env python3
"""RMC-011 Balancer V2 dual-provider acquisition.

Consumes an authenticated D08 authority file plus its token-admission manifest,
pins all reads to that exact anchor, reconciles two independent RPC views, and
emits content-addressed Balancer V2 flash-liquidity observations.

This script does not itself grant terminal D11 authority.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
VAULT_CANONICAL = "0xba12222222228d8ba445958a75a0704d566bf2c8"


class AcquisitionError(RuntimeError):
    pass


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AcquisitionError(message)


def rpc(url: str, method: str, params: list[Any]) -> Any:
    payload = json.dumps(
        {"jsonrpc": "2.0", "id": 11, "method": method, "params": params},
        separators=(",", ":"),
    ).encode()
    last: Exception | None = None
    for attempt in range(6):
        try:
            request = urllib.request.Request(
                url,
                data=payload,
                headers={
                    "content-type": "application/json",
                    "user-agent": "NQC-RMC011-Balancer-acquisition",
                },
            )
            with urllib.request.urlopen(request, timeout=40) as response:
                body = json.loads(response.read().decode())
            if body.get("error") is not None:
                raise AcquisitionError(f"{method}: {body['error']}")
            return body["result"]
        except Exception as exc:  # network retries are evidence acquisition only
            last = exc
            if attempt == 5:
                break
            time.sleep(min(8, 2**attempt))
    raise AcquisitionError(f"{method} failed after retries: {last}")


def cast_calldata(cast: str, signature: str, *args: str) -> str:
    completed = subprocess.run(
        [cast, "calldata", signature, *args],
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    value = completed.stdout.strip().lower()
    require(value.startswith("0x") and len(value) >= 10, f"invalid cast calldata for {signature}")
    return value


def eth_call(url: str, to: str, data: str, block_tag: str) -> bytes:
    raw = rpc(url, "eth_call", [{"to": to, "data": data}, block_tag])
    require(isinstance(raw, str) and raw.startswith("0x"), "eth_call result is not hex")
    try:
        return bytes.fromhex(raw[2:])
    except ValueError as exc:
        raise AcquisitionError("eth_call result is invalid hex") from exc


def words(data: bytes, count: int, label: str) -> list[int]:
    require(len(data) == count * 32, f"{label}: expected {count} ABI words, got {len(data)} bytes")
    return [int.from_bytes(data[index * 32 : (index + 1) * 32], "big") for index in range(count)]


def parse_address_word(data: bytes, label: str) -> str:
    values = words(data, 1, label)
    require(values[0] >> 160 == 0, f"{label}: non-canonical address word")
    return "0x" + values[0].to_bytes(32, "big")[-20:].hex()


def parse_uint_word(data: bytes, label: str) -> int:
    return words(data, 1, label)[0]


def load_anchor(path: Path) -> dict[str, Any]:
    authority = json.loads(path.read_text(encoding="utf-8"))
    anchor = authority.get("observation_anchor")
    require(isinstance(anchor, dict), "D08 authority has no observation_anchor")
    required = {
        "chain_id",
        "genesis_hash",
        "fork_lineage",
        "block_number",
        "block_hash",
        "parent_hash",
        "timestamp",
        "state_root",
    }
    require(required <= set(anchor), "D08 observation_anchor is incomplete")
    require(anchor["chain_id"] == 1, "Balancer V2 acquisition currently requires Ethereum mainnet")
    return {key: anchor[key] for key in sorted(required)}


def load_tokens(path: Path) -> list[dict[str, Any]]:
    by_token: dict[str, dict[str, Any]] = {}
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line:
            continue
        row = json.loads(line)
        token = row.get("token")
        require(
            isinstance(token, str) and token.startswith("0x") and len(token) == 42,
            f"token-admission line {number}: invalid token",
        )
        token = token.lower()
        execution = row.get("execution_compatibility")
        state = row.get("state_admission")
        require(isinstance(execution, dict), f"{token}: missing execution_compatibility")
        require(isinstance(state, dict), f"{token}: missing state_admission")
        blockers = execution.get("blockers")
        require(isinstance(blockers, list) and all(isinstance(x, str) for x in blockers), f"{token}: invalid blockers")
        normalized = {
            "token": token,
            "state_admission": state,
            "execution_compatibility": {
                "status": execution.get("status"),
                "blockers": sorted(blockers),
            },
        }
        previous = by_token.get(token)
        if previous is not None:
            require(previous == normalized, f"{token}: duplicate token rows disagree")
        by_token[token] = normalized
    require(bool(by_token), "token-admission manifest is empty")
    return [by_token[token] for token in sorted(by_token)]


def acquire_provider(
    *,
    label: str,
    url: str,
    anchor: dict[str, Any],
    tokens: list[dict[str, Any]],
    vault: str,
    cast: str,
) -> dict[str, Any]:
    block_number = int(anchor["block_number"])
    block_tag = hex(block_number)

    chain_id = int(rpc(url, "eth_chainId", []), 16)
    require(chain_id == int(anchor["chain_id"]), f"{label}: chain_id mismatch")

    block = rpc(url, "eth_getBlockByNumber", [block_tag, False])
    require(isinstance(block, dict), f"{label}: anchor block unavailable")
    checks = {
        "number": block_number,
        "hash": str(anchor["block_hash"]).lower(),
        "parentHash": str(anchor["parent_hash"]).lower(),
        "stateRoot": str(anchor["state_root"]).lower(),
        "timestamp": int(anchor["timestamp"]),
    }
    require(int(block["number"], 16) == checks["number"], f"{label}: block number mismatch")
    require(block["hash"].lower() == checks["hash"], f"{label}: block hash mismatch")
    require(block["parentHash"].lower() == checks["parentHash"], f"{label}: parent hash mismatch")
    require(block["stateRoot"].lower() == checks["stateRoot"], f"{label}: state root mismatch")
    require(int(block["timestamp"], 16) == checks["timestamp"], f"{label}: timestamp mismatch")

    vault_code_hex = rpc(url, "eth_getCode", [vault, block_tag])
    require(isinstance(vault_code_hex, str) and vault_code_hex.startswith("0x") and len(vault_code_hex) > 4, f"{label}: Balancer Vault code absent")
    vault_code = bytes.fromhex(vault_code_hex[2:])

    collector_data = cast_calldata(cast, "getProtocolFeesCollector()")
    collector = parse_address_word(
        eth_call(url, vault, collector_data, block_tag),
        f"{label}: getProtocolFeesCollector",
    )
    collector_code_hex = rpc(url, "eth_getCode", [collector, block_tag])
    require(isinstance(collector_code_hex, str) and collector_code_hex.startswith("0x") and len(collector_code_hex) > 4, f"{label}: protocol fees collector code absent")
    collector_code = bytes.fromhex(collector_code_hex[2:])

    paused_data = cast_calldata(cast, "getPausedState()")
    paused_words = words(
        eth_call(url, vault, paused_data, block_tag),
        3,
        f"{label}: getPausedState",
    )
    require(paused_words[0] in (0, 1), f"{label}: paused flag non-canonical")

    fee_data = cast_calldata(cast, "getFlashLoanFeePercentage()")
    flash_fee = parse_uint_word(
        eth_call(url, collector, fee_data, block_tag),
        f"{label}: getFlashLoanFeePercentage",
    )
    require(flash_fee <= 10**18, f"{label}: flash fee exceeds 1e18")

    balances: list[dict[str, Any]] = []
    for token_row in tokens:
        token = token_row["token"]
        token_code_hex = rpc(url, "eth_getCode", [token, block_tag])
        token_code_sha256 = None
        token_code_bytes = 0
        if isinstance(token_code_hex, str) and token_code_hex.startswith("0x") and len(token_code_hex) > 2:
            token_code = bytes.fromhex(token_code_hex[2:])
            token_code_sha256 = sha256_hex(token_code)
            token_code_bytes = len(token_code)
        balance_data = cast_calldata(cast, "balanceOf(address)", vault)
        balance = parse_uint_word(
            eth_call(url, token, balance_data, block_tag),
            f"{label}: {token} balanceOf(vault)",
        )
        balances.append(
            {
                "token": token,
                "vault_balance": str(balance),
                "token_code_sha256": token_code_sha256,
                "token_code_bytes": token_code_bytes,
                "state_admission": token_row["state_admission"],
                "execution_compatibility": token_row["execution_compatibility"],
            }
        )

    return {
        "schema_version": SCHEMA_VERSION,
        "provider_label": label,
        "anchor": anchor,
        "vault": vault,
        "vault_code_sha256": sha256_hex(vault_code),
        "vault_code_bytes": len(vault_code),
        "protocol_fees_collector": collector,
        "protocol_fees_collector_code_sha256": sha256_hex(collector_code),
        "protocol_fees_collector_code_bytes": len(collector_code),
        "paused": bool(paused_words[0]),
        "pause_window_end_time": paused_words[1],
        "buffer_period_end_time": paused_words[2],
        "flash_loan_fee_percentage_1e18": flash_fee,
        "assets": balances,
    }


def comparable_provider_view(document: dict[str, Any]) -> dict[str, Any]:
    out = dict(document)
    out.pop("provider_label", None)
    return out


def reconcile(
    provider_a: dict[str, Any],
    provider_b: dict[str, Any],
) -> dict[str, Any]:
    require(
        comparable_provider_view(provider_a) == comparable_provider_view(provider_b),
        "Balancer V2 dual-provider observations disagree",
    )
    bytes_a = canonical_bytes(provider_a)
    bytes_b = canonical_bytes(provider_b)
    require(bytes_a != bytes_b, "provider transcripts must remain independently labeled")
    digest_a = sha256_hex(bytes_a)
    digest_b = sha256_hex(bytes_b)
    require(digest_a != digest_b, "provider transcript digests must be distinct")

    observations = []
    for asset in provider_a["assets"]:
        observations.append(
            {
                "schema_version": SCHEMA_VERSION,
                "family": "BALANCER_V2_FLASH_LOAN",
                "anchor": provider_a["anchor"],
                "vault": provider_a["vault"],
                "asset": asset["token"],
                "available_vault_balance": asset["vault_balance"],
                "fee_percentage_1e18": provider_a["flash_loan_fee_percentage_1e18"],
                "paused": provider_a["paused"],
                "state_admission": asset["state_admission"],
                "execution_compatibility": asset["execution_compatibility"],
                "provider_transcript_sha256": [digest_a, digest_b],
            }
        )

    return {
        "provider_a_bytes": bytes_a,
        "provider_b_bytes": bytes_b,
        "provider_a_sha256": digest_a,
        "provider_b_sha256": digest_b,
        "observations": observations,
    }


def write_outputs(out: Path, provider_a: dict[str, Any], provider_b: dict[str, Any]) -> None:
    out.mkdir(parents=True, exist_ok=False)
    result = reconcile(provider_a, provider_b)
    (out / "provider-a.json").write_bytes(result["provider_a_bytes"])
    (out / "provider-b.json").write_bytes(result["provider_b_bytes"])

    observations_bytes = b"".join(canonical_bytes(row) for row in result["observations"])
    (out / "balancer-v2-observations.jsonl").write_bytes(observations_bytes)

    summary = {
        "schema_version": SCHEMA_VERSION,
        "status": "RMC011_BALANCER_V2_DUAL_PROVIDER_ACQUISITION_PASS",
        "family": "BALANCER_V2_FLASH_LOAN",
        "anchor": provider_a["anchor"],
        "vault": provider_a["vault"],
        "asset_count": len(result["observations"]),
        "paused": provider_a["paused"],
        "flash_loan_fee_percentage_1e18": provider_a["flash_loan_fee_percentage_1e18"],
        "provider_transcript_sha256": [result["provider_a_sha256"], result["provider_b_sha256"]],
        "terminal_d11_claim": False,
    }
    summary_bytes = canonical_bytes(summary)
    (out / "summary.json").write_bytes(summary_bytes)

    files = {}
    for name in [
        "provider-a.json",
        "provider-b.json",
        "balancer-v2-observations.jsonl",
        "summary.json",
    ]:
        data = (out / name).read_bytes()
        files[name] = {"sha256": sha256_hex(data), "bytes": len(data)}
    manifest = {
        "schema_version": SCHEMA_VERSION,
        "family": "BALANCER_V2_FLASH_LOAN",
        "status": "AUTHENTICATED_DUAL_PROVIDER_ACQUISITION",
        "files": files,
        "terminal_d11_claim": False,
    }
    (out / "evidence-manifest.json").write_bytes(canonical_bytes(manifest))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rpc-a", required=True)
    parser.add_argument("--rpc-b", required=True)
    parser.add_argument("--d08-authority", required=True, type=Path)
    parser.add_argument("--token-admission", required=True, type=Path)
    parser.add_argument("--vault", default=VAULT_CANONICAL)
    parser.add_argument("--cast", default="cast")
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    vault = args.vault.lower()
    require(vault == VAULT_CANONICAL, "Balancer V2 Vault differs from repository-canonical identity")
    anchor = load_anchor(args.d08_authority)
    tokens = load_tokens(args.token_admission)
    provider_a = acquire_provider(
        label="A",
        url=args.rpc_a,
        anchor=anchor,
        tokens=tokens,
        vault=vault,
        cast=args.cast,
    )
    provider_b = acquire_provider(
        label="B",
        url=args.rpc_b,
        anchor=anchor,
        tokens=tokens,
        vault=vault,
        cast=args.cast,
    )
    write_outputs(args.out, provider_a, provider_b)
    print(
        "RMC011_BALANCER_V2_ACQUISITION_PASS "
        f"assets={len(provider_a['assets'])} "
        f"block={anchor['block_number']} "
        f"vault={vault}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
