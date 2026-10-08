#!/usr/bin/env python3
"""No-hindsight universe and actual successor Aave event intersection tests."""
import unittest
from unittest.mock import patch
import rmc015_857_future_aave_liquidation_events as m
import rmc015_post_anchor_causal_sampler as src
from test_rmc015_post_anchor_causal_sampler import fixture

R="0x"+"1"*64
T="0x"+"2"*64
U="0x"+"3"*64
A="0x"+"a"*64
ASSET="0x"+"a"*40
OTHER="0x"+"b"*40
SENDER="0x"+"c"*40
OPERATORS=[("drpc","dRPC","https://drpc.invalid"),
           ("blast","BlastAPI","https://blast.invalid")]

def event(block,number,borrower,collateral=ASSET,debt=ASSET):
    def t(addr):return "0x"+"0"*24+addr[2:]
    return {
        "address":m.AAVE_POOL,"topics":[m.LIQUIDATION_TOPIC,t(collateral),t(debt),t(borrower)],
        "data":"0x"+f"{100:064x}"+f"{110:064x}"+f"{int(SENDER,16):064x}"+f"{0:064x}",
        "blockNumber":hex(block),"blockHash":T if block==src.FIRST else U,
        "transactionHash":"0x"+f"{(block<<8)+number+1:064x}","logIndex":hex(number),
        "transactionIndex":hex(number),"removed":False
    }

EVENTS=[
    event(src.FIRST,0,"0x"+f"{1:040x}"),
    event(src.FIRST+1,0,"0x"+f"{2:040x}",debt=OTHER),
    event(src.FIRST+1,1,"0x"+f"{3000:040x}"),
]

def rpc(url,method,params):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        assert params[1] is False
        if n==src.ANCHOR: return {
            "number":hex(n),"hash":src.ANCHOR_HASH,
            "parentHash":R,"stateRoot":A,"timestamp":"0x64"}
        if n==src.FIRST:return {
            "number":hex(n),"hash":T,
            "parentHash":src.ANCHOR_HASH,"stateRoot":A,"timestamp":"0x70"}
        if n==src.FIRST+1:return {
            "number":hex(n),"hash":U,"parentHash":T,"stateRoot":A,"timestamp":"0x7a"}
        if n==src.LATER:return {
            "number":hex(n),"hash":R,"parentHash":U,"stateRoot":A,"timestamp":"0x80"}
        raise AssertionError("unexpected block header")
    if method=="eth_getLogs":
        query,=params
        assert query["address"]==m.AAVE_POOL and query["topics"]==[m.LIQUIDATION_TOPIC]
        lo,hi=int(query["fromBlock"],16),int(query["toBlock"],16)
        assert lo>=m.START and hi<=m.END and 0<=hi-lo<m.CHUNK
        return [e.copy() for e in EVENTS if lo<=int(e["blockNumber"],16)<=hi]
    raise AssertionError("unexpected RPC method")

