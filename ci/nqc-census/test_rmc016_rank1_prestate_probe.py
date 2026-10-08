#!/usr/bin/env python3
"""Negative and deterministic tests for historical top WETH successor receipt."""
from __future__ import annotations
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parent))
import rmc016_rank1_prestate_probe as m

PARENT="0x"+"a"*64
ROOT="0x"+"b"*64
BORROWER="0x"+"c"*40

def datum():
    baseline={
        "block_number":m.BLOCK,"block_hash":m.WINNER_HASH,
        "total_gas_paid_wei":str(m.HISTORICAL_COMPETITOR_GAS),
        "receipt_evidence_sha256":"e"*64,
    }
    decoded={
        "transaction_hash":m.TX,"block_number":m.BLOCK,"block_hash":m.WINNER_HASH,
        "debt_to_cover_raw":str(m.PRINCIPAL),
        "collateral_asset":m.WETH,"debt_asset":m.WETH,
        "receive_a_token":False,
        "borrower_identity_sha256":"d"*64,
        "original_event_commitment_sha256":"f"*64,
    }
    return baseline,decoded

def call(url,method,params):
    if method=="eth_chainId": return "0x1"
    if method=="eth_getBlockByNumber":
        block=int(params[0],16)
        if block==m.BLOCK:
            return {"number":hex(block),"hash":m.WINNER_HASH,
                    "parentHash":PARENT,"stateRoot":ROOT}
        if block==m.BLOCK-1:
            return {"number":hex(block),"hash":PARENT,
                    "parentHash":"0x"+"1"*64,"stateRoot":ROOT}
        raise AssertionError("wrong block query")
    if method=="eth_getTransactionReceipt":
        assert params==[m.TX]
        return {"logs":[{
            "address":m.AAVE_POOL,"topics":[m.LIQUIDATION_TOPIC,
                  "0x"+"0"*24+m.WETH[2:],"0x"+"0"*24+m.WETH[2:],
                  "0x"+"0"*24+BORROWER[2:]],
        }]}
    raise AssertionError("unexpected method")

class HistoricalRankOnePrestateTests(unittest.TestCase):
    def good(self,req=call,decoded=None,baseline=None):
        expected,actual=datum()
        if decoded is not None: actual=decoded
        if baseline is not None: expected=baseline
        with patch.object(m,"receipt_normalized",return_value=expected),patch.object(
                m,"decode",return_value=actual):
            return m.verify_one(("drpc","dRPC","drpc.invalid"),expected,[{}],actual,call=req)

    def test_pinned_predecessor_without_hindsight_promotion(self):
        result=self.good()
        self.assertEqual(result["predecessor_block"]["number"],m.BLOCK-1)
        self.assertEqual(result["predecessor_block"]["hash"],PARENT)
        self.assertEqual(result["borrower"],BORROWER)
        self.assertEqual(result["winning_block"]["hash"],m.WINNER_HASH)

    def test_wrong_chain_fails(self):
        def fake(url,method,params):return "0x2" if method=="eth_chainId" else call(url,method,params)
        with self.assertRaisesRegex(ValueError,"non-Ethereum"):self.good(req=fake)

    def test_false_winner_block_hash_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==m.BLOCK:
                x["hash"]="0x"+"d"*64
            return x
        with self.assertRaisesRegex(ValueError,"winner block reorg"):self.good(req=fake)

    def test_nonparent_historical_prestate_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==m.BLOCK-1:
                x["hash"]="0x"+"d"*64
            return x
        with self.assertRaisesRegex(ValueError,"canonical parent"):self.good(req=fake)

    def test_invalid_state_root_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getBlockByNumber":x["stateRoot"]="0x12"
            return x
        with self.assertRaisesRegex(ValueError,"stateRoot"):self.good(req=fake)

    def test_wrong_receipt_identity_fails(self):
        fake_receipt=datum()[0]
        fake_receipt["receipt_evidence_sha256"]="a"*64
        with patch.object(m,"receipt_normalized",return_value=fake_receipt),patch.object(
                m,"decode",return_value=datum()[1]):
            with self.assertRaisesRegex(ValueError,"independent raw receipt"):
                m.verify_one(("drpc","dRPC","url"),datum()[0],[{}],datum()[1],call=call)

    def test_raw_amount_tamper_fails(self):
        fake=datum()[1]
        fake["debt_to_cover_raw"]=str(m.PRINCIPAL+1)
        with patch.object(m,"receipt_normalized",return_value=datum()[0]),patch.object(
                m,"decode",return_value=fake):
            with self.assertRaisesRegex(ValueError,"raw ABI event"):
                m.verify_one(("drpc","dRPC","url"),datum()[0],[{}],datum()[1],call=call)

    def test_missing_aave_liquidation_log_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getTransactionReceipt":x["logs"]=[]
            return x
        with self.assertRaisesRegex(ValueError,"log cardinality"):self.good(req=fake)

    def test_duplicate_aave_liquidation_event_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getTransactionReceipt":x["logs"].append(copy.deepcopy(x["logs"][0]))
            return x
        with self.assertRaisesRegex(ValueError,"log cardinality"):self.good(req=fake)

    def test_independent_providers_witness_cryptographic_parity(self):
        baseline,decoded=datum()
        with patch.object(m,"authenticated_target",return_value=(baseline,[{}],decoded)),\
             patch.object(m,"receipt_normalized",return_value=baseline),\
             patch.object(m,"decode",return_value=decoded):
            r=m.assess(None,None,None,call=call,providers=[
                ("drpc","dRPC","https://drpc.invalid"),
                ("blast","BlastAPI","https://blast.invalid")])
        self.assertTrue(r["independent_operator_receipt_and_parent_hash_consensus"])
        self.assertTrue(r["source_selection_retrospective_from_future_winner_tx"])
        self.assertFalse(r["borrower_liquidatable_at_previous_block_proven"])
        self.assertFalse(r["nexus_realized_net_profit_proven"])
        self.assertFalse(r["real_market_census_closed"])

    def test_no_pseudo_independent_operators(self):
        baseline,decoded=datum()
        with patch.object(m,"authenticated_target",return_value=(baseline,[{}],decoded)):
            with self.assertRaisesRegex(ValueError,"two independent"):
                m.assess(None,None,None,call=call,providers=[
                    ("drpc","ONE","url1"),("blast","ONE","url2")])

    def test_wrong_borrower_topic_fails(self):
        def fake(url,method,params):
            x=call(url,method,params)
            if method=="eth_getTransactionReceipt":
                x["logs"][0]["topics"][3]="0x"+"0"*64
            return x
        with self.assertRaisesRegex(ValueError,"borrower identity invalid"):self.good(req=fake)

    def test_source_identity_is_one_exact_historical_tx(self):
        self.assertEqual(m.TX,"0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba")
        self.assertEqual(m.BLOCK,25938048)
        self.assertTrue(m.PRINCIPAL>10**18)
        self.assertTrue(m.AFTER_COMPETITOR_GAS>0)

if __name__=="__main__":
    unittest.main()
