#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("reconcile_rmc013_provider_evidence.py")
SPEC = importlib.util.spec_from_file_location("rmc013_reconcile", MODULE_PATH)
assert SPEC and SPEC.loader
reconcile = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = reconcile
SPEC.loader.exec_module(reconcile)

CANDIDATE = "0x" + "11" * 32
ROUTE = "0x" + "22" * 32


def write_jsonl(path, values):
    path.write_text(
        "".join(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n" for value in values),
        encoding="utf-8",
    )


def summary(provider, count=1):
    return {
        "status": "RMC_013_ANVIL_BATCH_PASS",
        "provider_id": provider,
        "route_plan_count": count,
        "route_conserved": True,
    }


def static_row(provider, reason="NON_POSITIVE_PRE_GAS_SUCCESS_NET"):
    return {
        "provider_id": provider,
        "candidate_id": CANDIDATE,
        "route_id": ROUTE,
        "status": "REJECTED",
        "reason": reason,
        "modeled_profit_debt_units": "0",
    }


def pass_row(provider, gas=100000):
    anchor = {
        "number": 25_437_474,
        "hash": "0x" + "33" * 32,
        "parentHash": "0x" + "44" * 32,
        "stateRoot": "0x" + "55" * 32,
        "timestamp": 1_800_000_000,
        "baseFeePerGas": 10,
    }
    return {
        "provider_id": provider,
        "candidate_id": CANDIDATE,
        "route_id": ROUTE,
        "status": "PASS",
        "anchor": anchor,
        "executor": "0x" + "66" * 20,
        "executor_runtime_sha256": "77" * 32,
        "executor_runtime_keccak256": "0x" + "88" * 32,
        "calldata_sha256": "99" * 32,
        "realized_profit_debt_units_before_gas": "100",
        "simulated_gas_used": gas,
        "simulated_gas_used_basis": "DEBUG_TRACECALL_EXACT_ANVIL_FORK_ANCHOR",
        "gas_requirement_units": gas + 1000,
        "gas_requirement_basis": "ETH_ESTIMATE_GAS_EXACT_ANVIL_FORK_ANCHOR",
        "fork_local_executor_code_injected": True,
        "fork_local_operator_balance_overridden": True,
        "operator_balance_override_is_capital_evidence": False,
        "live_transaction_sent": False,
        "own_capital_used": False,
    }


class ReconcileTests(unittest.TestCase):
    def fixture(self, left, right, modeled="0"):
        root = Path(tempfile.mkdtemp(prefix="rmc013-reconcile-test-"))
        routes = root / "routes.jsonl"
        lp = root / "left.jsonl"
        rp = root / "right.jsonl"
        ls = root / "left-summary.json"
        rs = root / "right-summary.json"
        write_jsonl(
            routes,
            [{
                "candidate_id": CANDIDATE,
                "route_id": ROUTE,
                "pre_gas_success_net_debt_units": modeled,
            }],
        )
        write_jsonl(lp, [left])
        write_jsonl(rp, [right])
        ls.write_text(json.dumps(summary("left")), encoding="utf-8")
        rs.write_text(json.dumps(summary("right")), encoding="utf-8")
        return routes, lp, rp, ls, rs

    def test_identical_static_rejection_reconciles(self):
        args = self.fixture(static_row("left"), static_row("right"))
        rows, summary_doc = reconcile.reconcile(*args)
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["provider_consensus"])
        self.assertEqual(summary_doc["provider_mismatch_count"], 0)

    def test_one_unit_gas_difference_is_terminal_mismatch(self):
        args = self.fixture(pass_row("left", 100000), pass_row("right", 100001), "100")
        with self.assertRaises(ValueError):
            reconcile.reconcile(*args)

    def test_rejection_reason_difference_is_terminal_mismatch(self):
        args = self.fixture(
            static_row("left", "NON_POSITIVE_PRE_GAS_SUCCESS_NET"),
            static_row("right", "PFT_EXECUTOR_ROUTE_UNSUPPORTED"),
        )
        with self.assertRaises(ValueError):
            reconcile.reconcile(*args)

    def test_revert_without_content_addressed_bytes_fails_closed(self):
        row = {
            "provider_id": "left",
            "candidate_id": CANDIDATE,
            "route_id": ROUTE,
            "status": "REJECTED",
            "reason": "FORK_EXECUTION_REVERTED",
            "revert_selector": None,
            "revert_data_sha256": None,
        }
        args = self.fixture(row, {**row, "provider_id": "right"})
        with self.assertRaises(ValueError):
            reconcile.reconcile(*args)


if __name__ == "__main__":
    unittest.main()
