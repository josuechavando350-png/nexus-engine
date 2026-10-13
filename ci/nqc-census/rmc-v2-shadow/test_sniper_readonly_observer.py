#!/usr/bin/env python3
"""Offline adversarial negative tests for the NQC read-only sniper pilot."""
from __future__ import annotations
import copy
from datetime import datetime
import unittest

import sniper_readonly_observer as m

NOW=1_791_917_224
HEIGHT=26_190_000
HASH="0x"+"a"*64
PARENT="0x"+"b"*64
ROOT="0x"+"c"*64


def abi(hf=m.WAD+1000,debt=1000000000,collateral=1100000000,
        threshold=9199,ltv=8900):
    fields=(collateral,debt,0,threshold,ltv,hf)
    return "0x"+"".join(format(x,"064x") for x in fields)


class Fake:
    def __init__(self,**kwargs):
        self.providers={}
        self.methods=[]
        self.bad_chain=set()
        self.bad_rpc=set()
        self.bad_call=set()
        self.bad_risk=set()
        self.bad_header=set()
        self.reorg=set()
        self.stale=set()
        self.future=set()
        self.lowhf=set()
        self.nodebt=set()
        self.different=set()
        self.tips={k:HEIGHT+3 for k in m.SOURCES}
        self.calls={}
        self.payloads=[]
        for k,v in kwargs.items():setattr(self,k,v)
    def __call__(self,url,method,params):
        name=next(k for k,v in m.SOURCES.items() if v[1]==url)
        self.calls[name]=self.calls.get(name,0)+1
        self.methods.append(method)
        if name in self.bad_rpc:raise m.ObservationError("synthetic RPC denied")
        if method=="eth_chainId":
            return "0x2" if name in self.bad_chain else "0x1"
        if method=="eth_blockNumber":return hex(self.tips[name])
        if method=="eth_getBlockByNumber":
            block=int(params[0],16)
            return {
                "number":hex(block),
                "hash":("0x"+"d"*64 if name in self.bad_header or
                        (name in self.reorg and self.calls[name]>6) else HASH),
                "parentHash":PARENT,
                "stateRoot":ROOT,
                "timestamp":hex(NOW+9 if name in self.future else
                                NOW-500 if name in self.stale else NOW-36)
            }
        if method=="eth_call":
            self.payloads.append((name,params))
            if name in self.bad_call:return "0x00"
            d=params[0]["data"]
            if name in self.bad_risk:return abi(threshold=12000)
            address="0x"+d[-40:]
            debt=0 if name in self.nodebt else 100000000
            hf=m.WAD-500 if name in self.lowhf else m.WAD+500
            if name in self.different:hf+=1
            return abi(hf=hf,debt=debt)
        raise AssertionError("Network method out of contract: "+method)


