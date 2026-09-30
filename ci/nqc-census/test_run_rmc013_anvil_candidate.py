#!/usr/bin/env python3
import importlib.util
import sys
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_rmc013_anvil_candidate.py")
SPEC = importlib.util.spec_from_file_location("rmc013_anvil_candidate", MODULE_PATH)
assert SPEC and SPEC.loader
runner = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = runner
SPEC.loader.exec_module(runner)

A = "0x" + "11" * 20
B = "0x" + "22" * 20
PAIR = "0x" + "33" * 20
POOL = "0x" + "44" * 20
BORROWER = "0x" + "55" * 20
CANDIDATE = "0x" + "66" * 32
ROUTE = "0x" + "77" * 32


def route():
    return {
        "candidate_id": CANDIDATE,
        "route_id": ROUTE,
        "executor_compatibility": "PFT_AAVE_V3_EXECUTOR_V2_ROUTE",
        "anchor": {
            "chain_id": 1,
            "block_number": 25_437_474,
            "block_hash": "0x" + "88" * 32,
            "parent_hash": "0x" + "99" * 32,
            "timestamp": 1_800_000_000,
            "state_root": "0x" + "aa" * 32,
        },
        "borrower": BORROWER,
        "aave_pool": POOL,
        "collateral_asset": A,
        "debt_asset": B,
        "principal_debt_units": "400",
        "pre_gas_success_net_debt_units": "95",
        "hops": [
            {
                "pair": PAIR,
                "token_in": A,
                "token_out": B,
                "amount_in": "1000",
                "amount_out": "500",
            }
        ],
    }


class AnvilCandidateTests(unittest.TestCase):
    def test_operator_is_exactly_one_address(self):
        self.assertEqual(runner.address(runner.OPERATOR, "operator"), runner.OPERATOR)
        self.assertEqual(len(runner.OPERATOR), 42)

    def test_plan_tuple_binds_anchor_candidate_and_exact_hop_amounts(self):
        value = runner.plan_tuple(route())
        self.assertIn("25437474", value)
        self.assertIn(BORROWER, value)
        self.assertIn(POOL, str(route()))
        self.assertIn(PAIR, value)
        self.assertIn(",1000,500)", value)
        self.assertTrue(value.endswith("])"))

    def test_unsupported_executor_surface_rejects_without_starting_anvil(self):
        value = route()
        value["executor_compatibility"] = (
            "SAME_ASSET_DIRECT_SETTLEMENT_REQUIRES_DISTINCT_HARNESS"
        )
        evidence = runner.simulate(
            value,
            "https://invalid.example",
            "fixture",
            "definitely-not-anvil",
            "definitely-not-cast",
            "0x00",
            18545,
            Path("/tmp/unused-anvil.log"),
        )
        self.assertEqual(evidence["status"], "REJECTED")
        self.assertEqual(evidence["reason"], "PFT_EXECUTOR_ROUTE_UNSUPPORTED")

    def test_constructor_encoding_appends_only_abi_arguments(self):
        original = runner.command
        try:
            runner.command = lambda args: "0x" + "00" * 63 + "01"
            encoded = runner.append_constructor(
                "0x6000", "cast", runner.OPERATOR, POOL
            )
        finally:
            runner.command = original
        self.assertEqual(encoded, "0x6000" + "00" * 63 + "01")

    def test_address_and_hash_validation_are_fail_closed(self):
        with self.assertRaises(ValueError):
            runner.address("0x1234", "bad")
        with self.assertRaises(ValueError):
            runner.hash32("0x1234", "bad")


if __name__ == "__main__":
    unittest.main()
