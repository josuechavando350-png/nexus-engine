"""Source-authentic two PUBLIC head local-time decision-journal adversarial tests."""
from __future__ import annotations

from hashlib import sha256
import copy
import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import public_two_head_sealed_watch as watch

B = 26_200_000
NOW_NS = 1_792_100_000_000_000_000
TS = NOW_NS//1_000_000_000
HF=10**18
H0="0x"+"ab"*32
H1="0x"+"bc"*32
P0="0x"+"aa"*32
STATE0="0x"+"11"*32
STATE1="0x"+"22"*32

def header(height, *, wrong=False, old=False):
    number=B if height==B else B+1
    h=H0 if number==B else H1
    if wrong:h="0x"+"ff"*32
    ts=(TS-100 if old else TS-12+(number-B)*12)
    return {
        "number":hex(number),
        "hash":h,
        "parentHash":P0 if number==B else H0,
        "stateRoot":STATE0 if number==B else STATE1,
        "timestamp":hex(ts),
    }

def encode_account(hf=HF+HF//20, debt=5_000_000_000):
    return "0x"+"".join(f"{v:064x}" for v in (
        12_000_000_000,debt,3_000_000_000,7800,7300,hf))

class FakeClock:
    def __init__(self):
        self.n=0
    def __call__(self):
        self.n+=1
        return {
            "utc_unix_ns":NOW_NS+self.n*180_000_000,
            "local_monotonic_ns":10_000_000_000+self.n*180_000_000,
        }

class MockChain:
    def __init__(self,cohort,*,out=None,bad_provider=None,
                 wrong_header=False,stale=False,never_successor=False,
                 wrong_chain=False,tip_diverge=False,reorg=False):
        self.owners=[row["borrower"] for row in cohort]
        self.calls=[]
        self.out=out
        self.bad_provider=bad_provider
        self.wrong_header=wrong_header
        self.stale=stale
        self.never_successor=never_successor
        self.wrong_chain=wrong_chain
        self.tip_diverge=tip_diverge
        self.reorg=reorg
        self.tips={}
        self.header_reads={}

    def factory(self,name):
        self.tips[name]=0
        self.header_reads[name]=0
        def transport(url,method,args):
            self.calls.append((name,method,copy.deepcopy(args)))
            if self.out is not None:
                assert (self.out/"cohort-before-network.json").is_file(), \
                    "public Ethereum RPC before source owner precommit"
            if method=="eth_chainId":
                return "0x2" if self.wrong_chain and name=="publicnode" else "0x1"
            if method=="eth_blockNumber":
                self.tips[name]+=1
                if self.tip_diverge and name=="publicnode":return hex(B+8)
                if self.never_successor:return hex(B)
                return hex(B if self.tips[name]==1 else B+1)
            if method=="eth_getBlockByNumber":
                n=int(args[0],16)
                assert n in (B,B+1)
                self.header_reads[name]+=1
                should_be_wrong=(self.wrong_header and name=="publicnode" and n==B) \
                   or (self.reorg and n==B and self.header_reads[name]>6)
                return header(n,wrong=should_be_wrong,old=self.stale)
            if method=="eth_call":
                assert args[0]["to"]==watch.borrow.POOL
                addr="0x"+args[0]["data"][-40:]
                assert addr in self.owners
                height=B if args[1]["blockHash"]==H0 else B+1
                ix=self.owners.index(addr)
                if self.bad_provider=="429" and name=="publicnode":
                    raise OSError("429 no retries")
                if self.bad_provider=="mismatch" and name=="publicnode" and ix==2:
                    return encode_account(HF+HF//25)
                if height==B+1 and ix==0:
                    return encode_account(HF-HF//100)
                if height==B+1 and ix==1:
                    return encode_account(debt=0)
                return encode_account(HF+HF//20)
            raise AssertionError("unexpected nonreadonly or unbounded RPC")
        return transport

class PublicHeadChronologyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get("NQC_PR718_83OWNER_SOURCE_ZIP")
        if not path:raise AssertionError("set exact original PR718 source ZIP")
        cls.raw=Path(path).read_bytes()
        cls.cohort,cls.source=watch.authenticate_old_source(cls.raw)

    def make(self,**kwargs):
        with TemporaryDirectory() as temp:
            out=Path(temp)
            chain=MockChain(self.cohort,out=out,**kwargs)
            c=FakeClock()
            report=watch.collect(self.cohort,self.source,out,
                transport_factory=chain.factory,
                now_fn=c,sleeper=lambda _:None)
            journal=json.loads((out/"cohort-before-network.json").read_text())
            return report,journal,chain,[p.name for p in out.iterdir()]

    def test_source_zip_exact_pr718_all_members(self):
        self.assertEqual(sha256(self.raw).hexdigest(),watch.OLD_ZIP_SHA)
        self.assertEqual(self.source["source_manifest_entries_verified"],20)
        self.assertEqual(self.source["source_pr718_commit"],watch.OLD_COMMIT)
        self.assertEqual(self.source["source_pr718_tree"],watch.OLD_TREE)
        self.assertEqual(self.source["original_fixed_event_owner_universe"],83)

    def test_exact_nine_old_active_debt_owners_in_source_order_only(self):
        self.assertEqual(len(self.cohort),9)
        self.assertEqual(len({x["borrower"] for x in self.cohort}),9)
        self.assertEqual(
            [int(x["source_old_health_factor_wad"]) for x in self.cohort],
            sorted(int(x["source_old_health_factor_wad"]) for x in self.cohort))
        self.assertTrue(all(int(x["source_old_debt_base"])>0 for x in self.cohort))

    def test_old_immutable_archive_tamper_never_accepted(self):
        for payload in (self.raw+b"a",self.raw[:-1]):
            with self.subTest(n=len(payload)),self.assertRaises(watch.Rejected):
                watch.authenticate_old_source(payload)

    def test_precommit_is_written_before_any_new_eth_rpc(self):
        out,journal,chain,names=self.make()
        self.assertTrue(journal["no_current_ethereum_rpc_yet"])
        self.assertTrue(journal["future_HF_or_competitor_outcome_not_used_for_selection"])
        self.assertEqual(journal["fixed_selections"],self.cohort)
        self.assertIn("cohort-before-network.json",names)
        self.assertEqual(chain.calls[0][1],"eth_chainId")

    def test_source_frozen_two_public_heads_and_precise_HF(self):
        out,journal,chain,names=self.make()
        self.assertEqual(out["status"],"TWO_PUBLIC_CANONICAL_HEADS_AFTER_INCLUSION_ONLY_NO_CAPTURE")
        self.assertEqual(len(out["observations"]),2)
        self.assertEqual(out["block_height_increment"],1)
        self.assertEqual([s["height"] for s in out["observations"]],[B,B+1])
        self.assertEqual(out["active_debt_at_each_public_height"],[9,8])
        self.assertEqual(out["hf_lt_one_at_each_public_height"],[0,1])
        self.assertEqual(out["observations"][1]["decision"]["eligible_risk_only_borrowers"],
                         [self.cohort[0]["borrower"]])
        self.assertTrue(out["all_public_sources_agreed_exact_canonical_EIP1898_state"])
        self.assertIn("first-public-state-seal.json",names)
        self.assertIn("second-public-state-seal.json",names)

    def test_local_first_seen_not_confused_with_mainnet_builder_order(self):
        out,_,_,_=self.make()
        self.assertTrue(out["sealed_before_first_local_successor_header_observation"])
        self.assertFalse(out["sealed_before_real_block_was_mined_proven"])
        self.assertFalse(out["private_SVR_or_MEV_share_first_seen_proven"])
        self.assertFalse(out["early_pending_feed_access_proven"])
        self.assertFalse(out["builder_deadline_known"])
        self.assertTrue(out["first_seen_is_after_canonical_block_inclusion"])

    def test_local_seal_after_successor_slot_timestamp_is_explicitly_negative(self):
        report,_,_,_=self.make()
        self.assertFalse(report["first_seal_precedes_successor_canonical_timestamp"])
        self.assertGreater(report["first_seal_minus_successor_canonical_timestamp_ns"],0)
        self.assertTrue(report["canonical_block_timestamp_not_measured_builder_cutoff"])
        self.assertTrue(report["successor_slot_timestamp_derived_not_first_seen_time"])
        self.assertFalse(report["builder_inclusion_deadline_prealigned_by_this_UTC_check"])
        # The existing positive ordering claim is ONLY first LOCAL header
        # observation, even when the successor slot has already occurred.
        self.assertTrue(report["sealed_before_first_local_successor_header_observation"])

    def test_no_temporal_positive_certain_builder_prediction_from_header(self):
        report,_,_,_=self.make()
        self.assertFalse(report["sealed_before_real_block_was_mined_proven"])
        self.assertFalse(report["private_SVR_or_MEV_share_first_seen_proven"])
        self.assertFalse(report["early_pending_feed_access_proven"])

    def test_all_observed_risk_is_at_exact_two_source_blockhashes(self):
        out,_,chain,_=self.make()
        calls=[(provider,p[1]["blockHash"])
               for provider,method,p in chain.calls if method=="eth_call"]
        self.assertEqual(len(calls),36)
        self.assertEqual({t for _,t in calls},{H0,H1})
        self.assertEqual({name for name,_ in calls},{"drpc","publicnode"})

    def test_no_winning_fee_or_live_pnl_claim(self):
        out,_,_,_=self.make()
        self.assertEqual(out["nqc_realized_pnl_usd"],"0")
        self.assertFalse(out["commercial_score_upgrade"])
        self.assertFalse(out["RMC_closed"])
        self.assertFalse(out["P2_shadow_certified"])
        self.assertFalse(out["canary_live_authorized"])
        self.assertFalse(out["competitive_win_or_pricing_route_proven"])
        self.assertFalse(out["nonrecourse_gas_sponsor_proven"])
        self.assertTrue(out["OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED"])
        self.assertFalse(out["user_mxn2000_spent"])

    def test_publicnode_risk_mismatch_stays_incomplete_no_market_zero(self):
        out,_,_,_=self.make(bad_provider="mismatch")
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertFalse(out["all_public_sources_agreed_exact_canonical_EIP1898_state"])
        self.assertNotIn("hf_lt_one_at_each_public_height",out)
        self.assertTrue(out["errors"])

    def test_publicnode_429_is_no_retries_and_censored(self):
        out,_,chain,_=self.make(bad_provider="429")
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertTrue(out["errors"])
        self.assertNotIn("active_debt_at_each_public_height",out)
        self.assertLessEqual(sum(1 for a,b,c in chain.calls if a=="publicnode" and b=="eth_call"),1)

    def test_headers_diverge_censored_not_fabricated_risk(self):
        out,_,_,_=self.make(wrong_header=True)
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertEqual(len(out["observations"]),0)
        self.assertTrue(out["errors"])

    def test_wrong_chain_does_not_touch_risk(self):
        out,_,chain,_=self.make(wrong_chain=True)
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertEqual(sum(1 for _,method,_ in chain.calls if method=="eth_call"),0)
        self.assertTrue(out["errors"])

    def test_source_tip_divergence_is_fail_closed(self):
        out,_,_,_=self.make(tip_diverge=True)
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertEqual(len(out["observations"]),0)

    def test_stale_public_header_does_not_count_as_fresh_signal(self):
        out,_,_,_=self.make(stale=True)
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertTrue(out["errors"])

    def test_missing_successor_head_stays_source_incomplete(self):
        out,_,_,_=self.make(never_successor=True)
        self.assertEqual(out["status"],"INCOMPLETE_PUBLIC_HEAD_TIMING_NOT_MARKET_ABSENCE")
        self.assertEqual(len(out["observations"]),1)
        self.assertTrue(out["errors"])

    def test_sealed_payload_exact_sha_before_successor(self):
        out,_,_,_=self.make()
        first=out["observations"][0]
        prefix=copy.deepcopy(first)
        h=prefix.pop("sealed_payload_sha256")
        self.assertEqual(watch.sha256(watch.canon(prefix)).hexdigest(),h)
        self.assertLessEqual(
            first["risk_snapshot_sealed_by_this_process"]["local_monotonic_ns"],
            out["first_local_successor_head"][
                "first_successor_public_header_seen_by_this_process"]["local_monotonic_ns"])

    def test_ledger_eligible_HF_does_not_upgrade_actionability(self):
        out,_,_,_=self.make()
        obj=out["observations"][1]
        self.assertEqual(obj["state_hf_lt_one_now_count"],1)
        self.assertFalse(obj["decision"]["route_swap_funding_and_inclusion_verified"])
        self.assertTrue(obj["decision"]["candidate_signal_is_post_public_header_only"])
        self.assertFalse(obj["decision"]["profits_or_live_trades_claimed"])

    def test_inherited_rpc_write_allowlist_rejects_every_public_write(self):
        rpc=watch.borrow.RPC("drpc",transport=lambda *_:None)
        for method in ("eth_sendRawTransaction","eth_sendTransaction",
                       "eth_sendBundle","anvil_setStorageAt",
                       "personal_unlockAccount","eth_sign"):
            with self.subTest(method=method),self.assertRaises(watch.borrow.Rejected):
                rpc.call(method,[])
        self.assertEqual(rpc.calls,0)

    def test_frozen_owner_selection_not_based_on_second_hf(self):
        out,journal,_,_=self.make()
        second=out["observations"][1]
        self.assertEqual(
            [x["borrower"] for x in journal["fixed_selections"]],
            [x["borrower"] for x in second["accounts"]])
        self.assertNotIn("health_factor_wad",journal["fixed_selections"][0])
        self.assertTrue(journal["future_HF_or_competitor_outcome_not_used_for_selection"])

    def test_not_a_market_wide_census_and_no_absence_claim(self):
        out,_,_,_=self.make()
        self.assertEqual(out["chosen_owner_count"],9)
        self.assertEqual(out["previous_indexed_owner_universe_count"],83)
        self.assertFalse(out["full_aave_borrower_census_or_no_market_claim_proven"])
        self.assertTrue(out["public_head_observation_is_not_live_opportunity_capture"])


if __name__=="__main__":
    unittest.main()
