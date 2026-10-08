#!/usr/bin/env python3
"""Adversarial true third-party paymaster observation does not grant NQC credit."""
from __future__ import annotations
import copy
import sys
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parent))
import rmc011_pimlico_v07_historical_provider as m

PARENT="0x"+"a"*64
STATE="0x"+"b"*64
PIMLICO_CODE="0x"+"600a"*1200
ENTRYPOINT_CODE="0x"+"600b"*1100

def source(url,method,params):
    if method=="eth_chainId":
        assert params==[]
        return "0x1"
    if method=="eth_getBlockByNumber":
        assert params==[hex(m.HISTORICAL_BLOCK),False]
        return {
            "number":hex(m.HISTORICAL_BLOCK),
            "hash":m.HISTORICAL_HASH,
            "parentHash":PARENT,
            "stateRoot":STATE,
            "timestamp":hex(1788935603),
        }
    if method=="eth_getCode":
        assert params[1]==hex(m.HISTORICAL_BLOCK)
        if params[0]==m.PAYMASTER:return PIMLICO_CODE
        if params[0]==m.ENTRYPOINT:return ENTRYPOINT_CODE
        raise AssertionError("unexpected real source code address")
    if method=="eth_call":
        assert params==[
           {"to":m.ENTRYPOINT,"data":"0x70a08231"+m.PAYMASTER[2:].rjust(64,"0")},
           hex(m.HISTORICAL_BLOCK)]
        return "0x"+f"{2*10**18:064x}"
    raise AssertionError("unknown or state-changing RPC")

