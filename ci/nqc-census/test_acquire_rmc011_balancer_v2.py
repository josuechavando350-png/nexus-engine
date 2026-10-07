#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("acquire_rmc011_balancer_v2.py")
SPEC = importlib.util.spec_from_file_location("rmc011_balancer", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def anchor() -> dict:
    return {
        "block_hash": "0x" + "11" * 32,
        "block_number": 25_437_474,
        "chain_id": 1,
        "fork_lineage": "0x" + "22" * 32,
        "genesis_hash": "0x" + "33" * 32,
        "parent_hash": "0x" + "44" * 32,
        "state_root": "0x" + "55" * 32,
        "timestamp": 1_700_000_000,
    }


def provider(label: str) -> dict:
    return {
        "schema_version": 1,
        "provider_label": label,
        "anchor": anchor(),
        "vault": mod.VAULT_CANONICAL,
        "vault_code_sha256": "aa" * 32,
        "vault_code_bytes": 100,
        "protocol_fees_collector": "0x" + "66" * 20,
        "protocol_fees_collector_code_sha256": "bb" * 32,
        "protocol_fees_collector_code_bytes": 100,
        "paused": False,
        "pause_window_end_time": 1,
        "buffer_period_end_time": 2,
        "flash_loan_fee_percentage_1e18": 500_000_000_000_000,
        "assets": [
            {
                "token": "0x" + "77" * 20,
                "vault_balance": "123456789",
                "token_code_sha256": "cc" * 32,
                "token_code_bytes": 100,
                "state_admission": {"status": "ADMITTED"},
                "execution_compatibility": {
                    "status": "PROVEN_COMPATIBLE",
                    "blockers": [],
                },
            }
        ],
    }


class BalancerAcquisitionTests(unittest.TestCase):
    def test_reconcile_accepts_equal_semantics_with_distinct_labels(self) -> None:
        result = mod.reconcile(provider("A"), provider("B"))
        self.assertEqual(len(result["observations"]), 1)
        self.assertNotEqual(result["provider_a_sha256"], result["provider_b_sha256"])
        self.assertEqual(
            result["observations"][0]["available_vault_balance"],
            "123456789",
        )

    def test_reconcile_rejects_balance_mismatch(self) -> None:
        first = provider("A")
        second = provider("B")
        second["assets"][0]["vault_balance"] = "123456788"
        with self.assertRaises(mod.AcquisitionError):
            mod.reconcile(first, second)

    def test_reconcile_rejects_fee_mismatch(self) -> None:
        first = provider("A")
        second = provider("B")
        second["flash_loan_fee_percentage_1e18"] += 1
        with self.assertRaises(mod.AcquisitionError):
            mod.reconcile(first, second)

    def test_reconcile_rejects_anchor_mismatch(self) -> None:
        first = provider("A")
        second = provider("B")
        second["anchor"]["block_hash"] = "0x" + "99" * 32
        with self.assertRaises(mod.AcquisitionError):
            mod.reconcile(first, second)

    def test_load_tokens_preserves_blocked_assets(self) -> None:
        rows = [
            {
                "token": "0x" + "11" * 20,
                "state_admission": {"status": "ADMITTED"},
                "execution_compatibility": {
                    "status": "BLOCKED",
                    "blockers": ["UPGRADEABLE_UNPROVEN"],
                },
            },
            {
                "token": "0x" + "22" * 20,
                "state_admission": {"status": "REJECTED", "reason": "TEST"},
                "execution_compatibility": {
                    "status": "BLOCKED",
                    "blockers": ["STATE_REJECTED_TEST"],
                },
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token-admission.jsonl"
            path.write_text(
                "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
                encoding="utf-8",
            )
            loaded = mod.load_tokens(path)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(
            loaded[0]["execution_compatibility"]["blockers"],
            ["UPGRADEABLE_UNPROVEN"],
        )

    def test_load_tokens_rejects_duplicate_disagreement(self) -> None:
        token = "0x" + "11" * 20
        rows = [
            {
                "token": token,
                "state_admission": {"status": "ADMITTED"},
                "execution_compatibility": {"status": "PROVEN_COMPATIBLE", "blockers": []},
            },
            {
                "token": token,
                "state_admission": {"status": "ADMITTED"},
                "execution_compatibility": {"status": "BLOCKED", "blockers": ["X"]},
            },
        ]
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "token-admission.jsonl"
            path.write_text(
                "".join(json.dumps(row, separators=(",", ":")) + "\n" for row in rows),
                encoding="utf-8",
            )
            with self.assertRaises(mod.AcquisitionError):
                mod.load_tokens(path)

    def test_write_outputs_binds_all_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "evidence"
            mod.write_outputs(out, provider("A"), provider("B"))
            manifest = json.loads((out / "evidence-manifest.json").read_text())
            self.assertEqual(
                manifest["status"],
                "AUTHENTICATED_DUAL_PROVIDER_ACQUISITION",
            )
            self.assertFalse(manifest["terminal_d11_claim"])
            self.assertEqual(
                set(manifest["files"]),
                {
                    "provider-a.json",
                    "provider-b.json",
                    "balancer-v2-observations.jsonl",
                    "summary.json",
                },
            )


if __name__ == "__main__":
    unittest.main()
