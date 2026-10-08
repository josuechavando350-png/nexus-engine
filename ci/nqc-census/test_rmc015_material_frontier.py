#!/usr/bin/env python3
"""Offline adversarial regressions for the D08/D09 material-risk frontier."""

import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from zipfile import ZIP_STORED, ZipFile

from rmc015_material_frontier import (
    UINT256_MAX, WAD, analyze_records, audit, canonical_bytes, debt_bucket,
    sha_path,
)

D08_COMMIT = "8" * 40
D09_COMMIT = "9" * 40
ANCHOR = "0x" + "a" * 64
BASE = 10**8


def account(i, debt, hf, classification="POSITION_HOLDER"):
    return {
        "account": "0x" + f"{i:040x}",
        "classification": classification,
        "account_data": ["0", str(debt), "0", "0", "0", str(hf)],
        "health_factor_below_one": (hf < WAD) if debt else None,
        "debt_positions": [{"asset": "0x" + "1" * 40}] if debt else [],
        "supply_positions": [{"asset": "0x" + "2" * 40}],
    }


def records():
    return [
        account(1, 2_000 * BASE, WAD - 1),
        account(2, 11_000 * BASE, WAD),
        account(3, 50_000 * BASE, 105 * WAD // 100),
        account(4, 0, UINT256_MAX),
        {"account": "0x" + f"{5:040x}", "classification": "NO_POSITION_AT_ANCHOR",
         "account_data": None, "health_factor_below_one": None, "debt_positions": [], "supply_positions": []},
    ]


METRICS = {
    "state_verified_accounts": 5,
    "actionable_accounts": 3,
    "health_factor_below_one": 1,
    "position_holders": 4,
    "debt_positions": 3,
    "supply_positions": 4,
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build_zip(path, files, commit, *, corrupt_manifest=False):
    entries = []
    for name, content in files.items():
        sha = digest(content)
        if corrupt_manifest and name.endswith("account-manifest.jsonl"):
            sha = "a" * 64
        entries.append({"path": name.split("closeout/", 1)[1], "bytes": len(content), "sha256": sha})
    manifest = canonical_bytes({"schema_version": 1, "code_commit": commit,
                                "code_tree": "b" * 40, "artifacts": entries})
    with ZipFile(path, "w", ZIP_STORED) as z:
        for name, content in files.items():
            z.writestr(name, content)
        z.writestr("closeout/evidence-manifest.json", manifest)
    return sha_path(path)


class FrontierTests(unittest.TestCase):
    def test_half_open_hf_bins(self):
        self.assertEqual(debt_bucket(WAD - 1), "UNDER_1")
        self.assertEqual(debt_bucket(WAD), "FROM_1_TO_1_01")
        self.assertEqual(debt_bucket(101 * WAD // 100), "FROM_1_01_TO_1_05")
        self.assertEqual(debt_bucket(105 * WAD // 100), "FROM_1_05_TO_1_10")
        self.assertEqual(debt_bucket(120 * WAD // 100), "FROM_1_20_TO_1_50")
        self.assertEqual(debt_bucket(UINT256_MAX), "FROM_2_AND_ABOVE")

    def test_actual_d09_funnel_semantics(self):
        r, watch = analyze_records(records(), base_unit=BASE, expected=METRICS, watchlist=True)
        self.assertEqual(r["debt_accounts"], 3)
        self.assertEqual(r["underwater_debt_base_units"], str(2_000 * BASE))
        self.assertEqual(r["total_debt_base_units"], str(63_000 * BASE))
        self.assertEqual(r["material_risk_frontier"]["account_count"], 2)
        self.assertEqual([v["account"] for v in watch], [records()[1]["account"], records()[2]["account"]])
        self.assertEqual(r["health_factor_partition"][0]["account_count"], 1)
        self.assertEqual(r["health_factor_partition"][1]["account_count"], 1)
        self.assertEqual(r["health_factor_partition"][3]["account_count"], 1)

    def test_permutation_invariant(self):
        a, watch_a = analyze_records(records(), base_unit=BASE, expected=METRICS, watchlist=True)
        b, watch_b = analyze_records(list(reversed(records())), base_unit=BASE,
                                     expected=METRICS, watchlist=True)
        self.assertEqual(canonical_bytes(a), canonical_bytes(b))
        self.assertEqual(canonical_bytes(watch_a), canonical_bytes(watch_b))

    def test_no_double_counting_or_material_zero_hf(self):
        r = records()
        r.append(r[1])
        with self.assertRaisesRegex(ValueError, "duplicate account"):
            analyze_records(r, base_unit=BASE, expected=METRICS)
        r = records()
        r[3]["account_data"][1] = str(BASE)
        with self.assertRaisesRegex(ValueError, "finite health factor"):
            analyze_records(r, base_unit=BASE, expected=METRICS)

    def test_bad_hf_annotation_and_noncanonical_amount_rejected(self):
        r = records()
        r[0]["health_factor_below_one"] = False
        with self.assertRaisesRegex(ValueError, "classification differs"):
            analyze_records(r, base_unit=BASE, expected=METRICS)
        r = records()
        r[1]["account_data"][1] = "011"
        with self.assertRaisesRegex(ValueError, "noncanonical unsigned decimal"):
            analyze_records(r, base_unit=BASE, expected=METRICS)
        r = records()
        r[1]["account_data"][1] = 11.0
        with self.assertRaisesRegex(ValueError, "noncanonical unsigned decimal"):
            analyze_records(r, base_unit=BASE, expected=METRICS)

    def test_summary_conservation_fails_closed(self):
        r = records()
        bad = dict(METRICS, health_factor_below_one=0)
        with self.assertRaisesRegex(ValueError, "unhealthy-account conservation"):
            analyze_records(r, base_unit=BASE, expected=bad)
        bad = dict(METRICS, actionable_accounts=2)
        with self.assertRaisesRegex(ValueError, "debt-account conservation"):
            analyze_records(r, base_unit=BASE, expected=bad)

    def make_fixture(self, *, bad_manifest=False, wrong_anchor=False, wrong_unit=False):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name)
        state = {"status": "RMC_008_PASS_CANDIDATE", "mismatches": 0,
                 "unexplained_mismatches": 0, "aave_oracle_rows": 1,
                 "observation_anchor": {"chain_id": 1, "block_number": 26095351,
                                        "block_hash": ANCHOR, "timestamp": 1790832215}}
        account_summary = {"status": "RMC_009_PASS_CANDIDATE", "mismatches": 0,
                           "unexplained_mismatches": 0, "anchor_timestamp": 1790832215,
                           "anchor": {"number": 26095352 if wrong_anchor else 26095351,
                                      "hash": ANCHOR}, "metrics": METRICS}
        d08files = {"closeout/state-summary.json": canonical_bytes(state),
                    "closeout/oracle-manifest.jsonl": canonical_bytes({"base_currency_unit":
                                                                         str(BASE + 1 if wrong_unit else BASE)})}
        d09files = {"closeout/account-summary.json": canonical_bytes(account_summary),
                    "closeout/account-manifest.jsonl": b"".join(canonical_bytes(x) for x in records())}
        d08 = root / "d08.zip"
        d09 = root / "d09.zip"
        sha08 = build_zip(d08, d08files, D08_COMMIT)
        sha09 = build_zip(d09, d09files, D09_COMMIT, corrupt_manifest=bad_manifest)
        return d08, d09, sha08, sha09

    def test_integrated_realistic_zip_chain(self):
        d08, d09, h08, h09 = self.make_fixture()
        r, watchlist = audit(d08, d09, h08, h09,
                             expected_d08_commit=D08_COMMIT,
                             expected_d09_commit=D09_COMMIT,
                             emit_watchlist=True)
        self.assertFalse(r["terminal_authority"])
        self.assertFalse(r["realized_profitability_proven"])
        self.assertFalse(r["retrospective_backtest_admitted"])
        self.assertEqual(r["earliest_ex_ante_evaluation_block"], 26095352)
        self.assertFalse(r["execution_or_capital_feasibility_proven"])
        self.assertEqual(r["material_risk_frontier"]["account_count"], 2)
        self.assertEqual(r["watchlist_commitment_sha256"],
                         digest(b"".join(canonical_bytes(x) for x in watchlist)))
        self.assertRegex(r["authority_commitment_sha256"], r"^[0-9a-f]{64}$")

    def test_end_anchor_selection_cannot_backtest_prior_blocks(self):
        d08, d09, h08, h09 = self.make_fixture()
        for invalid in (26095350, 26095351, True):
            with self.assertRaisesRegex(ValueError, "LOOKAHEAD"):
                audit(d08, d09, h08, h09,
                      expected_d08_commit=D08_COMMIT,
                      expected_d09_commit=D09_COMMIT,
                      evaluation_start_block=invalid)
        r, _ = audit(d08, d09, h08, h09,
                     expected_d08_commit=D08_COMMIT,
                     expected_d09_commit=D09_COMMIT,
                     evaluation_start_block=26095352)
        self.assertFalse(r["retrospective_backtest_admitted"])

    def test_wrong_zip_digest_fails_before_interpretation(self):
        d08, d09, h08, h09 = self.make_fixture()
        with self.assertRaisesRegex(ValueError, "artifact SHA-256 differs"):
            audit(d08, d09, "f" * 64, h09, expected_d08_commit=D08_COMMIT,
                  expected_d09_commit=D09_COMMIT)

    def test_tampered_internal_member_detected_even_after_zip_repin(self):
        d08, d09, h08, h09 = self.make_fixture(bad_manifest=True)
        with self.assertRaisesRegex(ValueError, "content hash mismatch"):
            audit(d08, d09, h08, h09, expected_d08_commit=D08_COMMIT,
                  expected_d09_commit=D09_COMMIT)

    def test_wrong_anchor_refuses_cross_stage_promotion(self):
        d08, d09, h08, h09 = self.make_fixture(wrong_anchor=True)
        with self.assertRaisesRegex(ValueError, "D08/D09 anchor mismatch"):
            audit(d08, d09, h08, h09, expected_d08_commit=D08_COMMIT,
                  expected_d09_commit=D09_COMMIT)

    def test_oracle_unit_is_bound_to_d08_not_hardcoded(self):
        d08, d09, h08, h09 = self.make_fixture(wrong_unit=True)
        r, _ = audit(d08, d09, h08, h09,
                     expected_d08_commit=D08_COMMIT,
                     expected_d09_commit=D09_COMMIT)
        self.assertEqual(r["oracle_base_currency_unit"], str(BASE + 1))
        self.assertEqual(r["material_risk_frontier"]["account_count"], 2)


if __name__ == "__main__":
    unittest.main()
