#!/usr/bin/env python3
"""Adversarial source and cross-RPC tests of top-three historical WETH HF."""
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import rmc016_top3_preblock_health as m

PRE="0x"+"a"*64
ROOT="0x"+"b"*64
BORROWER="0x"+"c"*40
HFS=(m.RANK1_PREVIOUS_HF_WAD, 900000000000000000, 1100000000000000000)


def targets():
    return [{
        "rank":i+1,
        "transaction_hash":t[0],
        "winning_block_number":t[1],
        "winning_block_hash":"0x"+f"{i+1:064x}",
        "predecessor_number":t[1]-1,
        "original_receipt":{"receipt_evidence_sha256":str(i)+"e"*63},
        "original_event_list":[{}],
        "original_abi_event":{"borrower_identity_sha256":"d"*64,"log_index":0},
    } for i,t in enumerate(m.RANKED)]


def data_for_provider(provider_id,operator,*,healths=HFS):
    observations=[]
    for i,t in enumerate(m.RANKED):
        observations.append({
            "rank":i+1,"winner_transaction_hash":t[0],
            "winner_block_number":t[1],
            "winner_block_hash":"0x"+f"{i+1:064x}",
            "predecessor_block":{"number":t[1]-1,"hash":PRE,"parent_hash":"0x"+"f"*64,
                                  "state_root":ROOT},
            "source_borrower_identity_sha256":"d"*64,
            "borrower":BORROWER,
            "account_data":{"total_collateral_base":"2000","total_debt_base":"1000",
                            "available_borrows_base":"0","current_liquidation_threshold_bps":8000,
                            "ltv_bps":7000,"health_factor_wad":str(healths[i])},
            "health_factor_below_one_at_predecessor":healths[i]<m.WAD,
            "receipt_evidence_sha256":str(i)+"e"*63,
        })
    return {"provider_id":provider_id,"operator":operator,"rows":observations}


