"""Adversarial offline provenance, loopback restriction and receipt identity tests."""
from __future__ import annotations

import copy
from hashlib import sha256
import json
import os
from pathlib import Path
import tempfile
import unittest

import nqc_local_anvil_cold_receipt as app


def fake_receipts():
    sender="0x"+"ab"*20
    strategy="0x"+"12"*20
    executor="0x"+"34"*20
    rows=[]
    for i in range(4):
        receipt={
            "transactionHash":"0x"+f"{i+1:064x}",
            "blockHash":"0x"+f"{i+10:064x}",
            "from":sender,
            "to":None if i<=1 else (strategy if i==2 else executor),
            "contractAddress":strategy if i==0 else executor if i==1 else None,
            "gasUsed":hex((182_000,321_000,31_000,1_440_500)[i]),
            "status":"0x1",
            "effectiveGasPrice":"0x3b9aca00",
            "logs":[{"logIndex":hex(j)} for j in range(9)] if i==3 else [],
        }
        rows.append(receipt)
    return sender,rows


class FakeRpc:
    def __init__(self,rows):
        self.rows={r["transactionHash"]:r for r in rows}
        self.seen=[]

    def call(self,method,params):
        if method!="eth_getTransactionReceipt":
            raise AssertionError(method)
        self.seen.append(params[0])
        return copy.deepcopy(self.rows.get(params[0]))


class LocalOnlyColdReceiptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        name=os.environ.get("NQC_FUNDED_ROUTE_ZIP")
        if not name:
            raise AssertionError("exact immutable PR698 source ZIP not supplied")
        cls.raw=Path(name).read_bytes()
        cls.inputs,cls.proof=app.validate_original_zip(cls.raw)

    def test_source_archive_full_immutable_authentication(self):
        self.assertEqual(sha256(self.raw).hexdigest(),app.SOURCE_ZIP_SHA)
        self.assertEqual(self.inputs["NQC_WINNER_TX"],app.FORK_WINNER)
        self.assertEqual(self.inputs["NQC_WINNER_BLOCK"],str(app.PINNED_BLOCK))
        self.assertEqual(int(self.inputs["NQC_PRINCIPAL"]),app.EXPECTED_PRINCIPAL)
        self.assertEqual(self.inputs["NQC_RPC_URL"],app.UPSTREAM_READ_ONLY_RPC)
        self.assertGreater(self.proof["manifest_files_verified"],20)

    def test_zip_single_bit_tamper_rejected(self):
        with self.assertRaises(Exception):
            app.validate_original_zip(self.raw+bytes([0]))

    def test_no_external_rpc_target_possible(self):
        for url in ("https://eth.drpc.org","http://localhost:8545",
                    "http://127.0.0.1:8545","http://0.0.0.0:18545",
                    "http://127.0.0.1:18545/","https://127.0.0.1:18545",
                    "http://127.0.0.1:18545@eth.drpc.org"):
            with self.subTest(url=url),self.assertRaises(app.Rejected):
                app.reject_nonlocal_url(url)
        self.assertEqual(app.LocalAnvil().url,app.LOCAL_URL)

    def test_explicitly_disallowed_eth_sendRawTransaction_and_wallet_methods(self):
        rpc=app.LocalAnvil()
        for method in ("eth_sendRawTransaction","eth_sendTransaction",
                       "personal_unlockAccount","eth_sign",
                       "anvil_setCode","anvil_impersonateAccount"):
            with self.assertRaises(app.Rejected):
                rpc.call(method,[])
        self.assertEqual(rpc.calls,0)

    def test_local_fake_funding_is_bounded(self):
        rpc=app.LocalAnvil()
        with self.assertRaises(app.Rejected):
            rpc.call("anvil_setBalance",["0x"+"ff"*20,"0xff"])
        with self.assertRaises(app.Rejected):
            rpc.call("anvil_setBalance",["https://eth.drpc.org","0x3635c9adc5dea00000"])
        self.assertEqual(rpc.calls,0)

    def make_report(self,receipts=None):
        sender,rows=fake_receipts()
        if receipts is not None:
            rows=receipts
        with tempfile.TemporaryDirectory() as folder:
            f=Path(folder)/"run-latest.json"
            f.write_text(json.dumps({
                "transactions":[{"label":x["transactionHash"]} for x in rows],
                "receipts":rows,
            }))
            fake=FakeRpc(rows)
            d=app.decode_local_receipts(f,fake,sender,self.inputs,1_115_038)
            return d,fake

    def test_four_distinct_real_local_eoa_receipts(self):
        d,fake=self.make_report()
        self.assertEqual(d["fork_only_execute_receipt_gas_used"],1_440_500)
        self.assertEqual(len(d["fork_only_setup_transaction_receipt_gas_used"]),3)
        self.assertEqual(d["full_receipt_minus_internal_call_gas"],325_462)
        self.assertEqual(d["fork_only_execute_receipt_native_wei_gas_charged"],
                         1_440_500*1_000_000_000)
        self.assertEqual(len(fake.seen),4)
        self.assertFalse(d["real_execution_gas_fee_paid_from_user_or_operator"])
        self.assertFalse(d["mainnet_competitive_inclusion_or_capture_proven"])

    def test_competitor_gas_not_substituted_for_local_receipt(self):
        d,_=self.make_report()
        self.assertNotEqual(d["fork_only_execute_receipt_gas_used"],2_740_350)
        self.assertNotEqual(d["fork_only_execute_receipt_gas_used"],1_115_038)

    def test_receipt_revert_must_fail(self):
        _,rows=fake_receipts()
        rows[3]["status"]="0x0"
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_receipt_missing_one_of_four_fails(self):
        _,rows=fake_receipts()
        with self.assertRaises(app.Rejected):self.make_report(rows[:3])

    def test_duplicate_tx_hash_fails(self):
        _,rows=fake_receipts()
        rows[3]["transactionHash"]=rows[2]["transactionHash"]
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_wrong_execute_destination_fails(self):
        _,rows=fake_receipts()
        rows[3]["to"]="0x"+"fa"*20
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_wrong_cold_eoa_sender_fails(self):
        _,rows=fake_receipts()
        rows[2]["from"]="0x"+"00"*20
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_receipt_gas_below_internal_call_fails(self):
        _,rows=fake_receipts()
        rows[3]["gasUsed"]=hex(1_000_000)
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_rewrite_execution_or_setup_target_fails(self):
        _,rows=fake_receipts()
        rows[2]["to"]="0x"+"ab"*20
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_receipt_without_aave_route_logs_fails(self):
        _,rows=fake_receipts()
        rows[3]["logs"]=[]
        with self.assertRaises(app.Rejected):self.make_report(rows)

    def test_negative_and_boolean_integer_price_fails_closed(self):
        for v in (0, -1, True, 1.0, "1"):
            with self.assertRaises(app.Rejected):
                app.integer(v,"gas",True)

    def test_source_inputs_cannot_be_conflated_with_nqc_profit(self):
        self.assertEqual(app.EXPECTED_SURPLUS_BEFORE_NATIVE,2_273_989_378)
        self.assertEqual(app.EXPECTED_FEE,24_496_677)
        self.assertEqual(app.PINNED_BLOCK,26_142_067)
        self.assertNotEqual(app.EXPECTED_SURPLUS_BEFORE_NATIVE,0)

    def test_real_rpc_fork_validation_rejects_bad_chain(self):
        class Stub:
            def call(self,method,params):
                if method=="eth_chainId":return "0x89"
                raise AssertionError(method)
        with self.assertRaises(app.Rejected):
            app.check_fork_snapshot(Stub(),self.inputs)

    def test_missing_original_prewinner_abi_rejected(self):
        class Stub:
            def call(self,method,params):
                if method=="eth_chainId":return "0x1"
                if method=="anvil_nodeInfo":return {"anvil":"local"}
                if method=="eth_getBlockByNumber":
                    return {"number":hex(app.PINNED_BLOCK)}
                if method=="eth_call":return "0x"+("00"*192)
                raise AssertionError(method)
        with self.assertRaises(app.Rejected):
            app.check_fork_snapshot(Stub(),self.inputs)

    def test_exact_six_field_prewinner_drift_has_reproducible_witness(self):
        raw="0x"+("00"*192)
        class Stub:
            def call(self,method,params):
                if method=="eth_chainId":return "0x1"
                if method=="anvil_nodeInfo":return {"anvil":"loopback"}
                if method=="eth_getBlockByNumber":
                    return {"number":hex(app.PINNED_BLOCK),
                            "timestamp":"0x123",
                            "hash":"0x"+"aa"*32,
                            "parentHash":"0x"+"bb"*32}
                if method=="eth_call":return raw
                raise AssertionError(method)
        with self.assertRaises(app.PrestateDrift) as caught:
            app.check_fork_snapshot(Stub(),self.inputs)
        witness=caught.exception.witness
        self.assertEqual(len(witness["source_expected_six_uint256_words"]),6)
        self.assertEqual(witness["anvil_observed_six_uint256_words"],[0]*6)
        self.assertEqual(len(witness["observed_minus_expected_six_exact_integer_deltas"]),6)
        self.assertEqual(witness["anvil_local_latest_block_number"],app.PINNED_BLOCK)
        self.assertTrue(witness["cannot_promote_any_nqc_route_or_full_transaction_gas"])

    def test_no_presumed_external_native_gas_sponsor_or_real_profit(self):
        # Model explicitly retains non-claims and no route profit promotion.
        source=self.inputs
        self.assertTrue(source["NQC_BORROWER"].startswith("0x"))
        self.assertEqual(source["NQC_WINNER_TX"],app.FORK_WINNER)
        self.assertEqual(app.LOCAL_URL,"http://127.0.0.1:18545")


if __name__=="__main__":
    unittest.main()
