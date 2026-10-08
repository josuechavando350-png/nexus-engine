#!/usr/bin/env python3
"""Adversarial 857 original-member successor event window shard tests."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rmc015_857_window_shard_continuation as m
import rmc015_post_anchor_causal_sampler as src
from test_rmc015_post_anchor_causal_sampler import fixture

PROVIDERS=[("blast","BlastAPI","https://blast.invalid"),
           ("blockscout","Blockscout","https://blockscout.invalid")]
EVT_TX="0x"+"f"*64
EVT_POOL=src.POOL


def original_first(summary):
    p={
      "schema_version":1,
      "status":"RMC015_857_HISTORIC_REAL_POST_ANCHOR_EVENTS_VERIFIED_NOT_NQC_CAPTURE",
      "original_D09_selection_block":src.ANCHOR,
      "original_D09_selection_block_hash":src.ANCHOR_HASH,
      "event_window_start_block":m.FIRST,
      "event_window_end_block":m.FIRST_DONE_END,
      "event_scope":"FIRST_480_POST_ANCHOR_BLOCKS_ONLY",
      "full_source_cohort_size":857,
      "source_watchlist_commitment_sha256":summary["watchlist_commitment_sha256"],
      "source_frontier_authority_sha256":summary["authority_commitment_sha256"],
      "real_independent_operator_consensus":True,
      "observed_successful_public_rpc_operator_ids":["blast","blockscout"],
      "real_aave_liquidation_logs_in_window_all_borrowers":0,
      "real_aave_liquidation_events_matching_source_cohort":0,
      "real_winner_tx_count_matching_source_cohort":0,
      "distinct_original_cohort_borrowers_liquidated_in_window":0,
      "uninspected_original_successor_blocks":6720,
      "full_7200_block_source_window_certified":False,
      "NQC_own_capital_zero_external_gas_authorized":False,
      "rmc015_terminal_authority_closed":False,
      "real_market_census_closed":False,
      "NQC_realized_profit_usd":"0",
      "all_liquidation_event_commitment_sha256":src.sha(b""),
      "source_cohort_matched_event_commitment_sha256":src.sha(b""),
    }
    p["report_sha256"]=m.sha_json(p)
    return p


def addr_topic(value):
    return "0x"+"0"*24+value[2:]


def event(block,borrower):
    return {
      "address":EVT_POOL,
      "topics":[m.LIQUIDATION_TOPIC,addr_topic("0x"+"a"*40),
                addr_topic("0x"+"b"*40),addr_topic(borrower)],
      "data":"0x"+f"{10:064x}"+f"{11:064x}"
             +f"{int('0x'+'c'*40,16):064x}"+f"{0:064x}",
      "blockNumber":hex(block),
      "blockHash":"0x"+f"{block:064x}",
      "transactionHash":EVT_TX,
      "logIndex":"0x1",
      "transactionIndex":"0x2",
      "removed":False,
    }


class SourceRpc:
    def __init__(self,evs=None):
        self.events=evs or []
        self.calls=[]
    def __call__(self,url,method,args):
        self.calls.append((url,method,copy.deepcopy(args)))
        if method=="eth_chainId":return "0x1"
        if method=="eth_getBlockByNumber":
            b=int(args[0],16)
            if b==src.ANCHOR:
                return {
                   "number":hex(b),"hash":src.ANCHOR_HASH,
                   "parentHash":"0x"+"8"*64,"stateRoot":"0x"+"a"*64,
                   "timestamp":"0x64"}
            if b==m.CANARY_BLOCK:
                return {
                   "number":hex(b),"hash":m.CANARY_BLOCK_HASH,
                   "parentHash":"0x"+"8"*64,
                   "stateRoot":"0x"+"a"*64,
                   "timestamp":"0x60"}
            if m.FIRST<=b<=m.LAST:
                parent=src.ANCHOR_HASH if b==m.FIRST else "0x"+f"{b-1:064x}"
                return {
                   "number":hex(b),"hash":"0x"+f"{b:064x}",
                   "parentHash":parent,"stateRoot":"0x"+"a"*64,
                   "timestamp":hex(100+(b-src.ANCHOR)*12)}
            raise AssertionError("invalid block query")
        if method=="eth_getLogs":
            data=args[0]
            assert data["address"]==EVT_POOL
            assert data["topics"]==[m.LIQUIDATION_TOPIC]
            lo=int(data["fromBlock"],16)
            hi=int(data["toBlock"],16)
            assert 1<=hi-lo+1<=m.SHARD_SIZE
            if lo==m.CANARY_BLOCK and hi==m.CANARY_BLOCK:
                known=event(m.CANARY_BLOCK,"0x"+"e"*40)
                known["blockHash"]=m.CANARY_BLOCK_HASH
                known["transactionHash"]=m.CANARY_WINNER_TX
                return [known]
            if "blast.invalid" in url:
                assert hi-lo+1<=10
            return [copy.deepcopy(x) for x in self.events
                    if lo<=int(x["blockNumber"],16)<=hi]
        raise AssertionError("unexpected RPC")


class TestNew14HistoricalShards(unittest.TestCase):
    def inputs(self):
        summary,bytes_=fixture()
        return summary,bytes_,original_first(summary)

    def test_exact_15_shards_exhaust_7200_blocks(self):
        self.assertEqual(m.TOTAL_SHARDS,15)
        self.assertEqual(m.SHARD_SIZE,480)
        self.assertEqual(m.FIRST_DONE_END,m.FIRST+479)
        self.assertEqual(m.LAST-m.FIRST+1,7200)
        self.assertEqual([m.bounded_shard(i) for i in range(1,15)][0],
                         (m.FIRST+480,m.FIRST+959))
        self.assertEqual(m.bounded_shard(14)[1],m.LAST)

    def test_invalid_shard_rejected(self):
        for i in (-1,0,15,16,1.5,True,None):
            with self.subTest(i=i):
                with self.assertRaises(ValueError):
                    m.bounded_shard(i)

    def test_original_first_sha_and_zero_counts(self):
        s,_,p=self.inputs()
        x=m.verified_original_first(p,s)
        self.assertEqual(x["original_artifact_id"],11562554317)
        self.assertEqual(x["original_source_events"],0)
        self.assertTrue(x["independent_operator_consensus"])

    def test_original_forged_revenue_or_shard_counts_rejected(self):
        s,_,p=self.inputs()
        for key,value in (
            ("NQC_realized_profit_usd","1"),
            ("real_market_census_closed",True),
            ("real_aave_liquidation_logs_in_window_all_borrowers",1),
            ("all_liquidation_event_commitment_sha256","f"*64),
            ("original_D09_selection_block",1),
            ("full_7200_block_source_window_certified",True),
            ("event_window_end_block",m.LAST),
        ):
            original=copy.deepcopy(p)
            original[key]=value
            original["report_sha256"]=m.sha_json(
                {k:v for k,v in original.items() if k!="report_sha256"})
            with self.subTest(key=key):
                with self.assertRaises(ValueError):
                    m.verified_original_first(original,s)

    def test_original_report_bitflip_fails_its_cryptographic_commitment(self):
        s,_,p=self.inputs()
        p["source_watchlist_commitment_sha256"]="1"*64
        with self.assertRaisesRegex(ValueError,"commitment"):
            m.verified_original_first(p,s)

    def test_exact_archival_provider_spans_blast_ten_blockscout_four_hundred_eighty(self):
        self.assertEqual(m.MAX_REAL_ARCHIVE_LOG_RANGE,{"blast":10,"blockscout":480})
        s,w,p=self.inputs()
        members={json.loads(line)["account"] for line in w.splitlines()}
        self.assertEqual(len(members),857)
        witness=SourceRpc()
        previous_hash="0x"+f"{m.FIRST_DONE_END:064x}"
        observed,events=m.verify_one_shard(
            1,members,previous_hash,providers=PROVIDERS,call=witness)
        self.assertEqual(events,[])
        self.assertEqual(observed["matched_source_cohort_event_count"],0)
        chunks={}
        for url,method,args in witness.calls:
            if method!="eth_getLogs":continue
            chunk=args[0]
            lo=int(chunk["fromBlock"],16)
            hi=int(chunk["toBlock"],16)
            bound=(10 if "blast.invalid" in url else 480)
            self.assertTrue(1<=hi-lo+1<=bound)
            chunks.setdefault(url,[]).append((lo,hi))
        self.assertEqual(len(chunks),2)
        for url,slices in chunks.items():
            self.assertEqual(len(slices),48 if "blast.invalid" in url else 1)
            self.assertEqual(slices[0][0],m.FIRST_DONE_END+1)
            self.assertEqual(slices[-1][1],m.FIRST_DONE_END+480)
            self.assertTrue(all(slices[i][1]+1==slices[i+1][0]
                                for i in range(len(slices)-1)))
        self.assertFalse(observed["census_closed"])

    def test_known_positive_historical_canary_requires_true_logs_on_both_operators(self):
        fake=SourceRpc()
        canary=m.positive_archive_log_canary(PROVIDERS,call=fake)
        self.assertEqual(canary["known_historical_winner_block"],25938048)
        self.assertEqual(canary["verified_distinct_log_operator_count"],2)
        self.assertFalse(canary["canary_used_for_cohort_borrower_selection"])
        self.assertTrue(canary["canary_not_proof_of_NQC_capture"])
        self.assertEqual(len(canary["original_canary_operator_observations"]),2)

    def test_archive_silent_empty_canary_is_not_a_market_zero(self):
        fake=SourceRpc()
        def silent(url,method,args):
            if method=="eth_getLogs" and args[0]["fromBlock"]==hex(m.CANARY_BLOCK):
                return []
            return fake(url,method,args)
        s,w,p=self.inputs()
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/"checkpoints"
            with self.assertRaisesRegex(ValueError,"known positive history omitted"):
                m.whole_window(s,w,p,folder,providers=PROVIDERS,call=silent)
            self.assertFalse(folder.exists())

    def test_archive_canary_independent_set_disagreement_fails_closed(self):
        fake=SourceRpc()
        def conflicting(url,method,args):
            out=fake(url,method,args)
            if method=="eth_getLogs" and args[0]["fromBlock"]==hex(m.CANARY_BLOCK) and "blockscout.invalid" in url:
                extra=copy.deepcopy(out[0])
                extra["transactionHash"]="0x"+"e"*64
                extra["logIndex"]="0x2"
                return out+[extra]
            return out
        with self.assertRaisesRegex(ValueError,"canary event sets differ"):
            m.positive_archive_log_canary(PROVIDERS,call=conflicting)

    def test_archive_canary_receipt_is_not_cohort_member_selection(self):
        s,w,p=self.inputs()
        members={json.loads(line)["account"] for line in w.splitlines()}
        self.assertEqual(len(members),857)
        self.assertNotIn("0x"+"e"*40,members)
        r=m.positive_archive_log_canary(PROVIDERS,call=SourceRpc())
        self.assertFalse(r["canary_used_for_cohort_borrower_selection"])
        self.assertNotIn("0x"+"e"*40,str(r))

    def test_realistic_empty_observed_future_events_complete_7200(self):
        s,w,p=self.inputs()
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"checkpoints"
            r=m.whole_window(s,w,p,path,providers=PROVIDERS,call=SourceRpc())
            self.assertEqual(r["status"],m.SOURCE_ISSUE)
            self.assertEqual(r["verified_total_block_count"],7200)
            self.assertEqual(r["missing_original_window_block_count"],0)
            self.assertEqual(r["observed_ethereum_aave_liquidation_events_entire_window"],0)
            self.assertEqual(len(r["all_checkpoints"]),14)
            self.assertEqual(len(list(path.glob("shard-*.json"))),14)
            self.assertFalse(r["real_market_census_closed"])
            self.assertFalse(r["external_gas_nonrecourse_provider_authorized"])
            self.assertFalse(r["probabilistic_capture_calibrated"])
            self.assertEqual(r["nqc_realized_profit_usd"],"0")
            self.assertEqual(r["report_sha256"],m.sha_json({
                k:v for k,v in r.items() if k!="report_sha256"}))

    def test_one_future_market_event_and_correct_source_member_match(self):
        s,w,p=self.inputs()
        actual=json.loads(w.splitlines()[0])["account"]
        ev=event(m.FIRST+480,actual)
        with tempfile.TemporaryDirectory() as d:
            r=m.whole_window(s,w,p,Path(d)/"logs",providers=PROVIDERS,
                             call=SourceRpc([ev]))
            self.assertEqual(r["observed_ethereum_aave_liquidation_events_entire_window"],1)
            self.assertEqual(r["fixed_source_cohort_857_observed_liquidation_events_entire_window"],1)
            self.assertEqual(r["fixed_source_cohort_857_unique_liquidated_accounts_entire_window"],1)
            self.assertEqual(r["fixed_source_cohort_857_third_party_winner_tx_count"],1)
            self.assertEqual(r["nqc_realized_profit_usd"],"0")

    def test_unmatched_public_event_does_not_become_nqc_candidate(self):
        s,w,p=self.inputs()
        ev=event(m.FIRST+480,"0x"+"f"*40)
        with tempfile.TemporaryDirectory() as d:
            r=m.whole_window(s,w,p,Path(d)/"logs",providers=PROVIDERS,
                             call=SourceRpc([ev]))
            self.assertEqual(r["observed_ethereum_aave_liquidation_events_entire_window"],1)
            self.assertEqual(r["fixed_source_cohort_857_observed_liquidation_events_entire_window"],0)

    def test_two_independent_operators_required(self):
        s,w,p=self.inputs()
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,"independent"):
                m.whole_window(s,w,p,Path(d)/"c",providers=[
                    ("drpc","same","https://same.invalid"),
                    ("blast","same","https://other.invalid"),
                ],call=SourceRpc())

    def test_cross_operator_disagreement_fails_before_writing_shard(self):
        s,w,p=self.inputs()
        fake=SourceRpc([event(m.FIRST+480,"0x"+"f"*40)])
        def different(url,method,args):
            if "blockscout.invalid" in url and method=="eth_getLogs" and args[0]["fromBlock"]!=hex(m.CANARY_BLOCK):
                return []
            return fake(url,method,args)
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/"c"
            with self.assertRaisesRegex(ValueError,"disagree"):
                m.whole_window(s,w,p,folder,providers=PROVIDERS,call=different)
            self.assertEqual(list(folder.iterdir()),[])

    def test_reorg_at_shard_boundary_fails_before_commit(self):
        s,w,p=self.inputs()
        fake=SourceRpc()
        def changed(url,method,args):
            obj=fake(url,method,args)
            if method=="eth_getBlockByNumber" and int(args[0],16)==m.FIRST_DONE_END+1:
                obj["parentHash"]="0x"+"9"*64
            return obj
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/"c"
            with self.assertRaisesRegex(ValueError,"canonical consecutive"):
                m.whole_window(s,w,p,folder,providers=PROVIDERS,call=changed)
            self.assertEqual(list(folder.iterdir()),[])

    def test_event_block_hash_mismatch_fails(self):
        s,w,p=self.inputs()
        e=event(m.FIRST+480,"0x"+"f"*40)
        e["blockHash"]="0x"+"d"*64
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError,"event block hash"):
                m.whole_window(s,w,p,Path(d)/"c",providers=PROVIDERS,
                               call=SourceRpc([e]))

    def test_earlier_verified_checkpoints_preserved_after_later_failure(self):
        s,w,p=self.inputs()
        rpc=SourceRpc()
        def outage(url,method,args):
            if method=="eth_getLogs" and int(args[0]["fromBlock"],16)==m.FIRST+960:
                raise ValueError("upstream API timeout")
            return rpc(url,method,args)
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/"c"
            with self.assertRaisesRegex(ValueError,"upstream API timeout"):
                m.whole_window(s,w,p,folder,providers=PROVIDERS,call=outage)
            self.assertTrue((folder/"shard-01.json").is_file())
            self.assertFalse((folder/"shard-02.json").exists())
            snapshot=src.unique_json((folder/"shard-01.json").read_bytes())
            self.assertEqual(snapshot["status"],m.SHARD_STATUS)
            self.assertFalse(snapshot["entire_7200_block_window_certified_by_this_shard"])

    def test_old_checkpoints_not_reused_without_authentication(self):
        s,w,p=self.inputs()
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d)/"c"
            folder.mkdir()
            (folder/"shard-01.json").write_text("{}")
            with self.assertRaisesRegex(ValueError,"empty checkpoint"):
                m.whole_window(s,w,p,folder,providers=PROVIDERS,call=SourceRpc())

    def test_source_cohort_completeness_enforced(self):
        s,w,p=self.inputs()
        incomplete=b"\n".join(w.splitlines()[:-1])+b"\n"
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                m.whole_window(s,incomplete,p,Path(d)/"c",providers=PROVIDERS,
                               call=SourceRpc())

    def test_invalid_reorg_or_lookahead_evm_never_proves_profit(self):
        s,w,p=self.inputs()
        with tempfile.TemporaryDirectory() as d:
            r=m.whole_window(s,w,p,Path(d)/"c",providers=PROVIDERS,call=SourceRpc())
            for k in ("was_data_observed_live_during_historical_blocks",
                      "probabilistic_capture_calibrated",
                      "external_gas_nonrecourse_provider_authorized",
                      "nqc_revenue_15k_or_55k_monthly_certified",
                      "rmc015_terminal_authority_closed",
                      "real_market_census_closed",
                      "source_chosen_winners_as_selection_inputs"):
                self.assertIs(r[k],False,k)


    def test_original_pr650_real_operator_ids_must_match_exactly(self):
        summary,_,original=self.inputs()
        original["observed_successful_public_rpc_operator_ids"]=["drpc","blast"]
        original["report_sha256"]=m.sha_json({
            k:v for k,v in original.items() if k!="report_sha256"
        })
        with self.assertRaisesRegex(ValueError,"BlastAPI/Blockscout pair"):
            m.verified_original_first(original,summary)

    def test_exact_independent_source_log_ranges_for_all_shards(self):
        summary,watchlist,first=self.inputs()
        stub=SourceRpc()
        with tempfile.TemporaryDirectory() as d:
            r=m.whole_window(summary,watchlist,first,Path(d)/"shards",
                             providers=PROVIDERS,call=stub)
        all_logs=[(url,int(params[0]["toBlock"],16)-
                        int(params[0]["fromBlock"],16)+1)
                  for url,method,params in stub.calls
                  if method=="eth_getLogs" and
                     int(params[0]["fromBlock"],16)!=m.CANARY_BLOCK]
        blast=[size for url,size in all_logs if "blast.invalid" in url]
        scout=[size for url,size in all_logs if "blockscout.invalid" in url]
        self.assertEqual(len(blast),14*48)
        self.assertEqual(len(scout),14)
        self.assertTrue(all(x<=10 for x in blast))
        self.assertTrue(all(x==480 for x in scout))
        self.assertEqual(r["verified_total_block_count"],7200)
        self.assertEqual(r["original_and_successor_dual_rpc_persistent_operator_ids"],
                         ["blast","blockscout"])
        self.assertFalse(r["real_market_census_closed"])

    def test_quota_retry_same_operator_and_exact_range(self):
        called=[]
        slept=[]
        def fake(url,method,params):
            called.append((url,method,params))
            if len(called)<3:
                raise ValueError("HTTPError: HTTP Error 429: Too Many Requests")
            return [{"observed":"valid-after-retry"}]
        data=m.authenticated_log_rpc(
            fake,"https://blockscout.invalid","eth_getLogs",
            [{"fromBlock":"0x11","toBlock":"0x12"}],"blockscout",
            sleep=slept.append)
        self.assertEqual(data,[{"observed":"valid-after-retry"}])
        self.assertEqual(slept,[2,6])
        self.assertEqual(len(called),3)
        self.assertTrue(all(v[0]=="https://blockscout.invalid" for v in called))
        self.assertTrue(all(v[2]==called[0][2] for v in called))

    def test_quota_retry_exhaustion_never_produces_empty_log(self):
        calls=[]
        def limited(url,method,params):
            calls.append(1)
            raise ValueError("HTTP 429 Too Many Requests")
        with self.assertRaisesRegex(ValueError,"429"):
            m.authenticated_log_rpc(
                limited,"https://blockscout.invalid",
                "eth_getLogs",[{"fromBlock":"0x1"}],
                "blockscout",sleep=lambda seconds:None)
        self.assertEqual(len(calls),5)
        calls.clear()
        def denied(url,method,params):
            calls.append(1)
            raise ValueError("not authorized for archive")
        with self.assertRaisesRegex(ValueError,"not authorized"):
            m.authenticated_log_rpc(
                denied,"https://blockscout.invalid",
                "eth_getLogs",[],"blockscout",sleep=lambda seconds:None)
        self.assertEqual(len(calls),1)


    def test_429_on_canonical_block_header_is_retried_without_skipping(self):
        attempts=[]
        slept=[]
        def artificial(url,method,params):
            attempts.append((url,method,params))
            if len(attempts)<3:
                raise ValueError("HTTP Error 429 Too Many Requests")
            return {"number":"0x1","hash":"0x"+"a"*64}
        data=m.authenticated_log_rpc(
            artificial,"https://blockscout.invalid",
            "eth_getBlockByNumber",["0x1",False],
            "blockscout",sleep=slept.append)
        self.assertEqual(data["number"],"0x1")
        self.assertEqual(len(attempts),3)
        self.assertEqual(slept,[2,6])
        self.assertTrue(all(x[1]=="eth_getBlockByNumber" for x in attempts))
        self.assertTrue(all(x[2]==["0x1",False] for x in attempts))

    def test_throttled_real_event_header_retains_two_operator_consensus(self):
        summary,watchlist,first=self.inputs()
        stub=SourceRpc()
        triggered=[]
        def noisy(url,method,params):
            if ("blockscout.invalid" in url and
                method=="eth_getBlockByNumber" and
                int(params[0],16)==m.FIRST_DONE_END+1 and not triggered):
                triggered.append(True)
                raise ValueError("HTTP Error 429 Too Many Requests")
            return stub(url,method,params)
        with tempfile.TemporaryDirectory() as d:
            with patch.object(m.time,"sleep",return_value=None):
                result=m.whole_window(
                    summary,watchlist,first,Path(d)/"checkpoints",
                    providers=PROVIDERS,call=noisy)
        self.assertTrue(triggered)
        self.assertEqual(result["verified_total_block_count"],7200)
        self.assertFalse(result["probabilistic_capture_calibrated"])
        self.assertFalse(result["external_gas_nonrecourse_provider_authorized"])
        self.assertEqual(result["nqc_realized_profit_usd"],"0")

if __name__=="__main__":
    unittest.main()
