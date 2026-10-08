#!/usr/bin/env python3
"""Offline adversarial fixtures for non-authoritative WETH gas reference."""
import importlib.util,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).with_name("rmc016_preblock_gas_oracle_batch.py")
S=importlib.util.spec_from_file_location("price_batch",P)
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)
FIRST=25883783
PRE_HASH="0xec6d981a5ac384d99a0753bfe5c914529a691a969fe66484da0a7793781a40bd"
def source():
    blocks=[FIRST]+[FIRST+10*i for i in range(1,123)]
    by={n:[{"transaction_hash":"0x"+f"{i+1:064x}",
            "total_gas_paid_wei":"1000000000000000"}] for i,n in enumerate(blocks)}
    return by,blocks,{"25883782":{"block_hash":PRE_HASH,"price_raw":"243398000000"}}
def call(url,method,params):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        return {"number":hex(n),"hash":PRE_HASH if n==FIRST-1 else "0x"+f"{n:064x}"}
    if method=="eth_call":
        n=int(params[1],16)
        price=243398000000 if n==FIRST-1 else 250000000000+(n%100)
        return "0x"+f"{price:064x}"
    raise RuntimeError("unexpected method")
class TestPriceBatch(unittest.TestCase):
    def runit(self,callfn=call,**params):
        with patch.object(M,"src",return_value=source()):
            return M.acquire(Path("x"),Path("y"),Path("z"),request=callfn,
                             spacing=0,**params)
    def test_five_blocks_reconciled(self):
        r=self.runit()
        self.assertEqual(r["status"],"RMC016_DUAL_OPERATOR_PREBLOCK_GAS_REFERENCE_PASS")
        self.assertTrue(r["two_provider_consensus"])
        self.assertEqual(r["verified_blocks"],5)
        self.assertEqual(r["prices"][0]["preblock_gas_usd_wad_reference"],"2433980000000000000")
        self.assertFalse(r["exact_pre_tx_state_proven"])
        self.assertFalse(r["nexus_net_profit_proven"])
        self.assertFalse(r["real_market_census_closed"])
    def test_deterministic_commitment(self):
        self.assertEqual(self.runit()["commitment_sha256"],self.runit()["commitment_sha256"])
    def test_wrong_chain_denied(self):
        def fake(u,m,p):return "0x2" if m=="eth_chainId" else call(u,m,p)
        r=self.runit(fake)
        self.assertFalse(r["two_provider_consensus"])
        self.assertIn("wrong chain",r["error"])
    def test_provider_mismatch_denied(self):
        def fake(u,m,p):
            if m=="eth_call" and "blastapi" in u and int(p[1],16)!=FIRST-1:
                return "0x"+f"{int(call(u,m,p),16)+1:064x}"
            return call(u,m,p)
        self.assertIn("cross-operator",self.runit(fake)["error"])
    def test_original_first_historical_sample_cannot_be_changed(self):
        def fake(u,m,p):
            if m=="eth_call" and int(p[1],16)==FIRST-1:return "0x"+f"{243398000001:064x}"
            return call(u,m,p)
        self.assertIn("previous immutable oracle sample",self.runit(fake)["error"])
    def test_false_historical_hash_denied(self):
        def fake(u,m,p):
            z=call(u,m,p)
            if m=="eth_getBlockByNumber" and int(p[0],16)==FIRST-1:
                return {**z,"hash":"0x"+"e"*64}
            return z
        self.assertIn("previous immutable oracle sample",self.runit(fake)["error"])
    def test_invalid_uint_return(self):
        for value in (False,None,1,"0x1","0x"+"0"*64):
            with self.assertRaises(ValueError):M.normalize_result(value)
    def test_out_of_range_offsets(self):
        for args in ({"offset":-1},{"offset":120,"count":5},
                     {"count":6},{"count":0},{"count":True}):
            with self.assertRaises(ValueError):self.runit(**args)
    def test_sixth_tx_never_in_first_batch(self):
        r=self.runit()
        self.assertEqual(r["requested_blocks"],source()[1][:5])
        self.assertEqual(len(r["prices"]),5)
    def test_failed_rpc_stays_unproven(self):
        def fake(u,m,p):
            if m=="eth_call":raise ValueError("429 Too Many Requests")
            return call(u,m,p)
        r=self.runit(fake)
        self.assertEqual(r["status"],"RMC016_PREBLOCK_GAS_REFERENCE_BLOCKED")
        self.assertFalse(r["complete_historical_gas_usd_proven"])
        self.assertFalse(r["nexus_gas_funding_proven"])
    def test_no_pnl_from_reference(self):
        r=self.runit()
        self.assertNotIn("net_pnl_usd",r)
        self.assertTrue(all(x["pre_transaction_price_certified"] is False for x in r["prices"]))
    def test_bad_spacing_denied(self):
        with self.assertRaises(ValueError):self.runit(spacing=25)
if __name__=="__main__":unittest.main()
