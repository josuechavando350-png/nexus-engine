#!/usr/bin/env python3
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_module(filename: str, name: str):
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


gas = load_module("collect_rmc013_gas_evidence.py", "rmc013_gas")
reconcile = load_module("reconcile_rmc013_gas_evidence.py", "rmc013_gas_reconcile")

WETH = "0xC02aaa39b223FE8D0A0e5C4F27eAD9083C756Cc2"


class GasEvidenceTests(unittest.TestCase):
    def test_nearest_rank_is_integer_and_conservative(self):
        values = list(range(1, 101))
        self.assertEqual(gas.nearest_rank(values, 50), 50)
        self.assertEqual(gas.nearest_rank(values, 90), 90)
        self.assertEqual(gas.nearest_rank(values, 99), 99)

    def test_native_price_is_derived_from_exact_oracle_scale(self):
        root = Path(tempfile.mkdtemp(prefix="rmc013-gas-"))
        oracle = root / "oracle.jsonl"
        row = {
            "asset": WETH.lower(),
            "price": "250000000000",
            "base_currency_unit": "100000000",
            "price_path": "SOURCE_LATEST_ANSWER",
        }
        oracle.write_text(json.dumps(row) + "\n", encoding="utf-8")
        price = gas.native_price(oracle, WETH)
        self.assertEqual(price["native_usd_wad"], str(2500 * 10**18))
        self.assertEqual(price["wrapped_native_asset"], WETH.lower())

    def test_fee_history_shape_and_percentiles_are_checked(self):
        result = {
            "oldestBlock": "0x64",
            "baseFeePerGas": ["0x64", "0x65", "0x66"],
            "reward": [["0x1", "0x2", "0x3"], ["0x4", "0x5", "0x6"]],
        }
        parsed = gas.parse_fee_history(result, 2, [50, 90, 99])
        self.assertEqual(parsed["oldest_block"], 100)
        self.assertEqual(parsed["rewards"][1][2], 6)
        with self.assertRaises(ValueError):
            gas.parse_fee_history(result, 3, [50, 90, 99])

    def test_reconciliation_uses_worst_provider_priority_not_average(self):
        root = Path(tempfile.mkdtemp(prefix="rmc013-gas-reconcile-"))
        anchor = {
            "chain_id": 1,
            "block_number": 10,
            "block_hash": "0x" + "11" * 32,
            "parent_hash": "0x" + "22" * 32,
            "timestamp": 100,
            "state_root": "0x" + "33" * 32,
        }
        native = {
            "wrapped_native_asset": WETH.lower(),
            "raw_price": "250000000000",
            "base_currency_unit": "100000000",
            "native_usd_wad": str(2500 * 10**18),
            "price_path": "SOURCE_LATEST_ANSWER",
            "oracle_row_sha256": "aa" * 32,
            "oracle_manifest_sha256": "bb" * 32,
        }
        paths = []
        for provider, priority in [("a", 10), ("b", 30)]:
            row = {
                "provider_id": provider,
                "anchor": anchor,
                "history_blocks": 128,
                "reward_percentiles": [50, 90, 99],
                "admission_priority_percentile": 99,
                "anchor_base_fee_wei": "100",
                "next_block_base_fee_upper_bound_wei": "113",
                "admission_priority_fee_wei": str(priority),
                "native_price": native,
                "lookahead_used": False,
            }
            path = root / f"{provider}.json"
            path.write_bytes(reconcile.canonical(row))
            paths.append(path)
        out = reconcile.reconcile(paths)
        self.assertEqual(out["admission_priority_fee_wei"], "30")
        self.assertEqual(out["effective_gas_price_budget_wei"], "143")


if __name__ == "__main__":
    unittest.main()
