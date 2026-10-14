"""Authentic PR729 source and strict Multicall3 nine-subcall Aave AB/BA tests."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest

import public_aave_multicall3_exact9_parity as m

B=26_299_270
H="0x"+"ab"*32
P="0x"+"cd"*32
ROOT="0x"+"ef"*32
RUNTIME="0x"+"6001600055"*100


def risk(idx):
    debt=5_000_000_000+idx
    hf=10**18+(10+idx)*10**15
    return "0x"+"".join(f'{v:064x}' for v in (
        10_000_000_000,debt,2_000_000_000,8000,7300,hf))


def result_abi(values,*,failed=None,broken_offset=False):
    assert len(values)==m.N
    result=[m.u256(32),m.u256(m.N)]
    for i in range(m.N):
        offset=m.N*32+i*m.RESULT3_ELEMENT_SIZE
        if broken_offset and i==1:
            offset+=32
        result.append(m.u256(offset))
    for i,word in enumerate(values):
        result.append(m.u256(0 if failed==i else 1))
        result.append(m.u256(64))
        result.append(m.u256(192))
        assert len(bytes.fromhex(word[2:]))==192
        result.append(bytes.fromhex(word[2:]))
    return "0x"+b"".join(result).hex()


class FakeChain:
    def __init__(self,cohort,mode=None):
        self.cohort=cohort
        self.index={x["borrower"]:i for i,x in enumerate(cohort)}
        self.mode=mode
        self.calls=[]
        self.guard=threading.Lock()
        self.header_reads={"drpc":0,"publicnode":0}
        self.when=int(time.time())-30

    def factory(self,provider):
        def send(url,method,params):
            assert url==m.borrow.RPC_ENDPOINTS[provider]
            with self.guard:
                self.calls.append((provider,method,copy.deepcopy(params)))
            if method=="eth_chainId":
                return "0x2" if self.mode=="wrongchain" and provider=="publicnode" else "0x1"
            if method=="eth_blockNumber":
                return hex(B+15) if self.mode=="tipsplit" and provider=="publicnode" else hex(B+2)
            if method=="eth_getBlockByNumber":
                assert params==[hex(B),False]
                with self.guard:
                    self.header_reads[provider]+=1
                    nth=self.header_reads[provider]
                wrong=(self.mode=="wrongheader" and provider=="publicnode"
                    or self.mode=="reorg" and nth>1 and provider=="drpc")
                return {
                    "number":hex(B),"hash":("0x"+"fe"*32) if wrong else H,
                    "parentHash":P,"stateRoot":ROOT,
                    "timestamp":hex(self.when-300 if self.mode=="stale" else self.when),
                }
            if method=="eth_getCode":
                assert params==[
                    m.MULTICALL3,{"blockHash":H,"requireCanonical":True}]
                if self.mode=="absentcode" and provider=="drpc":
                    return "0x"
                if self.mode=="codeconflict" and provider=="publicnode":
                    return "0x"+"6002600055"*100
                return RUNTIME
            if method=="eth_call":
                args,anchor=params
                assert anchor=={"blockHash":H,"requireCanonical":True}
                if args["to"]==m.borrow.POOL:
                    who="0x"+args["data"][-40:]
                    assert who in self.index
                    i=self.index[who]
                    if self.mode=="missing" and provider=="publicnode" and i==2:
                        return "0x"
                    if self.mode=="directconflict" and provider=="publicnode" and i==2:
                        words=[int(risk(i)[2+j*64:2+(j+1)*64],16)
                               for j in range(6)]
                        words[5]+=1
                        return "0x"+"".join(f"{w:064x}" for w in words)
                    return risk(i)
                assert args["to"]==m.MULTICALL3
                assert args["data"]==m.encode_aggregate3(
                    [x["borrower"] for x in self.cohort])
                if self.mode=="429" and provider=="publicnode":
                    raise OSError("429 source throttled")
                if self.mode=="badresponse" and provider=="publicnode":
                    return "0xdeadbeef"
                if self.mode=="badsubcall" and provider=="drpc":
                    return result_abi([risk(i) for i in range(m.N)],failed=4)
                if self.mode=="badarray" and provider=="drpc":
                    return result_abi([risk(i) for i in range(m.N)],broken_offset=True)
                return result_abi([risk(i) for i in range(m.N)])
            raise AssertionError("not allowlisted source method")
        return send


class PublicMulticallAaveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p=os.environ.get("NQC_PR729_SOURCE_ZIP")
        if not p:
            raise AssertionError("set authenticated PR729 ZIP path")
        cls.raw=Path(p).read_bytes()
        cls.cohort,cls.source=m.authenticate_previous_zip(cls.raw)

    def make(self,mode=None):
        with TemporaryDirectory() as d:
            target=Path(d)
            fixture=FakeChain(self.cohort,mode)
            report=m.collect(self.cohort,self.source,target,
                             transport_factory=fixture.factory)
            files={p.name:p.read_bytes() for p in target.iterdir() if p.is_file()}
            return report,fixture,files

    def test_original_pr729_zip_commit_tree_and_full_twenty_manifest(self):
        self.assertEqual(sha256(self.raw).hexdigest(),m.PRIOR_SHA)
        self.assertEqual(self.source["previous_ABBA_head"],m.PRIOR_HEAD)
        self.assertEqual(self.source["previous_ABBA_tree"],m.PRIOR_TREE)
        self.assertEqual(self.source["previous_ABBA_manifest_sha256_members"],20)

    def test_nested_preselection_is_exactly_nine_old_debt_borrowers(self):
        self.assertEqual(len(self.cohort),9)
        self.assertEqual(len({x["borrower"] for x in self.cohort}),9)
        self.assertTrue(self.source["selection_known_before_current_RPC"])
        self.assertTrue(self.source["sample_is_old_Withdraw_debt_owners_not_all_Aave"])

    def test_original_zip_append_truncate_rejected(self):
        for payload in (self.raw[:-1],self.raw+b"extra"):
            with self.subTest(n=len(payload)),self.assertRaises(m.Rejected):
                m.authenticate_previous_zip(payload)

    def test_call3_exact_nine_36byte_pool_calls_allowfailure_false(self):
        addresses=[x["borrower"] for x in self.cohort]
        result=m.encode_aggregate3(addresses)
        self.assertTrue(result.startswith(m.AGGREGATE3_SELECTOR))
        self.assertEqual(len(addresses),9)
        self.assertEqual(m.read_word(bytes.fromhex(result[10:]),0),32)
        self.assertEqual(m.read_word(bytes.fromhex(result[10:]),32),9)
        self.assertEqual(result.count(m.borrow.call_data(addresses[0])[2:]),1)

    def test_call3_duplicate_borrower_is_rejected(self):
        data=[x["borrower"] for x in self.cohort]
        data[1]=data[0]
        with self.assertRaises(m.Rejected):m.encode_aggregate3(data)

    def test_call3_more_or_fewer_than_nine_is_rejected(self):
        data=[x["borrower"] for x in self.cohort]
        for example in (data[:8],data+data[:1]):
            with self.assertRaises(m.Rejected):m.encode_aggregate3(example)

    def test_exact_result_abi_nine_sixword_account_decoding(self):
        original=[risk(i) for i in range(9)]
        self.assertEqual(m.decode_aggregate3(result_abi(original)),original)

    def test_failed_single_subcall_never_counts_as_correct_account(self):
        with self.assertRaises(m.Rejected):
            m.decode_aggregate3(result_abi([risk(i) for i in range(9)],failed=4))

    def test_wrong_subcall_result_order_offset_fails(self):
        with self.assertRaises(m.Rejected):
            m.decode_aggregate3(result_abi([risk(i) for i in range(9)],broken_offset=True))

    def test_short_or_trailing_aggregate_output_rejected(self):
        value=result_abi([risk(i) for i in range(9)])
        for bad in (value[:-64],value+"00","0x12",None):
            with self.subTest(t=str(bad)[:20]),self.assertRaises(m.Rejected):
                m.decode_aggregate3(bad)

    def test_exact_one_canonical_hash_four_passes_and_abi_equality(self):
        report,fixture,_=self.make()
        self.assertEqual(report["status"],
            "ONE_MULTICALL3_PUBLIC_AAVE_NINE_RISK_ABBA_PARITY_NO_SVR")
        self.assertEqual([x["mode"] for x in report["trials"]],
                         ["SEQUENTIAL","MULTICALL3","MULTICALL3","SEQUENTIAL"])
        self.assertEqual(len({x["raw_result_sha256"] for x in report["trials"]}),1)
        self.assertEqual({x["canonical_block_hash"] for x in report["trials"]},{H})

    def test_per_provider_25_calls_only_including_two_multicalls(self):
        report,fixture,_=self.make()
        self.assertEqual(report["per_provider_RPC_calls"],
                         {"drpc":25,"publicnode":25})
        self.assertEqual(sum(k=="eth_call" for _,k,_ in fixture.calls),40)
        self.assertEqual(sum(
            method=="eth_call" and params[0]["to"]==m.MULTICALL3
            for _,method,params in fixture.calls),4)
        self.assertEqual(sum(
            method=="eth_call" and params[0]["to"]==m.borrow.POOL
            for _,method,params in fixture.calls),36)

    def test_proof_of_same_runtime_code_from_both_sources(self):
        report,_,_=self.make()
        proof=report["multicall3_deployment_code"]
        self.assertEqual(proof["ethereum_address"],m.MULTICALL3)
        self.assertTrue(proof["same_runtime_code_on_two_public_sources"])
        self.assertFalse(proof["contract_source_code_proven_by_two_RPC_code_bytes_alone"])
        self.assertEqual(proof["runtime_byte_length"],len(bytes.fromhex(RUNTIME[2:])))
        self.assertEqual(proof["both_source_runtime_sha256"],
                         sha256(bytes.fromhex(RUNTIME[2:])).hexdigest())

    def test_multicall_speed_not_a_private_oracle_or_capture_claim(self):
        doc,_,_=self.make()
        result=doc["comparison"]
        self.assertEqual(len(result["multicall3_elapsed_ns"]),2)
        self.assertEqual(len(result["sequential_elapsed_ns"]),2)
        self.assertTrue(result["two_trials_per_mode_insufficient_for_latency_distribution"])
        self.assertTrue(result["no_private_mev_orderflow_or_winning_builder_inclusion"])
        self.assertFalse(doc["private_SVR_or_before_block_builder_access_proven"])
        self.assertFalse(doc["commercial_score_upgrade"])
        self.assertEqual(doc["nqc_realized_pnl_usd"],"0")

    def test_precommit_written_prior_to_any_rpc(self):
        with TemporaryDirectory() as d:
            folder=Path(d)
            fixture=FakeChain(self.cohort)
            def factory(provider):
                core=fixture.factory(provider)
                def blocked_until_seal(url,method,args):
                    self.assertTrue((folder/"cohort-precommitted-before-RPC.json").exists())
                    return core(url,method,args)
                return blocked_until_seal
            report=m.collect(self.cohort,self.source,folder,
                             transport_factory=factory)
            self.assertEqual(report["status"],
                "ONE_MULTICALL3_PUBLIC_AAVE_NINE_RISK_ABBA_PARITY_NO_SVR")
            self.assertEqual(fixture.calls[0][1],"eth_chainId")

    def test_wrong_chain_stops_early_and_no_assumption_of_liquidations(self):
        doc,fixture,_=self.make("wrongchain")
        self.assertEqual(doc["status"],"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO")
        self.assertIsNone(doc["comparison"])
        self.assertFalse(any(k=="eth_call" for _,k,_ in fixture.calls))

    def test_absent_or_conflicting_deployed_bytecode_is_rejected(self):
        for mode in ("absentcode","codeconflict"):
            with self.subTest(mode=mode):
                doc,_,_=self.make(mode)
                self.assertEqual(doc["status"],"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO")
                self.assertIsNone(doc["comparison"])

    def test_wrong_header_stale_source_or_reorg_censored(self):
        for mode in ("wrongheader","stale","reorg","tipsplit"):
            with self.subTest(mode=mode):
                doc,_,_=self.make(mode)
                self.assertEqual(doc["status"],"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO")
                self.assertTrue(doc["errors"])

    def test_rpc_batch_throttle_rejected_without_swapping_provider(self):
        doc,_,_=self.make("429")
        self.assertEqual(doc["status"],"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO")
        self.assertIsNone(doc["comparison"])
        self.assertTrue(doc["errors"])

    def test_missing_direct_or_malformed_batch_censored(self):
        for mode in ("missing","badresponse","badsubcall","badarray"):
            with self.subTest(mode=mode):
                doc,_,_=self.make(mode)
                self.assertEqual(doc["status"],"INCOMPLETE_MULTICALL3_PUBLIC_RISK_NOT_MARKET_ZERO")
                self.assertTrue(doc["errors"])

    def test_rpc_never_accepts_wrong_contract_write_or_new_unselected_borrower(self):
        rpc=m.AllowlistedRPC("drpc",lambda *_:None)
        for method,args in (
            ("eth_sendRawTransaction",["0x1234"]),
            ("eth_getLogs",[]),
            ("eth_call",[{"to":"0x"+"ab"*20,"data":"0x"},
                         {"blockHash":H,"requireCanonical":True}]),
            ("eth_getCode",["0x"+"ff"*20,{"blockHash":H,"requireCanonical":True}]),
        ):
            with self.subTest(method=method),self.assertRaises(m.Rejected):
                rpc.call(method,args)
        self.assertEqual(rpc.calls,0)

    def test_source_profit_and_funding_remain_unverified_even_on_pass(self):
        doc,_,_=self.make()
        for key in ("contract_writes_or_mainnet_tx_submitted",
                    "private_SVR_or_before_block_builder_access_proven",
                    "economic_liquidation_route_or_flash_funding_verified",
                    "nonrecourse_native_gas_sponsor_proven",
                    "commercial_score_upgrade","RMC_closed",
                    "P2_shadow_certified","canary_live_authorized",
                    "user_mxn2000_spent"):
            self.assertFalse(doc[key])
        self.assertTrue(doc["OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED"])
        self.assertTrue(doc["public_canonical_head_already_mined_before_snapshot"])


if __name__=="__main__":
    unittest.main()
