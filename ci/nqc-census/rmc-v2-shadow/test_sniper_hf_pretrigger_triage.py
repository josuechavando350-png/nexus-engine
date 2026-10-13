#!/usr/bin/env python3
"""Synthetic-only negative regressions of sniper HF triage; no network/keys."""
from __future__ import annotations
from copy import deepcopy
import tempfile
from pathlib import Path
import unittest

import sniper_readonly_journal as j
import sniper_readonly_observer as o
import sniper_hf_pretrigger_triage as t

W=o.WAD
T=1791917200

def sample(n,*,close=True,below=False,no_debt=False):
    hf=W-1000 if below else (W+100_000_000_000_000-n*10_000_000)
    if not close:hf=W+100_000_000_000_000_000
    accounts=[]
    for label,meta in o.BORROWERS.items():
        h=hf if label=="emode24_susde_usdtb" else W+100_000_000_000_000_000
        debt=0 if no_debt and label=="emode24_susde_usdtb" else 150000000
        accounts.append({
            "borrower_label":label,"borrower":meta["address"],
            "identity_origin":meta["origin"],
            "account":{
                "total_collateral_base":"200000000",
                "total_debt_base":str(debt),"available_borrows_base":"0",
                "liquidation_threshold_bps":"9199","ltv_bps":"9000",
                "health_factor_wad":str(h)},
            "health_factor_below_one_with_debt":debt>0 and 0<h<W,
            "status":"RESEARCH_ONLY","raw_account_sha256":"a"*64
        })
    return {
        "schema_version":1,
        "contract":"NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT",
        "status":"DUAL_ENDPOINT_SAME_BLOCK_HF_WITNESS_NOT_P2",
        "chain_id":1,"pinned_block":{
            "number":26000000+n,"timestamp":T+60*n,
            "hash":"0x"+format(n+1,"064x"),
            "parent_hash":"0x"+format(n,"064x")},
        "observed_epoch_seconds":T+60*n+30,
        "account_rows":accounts,"watched_borrower_count":len(accounts),
        "provider_count":2,"successful_provider_ids":["drpc","publicnode"],
        "accounts_consistent_across_successful_endpoints":True,
        "independent_rpc_operator_authenticity_certified":False,
        "hf_below_one_state_count_not_execution_admission":
            sum(a["health_factor_below_one_with_debt"] for a in accounts),
        "actual_liquidation_executed":False,
        "native_gas_nonrecourse_sponsor_verified":False,
        "p2_shadow_certified":False,"rmc_closed":False,
        "commercial_score_upgrade":False,"nqc_realized_pnl_usd":"0"
    }

class SniperTriageTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out=Path(self.tmp.name).resolve()
    def journal(self,rows=None):
        for d in (rows if rows is not None else [sample(0),sample(1),sample(2)]):
            j.append_snapshot(self.out,d)
        return self.out
    def test_three_samples_watch_not_execution(self):
        d=t.triage(self.journal())
        self.assertEqual(d["hf_near_threshold_watch_count"],1)
        self.assertEqual(d["hf_below_one_state_candidates_only"],0)
        self.assertFalse(d["p2_shadow_certified"])
        self.assertFalse(d["commercial_score_upgrade"])
        self.assertEqual(d["nqc_realized_pnl_usd"],"0")
        self.assertTrue(d["no_live_transaction"])
    def test_monotone_hf_near_band(self):
        d=t.triage(self.journal())
        row=next(x for x in d["triage"] if x["borrower_label"]=="emode24_susde_usdtb")
        self.assertEqual(row["status"],"PRETRIGGER_NEAR_ONE_DECLINING_WATCH_ONLY")
        self.assertTrue(row["three_sample_hf_declining"])
        self.assertIsNone(row["estimated_time_to_liquidation"])
        self.assertIsNone(row["net_pnl_usd"])
    def test_no_profit_or_capture_in_any_alert(self):
        d=t.triage(self.journal())
        self.assertTrue(all(x["competition_capture_proven"] is False
                            and x["aave_liquidation_call_executed"] is False
                            for x in d["triage"]))
    def test_real_lt_one_is_state_candidate_only(self):
        d=t.triage(self.journal([sample(0),sample(1),sample(2,below=True)]))
        self.assertEqual(d["hf_below_one_state_candidates_only"],1)
        self.assertEqual(d["nqc_realized_pnl_usd"],"0")
        self.assertFalse(d["p2_shadow_certified"])
    def test_no_debt_is_not_a_watch(self):
        d=t.triage(self.journal([sample(0,no_debt=True),
                                 sample(1,no_debt=True),
                                 sample(2,no_debt=True)]))
        self.assertEqual(d["hf_near_threshold_watch_count"],0)
    def test_high_hf_no_alert(self):
        d=t.triage(self.journal([sample(0,close=False),
                                 sample(1,close=False),
                                 sample(2,close=False)]))
        self.assertEqual(d["hf_near_threshold_watch_count"],0)
    def test_nonmonotonic_near_is_still_only_watch(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["account_rows"][0]["account"]["health_factor_wad"]=str(
            W+100_000_000_000_000+10_000_000)
        d=t.triage(self.journal(docs))
        row=next(x for x in d["triage"] if x["borrower_label"]=="emode24_susde_usdtb")
        self.assertEqual(row["status"],"PRETRIGGER_NEAR_ONE_WATCH_ONLY")
    def test_only_two_samples_refused(self):
        with self.assertRaisesRegex(t.Rejected,"at least three"):
            t.triage(self.journal([sample(0),sample(1)]))
    def test_missing_journal_refused(self):
        with self.assertRaisesRegex(t.Rejected,"journal missing"):
            t.triage(self.out)
    def test_tampered_snapshot_refused(self):
        self.journal()
        p=self.out/"sample-000000001.json";p.write_text("{}")
        with self.assertRaisesRegex(t.Rejected,"hash/lineage"):
            t.triage(self.out)
    def test_forged_borrower_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["account_rows"][0]["borrower"]="0x"+"f"*40
        with self.assertRaisesRegex(t.Rejected,"borrower identity"):
            t.triage(self.journal(docs))
    def test_duplicate_provider_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[1]["successful_provider_ids"]=["drpc","drpc"]
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_source_count_forgery_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["provider_count"]=3
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_single_source_cannot_be_fabricated_as_quorum(self):
        docs=[sample(i) for i in range(3)]
        docs[0]["status"]="SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2"
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_p2_claim_refused(self):
        docs=[sample(i) for i in range(3)];docs[2]["p2_shadow_certified"]=True
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_fake_profit_refused(self):
        docs=[sample(i) for i in range(3)];docs[2]["nqc_realized_pnl_usd"]="45000"
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_invalid_risk_parameter_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[1]["account_rows"][0]["account"]["ltv_bps"]="10001"
        with self.assertRaisesRegex(t.Rejected,"risk bounds"):
            t.triage(self.journal(docs))
    def test_false_hf_trigger_flag_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["account_rows"][0]["health_factor_below_one_with_debt"]=True
        with self.assertRaisesRegex(t.Rejected,"candidate HF flag"):
            t.triage(self.journal(docs))
    def test_false_aggregate_candidate_count_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["hf_below_one_state_count_not_execution_admission"]=1
        with self.assertRaisesRegex(t.Rejected,"false source candidate"):
            t.triage(self.journal(docs))
    def test_duplicate_borrower_label_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[1]["account_rows"][1]["borrower_label"]=docs[1]["account_rows"][0]["borrower_label"]
        with self.assertRaisesRegex(t.Rejected,"borrower identity"):
            t.triage(self.journal(docs))
    def test_stale_block_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[1]["observed_epoch_seconds"]+=1000
        with self.assertRaisesRegex(t.Rejected,"historical timestamp"):
            t.triage(self.journal(docs))
    def test_nonmonotonic_block_sequence_refused(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["pinned_block"]["number"]=docs[1]["pinned_block"]["number"]
        with self.assertRaisesRegex(t.Rejected,"strictly increasing"):
            t.triage(self.journal(docs))
    def test_noncanonical_integer_rejected(self):
        for v in ("01",True,1.2,"-2",None):
            with self.subTest(v=v),self.assertRaises(t.Rejected):
                t.uint(v,"hf")
    def test_recent_censored_sample_not_zero(self):
        docs=[sample(i) for i in range(3)]
        docs[2]["status"]="UNVERIFIED_NO_OBSERVATION"
        with self.assertRaisesRegex(t.Rejected,"missing quorum"):
            t.triage(self.journal(docs))
    def test_no_predicted_crossing_in_result(self):
        d=t.triage(self.journal())
        self.assertTrue(all(x["estimated_time_to_liquidation"] is None
                            for x in d["triage"]))
    def test_invalid_journal_directory_refused(self):
        with self.assertRaisesRegex(t.Rejected,"directory"):
            t.triage(self.out/"does-not-exist")

if __name__=="__main__":unittest.main()
