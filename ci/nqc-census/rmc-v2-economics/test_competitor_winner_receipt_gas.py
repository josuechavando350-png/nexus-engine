"""Adversarial receipt conservation / gas accounting for EXACT 47 winner txs."""
from __future__ import annotations

from hashlib import sha256
import copy
import os
from pathlib import Path
import unittest

import competitor_winner_receipt_gas as m


START = 26_100_000
BASE_WEI = 13_000_000_000
PRIO_WEI = 2_000_000_000
TX_INDEX = 3


def address(n):
    return "0x"+f"{n:040x}"


def topic_address(n):
    return "0x"+"0"*24+address(n)[2:]


def h32(n):
    return "0x"+sha256(str(n).encode()).hexdigest()


def raw_liquidation_data(i):
    vals=[i+1,2*(i+1),int(address(5000),16),0]
    return "0x"+"".join(f"{v:064x}" for v in vals)


def make_log(block,tx,txidx,logidx,pair_id):
    collateral=100+pair_id
    debt=300+pair_id
    return {
        "address":m.index.POOL,
        "topics":[m.index.TOPIC,topic_address(collateral),
                  topic_address(debt),topic_address(2000+pair_id)],
        "data":raw_liquidation_data(logidx),
        "blockNumber":hex(block),"transactionHash":tx,
        "transactionIndex":hex(txidx),"logIndex":hex(logidx),
        "removed":False,
        "blockHash":h32(block),
    }


def fixtures():
    report={"indexed_event_count":53,
            "unique_indexed_winner_tx_count":47,
            "unique_indexed_pair_count":21,
            "source_rest_indexer_full_onchain_completeness":False}
    rows=[]
    for i in range(47):
        block=START+i-int(i>=10)-int(i>=20)
        tx=h32(10_000+i)
        count=(2 if i in (0,1) else 3 if i in (2,3) else 1)
        for k in range(count):
            log=make_log(block,tx,TX_INDEX+i%3,i*10+k,(i+k)%21)
            row=m.index.normalize(log,m.index.POST_START,m.index.POST_END)
            rows.append(row)
    assert len(rows)==53
    grouped,blocks=m.group_indexed_events(report,rows)
    return report,rows,grouped,blocks


def build_header(block):
    return {"number":hex(block),"hash":h32(block),
            "parentHash":h32(block-1),
            "stateRoot":h32(block+1_000_000),
            "timestamp":hex(1_797_000_000+(block-START)*12),
            "baseFeePerGas":hex(BASE_WEI),"gasLimit":hex(30_000_000)}


def build_receipt(item):
    logs=[]
    for row in item["source_rows"]:
        logs.append(make_log(item["block_number"],item["tx_hash"],
                             item["transaction_index"],row["log_index"],
                             int(row["collateral_asset"],16)-100))
    gas=320_000+item["block_number"]%13*1_000
    return {"transactionHash":item["tx_hash"],
            "blockHash":h32(item["block_number"]),
            "blockNumber":hex(item["block_number"]),
            "transactionIndex":hex(item["transaction_index"]),
            "status":"0x1","type":"0x2",
            "gasUsed":hex(gas),
            "effectiveGasPrice":hex(BASE_WEI+PRIO_WEI),
            "logs":logs}


def fake_rpc(grouped,blocks,*,side=None,mutate=None,trace=None):
    def handler(url,method,params):
        if trace is not None:trace.append((url,method,copy.deepcopy(params)))
        if method=="eth_chainId":return "0x1"
        if method=="eth_getBlockByNumber":
            height=int(params[0],16)
            assert height in blocks
            out=build_header(height)
            if mutate=="block" and side=="publicnode" and height==blocks[-1]:
                out["hash"]=h32(height+50123)
            return out
        if method=="eth_getTransactionReceipt":
            assert params[0] in grouped
            item=grouped[params[0]]
            r=build_receipt(item)
            if mutate=="revert" and side=="publicnode":
                r["status"]="0x0"
            if mutate=="fee" and side=="publicnode":
                r["effectiveGasPrice"]=hex(BASE_WEI+PRIO_WEI+1)
            if mutate=="missing-log" and side=="publicnode":
                r["logs"]=[]
            if mutate=="rate-limit" and side=="publicnode":
                raise OSError("HTTP429 no retry")
            return r
        raise AssertionError("Forbidden method")
    return handler


