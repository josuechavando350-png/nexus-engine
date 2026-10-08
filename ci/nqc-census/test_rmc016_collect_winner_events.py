#!/usr/bin/env python3
"""Adversarial offline fixtures for exact Ethereum liquidation event recovery."""
import importlib.util, json, tempfile, unittest
from pathlib import Path
P=Path(__file__).with_name("rmc016_collect_winner_events.py")
S=importlib.util.spec_from_file_location("scanner",P)
M=importlib.util.module_from_spec(S)
S.loader.exec_module(M)

def make_logs():
    result=[]
    for i in range(139):
        ti=i if i<127 else i-127
        h="0x"+f"{ti+1:064x}"
        result.append({
           "address": M.AAVE_POOL,"topics":[M.LIQUIDATION_TOPIC]+["0x"+"1"*64]*3,
           "transactionHash":h,"transactionIndex":hex(ti),"blockNumber":hex(M.START_BLOCK),
           "blockHash":M.START_HASH,"logIndex":hex(i),"removed":False,"data":"0x"+"0"*256})
    return result

def block(n):
    return {"number":hex(n),"hash":M.START_HASH if n==M.START_BLOCK else M.END_HASH,
            "parentHash":"0x"+"2"*64,"stateRoot":"0x"+"3"*64,
            "timestamp":"0x66300000"}

def fake(rows=None, break_at=None, failure=None, missing_receipt=False):
    rows=make_logs() if rows is None else rows
    def call(url,method,params):
        if break_at==method:raise ValueError(failure or "historical block range limit")
        if method=="eth_chainId":return "0x1"
        if method=="eth_getBlockByNumber":return block(int(params[0],16))
        if method=="eth_getLogs":
            lo=int(params[0]["fromBlock"],16)
            hi=int(params[0]["toBlock"],16)
            if failure=="too-wide" and hi-lo>1024:raise ValueError("block range exceeds maximum")
            return [r for r in rows if lo<=int(r["blockNumber"],16)<=hi]
        if method=="eth_getTransactionReceipt":
            if missing_receipt:return None
            txid=params[0]
            specific=[x for x in rows if x["transactionHash"]==txid]
            return {"transactionHash":txid,"blockNumber":hex(M.START_BLOCK),
                    "blockHash":M.START_HASH,"status":"0x1",
                    "gasUsed":"0x5208","effectiveGasPrice":"0x3b9aca00",
                    "logs":[{"address":M.AAVE_POOL,"topics":[M.LIQUIDATION_TOPIC],
                              "blockHash":M.START_HASH,"logIndex":x["logIndex"]}
                             for x in specific]}
        raise ValueError("unsupported fake method")
    return call

