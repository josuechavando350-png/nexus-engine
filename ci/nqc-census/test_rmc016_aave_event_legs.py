#!/usr/bin/env python3
"""Adversarial ABI decoder regressions; fixtures are never economic authority."""
import copy
import json
import unittest
import rmc016_aave_event_legs as m

def log(i,debt=20,collateral=110,flag=0):
    topic=lambda value:"0x"+("0"*24)+f"{value:040x}"
    word=lambda n:f"{n:064x}"
    return {"address":m.POOL,"topics":[m.TOPIC,topic(111),topic(222),topic(333)],
            "data":"0x"+word(debt)+word(collateral)+word(444)+word(flag),
            "blockNumber":hex(m.START),"blockHash":"0x"+"a"*64,
            "transactionHash":"0x"+f"{(i if i<127 else i-127)+1:064x}",
            "transactionIndex":hex(i if i<127 else i-127),
            "logIndex":hex(i),"removed":False}
def source(logs):
    rows=[]
    for x in logs:
        out=m.decode(x)
        rows.append({"block_number":out["block_number"],"block_hash":out["block_hash"],
                     "transaction_hash":out["transaction_hash"],
                     "transaction_index":out["transaction_index"],
                     "log_index":out["log_index"],
                     "event_commitment_sha256":out["original_event_commitment_sha256"]})
    return rows

class Decoder(unittest.TestCase):
    def setUp(self):
        self.logs=[log(i,flag=i%2) for i in range(139)]
        self.records=source(self.logs)
    def test_139_events_127_transactions_match_original_proofs(self):
        decoded=m.bind_logs(self.records,b"".join(m.canon(x) for x in self.logs))
        self.assertEqual(len(decoded),139)
        self.assertEqual(len({x["transaction_hash"] for x in decoded}),127)
        self.assertEqual(sum(x["receive_a_token"] for x in decoded),69)
        self.assertEqual(decoded[0]["debt_to_cover_raw"],"20")
        self.assertEqual(decoded[0]["collateral_liquidated_raw"],"110")
        self.assertNotIn("net_pnl",decoded[0])
    def test_changed_amount_detected_even_if_log_membership_unchanged(self):
        altered=copy.deepcopy(self.logs)
        altered[0]["data"]="0x"+f"{21:064x}"+altered[0]["data"][66:]
        with self.assertRaisesRegex(ValueError,"new raw event data differs"):
            m.bind_logs(self.records,b"".join(m.canon(x) for x in altered))
    def test_fake_extra_event_rejected(self):
        with self.assertRaisesRegex(ValueError,"extra or duplicate"):
            m.bind_logs(self.records,b"".join(m.canon(x) for x in [*self.logs[:-1],self.logs[0]]))
    def test_missing_event_rejected(self):
        with self.assertRaisesRegex(ValueError,"exactly 139"):
            m.bind_logs(self.records,b"".join(m.canon(x) for x in self.logs[:-1]))
    def test_noncanonical_boolean_rejected(self):
        with self.assertRaisesRegex(ValueError,"ABI boolean"):
            m.decode(log(0,flag=2))
    def test_zero_raw_debt_rejected(self):
        with self.assertRaisesRegex(ValueError,"zero liquidation"):
            m.decode(log(0,debt=0))
    def test_zero_raw_collateral_rejected(self):
        with self.assertRaisesRegex(ValueError,"zero liquidation"):
            m.decode(log(0,collateral=0))
    def test_wrong_pool_rejected(self):
        v=log(0);v["address"]="0x"+"0"*40
        with self.assertRaisesRegex(ValueError,"wrong Aave"):
            m.decode(v)
    def test_removed_reorg_log_rejected(self):
        v=log(0);v["removed"]=True
        with self.assertRaisesRegex(ValueError,"reorg removed"):
            m.decode(v)
    def test_wrong_indexed_address_padding_rejected(self):
        v=log(0);v["topics"][1]="0x"+"f"*64
        with self.assertRaisesRegex(ValueError,"not ABI padded"):
            m.decode(v)
    def test_outside_historical_range_rejected(self):
        v=log(0);v["blockNumber"]=hex(m.END+1)
        with self.assertRaisesRegex(ValueError,"block out of window"):
            m.decode(v)

if __name__=="__main__":
    unittest.main()
