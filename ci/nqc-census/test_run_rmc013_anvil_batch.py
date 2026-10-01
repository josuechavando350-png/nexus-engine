#!/usr/bin/env python3
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("run_rmc013_anvil_batch.py")
SPEC = importlib.util.spec_from_file_location("rmc013_anvil_batch", MODULE_PATH)
assert SPEC and SPEC.loader
batcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = batcher
SPEC.loader.exec_module(batcher)

CANDIDATE = "0x" + "11" * 32
ROUTE_A = "0x" + "22" * 32
ROUTE_B = "0x" + "33" * 32


def row(route_id, compatibility, net):
    return {
        "candidate_id": CANDIDATE,
        "route_id": route_id,
        "route_rank": 1,
        "executor_compatibility": compatibility,
        "pre_gas_success_net_debt_units": str(net),
        "anchor": {
            "chain_id": 1,
            "block_number": 1,
            "block_hash": "0x" + "44" * 32,
            "parent_hash": "0x" + "55" * 32,
            "timestamp": 1,
            "state_root": "0x" + "66" * 32,
        },
        "aave_pool": "0x" + "77" * 20,
        "hops": [],
    }


def write_jsonl(path, values):
    path.write_text(
        "".join(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n" for value in values),
        encoding="utf-8",
    )


class BatchTests(unittest.TestCase):
    def test_static_rejections_need_no_anvil_or_cast(self):
        root = Path(tempfile.mkdtemp(prefix="rmc013-batch-test-"))
        routes = root / "routes.jsonl"
        write_jsonl(
            routes,
            [
                row(
                    ROUTE_A,
                    "SAME_ASSET_DIRECT_SETTLEMENT_REQUIRES_DISTINCT_HARNESS",
                    100,
                ),
                row(ROUTE_B, "PFT_AAVE_V3_EXECUTOR_V2_ROUTE", 0),
            ],
        )
        evidence, summary = batcher.batch(
            routes,
            "https://invalid.example",
            "fixture",
            "definitely-not-anvil",
            "definitely-not-cast",
            "0x00",
            18545,
            root / "anvil.log",
        )
        self.assertEqual(len(evidence), 2)
        self.assertTrue(summary["route_conserved"])
        self.assertEqual(summary["execution_pass_count"], 0)
        self.assertEqual(summary["execution_rejection_count"], 2)
        self.assertIsNone(summary["executor"])
        self.assertEqual(
            {item["reason"] for item in evidence},
            {"PFT_EXECUTOR_ROUTE_UNSUPPORTED", "NON_POSITIVE_PRE_GAS_SUCCESS_NET"},
        )

    def test_duplicate_route_identity_fails_before_execution(self):
        root = Path(tempfile.mkdtemp(prefix="rmc013-batch-dup-"))
        routes = root / "routes.jsonl"
        value = row(ROUTE_A, "PFT_AAVE_V3_EXECUTOR_V2_ROUTE", 0)
        write_jsonl(routes, [value, value])
        with self.assertRaises(ValueError):
            batcher.rows(routes)


    def test_route_identity_and_rank_are_mandatory(self):
        for field in ("candidate_id", "route_id", "route_rank"):
            with self.subTest(field=field):
                root = Path(tempfile.mkdtemp(prefix="rmc013-batch-missing-"))
                routes = root / "routes.jsonl"
                value = row(ROUTE_A, "PFT_AAVE_V3_EXECUTOR_V2_ROUTE", 0)
                del value[field]
                write_jsonl(routes, [value])
                with self.assertRaises(ValueError):
                    batcher.rows(routes)

    def test_positive_executor_route_is_not_statically_rejected(self):
        value = row(ROUTE_A, "PFT_AAVE_V3_EXECUTOR_V2_ROUTE", 1)
        value["hops"] = [{"pair": "0x" + "88" * 20}]
        self.assertIsNone(batcher.static_rejection(value, "fixture"))


if __name__ == "__main__":
    unittest.main()
