#!/usr/bin/env python3
"""RMC015 post-anchor causal cohort adversarial regressions, no live trading."""
import copy
import unittest
from unittest.mock import patch
import rmc015_post_anchor_causal_sampler as m

PREV = "0x" + "a"*64
FUT1 = "0x" + "b"*64
FUT2 = "0x" + "c"*64
ROOT = "0x" + "d"*64
DEBT = 1_000_000_000_100
PROVIDERS=[
    ("drpc","dRPC","https://drpc.invalid"),
    ("blast","BlastAPI","https://blast.invalid"),
]


def fixture():
    rows=[]
    for i in range(857):
        rows.append({
           "account":"0x"+f"{i+1:040x}",
           "health_factor_wad":str(m.WAD+i*100000000000000),
           "debt_base_units":str(DEBT),
           "debt_position_count":1,
           "supply_position_count":1,
        })
    buf=b"".join(m.canonical(r) for r in rows)
    summary={
      "status":"RMC015_AUXILIARY_RISK_FRONTIER_VERIFIED",
      "anchor":{"chain_id":1,"block_number":m.ANCHOR,"block_hash":m.ANCHOR_HASH},
      "earliest_ex_ante_evaluation_block":m.FIRST,
      "retrospective_backtest_admitted":False,
      "lookahead_used":False,
      "material_risk_frontier":{"account_count":857},
      "execution_or_capital_feasibility_proven":False,
      "realized_profitability_proven":False,
      "watchlist_commitment_sha256":m.sha(buf),
      "authority_commitment_sha256":"e"*64,
    }
    return summary,buf


def words(v):
    return "0x"+"".join(f"{x:064x}" for x in v)


def fake_rpc(url,method,args):
    if method=="eth_chainId":
        assert args==[]
        return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(args[0],16)
        assert args[1] is False
        if n==m.ANCHOR:
            return {"number":hex(n),"hash":m.ANCHOR_HASH,
              "parentHash":PREV,"stateRoot":ROOT,"timestamp":hex(1000)}
        if n==m.FIRST:
            return {"number":hex(n),"hash":FUT1,
              "parentHash":m.ANCHOR_HASH,"stateRoot":ROOT,"timestamp":hex(1012)}
        if n==m.LATER:
            return {"number":hex(n),"hash":FUT2,
              "parentHash":FUT1,"stateRoot":ROOT,"timestamp":hex(90000)}
        raise AssertionError("only pinned future blocks are legal")
    if method=="eth_call":
        tx,n=args
        assert tx["to"]==m.POOL
        assert tx["data"].startswith(m.GET_ACCOUNT_DATA)
        assert n in (hex(m.ANCHOR),hex(m.FIRST),hex(m.LATER))
        addr=int(tx["data"][10:],16)
        if n==hex(m.ANCHOR):
            hf=m.WAD+(addr-1)*100000000000000
            debt=DEBT
        elif n==hex(m.FIRST):
            hf=m.WAD
            debt=DEBT
        else:
            if addr%5==0:
                hf=m.WAD-1
                debt=DEBT
            elif addr%7==0:
                hf=2**256-1
                debt=0
            else:
                hf=m.WAD+20
                debt=DEBT
        return words([10**16,debt,0,8500,7500,hf])
    raise AssertionError("unexpected RPC method, potentially unsafe")


