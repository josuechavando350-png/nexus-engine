#!/usr/bin/env python3
"""Fail-closed causal discovery/next-block label separation.

Synthetic fixtures ONLY; integration workflow must obtain separate live archive
RPC results before any causal observation is claimed.
"""
import copy
import unittest
from unittest.mock import patch
import rmc015_causal_borrow_cohort as m

BORROWER_A="0x"+"a"*40
BORROWER_B="0x"+"b"*40
BORROWER_C="0x"+"c"*40
TX_A="0x"+"3"*64
TX_B="0x"+"4"*64
SRC_BLOCK_HASH="0x"+"d"*64
NEXT_PARENT_HASH=m.CUTOFF_HASH

def borrow_log(beneficiary=BORROWER_A,initiator=BORROWER_B,block=m.CUTOFF-10,idx=1):
    amount=10**18
    return {
        "address":m.AAVE_POOL,"removed":False,"topics":[
            m.BORROW_TOPIC,
            "0x"+"0"*24+"1"*40,
            "0x"+"0"*24+beneficiary[2:],
            "0x"+"0"*64,
        ],
        "blockNumber":hex(block),"blockHash":SRC_BLOCK_HASH,
        "transactionHash":TX_A,"logIndex":hex(idx),
        "data":"0x"+"0"*24+initiator[2:]
          +f"{amount:064x}"+f"{2:064x}"+f"{3:064x}",
    }


def liquidation_log(borrower=BORROWER_A,idx=3):
    return {
        "address":m.AAVE_POOL,
        "removed":False,"topics":[
            m.LIQUIDATION_TOPIC,"0x"+"0"*64,
            "0x"+"0"*64,"0x"+"0"*24+borrower[2:],
        ],
        "blockNumber":hex(m.NEXT_BLOCK),"blockHash":m.NEXT_HASH,
        "transactionHash":TX_B,"logIndex":hex(idx),
    }


def account(hf=m.WAD+10**12,debt=10**13):
    return "0x"+ "".join(f"{x:064x}" for x in (
        2*10**13,debt,0,8000,7500,hf
    ))


class StubRPC:
    def __init__(self,borrow=None,liquidated=None,hf=m.WAD+10**12):
        self.borrow=borrow if borrow is not None else [borrow_log()]
        self.liquidated=liquidated if liquidated is not None else [liquidation_log()]
        self.hf=hf
        self.calls=[]

    def __call__(self,url,method,args):
        self.calls.append((url,method,copy.deepcopy(args)))
        if method=="eth_chainId":return "0x1"
        if method=="eth_getBlockByNumber":
            n=int(args[0],16)
            if n==m.CUTOFF:
                return {"number":hex(n),"hash":m.CUTOFF_HASH,
                        "parentHash":"0x"+"8"*64,
                        "stateRoot":"0x"+"9"*64,
                        "timestamp":hex(1790000000)}
            if n==m.NEXT_BLOCK:
                return {"number":hex(n),"hash":m.NEXT_HASH,
                        "parentHash":NEXT_PARENT_HASH,
                        "stateRoot":"0x"+"7"*64,
                        "timestamp":hex(1790000012)}
            raise AssertionError("unsafe block number")
        if method=="eth_getLogs":
            query=args[0]
            if query["topics"]==[m.BORROW_TOPIC]:
                lo=int(query["fromBlock"],16)
                hi=int(query["toBlock"],16)
                return [x for x in self.borrow
                        if lo<=int(x["blockNumber"],16)<=hi]
            if query["topics"]==[m.LIQUIDATION_TOPIC]:
                return self.liquidated
            raise AssertionError("wrong event topic")
        if method=="eth_call":return account(self.hf)
        raise AssertionError("forbidden RPC")


