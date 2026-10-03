#!/usr/bin/env python3
"""Validate RMC-007 workflow glue; never replace Rust replay or certify D07.

Current bootstrap anchors and historical creation headers have different roles.
The pair count is derived from the observed factory surface, not an A0 constant.
Only the standard library is used; this module performs no network requests.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

MAX_JSON_BYTES = 8 * 1024 * 1024
HEADER_KEYS = {"number", "hash", "parent_hash", "state_root", "timestamp"}
DOMAIN_KEYS = {"chain_id", "fork_lineage", "genesis_hash", "lineage_block", "lineage_hash"}
GENESIS = "0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3"


class SurfaceError(ValueError):
    """An incomplete, contradictory or malformed surface must fail closed."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SurfaceError(message)


def uint(value: object, label: str, *, positive: bool = False) -> int:
    require(type(value) is int and (0 < value if positive else 0 <= value),
            f"{label}: expected unsigned integer")
    # Keep the bound separate: booleans and floats must never compare as integers.
    require(value < 2**256, f"{label}: uint256 overflow")
    return value


def hash32(value: object, label: str, *, prefix: str = "0x") -> str:
    require(isinstance(value, str) and
            re.fullmatch(re.escape(prefix) + r"[0-9a-f]{64}", value) is not None,
            f"{label}: expected canonical 32-byte hash")
    require(value != prefix + "0" * 64, f"{label}: zero hash")
    return value


def object_at(value: object, *path: str) -> dict:
    for key in path:
        require(isinstance(value, dict) and key in value, f"missing object path: {'.'.join(path)}")
        value = value[key]
    require(isinstance(value, dict), f"expected object: {'.'.join(path)}")
    return value


def header(value: dict, label: str) -> dict:
    require(set(value) == HEADER_KEYS, f"{label}: header fields differ")
    uint(value["number"], f"{label}.number")
    uint(value["timestamp"], f"{label}.timestamp", positive=True)
    for field in ("hash", "parent_hash", "state_root"):
        hash32(value[field], f"{label}.{field}")
    return value


def _unique_object(pairs: list[tuple[str, object]]) -> dict:
    out = {}
    for key, value in pairs:
        require(key not in out, f"duplicate JSON key: {key}")
        out[key] = value
    return out


def load_json(path: Path) -> dict:
    with path.open("rb") as stream:
        raw = stream.read(MAX_JSON_BYTES + 1)
    require(len(raw) <= MAX_JSON_BYTES, "JSON size limit exceeded")
    def reject_constant(value: str) -> None:
        raise SurfaceError(f"non-finite JSON constant: {value}")
    return object_at(json.loads(raw, object_pairs_hook=_unique_object,
                                parse_constant=reject_constant))


