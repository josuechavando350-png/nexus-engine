#!/usr/bin/env python3
"""RMC-015 auxiliary: immutable D08/D09 Aave V3 material-risk frontier.

This is an *opportunity-discovery index*, not an execution, temporal episode,
profit, or Census-closeout authority. It never promotes a healthy account to
liquidatable; all quantities are exact integers in the oracle base unit.
"""

from __future__ import annotations

import argparse
from collections import Counter
from hashlib import sha256
import json
from pathlib import Path
import re
from typing import BinaryIO
from zipfile import ZipFile

WAD = 10**18
UINT256_MAX = 2**256 - 1
HASH64 = re.compile(r"[0-9a-f]{64}\Z")
ADDRESS = re.compile(r"0x[0-9a-f]{40}\Z")
GIT40 = re.compile(r"[0-9a-f]{40}\Z")
CLASSIFICATIONS = {"POSITION_HOLDER", "NO_POSITION_AT_ANCHOR", "CONFIGURATION_WITHOUT_POSITION"}
BOUNDARIES = (
    ("UNDER_1", 0, WAD),
    ("FROM_1_TO_1_01", WAD, 101 * WAD // 100),
    ("FROM_1_01_TO_1_05", 101 * WAD // 100, 105 * WAD // 100),
    ("FROM_1_05_TO_1_10", 105 * WAD // 100, 110 * WAD // 100),
    ("FROM_1_10_TO_1_20", 110 * WAD // 100, 120 * WAD // 100),
    ("FROM_1_20_TO_1_50", 120 * WAD // 100, 150 * WAD // 100),
    ("FROM_1_50_TO_2", 150 * WAD // 100, 2 * WAD),
    ("FROM_2_AND_ABOVE", 2 * WAD, UINT256_MAX + 1),
)
DEBT_FLOORS_IN_BASE_CURRENCY = (100, 1_000, 10_000, 100_000, 1_000_000)
FRONTIER_HF_MAX = 120 * WAD // 100
FRONTIER_DEBT_FLOOR_BASE = 10_000


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def canonical_bytes(obj: object) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")


def exact_uint(value: object, description: str) -> int:
    require(isinstance(value, str) and re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is not None,
            f"{description}: noncanonical unsigned decimal")
    n = int(value)
    require(0 <= n <= UINT256_MAX, f"{description}: out of uint256 range")
    return n


def sha_stream(stream: BinaryIO) -> str:
    h = sha256()
    for block in iter(lambda: stream.read(2**20), b""):
        h.update(block)
    return h.hexdigest()


def sha_path(path: Path) -> str:
    with path.open("rb") as handle:
        return sha_stream(handle)


def canonical_digest(value: object, name: str) -> str:
    require(isinstance(value, str), f"{name}: string required")
    cleaned = value.removeprefix("sha256:")
    require(HASH64.fullmatch(cleaned) is not None and cleaned != "0" * 64,
            f"{name}: noncanonical sha256")
    return cleaned


def verify_member(z: ZipFile, member: str, manifest: dict) -> None:
    expected = manifest.get(member)
    require(expected is not None, f"manifest missing {member}")
    info = z.getinfo(member)
    require(info.file_size == expected["bytes"], f"size mismatch: {member}")
    with z.open(member) as f:
        observed = sha_stream(f)
    require(observed == expected["sha256"], f"content hash mismatch: {member}")


def verified_file(z: ZipFile, member: str, manifest: dict) -> bytes:
    verify_member(z, member, manifest)
    require(z.getinfo(member).file_size <= 8 * 1024 * 1024,
            f"JSON member is too large to read into memory: {member}")
    return z.read(member)


def load_manifest(z: ZipFile, root: str = "closeout/") -> tuple[dict, dict]:
    names = z.namelist()
    require(len(names) == len(set(names)), "duplicate archive member name")
    require(all(".." not in Path(x).parts and not x.startswith("/") for x in names),
            "unsafe archive member name")
    doc = json.loads(z.read(root + "evidence-manifest.json"))
    rows = doc.get("artifacts")
    require(isinstance(rows, list) and rows, "missing evidence ledger")
    seen = {}
    for row in rows:
        require(isinstance(row, dict), "invalid evidence ledger entry")
        path = row.get("path")
        require(isinstance(path, str) and path and "/" not in path and path not in seen,
                "invalid or duplicate evidence path")
        expected = canonical_digest(row.get("sha256"), path)
        size = row.get("bytes")
        require(type(size) is int and 0 <= size < 2**34, "invalid evidence size")
        require(root + path in names, f"missing immutable member {root + path}")
        seen[root + path] = {"bytes": size, "sha256": expected}
    return doc, seen


def verify_zip(path: Path, expected_sha: str) -> ZipFile:
    require(path.is_file(), f"artifact is absent: {path}")
    expected = canonical_digest(expected_sha, str(path))
    observed = sha_path(path)
    require(observed == expected, f"immutable artifact SHA-256 differs: {path}")
    return ZipFile(path, "r")


def parse_anchor(summary08: dict, summary09: dict) -> dict:
    a08 = summary08["observation_anchor"]
    a09 = summary09["anchor"]
    require(type(a08.get("chain_id")) is int and a08["chain_id"] == 1,
            "this selector covers only Ethereum mainnet")
    require(type(a08.get("block_number")) is int and type(a09.get("number")) is int,
            "invalid anchor block number")
    require(type(a08.get("timestamp")) is int and type(summary09.get("anchor_timestamp")) is int,
            "invalid anchor timestamp")
    require(a08["block_number"] == a09["number"] and a08["block_hash"] == a09["hash"],
            "D08/D09 anchor mismatch")
    require(a08["timestamp"] == summary09["anchor_timestamp"], "anchor timestamp mismatch")
    require(summary08.get("mismatches") == 0 and summary09.get("mismatches") == 0,
            "upstream mismatch is nonzero")
    require(summary08.get("unexplained_mismatches") == 0 and summary09.get("unexplained_mismatches") == 0,
            "upstream unexplained mismatch is nonzero")
    require(summary08.get("status") == "RMC_008_PASS_CANDIDATE" and
            summary09.get("status") == "RMC_009_PASS_CANDIDATE", "invalid upstream summary status")
    return {"chain_id": 1, "block_number": a08["block_number"],
            "block_hash": a08["block_hash"], "timestamp": a08["timestamp"]}


def debt_bucket(health_factor: int) -> str:
    for name, low, high in BOUNDARIES:
        if low <= health_factor < high:
            return name
    raise ValueError("health factor is out of uint256 range")


def analyze_records(records, *, base_unit: int, expected: dict, watchlist: bool = False) -> tuple[dict, list]:
    require(type(base_unit) is int and base_unit > 0, "invalid oracle base unit")
    seen = set()
    categories: Counter = Counter()
    counts: Counter = Counter()
    sums: Counter = Counter()
    material: Counter = Counter()
    legs = Counter()
    n_debt = 0
    n_underwater = 0
    watchers = []
    total = 0
    for row in records:
        require(isinstance(row, dict), "account row must be object")
        account = row.get("account")
        require(isinstance(account, str) and ADDRESS.fullmatch(account) is not None,
                "noncanonical account address")
        require(account not in seen, f"duplicate account: {account}")
        seen.add(account)
        classification = row.get("classification")
        require(classification in CLASSIFICATIONS, f"unknown classification {classification}")
        categories[classification] += 1
        data = row.get("account_data")
        if classification == "NO_POSITION_AT_ANCHOR":
            require(data is None and row.get("debt_positions") in (None, []),
                    "no-position record contradicts its classification")
            continue
        require(isinstance(data, list) and len(data) == 6, "account_data must carry exactly six fields")
        values = [exact_uint(v, f"account_data[{i}]") for i, v in enumerate(data)]
        debt = values[1]
        hf = values[5]
        debt_positions = row.get("debt_positions")
        supply_positions = row.get("supply_positions")
        require(isinstance(debt_positions, list) and isinstance(supply_positions, list),
                "position lists must exist")
        legs["debt"] += len(debt_positions)
        legs["supply"] += len(supply_positions)
        if debt > 0:
            require(hf != UINT256_MAX and len(debt_positions) > 0,
                    "debt-bearing account lacks a finite health factor / debt position")
            require(row.get("health_factor_below_one") is (hf < WAD),
                    "protocol health-factor classification differs")
            n_debt += 1
            name = debt_bucket(hf)
            counts[name] += 1
            sums[name] += debt
            total += debt
            if hf < WAD:
                n_underwater += 1
            else:
                for threshold in DEBT_FLOORS_IN_BASE_CURRENCY:
                    if debt >= threshold * base_unit:
                        material[str(threshold)] += 1
            if WAD <= hf < FRONTIER_HF_MAX and debt >= FRONTIER_DEBT_FLOOR_BASE * base_unit:
                watchers.append({"account": account, "health_factor_wad": str(hf),
                                 "debt_base_units": str(debt),
                                 "debt_position_count": len(debt_positions),
                                 "supply_position_count": len(supply_positions)})
        else:
            require(hf == UINT256_MAX and row.get("health_factor_below_one") is None,
                    "debt-free account has an inconsistent health factor")
            require(len(debt_positions) == 0, "debt-free account has debt positions")
    require(len(seen) == expected["state_verified_accounts"], "D09 state-verified account conservation failed")
    require(n_debt == expected["actionable_accounts"], "D09 debt-account conservation failed")
    require(n_underwater == expected["health_factor_below_one"], "D09 unhealthy-account conservation failed")
    require(categories["POSITION_HOLDER"] == expected["position_holders"],
            "D09 position-holder conservation failed")
    require(legs["debt"] == expected["debt_positions"] and legs["supply"] == expected["supply_positions"],
            "D09 supply/debt position conservation failed")
    require(sum(counts.values()) == n_debt, "health-factor partition does not conserve debtors")
    if watchlist:
        # Decisions are anchored; no time-series or liquidation claims are made.
        watchers.sort(key=lambda r: (int(r["health_factor_wad"]), -int(r["debt_base_units"]), r["account"]))
    return {
        "state_verified_accounts": len(seen),
        "debt_accounts": n_debt,
        "underwater_accounts": n_underwater,
        "total_debt_base_units": str(total),
        "underwater_debt_base_units": str(sums["UNDER_1"]),
        "health_factor_partition": [
            {"name": name, "min_wad": str(low), "max_wad_exclusive": str(high),
             "account_count": counts[name], "debt_base_units": str(sums[name])}
            for name, low, high in BOUNDARIES
        ],
        "healthy_debt_floor_counts": [{"debt_floor_base_currency_units": threshold,
                                       "account_count": material[str(threshold)]}
                                      for threshold in DEBT_FLOORS_IN_BASE_CURRENCY],
        "material_risk_frontier": {
            "min_health_factor_wad": str(WAD),
            "max_health_factor_wad_exclusive": str(FRONTIER_HF_MAX),
            "min_debt_base_units": str(FRONTIER_DEBT_FLOOR_BASE * base_unit),
            "account_count": len(watchers),
            "claim": "NON_LIQUIDATABLE_WATCHLIST_ONLY"
        },
    }, watchers


def audit(d08_path: Path, d09_path: Path, d08_sha: str, d09_sha: str,
          *, expected_d08_commit: str, expected_d09_commit: str,
          emit_watchlist: bool = False, evaluation_start_block: int | None = None) -> tuple[dict, list]:
    for sha, name in [(expected_d08_commit, "D08 commit"), (expected_d09_commit, "D09 commit")]:
        require(isinstance(sha, str) and GIT40.fullmatch(sha) is not None,
                f"{name}: noncanonical commit")
    with verify_zip(d08_path, d08_sha) as d08, verify_zip(d09_path, d09_sha) as d09:
        m08, files08 = load_manifest(d08)
        m09, files09 = load_manifest(d09)
        require(m08.get("code_commit") == expected_d08_commit, "D08 code commit differs")
        require(m09.get("code_commit") == expected_d09_commit, "D09 code commit differs")
        s08 = json.loads(verified_file(d08, "closeout/state-summary.json", files08))
        s09 = json.loads(verified_file(d09, "closeout/account-summary.json", files09))
        anchor = parse_anchor(s08, s09)
        # Never backtest an end-of-window watchlist as if selected earlier.
        # Such hindsight selection biases the apparent capture/opportunity rate.
        if evaluation_start_block is not None:
            require(type(evaluation_start_block) is int and
                    evaluation_start_block > anchor["block_number"],
                    "LOOKAHEAD: watchlist may only evaluate at blocks AFTER its anchor")
        # Exact oracle base unit is authenticated in D08; do not assume USD or scale by float.
        oracle = verified_file(d08, "closeout/oracle-manifest.jsonl", files08)
        units = set()
        oracle_rows = 0
        for raw in oracle.splitlines():
            doc = json.loads(raw)
            units.add(exact_uint(doc.get("base_currency_unit"), "oracle base currency unit"))
            oracle_rows += 1
        require(len(units) == 1 and 0 not in units, "D08 oracle base-unit disagreement")
        require(oracle_rows == s08["aave_oracle_rows"], "D08 oracle row count differs")
        base_unit = next(iter(units))
        # Verify the exact 114 MB account ledger first, then stream one row at a
        # time. Never allocate the full decompressed ledger or JSON AST.
        member = "closeout/account-manifest.jsonl"
        verify_member(d09, member, files09)
        with d09.open(member) as rows:
            def decode_rows():
                for line in rows:
                    require(line.endswith(b"\n"), "account JSONL lacks final newline")
                    require(line.strip() != b"", "blank account JSONL row")
                    yield json.loads(line)
            result, watchlist = analyze_records(decode_rows(), base_unit=base_unit,
                                                 expected=s09["metrics"], watchlist=True)
        result.update({
            "schema_version": 1,
            "status": "RMC015_AUXILIARY_RISK_FRONTIER_VERIFIED",
            "terminal_authority": False,
            "census_closed": False,
            "realized_profitability_proven": False,
            "execution_or_capital_feasibility_proven": False,
            "lookahead_used": False,
            "lookahead_basis": "CROSS_SECTIONAL_SNAPSHOT_CONSTRUCTION_ONLY",
            "retrospective_backtest_admitted": False,
            "earliest_ex_ante_evaluation_block": anchor["block_number"] + 1,
            "extrapolation_used": False,
            "anchor": anchor,
            "oracle_base_currency_unit": str(base_unit),
            "currency_interpretation": "D08 authenticated Aave Oracle base currency, not transferable profit",
            "source_artifacts": {
                "rmc008": {"artifact_sha256": canonical_digest(d08_sha, "D08"),
                           "code_commit": expected_d08_commit,
                           "state_summary_sha256": files08["closeout/state-summary.json"]["sha256"],
                           "oracle_manifest_sha256": files08["closeout/oracle-manifest.jsonl"]["sha256"]},
                "rmc009": {"artifact_sha256": canonical_digest(d09_sha, "D09"),
                           "code_commit": expected_d09_commit,
                           "account_summary_sha256": files09["closeout/account-summary.json"]["sha256"],
                           "account_manifest_sha256": files09["closeout/account-manifest.jsonl"]["sha256"]}
            },
            "limits": [
                "ONE_HISTORICAL_BLOCK_ONLY",
                "END_ANCHOR_SELECTION_CANNOT_BACKTEST_PRIOR_BLOCKS",
                "WATCHLIST_ACCOUNTS_ARE_NOT_YET_LIQUIDATABLE",
                "NO_FUTURE_PRICE_MOVEMENT_PREDICTED",
                "NO_CAPITAL_OR_GAS_FUNDING_VERIFIED",
                "NO_TEMPORAL_ARRIVAL_OR_CAPTURE_RATE",
                "NO_NET_PNL_OR_MONTHLY_CAPACITY_CLAIM",
            ],
        })
        result["watchlist_commitment_sha256"] = sha256(b"".join(canonical_bytes(v) for v in watchlist)).hexdigest()
        result["authority_commitment_sha256"] = sha256(canonical_bytes(result)).hexdigest()
        return result, watchlist if emit_watchlist else []


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--d08", type=Path, required=True)
    p.add_argument("--d09", type=Path, required=True)
    p.add_argument("--d08-sha256", required=True)
    p.add_argument("--d09-sha256", required=True)
    p.add_argument("--d08-commit", required=True)
    p.add_argument("--d09-commit", required=True)
    p.add_argument("--summary-out", type=Path, required=True)
    p.add_argument("--watchlist-out", type=Path)
    p.add_argument("--evaluation-start-block", type=int)
    args = p.parse_args()
    result, rows = audit(args.d08, args.d09, args.d08_sha256, args.d09_sha256,
                         expected_d08_commit=args.d08_commit,
                         expected_d09_commit=args.d09_commit,
                         emit_watchlist=args.watchlist_out is not None,
                         evaluation_start_block=args.evaluation_start_block)
    args.summary_out.write_bytes(canonical_bytes(result))
    if args.watchlist_out:
        args.watchlist_out.write_bytes(b"".join(canonical_bytes(v) for v in rows))
    print("RMC015_AUXILIARY_RISK_FRONTIER_VERIFIED")
    print("summary_sha256=" + sha_path(args.summary_out))
    print("watchlist_count=" + str(result["material_risk_frontier"]["account_count"]))


if __name__ == "__main__":
    main()
