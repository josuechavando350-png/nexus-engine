#!/usr/bin/env python3
"""Adversarial offline regression of seven-winner historical WETH/WETH cost budget."""
from __future__ import annotations

import copy
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import rmc016_weth_cashflow_audit as m


def corpus():
    ids = list(m.TOP_TWO) + ["0x" + f"{n:064x}" for n in range(10, 135)]
    assert len(ids) == 127 and len(set(ids)) == 127
    rows, receipt = [], {}
    for i, tx in enumerate(ids):
        block = 25938048 if i == 0 else (26071849 if i == 1 else 25890000 + i)
        hashval = "0x" + f"{block:064x}"
        if i < 2:
            debt, gas, after = m.HISTORICAL_EXPECTED[i]
        else:
            debt, gas, after = 10**18, 10**14, (7 - i) * 10**12
        collateral = debt + gas + after
        receipt[tx] = {"block_number": block, "block_hash": hashval,
                       "total_gas_paid_wei": str(gas)}
        r = {"transaction_hash": tx, "block_number": block, "block_hash": hashval,
             "log_index": i, "transaction_index": 0,
             "collateral_asset": m.WETH if i < 7 else "0x" + "a" * 40,
             "debt_asset": m.WETH if i < 7 else "0x" + "b" * 40,
             "debt_to_cover_raw": str(debt),
             "collateral_liquidated_raw": str(collateral),
             "receive_a_token": False,
             "original_event_commitment_sha256": "a" * 64}
        rows.append(r)
        if 7 <= i < 19:
            more = r.copy()
            more["log_index"] = 1000 + i
            rows.append(more)
    assert len(rows) == 139
    prices = []
    for i, tx in enumerate(m.TOP_TWO):
        r = receipt[tx]
        prices.append({
            "transaction_hash": tx, "block_number": r["block_number"],
            "historical_winner_gas_wei": r["total_gas_paid_wei"],
            "two_operator_preblock_oracle_consensus": True,
            "exact_transaction_prestate_proven": False,
            "preblock": {
                "block": r["block_number"] - 1,
                "hash": "0x" + "c" * 64,
                "oracle_usd_base_1e8": ["250480170000", "268440000000"][i]},
            "block_end": {
                "block": r["block_number"], "hash": r["block_hash"],
                "oracle_usd_base_1e8": ["250480170000", "267072741547"][i]}})
    return rows, receipt, prices


