#!/usr/bin/env python3
"""Dual-provider reconciliation for RMC-011 Balancer V2 flash-capital acquisition."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path

VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8"
ADDRESS_RE = re.compile(r"^0x[0-9a-f]{40}$")
HASH_RE = re.compile(r"^(?:0x)?[0-9a-f]{64}$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class CaptureError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CaptureError(message)


def decimal(value: object, label: str) -> int:
    require(isinstance(value, str) and value.isdigit(), f"{label} must be decimal text")
    return int(value, 10)


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def validate_anchor(anchor: object) -> None:
    require(isinstance(anchor, dict), "anchor must be an object")
    require(anchor.get("chain_id") == 1, "Balancer acquisition must be Ethereum mainnet")
    for key in ("genesis_hash", "fork_lineage", "block_hash", "parent_hash", "state_root"):
        value = anchor.get(key)
        require(isinstance(value, str) and HASH_RE.fullmatch(value) is not None, f"anchor {key} invalid")
    for key in ("block_number", "timestamp"):
        value = anchor.get(key)
        require(isinstance(value, int) and value >= 0, f"anchor {key} invalid")


def validate_capture(doc: dict) -> dict:
    require(doc.get("schema_version") == 1, "capture schema_version must equal 1")
    require(doc.get("stage") == "RMC-011", "capture stage must equal RMC-011")
    require(doc.get("family") == "BALANCER_V2_FLASH_LOAN", "unexpected capture family")
    provider_id = doc.get("provider_id")
    require(isinstance(provider_id, str) and provider_id, "provider_id required")
    provider_operator = doc.get("provider_operator")
    require(
        isinstance(provider_operator, str) and provider_operator,
        "provider_operator required",
    )
    endpoint_hash = doc.get("rpc_endpoint_hash")
    require(isinstance(endpoint_hash, str) and SHA_RE.fullmatch(endpoint_hash) is not None, "rpc endpoint hash invalid")
    for key in ("provider_manifest", "bootstrap_manifest", "anchor_manifest"):
        value = doc.get(key)
        require(
            isinstance(value, str) and HASH_RE.fullmatch(value) is not None,
            f"{key} invalid",
        )

    validate_anchor(doc.get("anchor"))
    for key in (
        "authority_lock_sha256",
        "d08_market_state_sha256",
        "d08_token_admission_sha256",
        "d08_evidence_manifest_sha256",
        "asset_universe_sha256",
    ):
        value = doc.get(key)
        require(isinstance(value, str) and SHA_RE.fullmatch(value) is not None, f"{key} invalid")

    vault = doc.get("vault")
    require(isinstance(vault, dict), "vault must be an object")
    require(vault.get("address") == VAULT, "unexpected Balancer V2 Vault")
    for key in ("code_sha256", "fee_collector_code_sha256"):
        value = vault.get(key)
        require(isinstance(value, str) and SHA_RE.fullmatch(value) is not None, f"vault {key} invalid")
    fee_collector = vault.get("fee_collector")
    require(isinstance(fee_collector, str) and ADDRESS_RE.fullmatch(fee_collector) is not None, "fee collector invalid")
    require(isinstance(vault.get("paused"), bool), "vault paused must be boolean")
    decimal(vault.get("pause_window_end_time"), "pause_window_end_time")
    decimal(vault.get("buffer_period_end_time"), "buffer_period_end_time")
    fee = decimal(vault.get("flash_loan_fee_percentage_1e18"), "flash_loan_fee_percentage_1e18")
    require(fee <= 1_000_000_000_000_000_000, "Balancer flash fee exceeds 1e18")

    assets = doc.get("assets")
    require(isinstance(assets, list) and assets, "assets must be a non-empty array")
    observed: list[str] = []
    for row in assets:
        require(isinstance(row, dict), "asset row must be an object")
        asset = row.get("asset")
        require(isinstance(asset, str) and ADDRESS_RE.fullmatch(asset) is not None, "asset address invalid")
        require(asset != "0x" + "0" * 40, "zero asset forbidden")
        decimal(row.get("vault_balance"), f"{asset} vault_balance")
        code_sha = row.get("code_sha256")
        require(isinstance(code_sha, str) and SHA_RE.fullmatch(code_sha) is not None, f"{asset} code_sha256 invalid")
        observed.append(asset)
    require(observed == sorted(observed), "assets must be sorted")
    require(len(observed) == len(set(observed)), "assets must be unique")

    semantic = dict(doc)
    for key in (
        "provider_id",
        "provider_operator",
        "rpc_endpoint_hash",
        "provider_manifest",
        "bootstrap_manifest",
        "anchor_manifest",
    ):
        semantic.pop(key, None)
    return semantic


def reconcile(a: dict, b: dict) -> dict:
    semantic_a = validate_capture(a)
    semantic_b = validate_capture(b)
    require(a["provider_id"] != b["provider_id"], "providers must be distinct")
    require(
        a["provider_operator"].casefold() != b["provider_operator"].casefold(),
        "provider operators must be distinct",
    )
    require(a["rpc_endpoint_hash"] != b["rpc_endpoint_hash"], "RPC endpoints must be distinct")
    require(a["provider_manifest"] != b["provider_manifest"], "provider manifests must be distinct")
    require(semantic_a == semantic_b, "dual-provider Balancer captures disagree")

    capture_a_sha = hashlib.sha256(canonical_bytes(a)).hexdigest()
    capture_b_sha = hashlib.sha256(canonical_bytes(b)).hexdigest()
    semantic_sha = hashlib.sha256(canonical_bytes(semantic_a)).hexdigest()

    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "family": "BALANCER_V2_FLASH_LOAN",
        "status": "RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED",
        "provider_count": 2,
        "provider_ids": sorted([a["provider_id"], b["provider_id"]]),
        "capture_sha256": sorted([capture_a_sha, capture_b_sha]),
        "semantic_sha256": semantic_sha,
        **semantic_a,
    }


def main(argv: list[str]) -> int:
    if len(argv) not in {3, 4}:
        print("usage: verify-rmc011-balancer-v2-capture.py PROVIDER_A PROVIDER_B [OUTPUT]", file=sys.stderr)
        return 2
    try:
        a = json.loads(Path(argv[1]).read_text(encoding="utf-8"))
        b = json.loads(Path(argv[2]).read_text(encoding="utf-8"))
        result = reconcile(a, b)
        payload = canonical_bytes(result)
        if len(argv) == 4:
            Path(argv[3]).write_bytes(payload)
    except (OSError, json.JSONDecodeError, CaptureError) as exc:
        print(f"RMC011_BALANCER_V2_CAPTURE_INVALID {exc}", file=sys.stderr)
        return 1
    print(
        "RMC011_BALANCER_V2_CAPTURE_PASS "
        f"providers={result['provider_count']} "
        f"assets={len(result['assets'])} "
        f"paused={str(result['vault']['paused']).lower()} "
        f"semantic_sha256={result['semantic_sha256']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
