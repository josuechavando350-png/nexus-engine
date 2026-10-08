#!/usr/bin/env python3
"""Adversarial no-hindsight/no-source-mismatch tests for time-only WETH fork."""
import copy, sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import rmc015_weth_time_only_inputs as m

def report():
    data=[]
    for i,(tx,block,*_) in enumerate(m.RANKED):
        data.append({
            "rank":i+1,"winner_transaction_hash":tx,
            "winner_block_number":block,
            "winner_block_hash":"0x"+f"{block:064x}",
            "predecessor_block":{"number":block-1,
                                 "hash":"0x"+f"{block-1:064x}",
                                 "state_root":"0x"+"c"*64},
            "source_borrower_identity_sha256":"a"*64,
            "borrower":"0x"+f"{i+100:040x}",
            "account_data":{"health_factor_wad":m.EXPECTED_HEALTH_FACTORS[i]}
        })
    return {"report_sha256":"a"*64,"provider_records":[
        {"provider_id":"drpc","rows":copy.deepcopy(data)},
        {"provider_id":"blast","rows":copy.deepcopy(data)},
    ]}

def reader(url,method,params):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        match=next((i for i,(tx,block,*_) in enumerate(m.RANKED)
                    if n in (block,block-1)),None)
        if match is None:raise AssertionError("unexpected block")
        block=m.RANKED[match][1]
        return {"number":hex(n),"hash":"0x"+f"{n:064x}",
                "parentHash":"0x"+f"{n-1:064x}",
                "stateRoot":"0x"+"c"*64,
                "timestamp":hex(1700000000+match*1000+(12 if n==block else 0))}
    raise AssertionError(method)


class TimeOnlyAnchorsTests(unittest.TestCase):
    def test_proper_exact_two_provider_timestamps(self):
        r=m.assess(report(),call=reader)
        self.assertEqual(r["status"],"RMC015_REAL_TOP3_WETH_PREBLOCK_AND_WINNER_TIME_ANCHORS_PASS")
        self.assertEqual(len(r["canonical_time_anchors"]),3)
        for x in r["canonical_time_anchors"]:
            self.assertEqual(x["winning_block_timestamp"]-x["previous_block_timestamp"],12)
        for k in ("time_only_fork_execution_performed","actual_intrablock_trigger_certified",
                  "capturable_ex_ante_opportunity_proven",
                  "actual_nexus_liquidation_or_positive_pnl_proven",
                  "own_capital_zero_gas_sponsor_proven","real_market_census_closed"):
            self.assertFalse(r[k])

    def test_source_order_matters(self):
        r=report()
        r["provider_records"][0]["rows"].reverse()
        with self.assertRaises(ValueError):
            m.assess(r,call=reader)

    def test_wrong_chain_denied(self):
        def bad(url,method,params):
            return "0x2" if method=="eth_chainId" else reader(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong historic Ethereum"):
            m.assess(report(),call=bad)

    def test_wrong_prev_hash_denied(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==m.RANKED[0][1]-1:
                v["hash"]="0x"+"f"*64
            return v
        with self.assertRaisesRegex(ValueError,"identity disagreement"):
            m.assess(report(),call=bad)

    def test_wrong_parent_hash_denied(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==m.RANKED[0][1]:
                v["parentHash"]="0x"+"f"*64
            return v
        with self.assertRaisesRegex(ValueError,"identity disagreement"):
            m.assess(report(),call=bad)

    def test_wrong_state_root_denied(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if method=="eth_getBlockByNumber":v["stateRoot"]="0x"+"f"*64
            return v
        with self.assertRaises(ValueError):
            m.assess(report(),call=bad)

    def test_differing_timestamp_providers_denied(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if "blast" in url and method=="eth_getBlockByNumber":
                v["timestamp"]=hex(int(v["timestamp"],16)+1)
            return v
        with self.assertRaisesRegex(ValueError,"operators disagree"):
            m.assess(report(),call=bad)

    def test_nonmonotone_time_rejected(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if method=="eth_getBlockByNumber":
                v["timestamp"]=hex(1700000000)
            return v
        with self.assertRaisesRegex(ValueError,"ordering"):
            m.assess(report(),call=bad)

    def test_implausible_block_time_rejected(self):
        def bad(url,method,params):
            v=reader(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==m.RANKED[0][1]:
                v["timestamp"]=hex(1700000000+360)
            return v
        with self.assertRaisesRegex(ValueError,"ordering"):
            m.assess(report(),call=bad)

    def test_missing_previous_source_row_fails(self):
        r=report()
        r["provider_records"][0]["rows"][1]["predecessor_block"]["hash"]="0x"+"f"*64
        with self.assertRaises(ValueError):
            m.assess(r,call=reader)

    def test_nonindependent_operators_denied(self):
        with self.assertRaisesRegex(ValueError,"exact two independent"):
            m.assess(report(),call=reader,providers=[
                ("drpc","SAME","url1"),("blast","SAME","url2")])

    def test_result_determinism(self):
        a=m.assess(report(),call=reader)
        b=m.assess(report(),call=reader)
        self.assertEqual(a,b)
        self.assertEqual(a["report_sha256"],m.digest(m.canonical(
            {k:v for k,v in a.items() if k!="report_sha256"})))

if __name__=="__main__":
    unittest.main()
