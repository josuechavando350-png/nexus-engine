#!/usr/bin/env python3
"""Adversarial offline regressions for historical source RPC probe."""
import copy
import importlib.util
import unittest
from pathlib import Path
P=Path(__file__).with_name("rmc016_probe_historical_rpc.py")
S=importlib.util.spec_from_file_location("p",P)
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)

def header(n,h):
    return {"number":hex(n),"hash":h,"parentHash":"0x"+"2"*64,
            "stateRoot":"0x"+"3"*64,"timestamp":"0x65920000"}

def sample_log():
    return {"address":M.AAVE_POOL,
            "topics":[M.LIQUIDATION_TOPIC]+["0x"+"1"*64]*3,
            "blockNumber":hex(M.END_BLOCK),
            "blockHash":M.END_HASH,
            "transactionHash":M.KNOWN_LIQUIDATION_TX,
            "logIndex":"0x0",
            "data":"0x"+"0"*256,
            "removed":False}

def receipt():
    return {"transactionHash":M.KNOWN_LIQUIDATION_TX,
            "status":"0x1","blockHash":"0x"+"4"*64,
            "gasUsed":"0x5208","effectiveGasPrice":"0x3b9aca00",
            "logs":[{"address":M.AAVE_POOL,"topics":[M.LIQUIDATION_TOPIC]}]}

def api(_url,method,params):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        if n==M.START_BLOCK:return header(n,M.START_HASH)
        if n==M.END_BLOCK:return header(n,M.END_HASH)
        raise ValueError("unexpected queried block")
    if method=="eth_getLogs":return [sample_log()]
    if method=="eth_getTransactionReceipt":return receipt()
    raise ValueError("unknown method")

class HistoricalProbe(unittest.TestCase):
    def test_known_historical_provider_admitted(self):
        r=M.probe_one(M.PROVIDERS[0],api)
        self.assertEqual(r["chain_id"],1)
        self.assertEqual(r["sampled_log_count"],1)
        self.assertEqual(r["reference_receipt"]["transaction_gas_wei"],"21000000000000")
    def test_replay_deterministic(self):
        a=M.probe_one(M.PROVIDERS[0],api)
        b=M.probe_one(M.PROVIDERS[0],api)
        self.assertEqual(M.sha256(M.canonical(a)),M.sha256(M.canonical(b)))
    def test_wrong_chain_fail(self):
        def fake(u,m,p):
            return "0x89" if m=="eth_chainId" else api(u,m,p)
        with self.assertRaisesRegex(ValueError,"wrong RPC chain"):
            M.probe_one(M.PROVIDERS[0],fake)
    def test_changed_end_hash_fail(self):
        def fake(u,m,p):
            result=api(u,m,p)
            if m=="eth_getBlockByNumber" and p[0]==hex(M.END_BLOCK):
                result["hash"]="0x"+"0"*64
            return result
        with self.assertRaisesRegex(ValueError,"historical block hash"):
            M.probe_one(M.PROVIDERS[0],fake)
    def test_noncanonical_hex_fail(self):
        for x in [0,True,"0X1","0x01","-1","1","0x"]:
            with self.assertRaises(ValueError):
                M.as_hex_quantity(x,"test")
    def test_reorg_removed_log_fail(self):
        log=sample_log();log["removed"]=True
        with self.assertRaisesRegex(ValueError,"reorg-removed"):
            M.checked_log(log,M.END_BLOCK-31,M.END_BLOCK)
    def test_wrong_topic_fail(self):
        log=sample_log();log["topics"][0]="0x"+"0"*64
        with self.assertRaisesRegex(ValueError,"unexpected LiquidationCall"):
            M.checked_log(log,M.END_BLOCK-31,M.END_BLOCK)
    def test_log_outside_window_fail(self):
        log=sample_log();log["blockNumber"]=hex(M.END_BLOCK-32)
        with self.assertRaisesRegex(ValueError,"outside requested range"):
            M.checked_log(log,M.END_BLOCK-31,M.END_BLOCK)
    def test_wrong_data_size_fail(self):
        log=sample_log();log["data"]="0x0123"
        with self.assertRaisesRegex(ValueError,"invalid LiquidationCall ABI data"):
            M.checked_log(log,M.END_BLOCK-31,M.END_BLOCK)
    def test_wrong_receipt_tx_fail(self):
        r=receipt();r["transactionHash"]="0x"+"8"*64
        with self.assertRaisesRegex(ValueError,"wrong transaction receipt"):
            M.checked_receipt(M.KNOWN_LIQUIDATION_TX,r)
    def test_reverted_receipt_fail(self):
        r=receipt();r["status"]="0x0"
        with self.assertRaisesRegex(ValueError,"reverted"):
            M.checked_receipt(M.KNOWN_LIQUIDATION_TX,r)
    def test_quorum_requires_two_operators(self):
        evidence=M.probe_one(M.PROVIDERS[0],api)
        one=[{"admitted":True,"evidence":evidence}]
        self.assertFalse(M.evaluate(one))
        clone=copy.deepcopy(evidence)
        clone["provider_id"]="alternate"
        clone["operator"]="PublicNode"
        self.assertFalse(M.evaluate([*one,{"admitted":True,"evidence":clone}]))
        clone["operator"]="IndependentProvider"
        self.assertTrue(M.evaluate([*one,{"admitted":True,"evidence":clone}]))
    def test_any_receipt_disagreement_fails_quorum(self):
        a=M.probe_one(M.PROVIDERS[0],api)
        b=copy.deepcopy(a);b["provider_id"]="other";b["operator"]="Other"
        b["reference_receipt"]["gas_used"]="1234"
        self.assertFalse(M.evaluate([{"admitted":True,"evidence":a},
                                     {"admitted":True,"evidence":b}]))
    def test_provider_rejects_failures_with_exact_method(self):
        def fail_method(u,m,p):
            if m=="eth_getLogs":raise ValueError("historical log range denied")
            return api(u,m,p)
        with self.assertRaisesRegex(ValueError,"eth_getLogs: ValueError"):
            M.probe_one(M.PROVIDERS[0],fail_method)
    def test_blockscout_is_distinct_explorer_api(self):
        p=[x for x in M.PROVIDERS if x[0]=="blockscout"]
        self.assertEqual(len(p),1)
        self.assertEqual(p[0][1],"Blockscout")
        self.assertEqual(p[0][2],"https://eth.blockscout.com/api/eth-rpc")
        self.assertEqual(len({p[0] for p in M.PROVIDERS}),len(M.PROVIDERS))
    def test_missing_provider_does_not_fake_quorum(self):
        a=M.probe_one(M.PROVIDERS[0],api)
        b={"provider_id":"blocked","admitted":False}
        self.assertFalse(M.evaluate([{"admitted":True,"evidence":a},b]))

if __name__=="__main__":
    unittest.main()
