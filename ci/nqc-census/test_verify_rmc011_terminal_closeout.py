#!/usr/bin/env python3
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODULE_PATH = HERE / "verify-rmc011-terminal-closeout.py"
spec = importlib.util.spec_from_file_location("rmc011_terminal_closeout", MODULE_PATH)
assert spec is not None and spec.loader is not None
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def canonical(value: dict) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def evidence(i: int, kind: str) -> dict:
    head = f"{i + 1:040x}"
    return {
        "kind": kind,
        "repository": mod.EXPECTED_REPOSITORY,
        "workflow_name": "fixture-workflow",
        "run_id": 1000 + i,
        "head_sha": head,
        "artifact_id": 2000 + i,
        "artifact_name": f"fixture-{head}-{i}",
        "artifact_digest": "sha256:" + f"{3000 + i:064x}",
        "file": f"families/family-{i}/evidence.json",
        "sha256": f"{4000 + i:064x}",
    }


def valid_source_universe() -> dict:
    families = []
    for i, family in enumerate(sorted(mod.EXPECTED_FAMILIES)):
        status = (
            "AUTHENTICATED_REAL_SOURCE"
            if i % 2 == 0
            else "EXHAUSTIVELY_REJECTED_WITH_REPRODUCIBLE_EVIDENCE"
        )
        kind = "AUTHENTICATED_REAL_SOURCE" if status == "AUTHENTICATED_REAL_SOURCE" else "EXHAUSTIVE_REJECTION"
        families.append(
            {
                "id": family,
                "status": status,
                "terminally_resolved": True,
                "resolution_evidence": evidence(i, kind),
            }
        )
    discovery = evidence(99, "AUTHENTICATED_DISCOVERY")
    discovery["file"] = "discovery-evidence.json"
    return {
        "schema_version": 2,
        "stage": "RMC-011",
        "contract": "NQC_RMC011_CAPITAL_SOURCE_UNIVERSE_V1",
        "status": "CAPITAL_SOURCE_UNIVERSE_COMPLETE",
        "terminal_claim_allowed": True,
        "unknown_family_count": 0,
        "claim_scope": "SOURCE_UNIVERSE_READINESS_ONLY",
        "d11_terminal_closed": False,
        "families": families,
        "family_universe_discovery": {
            "status": "AUTHENTICATED_COMPLETE",
            "evidence": discovery,
        },
    }


def valid_lock() -> tuple[bytes, dict]:
    doc = {
        "schema_version": 1,
        "authority_lock_commitment": "0x" + "ab" * 32,
        "stages": [{"stage": f"D{i:02d}"} for i in range(6, 11)],
    }
    return canonical(doc), doc


def valid_transport_auth() -> tuple[bytes, bytes]:
    labels = sorted(mod.EXPECTED_FAMILIES) + ["FAMILY_UNIVERSE_DISCOVERY"]
    lines = []
    for i, label in enumerate(labels):
        lines.append("\t".join([
            label,
            str(5000 + i),
            str(6000 + i),
            f"{7000 + i:040x}",
            f"{8000 + i:064x}",
        ]))
    raw = ("\n".join(lines) + "\n").encode()
    marker = (hashlib.sha256(raw).hexdigest() + "  /tmp/rmc011-terminal-evidence-authenticated.tsv\n").encode()
    return raw, marker


def valid_closeout(lock_raw: bytes, lock: dict) -> dict:
    return {
        "schema_version": 3,
        "status": "RMC_011_REAL_SOURCE_CLOSEOUT_PASS",
        "real_source_certification": True,
        "source_count": 4,
        "requirement_count": 2,
        "feasible_count": 0,
        "zero_own_capital_proven": False,
        "global_capital_source_completeness_claimed": False,
        "terminal_capital_census_complete": False,
        "actionable_requirement_coverage_complete": False,
        "portfolio_concurrent_capacity_claimed": False,
        "repayment_cashflow_sufficiency_claimed": False,
        "profitability_claimed": False,
        "shadow_eligibility_claimed": False,
        "canary_claimed": False,
        "real_pnl_claimed": False,
        "generated_at": "2026-10-01T00:00:00Z",
        "observation_anchor": {
            "chain_id": 1,
            "block_number": 26095351,
            "block_hash": mod.EXPECTED_A1_HASH,
        },
        "code_commit": "12" * 20,
        "code_tree": "34" * 20,
        "capital_commitment": "0x" + "56" * 32,
        "upstream_authority_commitment": "0x" + "78" * 32,
        "upstream_authority_lock_commitment": lock["authority_lock_commitment"],
        "upstream_authority_lock_sha256": "0x" + hashlib.sha256(lock_raw).hexdigest(),
    }


