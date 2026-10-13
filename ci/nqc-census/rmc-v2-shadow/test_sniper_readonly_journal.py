#!/usr/bin/env python3
"""Adversarial synthetic tests. No RPC, gas, wallet or market event used."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import tempfile
import unittest

import sniper_readonly_journal as j
import sniper_readonly_observer as o


def sample(status="SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2"):
    return {
        "schema_version":1,
        "contract":"NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT",
        "status":status,
        "p2_shadow_certified":False,"rmc_closed":False,
        "commercial_score_upgrade":False,
        "nqc_realized_pnl_usd":"0",
        "snapshot_sampling_not_24_7_deployment":True,
        "account_rows":[] if status=="UNVERIFIED_NO_OBSERVATION" else
            [{"borrower":"0x"+ "a"*40,
              "health_factor_below_one_with_debt":False}]
    }


class EvidenceJournal(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir=Path(self.tmp.name).resolve()
    def append(self,value=None):
        return j.append_snapshot(self.dir,sample() if value is None else value)
    def test_first_commit_hash_chain(self):
        a=self.append()
        self.assertEqual(a["sequence"],0)
        self.assertEqual(a["previous_entry_sha256"],"0"*64)
        rows,head=j.audit((self.dir/"journal.jsonl").read_bytes(),self.dir)
        self.assertEqual(len(rows),1)
        self.assertEqual(head,j.digest(j.canonical(a)))
    def test_sequential_append_does_not_change_original_sample(self):
        self.append()
        original=(self.dir/"sample-000000000.json").read_bytes()
        b=self.append()
        self.assertEqual(b["sequence"],1)
        self.assertEqual((self.dir/"sample-000000000.json").read_bytes(),original)
        self.assertEqual(len(j.audit((self.dir/"journal.jsonl").read_bytes(),self.dir)[0]),2)
    def test_hash_chain_previous_commit(self):
        a=self.append()
        b=self.append()
        self.assertEqual(b["previous_entry_sha256"],j.digest(j.canonical(a)))
    def test_negative_provider_report_preserved_not_fake_empty(self):
        x=self.append(sample("UNVERIFIED_NO_OBSERVATION"))
        self.assertEqual(x["snapshot_status"],"UNVERIFIED_NO_OBSERVATION")
        self.assertFalse(x["captured_liquidation"])
    def test_reject_forged_p2_in_report(self):
        d=sample();d["p2_shadow_certified"]=True
        with self.assertRaisesRegex(j.JournalError,"forged"):self.append(d)
    def test_reject_forged_nqc_revenue(self):
        d=sample();d["nqc_realized_pnl_usd"]="45000"
        with self.assertRaisesRegex(j.JournalError,"forged"):self.append(d)
    def test_reject_forged_rmc_closure(self):
        d=sample();d["rmc_closed"]=True
        with self.assertRaisesRegex(j.JournalError,"forged"):self.append(d)
    def test_tampered_snapshot_content_rejected(self):
        self.append()
        (self.dir/"sample-000000000.json").write_text("{}\n")
        with self.assertRaisesRegex(j.JournalError,"content mismatch"):
            self.append()
    def test_missing_snapshot_rejected(self):
        self.append()
        (self.dir/"sample-000000000.json").unlink()
        with self.assertRaisesRegex(j.JournalError,"snapshot missing"):
            self.append()
    def test_edited_line_refuses_rehashed_positive_profit(self):
        self.append()
        path=self.dir/"journal.jsonl"
        d=json.loads(path.read_text())
        d["nqc_realized_pnl_usd"]="12500"
        path.write_bytes(j.canonical(d))
        with self.assertRaisesRegex(j.JournalError,"fabricated"):self.append()
    def test_hash_chain_forged_previous_ref(self):
        self.append();self.append()
        path=self.dir/"journal.jsonl"
        rows=path.read_bytes().splitlines()
        row=json.loads(rows[1])
        row["previous_entry_sha256"]="e"*64
        path.write_bytes(rows[0]+b"\n"+j.canonical(row))
        with self.assertRaisesRegex(j.JournalError,"broken hash"):
            self.append()
    def test_unknown_status_rejected(self):
        d=sample();d["status"]="PROFIT_ACHIEVED"
        with self.assertRaisesRegex(j.JournalError,"invalid source"):
            self.append(d)
    def test_malformed_json_journal_fails(self):
        self.append()
        path=self.dir/"journal.jsonl"
        path.write_bytes(b'{"broken"\n')
        with self.assertRaisesRegex(j.JournalError,"malformed"):self.append()
    def test_truncated_journal_refused(self):
        self.append()
        path=self.dir/"journal.jsonl"
        path.write_bytes(path.read_bytes()[:-1])
        with self.assertRaisesRegex(j.JournalError,"partial final"):
            self.append()
    def test_duplicate_json_key_refused(self):
        self.append()
        path=self.dir/"journal.jsonl"
        path.write_text('{"schema_version":1,"schema_version":2}\n')
        with self.assertRaisesRegex(j.JournalError,"malformed"):self.append()
    def test_orphan_existing_filename_never_overwritten(self):
        (self.dir/"sample-000000000.json").write_text("SENTINEL")
        with self.assertRaisesRegex(j.JournalError,"already exists"):
            self.append()
        self.assertEqual((self.dir/"sample-000000000.json").read_text(),"SENTINEL")
    def test_non_absolute_dir_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"directory"):
            j.append_snapshot(Path("."),sample())
    def test_empty_journal_not_signed(self):
        self.assertEqual(j.audit(b""),([],"0"*64))
    def test_single_snapshot_run_stops_as_configured(self):
        samples=[]
        def obs_fake(p):
            samples.append(p)
            return sample()
        n=j.run(self.dir,("drpc",),max_cycles=1,interval=60,observer=obs_fake,
                sleep=lambda seconds:self.fail("unexpected sleep"))
        self.assertEqual(n,1)
        self.assertEqual(samples,[("drpc",)])
    def test_two_cycle_run_records_both_samples(self):
        n=j.run(self.dir,("drpc",),max_cycles=2,interval=60,
                observer=lambda p:sample(),sleep=lambda _:None)
        self.assertEqual(n,2)
        self.assertEqual(len(j.audit((self.dir/"journal.jsonl").read_bytes(),
                                     self.dir)[0]),2)
    def test_rpc_exception_is_censored_not_candidate(self):
        def bad(_):raise RuntimeError("RPC unavailable")
        j.run(self.dir,("drpc",),max_cycles=1,interval=60,
              observer=bad,sleep=lambda _:None)
        d=json.loads((self.dir/"sample-000000000.json").read_text())
        self.assertEqual(d["status"],"UNVERIFIED_NO_OBSERVATION")
        self.assertIsNone(d["candidate_count"])
    def test_sub_minute_interval_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"interval"):
            j.run(self.dir,("drpc",),max_cycles=1,interval=0,
                  observer=lambda _:sample())
    def test_float_interval_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"interval"):
            j.run(self.dir,("drpc",),max_cycles=1,interval=60.0,
                  observer=lambda _:sample())
    def test_negative_cycles_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"cycles"):
            j.run(self.dir,("drpc",),max_cycles=-1,interval=60)
    def test_bool_cycles_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"cycles"):
            j.run(self.dir,("drpc",),max_cycles=True,interval=60)
    def test_duplicate_providers_rejected(self):
        with self.assertRaisesRegex(j.JournalError,"provider selection"):
            j.run(self.dir,("drpc","drpc"),max_cycles=1,interval=60)
    def test_append_only_json_record_has_no_wallet_or_signature(self):
        r=self.append()
        self.assertNotIn("private_key",r)
        self.assertNotIn("wallet",r)
        self.assertNotIn("signed_transaction",r)
        self.assertEqual(r["nqc_realized_pnl_usd"],"0")

if __name__=="__main__":unittest.main()