class HistoricalWethAuditTest(unittest.TestCase):
    def test_seven_rows_and_two_historical_prices(self):
        rows, receipts, prices = corpus()
        answer = m.calculate(rows, receipts, prices)
        self.assertEqual(len(answer), 7)
        self.assertEqual([r["transaction_hash"] for r in answer[:2]], list(m.TOP_TWO))
        self.assertEqual(int(answer[0]["collateral_minus_debt_minus_winner_gas_wei"]),
                         96136430295441074)
        self.assertTrue(answer[0]["fully_executable_by_nexus"] is False)
        self.assertTrue(answer[0]["historical_competitor_gas_not_nexus_gas"])
        self.assertTrue(answer[0]["historical_preblock_price_not_transaction_prestate"])
        combined = sum(int(x["preblock_usd_wad_conditional_cost_budget"]) for x in answer[:2])
        self.assertTrue(329 * m.WEI < combined < 332 * m.WEI)

    def test_five_basis_point_ceiling_is_conservative(self):
        rows, receipts, prices = corpus()
        answer = m.calculate(rows, receipts, prices)
        debt = m.HISTORICAL_EXPECTED[0][0]
        self.assertEqual(int(answer[0]["hypothetical_5bps_flash_premium_wei_ceil"]),
                         (debt * 5 + 9999) // 10000)

    def test_full_transaction_gas_instead_of_per_log_allocation(self):
        rows, receipts, prices = corpus()
        answer = m.calculate(rows, receipts, prices)
        self.assertEqual(answer[0]["winner_full_tx_gas_wei"],
                         str(m.HISTORICAL_EXPECTED[0][1]))

    def test_receive_atoken_requires_collateral_exit_proof(self):
        rows, receipts, prices = corpus()
        rows[0]["receive_a_token"] = True
        answer = m.calculate(rows, receipts, prices)
        self.assertTrue(answer[0]["direct_liquid_weth_collateral_unproven"])

    def test_missing_or_extra_weth_candidate_rejected(self):
        rows, receipts, prices = corpus()
        rows[6]["debt_asset"] = "0x" + "e" * 40
        with self.assertRaisesRegex(ValueError, "exactly seven"):
            m.calculate(rows, receipts, prices)

    def test_missing_receipt_rejected(self):
        rows, receipts, prices = corpus()
        del receipts[rows[0]["transaction_hash"]]
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_retroactive_winner_selection_cannot_change(self):
        rows, receipts, prices = corpus()
        rows[4]["collateral_liquidated_raw"] = str(100 * m.WEI)
        with self.assertRaisesRegex(ValueError, "retrospective top-two"):
            m.calculate(rows, receipts, prices)

    def test_false_two_operator_claim_rejected(self):
        rows, receipts, prices = corpus()
        prices[0]["two_operator_preblock_oracle_consensus"] = False
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_wrong_transaction_end_hash_rejected(self):
        rows, receipts, prices = corpus()
        prices[0]["block_end"]["hash"] = "0x" + "f" * 64
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_lookahead_transaction_prestate_claim_rejected(self):
        rows, receipts, prices = corpus()
        prices[0]["exact_transaction_prestate_proven"] = True
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_missing_or_duplicated_oracle_reference_rejected(self):
        rows, receipts, prices = corpus()
        prices[1]["transaction_hash"] = prices[0]["transaction_hash"]
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_different_historical_winner_gas_rejected(self):
        rows, receipts, prices = corpus()
        prices[1]["historical_winner_gas_wei"] = "0"
        with self.assertRaises(ValueError):
            m.calculate(rows, receipts, prices)

    def test_original_historical_raw_amounts_cannot_drift(self):
        rows, receipts, prices = corpus()
        rows[0]["debt_to_cover_raw"] = str(m.HISTORICAL_EXPECTED[0][0] + 1)
        with self.assertRaisesRegex(ValueError, "source quantities disagree"):
            m.calculate(rows, receipts, prices)

    def test_malformed_integer_and_negative_usd_reference(self):
        for bad in (True, 1, "-1", "+1", "01", "1.0", "1e8", None):
            with self.assertRaises(ValueError):
                m.uint(bad, "cost")
        self.assertEqual(m.signed_usd_wad(-m.WEI, "250000000000"), -2500*m.WEI)

    def test_duplicate_json_key_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            m.unique_json(b'{"x":1,"x":2}')

    def test_raw_event_conservation_and_mutation(self):
        rows, _, _ = corpus()
        original = {}
        for r in rows:
            original.setdefault(r["transaction_hash"], []).append({
                "block_hash": r["block_hash"], "log_index": r["log_index"],
                "block_number": r["block_number"], "transaction_index": r["transaction_index"],
                "event_commitment_sha256": "a" * 64,
            })
        ids = list(original)
        raw = b"".join(m.canonical(x) for x in rows)
        report = {"status": "RMC016_SINGLE_OPERATOR_REAL_INTEGER_LIQUIDATION_LEGS_SOURCE_MATCH",
                  "events": 139, "unique_winner_transactions": 127,
                  "event_rows_sha256": m.digest(raw),
                  "nexus_net_profitability_proven": False}
        self.assertEqual(len(m.reconcile_legs(original, ids, raw, report)), 139)
        altered = copy.deepcopy(rows)
        altered[0]["debt_to_cover_raw"] = "0"
        with self.assertRaises(ValueError):
            m.reconcile_legs(original, ids, b"".join(m.canonical(x) for x in altered), report)
        duplicate = copy.deepcopy(rows)
        duplicate[1] = duplicate[0]
        with self.assertRaises(ValueError):
            m.reconcile_legs(original, ids, b"".join(m.canonical(x) for x in duplicate), report)

    def test_duplicate_archive_members_and_modified_checksum_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "fixture.zip"
            def write(manifest, duplicate=False):
                with zipfile.ZipFile(path, "w") as z:
                    z.writestr("datum.json", b'{"n":1}\n')
                    z.writestr("archive.sha256", manifest)
                    if duplicate:
                        import warnings
                        with warnings.catch_warnings():
                            warnings.simplefilter("ignore", UserWarning)
                            z.writestr("datum.json", b'{"n":2}\n')
            right = m.digest(b'{"n":1}\n') + "  datum.json\n"
            write(right)
            self.assertEqual(
                m.authenticated_zip(path, m.digest(path.read_bytes()), {"datum.json"})["datum.json"],
                b'{"n":1}\n')
            write("0"*64 + "  datum.json\n")
            with self.assertRaisesRegex(ValueError, "manifest drift"):
                m.authenticated_zip(path, m.digest(path.read_bytes()), {"datum.json"})
            write(right, duplicate=True)
            with self.assertRaisesRegex(ValueError, "duplicate ZIP"):
                m.authenticated_zip(path, m.digest(path.read_bytes()), {"datum.json"})

    def test_deterministic_order_independent_source_rows(self):
        rows, receipts, prices = corpus()
        result = m.calculate(rows, receipts, prices)
        self.assertEqual(result, m.calculate(list(reversed(rows)), receipts,
                                             list(reversed(prices))))


if __name__ == "__main__":
    unittest.main()
