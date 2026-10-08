#!/usr/bin/env python3
"""Adversarial offline tests of dual-operator actual historic market time span."""
import copy
import unittest
from pathlib import Path
from unittest.mock import patch
import rmc016_true_historic_window_duration as m

ROOT=Path(__file__).resolve().parents[2]
FIRST_TIME=1_780_000_000
ELAPSED=30*86400
START=m.economic.EXPECTED_WINDOW[0]
END=m.economic.EXPECTED_WINDOW[1]
START_HASH,END_HASH=m.economic.EXPECTED_WINDOW_HASHES
PROVIDERS=[
    ("drpc","dRPC","https://drpc.invalid"),
    ("blast","BlastAPI","https://blast.invalid"),
]


def mock_rpc(url,method,args):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        assert len(args)==2 and args[1] is False
        n=int(args[0],16)
        assert n in (START,END)
        return {
          "number":hex(n),
          "hash":START_HASH if n==START else END_HASH,
          "parentHash":"0x"+"1"*64,
          "stateRoot":"0x"+"2"*64,
          "timestamp":hex(FIRST_TIME if n==START else FIRST_TIME+ELAPSED),
        }
    raise AssertionError("Unexpected archive RPC method")


class TestRealMarketDuration(unittest.TestCase):
    def get(self,call=mock_rpc,providers=PROVIDERS):
        return m.assess(root=ROOT,call=call,providers=providers)

    def test_source_locked_exact_historical_window_and_no_profit(self):
        r=self.get()
        self.assertEqual(r["status"],m.STATUS)
        self.assertEqual(r["original_market_window_block_count"],215036)
        self.assertEqual(r["actual_elapsed_seconds_between_start_and_end_block_timestamps"],ELAPSED)
        self.assertEqual(r["actual_elapsed_days_numerator"],ELAPSED)
        self.assertEqual(r["actual_elapsed_days_denominator"],86400)
        self.assertEqual(r["independent_historical_block_operator_ids"],["drpc","blast"])
        self.assertEqual(r["observed_market_third_party_liquidation_events"],139)
        self.assertEqual(r["observed_third_party_unique_winning_transactions"],127)
        self.assertEqual(r["nqc_realized_net_profit_usd_wad"],"0")
        self.assertEqual(r["report_sha256"],m.economic.sha(m.economic.canonical(
            {k:v for k,v in r.items() if k!="report_sha256"})))

    def test_30_day_history_arithmetic_wad_is_exact_only_for_same_duration(self):
        r=self.get()
        self.assertEqual(r["observed_market_oracle_gross_usd_wad"],
                         "138045174690310000000000")
        self.assertEqual(r[
          "same_past_window_30_day_arithmetic_equivalent_oracle_gross_usd_wad_floor"],
          r["observed_market_oracle_gross_usd_wad"])
        self.assertEqual(r[
          "same_past_window_30_day_arithmetic_equivalent_partial_after_third_party_gas_usd_wad_floor"],
          r["observed_market_partial_after_competitor_paid_gas_usd_wad"])

    def test_15k_and_55k_targets_are_necessary_not_certified(self):
        r=self.get()
        self.assertEqual(len(r["original_same_window_nominal_USD_target_share_thresholds"]),2)
        for t in r["original_same_window_nominal_USD_target_share_thresholds"]:
            self.assertFalse(t["confirmed_achievable_by_nexus"])
            self.assertFalse(t["sufficient_for_nexus_monthly_reliability"])
            self.assertFalse(t["empirical_nexus_capture_probability_known"])

    def test_no_derived_historical_market_rate_is_forecast_or_nqc_pnl(self):
        r=self.get()
        for key in (
            "all_monetization_execution_capital_builder_costs_complete",
            "nqc_market_share_or_capture_probability_calibrated",
            "nqc_nonrecourse_native_gas_credit_line_available",
            "nqc_monthly_USD_15000_or_55000_reliability_certified",
            "rmc011_terminal_closed",
            "rmc015_terminal_closed",
            "rmc016_terminal_authority_closed_by_this_report",
            "real_market_census_closed",
        ):self.assertIs(r[key],False,key)
        self.assertTrue(r["post_hoc_historical_arithmetic_is_no_future_market_forecast"])
        self.assertTrue(r["one_source_window_not_an_automatically_repeatable_month"])

    def test_very_different_window_length_changes_daily_and_30d_values(self):
        def shorter(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==END:
                h["timestamp"]=hex(FIRST_TIME+25*86400)
            return h
        r=self.get(call=shorter)
        gross=int(r["observed_market_oracle_gross_usd_wad"])
        self.assertEqual(int(r["same_past_window_30_day_arithmetic_equivalent_oracle_gross_usd_wad_floor"]),
                         gross*30//25)
        self.assertEqual(int(r["observed_historical_oracle_gross_rate_usd_per_day_wad_floor"]),
                         gross//25)

    def test_exact_integer_floor_when_not_divisible(self):
        def longer(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==END:
                h["timestamp"]=hex(FIRST_TIME+31*86400+1)
            return h
        r=self.get(call=longer)
        gross=int(r["observed_market_oracle_gross_usd_wad"])
        seconds=31*86400+1
        self.assertEqual(int(r["observed_historical_oracle_gross_rate_usd_per_day_wad_floor"]),
                         gross*86400//seconds)
        self.assertEqual(int(r["same_past_window_30_day_arithmetic_equivalent_oracle_gross_usd_wad_floor"]),
                         gross*86400*30//seconds)

    def test_only_historical_block_headers_and_chain_id_requested(self):
        calls=[]
        def audit(url,method,args):
            calls.append((url,method,copy.deepcopy(args)))
            return mock_rpc(url,method,args)
        self.get(call=audit)
        self.assertEqual(len(calls),6)
        self.assertEqual(sum(method=="eth_getBlockByNumber" for _,method,_ in calls),4)
        self.assertEqual(sum(method=="eth_chainId" for _,method,_ in calls),2)
        self.assertFalse(any(method.startswith("eth_send") for _,method,_ in calls))
        self.assertFalse(any(args==["latest"] for _,_,args in calls))

    def test_wrong_chain_hard_fails(self):
        def wrong(url,method,args):
            return "0x5" if method=="eth_chainId" else mock_rpc(url,method,args)
        with self.assertRaisesRegex(ValueError,"chain id"):
            self.get(call=wrong)

    def test_suspicious_rpc_provider_duplicate_identity_hard_fails(self):
        for providers in (
            [PROVIDERS[0],PROVIDERS[0]],
            [("drpc","Same","https://a.invalid"),
             ("blast","Same","https://b.invalid")],
            [("drpc","dRPC","https://same.invalid"),
             ("blast","BlastAPI","https://same.invalid")],
            [PROVIDERS[1],PROVIDERS[0]],
        ):
            with self.subTest(providers=providers):
                with self.assertRaisesRegex(ValueError,"independent"):
                    self.get(providers=providers)

    def test_cross_operator_time_disagreement_must_be_reported_as_failure(self):
        def disagree(url,method,args):
            h=mock_rpc(url,method,args)
            if "blast" in url and method=="eth_getBlockByNumber" and int(args[0],16)==END:
                h["timestamp"]=hex(FIRST_TIME+ELAPSED+12)
            return h
        with self.assertRaisesRegex(ValueError,"disagree"):
            self.get(call=disagree)

    def test_cross_operator_state_root_disagreement_must_fail(self):
        def disagree(url,method,args):
            h=mock_rpc(url,method,args)
            if "blast" in url and method=="eth_getBlockByNumber":
                h["stateRoot"]="0x"+"a"*64
            return h
        with self.assertRaisesRegex(ValueError,"disagree"):
            self.get(call=disagree)

    def test_invalid_historical_hash_rejected_before_income_math(self):
        def wrong(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber":
                h["hash"]="0x"+"f"*64
            return h
        with self.assertRaisesRegex(ValueError,"drift"):
            self.get(call=wrong)

    def test_invalid_or_noncanonical_block_number_rejected(self):
        def wrong(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber":
                h["number"]="0x0"+h["number"][2:]
            return h
        with self.assertRaisesRegex(ValueError,"noncanonical"):
            self.get(call=wrong)

    def test_missing_root_or_parent_rejected(self):
        for key in ("stateRoot","parentHash"):
            def wrong(url,method,args):
                h=mock_rpc(url,method,args)
                if method=="eth_getBlockByNumber":h[key]=None
                return h
            with self.subTest(field=key):
                with self.assertRaisesRegex(ValueError,"missing"):
                    self.get(call=wrong)

    def test_time_reversal_must_fail(self):
        def wrong(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==END:
                h["timestamp"]=hex(FIRST_TIME-1)
            return h
        with self.assertRaisesRegex(ValueError,"implausible"):
            self.get(call=wrong)

    def test_implausibly_large_90_day_duration_rejected(self):
        def wrong(url,method,args):
            h=mock_rpc(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==END:
                h["timestamp"]=hex(FIRST_TIME+90*86400)
            return h
        with self.assertRaisesRegex(ValueError,"implausible"):
            self.get(call=wrong)

    def test_upstream_D16_real_market_source_cannot_fake_monthly_income(self):
        originals=m.economic.auth_source(ROOT)
        altered=copy.deepcopy(originals)
        altered["d16"]["authority"]["nqc_conservative_realizable_monthly_capacity_usd_wad"]="1"
        with patch.object(m.economic,"auth_source",return_value=altered):
            with self.assertRaisesRegex(ValueError,"NQC realizable net"):
                self.get()

    def test_upstream_authorized_gas_source_not_faked(self):
        originals=m.economic.auth_source(ROOT)
        altered=copy.deepcopy(originals)
        altered["gas_registry"]["provider_count"]=1
        with patch.object(m.economic,"auth_source",return_value=altered):
            with self.assertRaisesRegex(ValueError,"external gas"):
                self.get()

    def test_authentic_original_source_git_blobs_required(self):
        src=m.economic.auth_source(ROOT)
        self.assertEqual(src["d16"]["authority"]["definite_episode_count"],139)
        self.assertEqual(src["gas_registry"]["provider_count"],0)

    def test_witness_deterministic_with_matching_sources(self):
        self.assertEqual(self.get(),self.get())


if __name__=="__main__":
    unittest.main()
