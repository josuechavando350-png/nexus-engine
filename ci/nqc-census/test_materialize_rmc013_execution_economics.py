#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE = Path(__file__).with_name("materialize_rmc013_execution_economics.py")
SPEC = importlib.util.spec_from_file_location("rmc013_materialize", MODULE)
assert SPEC and SPEC.loader
mat = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = mat
SPEC.loader.exec_module(mat)

ANCHOR = {
    "chain_id": 1,
    "block_number": 26_095_351,
    "block_hash": "0x" + "11" * 32,
    "parent_hash": "0x" + "22" * 32,
    "timestamp": 1_790_832_215,
    "state_root": "0x" + "33" * 32,
}
CANDIDATE_A = "0x" + "aa" * 32
CANDIDATE_B = "0x" + "ab" * 32
ACTION = "0x" + "bb" * 32
ROUTE_1 = "0x" + "01" * 32
ROUTE_2 = "0x" + "02" * 32
SOURCE = "0x" + "66" * 32
D12_DIGEST = "sha256:" + "dd" * 32


def write_jsonl(path: Path, values: list[dict]) -> None:
    path.write_text(
        "".join(json.dumps(v, sort_keys=True, separators=(",", ":")) + "\n" for v in values),
        encoding="utf-8",
    )


def route(candidate=CANDIDATE_A, route_id=ROUTE_1, gross="100000000000000000000"):
    return {
        "candidate_id": candidate,
        "actionable_candidate_id": ACTION,
        "route_id": route_id,
        "anchor": ANCHOR,
        "trade_size_collateral_units": "1000",
        "valuation": {
            "unit": "USD_WAD",
            "gross_value_usd_wad": gross,
            "gross_deficit_usd_wad": "0",
            "protocol_fee_cost_usd_wad": "1000000000000000000",
            "capital_fee_cost_usd_wad": "500000000000000000",
            "swap_fee_cost_usd_wad": "1000000000000000000",
            "price_impact_cost_usd_wad": "1000000000000000000",
        },
    }


def execution(candidate=CANDIDATE_A, route_id=ROUTE_1, gas_used=100_000, requirement=120_000):
    return {
        "candidate_id": candidate,
        "route_id": route_id,
        "status": "PASS",
        "reason": None,
        "provider_consensus": True,
        "semantic_evidence": {
            "candidate_id": candidate,
            "route_id": route_id,
            "status": "PASS",
            "simulated_gas_used": gas_used,
            "gas_requirement_units": requirement,
        },
    }


def gas():
    return {
        "schema": "nqc-rmc-013-gas-price-evidence-v1",
        "status": "RMC_013_GAS_PRICE_EVIDENCE_PASS",
        "anchor": ANCHOR,
        "next_block_base_fee_upper_bound_wei": "10000000000",
        "admission_priority_fee_wei": "2000000000",
        "effective_gas_price_budget_wei": "12000000000",
        "native_price": {
            "wrapped_native_asset": "0x" + "44" * 20,
            "native_usd_wad": str(2500 * 10**18),
        },
        "lookahead_used": False,
    }


def gas_source(capacity: int, ownership="EXTERNAL", execution_eligible=True, blockers=None):
    return {
        "source_id": SOURCE,
        "capital_class": "GAS_FUNDING",
        "asset": "NATIVE_GAS",
        "capital_ownership": ownership,
        "execution_eligible": execution_eligible,
        "execution_blockers": [] if blockers is None else blockers,
        "executable_capacity": "0x" + f"{capacity:064x}",
        "anchor": ANCHOR,
    }