class TestPimlicoV07RealMainnetReadOnly(unittest.TestCase):
    def test_true_operator_quorum_and_no_user_credit_promotion(self):
        r=m.assess(call=source)
        self.assertEqual(r["status"],"RMC011_EXTERNAL_V07_PAYMASTER_CODE_AND_ENTRYPPOINT_DEPOSIT_OBSERVED_NOT_ADMITTED")
        self.assertTrue(r["real_contract_code_and_total_deposit_dual_operator_consensus"])
        self.assertTrue(r["is_provider_total_deposit_positive_at_source_block"])
        self.assertEqual(r["real_entrypoint_paymaster_total_native_deposit_wei_at_historical_block"],str(2*10**18))
        self.assertEqual(r["report_sha256"],m.hash256(m.canon({k:v for k,v in r.items() if k!="report_sha256"})))
        self.assertEqual([x["provider_id"] for x in r["rpc_operator_witnesses"]],["drpc","blast"])

    def test_huge_actual_provider_deposit_still_not_nqc_money(self):
        r=m.assess(call=source)
        self.assertEqual(r["historical_block_number"],25938047)
        for key in (
            "source_contains_proof_of_nqc_allocated_credit",
            "source_contains_provider_weth_quote",
            "source_contains_provider_erc20_payment_policy_approval",
            "source_contains_signed_operation_specific_paymaster_authorization",
            "source_contains_nqc_nonrecourse_success_and_revert_agreement",
            "source_contains_exclusive_native_gas_reservation_for_nqc",
            "real_erc20_postop_can_pay_with_future_liquidation_proceeds_proven",
            "real_provider_mainnet_weth_support_and_account_allowance_proven",
            "independent_external_gas_provider_execution_authorized",
            "nqc_capital_feasible_for_own_capital_zero",
            "source_is_current_live_availability_quote",
            "actual_real_entrypoint_paymaster_userop_executed",
            "nqc_ex_ante_liquidation_capture_proven",
            "nqc_net_profit_proven",
            "rmc011_terminal_closed",
            "real_market_census_closed",
        ):
            self.assertIs(r[key],False,key)

    def test_zero_provider_deposit_is_allowed_negative_truth(self):
        def zero(url,method,params):
            return "0x"+"0"*64 if method=="eth_call" else source(url,method,params)
        r=m.assess(call=zero)
        self.assertFalse(r["is_provider_total_deposit_positive_at_source_block"])
        self.assertEqual(r["real_entrypoint_paymaster_total_native_deposit_wei_at_historical_block"],"0")
        self.assertFalse(r["nqc_capital_feasible_for_own_capital_zero"])

    def test_wrong_chain(self):
        def wrong(url,method,params):
            return "0x2" if method=="eth_chainId" else source(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong RPC chain"):m.assess(call=wrong)

    def test_wrong_block_hash_reorg(self):
        def wrong(url,method,params):
            doc=source(url,method,params)
            if method=="eth_getBlockByNumber":doc["hash"]="0x"+"f"*64
            return doc
        with self.assertRaisesRegex(ValueError,"reorg mismatch"):m.assess(call=wrong)

    def test_wrong_number(self):
        def wrong(url,method,params):
            doc=source(url,method,params)
            if method=="eth_getBlockByNumber":doc["number"]=hex(m.HISTORICAL_BLOCK+1)
            return doc
        with self.assertRaisesRegex(ValueError,"number wrong"):m.assess(call=wrong)

    def test_bad_parent_or_state_root(self):
        for key in ("parentHash","stateRoot"):
            def wrong(url,method,params):
                doc=source(url,method,params)
                if method=="eth_getBlockByNumber":doc[key]="0x0"
                return doc
            with self.subTest(field=key):
                with self.assertRaises(ValueError):m.assess(call=wrong)

    def test_code_absent_rejected(self):
        def bad(url,method,params):
            if method=="eth_getCode" and params[0]==m.PAYMASTER:return "0x"
            return source(url,method,params)
        with self.assertRaisesRegex(ValueError,"missing runtime"):m.assess(call=bad)

    def test_false_entrypoint_code_rejected(self):
        def bad(url,method,params):
            if method=="eth_getCode" and params[0]==m.ENTRYPOINT:return "0x"
            return source(url,method,params)
        with self.assertRaisesRegex(ValueError,"missing runtime"):m.assess(call=bad)

    def test_paymaster_code_mismatch_two_operators(self):
        def bad(url,method,params):
            if method=="eth_getCode" and params[0]==m.PAYMASTER and "blastapi" in url:
                return "0x"+"600d"*1200
            return source(url,method,params)
        with self.assertRaisesRegex(ValueError,"disagree on paymaster_code_sha256"):m.assess(call=bad)

    def test_provider_funds_mismatch(self):
        def bad(url,method,params):
            if method=="eth_call" and "blastapi" in url:
                return "0x"+f"{3*10**18:064x}"
            return source(url,method,params)
        with self.assertRaisesRegex(ValueError,"disagree on entrypoint_paymaster_total_deposit"):m.assess(call=bad)

    def test_truncated_abi_word(self):
        for x in ("0x",None,False,"0x7","0x"+"0"*63):
            def bad(url,method,params):
                return x if method=="eth_call" else source(url,method,params)
            with self.subTest(v=str(x)[:20]):
                with self.assertRaisesRegex(ValueError,"ABI malformed"):m.assess(call=bad)

    def test_not_pseudo_independent_providers(self):
        with self.assertRaisesRegex(ValueError,"independent"):
            m.assess(call=source,providers=[
                ("drpc","same","a"),("blast","same","b")])
        with self.assertRaisesRegex(ValueError,"independent"):
            m.assess(call=source,providers=[
                ("drpc","distinct-one","a"),("blast","distinct-two","a")])

    def test_read_only_at_single_historical_anchor(self):
        queries=[]
        def witness(url,method,params):
            queries.append((method,params))
            return source(url,method,params)
        m.assess(call=witness)
        self.assertEqual(len(queries),10)
        self.assertEqual(sum(method=="eth_call" for method,_ in queries),2)
        self.assertEqual(sum(method=="eth_getCode" for method,_ in queries),4)
        self.assertFalse(any(method.startswith("eth_send") for method,_ in queries))
        self.assertFalse(any(params==["latest"] for _,params in queries))

    def test_identity_constants_are_real_deployment_not_user_supplied(self):
        self.assertEqual(m.ENTRYPOINT,"0x0000000071727de22e5e9d8baf0edac6f37da032")
        self.assertEqual(m.PAYMASTER,"0x777777777777aec03fd955926dbf81597e66834c")
        self.assertEqual(m.HISTORICAL_BLOCK,25938047)
        self.assertEqual(m.BALANCE_OF,"0x70a08231")

if __name__=="__main__":
    unittest.main()
