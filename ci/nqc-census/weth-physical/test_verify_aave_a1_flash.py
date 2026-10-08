#!/usr/bin/env python3
"""Adversarial input gates for source-scoped Aave historical flash premium."""
import copy
import unittest

import verify_aave_a1_flash as m
from verify_weth_rpc import BLOCK_NUMBER, BLOCK_HASH


HEADER = {
    "number": hex(BLOCK_NUMBER),
    "hash": BLOCK_HASH,
    "parentHash": "0x"+"a"*64,
    "stateRoot": "0x"+"b"*64,
    "timestamp": "0x60000000",
}
CODE = "0x" + "6011"*100


def dummy(url, method, params):
    if method == "eth_chainId":
        return "0x1"
    if method == "eth_getBlockByNumber":
        assert params == [hex(BLOCK_NUMBER), False]
        return copy.deepcopy(HEADER)
    if method == "eth_getCode":
        assert params == [m.POOL, hex(BLOCK_NUMBER)]
        return CODE
    if method == "eth_call":
        assert params == [{"to":m.POOL,"data":m.PREMIUM_SELECTOR}, hex(BLOCK_NUMBER)]
        return "0x" + f"{5:064x}"
    raise ValueError("unsupported request")


class TestAaveA1HistoricalFee(unittest.TestCase):
    def test_positive_independent_aave_premium(self):
        r=m.assess(call=dummy)
        self.assertEqual(r["status"], "RMC011_AAVE_POOL_A1_FLASH_PREMIUM_DUAL_OPERATOR_PASS")
        self.assertEqual(r["premium_bps"], 5)
        self.assertEqual(len(r["provider_evidence"]), 2)
        self.assertEqual(r["report_sha256"], m.digest(m.canonical(
            {k:v for k,v in r.items() if k!="report_sha256"})))

    def test_not_an_execution_or_gas_sponsor_certification(self):
        r=m.assess(call=dummy)
        for field in (
            "on_chain_liquidity_available_to_nexus_proven",
            "flash_principal_borrow_replayed",
            "gas_sponsorship_proven",
            "zero_own_capital_eligibility_proven",
            "complete_liquidation_or_positive_nexus_net_pnl_proven",
            "real_market_census_closed",
        ):
            self.assertFalse(r[field])

    def test_wrong_chain(self):
        def altered(url,method,params):
            return "0x2" if method=="eth_chainId" else dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"wrong Aave Ethereum chain"):
            m.assess(call=altered)

    def test_reorg_header(self):
        def altered(url,method,params):
            if method=="eth_getBlockByNumber":
                v=dummy(url,method,params);v["hash"]="0x"+"a"*64;return v
            return dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"historical block hash"):
            m.assess(call=altered)

    def test_no_pool_code(self):
        def altered(url,method,params):
            return "0x" if method=="eth_getCode" else dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"runtime code unavailable"):
            m.assess(call=altered)

    def test_mutated_pool_code_between_providers(self):
        def altered(url,method,params):
            if method=="eth_getCode" and "blastapi" in url:
                return "0x"+"6012"*100
            return dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"providers disagree"):
            m.assess(call=altered)

    def test_mutated_fee_between_providers(self):
        def altered(url,method,params):
            if method=="eth_call" and "blastapi" in url:
                return "0x"+f"{7:064x}"
            return dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"providers disagree"):
            m.assess(call=altered)

    def test_reject_invalid_and_zero_return(self):
        for result in ("0x5","0x",True,None,5,"0x"+"0"*64):
            def altered(url,method,params):
                return result if method=="eth_call" else dummy(url,method,params)
            with self.subTest(value=str(result)[:12]):
                with self.assertRaises(ValueError):
                    m.assess(call=altered)

    def test_fee_rate_over_100_percent_refused(self):
        def altered(url,method,params):
            return "0x"+f"{10001:064x}" if method=="eth_call" else dummy(url,method,params)
        with self.assertRaisesRegex(ValueError,"bps domain"):
            m.assess(call=altered)

    def test_duplicate_operator_not_consensus(self):
        with self.assertRaisesRegex(ValueError,"independent"):
            m.assess(call=dummy,providers=[("drpc","same","a"),("blast","same","b")])

    def test_no_latest_tag_or_transaction_side_effect(self):
        queries=[]
        def seen(url,method,params):
            queries.append((method,params))
            return dummy(url,method,params)
        m.assess(call=seen)
        self.assertEqual(len(queries),8)
        self.assertEqual(sum(method=="eth_call" for method,_ in queries),2)
        self.assertFalse(any(method.startswith("eth_send") for method,_ in queries))
        self.assertNotIn(["latest"],[p for _,p in queries])


if __name__ == "__main__":
    unittest.main()