class Top3PreviousBlockTests(unittest.TestCase):
    def get(self,healths=HFS):
        def fake(provider,targets,call=None,spacing=0):
            return data_for_provider(provider[0],provider[1],healths=healths)
        with patch.object(m,"observe_provider",side_effect=fake):
            return m.assess(targets(),providers=[
                ("drpc","dRPC","a"),("blast","BlastAPI","b")])

    def test_source_anchored_three_distinct_cases(self):
        self.assertEqual(len(m.RANKED),3)
        self.assertEqual([x[0] for x in m.RANKED],[
            "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba",
            "0xb5b3f61e5a0becc1e2007d87cbea708fe40139478fac4c5eea5633b4b4beb1fb",
            "0x3c8757b8e83e098f64d88d0244709c7cdcf50ef67238e24d32357bcb679b5adb"])

    def test_one_possible_below_one_is_not_capture_proof(self):
        r=self.get()
        self.assertEqual(r["observed_predecessor_below_one_count"],1)
        self.assertEqual(r["observed_predecessor_not_below_one_count"],2)
        self.assertFalse(r["evidence_of_ex_ante_discovery_or_strategy_capture"])
        self.assertFalse(r["replayed_real_liquidation_in_preblock"])
        self.assertFalse(r["flash_principal_and_gas_externally_financed"])
        self.assertFalse(r["complete_costs_or_realized_nexus_profit_certified"])
        self.assertFalse(r["real_market_census_closed"])
        self.assertTrue(r["source_selection_uses_future_winner_knowledge"])

    def test_three_healthy_can_be_valid_observation(self):
        r=self.get((m.RANK1_PREVIOUS_HF_WAD,m.WAD,m.WAD+1))
        self.assertEqual(r["observed_predecessor_below_one_count"],0)

    def test_rank_one_previous_hf_immutable(self):
        with self.assertRaisesRegex(ValueError,"previous independently certified"):
            self.get((m.RANK1_PREVIOUS_HF_WAD+1,HFS[1],HFS[2]))

    def test_both_provider_records_must_match(self):
        def fake(provider,targets,call=None,spacing=0):
            v=data_for_provider(provider[0],provider[1])
            if provider[0]=="blast":
                v["rows"][1]["account_data"]["health_factor_wad"]=str(m.WAD+1)
            return v
        with patch.object(m,"observe_provider",side_effect=fake):
            with self.assertRaisesRegex(ValueError,"differs by RPC"):
                m.assess(targets(),providers=[("drpc","dRPC","a"),("blast","BlastAPI","b")])

    def test_duplicate_provider_rejected(self):
        with self.assertRaisesRegex(ValueError,"independent"):
            m.assess(targets(),providers=[("drpc","same","a"),("blast","same","b")])

    def test_reordered_historical_rank_not_permitted(self):
        t=targets()
        t.reverse()
        with self.assertRaisesRegex(ValueError,"not the exact"):
            m.assess(t)

    def test_aave_historical_previous_headers_are_exact(self):
        t=targets()[0]
        baseline=t["original_receipt"]
        def request(url,method,args):
            if method=="eth_chainId":return "0x1"
            if method=="eth_getBlockByNumber":
                n=int(args[0],16)
                return {"number":hex(n),"hash":t["winning_block_hash"] if n==t["winning_block_number"] else PRE,
                        "parentHash":PRE,"stateRoot":ROOT}
            if method=="eth_getTransactionReceipt":
                return {"logs":[{"address":m.AAVE_POOL,"topics":[m.LIQUIDATION_TOPIC,"0x"+"0"*64,
                  "0x"+"0"*64,"0x"+"0"*24+BORROWER[2:]],"logIndex":"0x0"}]}
            if method=="eth_call":
                return "0x"+"".join(f"{x:064x}" for x in
                      (2000,1000,0,8000,7000,m.RANK1_PREVIOUS_HF_WAD))
            raise AssertionError(method)
        with patch.object(m,"receipt_normalized",return_value=baseline),\
             patch.object(m,"decode",return_value=t["original_abi_event"]):
            r=m.observe_provider(("drpc","dRPC","x"),[t],call=request)
        self.assertEqual(r["rows"][0]["predecessor_block"]["hash"],PRE)
        self.assertFalse(r["rows"][0]["health_factor_below_one_at_predecessor"])

    def test_multiple_liquidations_match_only_exact_weth_log_index(self):
        t=targets()[0]
        other=copy.deepcopy(t)
        other["original_event_list"]=[{},{}]
        # There are two LiquidationCall logs, but the selected WETH log is
        # the one at index 0; all other event data must still be checked
        # separately by the normalized full-receipt parity gate.
        def request(url,method,args):
            if method=="eth_chainId":return "0x1"
            if method=="eth_getBlockByNumber":
                n=int(args[0],16)
                return {"number":hex(n),
                        "hash":t["winning_block_hash"] if n==t["winning_block_number"] else PRE,
                        "parentHash":PRE,"stateRoot":ROOT}
            if method=="eth_getTransactionReceipt":
                first={"address":m.AAVE_POOL,
                       "topics":[m.LIQUIDATION_TOPIC,"0x"+"0"*64,"0x"+"0"*64,
                                 "0x"+"0"*24+BORROWER[2:]],
                       "logIndex":"0x0"}
                second=copy.deepcopy(first)
                second["logIndex"]="0x1"
                return {"logs":[first,second]}
            if method=="eth_call":
                return "0x"+"".join(f"{x:064x}" for x in
                      (2000,1000,0,8000,7000,m.RANK1_PREVIOUS_HF_WAD))
            raise AssertionError(method)
        with patch.object(m,"receipt_normalized",return_value=t["original_receipt"]),\
             patch.object(m,"decode",return_value=t["original_abi_event"]):
            result=m.observe_provider(("drpc","dRPC","x"),[other],call=request)
        self.assertEqual(result["rows"][0]["borrower"],BORROWER)

    def test_wrong_parent_hash_denied(self):
        t=targets()[0]
        def request(url,method,args):
            if method=="eth_chainId":return "0x1"
            if method=="eth_getBlockByNumber":
                n=int(args[0],16)
                return {"number":hex(n),
                        "hash":t["winning_block_hash"] if n==t["winning_block_number"] else "0x"+"e"*64,
                        "parentHash":PRE,"stateRoot":ROOT}
            raise AssertionError("must fail before other calls")
        with self.assertRaisesRegex(ValueError,"canonical predecessor"):
            m.observe_provider(("drpc","dRPC","x"),[t],call=request)

    def test_malformed_target_cannot_succeed(self):
        with self.assertRaisesRegex(ValueError,"not the exact"):
            m.assess(targets()[:2],providers=[("drpc","dRPC","a"),("blast","BlastAPI","b")])

    def test_deterministic_commitment(self):
        a=self.get()
        b=self.get()
        self.assertEqual(a,b)
        self.assertEqual(a["report_sha256"],m.digest(m.canonical({k:v for k,v in a.items() if k!="report_sha256"})))

if __name__=="__main__":
    unittest.main()