def verify_surface(current: dict, boundary: dict, number: int, block_hash: str) -> int:
    uint(number, "expected number", positive=True)
    hash32(block_hash, "expected hash")
    reports = ((current, "nqc-rmc-007-v2-current-surface-v1", "CURRENT_SURFACE_PASS"),
               (boundary, "nqc-rmc-007-v2-factory-boundary-v1", "FACTORY_BOUNDARY_PASS"))
    anchors, domains = [], []
    for report, schema, status in reports:
        require(report.get("schema") == schema and report.get("status") == status,
                "surface schema/status mismatch")
        bootstrap = object_at(report, "bootstrap")
        require(bootstrap.get("schema") == "nqc-census-chain-bootstrap-report-v1",
                "bootstrap schema mismatch")
        anchor = header(object_at(bootstrap, "anchor", "anchor"), "observation")
        require((anchor["number"], anchor["hash"]) == (number, block_hash), "wrong observation anchor")
        domain = object_at(bootstrap, "chain_domain")
        require(set(domain) == DOMAIN_KEYS, "chain-domain fields differ")
        require(uint(domain["chain_id"], "chain_id", positive=True) == 1 and
                domain["genesis_hash"] == GENESIS, "wrong Ethereum domain")
        uint(domain["lineage_block"], "lineage_block")
        for key in ("fork_lineage", "genesis_hash", "lineage_hash"):
            hash32(domain[key], key)
        anchors.append(anchor)
        domains.append(domain)
    require(anchors[0] == anchors[1] and domains[0] == domains[1], "mixed bootstrap authority")

    facts, proof = object_at(current, "facts"), object_at(boundary, "proof")
    factory = facts.get("factory")
    require(isinstance(factory, str) and re.fullmatch(r"0x[0-9a-f]{40}", factory) is not None
            and factory != "0x" + "0" * 40, "invalid factory address")
    require(factory == boundary.get("factory") == proof.get("account"), "factory mismatch")
    count = uint(facts.get("pair_count"), "pair_count", positive=True)
    require(uint(facts.get("first_index"), "first_index") == 0, "first index mismatch")
    require(uint(facts.get("last_index"), "last_index") == count - 1, "last index mismatch")

    first = uint(boundary.get("first_code_block"), "first_code_block", positive=True)
    previous = uint(boundary.get("predecessor_block"), "predecessor_block")
    require(previous + 1 == first <= number, "invalid historical creation interval")
    require(uint(proof.get("first_code_block"), "proof.first_code_block", positive=True) == first,
            "creation block mismatch")
    interval = proof.get("search_interval")
    require(isinstance(interval, list) and len(interval) == 2, "invalid search interval")
    require([uint(v, "search interval") for v in interval] == [1, number], "search interval mismatch")
    creation, predecessor = object_at(proof, "boundary"), object_at(proof, "predecessor")
    for row, expected in ((creation, first), (predecessor, previous)):
        h = header(object_at(row, "anchor"), "historical")
        require(uint(row.get("block"), "historical block") == h["number"] == expected,
                "historical block mismatch")
        require(row.get("hash") == h["hash"] and row.get("parent_hash") == h["parent_hash"],
                "historical header mismatch")
    require(creation["parent_hash"] == predecessor["hash"], "historical parent discontinuity")
    require(predecessor["anchor"]["timestamp"] < creation["anchor"]["timestamp"] <= anchors[0]["timestamp"],
            "historical timestamp order mismatch")
    require(uint(creation.get("code_len"), "creation code length", positive=True) > 0,
            "creation has no code")
    require(uint(predecessor.get("code_len"), "predecessor code length") == 0,
            "predecessor already has code")
    runtime_hash = hash32(facts.get("factory_runtime_sha256"), "factory runtime", prefix="")
    require(creation.get("code_sha256") == runtime_hash, "factory runtime mismatch")
    require(predecessor.get("code_sha256") == hashlib.sha256(b"").hexdigest(), "empty code digest mismatch")
    return count


def verify_closeout(text: str, pair_count: int) -> None:
    uint(pair_count, "expected pair count", positive=True)
    lines = [line for line in text.splitlines() if "RMC007_CLOSEOUT_PASS" in line]
    expected = f"RMC007_CLOSEOUT_PASS pairs={pair_count} unexplained=0 mismatches=0 records=48 agreement="
    require(len(lines) == 1 and lines[0].startswith(expected),
            "closeout count/conservation marker mismatch or duplicate")
    # The existing Rust binary appends canonical agreement JSON on this line.
    # Preserve that grammar rather than rejecting a valid Rust closeout.
    try:
        agreement = json.loads(lines[0][len(expected):], object_pairs_hook=_unique_object)
    except ValueError as exc:
        raise SurfaceError("malformed closeout agreement") from exc
    require(isinstance(agreement, dict), "closeout agreement must be an object")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--current", required=True, type=Path)
    parser.add_argument("--boundary", required=True, type=Path)
    parser.add_argument("--number", required=True, type=int)
    parser.add_argument("--hash", required=True)
    parser.add_argument("--closeout-log", type=Path)
    args = parser.parse_args()
    try:
        count = verify_surface(load_json(args.current), load_json(args.boundary), args.number, args.hash)
        if args.closeout_log is not None:
            verify_closeout(args.closeout_log.read_text(encoding="utf-8"), count)
    except (OSError, ValueError, TypeError, KeyError, RecursionError) as exc:
        print(f"RMC007_RECOVERY_SURFACE_CONTRACT_FAIL {exc}", file=sys.stderr)
        return 1
    print(f"RMC007_RECOVERY_SURFACE_CONTRACT_PASS pairs={count} d07_terminal_closed=false")
    return 0


if __name__ == "__main__":
    sys.exit(main())
