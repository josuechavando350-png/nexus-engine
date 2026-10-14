"""One-shot exactly-one-local-EOA receipt, source auth and no-profit adversarial tests."""
from __future__ import annotations

import copy
from hashlib import sha256
import os
from pathlib import Path
import unittest
import zipfile

import nqc_local_one_shot_eoa as one
import nqc_local_anvil_cold_receipt as old

ONE_SHOT_TOPIC = "0x24e59545e75cb035e07191d48b8d7e75163aebd237dafa18ff0aae720a7c00ec"
ONE_SHOT = "0x"+"ab"*20


def address_topic(addr):
    return "0x"+"0"*24+addr[2:].lower()


def word(n):
    return f"{n:064x}"


class OneShotLocalEoaNegativeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        p=os.environ.get("NQC_PR723_SOURCE_ZIP")
        if not p:
            raise AssertionError("Set original immutable PR723 local EOA evidence ZIP path")
        raw=Path(p).read_bytes()
        need=sha256(raw).hexdigest()
        if need!="edae8d055655f0fc23c443dbdccdf9c4150311133a1966249d4957dcd80ed346":
            raise AssertionError("source ZIP SHA256 mismatch")
        with zipfile.ZipFile(p) as z:
            cls.source=old.historical.strict_json(z.read(
                "11865385506.zip") if False else
                zipfile.ZipFile(__import__("io").BytesIO(z.read("11865385506.zip")))
                    .read("attempt/weth_collateral_usdc_debt-drpc/public-inputs.json"))
            original=old.historical.strict_json(z.read("attempt/local-cold-receipt.json"))
            cls.operator=original["ephemeral_test_eoa_address"]
            cls.strategy=original["full_local_eoa_receipts"]["isolated_strategy_contract_address"]
            cls.coordinator=original["full_local_eoa_receipts"]["isolated_coordinator_contract_address"]
            cls.receipt=original["full_local_eoa_receipts"]["fork_only_full_local_execute_receipt"]
            cls.fork_archive=z.read("11865385506.zip")
            cls.oracle_archive=z.read("11871075488.zip")
            cls.index_archive=z.read("11861430884.zip")

    def fake(self):
        receipt=copy.deepcopy(self.receipt)
        receipt["contractAddress"]=ONE_SHOT
        receipt["to"]=None
        receipt["from"]=self.operator
        profit=old.EXPECTED_SURPLUS_BEFORE_NATIVE
        idx=None
        for i,log in enumerate(receipt["logs"]):
            if log.get("address","").lower()!=one.USDC or \
               log["topics"][0].lower()!=old.ERC20_TRANSFER_TOPIC or \
               len(log["topics"])!=3:
                continue
            if old._topic_address(log["topics"][1],"from")==self.coordinator and \
               old._topic_address(log["topics"][2],"to")==self.operator and \
               old._word_data(log["data"],1,"profit")[0]==profit:
                idx=i;break
        if idx is None:
            raise AssertionError("PR723 source receipt lacks original paid USDC sweep")
        move=receipt["logs"][idx]
        move["topics"][2]=address_topic(ONE_SHOT)
        payout=copy.deepcopy(move)
        payout["topics"][1]=address_topic(ONE_SHOT)
        payout["topics"][2]=address_topic(self.operator)
        receipt["logs"].append(payout)
        event=copy.deepcopy(move)
        event["address"]=ONE_SHOT
        event["topics"]=[
            ONE_SHOT_TOPIC,address_topic(self.operator),
            address_topic(self.strategy),address_topic(self.coordinator)]
        event["data"]="0x"+(
            word(int(old.FORK_WINNER,16))+word(profit)+
            word(int(receipt["blockNumber"],16)))
        receipt["logs"].append(event)
        return receipt

    def test_original_pr698_pr700_pr693_source_scope(self):
        info,_=old.validate_original_zip(self.fork_archive)
        self.assertEqual(info["NQC_PRESTATE_ABI"],self.source["NQC_PRESTATE_ABI"])
        prefix=old.authenticate_oracle_prefix(self.oracle_archive,self.index_archive)
        self.assertTrue(prefix["source_price_causality_not_prospective_svr_visibility"])
        self.assertEqual(prefix["source_winner_tx_index_from_original_indexer"],1)

    def test_one_local_eoa_signed_receipt_economic_events(self):
        proof=one.report_source(self.fake(),self.source,self.operator)
        self.assertTrue(proof["no_three_post_trigger_setup_eoa_transactions"])
        self.assertTrue(proof["local_two_stage_erc20_profit_payout_to_test_eoa"])
        self.assertEqual(proof["exact_local_usdc_profit_before_native_costs_base_units"],2273989378)
        self.assertFalse(proof["real_mainnet_broadcast_or_inclusion"])

    def test_one_shot_event_cannot_be_omitted(self):
        receipt=self.fake()
        receipt["logs"].pop()
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_final_usdc_transfer_to_eoa_cannot_be_faked(self):
        receipt=self.fake()
        receipt["logs"][-2]["data"]="0x"+word(1)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_wrong_borrower_liquidation_rejected(self):
        receipt=self.fake()
        log=next(x for x in receipt["logs"] if x.get("address","").lower()==old.POOL
                 and x["topics"][0].lower()==old.AAVE_LIQUIDATION_TOPIC)
        log["topics"][3]=address_topic("0x"+"ff"*20)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_incorrect_flash_repay_fee_rejected(self):
        receipt=self.fake()
        log=next(x for x in receipt["logs"] if x.get("address","").lower()==self.coordinator
                 and x["topics"][0].lower()==old.FUNDING_LEG_REPAID_TOPIC)
        vals=old._word_data(log["data"],5,"FundingLegRepaid")
        vals[3]+=1
        log["data"]="0x"+"".join(word(v) for v in vals)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_constructor_event_wrong_winner_rejected(self):
        receipt=self.fake()
        event=receipt["logs"][-1]
        values=old._word_data(event["data"],3,"OneShot")
        values[0]+=1
        event["data"]="0x"+"".join(word(v) for v in values)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_constructor_event_wrong_block_rejected(self):
        receipt=self.fake()
        event=receipt["logs"][-1]
        values=old._word_data(event["data"],3,"OneShot")
        values[2]+=1
        event["data"]="0x"+"".join(word(v) for v in values)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_requires_eoa_contract_creation_not_call(self):
        receipt=self.fake()
        receipt["to"]=self.coordinator
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_failed_eoa_transaction_never_counts(self):
        receipt=self.fake()
        receipt["status"]="0x0"
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_wrong_payout_operator_rejected(self):
        receipt=self.fake()
        receipt["logs"][-2]["topics"][2]=address_topic("0x"+"bb"*20)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_duplicate_one_shot_economic_event_rejected(self):
        receipt=self.fake()
        receipt["logs"].append(copy.deepcopy(receipt["logs"][-1]))
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_gas_price_and_cost_identity_kept_local_only(self):
        result=one.report_source(self.fake(),self.source,self.operator)
        self.assertEqual(result["synthetic_local_eoa_paid_wei"],
                         result["one_and_only_local_eoa_tx_actual_gas_used"]*
                         result["local_actual_effective_gas_price_wei"])
        self.assertTrue(result["one_backrun_body_tx_assumed_eligible_but_not_verified_by_svr"])

    def test_refuses_injected_debt_principal_amount(self):
        receipt=self.fake()
        log=next(x for x in receipt["logs"] if x.get("address","").lower()==old.POOL
                 and x["topics"][0].lower()==old.AAVE_LIQUIDATION_TOPIC)
        vals=old._word_data(log["data"],4,"LiquidationCall")
        vals[0]+=1
        log["data"]="0x"+"".join(word(v) for v in vals)
        with self.assertRaises(one.Rejected):
            one.report_source(receipt,self.source,self.operator)

    def test_malformed_indexed_address_rejected(self):
        receipt=self.fake()
        receipt["logs"][-1]["topics"][1]="0x"+"ff"*32
        with self.assertRaises(Exception):
            one.report_source(receipt,self.source,self.operator)

    def test_no_extra_live_private_key_or_signer_prerequisite(self):
        self.assertEqual(one.LOCAL,"http://127.0.0.1:18545")
        self.assertEqual(one.ONE_SHOT_SCRIPT,
                         "NqcV2OneShotAtomicLocal.s.sol:NqcV2OneShotBroadcastScript")
        self.assertTrue(old.reject_nonlocal_url(one.LOCAL))


if __name__=="__main__":
    unittest.main()
