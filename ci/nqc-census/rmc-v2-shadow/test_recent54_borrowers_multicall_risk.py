"""Canonical PR715 54-debt Borrow owners, 1-call Multicall3 source tests."""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import copy
import os
import threading
import time
import unittest

import recent54_borrowers_multicall_risk as m


B=26_299_310
BLOCK="0x"+"ab"*32
PARENT="0x"+"cd"*32
ROOT="0x"+"ef"*32
RUNTIME="0x"+"60"*3808
CODEHASH=sha256(bytes.fromhex(RUNTIME[2:])).hexdigest()


def account(i,debt=900_000_000):
    hf=10**18+(2+i%40)*10**16
    if i==0:hf=990_000_000_000_000_000
    if i==1:hf=1_015_000_000_000_000_000
    raw=[6000000000,debt,800000000,7500,7000,hf]
    return "0x"+"".join(f'{v:064x}' for v in raw)


def pack_answer(rows,bad=None,offset_bad=False):
    result=[m.base.u256(32),m.base.u256(m.N)]
    for idx in range(m.N):
        off=m.N*32+idx*m.base.RESULT3_ELEMENT_SIZE
        if offset_bad and idx==10:off+=32
        result.append(m.base.u256(off))
    for idx,row in enumerate(rows):
        result.append(m.base.u256(0 if bad==idx else 1))
        result.append(m.base.u256(64))
        result.append(m.base.u256(192))
        result.append(bytes.fromhex(row[2:]))
    return "0x"+b"".join(result).hex()


class MockChain:
    def __init__(self,owners,mode=None):
        self.owners=owners
        self.mode=mode
        self.events=[]
        self.lock=threading.Lock()
        self.header_calls={}
        self.time=int(time.time())-30
    def factory(self,provider):
        self.header_calls[provider]=0
        def serve(url,method,params):
            assert url==m.borrow.RPC_ENDPOINTS[provider]
            with self.lock:
                self.events.append((provider,method,copy.deepcopy(params)))
            if method=="eth_chainId":
                return "0x2" if self.mode=="wrongchain" and provider=="publicnode" else "0x1"
            if method=="eth_blockNumber":
                return hex(B+10) if self.mode=="tipdiff" and provider=="publicnode" else hex(B+2)
            if method=="eth_getBlockByNumber":
                assert params==[hex(B),False]
                with self.lock:
                    self.header_calls[provider]+=1
                    ordinal=self.header_calls[provider]
                bad=(self.mode=="headerdiff" and provider=="publicnode") or (
                    self.mode=="reorg" and provider=="drpc" and ordinal>1)
                return {"number":hex(B),"hash":"0x"+"ff"*32 if bad else BLOCK,
                        "parentHash":PARENT,"stateRoot":ROOT,
                        "timestamp":hex(self.time-300 if self.mode=="stale" else self.time)}
            if method=="eth_getCode":
                assert params==[
                    m.base.MULTICALL3,{"blockHash":BLOCK,"requireCanonical":True}]
                if self.mode=="nocode" and provider=="drpc":return "0x"
                if self.mode=="differentcode" and provider=="publicnode":
                    return "0x"+"61"*3808
                return RUNTIME
            if method=="eth_call":
                tx,at=params
                assert at=={"blockHash":BLOCK,"requireCanonical":True}
                if tx["to"]==m.base.MULTICALL3:
                    assert tx["data"]==m.encode_calls_54(self.owners)
                    if self.mode=="429" and provider=="publicnode":
                        raise OSError("HTTP 429")
                    values=[account(i) for i in range(m.N)]
                    if self.mode=="peer_diff" and provider=="publicnode":
                        values[15]=account(15,debt=900_000_001)
                    if self.mode=="truncated" and provider=="drpc":
                        return pack_answer(values)[:-64]
                    if self.mode=="fail_one" and provider=="drpc":
                        return pack_answer(values,bad=5)
                    return pack_answer(values)
                assert tx["to"]==m.borrow.POOL
                owner="0x"+tx["data"][-40:]
                idx=self.owners.index(owner)
                if self.mode=="control_mismatch" and provider=="drpc" and idx==27:
                    return account(idx,debt=899_999_999)
                return account(idx)
            raise AssertionError("unapproved RPC")
        return serve


class FiftyFourOldBorrowOwnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get("NQC_PR715_BORROW58_SOURCE_ZIP")
        if not path:
            raise AssertionError("set original PR715 artifact path")
        cls.raw=Path(path).read_bytes()
        cls.cohort,cls.source=m.authenticate_old_source(cls.raw)
        cls.owners=[x["borrower"] for x in cls.cohort]

    def make(self,mode=None):
        with TemporaryDirectory() as d:
            out=Path(d)
            fixture=MockChain(self.owners,mode)
            with patch.object(m,"SOURCE_MULTICALL_CODE_HASH",CODEHASH):
                report=m.collect(self.cohort,self.source,out,
                                 transport_factory=fixture.factory)
            files={x.name:x.read_bytes() for x in out.iterdir() if x.is_file()}
            return report,fixture,files

    def test_exact_original_pr715_borrow_58_source_SHA_members(self):
        self.assertEqual(sha256(self.raw).hexdigest(),m.ORIGINAL_ZIP_SHA)
        self.assertEqual(self.source["producer_commit"],m.ORIGINAL_HEAD)
        self.assertEqual(self.source["producer_tree"],m.ORIGINAL_TREE)
        self.assertEqual(self.source["producer_manifest_verified"],15)

    def test_old_54_have_debt_and_excluded_four_no_debt(self):
        self.assertEqual(len(self.cohort),54)
        self.assertEqual(len(set(self.owners)),54)
        self.assertEqual(self.source["original_Borrow_beneficiaries"],58)
        self.assertEqual(self.source["original_debt_positive_accounts"],54)
        self.assertTrue(all(int(x["source_old_total_debt_base_raw"])>0
                            for x in self.cohort))
        self.assertEqual(
            [int(x["source_old_HF_wad"]) for x in self.cohort],
            sorted(int(x["source_old_HF_wad"]) for x in self.cohort))

    def test_source_zip_mutation_must_reject_before_live_RPC(self):
        for blob in (self.raw[:-1],self.raw+b'x'):
            with self.assertRaises(m.Rejected):m.authenticate_old_source(blob)

    def test_54_source_batches_without_trimming_or_address_replacement(self):
        data=m.encode_calls_54(self.owners)
        self.assertEqual(m.base.read_word(bytes.fromhex(data[10:]),32),54)
        self.assertTrue(data.startswith(m.base.AGGREGATE3_SELECTOR))
        self.assertLess(len(data)//2,15000)
        with self.assertRaises(m.Rejected):m.encode_calls_54(self.owners[:53])
        bad=self.owners.copy()
        bad[10]=bad[9]
        with self.assertRaises(m.Rejected):m.encode_calls_54(bad)

    def test_strict_all_54_result_output_decodes_same_abi(self):
        sample=[account(i) for i in range(54)]
        self.assertEqual(m.decode_result54(pack_answer(sample)),sample)

    def test_malformed_failed_or_truncated_54_result_rejected(self):
        source=[account(i) for i in range(54)]
        for resp in (
            pack_answer(source,bad=10),
            pack_answer(source,offset_bad=True),
            pack_answer(source)[:-64],
            "0x",
        ):
            with self.assertRaises(m.Rejected):m.decode_result54(resp)

    def test_full_read_only_54_source_at_one_canonical_hash(self):
        report,fixture,files=self.make()
        self.assertEqual(report["status"],
            "FIFTYFOUR_PRIOR_DEBT_BORROWERS_MULTICALL_QUORUM_NO_P2")
        self.assertEqual(report["new_active_debt_count"],54)
        self.assertEqual(report["new_no_debt_count"],0)
        self.assertEqual(report["new_HF_below_one_count"],1)
        self.assertEqual(report["new_HF_1_to_1_02_count"],1)
        self.assertTrue(report["full_fiftyfour_EIP1898_source_parity"])
        self.assertTrue(report["one_mainnet_Multicall3_eth_call_per_source"])
        self.assertEqual(len(report["all_fiftyfour_original_borrowers"]),54)
        self.assertEqual(report["per_provider_rpc_calls"],{"drpc":11,"publicnode":11})
        self.assertIn("54-cohort-committed-before-rpc.json",files)
        self.assertEqual(report["canonical_observed_mainnet_block"]["hash"],BLOCK)

    def test_exact_one_multicall3_per_url_plus_five_direct_controls(self):
        report,fixture,_=self.make()
        batches=[(p,params) for p,meth,params in fixture.events
                 if meth=="eth_call" and params[0]["to"]==m.base.MULTICALL3]
        directs=[(p,params) for p,meth,params in fixture.events
                 if meth=="eth_call" and params[0]["to"]==m.borrow.POOL]
        self.assertEqual(len(batches),2)
        self.assertEqual(len(directs),10)
        self.assertTrue(all(params[1]=={"blockHash":BLOCK,"requireCanonical":True}
                            for _,params in batches+directs))
        self.assertEqual(
            [r["source_original_index"] for r in
             report["original_five_direct_controls"]["drpc"]],
            list(m.CHECK_INDICES))

    def test_canonical_code_hash_match_is_explicit_and_only_local_mock_override(self):
        report,_,_=self.make()
        self.assertEqual(report["multicall3_deployed_code_sha256"],CODEHASH)
        self.assertEqual(
            m.SOURCE_MULTICALL_CODE_HASH,
            "2756d7c52baee85cacb504f6ee1df7aad6809ac8d94a4a111d76991f90d36d6e")

    def test_precommit_written_before_any_RPC(self):
        with TemporaryDirectory() as d:
            out=Path(d)
            fixture=MockChain(self.owners)
            def factory(provider):
                fn=fixture.factory(provider)
                def call(url,method,params):
                    self.assertTrue((out/"54-cohort-committed-before-rpc.json").exists())
                    return fn(url,method,params)
                return call
            with patch.object(m,"SOURCE_MULTICALL_CODE_HASH",CODEHASH):
                report=m.collect(self.cohort,self.source,out,
                                 transport_factory=factory)
            self.assertEqual(report["status"],
                "FIFTYFOUR_PRIOR_DEBT_BORROWERS_MULTICALL_QUORUM_NO_P2")
            self.assertEqual(fixture.events[0][1],"eth_chainId")

    def test_no_source_429_bypass_or_market_zero(self):
        r,fixture,_=self.make("429")
        self.assertEqual(r["status"],
            "INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO")
        self.assertFalse(r["full_fiftyfour_EIP1898_source_parity"])
        self.assertNotIn("new_HF_below_one_count",r)
        self.assertTrue(r["errors"])

    def test_conflicting_peer_full_risk_ABI_censors(self):
        r,_,_=self.make("peer_diff")
        self.assertEqual(r["status"],
            "INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO")
        self.assertNotIn("new_active_debt_count",r)

    def test_direct_control_mismatch_rejected_not_trimmed(self):
        r,_,_=self.make("control_mismatch")
        self.assertEqual(r["status"],
            "INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO")
        self.assertFalse(r["full_fiftyfour_EIP1898_source_parity"])

    def test_code_mismatch_or_empty_contract_fails(self):
        for mode in ("nocode","differentcode"):
            with self.subTest(mode=mode):
                report,_,_=self.make(mode)
                self.assertEqual(report["status"],
                    "INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO")

    def test_parent_header_reorg_staleness_wrongchain_tips_censored(self):
        for mode in ("headerdiff","reorg","stale","wrongchain","tipdiff"):
            with self.subTest(mode=mode):
                r,_,_=self.make(mode)
                self.assertEqual(r["status"],
                    "INCOMPLETE_54_BORROWERS_MULTICALL_NOT_AAVE_MARKET_ZERO")
                self.assertTrue(r["errors"])

    def test_exact_five_out_of_54_controls_not_full_independent_direct_audit(self):
        r,_,_=self.make()
        self.assertEqual(len(r["original_five_direct_controls"]["publicnode"]),5)
        self.assertFalse(r["economic_liquidation_route_or_flash_funding_verified"])
        self.assertFalse(r["builder_inclusion_and_captured_opportunities_proven"])
        self.assertTrue(r["not_preinclusion_or_private_SVR_feed"])

    def test_no_trades_no_cash_no_external_execution_rights(self):
        r,_,_=self.make()
        self.assertTrue(r["eth_call_is_readonly_even_if_multicall_contract_not_view"])
        self.assertFalse(r["commercial_score_upgrade"])
        self.assertFalse(r["RMC_closed"])
        self.assertFalse(r["P2_shadow_certified"])
        self.assertFalse(r["canary_live_authorized"])
        self.assertTrue(r["OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED"])
        self.assertFalse(r["user_mxn2000_spent"])
        self.assertEqual(r["nqc_realized_pnl_usd"],"0")

    def test_bad_source_address_direct_RPC_forbidden(self):
        rpc=m.base.AllowlistedRPC("drpc",lambda *_:None)
        for method,params in (
            ("eth_sendRawTransaction",["0x1234"]),
            ("eth_getLogs",[]),
            ("eth_call",[{"to":"0x"+"ee"*20,"data":"0x"},{
                "blockHash":BLOCK,"requireCanonical":True}]),
        ):
            with self.assertRaises(m.base.Rejected):
                rpc.call(method,params)
        self.assertEqual(rpc.calls,0)


if __name__=="__main__":
    unittest.main()
