#!/usr/bin/env python3
"""Adversarial tests for immutable dRPC witness reuse and Blockscout parity."""
from __future__ import annotations
import copy,importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
P=Path(__file__).with_name("rmc016_reuse_drpc_blockscout.py")
S=importlib.util.spec_from_file_location("model",P)
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)

def witness(i):
    tid="0x"+f"{i+1:064x}"
    r={"transaction_hash":tid,"block_number":26000000+i,
       "block_hash":"0x"+f"{i+9:064x}","transaction_index":i,
       "liquidation_event_count":1,"gas_used":"21000",
       "effective_gas_price_wei":"1000000000",
       "execution_gas_wei":"21000000000000","blob_gas_wei":"0",
       "total_gas_paid_wei":"21000000000000"}
    r["receipt_evidence_sha256"]=M.sha(M.canonical(r))
    return r
def fake_source():
    rows={r["transaction_hash"]:r for r in [witness(i) for i in range(127)]}
    ev={key:[{"block_number":val["block_number"],"block_hash":val["block_hash"],
              "transaction_index":val["transaction_index"],"log_index":i}]
        for i,(key,val) in enumerate(rows.items())}
    return ev,sorted(rows),rows

class HistoricalReuseTests(unittest.TestCase):
    def test_stratification_and_cardinality(self):
        ids=fake_source()[1]
        for n in (1,2,6,12,126,127):
            chosen=M.choose_ids(ids,n)
            self.assertEqual(len(chosen),n)
            self.assertEqual(len(set(chosen)),n)
            self.assertTrue(set(chosen).issubset(ids))
        self.assertEqual(M.choose_ids(ids,127),ids)
    def test_invalid_sampling_fails_closed(self):
        ids=fake_source()[1]
        for n in (True,False,0,128,-1,3.4):
            with self.assertRaises(ValueError):
                M.choose_ids(ids,n)
    def test_twelve_from_other_operator_never_promoted_to_complete(self):
        source=fake_source()
        def call(url,method,params):
            return {"fixture_normalized":source[2][params[0]]}
        with patch.object(M,"admitted_drpc",return_value=source),\
             patch.object(M,"receipt_normalized",side_effect=lambda tid,evt,raw:raw["fixture_normalized"]):
            result,records=M.audit(Path("a"),Path("b"),12,call=call)
        self.assertEqual(len(records),12)
        self.assertFalse(result["complete_independent_receipt_parity"])
        self.assertEqual(result["status"],"RMC016_BLOCKSCOUT_DRPC_RECEIPT_SAMPLE_PASS")
        self.assertIsNone(result["all_127_receipt_gas_wei_proven_by_two_operators"])
        self.assertFalse(result["nexus_pnl_proven"])
    def test_complete_two_operator_parity_never_nexus_net(self):
        source=fake_source()
        with patch.object(M,"admitted_drpc",return_value=source),\
             patch.object(M,"receipt_normalized",side_effect=lambda tid,evt,raw:raw["fixture_normalized"]):
            result,records=M.audit(Path("a"),Path("b"),127,
                call=lambda u,m,p:{"fixture_normalized":source[2][p[0]]})
        self.assertEqual(result["blockscout_verified_receipt_count"],127)
        self.assertTrue(result["complete_independent_receipt_parity"])
        self.assertEqual(result["all_127_receipt_gas_wei_proven_by_two_operators"],
                         str(127*21000000000000))
        self.assertFalse(result["nexus_capture_probability_calibrated"])
        self.assertFalse(result["historical_127_gas_usd_valued"])
        self.assertIsNone(result["nexus_monthly_net_pnl_usd"])
    def test_missing_external_receipt_blocks_full_claim(self):
        source=fake_source()
        def call(u,m,p):
            if p[0]==source[1][3]:raise RuntimeError("HTTP 429")
            return {"fixture_normalized":source[2][p[0]]}
        with patch.object(M,"admitted_drpc",return_value=source),\
             patch.object(M,"receipt_normalized",side_effect=lambda tid,evt,raw:raw["fixture_normalized"]):
            result,records=M.audit(Path("a"),Path("b"),127,call=call)
        self.assertEqual(len(records),3)
        self.assertFalse(result["complete_independent_receipt_parity"])
        self.assertEqual(result["status"],"RMC016_BLOCKSCOUT_DRPC_RECEIPT_PARITY_BLOCKED")
        self.assertIn("429",result["blocked_reason"])
    def test_changed_external_gas_rejected(self):
        source=fake_source()
        def call(u,m,p):
            r=copy.deepcopy(source[2][p[0]])
            if p[0]==M.choose_ids(source[1],12)[2]:
                r["gas_used"]="99999"
            return {"fixture_normalized":r}
        with patch.object(M,"admitted_drpc",return_value=source),\
             patch.object(M,"receipt_normalized",side_effect=lambda tid,evt,raw:raw["fixture_normalized"]):
            result,records=M.audit(Path("a"),Path("b"),12,call=call)
        self.assertEqual(len(records),2)
        self.assertIn("receipt disagreement",result["blocked_reason"])
    def test_drpc_error_report_not_success(self):
        _,_,rows=fake_source()
        report=({"status":"RMC016_HISTORICAL_WINNER_RECEIPT_PARITY_BLOCKED",
                 "source_event_artifact_sha256":M.SOURCE_SHA,
                 "provider_stages":[{"provider_id":"drpc","verified_transaction_count":127},
                                    {"provider_id":"blast","verified_transaction_count":6}],
                 "nexus_net_pnl_proven":False,
                 "independent_receipt_parity_complete":False})
        self.assertNotEqual(report["status"],"RMC016_TWO_OPERATOR_127_RECEIPT_PARITY_PASS_NO_NET_CLAIM")
    def test_hard_pinned_source_digest(self):
        self.assertEqual(len(M.SOURCE_SHA),64)
        self.assertEqual(len(M.DRPC_PARTIAL_ZIP_SHA),64)
        self.assertEqual(len(M.DRPC_ROWS_SHA),64)
        self.assertEqual(len({M.SOURCE_SHA,M.DRPC_PARTIAL_ZIP_SHA,M.DRPC_ROWS_SHA}),3)
    def test_output_checksum_and_append_only(self):
        report={"status":"TEST","commitment_sha256":"0"*64}
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)/"out"
            M.output_file(folder,report,[witness(1)])
            sha_row=(folder/"archive.sha256").read_text().splitlines()
            self.assertEqual(len(sha_row),2)
            for r in sha_row:
                digest,name=r.split("  ")
                self.assertEqual(digest,M.sha((folder/name).read_bytes()))
            with self.assertRaises(ValueError):
                M.output_file(folder,report,[])
    def test_nonnegative_integer_gas_and_no_counterfeit_claims(self):
        _,_,rows=fake_source()
        out,_=M.make_report(list(rows),list(rows),rows,list(rows.values()),None)
        self.assertFalse(out["historical_127_gas_usd_valued"])
        self.assertFalse(out["independent_full_historical_event_discovery_proven"])
        self.assertFalse(out["nexus_external_capital_and_gas_proven"])
        self.assertFalse(out["nexus_pnl_proven"])

if __name__=="__main__":unittest.main()
