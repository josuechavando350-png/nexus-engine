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
        # Exact forked oracle tx0 source is block 26,142,067; the local EOA
        # CREATE transaction MUST be the very NEXT isolated synthetic block.
        receipt["blockNumber"]=hex(old.PINNED_BLOCK+1)
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
        # EVM next-block Aave interest accrual changes 0,1,5 risk
        # words by the exact amounts independently observed in first cast trace.
        expected=[int(self.source["NQC_PRESTATE_ABI"][2+i*64:2+(i+1)*64],16)
                  for i in range(6)]
        observed=expected.copy()
        observed[0]+=4810
        observed[1]+=15297
        observed[5]-=1148180630
        original_raw=bytes.fromhex(self.source["NQC_PRESTATE_ABI"][2:])
        observed_raw=b"".join(n.to_bytes(32,"big") for n in observed)
        drift=copy.deepcopy(move)
        drift["address"]=ONE_SHOT
        drift["topics"]=[one.DRIFT_TOPIC]
        drift["data"]="0x"+"".join(word(x) for x in (
            [int.from_bytes(one.ethereum_keccak256(original_raw),"big"),
             int.from_bytes(one.ethereum_keccak256(observed_raw),"big")] +
             expected+observed+[int(self.source["NQC_WINNER_TIMESTAMP"])+1]))
        receipt["logs"].insert(0,drift)
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

    def test_offline_ethereum_keccak_known_transfer_event(self):
        self.assertEqual("0x"+one.ethereum_keccak256(
            b"Transfer(address,address,uint256)").hex(),
            old.ERC20_TRANSFER_TOPIC)
        self.assertEqual("0x"+one.ethereum_keccak256(
            b"LocalOneShotStateDrift(bytes32,bytes32,uint256[6],uint256[6],uint256)"
        ).hex(),one.DRIFT_TOPIC)

    def test_actual_one_synthetic_block_interest_drift_explicitly_proven(self):
        proof=one.report_source(self.fake(),self.source,self.operator)
        drift=proof["local_execution_one_block_state_drift"]
        self.assertEqual(drift["execution_minus_original_integer_deltas"],
                         [4810,15297,0,0,0,-1148180630])
        self.assertTrue(drift["source_and_execution_hf_below_one"])
        self.assertFalse(drift["source_equals_execution_six_word_abi"])
        self.assertTrue(drift["actual_execution_state_1ppm_posthoc_guard_passed"])

    def test_one_ppm_exceeded_or_config_drift_rejected(self):
        r=self.fake()
        drift=r["logs"][0]
        words=old._word_data(drift["data"],15,"drift")
        words[8]+=100000000
        drift["data"]="0x"+"".join(word(n) for n in words)
        with self.assertRaises(one.Rejected):
            one.report_source(r,self.source,self.operator)
        r=self.fake()
        words=old._word_data(r["logs"][0]["data"],15,"drift")
        words[8+3]+=1
        r["logs"][0]["data"]="0x"+"".join(word(n) for n in words)
        with self.assertRaises(one.Rejected):
            one.report_source(r,self.source,self.operator)

    def test_state_drift_witness_cannot_be_omitted(self):
        r=self.fake()
        r["logs"].pop(0)
        with self.assertRaises(one.Rejected):
            one.report_source(r,self.source,self.operator)

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

    def test_failed_local_constructor_is_a_gas_loss_not_a_liquidation(self):
        receipt=self.fake()
        receipt["status"]="0x0"
        receipt["contractAddress"]=None
        receipt["logs"]=[]
        proof=one.authenticate_failed_loopback_receipt(
            receipt,receipt["transactionHash"],self.operator)
        self.assertEqual(proof["status"],
            "LOCALLY_MINED_EOA_CONSTRUCTOR_REVERTED_NO_PROFIT")
        self.assertTrue(proof["logs_empty_due_revert"])
        self.assertFalse(proof["actual_profit_claimed"])
        self.assertFalse(proof["real_mainnet_transaction"])
        self.assertGreater(proof["gas_used_by_failed_local_tx"],21_000)

    def test_success_local_constructor_cannot_be_mislabeled_failure(self):
        receipt=self.fake()
        with self.assertRaises(one.Rejected):
            one.authenticate_failed_loopback_receipt(
                receipt,receipt["transactionHash"],self.operator)
        receipt["status"]="0x0"
        receipt["from"]="0x"+"ff"*20
        receipt["contractAddress"]=None
        with self.assertRaises(one.Rejected):
            one.authenticate_failed_loopback_receipt(
                receipt,receipt["transactionHash"],self.operator)

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
                         "script/NqcV2OneShotAtomicLocal.s.sol:NqcV2OneShotBroadcastScript")
        self.assertTrue(old.reject_nonlocal_url(one.LOCAL))



