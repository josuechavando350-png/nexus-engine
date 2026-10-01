from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-protocol-family-resolution.py")
SPEC = importlib.util.spec_from_file_location("rmc011_protocol_resolution", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def docs() -> tuple[dict, dict, dict, dict, dict]:
    summary = {
        "sources_by_class": {
            "PROTOCOL_NATIVE_FLASH_LOAN": 3,
            "FLASH_SWAP": 2,
        }
    }
    lock = {
        "stages": [
            {"stage": "RMC-008", "artifact_sha256": "0x" + "11" * 32}
        ]
    }
    balancer = {
        "status": "RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED",
        "source_count": 4,
    }
    uniswap = {
        "status": "RMC011_UNISWAP_V3_DUAL_PROVIDER_RECONCILED",
        "source_count": 5,
    }
    expanded = {
        "status": "RMC011_EXPANDED_LEDGER_REPLAY_PASS",
        "legacy_source_count": 5,
        "d08_source_count": 5,
        "d11_native_source_count": 9,
        "expanded_source_count": 14,
        "expanded_capital_commitment": "aa" * 32,
    }
    return summary, lock, balancer, uniswap, expanded


class ProtocolFamilyResolutionTests(unittest.TestCase):
    def test_positive_counts_produce_authenticated_real_sources(self) -> None:
        result = mod.validate_documents(*docs())
        self.assertEqual(result["family_count"], 4)
        self.assertEqual(
            {row["family"] for row in result["families"]},
            mod.ALL_FAMILIES,
        )
        self.assertTrue(all(
            row["outcome"] == "AUTHENTICATED_REAL_SOURCE"
            for row in result["families"]
        ))
        self.assertFalse(result["global_capital_source_completeness_claimed"])
        self.assertFalse(result["terminal_d11_closed"])

    def test_zero_family_count_produces_exhaustive_rejection(self) -> None:
        summary, lock, balancer, uniswap, expanded = docs()
        summary["sources_by_class"]["FLASH_SWAP"] = 0
        expanded["legacy_source_count"] = 3
        expanded["d08_source_count"] = 3
        expanded["expanded_source_count"] = 12
        result = mod.validate_documents(summary, lock, balancer, uniswap, expanded)
        v2 = next(
            row for row in result["families"]
            if row["family"] == "UNISWAP_V2_FLASH_SWAP"
        )
        self.assertEqual(v2["outcome"], "EXHAUSTIVE_REJECTION")
        self.assertEqual(v2["source_count"], 0)

    def test_native_source_conservation_is_required(self) -> None:
        summary, lock, balancer, uniswap, expanded = docs()
        expanded["d11_native_source_count"] = 8
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(summary, lock, balancer, uniswap, expanded)

    def test_expanded_source_conservation_is_required(self) -> None:
        summary, lock, balancer, uniswap, expanded = docs()
        expanded["expanded_source_count"] = 99
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(summary, lock, balancer, uniswap, expanded)

    def test_exact_d08_authority_is_required(self) -> None:
        summary, lock, balancer, uniswap, expanded = docs()
        lock["stages"] = []
        with self.assertRaises(mod.ResolutionError):
            mod.validate_documents(summary, lock, balancer, uniswap, expanded)


if __name__ == "__main__":
    unittest.main()
