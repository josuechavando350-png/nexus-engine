"""Source-locked A/B B/A risk-reader latency tests — never a SVR proof."""
from __future__ import annotations

from hashlib import sha256
import copy
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import time
import unittest

import public_aave_9account_rpc_latency_ab as ab

B=26_299_120
HASH="0x"+"ab"*32
PARENT="0x"+"cd"*32
ROOT="0x"+"ef"*32


def account(ix):
    hf=10**18+(5+ix)*10**16
    words=(10000000000,3000000000+ix,1000000,8000,7200,hf)
    return "0x"+"".join(f"{x:064x}" for x in words)


class FakeRateGate:
    """Zero-delay test-only gate; LIVE provider uses actual 400ms min pacing."""
    def __init__(self,transport):
        self.transport=transport
        self.dispatches=0
    def __call__(self,url,method,params):
        self.dispatches+=1
        return self.transport(url,method,params)


class PublicFixture:
    def __init__(self,owners,*,mode=None):
        self.owners=owners
        self.mode=mode
        self.calls=[]
        self.lock=threading.Lock()
        self.header_count={"drpc":0,"publicnode":0}
        self.t0=int(time.time())-25
    def factory(self,provider):
        def query(url,method,params):
            assert url==ab.borrow.RPC_ENDPOINTS[provider]
            with self.lock:
                self.calls.append((provider,method,copy.deepcopy(params)))
            if method=="eth_chainId":
                return "0x2" if self.mode=="wrong_chain" and provider=="publicnode" else "0x1"
            if method=="eth_blockNumber":
                return hex(B+12) if self.mode=="tipdiverge" and provider=="publicnode" else hex(B+2)
            if method=="eth_getBlockByNumber":
                assert params==[hex(B),False]
                with self.lock:
                    self.header_count[provider]+=1
                    n=self.header_count[provider]
                h=(("0x"+"55"*32) if
                   (self.mode=="head_mismatch" and provider=="publicnode" or
                    self.mode=="reorg" and provider=="drpc" and n>1)
                   else HASH)
                return {"number":hex(B),"hash":h,"parentHash":PARENT,
                        "stateRoot":ROOT,
                        "timestamp":hex(self.t0-250 if self.mode=="stale" else self.t0)}
            if method=="eth_call":
                assert params[0]["to"]==ab.borrow.POOL
                assert params[1]=={"blockHash":HASH,"requireCanonical":True}
                who="0x"+params[0]["data"][-40:]
                assert who in self.owners
                index=self.owners.index(who)
                if self.mode=="429" and provider=="publicnode" and index==3:
                    raise OSError("HTTP 429: bounded source unavailable")
                if self.mode=="badABI" and provider=="drpc" and index==2:
                    return "0xbeef"
                if self.mode=="missing" and provider=="publicnode" and index==4:
                    return None
                if self.mode=="mismatch" and provider=="publicnode" and index==6:
                    return account(index).replace("a","b")
                return account(index)
            raise AssertionError("unexpected source method")
        return query


class SealedReadTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get("NQC_PR728_SOURCE_ZIP")
        if not path:
            raise AssertionError("Set immutable SHA-bound PR728 producer ZIP")
        cls.raw=Path(path).read_bytes()
        cls.cohort,cls.source=ab.authenticate_source(cls.raw)
        cls.owners=[x["borrower"] for x in cls.cohort]

    def make(self,mode=None):
        with TemporaryDirectory() as directory:
            path=Path(directory)
            fixture=PublicFixture(self.owners,mode=mode)
            res=ab.collect(self.cohort,self.source,path,
                           transport_factory=fixture.factory,
                           rate_gate_factory=FakeRateGate)
            files={p.name:p.read_bytes() for p in path.iterdir() if p.is_file()}
            return res,fixture,files

    def test_exact_source_original_twenty_member_manifest(self):
        self.assertEqual(sha256(self.raw).hexdigest(),ab.SOURCE_SHA)
        self.assertEqual(self.source["producer_manifest_members_verified"],20)
        self.assertEqual(self.source["producer_commit"],ab.SOURCE_HEAD)
        self.assertEqual(self.source["producer_tree"],ab.SOURCE_TREE)

    def test_original_nine_selected_before_new_hf_by_prior_debt(self):
        self.assertEqual(len(self.cohort),9)
        self.assertEqual(len(set(self.owners)),9)
        self.assertTrue(self.source["cohort_fixed_using_prior_debt_snapshot"])
        self.assertTrue(all(int(x["source_old_debt_base"])>0 for x in self.cohort))
        self.assertEqual(sorted(self.owners),sorted(set(self.owners)))

    def test_source_byte_tampering_is_fatal(self):
        for raw in (self.raw+b"x",self.raw[:-1]):
            with self.subTest(length=len(raw)),self.assertRaises(ab.Rejected):
                ab.authenticate_source(raw)

    def test_ab_ba_four_passes_match_on_one_exact_hash(self):
        result,fixture,files=self.make()
        self.assertEqual(result["status"],
            "SOURCE_AUTHENTIC_AB_BA_PUBLIC_HEAD_LATENCY_NOT_SVR_ACCESS")
        self.assertEqual([x["mode"] for x in result["trials"]],
            ["SEQUENTIAL","THREE_LANES","THREE_LANES","SEQUENTIAL"])
        self.assertEqual({t["fixed_canonical_state_hash"] for t in result["trials"]},
                         {HASH})
        self.assertTrue(all(t["accounts"]==result["trials"][0]["accounts"]
                            for t in result["trials"]))
        self.assertEqual(result["latency_comparison"]["eth_call_count_per_provider"],36)

    def test_all_raw_EIP1898_blocks_pinned_and_dual_sources_identical(self):
        r,chain,_=self.make()
        reads=[(p,x) for p,m,x in chain.calls if m=="eth_call"]
        self.assertEqual(len(reads),72)
        self.assertEqual({p for p,_ in reads},{"drpc","publicnode"})
        self.assertTrue(all(x[1]=={"blockHash":HASH,"requireCanonical":True}
                            for _,x in reads))
        self.assertTrue(all(t["raw_abi_records_identical_between_sources"] for t in r["trials"]))

    def test_cohort_seal_is_on_disk_before_first_ethereum_rpc(self):
        with TemporaryDirectory() as path:
            out=Path(path)
            class RequireSeal(PublicFixture):
                def factory(this,provider):
                    wrapped=super().factory(provider)
                    def check(url,method,params):
                        self.assertTrue((out/"cohort-sealed-before-new-network.json").exists())
                        return wrapped(url,method,params)
                    return check
            fixture=RequireSeal(self.owners)
            r=ab.collect(self.cohort,self.source,out,
                transport_factory=fixture.factory,rate_gate_factory=FakeRateGate)
            self.assertEqual(r["status"],
              "SOURCE_AUTHENTIC_AB_BA_PUBLIC_HEAD_LATENCY_NOT_SVR_ACCESS")
            self.assertEqual(fixture.calls[0][1],"eth_chainId")

    def test_actual_rpc_budget_is_below_sixty_per_provider(self):
        r,fixture,_=self.make()
        counts={p:sum(x[0]==p for x in fixture.calls)
                for p in ab.PROVIDERS}
        self.assertEqual(counts,{"drpc":40,"publicnode":40})
        self.assertEqual(r["read_dispatches_per_provider"],counts)

    def test_sequential_vs_parallel_is_only_two_observations_not_prediction(self):
        r,_,_=self.make()
        m=r["latency_comparison"]
        self.assertEqual(len(m["sequential_trial_elapsed_ns"]),2)
        self.assertEqual(len(m["three_lane_trial_elapsed_ns"]),2)
        self.assertEqual(m["risk_accounts_in_each_trial"],9)
        self.assertTrue(m["network_order_provider_cache_and_load_confound_results"])
        self.assertTrue(m["one_trial_is_not_a_reliable_speed_distribution"])
        self.assertIs(type(m["three_lanes_faster_in_this_specific_two_round_sample"]),bool)

    def test_no_svr_preinclusion_or_live_business_claims(self):
        r,_,_=self.make()
        self.assertFalse(r["builder_deadline_or_preinclusion_observation_proven"])
        self.assertFalse(r["private_chainlink_SVR_mevshare_access_proven"])
        self.assertFalse(r["nqc_profit_or_route_feasible_proven"])
        self.assertFalse(r["commercial_score_upgrade"])
        self.assertFalse(r["RMC_closed"])
        self.assertFalse(r["P2_shadow_certified"])
        self.assertFalse(r["canary_live_authorized"])
        self.assertFalse(r["real_ethereum_mainnet_tx_broadcast"])
        self.assertFalse(r["fees_user_mxn2000_or_operator_funds_spent"])
        self.assertEqual(r["nqc_realized_pnl_usd"],"0")

    def test_peer_abi_mismatch_is_censored_not_market_zero(self):
        r,_,_=self.make(mode="mismatch")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])
        self.assertTrue(r["errors"])

    def test_provider_http429_never_retried_as_valid_abi(self):
        r,fixture,_=self.make(mode="429")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])
        self.assertTrue(any("OSError"==x["type"] for x in r["errors"]))

    def test_bad_abi_from_provider_censored(self):
        r,_,_=self.make(mode="badABI")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])

    def test_no_rpc_account_data_returned_is_not_zero_liquidations(self):
        r,_,_=self.make(mode="missing")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])

    def test_provider_header_hash_disagreement_rejected(self):
        r,fixture,_=self.make(mode="head_mismatch")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertEqual(len([t for t in fixture.calls if t[1]=="eth_call"]),0)

    def test_source_wrong_chain_prevents_reading_risk(self):
        r,fixture,_=self.make(mode="wrong_chain")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertFalse(any(m=="eth_call" for _,m,_ in fixture.calls))

    def test_old_head_does_not_create_fake_timely_candidate(self):
        r,_,_=self.make(mode="stale")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])

    def test_tip_divergence_prevents_source_promotion(self):
        r,_,_=self.make(mode="tipdiverge")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertEqual(len(r["trials"]),0)

    def test_reorg_after_source_reads_censors_result(self):
        r,_,_=self.make(mode="reorg")
        self.assertEqual(r["status"],"INCOMPLETE_READ_LATENCY_BENCHMARK_NOT_MARKET_ABSENCE")
        self.assertIsNone(r["latency_comparison"])

    def test_global_minimum_rate_gate_dispatch_spacing(self):
        current=[0.0]
        def now():return current[0]
        def sleep(d):current[0]+=d
        gate=ab.ProviderRateGate(lambda _u,_m,_p:"ok",clock=now,sleeper=sleep)
        for _ in range(4):
            self.assertEqual(gate("url","eth_call",[]),"ok")
        self.assertGreaterEqual(current[0],3*ab.MIN_SPACING_SEC)
        self.assertEqual(gate.dispatches,4)
        with self.assertRaises(ab.Rejected):
            ab.ProviderRateGate(lambda *_:None,interval_sec=0)

    def test_missing_mode_or_changed_risk_makes_speed_claim_fail(self):
        report,_,_=self.make()
        with self.assertRaises(ab.Rejected):
            ab.report_costs(report["trials"][:3],self.cohort,
                            report["pinned_header"])
        forged=copy.deepcopy(report["trials"])
        forged[2]["accounts"][0]["risk"]["health_factor_wad"]="1"
        with self.assertRaises(ab.Rejected):
            ab.report_costs(forged,self.cohort,report["pinned_header"])

    def test_raw_account_or_owner_tampering_is_not_accepted(self):
        report,_,_=self.make()
        a=copy.deepcopy(report["trials"][0]["accounts"])
        a[0]["borrower"]="0x"+"ff"*20
        with self.assertRaises(ab.Rejected):
            ab.normalized_accounts(a,self.cohort)
        b=copy.deepcopy(report["trials"][0]["accounts"])
        b[2]["raw_abi_sha256"]="0"*64
        with self.assertRaises(ab.Rejected):
            ab.normalized_accounts(b,self.cohort)

    def test_original_rpc_write_methods_rejected_locally(self):
        client=ab.make_reader("drpc",lambda *_:None)
        for m in ("eth_sendRawTransaction","eth_sendTransaction","eth_sign",
                  "anvil_setBalance","anvil_impersonateAccount"):
            with self.assertRaises(ab.borrow.Rejected):
                client.call(m,[])
        self.assertEqual(client.calls,0)


if __name__=="__main__":
    unittest.main()
