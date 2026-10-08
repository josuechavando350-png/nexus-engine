#!/usr/bin/env python3
"""Bind immutable historical nine-family proofs to unchanged current family rows.

This is a compatibility gate, not a new source producer or global closure
certificate. The original independent auditors still authenticate the exact
historical blob, original ZIPs and source provenance in a separate replay root.
Current whole-universe validation remains a separate workflow step.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

HISTORICAL_SOURCE_BLOB = "c1b9f136a13f220af9dceaae50e5caa3105121eb"
HISTORICAL_FIXTURE = Path(__file__).parent / "fixtures/rmc011-source-universe-nine-original-pins.json"
BOUNDED = {
    "EXTERNAL_GAS_CREDIT", "EXTERNAL_GAS_SPONSOR", "TRANSIENT_EXTERNAL_CREDIT",
    "INVENTORY_REQUIREMENT", "BOND_OR_STAKE", "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}
DEBT = {"COLLATERALIZED_BORROWING", "PERSISTENT_DEBT"}
NATIVE = {
    "AAVE_V3_FLASH_LOAN", "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN", "UNISWAP_V3_FLASH",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(doc):
    return (json.dumps(doc, sort_keys=True, separators=(",", ":"),
                       ensure_ascii=True, allow_nan=False) + "\n").encode()


def gitblob(raw):
    return hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest()


def decode(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "duplicate JSON field forbidden")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError("non-finite JSON value forbidden: " + value)

    result = json.loads(raw, object_pairs_hook=unique, parse_constant=reject_constant)
    require(type(result) is dict, "source universe must be an object")
    return result


def family_rows(doc):
    require(type(doc.get("schema_version")) is int and doc["schema_version"] == 2
            and doc.get("stage") == "RMC-011"
            and doc.get("contract") == "NQC_RMC011_CAPITAL_SOURCE_UNIVERSE_V1",
            "source universe schema, stage or contract differs")
    rows = doc.get("families")
    require(type(rows) is list and len(rows) == 13
            and all(type(row) is dict and type(row.get("id")) is str for row in rows),
            "source universe requires thirteen named family rows")
    by_id = {row["id"]: row for row in rows}
    require(len(by_id) == 13 and set(by_id) == BOUNDED | DEBT | NATIVE,
            "source universe has missing, duplicate or unexpected family identities")
    return by_id


def audit(historical_raw, current_raw):
    require(gitblob(historical_raw) == HISTORICAL_SOURCE_BLOB,
            "historical nine-family source Git blob drift")
    historical = decode(historical_raw)
    current = decode(current_raw)
    old_rows = family_rows(historical)
    current_rows = family_rows(current)
    require(type(current.get("family_universe_discovery")) is dict,
            "current discovery declaration must be an object")
    for family in sorted(BOUNDED | DEBT):
        # Canonical bytes preserve JSON types: True must never equal numeric 1.
        require(canonical(old_rows[family]) == canonical(current_rows[family]),
                family + ": current historical family binding changed")

    report = {
        "schema_version": 1,
        "status": "RMC011_HISTORICAL_NINE_FAMILY_BINDINGS_UNCHANGED",
        "claim_scope": "HISTORICAL_SOURCE_REPLAY_AND_CURRENT_NINE_FAMILY_COMPATIBILITY_ONLY",
        "historical_source_universe_git_blob": HISTORICAL_SOURCE_BLOB,
        "current_source_universe_git_blob": gitblob(current_raw),
        "historical_family_rows_verified_unchanged": sorted(BOUNDED | DEBT),
        "historical_replay": {
            "resolved_family_count": 9,
            "unresolved_family_count": 4,
            "family_universe_discovery_status": "NOT_CERTIFIED",
            "terminal_claim_allowed": False,
            "d11_terminal_closed": False,
        },
        "current_registry_observation_only": {
            "resolved_family_count": sum(row.get("terminally_resolved") is True
                                         for row in current_rows.values()),
            "status": current.get("status"),
            "family_universe_discovery_status": current.get("family_universe_discovery", {}).get("status"),
        },
        "current_global_discovery_authenticated_by_this_audit": False,
        "d11_terminal_closed_by_this_audit": False,
        "real_market_census_closed_by_this_audit": False,
    }
    report["report_sha256"] = hashlib.sha256(canonical(report)).hexdigest()
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--historical-source-universe", type=Path, default=HISTORICAL_FIXTURE)
    parser.add_argument("--current-source-universe", type=Path,
                        default=Path("ci/nqc-census/rmc011-capital-source-universe.json"))
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = audit(args.historical_source_universe.read_bytes(),
                   args.current_source_universe.read_bytes())
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("xb") as output:
        output.write(canonical(report))
    print(report["status"], "HISTORICAL_REPLAY_ONLY CURRENT_BINDINGS=9")


if __name__ == "__main__":
    main()
