#!/usr/bin/env python3
"""Adversarial tests for deployed-paymaster read-only token cost/penalty ABI."""
import copy
import unittest
from unittest.mock import patch
import rmc011_external_v07_fee_abi as m

SOURCE_BYTECODE = "0x" + "6001"*1300
STATE_ROOT = "0x" + "b"*64
PARENT = "0x" + "a"*64


def valid_rpc(url,method,params):
    if method=="eth_chainId":
        assert params==[]
        return "0x1"
    if method=="eth_getBlockByNumber":
        assert params==[hex(m.BLOCK),False]
        return {
            "number":hex(m.BLOCK),"hash":m.BLOCK_HASH,
            "parentHash":PARENT,"stateRoot":STATE_ROOT
        }
    if method=="eth_getCode":
        assert params==[m.PAYMASTER,hex(m.BLOCK)]
        return SOURCE_BYTECODE
    if method=="eth_call":
        assert len(params)==2 and params[1]==hex(m.BLOCK)
        tx=params[0]
        assert tx["to"]==m.PAYMASTER
        data=tx["data"]
        args=[int(data[i:i+64],16) for i in range(10,len(data),64)]
        if data[:10]==m.SELECTOR_EXPECTED_PENALTY:
            assert len(args)==5
            result=m.quote_penalty_math(*args)
        elif data[:10]==m.SELECTOR_GET_COST_IN_TOKEN:
            assert len(args)==4
            result=m.quote_cost_math(*args)
        else:raise AssertionError("unsupported selector")
        return "0x"+f"{result:064x}"
    raise AssertionError("read-only test RPC forbids other methods")


