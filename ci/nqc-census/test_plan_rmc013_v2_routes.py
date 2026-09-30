#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
import sys
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("plan_rmc013_v2_routes.py")
SPEC = importlib.util.spec_from_file_location("rmc013_routes", MODULE_PATH)
assert SPEC and SPEC.loader
routes = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = routes
SPEC.loader.exec_module(routes)

A = "0x" + "11" * 20
B = "0x" + "22" * 20
C = "0x" + "33" * 20
D = "0x" + "44" * 20
ACTION = "0x" + "aa" * 32
PORTFOLIO = "0x" + "bb" * 32


def pair(index, pair_address, token0, token1, reserve0, reserve1):
    return {
        "schema_version": 1,
        "protocol": "UNISWAP_V2",
        "market_id": "0x" + f"{index + 1:064x}",
        "index": index,
        "pair": pair_address,
        "token0": token0,
        "token1": token1,
        "runtime": {
            "kind": "CREATE2_DERIVED_FROM_ADMITTED_FACTORY",
            "derivation_matches": True,
            "runtime_sha256": "11" * 32,
        },
        "factory_membership": True,
        "reserves": [str(reserve0), str(reserve1), 123],
        "total_supply": "1000000",
        "fee_semantics": {
            "swap_fee_bps": 30,
            "basis": "EXPLICIT_CONFIGURATION_BOUND_TO_ADMITTED_PAIR_RUNTIME",
            "protocol_fee_enabled": False,
        },
        "liquidity_state": "LIQUID",
        "stage_state_reconstructable": "ADVANCE",
    }


def action(collateral=A, debt=B):
    return {
        "status": "ADMITTED",
        "candidate_id": ACTION,
        "borrower": "0x" + "55" * 20,
        "collateral_asset": collateral,
        "debt_asset": debt,
        "collateral_to_liquidator": "1000",
        "liquidation_protocol_fee_collateral": "100",
        "debt_to_liquidate": "400",
        "flash_loan_premium": "5",
        "debt_price_base_wad": str(10**18),
        "debt_asset_unit": "1000",
    }


def promotion():
    return {
        "actionable_candidate_id": ACTION,
        "portfolio_candidate_id": PORTFOLIO,
        "aave_pool": "0x" + "77" * 20,
        "capital_status": "FEASIBLE",
        "allocations": [{"source_id": "0x" + "66" * 32, "amount": "0x" + "00" * 31 + "01"}],
    }


def d12_summary(feasible_count=1):
    return {
        "status": "RMC_012_ACTIONABILITY_PASS",
        "principal_capital_feasible": feasible_count,
        "anchor": {
            "chain_id": 1,
            "block_number": 25_437_474,
            "block_hash": "0x" + "88" * 32,
            "parent_hash": "0x" + "99" * 32,
            "timestamp": 1_800_000_000,
            "state_root": "0x" + "ab" * 32,
        },
    }


def write_jsonl(path: Path, values):
    path.write_text(
        "".join(json.dumps(row, sort_keys=True, separators=(",", ":")) + "\n" for row in values),
        encoding="utf-8",
    )


