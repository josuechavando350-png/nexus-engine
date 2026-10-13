from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch

MOD = Path(__file__).with_name("nqc_v2_aave_rpc_observer.py")
spec = importlib.util.spec_from_file_location("nqc_observer", MOD)
assert spec is not None and spec.loader is not None
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)

BLOCK = {"number": hex(26181269), "hash": "0x" + "a" * 64,
         "parentHash": "0x" + "b" * 64, "timestamp": hex(1791880000)}
ACCOUNT = [675980297401691, 621678566556913, 0, 9199, 8999, 1000359198229411800]


def simulated_rpc(endpoint, method, params):
    if method == "eth_chainId":
        return "0x1"
    if method == "eth_blockNumber":
        return hex(26181272)
    if method == "eth_getBlockByNumber":
        return BLOCK.copy()
    if method == "eth_call":
        return "0x" + "".join(f"{n:064x}" for n in ACCOUNT)
    raise AssertionError(method)


class ObserverTests(unittest.TestCase):
    @patch.object(observer, "rpc", side_effect=simulated_rpc)
    def test_two_rpc_quorum_complete(self, _):
        x = observer.observe(("https://rpc-a.test", "https://rpc-b.test"))
        self.assertEqual(x["status"], "HF_NOT_BELOW_ONE_STATE_OBSERVED")
        self.assertFalse(x["health_factor_lt_one"])
        self.assertEqual(x["account_data"]["health_factor_wad"], str(ACCOUNT[5]))
        self.assertEqual(x["block"]["number"], 26181269)
        self.assertIn("NOT_PROSPECTIVE_CROSSING_PROOF", x["non_claims"])

    @patch.object(observer, "rpc", side_effect=simulated_rpc)
    def test_crossing_not_claimed_without_before_event(self, mock):
        del mock
        ACCOUNT[5] = 999999999999999999
        try:
            result = observer.observe(("https://rpc-a.test", "https://rpc-b.test"))
            self.assertEqual(result["status"], "HF_BELOW_ONE_STATE_OBSERVED")
            self.assertIn("NOT_PROSPECTIVE_CROSSING_PROOF", result["non_claims"])
        finally:
            ACCOUNT[5] = 1000359198229411800

    def test_calldata_address_padding(self):
        self.assertEqual(len(observer.calldata(observer.BORROWER)), 10 + 64)
        with self.assertRaisesRegex(observer.EvidenceError, "invalid borrower"):
            observer.calldata("0x123")

    def test_response_parse_requires_six_words(self):
        with self.assertRaisesRegex(observer.EvidenceError, "six-word"):
            observer.parse_account("0x1234")

    def test_throws_on_head_divergence(self):
        def bad_rpc(endpoint, method, params):
            if method == "eth_blockNumber":
                return hex(26181272 if endpoint.endswith("a") else 26181200)
            return simulated_rpc(endpoint, method, params)
        with patch.object(observer, "rpc", side_effect=bad_rpc):
            with self.assertRaisesRegex(observer.EvidenceError, "head lag"):
                observer.observe(("a", "b"))

    def test_throws_on_block_hash_mismatch(self):
        def bad_rpc(endpoint, method, params):
            data = simulated_rpc(endpoint, method, params)
            if method == "eth_getBlockByNumber" and endpoint == "b":
                return {**data, "hash": "0x" + "f" * 64}
            return data
        with patch.object(observer, "rpc", side_effect=bad_rpc):
            with self.assertRaisesRegex(observer.EvidenceError, "block consensus"):
                observer.observe(("a", "b"))

    def test_throws_on_read_disagreement(self):
        def bad_rpc(endpoint, method, params):
            data = simulated_rpc(endpoint, method, params)
            if method == "eth_call" and endpoint == "b":
                return "0x" + "".join(f"{n:064x}" for n in [*ACCOUNT[:-1], ACCOUNT[-1]-1])
            return data
        with patch.object(observer, "rpc", side_effect=bad_rpc):
            with self.assertRaisesRegex(observer.EvidenceError, "disagrees"):
                observer.observe(("a", "b"))

    def test_throws_on_midread_reorg(self):
        calls = {"a": 0, "b": 0}
        def bad_rpc(endpoint, method, params):
            if method != "eth_getBlockByNumber":
                return simulated_rpc(endpoint, method, params)
            calls[endpoint] += 1
            if calls[endpoint] >= 2:
                return {**BLOCK, "hash": "0x" + "f" * 64}
            return BLOCK.copy()
        with patch.object(observer, "rpc", side_effect=bad_rpc):
            with self.assertRaisesRegex(observer.EvidenceError, "reorg"):
                observer.observe(("a", "b"))

    def test_failover_skips_failed_provider_and_requires_two_rpc(self):
        def unreliable(endpoint, method, params):
            if endpoint.endswith("first"):
                raise observer.EvidenceError("HTTP 525")
            return simulated_rpc(endpoint, method, params)
        with patch.object(observer, "rpc", side_effect=unreliable):
            chosen = observer.select_endpoints(("https://first", "https://second", "https://third"))
            self.assertEqual(chosen, ("https://second", "https://third"))

    def test_no_single_rpc_provider_satisfies_quorum(self):
        def unreliable(endpoint, method, params):
            if endpoint.endswith("unavailable"):
                raise observer.EvidenceError("HTTP 525")
            return simulated_rpc(endpoint, method, params)
        with patch.object(observer, "rpc", side_effect=unreliable):
            with self.assertRaisesRegex(observer.EvidenceError, "RPC_QUORUM_UNAVAILABLE"):
                observer.select_endpoints(("https://good", "https://unavailable"))

    def test_reject_same_rpc_domain_repeated(self):
        with patch.object(observer, "rpc", side_effect=simulated_rpc):
            with self.assertRaisesRegex(observer.EvidenceError, "RPC_QUORUM_UNAVAILABLE"):
                observer.select_endpoints(("https://rpc.test", "https://rpc.test/path"))

    def test_no_broadcast_whitelisted(self):
        with self.assertRaisesRegex(observer.EvidenceError, "unsupported RPC method"):
            observer.rpc("x", "eth_sendRawTransaction", [])


if __name__ == "__main__":
    unittest.main()
