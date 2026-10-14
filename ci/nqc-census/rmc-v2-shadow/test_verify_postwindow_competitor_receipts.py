#!/usr/bin/env python3
"""Negative synthetic tests of exact historical Aave receipt witness; no network."""
from __future__ import annotations
from copy import deepcopy
from unittest.mock import patch
import unittest

import verify_postwindow_competitor_receipts as m

HASH="0x"+"a"*64
PARENT="0x"+"b"*64
ROOT="0x"+"c"*64

def log(pin):
    word=lambda n:format(n,"064x")
    return {
      "address":m.source.POOL,
      "topics":[m.source.TOPIC,
                "0x"+"0"*24+pin["collateral"][2:],
                "0x"+"0"*24+pin["debt"][2:],
                "0x"+"0"*24+"e"*40],
      "data":"0x"+word(1_000_000_000)+word(2_000_000_000)+
              ("0"*24+"d"*40)+word(0),
      "blockNumber":hex(pin["block"]),
      "transactionHash":pin["tx"],
      "transactionIndex":"0x1",
      "logIndex":hex(pin["log_index"]),
      "blockHash":HASH,
      "removed":False,
    }

def source_row(pin):
    return m.source.normalize(log(pin),pin["block"],pin["block"])

def header(block):
    return {"number":hex(block),"hash":HASH,
            "parentHash":PARENT,"stateRoot":ROOT,
            "timestamp":"0x65000001"}

def receipt(pin):
    return {"transactionHash":pin["tx"],"blockNumber":hex(pin["block"]),
            "blockHash":HASH,"status":"0x1",
            "transactionIndex":"0x1",
            "gasUsed":"0x1e8480",
            "effectiveGasPrice":"0x3b9aca00",
            "logs":[log(pin)]}

class Fake:
    def __init__(self):
        self.logs={p["tx"]:receipt(p) for p in m.PINS}
        self.blocks={p["block"]:header(p["block"]) for p in m.PINS}
        self.bad_headers=set()
        self.bad_chain=set()
        self.bad_receipts=set()
        self.tamper_blast=False
        self.calls=[]
    def __call__(self,url,method,params):
        provider=next(k for k,v in m.PROVIDERS.items() if v[1]==url)
        self.calls.append((provider,method))
        if method=="eth_chainId":
            return "0x2" if provider in self.bad_chain else "0x1"
        if method=="eth_getBlockByNumber":
            return self.blocks[int(params[0],16)]
        if method=="eth_getTransactionReceipt":
            if provider in self.bad_receipts:return None
            d=deepcopy(self.logs[params[0]])
            if self.tamper_blast and provider=="blast":
                d["effectiveGasPrice"]="0x3b9aca01"
            return d
        raise AssertionError("Forbidden RPC method "+method)

