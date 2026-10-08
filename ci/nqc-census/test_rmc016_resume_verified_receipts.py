#!/usr/bin/env python3
"""Adversarial test matrix for real dRPC checkpoint / Blockscout receipt continuation."""
import copy
import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import rmc016_resume_verified_receipts as R
import rmc016_two_operator_receipts as P

SPEC=importlib.util.spec_from_file_location(
    "source_fixture", Path(__file__).with_name("test_rmc016_two_operator_receipts.py"))
S=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)

class ReceiptCheckpointTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root=Path(temp.name)
        self.source,self.source_sha,self.raw_receipts=S.fixture(self.root)
        _,self.events,self.ids=P.load_source(self.source,self.source_sha)
        self.drpc={}
        for tid in self.ids:
            self.drpc[tid]=P.receipt_normalized(tid,self.events[tid],self.raw_receipts[tid])
        self.checkpoint=self.root/"drpc-checkpoint.zip"
        self.write_checkpoint()
        self.patch_source=patch.object(R,"SOURCE_ARTIFACT_SHA256",self.source_sha)
        self.patch_checkpoint=patch.object(R,"DRPC_CHECKPOINT_SHA256",R.sha(self.checkpoint.read_bytes()))
        self.patch_gas=patch.object(
            R,"DRPC_EXPECTED_GAS_WEI",sum(int(row["total_gas_paid_wei"]) for row in self.drpc.values()))
        for p in (self.patch_source,self.patch_checkpoint,self.patch_gas):
            p.start();self.addCleanup(p.stop)

    def write_checkpoint(self,report=None,records=None):
        if report is None:
            report={
                "schema_version":1,"status":"RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED",
                "blocked_at":"blast",
                "independent_receipt_parity_complete":False,
                "nexus_net_pnl_proven":False,
                "source_event_artifact_sha256":self.source_sha,
                "provider_stages":[
                    {"provider_id":"drpc","verified_transaction_count":127},
                    {"provider_id":"blast","verified_transaction_count":6},
                ],
            }
        if records is None:
            records=self.drpc
        data={
            "receipt-parity-report.json":R.canonical(report),
            "verified-drpc-receipts.jsonl":b"".join(R.canonical(records[tid]) for tid in sorted(records)),
        }
        data["archive.sha256"]="".join(
            R.sha(v)+"  "+n+"\n" for n,v in sorted(data.items())).encode()
        with zipfile.ZipFile(self.checkpoint,"w") as z:
            for n,v in data.items():z.writestr(n,v)

    def call(self,url,method,args):
        self.assertEqual(url,"https://eth.blockscout.com/api/eth-rpc")
        self.assertEqual(method,"eth_getTransactionReceipt")
        return self.raw_receipts[args[0]]

    def run_collect(self,callback=None,**kwargs):
        out=self.root/"out"
        return R.collect(self.source,self.checkpoint,out,
            rpc_call=callback or self.call,sleep=lambda _:None,
            minimum_seconds=1,**kwargs)

    def test_real_127_validated_checkpoint_bytes_and_127_blockscout_receipts(self):
        result=self.run_collect()
        self.assertEqual(result["status"],"RMC016_TWO_OPERATOR_RECEIPT_PARITY_HISTORICAL_ONLY")
        self.assertEqual(result["unique_winner_transaction_count"],127)
        self.assertEqual(result["source_liquidation_event_count"],139)
        self.assertEqual(result["independent_receipt_operator_count"],2)
        self.assertEqual(result["gas_paid_wei"],str(127*21000000000000))
        self.assertFalse(result["prior_drpc_workflow_completed_successfully"])
        self.assertFalse(result["nexus_realized_pnl_proven"])
        self.assertFalse(result["nexus_external_gas_funding_proven"])
        self.assertIsNone(result["nexus_monthly_net_pnl_estimate_usd"])
        self.assertTrue((self.root/"out"/"archive.sha256").exists())

    def test_only_the_second_operator_receives_new_RPC_calls(self):
        called=[]
        def spy(url,method,args):
            called.append((url,method))
            return self.call(url,method,args)
        result=self.run_collect(spy)
        self.assertEqual(result["unique_winner_transaction_count"],127)
        self.assertEqual(len(called),127)
        self.assertEqual({x[0] for x in called},{"https://eth.blockscout.com/api/eth-rpc"})

    def test_exact_outer_checkpoint_archive_sha_is_required(self):
        with self.checkpoint.open("ab") as f:f.write(b"changed")
        with self.assertRaisesRegex(ValueError,"archive outer SHA"):
            R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_exact_outer_source_archive_sha_is_required(self):
        with self.source.open("ab") as f:f.write(b"changed")
        with self.assertRaisesRegex(ValueError,"source ZIP SHA"):
            R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_forged_checkpoint_workflow_claim_fails(self):
        self.assertEqual(R.authenticated_drpc_checkpoint(self.checkpoint,self.source)[2],self.ids)
        with zipfile.ZipFile(self.checkpoint) as z:
            report=json.loads(z.read("receipt-parity-report.json"))
        report["independent_receipt_parity_complete"]=True
        self.write_checkpoint(report=report)
        with patch.object(R,"DRPC_CHECKPOINT_SHA256",R.sha(self.checkpoint.read_bytes())):
            with self.assertRaisesRegex(ValueError,"predecessor provenance"):
                R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_missing_drpc_row_rejected_even_if_zip_rehashed(self):
        rows=dict(self.drpc)
        rows.pop(self.ids[-1])
        self.write_checkpoint(records=rows)
        with patch.object(R,"DRPC_CHECKPOINT_SHA256",R.sha(self.checkpoint.read_bytes())):
            with self.assertRaisesRegex(ValueError,"127 receipts"):
                R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_gas_witness_tampering_detected(self):
        rows=copy.deepcopy(self.drpc)
        tid=self.ids[0]
        rows[tid]["gas_used"]="42"
        self.write_checkpoint(records=rows)
        with patch.object(R,"DRPC_CHECKPOINT_SHA256",R.sha(self.checkpoint.read_bytes())):
            with self.assertRaisesRegex(ValueError,"gas arithmetic"):
                R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_blockscout_mismatch_keeps_source_unmodified_and_fails_closed(self):
        tid=self.ids[0]
        def wrong(url,method,args):
            r=copy.deepcopy(self.call(url,method,args))
            if args[0]==tid:r["gasUsed"]="0x5209"
            return r
        result=self.run_collect(wrong)
        self.assertEqual(result["status"],"RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED")
        self.assertEqual(result["blockscout_receipts_verified"],0)
        self.assertFalse(result["independent_receipt_parity_complete"])
        self.assertFalse(result["nexus_realized_pnl_proven"])

    def test_unavailable_blockscout_fails_closed(self):
        result=self.run_collect(lambda u,m,p:None)
        self.assertEqual(result["status"],"RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED")
        self.assertIn("missing historical receipt",result["failures"][0]["error"])

    def test_retry_429_backoff_limited_and_recoverable(self):
        counts={}
        waits=[]
        def transient(url,method,args):
            tid=args[0]
            counts[tid]=counts.get(tid,0)+1
            if tid==self.ids[0] and counts[tid]==1:
                raise ValueError("HTTPError: 429 Too Many Requests")
            return self.call(url,method,args)
        out=self.root/"out"
        result=R.collect(self.source,self.checkpoint,out,rpc_call=transient,
            sleep=waits.append,minimum_seconds=1,retry_delays=(15,30))
        self.assertEqual(result["status"],"RMC016_TWO_OPERATOR_RECEIPT_PARITY_HISTORICAL_ONLY")
        self.assertEqual(counts[self.ids[0]],2)
        self.assertIn(15,waits)
        self.assertNotIn(30,waits)

    def test_non_429_error_never_retries(self):
        calls=[]
        def fail(url,method,args):
            calls.append(args[0])
            raise ValueError("HTTP 403 forbidden")
        result=self.run_collect(fail)
        self.assertEqual(len(calls),1)
        self.assertEqual(result["status"],"RMC016_SECOND_OPERATOR_RECEIPT_VALIDATION_BLOCKED")
        self.assertIn("403",result["failures"][0]["error"])

    def test_partial_checkpoint_remains_verifiable_on_twentieth_failure(self):
        count=[0]
        def fail20(url,method,args):
            count[0]+=1
            if count[0]==20:raise ValueError("HTTP 403 forbidden")
            return self.call(url,method,args)
        result=self.run_collect(fail20)
        self.assertEqual(result["blockscout_receipts_verified"],19)
        raw=(self.root/"out"/"verified-blockscout-receipts.jsonl").read_bytes()
        self.assertEqual(len(raw.splitlines()),19)
        self.assertEqual(result["partial_evidence_sha256"],R.sha(raw))
        hashes=(self.root/"out"/"archive.sha256").read_text().splitlines()
        self.assertTrue(all(R.sha((self.root/"out"/line.split("  ")[1]).read_bytes())==
                            line.split("  ")[0] for line in hashes))

    def test_duplicate_archive_members_rejected(self):
        with zipfile.ZipFile(self.checkpoint,"a") as z:
            z.writestr("receipt-parity-report.json",b'{}')
        with patch.object(R,"DRPC_CHECKPOINT_SHA256",R.sha(self.checkpoint.read_bytes())):
            with self.assertRaisesRegex(ValueError,"members"):
                R.authenticated_drpc_checkpoint(self.checkpoint,self.source)

    def test_output_append_only(self):
        result=self.run_collect()
        with self.assertRaisesRegex(ValueError,"append-only"):
            self.run_collect()

    def test_invalid_rate_control_fails(self):
        with self.assertRaisesRegex(ValueError,"rate control"):
            R.collect(self.source,self.checkpoint,self.root/"out",
                minimum_seconds=0,sleep=lambda _:None,rpc_call=self.call)

if __name__=="__main__":
    unittest.main()
