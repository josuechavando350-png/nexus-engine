#!/usr/bin/env python3
from __future__ import annotations

import copy
import importlib.util
import unittest
from pathlib import Path

MODULE_PATH = Path("ci/nqc-census/verify-rmc011-balancer-v2-capture.py")
SPEC = importlib.util.spec_from_file_location("rmc011_balancer", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)

VAULT = "0xba12222222228d8ba445958a75a0704d566bf2c8"


def capture(
    provider: str,
    operator: str,
    digit: str,
) -> dict:
    return {
        "schema_version": 1,
        "stage": "RMC-011",
        "family": "BALANCER_V2_FLASH_LOAN",
        "provider_id": provider,
        "provider_operator": operator,
        "rpc_endpoint_hash": digit * 64,
        "provider_manifest": "0x" + digit * 64,
        "bootstrap_manifest": "0x" + digit * 63 + "1",
        "anchor_manifest": "0x" + digit * 63 + "2",
        "anchor": {
            "chain_id": 1,
            "genesis_hash": "0x" + "1" * 64,
            "fork_lineage": "0x" + "2" * 64,
            "block_number": 25_437_474,
            "block_hash": "0x" + "3" * 64,
            "parent_hash": "0x" + "4" * 64,
            "timestamp": 1_799_999_999,
            "state_root": "0x" + "5" * 64,
        },
        "authority_lock_sha256": "6" * 64,
        "d08_market_state_sha256": "7" * 64,
        "d08_token_admission_sha256": "8" * 64,
        "d08_evidence_manifest_sha256": "9" * 64,
        "asset_universe_sha256": "a" * 64,
        "vault": {
            "address": VAULT,
            "code_sha256": "b" * 64,
            "fee_collector": "0x" + "1" * 40,
            "fee_collector_code_sha256": "c" * 64,
            "paused": False,
            "pause_window_end_time": "0",
            "buffer_period_end_time": "0",
            "flash_loan_fee_percentage_1e18": "0",
        },
        "assets": [
            {
                "asset": "0x" + "1" * 40,
                "vault_balance": "0",
                "code_sha256": "d" * 64,
            },
            {
                "asset": "0x" + "2" * 40,
                "vault_balance": "123456789",
                "code_sha256": "e" * 64,
            },
        ],
    }


class BalancerCaptureTests(unittest.TestCase):
    def test_two_distinct_providers_reconcile(self) -> None:
        a = capture("blastapi-public", "Bware Labs", "1")
        b = capture("mevblocker-rpc", "MEV Blocker", "2")
        result = mod.reconcile(a, b)
        self.assertEqual(result["provider_count"], 2)
        self.assertEqual(len(result["assets"]), 2)
        self.assertEqual(
            result["status"],
            "RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED",
        )

    def test_provider_specific_manifests_do_not_change_semantics(self) -> None:
        a = capture("a", "operator-a", "1")
        b = capture("b", "operator-b", "2")
        self.assertEqual(mod.validate_capture(a), mod.validate_capture(b))

    def test_same_operator_fails_independence(self) -> None:
        a = capture("a", "same-operator", "1")
        b = capture("b", "SAME-OPERATOR", "2")
        with self.assertRaises(mod.CaptureError):
            mod.reconcile(a, b)

    def test_semantic_disagreement_fails(self) -> None:
        a = capture("a", "operator-a", "1")
        b = capture("b", "operator-b", "2")
        b["assets"][1]["vault_balance"] = "123456788"
        with self.assertRaises(mod.CaptureError):
            mod.reconcile(a, b)

    def test_asset_order_is_canonical(self) -> None:
        doc = capture("a", "operator-a", "1")
        doc["assets"] = list(reversed(doc["assets"]))
        with self.assertRaises(mod.CaptureError):
            mod.validate_capture(doc)

    def test_provider_manifest_is_required(self) -> None:
        doc = capture("a", "operator-a", "1")
        del doc["provider_manifest"]
        with self.assertRaises(mod.CaptureError):
            mod.validate_capture(doc)

    def test_zero_capacity_asset_is_preserved(self) -> None:
        doc = capture("a", "operator-a", "1")
        semantic = mod.validate_capture(copy.deepcopy(doc))
        self.assertEqual(semantic["assets"][0]["vault_balance"], "0")


if __name__ == "__main__":
    unittest.main()
