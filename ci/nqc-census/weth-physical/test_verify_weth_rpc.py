#!/usr/bin/env python3
"""Adversarial local checks of historical WETH runtime / canonical anchor."""
import copy
import unittest
from verify_weth_rpc import assess, canonical, checked_header, checked_weth_code
import verify_weth_rpc as m

GOOD_HEADER = {
    "number": hex(m.BLOCK_NUMBER),
    "hash": m.BLOCK_HASH,
    "parentHash": "0x" + "a"*64,
    "stateRoot": "0x" + "b"*64,
    "timestamp": "0x672df800",
}
GOOD_CODE = "0x" + "6001"*150


def fake_rpc(url, method, params):
    if method == "eth_chainId":
        assert params == []
        return "0x1"
    if method == "eth_getBlockByNumber":
        assert params == [hex(m.BLOCK_NUMBER), False]
        return copy.deepcopy(GOOD_HEADER)
    if method == "eth_getCode":
        assert params == [m.WETH, hex(m.BLOCK_NUMBER)]
        return GOOD_CODE
    raise ValueError("unsupported RPC method")


class ReadOnlyWethWitnessTest(unittest.TestCase):
    def test_exact_dual_operator_code_identity(self):
        a=assess(call=fake_rpc)
        b=assess(call=fake_rpc)
        self.assertEqual(a,b)
        self.assertEqual(a["status"],"RMC011_WETH_ANCHORED_DUAL_OPERATOR_RUNTIME_WITNESS_PASS")
        self.assertEqual(a["weth_runtime_bytes"],300)
        self.assertTrue(a["cross_operator_code_identity_and_header_consensus"])
        self.assertEqual(len(a["operators"]),2)
        self.assertEqual(a["report_sha256"],m.digest(canonical({k:v for k,v in a.items() if k!="report_sha256"})))

    def test_no_token_promotion_gas_capital_or_pnl(self):
        r=assess(call=fake_rpc)
        for field in (
            "actual_transfer_approval_deposit_withdraw_fork_replayed",
            "nqc_token_execution_admission_certified",
            "nqc_flash_loan_or_liquidation_proven",
            "external_gas_sponsorship_proven",
            "own_capital_zero_execution_proven",
            "nexus_realized_pnl_proven",
            "real_market_census_closed",
        ):
            self.assertIs(r[field],False)

    def test_wrong_chain_fails(self):
        def fail(url,method,params):
            return "0x38" if method=="eth_chainId" else fake_rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong Ethereum chain"):
            assess(call=fail)

    def test_reorged_block_hash_fails(self):
        def fail(url,method,params):
            o=fake_rpc(url,method,params)
            if method=="eth_getBlockByNumber":
                o["hash"]="0x"+"f"*64
            return o
        with self.assertRaisesRegex(ValueError,"reorg mismatch"):
            assess(call=fail)

    def test_wrong_number_fails(self):
        bad=copy.deepcopy(GOOD_HEADER)
        bad["number"]=hex(m.BLOCK_NUMBER-1)
        with self.assertRaisesRegex(ValueError,"wrong block number"):
            checked_header(bad)

    def test_bad_state_root_and_parent_fail(self):
        for prop in ("stateRoot","parentHash"):
            bad=copy.deepcopy(GOOD_HEADER)
            bad[prop]="0xdeadbeef"
            with self.assertRaises(ValueError):
                checked_header(bad)

    def test_header_timestamp_must_be_positive(self):
        bad=copy.deepcopy(GOOD_HEADER)
        bad["timestamp"]="0x0"
        with self.assertRaises(ValueError):
            checked_header(bad)

    def test_cross_operator_code_drift_fails(self):
        def fail(url,method,params):
            if method=="eth_getCode" and "blastapi" in url:
                return "0x"+"6002"*150
            return fake_rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"disagree"):
            assess(call=fail)

    def test_cross_operator_state_drift_fails(self):
        def fail(url,method,params):
            d=fake_rpc(url,method,params)
            if method=="eth_getBlockByNumber" and "blastapi" in url:
                d["stateRoot"]="0x"+"c"*64
            return d
        with self.assertRaisesRegex(ValueError,"disagree"):
            assess(call=fail)

    def test_missing_code_fails(self):
        for v in ("0x",None,True,1,"0x123","0x" + "ab"*50):
            with self.subTest(value=str(v)[:12]):
                with self.assertRaises(ValueError):
                    checked_weth_code(v)

    def test_wrong_provider_identity_rejected(self):
        with self.assertRaisesRegex(ValueError,"distinct canonical provider"):
            assess(call=fake_rpc, providers=(("drpc","same","a"),("blast","same","b")))
        with self.assertRaisesRegex(ValueError,"distinct canonical provider"):
            assess(call=fake_rpc, providers=(("drpc","a","url1"),("drpc","b","url2")))

    def test_call_uses_historical_tag_not_latest(self):
        calls=[]
        def observe(url,method,params):
            calls.append((url,method,params))
            return fake_rpc(url,method,params)
        assess(call=observe)
        self.assertEqual(len(calls),6)
        self.assertEqual(sum(x[1]=="eth_getCode" for x in calls),2)
        self.assertTrue(all(x[2]!=["latest"] for x in calls))

    def test_invalid_rpc_quantities_rejected(self):
        for value in ("0x00","0x01",True,1,"0xzz",None):
            with self.subTest(value=str(value)):
                with self.assertRaises(ValueError):
                    m.quantity(value,"test")

    def test_sanitized_outputs_no_rpc_urls_or_secrets(self):
        x=assess(call=fake_rpc)
        raw=canonical(x).decode()
        self.assertNotIn("https://",raw)
        self.assertNotIn("private_key",raw)
        self.assertNotIn("eth_sendRawTransaction",raw)


if __name__=="__main__":
    unittest.main()
