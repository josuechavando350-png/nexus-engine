#!/usr/bin/env python3
"""Negative regressions for one bound Aave temporal shard; offline fixtures only."""
from __future__ import annotations
import copy
import json
import unittest

import rmc015_single_480_shard_evidence as m
import rmc015_857_window_shard_continuation as source
from test_rmc015_857_window_shard_continuation import (
    SourceRpc, PROVIDERS, event, original_first, fixture
)


class TestSingleShardIntegrity(unittest.TestCase):
    def inputs(self):
        summary,watchlist=fixture()
        return summary,watchlist,original_first(summary)

    def runone(self,*,idx=1,call=None,providers=None,summary=None,watchlist=None,first=None):
        s,w,p=self.inputs()
        return m.isolated_shard(
            s if summary is None else summary,
            w if watchlist is None else watchlist,
            p if first is None else first,
            idx,providers=PROVIDERS if providers is None else providers,
            call=SourceRpc() if call is None else call)

    def test_actual_one_shard_480_blocks_only_and_source_completeness(self):
        r=self.runone()
        self.assertEqual(r["status"],m.STATUS)
        self.assertEqual(r["fixed_original_857_source_borrower_count"],857)
        self.assertEqual(r["shard_index"],1)
        self.assertEqual(r["shard_verified_block_count"],480)
        self.assertEqual(r["shard_source_start_block"],source.FIRST+480)
        self.assertEqual(r["shard_source_end_block"],source.FIRST+959)
        self.assertEqual(r["verified_first_plus_one_shard_block_count"],960)
        self.assertEqual(r["remaining_7200_blocks_not_independently_certified_by_this_report"],6240)
        self.assertEqual(r["true_executed_market_liquidation_event_count"],0)
        self.assertEqual(r["source_857_cohort_executed_liquidation_event_count"],0)
        self.assertEqual(r["real_nexus_profit_usd"],"0")
        self.assertEqual(r["report_sha256"],source.sha_json(
            {k:v for k,v in r.items() if k!="report_sha256"}))
        self.assertEqual(r["original_first_480_source_certificate"]["original_artifact_id"],
                         11562554317)

    def test_public_positive_known_canary_blocks_false_empty_provider(self):
        r=self.runone()
        c=r["historical_positive_real_winner_log_source_check"]
        self.assertEqual(c["verified_distinct_log_operator_count"],2)
        self.assertEqual(c["known_historical_winner_block"],25938048)
        self.assertFalse(c["canary_used_for_cohort_borrower_selection"])
        self.assertTrue(c["canary_not_proof_of_NQC_capture"])

    def test_no_profit_capture_or_full_census_promoted(self):
        r=self.runone()
        for key in (
            "original_fourteen_shards_all_reverified_and_joined",
            "unexecuted_and_transient_eligible_positions_fully_enumerated",
            "zero_gas_capital_external_provider_authorized",
            "inclusion_and_execution_capture_probability_calibrated",
            "monthly_usd_15000_or_55000_target_certified",
            "rmc015_full_temporal_terminal_authority_closed",
            "real_market_census_closed",
        ):
            self.assertFalse(r[key],key)
        self.assertTrue(r["no_future_winner_used_to_construct_cohort"])
        self.assertTrue(r["this_report_uses_retrospective_archive_reads"])

    def test_one_preselected_borrower_is_market_event_not_nexus_capture(self):
        _,w,_=self.inputs()
        borrower=json.loads(w.splitlines()[0])["account"]
        r=self.runone(call=SourceRpc([event(source.FIRST+480,borrower)]))
        self.assertEqual(r["true_executed_market_liquidation_event_count"],1)
        self.assertEqual(r["source_857_cohort_executed_liquidation_event_count"],1)
        self.assertEqual(r["source_cohort_unique_liquidated_borrowers_this_shard"],1)
        self.assertEqual(r["real_nexus_profit_usd"],"0")
        self.assertFalse(r["inclusion_and_execution_capture_probability_calibrated"])

    def test_outside_cohort_market_events_do_not_become_nexus_candidates(self):
        r=self.runone(call=SourceRpc([event(source.FIRST+480,"0x"+"e"*40)]))
        self.assertEqual(r["true_executed_market_liquidation_event_count"],1)
        self.assertEqual(r["source_857_cohort_executed_liquidation_event_count"],0)

    def test_bounded_last_fourteenth_shard(self):
        r=self.runone(idx=14)
        self.assertEqual(r["shard_source_start_block"],source.LAST-479)
        self.assertEqual(r["shard_source_end_block"],source.LAST)
        self.assertFalse(r["real_market_census_closed"])

    def test_wrong_segment_indices_rejected(self):
        for bad in (-1,0,15,20,True,1.25,None):
            with self.subTest(index=bad):
                with self.assertRaisesRegex(ValueError,"shard"):
                    self.runone(idx=bad)

    def test_independent_provider_set_must_be_source_proven(self):
        for providers in (
            [PROVIDERS[0],PROVIDERS[0]],
            [("drpc","dRPC","https://other.invalid"),PROVIDERS[1]],
            [("blast","Same","https://1.invalid"),
             ("blockscout","Same","https://2.invalid")],
            [("blast","A","https://same.invalid"),
             ("blockscout","B","https://same.invalid")],
        ):
            with self.subTest(providers=providers):
                with self.assertRaisesRegex(ValueError,"independent source proven"):
                    self.runone(providers=providers)

    def test_missing_857th_account_not_silently_truncated(self):
        s,w,p=self.inputs()
        truncated=b"\n".join(w.splitlines()[:-1])+b"\n"
        with self.assertRaises(ValueError):
            self.runone(summary=s,watchlist=truncated,first=p)

    def test_corrupted_original_authenticated_first_shard_fails(self):
        s,w,p=self.inputs()
        p["real_aave_liquidation_logs_in_window_all_borrowers"]=1
        p["report_sha256"]=source.sha_json({
            k:v for k,v in p.items() if k!="report_sha256"})
        with self.assertRaises(ValueError):
            self.runone(summary=s,watchlist=w,first=p)

    def test_original_source_false_census_promotion_fails(self):
        s,w,p=self.inputs()
        p["real_market_census_closed"]=True
        p["report_sha256"]=source.sha_json({
            k:v for k,v in p.items() if k!="report_sha256"})
        with self.assertRaises(ValueError):
            self.runone(summary=s,watchlist=w,first=p)

    def test_silent_empty_canary_fail_closed(self):
        original=SourceRpc()
        def bad(url,method,params):
            if (method=="eth_getLogs" and
                params[0]["fromBlock"]==hex(source.CANARY_BLOCK)):
                return []
            return original(url,method,params)
        with self.assertRaisesRegex(ValueError,"known positive history omitted"):
            self.runone(call=bad)

    def test_mismatched_operator_future_event_universe_rejected(self):
        first=SourceRpc([event(source.FIRST+480,"0x"+"e"*40)])
        def bad(url,method,params):
            if "blockscout.invalid" in url and method=="eth_getLogs" and (
                params[0]["fromBlock"]!=hex(source.CANARY_BLOCK)):
                return []
            return first(url,method,params)
        with self.assertRaisesRegex(ValueError,"archive operators disagree"):
            self.runone(call=bad)

    def test_predecessor_state_root_mismatch_rejected_before_shard(self):
        initial=SourceRpc()
        def bad(url,method,params):
            x=initial(url,method,params)
            if method=="eth_getBlockByNumber" and (
                int(params[0],16)==source.FIRST_DONE_END) and (
                "blockscout.invalid" in url):
                x["stateRoot"]="0x"+"b"*64
            return x
        with self.assertRaisesRegex(ValueError,"predecessor state and hash"):
            self.runone(call=bad)

    def test_block_reorg_in_source_shard_rejected(self):
        original=SourceRpc()
        def bad(url,method,params):
            x=original(url,method,params)
            if method=="eth_getBlockByNumber" and (
                int(params[0],16)==source.FIRST_DONE_END+1):
                x["parentHash"]="0x"+"d"*64
            return x
        with self.assertRaisesRegex(ValueError,"consecutive"):
            self.runone(call=bad)

    def test_api_rate_limit_not_interpreted_as_no_events(self):
        original=SourceRpc()
        def blocked(url,method,params):
            if method=="eth_getLogs" and "blockscout.invalid" in url and (
                params[0]["fromBlock"]!=hex(source.CANARY_BLOCK)):
                raise ValueError("HTTP Error 429: Too Many Requests")
            return original(url,method,params)
        # Unit test bypasses the actual backoff wait by patching the
        # already-imported wrapper to exercise fail-closed semantics.
        orig=source.authenticated_log_rpc
        def fail_immediately(call,url,method,args,pid):
            if pid=="blockscout" and method=="eth_getLogs" and (
                args[0]["fromBlock"]!=hex(source.CANARY_BLOCK)):
                raise ValueError("HTTP Error 429: Too Many Requests")
            return orig(call,url,method,args,pid)
        from unittest.mock import patch
        with patch.object(source,"authenticated_log_rpc",fail_immediately):
            with self.assertRaisesRegex(ValueError,"429"):
                self.runone(call=blocked)

    def test_result_excludes_original_source_addresses(self):
        s,w,_=self.inputs()
        r=self.runone()
        original=set(json.loads(line)["account"] for line in w.splitlines())
        self.assertEqual(len(original),857)
        public=source.source.canonical(r).decode()
        self.assertFalse(any(a in public for a in original))

    def test_output_deterministic_with_identical_injected_canonical_state(self):
        a=self.runone()
        b=self.runone()
        self.assertEqual(a,b)


if __name__=="__main__":
    unittest.main()
