#!/usr/bin/env python3
"""Offline adversarial tests for historical Aave oracle observations; never Nexus P&L."""
import copy,importlib.util,unittest
from pathlib import Path
P=Path(__file__).with_name("rmc016_historical_gas_price_oracle.py")
S=importlib.util.spec_from_file_location("oracle_probe",P)
M=importlib.util.module_from_spec(S);S.loader.exec_module(M)

def price(block):
    if block==M.END_BLOCK:return M.ANCHOR_PRICE
    return 2010*M.UNIT+(block%1000)
def api(url,method,params):
    if method=="eth_chainId":return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        return {"number":hex(n),"hash":M.END_HASH if n==M.END_BLOCK else
                "0x"+f"{n:064x}"}
    if method=="eth_call":
        assert params[0]["to"]==M.ORACLE
        assert params[0]["data"]==M.CALLDATA
        return "0x"+f"{price(int(params[1],16)):064x}"
    raise ValueError(method)

class HistoricalOracleGate(unittest.TestCase):
    def test_sampled_prices_pass_only_early_block_scope(self):
        report=M.probe(api)
        self.assertEqual(report["status"],"RMC016_TWO_OPERATOR_AAVE_WETH_HISTORICAL_ORACLE_SAMPLE_PASS")
        self.assertTrue(report["independent_sample_consensus"])
        self.assertEqual(report["sample_count"],4)
        self.assertFalse(report["claims_exact_pre_transaction_price"])
        self.assertFalse(report["historical_full_receipt_gas_priced"])
        self.assertFalse(report["nexus_profitability_proven"])
        self.assertEqual(report["prices"][str(M.END_BLOCK)]["price_raw"],str(M.ANCHOR_PRICE))
    def test_stable_commitment(self):
        self.assertEqual(M.probe(api)["report_sha256"],M.probe(api)["report_sha256"])
    def test_correct_function_selector(self):
        self.assertEqual(M.CALLDATA[:10],"0xb3596f07")
        self.assertEqual(len(M.CALLDATA),74)
        self.assertEqual(M.CALLDATA[-40:],M.WETH[2:])
    def test_zero_price_rejected(self):
        with self.assertRaisesRegex(ValueError,"zero/negative"):
            M.normalize_result("0x"+"0"*64)
    def test_malformed_price_data_rejected(self):
        for x in ["0x1","0x"+"q"*64,123,"1","0x"+"0"*65]:
            with self.assertRaises(ValueError):
                M.normalize_result(x)
    def test_wrong_chain_rejected(self):
        def bad(u,m,p):
            return "0x89" if m=="eth_chainId" else api(u,m,p)
        report=M.probe(bad)
        self.assertIn("wrong chain",report["blocking_reason"])
        self.assertFalse(report["independent_sample_consensus"])
    def test_anchor_hash_mismatch_rejected(self):
        def bad(u,m,p):
            x=api(u,m,p)
            if m=="eth_getBlockByNumber" and p[0]==hex(M.END_BLOCK):
                return {**x,"hash":"0x"+"f"*64}
            return x
        self.assertIn("anchor hash changed",M.probe(bad)["blocking_reason"])
    def test_d08_anchor_oracle_price_falsification_rejected(self):
        def bad(u,m,p):
            if m=="eth_call" and p[1]==hex(M.END_BLOCK):
                return "0x"+f"{M.ANCHOR_PRICE+1:064x}"
            return api(u,m,p)
        self.assertIn("D08 WETH oracle end-anchor parity",M.probe(bad)["blocking_reason"])
    def test_dual_operator_price_mismatch_rejected(self):
        def bad(u,m,p):
            if m=="eth_call" and "blast" in u and p[1]!=hex(M.END_BLOCK):
                n=int(p[1],16)
                return "0x"+f"{price(n)+1:064x}"
            return api(u,m,p)
        self.assertIn("independent providers disagree",M.probe(bad)["blocking_reason"])
    def test_changing_provider_set_rejected(self):
        with self.assertRaisesRegex(ValueError,"exact two independent operators"):
            M.probe(api,providers=[M.PROVIDERS[0],M.PROVIDERS[0]])
    def test_rpc_failure_report_not_fake_success(self):
        def bad(u,m,p):
            if m=="eth_call":raise ValueError("historical provider unavailable")
            return api(u,m,p)
        report=M.probe(bad)
        self.assertEqual(report["status"],"RMC016_HISTORICAL_PREBLOCK_ORACLE_SAMPLES_BLOCKED")
        self.assertFalse(report["historical_full_receipt_gas_priced"])
    def test_invalid_interval_rejected(self):
        with self.assertRaises(ValueError):M.probe(api,min_interval=25)
    def test_oracle_samples_are_prior_to_reference_events(self):
        self.assertEqual(M.SAMPLES[:3],(25883782,26001679,26085026))
        self.assertTrue(all(n<M.END_BLOCK for n in M.SAMPLES[:-1]))
        self.assertEqual(M.UNIT,10**8)

if __name__=="__main__":unittest.main()