class FullHistoricalDiscovery(unittest.TestCase):
    @property
    def provider(self):
        return next(x for x in M.PROVIDERS if x[0]=="blockscout")
    def test_full_139_event_127_unique_hash_conservation(self):
        result,events,txids,gas=M.gather(self.provider,fake(),chunk=4096,receipts=True)
        self.assertTrue(result["coverage_complete"])
        self.assertTrue(result["counts_match_source_certificate"])
        self.assertEqual(len(events),139)
        self.assertEqual(len(txids),127)
        self.assertEqual(len(gas),127)
        self.assertEqual(int(result["observed_market_gas_wei"]),127*21000000000000)
        self.assertFalse(result["independent_provider_consensus"])
        self.assertFalse(result["nexus_pnl_proven"])
        self.assertFalse(result["own_capital_funding_proven"])
    def test_determinism_of_evidence_sha(self):
        a=M.gather(self.provider,fake(),chunk=2048)[0]
        b=M.gather(self.provider,fake(),chunk=2048)[0]
        self.assertEqual(a["events_sha256"],b["events_sha256"])
        self.assertEqual(a["transactions_sha256"],b["transactions_sha256"])
    def test_different_chunk_sizes_reproduce_same_events(self):
        a=M.gather(self.provider,fake(),chunk=4096)[0]
        b=M.gather(self.provider,fake(),chunk=16384)[0]
        self.assertEqual(a["events_sha256"],b["events_sha256"])
        self.assertNotEqual(a["shards_sha256"],b["shards_sha256"])
    def test_duplicate_log_must_fail_closed(self):
        rows=make_logs()
        rows.append(rows[0])
        report,*_=M.gather(self.provider,fake(rows),chunk=8192)
        self.assertEqual(report["status"],"RMC016_FULL_HISTORICAL_LOG_RECOVERY_BLOCKED")
        self.assertIn("duplicated log",report["failure"])
    def test_failed_reorg_removed_log_rejected(self):
        rows=make_logs()
        rows[0]["removed"]=True
        report,*_=M.gather(self.provider,fake(rows))
        self.assertFalse(report["coverage_complete"])
        self.assertIn("reorg",report["failure"])
    def test_event_outside_requested_window_rejected(self):
        row=make_logs()[0]
        row["blockNumber"]=hex(M.START_BLOCK-1)
        with self.assertRaises(ValueError):
            M.event(row,M.START_BLOCK,M.END_BLOCK)
    def test_per_transaction_event_mismatch_rejected(self):
        rows=make_logs()
        def modified(url,method,params):
            r=fake(rows)(url,method,params)
            if method=="eth_getTransactionReceipt" and params[0]==rows[0]["transactionHash"]:
                r["logs"]=[]
            return r
        report,*_=M.gather(self.provider,modified,receipts=True)
        self.assertIn("receipt liquidation logs",report["failure"])
    def test_missing_receipt_keeps_net_unproven(self):
        report,*_=M.gather(self.provider,fake(missing_receipt=True),receipts=True)
        self.assertFalse(report["coverage_complete"])
        self.assertFalse(report["nexus_pnl_proven"])
    def test_window_bisection_preserves_exhaustive_count(self):
        result,events,*_=M.gather(self.provider,fake(failure="too-wide"),chunk=8192,call_budget=1200)
        self.assertTrue(result["counts_match_source_certificate"])
        self.assertEqual(len(events),139)
        self.assertGreater(result["shard_count"],27)
    def test_permission_denied_is_not_bisected(self):
        result,*_=M.gather(self.provider,fake(break_at="eth_getLogs",failure="403 forbidden"))
        self.assertFalse(result["coverage_complete"])
        self.assertLess(result["rpc_calls"],8)
    def test_hard_call_budget_rejected(self):
        result,*_=M.gather(self.provider,fake(),chunk=1024,call_budget=10)
        self.assertEqual(result["status"],"RMC016_FULL_HISTORICAL_LOG_RECOVERY_BLOCKED")
        self.assertIn("BUDGET",result["failure"])
    def test_one_missing_log_cannot_be_promoted_as_127(self):
        rows=make_logs()[1:]
        result,*_=M.gather(self.provider,fake(rows))
        self.assertTrue(result["coverage_complete"])
        self.assertFalse(result["counts_match_source_certificate"])
        self.assertFalse(result["nexus_pnl_proven"])
    def test_partial_range_cannot_claim_monthly_count(self):
        result,*_=M.gather(self.provider,fake(),start=M.START_BLOCK,
                             end=M.START_BLOCK+5,strict_counts=False)
        self.assertFalse(result["counts_match_source_certificate"])
    def test_forged_provider_rejected(self):
        with self.assertRaises(ValueError):
            M.gather(("sham","Blockscout","https://evil.invalid"),fake())
    def test_report_append_only_and_checksums(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"output"
            report,events,ids,gas=M.gather(self.provider,fake(),receipts=True)
            M.write_report(path,report,events,ids,gas)
            for line in (path/"archive.sha256").read_text().splitlines():
                digest,name=line.split("  ")
                self.assertEqual(M.sha((path/name).read_bytes()),digest)
            with self.assertRaises(ValueError):
                M.write_report(path,report,events,ids,gas)

if __name__=="__main__":
    unittest.main()
