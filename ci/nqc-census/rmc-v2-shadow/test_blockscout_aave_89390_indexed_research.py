#!/usr/bin/env python3
"""Synthetic-only negative tests for Blockscout untrusted indexed Aave census."""
from copy import deepcopy
import unittest
import blockscout_aave_89390_indexed_research as m

def padded(a):return "0x"+"0"*24+a[2:]
def row(block,tx,idx,collateral,debt,debt_raw=123,collateral_raw=130):
    return {"address":m.POOL,
            "topics":[m.TOPIC,padded(collateral),padded(debt),padded("0x"+"2"*40)],
            "data":"0x"+format(debt_raw,"064x")+format(collateral_raw,"064x")+
                "0"*24+"9"*40+format(0,"064x"),
            "blockNumber":hex(block),"transactionHash":tx,
            "transactionIndex":"0x1","logIndex":hex(idx)}
def prior():
    event=row(m.RANK1_BLOCK,m.RANK1_TX,21,m.RANK1_COLLATERAL,m.RANK1_COLLATERAL,
              m.RANK1_DEBT_RAW,m.RANK1_COLLATERAL_RAW)
    event["topics"][3]=padded("0x7a0575018b57cb64434fcd794f4f0c624fd0fbd3")
    event["data"]=event["data"][:130]+"0"*24+"9e3e25dcc3ed4a97e6fdcb166280a248d8c42219"+format(0,"064x")
    rows=[event]
    for i in range(1,139):
        tx="0x"+format(1+(i-1)%126,"064x")
        rows.append(row(m.BASE_START+i,tx,i,m.RANK1_COLLATERAL,m.RANK1_COLLATERAL))
    return {"status":"1","message":"OK","result":rows}
def post(*,target=True):
    rows=[row(m.POST_START+42,"0x"+"e"*64,7,
              m.SUSDE if target else m.RANK1_COLLATERAL,
              m.USDTB if target else m.RANK1_COLLATERAL)]
    rows.append(row(m.POST_START+45,"0x"+"f"*64,8,
                    m.RANK1_COLLATERAL,m.RANK1_COLLATERAL))
    return {"status":"1","message":"OK","result":rows}

class IndexedCensusNegativeTests(unittest.TestCase):
    def valid(self,old=None,new=None):
        return m.report(prior() if old is None else old,
                        post() if new is None else new,b"original",b"post")
    def test_original_139_events_127_winner_count(self):
        rows=m.classify(prior(),m.BASE_START,m.BASE_END,require_any=True)
        self.assertEqual(len(rows),139)
        self.assertEqual(len({e["tx_hash"] for e in rows}),127)
    def test_rmc016_rank1_immutable_event_digest(self):
        indexed=m.classify(prior(),m.BASE_START,m.BASE_END,require_any=True)
        m.require_rank1(indexed)
    def test_positive_target_is_only_research_hint(self):
        d=self.valid()
        self.assertEqual(d["postwindow_indexed_stats"]["targeted_liquidation_event_count"],1)
        self.assertEqual(len(d["targeted_historical_index_hints"]),1)
        self.assertFalse(d["postwindow_canonical_block_receipts_independently_verified"])
        self.assertFalse(d["no_Nexus_realized_revenue"] is False)
        self.assertEqual(d["nqc_realized_pnl_usd"],"0")
        self.assertFalse(d["rmc_closed"])
    def test_no_target_pair_keeps_other_liquidations_not_absence(self):
        d=self.valid(new=post(target=False))
        self.assertEqual(d["postwindow_indexed_stats"]["targeted_liquidation_event_count"],0)
        self.assertEqual(d["postwindow_indexed_stats"]["total_aave_liquidation_logs_indexed"],2)
        self.assertFalse(d["indexer_full_event_completeness_certified"])
    def test_missing_rmc016_raw_winners_rejected(self):
        old=prior();old["result"]=old["result"][:-1]
        with self.assertRaisesRegex(m.Rejected,"139-event"):
            self.valid(old=old)
    def test_missing_original_rank1_rejected(self):
        old=prior()
        old["result"][0]["transactionHash"]="0x"+"a"*64
        with self.assertRaisesRegex(m.Rejected,"rank1"):
            self.valid(old=old)
    def test_corrupt_original_principal_rejected(self):
        old=prior()
        old["result"][0]["data"]="0x"+format(m.RANK1_DEBT_RAW+1,"064x")+old["result"][0]["data"][66:]
        with self.assertRaisesRegex(m.Rejected,"rank1"):
            self.valid(old=old)
    def test_empty_postwindow_not_proven_by_stubbed_indexer(self):
        with self.assertRaisesRegex(m.Rejected,"POSTWINDOW_EMPTY"):
            self.valid(new={"status":"0","message":"No logs found","result":[]})
    def test_bad_source_error_cannot_claim_zero(self):
        with self.assertRaisesRegex(m.Rejected,"provider error"):
            self.valid(new={"status":"0","message":"NOTOK","result":[]})
    def test_hidden_pagination_cap_rejected(self):
        p=post()
        p["result"]=[deepcopy(p["result"][1]) for _ in range(950)]
        with self.assertRaisesRegex(m.Rejected,"truncated"):
            m.classify(p,m.POST_START,m.POST_END)
    def test_duplicate_indexed_logs_rejected(self):
        p=post();p["result"].append(deepcopy(p["result"][0]))
        with self.assertRaisesRegex(m.Rejected,"duplicate"):
            m.classify(p,m.POST_START,m.POST_END)
    def test_outside_postwindow_block_rejected(self):
        p=post();p["result"][0]["blockNumber"]=hex(m.POST_END+1)
        with self.assertRaisesRegex(m.Rejected,"outside"):
            m.classify(p,m.POST_START,m.POST_END)
    def test_removed_transaction_hash_rejected(self):
        p=post();p["result"][0].pop("transactionHash")
        with self.assertRaisesRegex(m.Rejected,"transaction hash"):
            m.classify(p,m.POST_START,m.POST_END)
    def test_non_Aave_pool_origin_rejected(self):
        p=post();p["result"][0]["address"]=m.SUSDE
        with self.assertRaisesRegex(m.Rejected,"Pool"):
            m.classify(p,m.POST_START,m.POST_END)
    def test_indexer_omitted_blockhash_not_fabricated(self):
        d=self.valid()
        self.assertTrue(d["rank1_rest_api_omitted_block_hash"])
        self.assertFalse(d["postwindow_full_RPC_two_operator_quorum"])
    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(m.Rejected):m.strict_json('{"status":"1","status":"0"}')
    def test_bad_hex_quantity_rejected(self):
        for s in ("0x00","-1",0,"0xz"):
            with self.subTest(s=s),self.assertRaises(m.Rejected):m.qty(s,"test")

if __name__=="__main__":unittest.main()