class RoutePlannerTests(unittest.TestCase):
    def run_plan(self, pairs, action_rows=None, promotions=None, max_hops=3, keep_routes=0):
        root = Path(tempfile.mkdtemp(prefix="rmc013-route-test-"))
        state = root / "state.jsonl"
        actions = root / "actions.jsonl"
        promo = root / "promotions.jsonl"
        summary_path = root / "actionability-summary.json"
        out = root / "out"
        promotion_rows = promotions if promotions is not None else [promotion()]
        write_jsonl(state, pairs)
        write_jsonl(actions, action_rows if action_rows is not None else [action()])
        write_jsonl(promo, promotion_rows)
        summary_path.write_text(
            json.dumps(d12_summary(len([row for row in promotion_rows if row.get("capital_status") == "FEASIBLE"]))),
            encoding="utf-8",
        )
        summary = routes.plan(
            state,
            actions,
            summary_path,
            promo,
            out,
            max_hops,
            keep_routes,
        )
        planned = routes.rows(out / "v2-route-plans.jsonl")
        rejected = routes.rows(out / "v2-route-rejections.jsonl")
        return summary, planned, rejected

    def test_two_hop_route_can_beat_direct_and_decomposition_conserves_value(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, B, 10_000, 5_000),
            pair(1, "0x" + "02" * 20, A, C, 10_000, 20_000),
            pair(2, "0x" + "03" * 20, C, B, 20_000, 20_000),
        ]
        summary, planned, rejected = self.run_plan(pairs)
        self.assertEqual(rejected, [])
        self.assertEqual(summary["capital_feasible_candidate_count"], 1)
        self.assertEqual(summary["evaluated_route_topology_count"], 2)
        self.assertEqual(len(planned), 2)
        best = planned[0]
        self.assertEqual(len(best["hops"]), 2)
        gross = int(best["gross_surplus_debt_units"]) - int(best["gross_deficit_debt_units"])
        costs = (
            int(best["protocol_fee_cost_debt_units"])
            + int(best["swap_fee_cost_debt_units"])
            + int(best["price_impact_cost_debt_units"])
            + int(best["flash_premium_debt_units"])
        )
        self.assertEqual(gross - costs, int(best["pre_gas_success_net_debt_units"]))

    def test_three_hop_search_is_complete_for_simple_fixture(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, C, 10_000, 10_000),
            pair(1, "0x" + "02" * 20, C, D, 10_000, 10_000),
            pair(2, "0x" + "03" * 20, D, B, 10_000, 10_000),
        ]
        summary2, planned2, rejected2 = self.run_plan(pairs, max_hops=2)
        self.assertEqual(planned2, [])
        self.assertEqual(len(rejected2), 1)
        summary3, planned3, rejected3 = self.run_plan(pairs, max_hops=3)
        self.assertEqual(rejected3, [])
        self.assertEqual(summary3["evaluated_route_topology_count"], 1)
        self.assertEqual(len(planned3[0]["hops"]), 3)
        self.assertEqual(summary2["evaluated_route_topology_count"], 0)

    def test_same_asset_is_explicit_zero_hop_route(self):
        summary, planned, rejected = self.run_plan(
            [],
            action_rows=[action(collateral=A, debt=A)],
        )
        self.assertEqual(rejected, [])
        self.assertEqual(summary["evaluated_route_topology_count"], 1)
        self.assertEqual(planned[0]["hops"], [])
        self.assertEqual(planned[0]["actual_output_debt_units"], "1000")

    def test_missing_route_is_explicit_rejection_not_unknown(self):
        pairs = [pair(0, "0x" + "01" * 20, A, C, 10_000, 10_000)]
        _, planned, rejected = self.run_plan(pairs)
        self.assertEqual(planned, [])
        self.assertEqual(len(rejected), 1)
        self.assertEqual(rejected[0]["reason"], "ROUTE_UNAVAILABLE_V2_MAX_HOPS")

    def test_nonreconstructable_or_zero_liquidity_pair_is_never_routed(self):
        bad = pair(0, "0x" + "01" * 20, A, B, 10_000, 10_000)
        bad["stage_state_reconstructable"] = "REJECT:STATE_UNRECONSTRUCTABLE"
        zero = pair(1, "0x" + "02" * 20, A, B, 10_000, 10_000)
        zero["liquidity_state"] = "ZERO_LIQUIDITY_NOT_ROUTABLE"
        summary, planned, rejected = self.run_plan([bad, zero])
        self.assertEqual(summary["v2_pair_count"], 0)
        self.assertEqual(planned, [])
        self.assertEqual(len(rejected), 1)

    def test_zero_output_mid_route_preserves_full_hop_trace(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, C, 10**30, 1),
            pair(1, "0x" + "02" * 20, C, B, 10_000, 10_000),
        ]
        _, planned, rejected = self.run_plan(pairs, max_hops=2)
        self.assertEqual(rejected, [])
        self.assertEqual(len(planned), 1)
        self.assertEqual(len(planned[0]["hops"]), 2)
        self.assertEqual(planned[0]["hops"][0]["amount_out"], "0")
        self.assertEqual(planned[0]["hops"][1]["amount_in"], "0")
        self.assertEqual(planned[0]["hops"][1]["amount_out"], "0")
        self.assertLess(int(planned[0]["pre_gas_success_net_debt_units"]), 0)

    def test_exhaustive_mode_never_omits_positive_routes(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, B, 10_000, 9_000),
            pair(1, "0x" + "02" * 20, A, C, 10_000, 20_000),
            pair(2, "0x" + "03" * 20, C, B, 20_000, 20_000),
        ]
        summary, planned, rejected = self.run_plan(pairs, keep_routes=0)
        self.assertEqual(rejected, [])
        self.assertTrue(summary["route_execution_coverage_complete"])
        self.assertEqual(summary["positive_routes_omitted"], 0)
        self.assertEqual(summary["emission_policy"], "ALL_POSITIVE_ELSE_BEST_NONPOSITIVE")
        self.assertEqual(len(planned), planned[0]["positive_route_count"])

    def test_capped_mode_exposes_positive_route_omission(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, B, 10_000, 9_000),
            pair(1, "0x" + "02" * 20, A, C, 10_000, 20_000),
            pair(2, "0x" + "03" * 20, C, B, 20_000, 20_000),
        ]
        summary, planned, _ = self.run_plan(pairs, keep_routes=1)
        self.assertFalse(summary["route_execution_coverage_complete"])
        self.assertGreater(summary["positive_routes_omitted"], 0)
        self.assertEqual(len(planned), 1)

    def test_input_order_cannot_change_selected_route_bytes(self):
        pairs = [
            pair(0, "0x" + "01" * 20, A, B, 10_000, 5_000),
            pair(1, "0x" + "02" * 20, A, C, 10_000, 20_000),
            pair(2, "0x" + "03" * 20, C, B, 20_000, 20_000),
        ]
        first = self.run_plan(pairs)[1]
        second = self.run_plan(list(reversed(pairs)))[1]
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