class OneShotEoaSubmissionEnvelopeTests(unittest.TestCase):
    """Mock envelope tests prove fail-closed rules, NOT mainnet availability."""

    def setUp(self):
        self.operator="0x"+"77"*20
        self.txhash="0x"+"ab"*32
        self.blockhash="0x"+"bc"*32
        self.borrower="0x"+"11"*20
        self.inputs={
            "NQC_BORROWER":self.borrower,
            "NQC_PRESTATE_ABI":"0x"+"00"*192,
            "NQC_PARENT_HASH":"0x"+"22"*32,
        }
        # Mock bytecode + exact ABI values, not a source-authenticated contract.
        mock_initcode=(
            bytes.fromhex("600060005260206000f3")+
            bytes.fromhex("00"*12+self.borrower[2:])+
            bytes.fromhex(self.inputs["NQC_PARENT_HASH"][2:])+
            bytes.fromhex(old.FORK_WINNER[2:])+
            bytes.fromhex(self.inputs["NQC_PRESTATE_ABI"][2:])
        )
        self.tx={
            "hash":self.txhash,
            "blockHash":self.blockhash,
            "blockNumber":hex(old.PINNED_BLOCK+1),
            "from":self.operator,
            "to":None,
            "chainId":"0x1",
            "nonce":"0x0",
            "value":"0x0",
            "type":"0x2",
            "gas":hex(8_000_000),
            "maxFeePerGas":hex(2_000_000_000),
            "maxPriorityFeePerGas":hex(50_000_000),
            "input":"0x"+mock_initcode.hex(),
        }
        self.receipt={
            "transactionHash":self.txhash,
            "blockHash":self.blockhash,
            "blockNumber":hex(old.PINNED_BLOCK+1),
            "from":self.operator,
            "to":None,
            "gasUsed":hex(3_914_680),
            "effectiveGasPrice":hex(1_001_089_409),
        }
        self.block={
            "number":self.receipt["blockNumber"],
            "hash":self.blockhash,
            "gasLimit":hex(30_000_000),
            "gasUsed":self.receipt["gasUsed"],
            "transactions":[self.txhash],
        }

    def check(self,tx=None,receipt=None,block=None,inputs=None):
        return one.authenticate_single_eoa_submission(
            self.tx if tx is None else tx,
            self.receipt if receipt is None else receipt,
            self.block if block is None else block,
            self.operator,
            self.inputs if inputs is None else inputs)

    def test_mock_one_eoa_initcode_envelope_conserves_gas(self):
        d=self.check()
        self.assertTrue(d["one_and_only_local_block_tx_identity_verified"])
        self.assertTrue(d["constructor_args_embed_exact_source_hash_parent_borrower_and_abi"])
        self.assertTrue(d["no_second_eoa_in_locally_mined_block"])
        self.assertEqual(d["local_block_number"],old.PINNED_BLOCK+1)
        self.assertEqual(d["eip1559_transaction_type"],2)
        self.assertEqual(d["eoa_native_value_wei"],0)
        self.assertEqual(d["local_eoa_receipt_gas_used_units"],3_914_680)
        self.assertEqual(d["eip3860_cancun_max_initcode_bytes"],49_152)
        self.assertFalse(d["one_transaction_is_not_mev_share_svr_relay_admission"] is False)

    def test_erc20_principal_cannot_be_injected_by_native_value(self):
        tx=copy.deepcopy(self.tx)
        tx["value"]="0x1"
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_reused_eoa_nonce_cannot_masquerade_as_fresh_local_account(self):
        tx=copy.deepcopy(self.tx)
        tx["nonce"]="0x1"
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_unexpected_rpc_chain_or_transaction_type_is_rejected(self):
        for prop,value in (("chainId","0x2105"),("type","0x0")):
            tx=copy.deepcopy(self.tx)
            tx[prop]=value
            with self.subTest(prop=prop),self.assertRaises(one.Rejected):
                self.check(tx=tx)

    def test_cannot_forge_to_contract_call_instead_of_create(self):
        tx=copy.deepcopy(self.tx)
        tx["to"]="0x"+"55"*20
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_missing_borrower_or_abi_in_constructor_calldata_fails(self):
        for key in ("NQC_BORROWER","NQC_PRESTATE_ABI",
                    "NQC_PARENT_HASH"):
            inputs=copy.deepcopy(self.inputs)
            inputs[key]="0x"+"ff"*(20 if key=="NQC_BORROWER" else
                                   192 if key=="NQC_PRESTATE_ABI" else 32)
            with self.subTest(key=key),self.assertRaises(one.Rejected):
                self.check(inputs=inputs)

    def test_eip3860_initcode_over_49152_is_never_accepted(self):
        tx=copy.deepcopy(self.tx)
        tx["input"]+="00"*(49_153)
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_mined_block_with_second_transaction_fails(self):
        block=copy.deepcopy(self.block)
        block["transactions"].append("0x"+"ee"*32)
        with self.assertRaises(one.Rejected):
            self.check(block=block)

    def test_receipt_gas_must_not_exceed_signed_gas_limit(self):
        tx=copy.deepcopy(self.tx)
        tx["gas"]=hex(3_000_000)
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_block_gas_conservation_exact_one_transaction(self):
        block=copy.deepcopy(self.block)
        block["gasUsed"]=hex(3_914_681)
        with self.assertRaises(one.Rejected):
            self.check(block=block)

    def test_eip1559_fee_cap_cannot_be_below_effective_fee(self):
        tx=copy.deepcopy(self.tx)
        tx["maxFeePerGas"]=hex(500_000_000)
        with self.assertRaises(one.Rejected):
            self.check(tx=tx)

    def test_chain_source_block_hash_avoids_claiming_original_competitor_slot(self):
        bad=copy.deepcopy(self.receipt)
        bad["blockNumber"]=hex(old.PINNED_BLOCK)
        with self.assertRaises(one.Rejected):
            self.check(receipt=bad)


if __name__=="__main__":
    unittest.main()
