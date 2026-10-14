import copy
import unittest

import oracle_price_path_fork as p


def case(family="PRIMARY_NEW_TRANSMISSION"):
    return {"block": 26188605, "timestamp": 1791955199,
            "block_hash": "0x" + "12"*32,
            "tx_hash": "0x" + "ab"*32,
            "tx_index": 51, "round_id": 24873,
            "topic": "0x" + "34"*32,
            "family": family}


def metrics(changed=True):
    v = {
        "NQC_AAVE_PRICE_BEFORE": 251000000000,
        "NQC_AAVE_PRICE_AFTER": 250500000000 if changed else 251000000000,
        "NQC_CHAINLINK_ANSWER_BEFORE": 251000000000,
        "NQC_CHAINLINK_ANSWER_AFTER": 250500000000 if changed else 251000000000,
        "NQC_CHAINLINK_ROUND_BEFORE": 24872,
        "NQC_CHAINLINK_ROUND_AFTER": 24873 if changed else 24872,
        "NQC_PRICE_CHANGED": int(changed),
        "NQC_MATCHED_ORACLE_EVENT": 1,
    }
    return v


def forge_log(mutated=None, passed=True):
    m = {**metrics(), **(mutated or {})}
    return (
        "[PASS] testPinnedConfirmedOracleTransactionPricePath()\n"
        "Suite result: " + ("ok. 1 passed; 0 failed; 0 skipped\n"
                            if passed else "FAILED. 0 passed; 1 failed; 0 skipped\n") +
        "".join(f"  {key}: {value}\n" for key, value in m.items()) +
        "  NQC_AAVE_PRICE_ORACLE: 0x" + "56"*20 + "\n" +
        "  NQC_CHAINLINK_PRICE_SOURCE: 0x" + "78"*20 + "\n"
    )


def rows(family1="PRIMARY_NEW_TRANSMISSION"):
    families=(family1, "SECONDARY_ROUND_ID_UPDATED",
              family1, "SECONDARY_ROUND_ID_UPDATED")
    out=[]
    for i,family in enumerate(families):
        c=case(family)
        c['tx_hash']="0x"+f'{i+1:064x}'
        out.append({"case":c, "dRPC":{
            **metrics(changed=(i%2==1)), "AAVE_PRICE_DELTA_RAW": -10 if (i%2==1) else 0,
            "source_event_family":family}, "BlastAPI":None, "source_parity":False})
    return out


class OraclePricePathTests(unittest.TestCase):
    def test_positive_source_digest_is_immutable(self):
        with self.assertRaises(ValueError):
            p.authenticate_source(b"not a source archive")

    def test_complete_fork_log_has_zero_guess_about_profit(self):
        m=p.parse_forge_log(forge_log(),case())
        self.assertEqual(m["NQC_PRICE_CHANGED"],1)
        self.assertEqual(m["AAVE_PRICE_DELTA_RAW"],-500000000)
        self.assertTrue(m["historical_only"])
        self.assertTrue(m["source_event_does_not_guarantee_price_change"])

    def test_secondary_event_without_price_change_is_valid_negative_evidence(self):
        m=p.parse_forge_log(
            forge_log({**metrics(changed=False)}),
            case("SECONDARY_ROUND_ID_UPDATED"))
        self.assertEqual(m["NQC_PRICE_CHANGED"],0)
        self.assertEqual(m["AAVE_PRICE_DELTA_RAW"],0)
        self.assertEqual(m["source_event_family"],"SECONDARY_ROUND_ID_UPDATED")

    def test_duplicate_numeric_evidence_rejected(self):
        s=forge_log() + "  NQC_AAVE_PRICE_AFTER: 250500000000\n"
        with self.assertRaises(ValueError):
            p.parse_forge_log(s,case())

    def test_fork_failure_not_reclassified_success(self):
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log(passed=False),case())

    def test_unrelated_solidity_test_rejected(self):
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log().replace(
                "testPinnedConfirmedOracleTransactionPricePath",
                "testUnrelatedFork"),case())

    def test_unsupported_price_claim_rejected(self):
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log({"NQC_PRICE_CHANGED":0}),case())

    def test_mismatched_single_positive_event_rejected(self):
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log({"NQC_MATCHED_ORACLE_EVENT":2}),case())

    def test_unusable_zero_price_and_round_rejected(self):
        for k in ("NQC_AAVE_PRICE_BEFORE", "NQC_AAVE_PRICE_AFTER",
                  "NQC_CHAINLINK_ANSWER_BEFORE", "NQC_CHAINLINK_ROUND_AFTER"):
            with self.subTest(k=k),self.assertRaises(ValueError):
                p.parse_forge_log(forge_log({k:0}),case())

    def test_invalid_address_identity_rejected(self):
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log().replace(
                "NQC_CHAINLINK_PRICE_SOURCE: 0x" + "78"*20,
                "NQC_CHAINLINK_PRICE_SOURCE: 0x" + "00"*20),case())

    def test_unknown_source_event_family_rejected(self):
        c=case("SUSPICIOUS_UNKNOWN_EVENT")
        with self.assertRaises(ValueError):
            p.parse_forge_log(forge_log(),c)

    def test_partial_one_source_summary_preserves_coverage(self):
        s=p.summary(rows())
        self.assertEqual(s["status"], "FOUR_HISTORICAL_PRICE_PATHS_SINGLE_SOURCE_ONLY")
        self.assertEqual(s["by_event_family"]["PRIMARY_NEW_TRANSMISSION"]["transactions"],2)
        self.assertEqual(s["by_event_family"]["PRIMARY_NEW_TRANSMISSION"]["aave_price_unchanged"],2)
        self.assertEqual(s["by_event_family"]["SECONDARY_ROUND_ID_UPDATED"]["aave_price_changed"],2)

    def test_missing_first_case_does_not_claim_four_source_paths(self):
        a=rows()
        a[0]["dRPC"]=None
        result=p.summary(a)
        self.assertEqual(result["status"],"UNKNOWN_INCOMPLETE_PRICE_PATH")
        self.assertEqual(result["available_single_source_paths"],3)

    def test_restricted_fork_source_chain_contract(self):
        import oracle_round_transaction_order as prev
        caller=prev.RPC("drpc",lambda method,params:None)
        with self.assertRaises(ValueError):
            caller.call("eth_sendRawTransaction",["0x1234"])
        with self.assertRaises(ValueError):
            caller.call("eth_getBlockByNumber",["latest",False],
                        allowed_blocks={26188605})
        self.assertEqual(caller.calls,0)


if __name__=="__main__":
    unittest.main()