class CompetitorGasTruthTests(unittest.TestCase):
    def setUp(self):
        self.report,self.rows,self.grouped,self.blocks=fixtures()

    def test_source_grouping_47_unique_txs_53_events_45_blocks(self):
        self.assertEqual(len(self.grouped),47)
        self.assertEqual(sum(len(x["source_rows"]) for x in self.grouped.values()),53)
        self.assertEqual(len(self.blocks),45)

    def test_forty_seven_receipts_and_exact_cost_conservation(self):
        result=m.build(self.report,self.rows,
                       lambda name:fake_rpc(self.grouped,self.blocks,side=name))
        self.assertEqual(result["status"],
                         "TWO_URL_47_COMPETITOR_RECEIPTS_GAS_PARITY_NO_NQC_GAS")
        self.assertTrue(result["complete_two_url_receipt_parity"])
        self.assertEqual(result["source_unique_event_bearing_blocks"],45)
        self.assertEqual(result["sources"]["drpc"]["rpc_calls_used"],95)
        self.assertEqual(result["sources"]["publicnode"]["rpc_calls_used"],95)
        samples=result["sources"]["drpc"]["witnesses"]
        self.assertEqual(len(samples),47)
        self.assertEqual(sum(x["source_liquidation_log_count"] for x in samples),53)
        for s in samples:
            self.assertEqual(s["total_receipt_native_fee_wei"],
                             s["base_fee_burn_wei"]+
                             s["priority_fee_paid_wei"]+
                             s["blob_fee_paid_wei"])
        d=result["competitor_gas_statistics"]
        self.assertEqual(d["sample_size_distinct_paid_competitor_transactions"],47)
        self.assertEqual(d["source_aave_liquidation_logs_verified"],53)
        self.assertEqual(d["native_gas_paid_by_distinct_competitors_wei"],
                         sum(x["total_receipt_native_fee_wei"] for x in samples))
        self.assertTrue(d["not_equivalent_to_nqc_cold_transaction_gas"])
        self.assertFalse(result["nqc_net_ev_proven"])
        self.assertEqual(result["nqc_realized_pnl_usd"],"0")

    def test_multi_liquidation_logs_do_not_duplicate_paid_gas(self):
        r=m.build(self.report,self.rows,
                  lambda name:fake_rpc(self.grouped,self.blocks,side=name))
        samples=r["sources"]["drpc"]["witnesses"]
        self.assertEqual(sum(x["source_liquidation_log_count"]-1
                             for x in samples),6)
        self.assertEqual(sum(x["total_receipt_native_fee_wei"]
                             for x in samples),
                         r["competitor_gas_statistics"]
                           ["native_gas_paid_by_distinct_competitors_wei"])

    def test_nearest_rank_distributions_not_probabilities(self):
        data=list(range(1,48))
        self.assertEqual([m.nearest_rank(data,p) for p in (50,90,99)],
                         [24,43,47])
        self.assertEqual(m.nearest_rank(data,100),47)
        with self.assertRaises(m.Rejected):
            m.nearest_rank([],50)

    def test_failed_canonical_receipt_not_a_zero_gas_winner(self):
        x=self.grouped[next(iter(self.grouped))]
        receipt=build_receipt(x)
        receipt["status"]="0x0"
        with self.assertRaises(m.Rejected):
            m.verify_competitor_receipt(
                receipt,x,m.verify_header(build_header(x["block_number"]),
                                          x["block_number"]))

    def test_recipient_log_event_wrong_raw_amount_fails_closed(self):
        x=next(iter(self.grouped.values()))
        receipt=build_receipt(x)
        receipt["logs"][0]["data"]=raw_liquidation_data(100000)
        with self.assertRaises(m.Rejected):
            m.verify_competitor_receipt(receipt,x,
                m.verify_header(build_header(x["block_number"]),x["block_number"]))

    def test_missing_one_competitor_log_fails_closed(self):
        x=next(v for v in self.grouped.values() if len(v["source_rows"])>1)
        receipt=build_receipt(x)
        receipt["logs"].pop()
        with self.assertRaises(m.Rejected):
            m.verify_competitor_receipt(receipt,x,
                m.verify_header(build_header(x["block_number"]),x["block_number"]))

    def test_source_rpc_transport_error_is_incomplete_not_empty_market(self):
        out=m.build(self.report,self.rows,lambda name:
                    fake_rpc(self.grouped,self.blocks,side=name,mutate="rate-limit"))
        self.assertEqual(out["status"],"INCOMPLETE_COMPETITOR_RECEIPT_GAS_NOT_NQC_NET")
        self.assertFalse(out["complete_two_url_receipt_parity"])
        self.assertIsNone(out["competitor_gas_statistics"])
        self.assertTrue(out["sources"]["publicnode"]["errors"])
        self.assertEqual(out["sources"]["drpc"]["receipts_verified"],47)

    def test_wrong_block_hash_fails_closed(self):
        out=m.build(self.report,self.rows,lambda name:
                    fake_rpc(self.grouped,self.blocks,side=name,mutate="block"))
        self.assertEqual(out["status"],"INCOMPLETE_COMPETITOR_RECEIPT_GAS_NOT_NQC_NET")
        self.assertEqual(out["sources"]["publicnode"]["receipts_verified"],0)

    def test_wrong_fee_parity_never_promoted_to_success(self):
        with self.assertRaises(m.Rejected):
            m.build(self.report,self.rows,lambda name:
                    fake_rpc(self.grouped,self.blocks,side=name,mutate="fee"))

    def test_pure_rpc_allowlist_blocks_broadcast(self):
        rpc=m.RPC("drpc",set(self.grouped),set(self.blocks),
                  fake_rpc(self.grouped,self.blocks))
        for method,params in (("eth_sendRawTransaction",["0xab"]),
                              ("eth_getTransactionReceipt",[h32(-1234)]),
                              ("eth_getBlockByNumber",["pending",True])):
            with self.assertRaises(m.Rejected):
                rpc.call(method,params)
        self.assertEqual(rpc.calls,0)

    def test_base_fee_exceeding_effective_gas_is_rejected(self):
        x=next(iter(self.grouped.values()))
        receipt=build_receipt(x)
        receipt["effectiveGasPrice"]=hex(BASE_WEI-1)
        with self.assertRaises(m.Rejected):
            m.verify_competitor_receipt(receipt,x,
                m.verify_header(build_header(x["block_number"]),x["block_number"]))

    def test_eip4844_blob_fee_extra_without_double_count(self):
        x=next(iter(self.grouped.values()))
        receipt=build_receipt(x)
        receipt.update({"type":"0x3","blobGasUsed":"0x20000","blobGasPrice":"0x42"})
        witness=m.verify_competitor_receipt(receipt,x,
            m.verify_header(build_header(x["block_number"]),x["block_number"]))
        self.assertEqual(witness["blob_fee_paid_wei"],0x20000*0x42)
        self.assertEqual(witness["total_receipt_native_fee_wei"],
                         witness["original_competitor_receipt_gas_used"]*
                         (BASE_WEI+PRIO_WEI)+0x20000*0x42)

    def test_blob_receipt_partial_fields_rejected(self):
        x=next(iter(self.grouped.values()))
        receipt=build_receipt(x)
        receipt.update({"type":"0x3","blobGasUsed":"0x20000"})
        with self.assertRaises(m.Rejected):
            m.verify_competitor_receipt(receipt,x,
                m.verify_header(build_header(x["block_number"]),x["block_number"]))

    def test_source_fake_additional_transaction_rejected(self):
        one=copy.deepcopy(self.rows[0])
        one["tx_hash"]=h32(999999)
        self.rows[0]=one
        # Still 47 source transactions only if a singleton source is removed,
        # but the event's actual canonical receipt source identity will fail.
        with self.assertRaises(m.Rejected):
            m.group_indexed_events(self.report,self.rows)

    def test_untrusted_source_zip_cannot_be_audit_pass(self):
        with self.assertRaises(Exception):
            m.proof.authenticate_index_archive(b"fake zip")

    def test_historical_winner_cannot_certify_nqc_tx_cost(self):
        r=m.build(self.report,self.rows,
                  lambda name:fake_rpc(self.grouped,self.blocks,side=name))
        self.assertFalse(r["cold_nqc_complete_transaction_gas_used_verified"])
        self.assertTrue(r["these_are_competitor_transactions_not_nqc_transactions"])
        self.assertFalse(r["builder_out_of_band_inclusion_payments_established"])
        self.assertFalse(r["nonrecourse_external_native_gas_payer_committed"])

    def test_producer_real_archive_and_53_event_47_tx_source(self):
        path=os.environ.get("NQC_PR693_GAS_SOURCE_ZIP")
        self.assertTrue(path,"CI must supply real immutable producer evidence ZIP")
        report,rows,source=m.proof.authenticate_index_archive(Path(path).read_bytes())
        grouped,blocks=m.group_indexed_events(report,rows)
        self.assertEqual(len(grouped),47)
        self.assertEqual(len(blocks),45)
        self.assertEqual(sum(len(x["source_rows"]) for x in grouped.values()),53)
        self.assertEqual(source["source_zip_sha256"],m.proof.INDEX_ARTIFACT_SHA)


if __name__=="__main__":
    unittest.main()