class PostAnchorTests(unittest.TestCase):
    def test_selected_12_from_original_857_only(self):
        s,data=fixture()
        c,commit=m.select(s,data)
        self.assertEqual(len(c),12)
        self.assertEqual(len({x["account"] for _,x in c}),12)
        self.assertEqual([x["account"] for _,x in c[:6]],
                         ["0x"+f"{i+1:040x}" for i in range(6)])
        self.assertEqual(commit,m.select(s,data)[1])

    def test_real_shape_two_rpc_no_lookahead(self):
        s,data=fixture()
        x=m.assess(s,data,providers=PROVIDERS,call=fake_rpc)
        self.assertEqual(x["status"],
            "RMC015_POST_ANCHOR_SAMPLE_REAL_TWO_OPERATOR_STATE_PASS_NOT_PNL")
        self.assertEqual(x["original_source_watchlist_count"],857)
        self.assertEqual(x["sample_count"],12)
        self.assertEqual(x["net_nqc_income_measured_usd"],"0")
        self.assertEqual(sum(x["post_anchor_endpoint_observations"]["future_7200"][
            "cohort_outcome_counts"].values()),12)
        self.assertEqual(x["report_sha256"],m.sha(m.canonical(
            {k:v for k,v in x.items() if k!="report_sha256"})))

    def test_no_census_pnl_profit_capture_false_promotion(self):
        s,d=fixture()
        r=m.assess(s,d,providers=PROVIDERS,call=fake_rpc)
        for k in (
            "sample_made_from_any_future_winning_transaction",
            "original_857_account_population_fully_rescanned",
            "continuous_account_monitoring_or_intermediate_liquidations_proven",
            "historic_queries_issued_in_real_time_at_2026_anchor",
            "live_nqc_signal_or_trading_decision_proven",
            "builder_bid_or_competitor_capture_measured",
            "capital_and_gas_with_zero_own_capital_authorized",
            "nqc_realized_profitable_trades_proven",
            "monthly_profit_or_15k_55k_goal_probability_proven",
            "rmc015_terminal_authority_closed",
            "real_market_census_closed",
        ):
            self.assertIs(r[k],False,k)
        self.assertTrue(r["selection_was_fixed_before_any_future_block_was_queried"])

    def test_winning_transaction_not_in_selection_source(self):
        s,d=fixture()
        s["retrospective_backtest_admitted"]=True
        with self.assertRaisesRegex(ValueError,"future-only"):
            m.select(s,d)

    def test_d09_watchlist_immutable_digest(self):
        s,d=fixture()
        altered=d.replace(b'"debt_position_count":1',b'"debt_position_count":2',1)
        with self.assertRaisesRegex(ValueError,"SHA256"):
            m.select(s,altered)

    def test_watchlist_anchor_cannot_shift_to_earlier_day(self):
        s,d=fixture()
        s["anchor"]["block_number"]-=100
        with self.assertRaisesRegex(ValueError,"future-only"):
            m.select(s,d)

    def test_zero_lookahead_and_original_857_required(self):
        s,d=fixture()
        s["lookahead_used"]=True
        with self.assertRaisesRegex(ValueError,"future-only"):
            m.select(s,d)
        s,d=fixture()
        s["material_risk_frontier"]["account_count"]=856
        with self.assertRaisesRegex(ValueError,"future-only"):
            m.select(s,d)

    def test_duplicate_account_forbidden_even_with_rehashed_watchlist(self):
        s,d=fixture()
        rows=[m.unique_json(line) for line in d.splitlines()]
        rows[100]["account"]=rows[99]["account"]
        d2=b"".join(m.canonical(x) for x in rows)
        s["watchlist_commitment_sha256"]=m.sha(d2)
        with self.assertRaisesRegex(ValueError,"duplicated"):
            m.select(s,d2)

    def test_future_health_cannot_change_original_selection(self):
        s,d=fixture()
        _,commit=m.select(s,d)
        def manipulated(url,method,args):
            r=fake_rpc(url,method,args)
            if method=="eth_call" and args[1]==hex(m.LATER):
                return words([10**16,DEBT,0,8500,7500,1])
            return r
        x=m.assess(s,d,providers=PROVIDERS,call=manipulated)
        self.assertEqual(x["decision_time_cohort_sha256"],commit)
        self.assertEqual(sum(v for k,v in x["post_anchor_endpoint_observations"]["future_7200"][
            "cohort_outcome_counts"].items() if k.endswith("BELOW_ONE_AT_ENDPOINT")),12)

    def test_false_archive_chain_rejected(self):
        s,d=fixture()
        def bad(url,method,args):
            return "0x89" if method=="eth_chainId" else fake_rpc(url,method,args)
        with self.assertRaisesRegex(ValueError,"chain"):
            m.assess(s,d,providers=PROVIDERS,call=bad)

    def test_future_block_must_extend_fixed_anchor(self):
        s,d=fixture()
        def bad(url,method,args):
            v=fake_rpc(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==m.FIRST:
                v["parentHash"]=FUT2
            return v
        with self.assertRaisesRegex(ValueError,"boundary"):
            m.assess(s,d,providers=PROVIDERS,call=bad)

    def test_missing_anchored_source_position_fails(self):
        s,d=fixture()
        def bad(url,method,args):
            r=fake_rpc(url,method,args)
            if method=="eth_call" and args[1]==hex(m.ANCHOR):
                return words([10**16,DEBT+1,0,8500,7500,m.WAD])
            return r
        with self.assertRaisesRegex(ValueError,"does not match"):
            m.assess(s,d,providers=PROVIDERS,call=bad)

    def test_independent_rpc_state_disagreement_detected(self):
        s,d=fixture()
        def bad(url,method,args):
            r=fake_rpc(url,method,args)
            if "blast.invalid" in url and method=="eth_call" and args[1]==hex(m.LATER):
                return words([10**16,DEBT,0,8500,7500,m.WAD+1])
            return r
        with self.assertRaisesRegex(ValueError,"across providers"):
            m.assess(s,d,providers=PROVIDERS,call=bad)

    def test_pseudodiverse_rpc_provider_refused(self):
        s,d=fixture()
        with self.assertRaisesRegex(ValueError,"independent"):
            m.assess(s,d,providers=[PROVIDERS[0],PROVIDERS[0]],call=fake_rpc)

    def test_missing_or_truncated_abi_refused(self):
        s,d=fixture()
        def bad(url,method,args):
            return "0x1" if method=="eth_call" else fake_rpc(url,method,args)
        with self.assertRaisesRegex(ValueError,"six ABI"):
            m.assess(s,d,providers=PROVIDERS,call=bad)

    def test_debt_free_account_can_be_censored_at_later_snapshot(self):
        s,d=fixture()
        selected,_=m.select(s,d)
        censored=int(selected[0][1]["account"],16)
        def debt_closed(url,method,args):
            if method=="eth_call" and args[1]==hex(m.LATER) and int(args[0]["data"][10:],16)==censored:
                return words([10**16,0,0,8500,7500,2**256-1])
            return fake_rpc(url,method,args)
        r=m.assess(s,d,providers=PROVIDERS,call=debt_closed)
        aggregate=r["post_anchor_endpoint_observations"]["future_7200"]["cohort_outcome_counts"]
        self.assertIn("CLOSEST_TO_ONE__NO_DEBT_AT_ENDPOINT",aggregate)
        self.assertEqual(aggregate["CLOSEST_TO_ONE__NO_DEBT_AT_ENDPOINT"],1)

    def test_reject_ambiguous_duplicate_json_fields(self):
        with self.assertRaisesRegex(ValueError,"duplicate JSON"):
            m.unique_json(b'{"status":"good","status":"bad"}')


if __name__=="__main__":
    unittest.main()
