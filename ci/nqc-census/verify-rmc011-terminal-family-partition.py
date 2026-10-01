#!/usr/bin/env python3
"""Prove the terminal RMC-011 family-resolution partition is exact and disjoint."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

ROOT = Path("ci/nqc-census")
EXPECTED = {
    "AAVE_V3_FLASH_LOAN",
    "UNISWAP_V2_FLASH_SWAP",
    "BALANCER_V2_FLASH_LOAN",
    "UNISWAP_V3_FLASH",
    "EXTERNAL_GAS_CREDIT",
    "EXTERNAL_GAS_SPONSOR",
    "TRANSIENT_EXTERNAL_CREDIT",
    "COLLATERALIZED_BORROWING",
    "PERSISTENT_DEBT",
    "INVENTORY_REQUIREMENT",
    "BOND_OR_STAKE",
    "SOLVER_OR_BUILDER_DEPOSIT",
    "INTRA_BLOCK_TEMPORARY_LOCK",
}


class PartitionError(ValueError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise PartitionError(message)


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    require(spec is not None and spec.loader is not None, f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate_partition(
    bounded: set[str],
    debt: set[str],
    protocol: set[str],
) -> dict:
    groups = {
        "bounded": set(bounded),
        "debt": set(debt),
        "protocol": set(protocol),
    }
    for name, group in groups.items():
        require(group, f"{name} family partition is empty")
        require(group <= EXPECTED, f"{name} contains unknown family")

    require(not (groups["bounded"] & groups["debt"]), "bounded/debt partitions overlap")
    require(not (groups["bounded"] & groups["protocol"]), "bounded/protocol partitions overlap")
    require(not (groups["debt"] & groups["protocol"]), "debt/protocol partitions overlap")

    union = groups["bounded"] | groups["debt"] | groups["protocol"]
    require(union == EXPECTED, "terminal family partition does not cover exact 13-family universe")
    require(len(groups["bounded"]) == 7, "bounded partition must contain 7 families")
    require(len(groups["debt"]) == 2, "debt partition must contain 2 families")
    require(len(groups["protocol"]) == 4, "protocol partition must contain 4 families")

    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "status": "RMC011_TERMINAL_FAMILY_PARTITION_PASS",
        "family_count": len(union),
        "bounded_count": len(groups["bounded"]),
        "debt_count": len(groups["debt"]),
        "protocol_count": len(groups["protocol"]),
        "families": sorted(union),
        "d11_terminal_closed": False,
    }


def current_partition() -> dict:
    bounded_mod = load(
        ROOT / "verify-rmc011-bounded-family-promotion.py",
        "rmc011_bounded_promotion",
    )
    debt_mod = load(
        ROOT / "verify-rmc011-debt-family-promotion.py",
        "rmc011_debt_promotion",
    )
    protocol_mod = load(
        ROOT / "verify-rmc011-protocol-family-promotion.py",
        "rmc011_protocol_promotion",
    )
    return validate_partition(
        set(bounded_mod.BOUNDED_FAMILIES),
        set(debt_mod.DEBT_FAMILIES),
        set(protocol_mod.FAMILIES),
    )


def main() -> int:
    try:
        result = current_partition()
    except (OSError, PartitionError, ValueError) as exc:
        print(f"RMC011_TERMINAL_FAMILY_PARTITION_INVALID {exc}", file=sys.stderr)
        return 1
    print(
        "RMC011_TERMINAL_FAMILY_PARTITION_PASS "
        f"families={result['family_count']} "
        f"bounded={result['bounded_count']} "
        f"debt={result['debt_count']} "
        f"protocol={result['protocol_count']}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
