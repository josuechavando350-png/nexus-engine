#!/usr/bin/env python3
"""Deterministic RMC-013 Uniswap V2 route planner.

Consumes exact RMC-008 V2 state plus exact RMC-012 actionability/capital
promotion artifacts. It evaluates every simple V2 route up to max_hops for each
capital-feasible liquidation, then retains the best routes without pretending
that route planning itself proves execution, gas, inclusion, or realized P&L.

All arithmetic is integer. No network, floating point, aggregator, or mutable
"latest" input is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

BPS = 10_000
USD_WAD = 10**18
SCHEMA = "nqc-rmc-013-v2-route-plan-v1"
ALGORITHM = "EXHAUSTIVE_SIMPLE_UNISWAP_V2_PATHS_MAX_HOPS_V1"


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
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"{path}:{number}: JSONL row is not an object")
            out.append(value)
    return out


def address(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError(f"address is not a string: {value!r}")
    lowered = value.lower()
    if len(lowered) != 42 or not lowered.startswith("0x"):
        raise ValueError(f"invalid address: {value!r}")
    int(lowered[2:], 16)
    return lowered


def nonnegative_decimal(value: object, field: str) -> int:
    if not isinstance(value, str) or not value.isdigit():
        raise ValueError(f"{field} must be an unsigned decimal string")
    return int(value)


def hex256(value: object, field: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field} must be a hex string")
    raw = value[2:] if value.startswith("0x") else value
    if len(raw) != 64:
        raise ValueError(f"{field} must contain exactly 32 bytes")
    int(raw, 16)
    return "0x" + raw.lower()


def usd_wad(units: int, price_wad: int, asset_unit: int) -> int:
    if units < 0 or price_wad < 0 or asset_unit <= 0:
        raise ValueError("invalid USD-WAD conversion input")
    return units * price_wad // asset_unit


@dataclass(frozen=True)
class Pair:
    address: str
    token0: str
    token1: str
    reserve0: int
    reserve1: int
    fee_bps: int
    market_id: str

    def directed(self, token_in: str, token_out: str) -> tuple[int, int]:
        if token_in == self.token0 and token_out == self.token1:
            return self.reserve0, self.reserve1
        if token_in == self.token1 and token_out == self.token0:
            return self.reserve1, self.reserve0
        raise ValueError("pair does not contain directed token edge")


@dataclass(frozen=True)
class Hop:
    pair: Pair
    token_in: str
    token_out: str

    def json(self) -> dict:
        rin, rout = self.pair.directed(self.token_in, self.token_out)
        return {
            "pair": self.pair.address,
            "market_id": self.pair.market_id,
            "token_in": self.token_in,
            "token_out": self.token_out,
            "reserve_in": str(rin),
            "reserve_out": str(rout),
            "swap_fee_bps": self.pair.fee_bps,
        }


def amount_out(amount_in: int, reserve_in: int, reserve_out: int, fee_bps: int) -> int:
    if amount_in <= 0 or reserve_in <= 0 or reserve_out <= 0:
        return 0
    if not 0 <= fee_bps < BPS:
        raise ValueError("fee_bps outside [0,10000)")
    with_fee = amount_in * (BPS - fee_bps)
    return with_fee * reserve_out // (reserve_in * BPS + with_fee)


def spot_out(amount_in: int, reserve_in: int, reserve_out: int) -> int:
    if amount_in <= 0 or reserve_in <= 0 or reserve_out <= 0:
        return 0
    return amount_in * reserve_out // reserve_in


def route_output(amount: int, route: tuple[Hop, ...], mode: str) -> int:
    current = amount
    for hop in route:
        rin, rout = hop.pair.directed(hop.token_in, hop.token_out)
        if mode == "actual":
            current = amount_out(current, rin, rout, hop.pair.fee_bps)
        elif mode == "zero_fee":
            current = amount_out(current, rin, rout, 0)
        elif mode == "spot":
            current = spot_out(current, rin, rout)
        else:
            raise ValueError(f"unknown route mode {mode}")
        if current == 0:
            break
    return current


class Graph:
    def __init__(self, pairs: Iterable[Pair]) -> None:
        self.adj: dict[str, list[tuple[str, Pair]]] = defaultdict(list)
        self.by_tokens: dict[tuple[str, str], Pair] = {}
        for pair in pairs:
            key = tuple(sorted((pair.token0, pair.token1)))
            if key in self.by_tokens:
                raise ValueError(f"duplicate V2 token pair {key}")
            self.by_tokens[key] = pair
            self.adj[pair.token0].append((pair.token1, pair))
            self.adj[pair.token1].append((pair.token0, pair))
        for token in self.adj:
            self.adj[token].sort(key=lambda item: (item[0], item[1].address))

    def pair(self, left: str, right: str) -> Pair | None:
        return self.by_tokens.get(tuple(sorted((left, right))))

    def routes(self, token_in: str, token_out: str, max_hops: int) -> list[tuple[Hop, ...]]:
        if token_in == token_out:
            return [tuple()]
        found: list[tuple[Hop, ...]] = []
        seen: set[tuple[str, ...]] = set()

        def add(tokens: list[str], pairs: list[Pair]) -> None:
            key = tuple(pair.address for pair in pairs)
            if key in seen:
                return
            seen.add(key)
            found.append(
                tuple(
                    Hop(pair=pair, token_in=tokens[i], token_out=tokens[i + 1])
                    for i, pair in enumerate(pairs)
                )
            )

        direct = self.pair(token_in, token_out)
        if direct is not None and max_hops >= 1:
            add([token_in, token_out], [direct])
        if max_hops >= 2:
            for mid, first in self.adj.get(token_in, []):
                if mid in {token_in, token_out}:
                    continue
                second = self.pair(mid, token_out)
                if second is not None and second.address != first.address:
                    add([token_in, mid, token_out], [first, second])
        if max_hops >= 3:
            left = [
                (mid, pair)
                for mid, pair in self.adj.get(token_in, [])
                if mid not in {token_in, token_out}
            ]
            right = [
                (mid, pair)
                for mid, pair in self.adj.get(token_out, [])
                if mid not in {token_in, token_out}
            ]
            for mid1, first in left:
                for mid2, last in right:
                    if mid1 == mid2 or mid2 == token_in or mid1 == token_out:
                        continue
                    bridge = self.pair(mid1, mid2)
                    if bridge is None:
                        continue
                    pair_ids = {first.address, bridge.address, last.address}
                    if len(pair_ids) != 3:
                        continue
                    add(
                        [token_in, mid1, mid2, token_out],
                        [first, bridge, last],
                    )
        found.sort(
            key=lambda route: (
                len(route),
                tuple(hop.token_out for hop in route),
                tuple(hop.pair.address for hop in route),
            )
        )
        return found


def load_pairs(path: Path) -> list[Pair]:
    pairs: list[Pair] = []
    for row in rows(path):
        if row.get("protocol") != "UNISWAP_V2":
            continue
        if row.get("stage_state_reconstructable") != "ADVANCE":
            continue
        if row.get("liquidity_state") != "LIQUID":
            continue
        if row.get("factory_membership") is not True:
            continue
        runtime = row.get("runtime")
        if not isinstance(runtime, dict) or runtime.get("derivation_matches") is not True:
            continue
        reserves = row.get("reserves")
        if not isinstance(reserves, list) or len(reserves) != 3:
            continue
        reserve0 = int(reserves[0])
        reserve1 = int(reserves[1])
        if reserve0 <= 0 or reserve1 <= 0:
            continue
        fee = row.get("fee_semantics")
        if not isinstance(fee, dict):
            raise ValueError("V2 row missing fee_semantics")
        fee_bps = fee.get("swap_fee_bps")
        if not isinstance(fee_bps, int):
            raise ValueError("V2 row swap_fee_bps is not integer")
        pairs.append(
            Pair(
                address=address(row["pair"]),
                token0=address(row["token0"]),
                token1=address(row["token1"]),
                reserve0=reserve0,
                reserve1=reserve1,
                fee_bps=fee_bps,
                market_id=hex256(row["market_id"], "market_id"),
            )
        )
    pairs.sort(key=lambda pair: pair.address)
    return pairs


def route_record(
    route: tuple[Hop, ...],
    action: dict,
    promotion: dict,
    route_rank: int,
    topology_count: int,
) -> dict:
    collateral = address(action["collateral_asset"])
    debt = address(action["debt_asset"])
    net_collateral = nonnegative_decimal(action["collateral_to_liquidator"], "collateral_to_liquidator")
    protocol_fee_collateral = nonnegative_decimal(
        action["liquidation_protocol_fee_collateral"],
        "liquidation_protocol_fee_collateral",
    )
    gross_collateral = net_collateral + protocol_fee_collateral
    principal = nonnegative_decimal(action["debt_to_liquidate"], "debt_to_liquidate")
    flash_premium = nonnegative_decimal(action["flash_loan_premium"], "flash_loan_premium")
    debt_price_wad = nonnegative_decimal(action["debt_price_base_wad"], "debt_price_base_wad")
    debt_unit = nonnegative_decimal(action["debt_asset_unit"], "debt_asset_unit")
    if debt_unit <= 0:
        raise ValueError("debt_asset_unit is zero")

    if not route:
        actual = zero_fee = spot_net = net_collateral
        spot_gross = gross_collateral
    else:
        actual = route_output(net_collateral, route, "actual")
        zero_fee = route_output(net_collateral, route, "zero_fee")
        spot_net = route_output(net_collateral, route, "spot")
        spot_gross = route_output(gross_collateral, route, "spot")

    if not (spot_gross >= spot_net >= zero_fee >= actual):
        raise ValueError("route decomposition is not monotonic")

    protocol_fee_units = spot_gross - spot_net
    swap_fee_units = zero_fee - actual
    price_impact_units = spot_net - zero_fee
    gross_surplus_units = max(spot_gross - principal, 0)
    gross_deficit_units = max(principal - spot_gross, 0)
    pre_gas_net_units = actual - principal - flash_premium

    def wad(value: int) -> str:
        return str(usd_wad(value, debt_price_wad, debt_unit))

    route_key = hashlib.sha256(
        b"NQC-RMC013-V2-ROUTE-V1\0"
        + bytes.fromhex(promotion["portfolio_candidate_id"][2:])
        + b"".join(bytes.fromhex(hop.pair.address[2:]) for hop in route)
    ).hexdigest()

    return {
        "schema": SCHEMA,
        "algorithm": ALGORITHM,
        "candidate_id": hex256(promotion["portfolio_candidate_id"], "portfolio_candidate_id"),
        "actionable_candidate_id": hex256(
            promotion["actionable_candidate_id"], "actionable_candidate_id"
        ),
        "route_id": "0x" + route_key,
        "route_rank": route_rank,
        "evaluated_topology_count": topology_count,
        "collateral_asset": collateral,
        "debt_asset": debt,
        "hops": [hop.json() for hop in route],
        "trade_size_collateral_units": str(net_collateral),
        "gross_collateral_before_protocol_fee_units": str(gross_collateral),
        "principal_debt_units": str(principal),
        "flash_premium_debt_units": str(flash_premium),
        "spot_gross_output_debt_units": str(spot_gross),
        "spot_net_output_debt_units": str(spot_net),
        "zero_fee_output_debt_units": str(zero_fee),
        "actual_output_debt_units": str(actual),
        "gross_surplus_debt_units": str(gross_surplus_units),
        "gross_deficit_debt_units": str(gross_deficit_units),
        "protocol_fee_cost_debt_units": str(protocol_fee_units),
        "swap_fee_cost_debt_units": str(swap_fee_units),
        "price_impact_cost_debt_units": str(price_impact_units),
        "pre_gas_success_net_debt_units": str(pre_gas_net_units),
        "valuation": {
            "unit": "USD_WAD",
            "debt_price_base_wad": str(debt_price_wad),
            "debt_asset_unit": str(debt_unit),
            "gross_value_usd_wad": wad(gross_surplus_units),
            "gross_deficit_usd_wad": wad(gross_deficit_units),
            "protocol_fee_cost_usd_wad": wad(protocol_fee_units),
            "capital_fee_cost_usd_wad": wad(flash_premium),
            "swap_fee_cost_usd_wad": wad(swap_fee_units),
            "price_impact_cost_usd_wad": wad(price_impact_units),
        },
    }


def plan(
    d08_state: Path,
    d12_actionability: Path,
    d12_promotions: Path,
    out_dir: Path,
    max_hops: int,
    keep_routes: int,
) -> dict:
    if max_hops not in {1, 2, 3}:
        raise ValueError("max_hops must be 1, 2, or 3")
    if keep_routes <= 0:
        raise ValueError("keep_routes must be positive")

    pair_rows = load_pairs(d08_state)
    graph = Graph(pair_rows)
    action_rows = rows(d12_actionability)
    actions = {
        hex256(row["candidate_id"], "candidate_id"): row
        for row in action_rows
        if row.get("status") == "ADMITTED"
    }
    promotions = [
        row for row in rows(d12_promotions) if row.get("capital_status") == "FEASIBLE"
    ]
    promotions.sort(key=lambda row: hex256(row["portfolio_candidate_id"], "portfolio_candidate_id"))

    output: list[dict] = []
    rejections: list[dict] = []
    topology_cache: dict[tuple[str, str], list[tuple[Hop, ...]]] = {}
    total_evaluated = 0

    for promotion in promotions:
        actionable_id = hex256(promotion["actionable_candidate_id"], "actionable_candidate_id")
        action = actions.get(actionable_id)
        if action is None:
            raise ValueError(f"feasible promotion has no admitted actionability row: {actionable_id}")
        collateral = address(action["collateral_asset"])
        debt = address(action["debt_asset"])
        cache_key = (collateral, debt)
        routes = topology_cache.get(cache_key)
        if routes is None:
            routes = graph.routes(collateral, debt, max_hops)
            topology_cache[cache_key] = routes
        total_evaluated += len(routes)
        if not routes:
            rejections.append(
                {
                    "schema": SCHEMA,
                    "candidate_id": hex256(
                        promotion["portfolio_candidate_id"], "portfolio_candidate_id"
                    ),
                    "actionable_candidate_id": actionable_id,
                    "reason": "ROUTE_UNAVAILABLE_V2_MAX_HOPS",
                    "max_hops": max_hops,
                }
            )
            continue

        evaluated = [
            route_record(route, action, promotion, 0, len(routes)) for route in routes
        ]
        evaluated.sort(
            key=lambda row: (
                -int(row["pre_gas_success_net_debt_units"]),
                len(row["hops"]),
                row["route_id"],
            )
        )
        for rank, row in enumerate(evaluated[:keep_routes], 1):
            row["route_rank"] = rank
            output.append(row)

    out_dir.mkdir(parents=True, exist_ok=True)
    plans_path = out_dir / "v2-route-plans.jsonl"
    rejected_path = out_dir / "v2-route-rejections.jsonl"
    plans_path.write_bytes(b"".join(canonical(row) for row in output))
    rejected_path.write_bytes(b"".join(canonical(row) for row in rejections))

    summary = {
        "schema_version": 1,
        "status": "RMC_013_V2_ROUTE_PLANNING_PASS",
        "algorithm": ALGORITHM,
        "max_hops": max_hops,
        "keep_routes_per_candidate": keep_routes,
        "v2_pair_count": len(pair_rows),
        "capital_feasible_candidate_count": len(promotions),
        "candidate_with_route_count": len(
            {row["candidate_id"] for row in output}
        ),
        "route_unavailable_candidate_count": len(rejections),
        "evaluated_route_topology_count": total_evaluated,
        "emitted_route_count": len(output),
        "input_sha256": {
            "d08_market_state_manifest": sha256_file(d08_state),
            "d12_actionability_records": sha256_file(d12_actionability),
            "d12_capital_promotions": sha256_file(d12_promotions),
        },
        "output_sha256": {
            "v2_route_plans": sha256_file(plans_path),
            "v2_route_rejections": sha256_file(rejected_path),
        },
        "execution_claimed": False,
        "gas_claimed": False,
        "capture_probability_claimed": False,
        "realized_pnl_claimed": False,
    }
    summary_path = out_dir / "v2-route-summary.json"
    summary_path.write_bytes(canonical(summary))
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--d08-state", type=Path, required=True)
    parser.add_argument("--d12-actionability", type=Path, required=True)
    parser.add_argument("--d12-promotions", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--max-hops", type=int, default=3)
    parser.add_argument("--keep-routes", type=int, default=8)
    args = parser.parse_args()
    summary = plan(
        args.d08_state,
        args.d12_actionability,
        args.d12_promotions,
        args.out,
        args.max_hops,
        args.keep_routes,
    )
    print(
        "RMC013_V2_ROUTE_PLANNING_PASS",
        f"candidates={summary['capital_feasible_candidate_count']}",
        f"evaluated_routes={summary['evaluated_route_topology_count']}",
        f"emitted_routes={summary['emitted_route_count']}",
    )


if __name__ == "__main__":
    main()