class Test857PreselectedAgainstRealLaterEvents(unittest.TestCase):
    def runreal(self,call=rpc,providers=OPERATORS):
        s,data=fixture()
        return m.assess(s,data,call=call,providers=providers)

    def test_prior_cohort_real_successor_window(self):
        x=self.runreal()
        self.assertEqual(x["full_source_cohort_size"],857)
        self.assertEqual(x["real_aave_liquidation_logs_in_window_all_borrowers"],3)
        self.assertEqual(x["real_aave_liquidation_events_matching_source_cohort"],2)
        self.assertEqual(x["real_winner_tx_count_matching_source_cohort"],2)
        self.assertEqual(x["distinct_original_cohort_borrowers_liquidated_in_window"],2)
        self.assertEqual(x["matched_event_type_counts"],{"CROSS_ASSET":1,"SAME_ASSET":1})
        self.assertTrue(x["real_independent_operator_consensus"])
        self.assertEqual(x["report_sha256"],src.sha(src.canonical(
            {k:v for k,v in x.items() if k!="report_sha256"})))

    def test_output_does_not_contain_source_addresses(self):
        x=self.runreal()
        raw=src.canonical(x)
        for i in range(1,858):
            self.assertNotIn(("0x"+f"{i:040x}").encode(),raw)

    def test_not_financed_or_real_nqc_pnl(self):
        x=self.runreal()
        self.assertTrue(x["winners_are_third_parties_not_NQC"])
        for k in ("matched_winners_profit_after_builder_inclusion_proven",
                  "short_lived_unexecuted_liquidatable_opportunities_exhaustive",
                  "time_of_first_eligibility_seen_by_NQC_real_time",
                  "NQC_own_capital_zero_external_gas_authorized",
                  "NQC_probability_15k_or_55k_monthly_certified",
                  "rmc015_terminal_authority_closed",
                  "real_market_census_closed"):
            self.assertIs(x[k],False,k)
        self.assertEqual(x["NQC_realized_profit_usd"],"0")

    def test_no_retroactive_winner_selected_to_cohort(self):
        s,data=fixture()
        x=m.assess(s,data,call=rpc,providers=OPERATORS)
        self.assertTrue(x["original_857_members_selected_without_winner_hindsight"])
        self.assertEqual(x["original_D09_selection_block"],26095351)

    def test_wrong_chain_fails_closed(self):
        def bad(url,method,params):
            return "0x3" if method=="eth_chainId" else rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong Ethereum"):
            self.runreal(call=bad)

    def test_missing_first_child_canonicality_fails(self):
        def bad(url,method,params):
            r=rpc(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==src.FIRST:
                r["parentHash"]=R
            return r
        with self.assertRaisesRegex(ValueError,"future events"):
            self.runreal(call=bad)

    def test_cross_operator_full_universe_disagreement(self):
        def bad(url,method,params):
            events=rpc(url,method,params)
            if "blast.invalid" in url and method=="eth_getLogs" and events:
                return events[:-1]
            return events
        with self.assertRaisesRegex(ValueError,"disagree"):
            self.runreal(call=bad)

    def test_missing_event_block_hash_rejected(self):
        def bad(url,method,params):
            v=rpc(url,method,params)
            if method=="eth_getLogs" and v:
                v[0]["blockHash"]=R
            return v
        with self.assertRaisesRegex(ValueError,"historical block hash"):
            self.runreal(call=bad)

    def test_removed_reorg_log_rejected(self):
        def bad(url,method,params):
            v=rpc(url,method,params)
            if method=="eth_getLogs" and v:
                v[0]["removed"]=True
            return v
        with self.assertRaisesRegex(ValueError,"removed/reorg"):
            self.runreal(call=bad)

    def test_event_abi_amount_zero_rejected(self):
        d=event(src.FIRST,0,"0x"+f"{1:040x}")
        d["data"]="0x"+"0"*64+d["data"][66:]
        with self.assertRaisesRegex(ValueError,"invalid integer"):
            m.check_log(d,m.START,m.END)

    def test_invalid_indexed_borrower_rejected(self):
        d=event(src.FIRST,0,"0x"+f"{1:040x}")
        d["topics"][3]="0x"+"0"*64
        with self.assertRaisesRegex(ValueError,"borrower cannot be zero"):
            m.check_log(d,m.START,m.END)

    def test_out_of_window_reported_log_is_failure(self):
        d=event(m.START,0,"0x"+f"{1:040x}")
        with self.assertRaisesRegex(ValueError,"outside"):
            m.check_log(d,m.START+1,m.END)

    def test_no_source_duplication_from_multiple_logs(self):
        def bad(url,method,params):
            v=rpc(url,method,params)
            if method=="eth_getLogs" and v:
                return v+[v[0]]
            return v
        with self.assertRaisesRegex(ValueError,"duplicated"):
            self.runreal(call=bad)

    def test_empty_outcome_does_not_become_global_no_opportunities(self):
        def empty(url,method,params):
            return [] if method=="eth_getLogs" else rpc(url,method,params)
        x=self.runreal(call=empty)
        self.assertEqual(x["real_aave_liquidation_events_matching_source_cohort"],0)
        self.assertFalse(x["short_lived_unexecuted_liquidatable_opportunities_exhaustive"])

    def test_fake_provider_independence_rejected(self):
        with self.assertRaisesRegex(ValueError,"independent"):
            self.runreal(providers=[OPERATORS[0],OPERATORS[0]])

    def test_wrong_source_watchlist_digest_fails(self):
        s,d=fixture()
        s["watchlist_commitment_sha256"]="f"*64
        with self.assertRaisesRegex(ValueError,"SHA256"):
            m.assess(s,d,call=rpc,providers=OPERATORS)

    def test_source_admission_refuses_historical_logs_free_tier_and_uses_independent_alternatives(self):
        candidates=[
          ("drpc","dRPC","https://drpc.invalid"),
          ("blast","BlastAPI","https://blast.invalid"),
          ("publicnode","PublicNode","https://publicnode.invalid")
        ]
        def constrained(url,method,params):
            if "drpc.invalid" in url and method=="eth_getLogs":
                raise ValueError("ranges over 10000 blocks are not supported on free plan")
            return rpc(url,method,params)
        admitted,rejected=m.independently_supported_archives(call=constrained,candidates=candidates)
        self.assertEqual([p[0] for p in admitted],["blast","publicnode"])
        self.assertEqual([x["provider_id"] for x in rejected],["drpc"])

    def test_blast_free_rpc_requires_ten_block_segments_without_losing_events(self):
        s,data=fixture()
        counts={"blast":0,"blockscout":0}
        def strict(url,method,params):
            if method=="eth_getLogs":
                lo=int(params[0]["fromBlock"],16)
                hi=int(params[0]["toBlock"],16)
                if "blast.invalid" in url:
                    self.assertLessEqual(hi-lo+1,10)
                    counts["blast"]+=1
                elif "blockscout.invalid" in url:
                    self.assertLessEqual(hi-lo+1,480)
                    counts["blockscout"]+=1
            return rpc(url,method,params)
        r=m.assess(s,data,call=strict,providers=[
            ("blast","BlastAPI","https://blast.invalid"),
            ("blockscout","Blockscout","https://blockscout.invalid"),
        ])
        self.assertEqual(r["event_chunks_per_provider"],{"blast":720,"blockscout":15})
        self.assertEqual(counts,{"blast":720,"blockscout":15})
        self.assertEqual(r["real_aave_liquidation_events_matching_source_cohort"],2)

    def test_no_paid_or_unverified_public_archive_fallback(self):
        candidates=[
          ("drpc","dRPC","https://drpc.invalid"),
          ("blast","BlastAPI","https://blast.invalid")
        ]
        def all_blocked(url,method,params):
            if method=="eth_getLogs":
                raise ValueError("premium API key required")
            return rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"two independent public archive RPCs"):
            m.independently_supported_archives(call=all_blocked,candidates=candidates)

    def test_exact_temporal_chunks_cover_7200_blocks(self):
        self.assertEqual(m.END-m.START+1,7200)
        self.assertEqual(m.CHUNK,480)
        self.assertEqual((m.END-m.START+1)//m.CHUNK,15)
        x=self.runreal()
        self.assertEqual(x["event_chunks_per_provider"],{"drpc":15,"blast":720})


if __name__=="__main__":
    unittest.main()
