#!/usr/bin/env python3
"""Adversarial negative proofs for historical Aave WETH borrower HF."""
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).parent))
import rmc016_rank1_preblock_health as m

HASH="0x"+"a"*64
ROOT="0x"+"b"*64
BORROWER="0x"+"c"*40


def source():
    return {
        "status":"RMC016_RANK1_SOURCE_AUTHENTICATED_PREDECESSOR_STATE_WITNESS",
        "tx":m.TX,"winning_block_number":m.BLOCK,
        "winning_block_hash":m.WINNER_HASH,
        "previous_block":{"number":m.BLOCK-1,"hash":HASH,"state_root":ROOT},
        "borrower_address_for_local_fork_only":BORROWER,
        "borrower_identity_sha256":"d"*64,
        "independent_operator_receipt_and_parent_hash_consensus":True,
        "source_selection_retrospective_from_future_winner_tx":True,
        "borrower_liquidatable_at_previous_block_proven":False,
        "nexus_realized_net_profit_proven":False,"real_market_census_closed":False,
        "report_sha256":"e"*64,
    }

def abi(hf, debt=1000, collateral=1100, threshold=8000, ltv=7000):
    words=(collateral,debt,0,threshold,ltv,hf)
    return "0x"+"".join(f"{x:064x}" for x in words)


def make_rpc(hf, debt=1000):
    def call(url,method,args):
        if method=="eth_chainId":return "0x1"
        if method=="eth_getBlockByNumber":
            assert args==[hex(m.BLOCK-1),False]
            return {"number":hex(m.BLOCK-1),"hash":HASH,"stateRoot":ROOT}
        if method=="eth_call":
            assert args==[{"to":m.AAVE_POOL,
                    "data":m.GET_ACCOUNT_DATA+BORROWER[2:].rjust(64,"0")},hex(m.BLOCK-1)]
            return abi(hf,debt)
        raise AssertionError("unexpected historical RPC")
    return call


class TestHistoricalAavePrestateHF(unittest.TestCase):
    def test_actual_threshold_below_one(self):
        result=m.assess(source(),call=make_rpc(m.WAD-1))
        self.assertEqual(result["status"],"RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_BELOW_ONE")
        self.assertTrue(result["health_factor_below_one_at_predecessor"])
        self.assertTrue(result["candidate_can_be_considered_for_preblock_fork_liquidation"])
        self.assertFalse(result["atomic_liquidation_replayed"])
        self.assertFalse(result["nexus_net_profit_proven"])
        self.assertFalse(result["real_market_census_closed"])

    def test_exact_one_not_liquidatable(self):
        result=m.assess(source(),call=make_rpc(m.WAD))
        self.assertFalse(result["candidate_can_be_considered_for_preblock_fork_liquidation"])
        self.assertEqual(result["status"],"RMC016_RANK1_PREBLOCK_HEALTH_FACTOR_NOT_BELOW_ONE")

    def test_health_factor_above_one_not_liquidatable(self):
        r=m.assess(source(),call=make_rpc(m.WAD+5000))
        self.assertFalse(r["health_factor_below_one_at_predecessor"])

    def test_wrong_chain_rejected(self):
        def other(url,method,args):
            return "0x2" if method=="eth_chainId" else make_rpc(0)(url,method,args)
        with self.assertRaisesRegex(ValueError,"wrong chain"):
            m.assess(source(),call=other)

    def test_corrupted_block_hash_rejected(self):
        def other(url,method,args):
            v=make_rpc(0)(url,method,args)
            if method=="eth_getBlockByNumber":v["hash"]="0x"+"f"*64
            return v
        with self.assertRaisesRegex(ValueError,"block hash"):
            m.assess(source(),call=other)

    def test_corrupted_state_root_rejected(self):
        def other(url,method,args):
            v=make_rpc(0)(url,method,args)
            if method=="eth_getBlockByNumber":v["stateRoot"]="0x"+"f"*64
            return v
        with self.assertRaisesRegex(ValueError,"state root"):
            m.assess(source(),call=other)

    def test_independent_operators_disagree_rejected(self):
        def other(url,method,args):
            hf=m.WAD-1 if "drpc" in url else m.WAD+1
            return make_rpc(hf)(url,method,args)
        with self.assertRaisesRegex(ValueError,"mismatch"):
            m.assess(source(),call=other)

    def test_missing_debt_rejected(self):
        with self.assertRaisesRegex(ValueError,"no debt"):
            m.assess(source(),call=make_rpc(0,debt=0))

    def test_fee_oracle_invalid_bps_rejected(self):
        for bad in (10001,11000):
            with self.assertRaisesRegex(ValueError,"invalid bps"):
                m.decode_user_account_data(abi(m.WAD-1,threshold=bad))

    def test_abi_malformed_rejected(self):
        for bad in (True,None,0,"0x","0x1","0x"+"0"*63):
            with self.subTest(data=str(bad)):
                with self.assertRaises(ValueError):
                    m.decode_user_account_data(bad)

    def test_duplicate_operators_never_consensus(self):
        with self.assertRaisesRegex(ValueError,"distinct"):
            m.assess(source(),call=make_rpc(m.WAD-1),providers=[
                ("drpc","same","drpc.invalid"),("blast","same","blast.invalid")])

    def test_no_future_oracle_or_receipt_lookahead(self):
        seen=[]
        def observer(url,method,args):
            seen.append((method,args))
            return make_rpc(m.WAD-1)(url,method,args)
        r=m.assess(source(),call=observer)
        self.assertTrue(r["source_retrospective_selection_only"])
        self.assertFalse(r["discovery_or_capture_prior_to_winner_proven"])
        self.assertEqual(sum(x[0]=="eth_call" for x in seen),2)
        self.assertFalse(any(x[0].startswith("eth_send") for x in seen))
        self.assertFalse(any(x[0]=="eth_getTransactionReceipt" for x in seen))

    def test_report_determinism(self):
        r=m.assess(source(),call=make_rpc(700000000000000000))
        self.assertEqual(r["report_sha256"],m.digest(m.canonical(
            {k:v for k,v in r.items() if k!="report_sha256"})))

if __name__=="__main__":
    unittest.main()