class TestExternalPaymasterFeeAbi(unittest.TestCase):
    def audit(self,call=valid_rpc,providers=None):
        with patch.object(m,"PAYMASTER_CODE_SHA256",
                          m.digest(bytes.fromhex(SOURCE_BYTECODE[2:]))):
            return m.assess(call=call,providers=providers)

    def test_two_independent_readonly_evm_abi_witnesses(self):
        r=self.audit()
        self.assertEqual(r["status"],
            "RMC011_REAL_EXTERNAL_V07_ERC20_FEE_ABI_AND_PENALTY_PARITY_PASS_NOT_CREDIT")
        self.assertEqual(len(r["four_illustrative_cost_cases"]),4)
        self.assertEqual(len(r["read_only_provider_operator_witnesses"]),2)
        self.assertTrue(r["real_deployed_pure_abi_functions_and_illustrative_math_agree"])
        self.assertEqual(r["report_sha256"],
            m.digest(m.canonical({k:v for k,v in r.items() if k!="report_sha256"})))

    def test_quote_without_postop_is_just_illustrative_existing_gas(self):
        r=self.audit()
        first=r["four_illustrative_cost_cases"][0]
        self.assertEqual(first["real_abi_expected_penalty_gas_cost_wei"],"0")
        self.assertEqual(first["real_abi_get_cost_in_weth_wei_at_1to1_test_rate"],
                         str(m.ILLUSTRATIVE_GAS_ALREADY_SPENT_WEI))

    def test_execution_gas_limit_penalty_can_raise_fee(self):
        r=self.audit()
        values=[int(x["real_abi_get_cost_in_weth_wei_at_1to1_test_rate"])
                for x in r["four_illustrative_cost_cases"]]
        self.assertLess(values[0],values[-1])
        self.assertEqual(len(set(values)),4)
        self.assertTrue(all(v<m.USER_OPERATION_WETH_SURPLUS_WEI for v in values))
        for x in r["four_illustrative_cost_cases"]:
            self.assertFalse(x["real_signed_provider_exchange_rate_used"])
            self.assertFalse(x["provider_signed_weth_userop_authorized"])
            self.assertFalse(x["nqc_gas_sponsorship_or_production_execution_proven"])

    def test_no_actual_provider_quote_or_nqc_balance_promotion(self):
        r=self.audit()
        for key in (
            "real_historical_postop_or_signed_userop_executed",
            "provider_signed_exchange_rate_or_constant_fee_obtained",
            "nqc_specific_paymaster_signer_authorization_granted",
            "provider_reverted_gas_nonrecourse_liability_accepted",
            "operator_pimlico_balance_or_other_recourse_excluded",
            "third_party_native_gas_line_reserved_for_nqc",
            "pimlico_provider_total_eth_deposit_is_nqc_money",
            "contract_penalty_math_is_an_actual_pimlico_policy_quote",
            "nqc_executable_with_zero_own_capital",
            "nqc_realized_pnl_proven",
            "rmc011_terminal_closed","real_market_census_closed"
        ):
            self.assertFalse(r[key],key)

    def test_wrong_chain_fails_closed(self):
        def bad(url,method,params):
            return "0x38" if method=="eth_chainId" else valid_rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong network"):self.audit(call=bad)

    def test_noncanonical_block_fails_closed(self):
        for key,replacement,expected in (
            ("number",hex(m.BLOCK+1),"block mismatch"),
            ("hash","0x"+"c"*64,"mismatch/reorg"),
            ("stateRoot","0x12","missing stateRoot"),
            ("parentHash",None,"missing parentHash"),
        ):
            def bad(url,method,params):
                out=valid_rpc(url,method,params)
                if method=="eth_getBlockByNumber":
                    out[key]=replacement
                return out
            with self.subTest(key=key):
                with self.assertRaises(ValueError):self.audit(call=bad)

    def test_real_runtime_code_must_be_present(self):
        def bad(url,method,params):
            return "0x" if method=="eth_getCode" else valid_rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"bytecode absent"):
            self.audit(call=bad)

    def test_real_runtime_code_hash_mismatch(self):
        with self.assertRaisesRegex(ValueError,"runtime source identity mismatch"):
            m.assess(call=valid_rpc)

    def test_two_rpc_original_code_disagreement_must_fail(self):
        def bad(url,method,params):
            if method=="eth_getCode" and "blastapi" in url:
                return "0x"+"6002"*1300
            return valid_rpc(url,method,params)
        with self.assertRaises(ValueError):self.audit(call=bad)

    def test_deployed_onchain_fee_math_disagreement_fails(self):
        def bad(url,method,params):
            value=valid_rpc(url,method,params)
            if method=="eth_call" and params[0]["data"].startswith(m.SELECTOR_GET_COST_IN_TOKEN):
                return "0x"+f"{int(value,16)+1:064x}"
            return value
        with self.assertRaisesRegex(ValueError,"token price deviates"):
            self.audit(call=bad)

    def test_deployed_penalty_math_disagreement_fails(self):
        def bad(url,method,params):
            value=valid_rpc(url,method,params)
            if method=="eth_call" and params[0]["data"].startswith(m.SELECTOR_EXPECTED_PENALTY):
                return "0x"+f"{int(value,16)+1:064x}"
            return value
        with self.assertRaisesRegex(ValueError,"penalty deviates"):
            self.audit(call=bad)

    def test_provider_cross_rpc_no_fake_fee_quorum(self):
        def bad(url,method,params):
            if method=="eth_call" and "blastapi" in url:
                value=valid_rpc(url,method,params)
                return "0x"+f"{int(value,16)+1:064x}"
            return valid_rpc(url,method,params)
        with self.assertRaises(ValueError):self.audit(call=bad)

    def test_bad_return_word_rejected(self):
        for badval in (None,True,7,"0x","0x1","0x"+"0"*63):
            def altered(url,method,params):
                if method=="eth_call":return badval
                return valid_rpc(url,method,params)
            with self.subTest(input=str(badval)):
                with self.assertRaisesRegex(ValueError,"ABI word"):self.audit(call=altered)

    def test_pseudo_independent_operator_or_endpoint_rejected(self):
        for providers in (
            (("drpc","SAME","a"),("blast","SAME","b")),
            (("drpc","ONE","a"),("blast","TWO","a")),
            (("drpc","ONE","a"),("drpc","TWO","b")),
        ):
            with self.subTest(providers=providers):
                with self.assertRaisesRegex(ValueError,"independent"):
                    self.audit(providers=providers)

    def test_readonly_anchored_method_counts(self):
        calls=[]
        def observe(url,method,params):
            calls.append((method,params))
            return valid_rpc(url,method,params)
        self.audit(call=observe)
        self.assertEqual(len(calls),22)
        self.assertEqual(sum(x[0]=="eth_call" for x in calls),16)
        self.assertEqual(sum(x[0]=="eth_getCode" for x in calls),2)
        self.assertFalse(any(method.startswith("eth_send") for method,_ in calls))
        self.assertFalse(any(params==["latest"] for _,params in calls))

    def test_ABI_selector_or_argument_arity_cannot_be_forged(self):
        with self.assertRaisesRegex(ValueError,"selector"):
            m.encode("0xdeadbeef",1,2,3,4)
        with self.assertRaisesRegex(ValueError,"arity"):
            m.encode(m.SELECTOR_GET_COST_IN_TOKEN,1,2)
        for v in (True,None,-1,1.5,2**256):
            with self.assertRaises(ValueError):
                m.encode(m.SELECTOR_GET_COST_IN_TOKEN,1,2,3,v)

    def test_cost_floor_wei_arithmetic(self):
        self.assertEqual(m.quote_cost_math(1,1,2,10**18),3)
        self.assertEqual(m.quote_cost_math(1,1,2,1),0)
        self.assertEqual(m.quote_penalty_math(0,100,0,100,100),1000)
        self.assertEqual(m.quote_penalty_math(0,100,0,0,0),0)
        with self.assertRaisesRegex(ValueError,"denominator zero"):
            m.quote_penalty_math(1,0,0,0,1)


if __name__=="__main__":
    unittest.main()
