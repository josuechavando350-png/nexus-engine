"""Adversarial PR717-source and 83-owner dual-RPC recheck regressions (NO TRADE)."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
from unittest.mock import patch
import unittest

import withdraw_all_83_owner_refresh as gate


FAKE_NOW = 1_792_100_000
TEST_EVENT_FINAL = 26_191_487
TEST_TIP = TEST_EVENT_FINAL+304
TEST_PIN = TEST_TIP-3


class FakeRPC:
    old_headers = None
    owner_order = None
    failure = None
    changed_state = False
    wrong_block = False
    too_slow = False
    call_log = []

    def __init__(self, provider, transport=None):
        self.provider=provider
        self.calls=0
        self.transcript=[]
        self._pin={
            "number":TEST_PIN,"hash":"0x"+"54"*32,
            "parent_hash":"0x"+"43"*32,"state_root":"0x"+"65"*32,
            "timestamp":FAKE_NOW-35,
        }

    def call(self,method,params,allowed_borrowers=None):
        self.calls+=1
        need = self.calls<=gate.MAX_READ_CALLS_PER_SOURCE
        if not need:raise ValueError("fake RPC budget exceeded")
        if method=="eth_chainId":return "0x1"
        if method=="eth_blockNumber":return hex(TEST_TIP)
        if method!="eth_call":raise ValueError("method out of read-only fixture")
        assert params[0]["to"]==gate.previous.POOL
        assert params[1]=={"blockHash":self._pin["hash"],
                           "requireCanonical":True}
        assert params[0]["data"].startswith("0xbf92857c")
        addr="0x"+params[0]["data"][-40:]
        assert addr in allowed_borrowers
        i=self.owner_order.index(addr)
        self.call_log.append((self.provider,method,addr,params[1]["blockHash"]))
        if self.provider=="publicnode" and self.failure=="publicnode_429" and i==7:
            raise OSError("429 source quota")
        if self.provider=="publicnode" and self.changed_state and i==7:
            return encode(hf=gate.previous.borrow.WAD+1)
        if i in (0,64):
            return encode(hf=gate.previous.borrow.WAD-1)
        if i in (1,65):
            return encode(hf=gate.previous.borrow.WAD+gate.previous.borrow.WAD//200)
        if i<10 or i in (64,65,66,67):
            return encode(hf=gate.previous.borrow.WAD*2)
        return encode(hf=gate.previous.borrow.WAD*2,debt=0)

    def get_header(self,height):
        self.calls+=1
        if height in (26191104,26191487):
            return copy.deepcopy(self.old_headers[
                "first" if height==26191104 else "last"])
        assert height==TEST_PIN
        ans=copy.deepcopy(self._pin)
        if self.provider=="publicnode" and self.wrong_block:
            ans["hash"]="0x"+"ff"*32
        return ans


def encode(hf, debt=5000):
    return "0x"+"".join(f"{x:064x}" for x in
        (7000,debt,1000,8250,7500,hf))


class Authenticated83OwnerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path=os.environ.get("NQC_PR717_EVIDENCE_ZIP")
        if not path:
            raise AssertionError("Set exact downloaded PR717 artifact path before tests")
        cls.original=Path(path).read_bytes()
        cls.document,cls.provenance=gate.authenticate_zip(cls.original)
        cls.owners,cls.previous_states,cls.boundaries=gate.source_cohort(cls.document)

    def setUp(self):
        FakeRPC.old_headers=self.boundaries
        FakeRPC.owner_order=self.owners
        FakeRPC.failure=None
        FakeRPC.changed_state=False
        FakeRPC.wrong_block=False
        FakeRPC.call_log=[]

    def fake_collect(self):
        with patch.object(gate.previous.borrow,"RPC",FakeRPC):
            return gate.collect(self.document,self.provenance,
                                time_provider=lambda:FAKE_NOW)

    def test_exact_zip_authenticated_and_source_locked(self):
        self.assertEqual(sha256(self.original).hexdigest(),gate.PRODUCER_ZIP_SHA)
        self.assertEqual(self.provenance["manifest_members_sha256_verified"],18)
        self.assertEqual(self.provenance["source_head"],gate.PRODUCER_HEAD)
        self.assertEqual(self.provenance["source_tree"],gate.PRODUCER_TREE)

    def test_exact_83_and_19_omitted_are_from_same_source(self):
        self.assertEqual(len(self.owners),83)
        self.assertEqual(len(set(self.owners)),83)
        self.assertEqual(len(self.previous_states),64)
        self.assertEqual(len(self.owners[64:]),19)
        source=self.document["source_reports"]["drpc"]["events"]
        self.assertEqual(sum(x["owner"] in set(self.owners[64:]) for x in source),24)

    def test_producer_zip_byte_mutation_rejected(self):
        with self.assertRaises(gate.Rejected):
            gate.authenticate_zip(self.original[:-1]+bytes([self.original[-1]^1]))

    def test_previous_one_rpc_censored_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["source_reports"]["publicnode"]["status"]="INCOMPLETE_WITHDRAW_SOURCE"
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_source_event_identity_mismatch_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["source_reports"]["drpc"]["events"][0]["tx_hash"]="0x"+"aa"*32
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_duplicate_previous_event_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["source_reports"]["drpc"]["events"][-1]=copy.deepcopy(
            doc["source_reports"]["drpc"]["events"][0])
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_truncated_or_mutated_original_64_selection_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["source_cohort"]=doc["source_cohort"][:63]
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_false_prior_commercial_promotion_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["commercial_score_upgrade"]=True
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_original_reorg_or_missing_header_rejected(self):
        doc=copy.deepcopy(self.document)
        doc["source_reports"]["publicnode"]["last_header"]["hash"]="0x"+"aa"*32
        with self.assertRaises(gate.Rejected):gate.source_cohort(doc)

    def test_83_complete_at_one_exact_postevent_block(self):
        result=self.fake_collect()
        self.assertEqual(result["status"],
                         "TWO_URL_ALL_83_WITHDRAW_OWNER_HF_VERIFIED_NOT_P2")
        self.assertTrue(result["two_public_url_exact_account_parity"])
        self.assertEqual(result["verified_all_owner_accounts"],83)
        self.assertEqual(result["verified_19_omitted_accounts"],19)
        self.assertEqual(result["omitted_19_active_debt_count"],4)
        self.assertEqual(result["omitted_19_hf_below_one_count"],1)
        self.assertEqual(result["hf_below_one_with_debt_count"],2)
        self.assertEqual(result["source"]["producer_zip_sha256"],
                         gate.PRODUCER_ZIP_SHA)
        self.assertEqual(result["fresh_pinned_block"]["number"],TEST_PIN)
        self.assertTrue(all(j[3]=="0x"+"54"*32 for j in FakeRPC.call_log))
        self.assertEqual(len(FakeRPC.call_log),166)
        self.assertEqual(result["providers"]["drpc"]["calls_used"],90)
        self.assertEqual(result["providers"]["publicnode"]["calls_used"],90)
        self.assertFalse(result["prospective_pre_inclusion_observation_proven"])
        self.assertFalse(result["net_profit_or_positive_ev_certified"])
        self.assertEqual(result["nqc_realized_pnl_usd"],"0")

    def test_all_83_no_lookahead_or_live_capture_claim(self):
        result=self.fake_collect()
        self.assertTrue(result["selected_prior_to_current_risk_state"])
        self.assertFalse(result["competitive_inclusion_or_winrate_proven"])
        self.assertFalse(result["source_census_complete_aave_active_accounts"])
        self.assertFalse(result["nonrecourse_native_gas_sponsor_proven"])
        self.assertFalse(result["commercial_score_upgrade"])

    def test_source_disagreement_censored_not_zero(self):
        FakeRPC.changed_state=True
        out=self.fake_collect()
        self.assertEqual(out["status"],"INCOMPLETE_ALL_83_WITHDRAW_OWNER_CURRENT_STATE")
        self.assertFalse(out["two_public_url_exact_account_parity"])
        self.assertIsNone(out["hf_below_one_with_debt_count"])
        self.assertTrue(any(x["stage"]=="parity" for x in out["errors"]))

    def test_source_429_censored_not_zero(self):
        FakeRPC.failure="publicnode_429"
        out=self.fake_collect()
        self.assertEqual(out["status"],"INCOMPLETE_ALL_83_WITHDRAW_OWNER_CURRENT_STATE")
        self.assertFalse(out["two_public_url_exact_account_parity"])
        self.assertIsNone(out["omitted_19_hf_below_one_count"])
        self.assertEqual(out["providers"]["publicnode"]["status"],
                         "INCOMPLETE_CURRENT_OWNER_SOURCE")

    def test_different_current_canonical_head_censored(self):
        FakeRPC.wrong_block=True
        out=self.fake_collect()
        self.assertEqual(out["status"],"INCOMPLETE_ALL_83_WITHDRAW_OWNER_CURRENT_STATE")
        self.assertIsNone(out["verified_all_owner_accounts"])
        self.assertTrue(any(x["stage"]=="header" for x in out["errors"]))

    def test_stale_pinned_block_never_promoted(self):
        with patch.object(gate.previous.borrow,"RPC",FakeRPC):
            out=gate.collect(self.document,self.provenance,
                             time_provider=lambda:FAKE_NOW+300)
        self.assertEqual(out["status"],"INCOMPLETE_ALL_83_WITHDRAW_OWNER_CURRENT_STATE")
        self.assertIsNone(out["active_debt_count"])
        self.assertTrue(any(x["stage"]=="freshness" for x in out["errors"]))

    def test_statistical_comparable_count_conserves(self):
        d=self.fake_collect()
        self.assertEqual(
            d["comparable_prior_64_with_debt_both_states"],
            d["comparable_64_hf_increased_count"]+
            d["comparable_64_hf_decreased_count"]+
            d["comparable_64_hf_unchanged_count"])
        self.assertEqual(d["active_debt_count"]+d["zero_debt_count"],83)

    def test_no_market_claim_if_producer_event_window_censored(self):
        d=copy.deepcopy(self.document)
        d["verified_withdraw_event_count"]=None
        with self.assertRaises(gate.Rejected):gate.source_cohort(d)

    def test_no_market_claim_if_producer_observed_owners_not_83(self):
        d=copy.deepcopy(self.document)
        d["verified_distinct_owner_count"]=82
        with self.assertRaises(gate.Rejected):gate.source_cohort(d)

    def test_false_old_revenue_is_rejected(self):
        d=copy.deepcopy(self.document)
        d["nqc_realized_pnl_usd"]="1"
        with self.assertRaises(gate.Rejected):gate.source_cohort(d)

    def test_empty_report_gas_sponsor_and_shadow_always_false(self):
        result=gate.empty_report(self.provenance,self.owners)
        for name in ("liquidation_route_executable_proven",
                     "cold_standalone_nqc_transaction_gas_verified",
                     "competitive_inclusion_or_winrate_proven",
                     "nonrecourse_native_gas_sponsor_proven",
                     "net_profit_or_positive_ev_certified",
                     "P2_shadow_certified","RMC_closed",
                     "canary_live_authorized","commercial_score_upgrade"):
            self.assertFalse(result[name])


if __name__=="__main__":
    unittest.main()
