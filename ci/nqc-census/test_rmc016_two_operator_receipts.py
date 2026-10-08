#!/usr/bin/env python3
"""Offline adversarial receipt parity fixture; no live financial claim."""
import copy, hashlib, importlib.util, json, tempfile, unittest, zipfile
from pathlib import Path
S=importlib.util.spec_from_file_location("receipt",Path(__file__).with_name("rmc016_two_operator_receipts.py"))
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)

def eventrow(i):
    ti=i if i<127 else i-127
    tx="0x"+f"{ti+1:064x}"
    return {"address":M.AAVE_POOL,"topics":[M.LIQUIDATION_TOPIC]+["0x"+"1"*64]*3,
        "data":"0x"+"0"*256,"blockNumber":hex(M.START_BLOCK),"blockHash":M.START_HASH,
        "transactionHash":tx,"transactionIndex":hex(ti),"logIndex":hex(i),"removed":False}

def fixture(root):
    raw=[eventrow(i) for i in range(139)]
    events=[M.event(e,M.START_BLOCK,M.END_BLOCK) for e in raw]
    events.sort(key=lambda x:(x["block_number"],x["transaction_index"],x["log_index"],
                             x["transaction_hash"]))
    txids=sorted({e["transaction_hash"] for e in events})
    assert len(txids)==127
    ledger=b"".join(M.canonical(x) for x in events)
    txdata=b"".join((x+"\n").encode() for x in txids)
    report={"schema_version":1,"status":"RMC016_SINGLE_SOURCE_WINNER_EVENTS_COUNTS_RECONCILED",
        "provider_id":"blockscout","independent_provider_consensus":False,
        "counts_match_source_certificate":True,"coverage_complete":True,
        "liquidation_event_count":139,"unique_winner_transaction_count":127,
        "nexus_pnl_proven":False,
        "source_window":{"start_block":M.START_BLOCK,"start_hash":M.START_HASH,
                         "end_block":M.END_BLOCK,"end_hash":M.END_HASH},
        "events_sha256":M.sha(ledger),"transactions_sha256":M.sha(txdata)}
    files={"discovery-report.json":M.canonical(report),"liquidation-events.jsonl":ledger,
           "winner-transactions.txt":txdata}
    files["archive.sha256"]="".join(M.sha(v)+"  "+k+"\n" for k,v in sorted(files.items())).encode()
    p=root/"source.zip"
    with zipfile.ZipFile(p,"w") as z:
        for k,v in files.items():z.writestr(k,v)
    receipts={}
    for tx in txids:
        associated=[r for r in raw if r["transactionHash"]==tx]
        receipts[tx]={"transactionHash":tx,"status":"0x1",
          "blockHash":M.START_HASH,"blockNumber":hex(M.START_BLOCK),
          "transactionIndex":associated[0]["transactionIndex"],
          "effectiveGasPrice":"0x3b9aca00","gasUsed":"0x5208",
          "logs":associated}
    return p,M.sha(p.read_bytes()),receipts

class ReceiptParity(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup)
        self.root=Path(t.name)
        self.archive,self.digest,self.good=fixture(self.root)
    def test_complete_127_receipt_parity_only_not_nexus_net(self):
        result,rows=M.reconcile(self.good,copy.deepcopy(self.good),self.archive,self.digest)
        self.assertEqual(result["winner_transaction_count"],127)
        self.assertEqual(result["event_count"],139)
        self.assertEqual(len(rows),127)
        self.assertEqual(result["gas_paid_wei"],str(127*21000000000000))
        self.assertFalse(result["independent_source_log_completeness_certified"])
        self.assertFalse(result["nexus_net_pnl_proven"])
        self.assertFalse(result["gas_usd_conversion_completed"])
    def test_source_zip_mutation_rejected(self):
        with self.archive.open("ab") as f:f.write(b"x")
        with self.assertRaisesRegex(ValueError,"source ZIP SHA"):
            M.load_source(self.archive,self.digest)
    def test_missing_transaction_receipt_fails(self):
        b=copy.deepcopy(self.good);b.pop(next(iter(b)))
        with self.assertRaisesRegex(ValueError,"incomplete independent receipt universe"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_second_provider_gas_substitution_rejected(self):
        b=copy.deepcopy(self.good)
        tid=next(iter(b));b[tid]["gasUsed"]="0x5209"
        with self.assertRaisesRegex(ValueError,"independent provider receipt disagreement"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_failed_winner_receipt_rejected(self):
        b=copy.deepcopy(self.good)
        b[next(iter(b))]["status"]="0x0"
        with self.assertRaisesRegex(ValueError,"winner reverted"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_receipt_wrong_block_hash_rejected(self):
        b=copy.deepcopy(self.good)
        b[next(iter(b))]["blockHash"]="0x"+"1"*64
        with self.assertRaisesRegex(ValueError,"receipt block/index"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_receipt_missing_liquidation_logs_rejected(self):
        b=copy.deepcopy(self.good)
        b[next(iter(b))]["logs"]=[]
        with self.assertRaisesRegex(ValueError,"receipt logs"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_duplicated_jsonl_is_not_accepted(self):
        with zipfile.ZipFile(self.archive,"r") as z:
            files={n:z.read(n) for n in z.namelist()}
        lines=files["liquidation-events.jsonl"].splitlines(keepends=True)
        files["liquidation-events.jsonl"]=b"".join(lines+[lines[0]])
        files["archive.sha256"]="".join(M.sha(v)+"  "+k+"\n" for k,v in sorted(files.items()) if k!="archive.sha256").encode()
        with zipfile.ZipFile(self.archive,"w") as z:
            for k,v in files.items():z.writestr(k,v)
        with self.assertRaises(ValueError):
            M.load_source(self.archive,M.sha(self.archive.read_bytes()))
    def test_wrong_window_claim_rejected(self):
        with zipfile.ZipFile(self.archive,"r") as z:
            files={n:z.read(n) for n in z.namelist()}
        report=json.loads(files["discovery-report.json"])
        report["source_window"]["start_block"]+=1
        files["discovery-report.json"]=M.canonical(report)
        files["archive.sha256"]="".join(M.sha(v)+"  "+k+"\n" for k,v in sorted(files.items()) if k!="archive.sha256").encode()
        with zipfile.ZipFile(self.archive,"w") as z:
            for k,v in files.items():z.writestr(k,v)
        with self.assertRaisesRegex(ValueError,"source anchor drift"):
            M.load_source(self.archive,M.sha(self.archive.read_bytes()))
    def test_incomplete_blob_gas_evidence_rejected(self):
        b=copy.deepcopy(self.good)
        b[next(iter(b))]["blobGasUsed"]="0x5"
        with self.assertRaisesRegex(ValueError,"blob fee"):
            M.reconcile(self.good,b,self.archive,self.digest)
    def test_raw_eth_gas_never_becomes_usd_profit(self):
        r,records=M.reconcile(self.good,self.good,self.archive,self.digest)
        self.assertNotIn("usd",r["gas_paid_wei"])
        self.assertIsNone(r["monthly_nexus_pnl_usd"])
        self.assertTrue(all(int(x["total_gas_paid_wei"])>=0 for x in records))

if __name__=="__main__":unittest.main()
