#!/usr/bin/env python3
"""Adversarial source-bound incremental Blockscout receipt checkpoint tests."""
from __future__ import annotations

import copy
import hashlib
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import rmc016_resume_blockscout_batch as B
import rmc016_resume_verified_receipts as R
import rmc016_two_operator_receipts as P
from test_rmc016_two_operator_receipts import fixture


class ReceiptBatchTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.root=Path(t.name)
        self.source,self.source_sha,self.raw=fixture(self.root)
        _,self.events,self.ids=P.load_source(self.source,self.source_sha)
        self.drpc={tx:P.receipt_normalized(tx,self.events[tx],self.raw[tx]) for tx in self.ids}
        self.drpc_zip=self.root/"drpc.zip"
        drpc_report={
            "schema_version":1,"status":"RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED",
            "blocked_at":"blast","independent_receipt_parity_complete":False,
            "nexus_net_pnl_proven":False,"source_event_artifact_sha256":self.source_sha,
            "provider_stages":[{"provider_id":"drpc","verified_transaction_count":127},
                               {"provider_id":"blast","verified_transaction_count":6}],
        }
        self._write_zip(self.drpc_zip,{
            "receipt-parity-report.json":B.canonical(drpc_report),
            "verified-drpc-receipts.jsonl":b"".join(B.canonical(self.drpc[tx]) for tx in self.ids),
        })
        self.prior=self.root/"blockscout10.zip"
        self.write_prior()
        self.patches=[
            patch.object(R,"SOURCE_ARTIFACT_SHA256",self.source_sha),
            patch.object(R,"DRPC_CHECKPOINT_SHA256",B.sha(self.drpc_zip.read_bytes())),
            patch.object(R,"DRPC_EXPECTED_GAS_WEI",
                         sum(int(x["total_gas_paid_wei"]) for x in self.drpc.values())),
            patch.object(B,"SOURCE_ARTIFACT_SHA256",self.source_sha),
            patch.object(B,"DRPC_CHECKPOINT_SHA256",B.sha(self.drpc_zip.read_bytes())),
            patch.object(B,"PREVIOUS_SHA256",B.sha(self.prior.read_bytes())),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)

    def _write_zip(self,path,contents):
        contents=dict(contents)
        contents["archive.sha256"]="".join(B.sha(v)+"  "+k+"\n"
            for k,v in sorted(contents.items())).encode()
        with zipfile.ZipFile(path,"w") as z:
            for name,bytes_ in sorted(contents.items()):
                z.writestr(name,bytes_)

    def write_prior(self, records=None, report=None):
        rows=[self.drpc[tx] for tx in self.ids[:10]] if records is None else records
        ledger=b"".join(B.canonical(x) for x in rows)
        if report is None:
            report={"schema_version":1,
                    "status":"RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED",
                    "first_operator":"dRPC","second_operator":"Blockscout",
                    "dRPC_receipts_verified_from_checkpoint":127,
                    "blockscout_receipts_verified":len(rows),
                    "independent_receipt_parity_complete":False,
                    "nexus_realized_pnl_proven":False,
                    "real_market_census_closed":False,
                    "historical_source_artifact_sha256":self.source_sha,
                    "prior_drpc_checkpoint_artifact_sha256":B.sha(self.drpc_zip.read_bytes()),
                    "partial_evidence_sha256":B.sha(ledger)}
        self._write_zip(self.prior,{
            "receipt-parity-report.json":B.canonical(report),
            "verified-blockscout-receipts.jsonl":ledger,
        })

    def call(self,url,method,params):
        self.assertEqual(url,"https://eth.blockscout.com/api/eth-rpc")
        self.assertEqual(method,"eth_getTransactionReceipt")
        return self.raw[params[0]]

    def run_batch(self,func=None,**kwargs):
        return B.collect_batch(self.source,self.drpc_zip,self.prior,self.root/"batch",
             rpc_call=func or self.call,sleep=lambda _:None,min_interval=2,**kwargs)

    def test_add_six_without_repeat_and_preserve_nonclaims(self):
        called=[]
        def spy(u,m,p):
            called.append(p[0]);return self.call(u,m,p)
        report=self.run_batch(spy)
        self.assertEqual(report["prior_receipt_count"],10)
        self.assertEqual(report["new_receipt_count"],6)
        self.assertEqual(report["verified_receipt_count"],16)
        self.assertEqual(report["remaining_receipt_count"],111)
        self.assertEqual(called,self.ids[10:16])
        self.assertEqual(report["status"],"RMC016_SECOND_OPERATOR_BATCH_CHECKPOINT_PARTIAL")
        self.assertFalse(report["all_127_receipts_cross_operator_reconciled"])
        self.assertFalse(report["nexus_realized_pnl_proven"])
        self.assertFalse(report["nexus_gas_funding_proven"])
        self.assertIsNone(report["nexus_monthly_net_pnl_usd"])

    def test_incremental_archive_checksums(self):
        report=self.run_batch()
        d=self.root/"batch"
        data=(d/"verified-blockscout-receipts.jsonl").read_bytes()
        self.assertEqual(B.sha(data),report["verified_receipts_sha256"])
        self.assertEqual(len(data.splitlines()),16)
        for line in (d/"archive.sha256").read_text().splitlines():
            value,name=line.split("  ")
            self.assertEqual(value,B.sha((d/name).read_bytes()))
    def test_changed_parent_zip_fail_closed(self):
        with self.prior.open("ab") as f:f.write(b"tamper")
        with self.assertRaisesRegex(ValueError,"previous Blockscout ZIP SHA256"):
            self.run_batch()
    def test_parent_row_gas_changed_even_with_rehashed_zip_fails(self):
        rows=[copy.deepcopy(self.drpc[tx]) for tx in self.ids[:10]]
        rows[0]["gas_used"]="1"
        self.write_prior(records=rows)
        with patch.object(B,"PREVIOUS_SHA256",B.sha(self.prior.read_bytes())):
            with self.assertRaisesRegex(ValueError,"prior gas arithmetic"):
                self.run_batch()
    def test_source_row_substitution_fail_closed(self):
        rows=[copy.deepcopy(self.drpc[tx]) for tx in self.ids[:10]]
        rows[0]["block_number"]+=1
        self.write_prior(records=rows)
        with patch.object(B,"PREVIOUS_SHA256",B.sha(self.prior.read_bytes())):
            with self.assertRaisesRegex(ValueError,"prior block identity"):
                self.run_batch()
    def test_reordered_receipts_with_exact_rehash_fail(self):
        rows=[self.drpc[tx] for tx in self.ids[:10]][::-1]
        self.write_prior(records=rows)
        with patch.object(B,"PREVIOUS_SHA256",B.sha(self.prior.read_bytes())):
            with self.assertRaisesRegex(ValueError,"exact sorted prefix"):
                self.run_batch()
    def test_missing_parent_row_with_rehashed_zip_fail(self):
        rows=[self.drpc[tx] for tx in self.ids[:9]]
        self.write_prior(records=rows)
        with patch.object(B,"PREVIOUS_SHA256",B.sha(self.prior.read_bytes())):
            with self.assertRaisesRegex(ValueError,"wrong count"):
                self.run_batch()
    def test_wrong_new_receipt_stops_partial_without_false_pass(self):
        def wrong(u,m,p):
            v=copy.deepcopy(self.call(u,m,p))
            if p[0]==self.ids[12]:v["gasUsed"]="0x5209"
            return v
        result=self.run_batch(wrong)
        self.assertEqual(result["verified_receipt_count"],12)
        self.assertEqual(result["new_receipt_count"],2)
        self.assertEqual(result["remaining_receipt_count"],115)
        self.assertFalse(result["all_127_receipts_cross_operator_reconciled"])
        self.assertIn("mismatch",result["failure"]["error"])
    def test_429_prior_to_first_receipt_produces_no_false_increase(self):
        def fail(u,m,p):
            raise ValueError("429 Too Many Requests")
        result=self.run_batch(fail,retry_delays=())
        self.assertEqual(result["verified_receipt_count"],10)
        self.assertEqual(result["new_receipt_count"],0)
        self.assertFalse(result["nexus_realized_pnl_proven"])
    def test_max_new_and_interval_limits(self):
        for max_new in (0,9,True):
            with self.assertRaisesRegex(ValueError,"batch limit"):
                self.run_batch(max_new=max_new)
        for interval in (0,31,False):
            with self.assertRaisesRegex(ValueError,"inter-query"):
                B.collect_batch(self.source,self.drpc_zip,self.prior,
                                self.root/"bad",min_interval=interval)
    def test_append_only_output_no_clobber(self):
        self.run_batch()
        with self.assertRaisesRegex(ValueError,"append-only"):
            self.run_batch()
    def test_second_round_immutable_checkpoint_chain(self):
        first=self.run_batch()
        batch=self.root/"batch"
        chained=self.root/"second-prior.zip"
        with zipfile.ZipFile(chained,"w") as z:
            for p in sorted(batch.iterdir()):
                z.writestr(p.name,p.read_bytes())
        with patch.object(B,"PREVIOUS_SHA256",B.sha(chained.read_bytes())):
            with patch.object(B,"PREVIOUS_RUN_ID",123456):
                result=B.collect_batch(self.source,self.drpc_zip,chained,
                                       self.root/"round2",max_new=6,min_interval=2,
                                       rpc_call=self.call,sleep=lambda _:None)
        self.assertEqual(first["verified_receipt_count"],16)
        self.assertEqual(result["prior_receipt_count"],16)
        self.assertEqual(result["verified_receipt_count"],22)
        self.assertEqual(result["new_receipt_count"],6)

if __name__=="__main__":unittest.main()