class MaterializerTests(unittest.TestCase):
    def fixture(
        self,
        routes=None,
        reconciled=None,
        route_rejections=None,
        sources=None,
        feasible_count=None,
    ):
        root = Path(tempfile.mkdtemp(prefix="rmc013-materialize-test-"))
        paths = {
            "routes": root / "routes.jsonl",
            "route_rejections": root / "route-rejections.jsonl",
            "reconciled": root / "reconciled.jsonl",
            "gas": root / "gas.json",
            "sources": root / "sources.jsonl",
            "d12": root / "d12.json",
            "out": root / "out",
        }
        route_rows = [route()] if routes is None else routes
        exec_rows = [execution()] if reconciled is None else reconciled
        rejects = [] if route_rejections is None else route_rejections
        source_rows = [gas_source(10**30)] if sources is None else sources
        candidates = {
            row["candidate_id"] for row in route_rows
        } | {
            row["candidate_id"] for row in rejects
        }
        count = len(candidates) if feasible_count is None else feasible_count
        write_jsonl(paths["routes"], route_rows)
        write_jsonl(paths["route_rejections"], rejects)
        write_jsonl(paths["reconciled"], exec_rows)
        write_jsonl(paths["sources"], source_rows)
        paths["gas"].write_text(json.dumps(gas()), encoding="utf-8")
        paths["d12"].write_text(
            json.dumps({
                "status": "RMC_012_ACTIONABILITY_PASS",
                "anchor": ANCHOR,
                "principal_capital_feasible": count,
            }),
            encoding="utf-8",
        )
        return root, paths

    def run_materializer(self, paths):
        return mat.materialize(
            paths["routes"],
            paths["route_rejections"],
            paths["reconciled"],
            paths["gas"],
            paths["sources"],
            paths["d12"],
            D12_DIGEST,
            paths["out"],
        )

    def test_single_candidate_materializes_complete_economics_surface(self):
        _, paths = self.fixture()
        summary = self.run_materializer(paths)
        self.assertEqual(summary["economics_candidate_count"], 1)
        self.assertEqual(summary["economics_quote_count"], 1)
        self.assertEqual(summary["execution_variant_count"], 1)
        self.assertEqual(summary["explicit_rejection_count"], 0)
        self.assertTrue(summary["coverage_complete"])
        self.assertFalse(summary["capture_probability_invented"])
        self.assertFalse(summary["global_concurrent_gas_capacity_claimed"])
        quotes = mat.rows(paths["out"] / "execution-economics.jsonl")
        self.assertEqual(len(quotes), 1)
        self.assertEqual(
            [row["kind"] for row in quotes[0]["costs"]],
            list(mat.COST_KINDS),
        )
        self.assertEqual(quotes[0]["capture"]["status"], "UNCALIBRATED")
        self.assertIsNone(quotes[0]["capture"]["probability"])
        self.assertEqual(
            len(mat.rows(paths["out"] / "gas-funding-bindings.jsonl")), 1
        )
        for name in (
            "capacity-curves.jsonl",
            "shadow-predictions.jsonl",
            "gas-conflict-claims.jsonl",
            "execution-evidence-summary.json",
            "evidence-manifest.json",
        ):
            self.assertTrue((paths["out"] / name).is_file(), name)

    def test_one_candidate_may_materialize_multiple_exact_variants(self):
        routes = [
            route(route_id=ROUTE_1),
            route(route_id=ROUTE_2, gross="110000000000000000000"),
        ]
        reconciled = [
            execution(route_id=ROUTE_1),
            execution(route_id=ROUTE_2, gas_used=101_000, requirement=121_000),
        ]
        _, paths = self.fixture(routes=routes, reconciled=reconciled)
        summary = self.run_materializer(paths)
        self.assertEqual(summary["economics_candidate_count"], 1)
        self.assertEqual(summary["economics_quote_count"], 2)
        self.assertEqual(summary["execution_variant_count"], 2)
        self.assertEqual(
            len(mat.rows(paths["out"] / "gas-funding-bindings.jsonl")), 1
        )
        curves = mat.rows(paths["out"] / "capacity-curves.jsonl")
        self.assertEqual(len(curves), 1)
        self.assertEqual(len(curves[0]["variants"]), 2)

    def test_shared_gas_source_is_per_candidate_feasible_and_becomes_conflict_claim(self):
        # Each candidate needs 120k * 12 gwei = 1.44e15 wei.
        # Source capacity 2e15 can fund either candidate but not both
        # simultaneously. RMC-013 must not fabricate simultaneous execution.
        required = 120_000 * 12_000_000_000
        routes = [
            route(CANDIDATE_A, ROUTE_1),
            route(CANDIDATE_B, ROUTE_2),
        ]
        reconciled = [
            execution(CANDIDATE_A, ROUTE_1),
            execution(CANDIDATE_B, ROUTE_2),
        ]
        _, paths = self.fixture(
            routes=routes,
            reconciled=reconciled,
            sources=[gas_source(2_000_000_000_000_000)],
        )
        summary = self.run_materializer(paths)
        self.assertGreater(required * 2, 2_000_000_000_000_000)
        self.assertEqual(summary["economics_candidate_count"], 2)
        self.assertEqual(summary["explicit_rejection_count"], 0)
        self.assertEqual(summary["shared_gas_conflict_claim_count"], 2)
        claims = mat.rows(paths["out"] / "gas-conflict-claims.jsonl")
        self.assertEqual({row["resource_id"] for row in claims}, {SOURCE})
        self.assertEqual({row["candidate_id"] for row in claims}, {CANDIDATE_A, CANDIDATE_B})

    def test_single_candidate_over_capacity_rejects_explicitly(self):
        _, paths = self.fixture(sources=[gas_source(1)])
        summary = self.run_materializer(paths)
        self.assertEqual(summary["execution_simulatable_count"], 0)
        self.assertEqual(summary["explicit_rejection_count"], 1)
        rejects = mat.rows(paths["out"] / "execution-rejection-ledger.jsonl")
        self.assertEqual(rejects[0]["reason"], "INSUFFICIENT_EXTERNAL_GAS_FUNDING")
        self.assertEqual(summary["unknown_rejection_count"], 0)

    def test_operator_owned_gas_cannot_make_candidate_executable(self):
        _, paths = self.fixture(sources=[gas_source(10**30, ownership="OPERATOR_OWNED")])
        summary = self.run_materializer(paths)
        self.assertEqual(summary["execution_simulatable_count"], 0)
        self.assertEqual(summary["operator_owned_gas_funding_count"], 0)
        rejects = mat.rows(paths["out"] / "execution-rejection-ledger.jsonl")
        self.assertEqual(rejects[0]["reason"], "INSUFFICIENT_EXTERNAL_GAS_FUNDING")

    def test_all_physical_variants_rejected_is_conserved_not_unknown(self):
        rejected_exec = {
            "candidate_id": CANDIDATE_A,
            "route_id": ROUTE_1,
            "status": "REJECTED",
            "reason": "FORK_EXECUTION_REVERTED",
            "provider_consensus": True,
            "semantic_evidence": {
                "candidate_id": CANDIDATE_A,
                "route_id": ROUTE_1,
                "status": "REJECTED",
                "reason": "FORK_EXECUTION_REVERTED",
            },
        }
        _, paths = self.fixture(reconciled=[rejected_exec])
        summary = self.run_materializer(paths)
        self.assertEqual(summary["explicit_rejection_count"], 1)
        self.assertEqual(summary["unknown_rejection_count"], 0)
        reject = mat.rows(paths["out"] / "execution-rejection-ledger.jsonl")[0]
        self.assertEqual(reject["reason"], "PHYSICAL_EXECUTION_REJECTED_ALL_VARIANTS")

    def test_unknown_physical_rejection_fails_closed(self):
        rejected_exec = {
            "candidate_id": CANDIDATE_A,
            "route_id": ROUTE_1,
            "status": "REJECTED",
            "reason": "UNKNOWN",
            "provider_consensus": True,
            "semantic_evidence": {},
        }
        _, paths = self.fixture(reconciled=[rejected_exec])
        with self.assertRaises(ValueError):
            self.run_materializer(paths)

    def test_gas_anchor_substitution_fails_closed(self):
        _, paths = self.fixture()
        bad = gas()
        bad["anchor"] = {**ANCHOR, "block_hash": "0x" + "99" * 32}
        paths["gas"].write_text(json.dumps(bad), encoding="utf-8")
        with self.assertRaises(ValueError):
            self.run_materializer(paths)

    def test_missing_reconciled_variant_fails_closed(self):
        _, paths = self.fixture(reconciled=[])
        with self.assertRaises(ValueError):
            self.run_materializer(paths)

    def test_d12_candidate_conservation_fails_closed(self):
        _, paths = self.fixture(feasible_count=2)
        with self.assertRaises(ValueError):
            self.run_materializer(paths)


if __name__ == "__main__":
    unittest.main()
