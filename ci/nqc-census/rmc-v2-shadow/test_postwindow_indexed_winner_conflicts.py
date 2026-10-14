#!/usr/bin/env python3
"""20+ synthetic fail-closed regressions for indexer pair activity ranking."""
from __future__ import annotations
import unittest
from copy import deepcopy
import postwindow_indexed_winner_conflicts as r

WETH="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
USDC="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
USDT="0xdac17f958d2ee523a2206206994597c13d831ec7"

def row(tx=None,idx=0,block=None,ca=WETH,db=USDC):
    return {
        "block":r.source.POST_START if block is None else block,
        "tx_hash":"0x"+"a"*64 if tx is None else tx,
        "log_index":idx,"transaction_index":0,
        "collateral_asset":ca,"debt_asset":db,
        "borrower_sha256":"a"*64,
    }

class IndexedCompetitorConflicts(unittest.TestCase):
    def test_single_event_is_one_gas_conflict(self):
        x=r.rank([row()])
        self.assertEqual(x["indexed_event_count"],1)
        self.assertEqual(x["unique_indexed_winner_tx_count"],1)
        self.assertEqual(len(x["transaction_conflict_sets"]),1)
    def test_duplicate_event_rejected(self):
        a=row()
        with self.assertRaisesRegex(r.Rejected,"duplicate"):
            r.rank([a,deepcopy(a)])
    def test_two_logs_one_tx_not_two_paid_winners(self):
        x=r.rank([row(idx=0),row(idx=1)])
        self.assertEqual(x["indexed_event_count"],2)
        self.assertEqual(x["unique_indexed_winner_tx_count"],1)
        self.assertEqual(x["winner_txs_with_multiple_events"],1)
        self.assertEqual(x["ranked_pairs"][0]["distinct_historical_winner_tx_count"],1)
    def test_two_pairs_one_transaction_still_one_conflict_set(self):
        x=r.rank([row(idx=0),row(idx=1,db=USDT)])
        self.assertEqual(x["unique_indexed_pair_count"],2)
        self.assertEqual(x["unique_indexed_winner_tx_count"],1)
        self.assertEqual(x["transaction_conflict_sets"][0]["asset_pair_count_in_same_transaction"],2)
    def test_one_tx_in_two_blocks_is_not_valid(self):
        with self.assertRaisesRegex(r.Rejected,"conflicting blocks"):
            r.rank([row(idx=0),row(idx=1,block=r.source.POST_START+1)])
    def test_rank_by_unique_tx_not_multi_logs(self):
        x=r.rank([row(idx=0),row(idx=1),row(idx=2),
                  row(tx="0x"+"b"*64,db=USDT),
                  row(tx="0x"+"c"*64,db=USDT)])
        self.assertEqual(x["ranked_pairs"][0]["debt_asset"],USDT)
        self.assertEqual(x["ranked_pairs"][0]["distinct_historical_winner_tx_count"],2)
    def test_no_events_does_not_imply_zero(self):
        with self.assertRaisesRegex(r.Rejected,"missing or capped"):
            r.rank([])
    def test_wrong_type_does_not_qualify_as_real_event(self):
        with self.assertRaisesRegex(r.Rejected,"missing or capped"):
            r.rank(None)
    def test_wrong_block_rejected(self):
        for h in (r.source.POST_START-1,r.source.POST_END+1):
            with self.subTest(h=h),self.assertRaisesRegex(r.Rejected,"outside"):
                r.rank([row(block=h)])
    def test_bad_tx_identity_rejected(self):
        a=row();a["tx_hash"]="x"
        with self.assertRaisesRegex(r.Rejected,"transaction identity"):r.rank([a])
    def test_missing_asset_rejected(self):
        a=row();a["collateral_asset"]=None
        with self.assertRaisesRegex(r.Rejected,"pair identities"):r.rank([a])
    def test_missing_borrower_commitment_rejected(self):
        a=row();a["borrower_sha256"]="bad"
        with self.assertRaisesRegex(r.Rejected,"borrower"):r.rank([a])
    def test_negative_event_log_index_rejected(self):
        a=row(idx=-1)
        with self.assertRaisesRegex(r.Rejected,"ordering"):r.rank([a])
    def test_negative_transaction_index_rejected(self):
        a=row();a["transaction_index"]=-1
        with self.assertRaisesRegex(r.Rejected,"ordering"):r.rank([a])
    def test_all_conflicts_count_gas_at_most_once(self):
        x=r.rank([row(),row(idx=1),row(tx="0x"+"b"*64)])
        self.assertTrue(all(c["winner_gas_must_be_counted_once"]
                            for c in x["transaction_conflict_sets"]))
    def test_not_realized_pnl_or_shadow_authority(self):
        x=r.rank([row()])
        self.assertFalse(x["first_month_45000_55000_net_usd_proven"])
        self.assertFalse(x["P2_shadow_certified"])
        self.assertEqual(x["nqc_realized_pnl_usd"],"0")
    def test_indexed_absence_is_not_chain_zero_proof(self):
        x=r.rank([row()])
        self.assertTrue(x["no_susde_or_usdtb_in_this_indexer_response"])
        self.assertTrue(x["not_proof_of_no_susde_or_usdtb_on_canonical_chain"])
        self.assertFalse(x["block_and_tx_receipt_independent_quorum"])
    def test_no_valuations_from_mixed_raw_token_amounts(self):
        x=r.rank([row()])
        self.assertFalse(x["price_oracle_token_decimals_gas_flash_swap_net_cost_proven"])
        self.assertTrue(x["ranked_pairs"][0]["symbolic_activity_only_not_net_pnl"])
    def test_wrong_data_type_for_artifact_rejected(self):
        with self.assertRaisesRegex(r.Rejected,"unbounded"):
            r.authenticate_archive("not bytes")
    def test_broken_original_zip_sha_rejected(self):
        with self.assertRaisesRegex(r.Rejected,"SHA256 mismatch"):
            r.authenticate_archive(b"not the historical artifact")
    def test_zero_transactions_is_not_profit(self):
        x=r.rank([row()])
        self.assertFalse(x["capturable_future_opportunities_established"])
    def test_same_frequency_ties_deterministic(self):
        a=r.rank([row(db=USDT),row(tx="0x"+"b"*64,db=USDC)])
        b=r.rank([row(tx="0x"+"b"*64,db=USDC),row(db=USDT)])
        self.assertEqual(a,b)

if __name__=="__main__":unittest.main()