class TerminalCloseoutTests(unittest.TestCase):
    def build(self, source: dict | None = None, closeout: dict | None = None, lock_raw: bytes | None = None, lock: dict | None = None, transport_raw: bytes | None = None, transport_marker: bytes | None = None) -> dict:
        if source is None:
            source = valid_source_universe()
        if lock_raw is None or lock is None:
            lock_raw, lock = valid_lock()
        if closeout is None:
            closeout = valid_closeout(lock_raw, lock)
        if transport_raw is None or transport_marker is None:
            transport_raw, transport_marker = valid_transport_auth()
        return mod.build_terminal_closeout(
            canonical(source),
            source,
            canonical(closeout),
            closeout,
            lock_raw,
            lock,
            transport_raw,
            transport_marker,
        )

    def test_complete_inputs_emit_terminal_closeout(self):
        out = self.build()
        self.assertEqual(out["status"], "D11_TERMINAL_CLOSED")
        self.assertTrue(out["d11_terminal_closed"])
        self.assertTrue(out["terminal_capital_census_complete"])
        self.assertTrue(out["capital_source_universe_complete"])
        self.assertEqual(out["resolved_family_count"], 13)
        self.assertEqual(out["source_universe_transport_auth_count"], 14)
        self.assertRegex(out["source_universe_transport_auth_sha256"], r"^[0-9a-f]{64}$")
        self.assertFalse(out["profitability_claimed"])

    def test_terminal_commitment_is_deterministic(self):
        first = self.build()
        second = self.build()
        self.assertEqual(first, second)
        commitment = first.pop("terminal_closeout_commitment")
        self.assertEqual(commitment, "0x" + mod.sha256_bytes(mod.canonical_bytes(first)))

    def test_one_unresolved_family_fails_closed(self):
        source = valid_source_universe()
        row = source["families"][0]
        row["status"] = "SEMANTIC_ADMISSION_IMPLEMENTED"
        row["terminally_resolved"] = False
        row["resolution_evidence"] = None
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(source=source)

    def test_family_set_substitution_fails_closed(self):
        source = valid_source_universe()
        source["families"][0]["id"] = "NOT_A_CANONICAL_FAMILY"
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(source=source)

    def test_discovery_must_be_authenticated(self):
        source = valid_source_universe()
        source["family_universe_discovery"] = {"status": "NOT_CERTIFIED", "evidence": None}
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(source=source)

    def test_wrong_observation_anchor_fails_closed(self):
        lock_raw, lock = valid_lock()
        closeout = valid_closeout(lock_raw, lock)
        closeout["observation_anchor"]["block_number"] = mod.EXPECTED_A1_BLOCK - 1
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(closeout=closeout, lock_raw=lock_raw, lock=lock)

    def test_transport_auth_marker_mismatch_fails_closed(self):
        transport_raw, _ = valid_transport_auth()
        bad_marker = ("0" * 64 + "  transcript\n").encode()
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(transport_raw=transport_raw, transport_marker=bad_marker)

    def test_transport_auth_missing_family_fails_closed(self):
        transport_raw, _ = valid_transport_auth()
        trimmed = ("\n".join(transport_raw.decode().splitlines()[:-1]) + "\n").encode()
        marker = (hashlib.sha256(trimmed).hexdigest() + "  transcript\n").encode()
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(transport_raw=trimmed, transport_marker=marker)

    def test_authority_lock_byte_substitution_fails_closed(self):
        lock_raw, lock = valid_lock()
        closeout = valid_closeout(lock_raw, lock)
        altered = lock_raw + b"\n"
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(closeout=closeout, lock_raw=altered, lock=lock)

    def test_narrow_closeout_cannot_self_claim_terminal(self):
        lock_raw, lock = valid_lock()
        closeout = valid_closeout(lock_raw, lock)
        closeout["terminal_capital_census_complete"] = True
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(closeout=closeout, lock_raw=lock_raw, lock=lock)

    def test_economic_claim_in_d11_fails_closed(self):
        lock_raw, lock = valid_lock()
        closeout = valid_closeout(lock_raw, lock)
        closeout["profitability_claimed"] = True
        with self.assertRaises(mod.TerminalCloseoutError):
            self.build(closeout=closeout, lock_raw=lock_raw, lock=lock)


if __name__ == "__main__":
    unittest.main()