class TestCausalBorrowCohort(unittest.TestCase):
    def fake_providers(self):
        return [("drpc","dRPC","https://a.invalid"),
                ("blast","BlastAPI","https://b.invalid")]

    def test_full_two_operator_holdout_without_future_selection(self):
        stub=StubRPC()
        r=m.assess(call=stub,providers=self.fake_providers())
        self.assertEqual(r["status"],
            "RMC015_PREWINNER_BORROW_COHORT_CAUSAL_HOLDOUT_OBSERVED_NOT_PNL")
        self.assertEqual(r["recent_borrow_event_count"],1)
        self.assertEqual(r["recent_borrow_cohort_size"],1)
        self.assertEqual(r["observed_holdout_unique_liquidated_borrowers"],1)
        self.assertEqual(r["holdout_borrowers_present_in_causal_recent_borrow_cohort"],1)
        self.assertEqual(r["holdout_borrowers_absent_from_causal_recent_borrow_cohort"],0)
        self.assertFalse(r["nqc_revenue_or_income_found"])
        self.assertFalse(r["real_market_census_closed"])
        self.assertEqual(r["immutable_input_features_sha256"],
            r["source_features"]["features_frozen_sha256"])
        self.assertEqual(r["report_sha256"],m.sha({k:v for k,v in r.items()
                                                 if k!="report_sha256"}))
        methods=[v[1:3] for v in stub.calls]
        last_feature=max(i for i,(name,params) in enumerate(methods)
                         if name=="eth_call")
        first_holdout=min(i for i,(name,params) in enumerate(methods)
                          if name=="eth_getBlockByNumber"
                          and params==[hex(m.NEXT_BLOCK),False])
        self.assertLess(last_feature,first_holdout)

    def test_cohort_misses_are_not_silently_counted_as_wins(self):
        stub=StubRPC(liquidated=[liquidation_log(BORROWER_C)])
        r=m.assess(call=stub,providers=self.fake_providers())
        self.assertEqual(r["holdout_borrowers_present_in_causal_recent_borrow_cohort"],0)
        self.assertEqual(r["holdout_borrowers_absent_from_causal_recent_borrow_cohort"],1)
        self.assertEqual(r["holdout_miss_borrowers"],[BORROWER_C])
        self.assertFalse(r["next_block_liquidation_match_proves_capture"])

    def test_empty_cohort_has_no_hindsight_winner_injection(self):
        r=m.assess(call=StubRPC(borrow=[]),providers=self.fake_providers())
        self.assertEqual(r["recent_borrow_cohort_size"],0)
        self.assertEqual(r["holdout_borrowers_present_in_causal_recent_borrow_cohort"],0)
        self.assertEqual(r["holdout_borrowers_absent_from_causal_recent_borrow_cohort"],1)

    def test_causal_feature_metadata_includes_explicit_no_claims(self):
        r=m.assess(call=StubRPC(),providers=self.fake_providers())
        for key in (
            "study_was_designed_with_prior_knowledge_of_this_historical_winner_block",
            "independent_operator_feature_consensus",
            "independent_operator_holdout_label_consensus",
        ):self.assertTrue(r[key],key)
        for key in (
            "unbiased_ex_ante_out_of_sample_validation_complete",
            "historical_cohort_coverage_complete",
            "next_block_liquidation_match_proves_capture",
            "nqc_revenue_or_income_found",
            "nqc_capital_zero_external_gas_authorized",
            "rmc015_terminal_authority_obtained",
            "real_market_census_closed",
            "signal_discovery_uses_future_winner_knowledge",
        ):self.assertFalse(r[key],key)

    def test_debt_beneficiary_is_onbehalfof_not_borrow_initiator(self):
        event=m.borrow_identity(borrow_log(),m.CUTOFF-64,m.CUTOFF)
        self.assertEqual(event["borrower"],BORROWER_A)
        self.assertEqual(event["initiator"],BORROWER_B)
        self.assertNotEqual(event["borrower"],event["initiator"])

    def test_topic_must_be_actual_borrow_event(self):
        bad=borrow_log()
        bad["topics"][0]=m.LIQUIDATION_TOPIC
        with self.assertRaisesRegex(ValueError,"topics invalid"):
            m.borrow_identity(bad,m.CUTOFF-64,m.CUTOFF)

    def test_borrow_log_after_cutoff_fails_even_if_in_range(self):
        with self.assertRaisesRegex(ValueError,"leaked beyond"):
            m.borrow_identity(borrow_log(block=m.CUTOFF+1),
                              m.CUTOFF-64,m.CUTOFF+1)

    def test_log_reorg_removed_disallowed(self):
        x=borrow_log()
        x["removed"]=True
        with self.assertRaises(ValueError):
            m.borrow_identity(x,m.CUTOFF-64,m.CUTOFF)

    def test_malformed_topic_length_and_nonindexed_address(self):
        x=borrow_log()
        x["topics"][2]="0x"+"1"*64
        with self.assertRaisesRegex(ValueError,"debt beneficiary"):
            m.borrow_identity(x,m.CUTOFF-64,m.CUTOFF)
        x=borrow_log()
        x["data"]="0x"+"00"
        with self.assertRaisesRegex(ValueError,"payload"):
            m.borrow_identity(x,m.CUTOFF-64,m.CUTOFF)

    def test_duplicate_pre_cutoff_borrow_transaction_event_fails(self):
        stub=StubRPC(borrow=[borrow_log(),borrow_log()])
        with self.assertRaisesRegex(ValueError,"duplicate original"):
            m.assess(call=stub,providers=self.fake_providers())

    def test_duplicate_holdout_liquidation_event_fails(self):
        stub=StubRPC(liquidated=[liquidation_log(),liquidation_log()])
        with self.assertRaisesRegex(ValueError,"holdout duplicate"):
            m.assess(call=stub,providers=self.fake_providers())

    def test_future_block_header_forbidden_in_feature_stage(self):
        stub=StubRPC()
        with self.assertRaisesRegex(ValueError,"noncutoff"):
            m.cutoff_query(stub,"https://a.invalid","eth_getBlockByNumber",
                           [hex(m.NEXT_BLOCK),False])

    def test_future_events_forbidden_in_feature_stage(self):
        stub=StubRPC()
        with self.assertRaisesRegex(ValueError,"future/unbounded"):
            m.cutoff_query(stub,"https://a.invalid","eth_getLogs",[
                {"address":m.AAVE_POOL,"topics":[m.BORROW_TOPIC],
                 "fromBlock":hex(m.CUTOFF+1),"toBlock":hex(m.CUTOFF+1)}])

    def test_future_account_eth_call_forbidden_in_feature_stage(self):
        stub=StubRPC()
        with self.assertRaisesRegex(ValueError,"only as-of"):
            m.cutoff_query(stub,"https://a.invalid","eth_call",[
                {"to":m.AAVE_POOL,
                 "data":m.GET_ACCOUNT_DATA+BORROWER_A[2:].rjust(64,"0")},
                hex(m.NEXT_BLOCK)])

    def test_receipt_or_historical_winner_lookup_forbidden_at_feature_stage(self):
        with self.assertRaisesRegex(ValueError,"forbidden"):
            m.cutoff_query(StubRPC(),"https://a.invalid",
                           "eth_getTransactionReceipt",[TX_A])

    def test_operator_pseudodiversity_fails(self):
        with self.assertRaisesRegex(ValueError,"independently"):
            m.assess(call=StubRPC(),providers=[
                ("drpc","Same","https://a.invalid"),
                ("blast","Same","https://b.invalid")])

    def test_independent_feature_disagreement_fails(self):
        stub=StubRPC()
        def bad(url,method,args):
            if "b.invalid" in url and method=="eth_call":
                return account(m.WAD+2*10**14)
            return stub(url,method,args)
        with self.assertRaisesRegex(ValueError,"before-cutoff"):
            m.assess(call=bad,providers=self.fake_providers())

    def test_independent_holdout_disagreement_fails(self):
        stub=StubRPC()
        def bad(url,method,args):
            if "b.invalid" in url and method=="eth_getLogs" and (
                args[0].get("topics")==[m.LIQUIDATION_TOPIC]):
                return []
            return stub(url,method,args)
        with self.assertRaisesRegex(ValueError,"post-cutoff"):
            m.assess(call=bad,providers=self.fake_providers())

    def test_holdout_not_successor_fails(self):
        stub=StubRPC()
        def bad(url,method,args):
            x=stub(url,method,args)
            if method=="eth_getBlockByNumber" and args==[hex(m.NEXT_BLOCK),False]:
                x["parentHash"]="0x"+"f"*64
            return x
        with self.assertRaisesRegex(ValueError,"not direct"):
            m.assess(call=bad,providers=self.fake_providers())

    def test_cap_overflow_fails_not_truncates_or_picks_winner(self):
        with patch.object(m,"MAX_COHORT",0):
            with self.assertRaisesRegex(ValueError,"do not truncate"):
                m.assess(call=StubRPC(),providers=self.fake_providers())

    def test_repeated_rpc_log_chunk_rejected(self):
        stub=StubRPC()
        def bad(url,method,args):
            if method=="eth_getLogs" and args[0]["topics"]==[m.BORROW_TOPIC]:
                return [borrow_log(block=m.CUTOFF-2)]*(
                    m.MAX_LOGS_PER_CHUNK+1)
            return stub(url,method,args)
        with self.assertRaisesRegex(ValueError,"incomplete"):
            m.assess(call=bad,providers=self.fake_providers())

    def test_no_external_gas_provider_or_profit_inferred(self):
        r=m.assess(call=StubRPC(),providers=self.fake_providers())
        self.assertFalse(r["nqc_capital_zero_external_gas_authorized"])
        self.assertFalse(r["nqc_revenue_or_income_found"])
        self.assertFalse(r["rmc015_terminal_authority_obtained"])
        self.assertFalse(r["historical_cohort_coverage_complete"])

    def test_log_missing_borrower_or_malformed_holdout_rejected(self):
        bad=liquidation_log()
        bad["topics"][3]="0x"+"f"*64
        with self.assertRaisesRegex(ValueError,"bad borrower"):
            m.holdout_stage(self.fake_providers()[0],"a"*64,
                            call=StubRPC(liquidated=[bad]))

    def test_wrong_chain_fails_closed(self):
        stub=StubRPC()
        def bad(url,method,args):
            if method=="eth_chainId":return "0x89"
            return stub(url,method,args)
        with self.assertRaisesRegex(ValueError,"wrong chain"):
            m.assess(call=bad,providers=self.fake_providers())

    def test_current_block_drift_fails_closed(self):
        stub=StubRPC()
        def bad(url,method,args):
            x=stub(url,method,args)
            if method=="eth_getBlockByNumber" and args==[hex(m.CUTOFF),False]:
                x["hash"]="0x"+"f"*64
            return x
        with self.assertRaisesRegex(ValueError,"canonical mismatch"):
            m.assess(call=bad,providers=self.fake_providers())

if __name__=="__main__":
    unittest.main()