class HistoricalReceiptPositiveGates(unittest.TestCase):
    def setUp(self):
        self.p=m.PINS[0]
        self.log=log(self.p)
        self.row=source_row(self.p)
        self.head=m.header(header(self.p["block"]),self.p["block"])
    def test_signed_transaction_methods_absent(self):
        for x in ("eth_sendRawTransaction","eth_sendTransaction",
                  "personal_sign","eth_sign"):
            self.assertNotIn(x,m.ALLOWED)
            with self.assertRaisesRegex(m.Rejected,"non-read-only"):
                m.RPC("drpc",Fake()).call(x,[])
    def test_two_fixed_positive_fixture_selections(self):
        a=m.expected_events([source_row(p) for p in m.PINS])
        self.assertEqual(len(a),2)
    def test_missing_positive_control_rejected(self):
        with self.assertRaisesRegex(m.Rejected,"not unique"):
            m.expected_events([self.row])
    def test_spoofed_event_pair_rejected(self):
        c=deepcopy(self.row);c["debt_asset"]=m.USDT
        with self.assertRaisesRegex(m.Rejected,"not unique"):
            m.expected_events([c,source_row(m.PINS[1])])
    def test_valid_receipt_matches_exact_indexed_raw_abi(self):
        w=m.verify_receipt(receipt(self.p),self.head,self.p,self.row)
        self.assertTrue(w["receipt_event_identity_matches"])
        self.assertEqual(w["realized_Nexus_revenue_from_this_tx"],"0")
    def test_successful_two_rpc_mock_never_certifies_trading(self):
        f=Fake()
        with patch.object(m.indexed,"authenticate_archive",
                          return_value=[source_row(p) for p in m.PINS]):
            r=m.run(b"ignored-for-synthetic",transport=f)
        self.assertEqual(r["status"],
                         "TWO_PUBLIC_RPC_HISTORICAL_RECEIPT_PARITY_NO_NEXUS_CAPTURE")
        self.assertEqual(len(r["historical_receipt_witnesses"]),2)
        self.assertFalse(r["P2_shadow_certified"])
        self.assertFalse(r["RMC_closed"])
        self.assertEqual(r["nqc_realized_pnl_usd"],"0")
        self.assertTrue(set(x for _,x in f.calls)<=m.ALLOWED)
    def test_wrong_provider_chain_fails(self):
        f=Fake();f.bad_chain.add("blast")
        with patch.object(m.indexed,"authenticate_archive",
                          return_value=[source_row(p) for p in m.PINS]):
            with self.assertRaisesRegex(m.Rejected,"not Ethereum"):
                m.run(b"mock",transport=f)
    def test_public_source_discrepancy_rejected(self):
        f=Fake();f.tamper_blast=True
        with patch.object(m.indexed,"authenticate_archive",
                          return_value=[source_row(p) for p in m.PINS]):
            with self.assertRaisesRegex(m.Rejected,"disagree"):
                m.run(b"mock",transport=f)
    def test_missing_receipt_rejected(self):
        with self.assertRaisesRegex(m.Rejected,"missing Ethereum"):
            m.verify_receipt(None,self.head,self.p,self.row)
    def test_wrong_transaction_hash_rejected(self):
        d=receipt(self.p);d["transactionHash"]="0x"+"f"*64
        with self.assertRaisesRegex(m.Rejected,"transaction hash"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_wrong_block_hash_rejected(self):
        d=receipt(self.p);d["blockHash"]="0x"+"f"*64
        with self.assertRaisesRegex(m.Rejected,"canonical header"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_failed_winner_transaction_rejected(self):
        d=receipt(self.p);d["status"]="0x0"
        with self.assertRaisesRegex(m.Rejected,"reverted"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_wrong_log_index_rejected(self):
        d=receipt(self.p);d["logs"][0]["logIndex"]="0xfff"
        with self.assertRaisesRegex(m.Rejected,"absent/duplicated"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_log_payload_modified_rejected(self):
        d=receipt(self.p);d["logs"][0]["data"]=d["logs"][0]["data"][:-1]+"1"
        with self.assertRaisesRegex(m.Rejected,"raw ABI mismatch"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_log_topics_modified_rejected(self):
        d=receipt(self.p);d["logs"][0]["topics"][2]="0x"+"0"*24+m.USDT[2:]
        with self.assertRaisesRegex(m.Rejected,"raw ABI mismatch"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_receipt_gas_must_be_positive(self):
        d=receipt(self.p);d["gasUsed"]="0x0"
        with self.assertRaisesRegex(m.Rejected,"gas accounting"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_removed_log_never_admitted(self):
        d=receipt(self.p);d["logs"][0]["removed"]=True
        with self.assertRaisesRegex(m.Rejected,"removed"):
            m.verify_receipt(d,self.head,self.p,self.row)
    def test_block_state_root_required(self):
        d=header(self.p["block"]);d.pop("stateRoot")
        with self.assertRaisesRegex(m.Rejected,"state root"):
            m.header(d,self.p["block"])
    def test_wrong_height_header_rejected(self):
        d=header(self.p["block"]);d["number"]=hex(self.p["block"]+1)
        with self.assertRaisesRegex(m.Rejected,"height"):
            m.header(d,self.p["block"])
    def test_cannot_use_duplicate_providers(self):
        with self.assertRaisesRegex(m.Rejected,"distinct"):
            m.run(b"mock",provider_ids=("drpc","drpc"))
    def test_single_provider_cannot_be_dual_quorum(self):
        with self.assertRaisesRegex(m.Rejected,"distinct"):
            m.run(b"mock",provider_ids=("drpc",))
    def test_canonical_integer_format_no_float(self):
        with self.assertRaisesRegex(m.Rejected,"hex quantity"):
            m.qty("0x00","gas")
    def test_rpc_request_budget_enforced(self):
        r=m.RPC("drpc",Fake())
        for _ in range(12):r.call("eth_chainId",[])
        with self.assertRaisesRegex(m.Rejected,"budget"):
            r.call("eth_chainId",[])

if __name__=="__main__":unittest.main()