class ReadOnlySafety(unittest.TestCase):
    def test_method_allowlist_blocks_transaction_sends(self):
        t=Fake();r=m.Reader("drpc",t)
        for verb in ("eth_sendRawTransaction","eth_sendTransaction",
                     "personal_sign","eth_sign","eth_estimateGas"):
            with self.subTest(verb=verb),self.assertRaisesRegex(
                    m.ObservationError,"non-read-only"):
                r.call(verb,[])
        self.assertEqual(t.methods,[])
    def test_synthetic_quorum_is_never_profit_claim(self):
        out=m.observe(("drpc","publicnode"),Fake(),now=NOW)
        self.assertEqual(out["status"],"DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2")
        self.assertEqual(out["provider_count"],2)
        self.assertEqual(out["nqc_realized_pnl_usd"],"0")
        self.assertFalse(out["actual_liquidation_executed"])
        self.assertFalse(out["competitive_capture_probability_known"])
        self.assertFalse(out["p2_shadow_certified"])
        self.assertFalse(out["rmc_closed"])
        self.assertFalse(out["native_gas_nonrecourse_sponsor_verified"])
    def test_accounts_all_checked_on_same_eip1898_hash(self):
        t=Fake();out=m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertEqual(out["watched_borrower_count"],len(m.BORROWERS))
        self.assertEqual(len(t.payloads),2*len(m.BORROWERS))
        for name,args in t.payloads:
            self.assertEqual(args[1],{"blockHash":HASH,"requireCanonical":True})
            self.assertEqual(args[0]["to"],m.POOL)
            self.assertTrue(args[0]["data"].startswith("0x"+m.SELECTOR))
    def test_only_readonly_rpc_methods_called(self):
        t=Fake();m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertTrue(set(t.methods)<=m.READ_METHODS)
    def test_one_source_is_not_quorum(self):
        t=Fake(bad_rpc={"publicnode"})
        out=m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertEqual(out["status"],"SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2")
        self.assertEqual(out["provider_count"],1)
        self.assertFalse(out["independent_rpc_operator_authenticity_certified"])
    def test_two_unavailable_sources_deny_hf_claim(self):
        out=m.observe(("drpc","blast"),Fake(bad_rpc={"drpc","blast"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
        self.assertIsNone(out["candidate_count"])
        self.assertEqual(out["nqc_realized_pnl_usd"],"0")
    def test_wrong_chain_provider_never_admitted(self):
        out=m.observe(("drpc","blast"),
                      Fake(bad_chain={"drpc"}),now=NOW)
        self.assertEqual(out["provider_count"],1)
        self.assertEqual(out["successful_provider_ids"],["blast"])
    def test_mismatched_account_bytes_fail_closed(self):
        out=m.observe(("drpc","publicnode"),
                      Fake(different={"publicnode"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
        self.assertEqual(out["blocker"],"PROVIDER_STATE_MISMATCH")
        self.assertIsNone(out["candidate_count"])
    def test_head_divergence_blocks_positive_claim(self):
        t=Fake();t.tips["publicnode"]=HEIGHT+25
        out=m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertEqual(out["blocker"],"RPC_TIP_DIVERGENCE")
    def test_reorg_during_read_blocks_evidence(self):
        t=Fake(reorg={"drpc","publicnode"})
        out=m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_wrong_header_blocks_source(self):
        t=Fake(bad_header={"publicnode"})
        out=m.observe(("drpc","publicnode"),t,now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_future_timestamp_rejected(self):
        out=m.observe(("drpc",),Fake(future={"drpc"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_stale_block_rejected(self):
        out=m.observe(("drpc",),Fake(stale={"drpc"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_bad_abi_rejected(self):
        out=m.observe(("drpc",),Fake(bad_call={"drpc"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_wrong_risk_params_rejected(self):
        out=m.observe(("drpc",),Fake(bad_risk={"drpc"}),now=NOW)
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")
    def test_hf_below_one_is_only_candidate_not_execution(self):
        out=m.observe(("drpc",),Fake(lowhf={"drpc"}),now=NOW)
        self.assertEqual(out["hf_below_one_state_count_not_execution_admission"],
                         len(m.BORROWERS))
        self.assertTrue(all(x["health_factor_below_one_with_debt"]
                            for x in out["account_rows"]))
        self.assertFalse(out["candidate_route_profit_verified"])
        self.assertFalse(out["actual_liquidation_executed"])
    def test_no_debt_never_counted_as_candidate(self):
        out=m.observe(("drpc",),Fake(lowhf={"drpc"},nodebt={"drpc"}),now=NOW)
        self.assertEqual(out["hf_below_one_state_count_not_execution_admission"],0)
    def test_equal_health_factor_not_less_than_one(self):
        out=m.decode_account(abi(hf=m.WAD))
        self.assertEqual(out["health_factor_wad"],m.WAD)
        self.assertGreaterEqual(out["health_factor_wad"],m.WAD)
    def test_zero_health_factor_not_liquidation_eligible(self):
        out=m.observe(("drpc",),Fake(),now=NOW)
        self.assertTrue(all("NO_DEBT_OR_NO_CONFIRMED" in
                            x["status"] for x in out["account_rows"]))
    def test_unapproved_provider_rejected(self):
        with self.assertRaisesRegex(m.ObservationError,"unapproved provider"):
            m.Reader("localwallet")
    def test_duplicate_providers_rejected(self):
        with self.assertRaisesRegex(m.ObservationError,"provider selection"):
            m.observe(("drpc","drpc"),Fake(),now=NOW)
    def test_more_than_three_providers_rejected(self):
        with self.assertRaisesRegex(m.ObservationError,"provider selection"):
            m.observe(tuple(m.SOURCES),Fake(),now=NOW)
    def test_borrower_address_malformed_rejected(self):
        for p in ("", "0xa", "not an address"):
            with self.subTest(p=p),self.assertRaises(m.ObservationError):
                m.account_calldata(p)
    def test_rpc_quantity_malformed_rejected(self):
        for p in ("3","0x00","0xgg",None):
            with self.subTest(p=p),self.assertRaises(m.ObservationError):
                m.quantity(p,"qty")
    def test_account_abi_length_malformed_rejected(self):
        for p in ("0x",abi()[:-1],abi()+"01",None):
            with self.subTest(p=p),self.assertRaises(m.ObservationError):
                m.decode_account(p)
    def test_integer_risk_math_never_float(self):
        d=m.decode_account(abi())
        self.assertTrue(all(type(v) is int for v in d.values()))
    def test_observation_time_not_float_or_future(self):
        with self.assertRaisesRegex(m.ObservationError,"time source"):
            m.observe(("drpc",),Fake(),now=float(NOW))
    def test_only_chain_watched(self):
        out=m.observe(("drpc",),Fake(),now=NOW)
        self.assertEqual(out["chain_id"],1)
    def test_snapshot_is_not_always_on_deployment(self):
        out=m.observe(("drpc",),Fake(),now=NOW)
        self.assertTrue(out["snapshot_sampling_not_24_7_deployment"])
        self.assertFalse(out["external_flash_capital_committed"])
        self.assertFalse(out["commercial_score_upgrade"])
    def test_canonical_serialization_stable(self):
        v={"b":2,"a":1}
        self.assertEqual(m.sha256(m.canonical(v)),m.sha256(m.canonical(copy.deepcopy(v))))
    def test_bounded_reader_blocks_excess_calls(self):
        r=m.Reader("drpc",Fake())
        for _ in range(m.MAX_CALLS_PER_SOURCE):r.call("eth_chainId",[])
        with self.assertRaisesRegex(m.ObservationError,"call budget"):
            r.call("eth_chainId",[])
    def test_source_errors_are_never_empty_event_interpretation(self):
        out=m.observe(("drpc",),Fake(bad_rpc={"drpc"}),now=NOW)
        self.assertIsNone(out.get("hf_below_one_state_count_not_execution_admission"))
        self.assertEqual(out["status"],"UNVERIFIED_NO_OBSERVATION")

if __name__=="__main__":unittest.main()
