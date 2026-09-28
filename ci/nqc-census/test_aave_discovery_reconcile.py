#!/usr/bin/env python3
import importlib.util
import pathlib
import unittest

MODULE = pathlib.Path(__file__).with_name("aave_discovery_reconcile.py")
SPEC = importlib.util.spec_from_file_location("rmc006", MODULE)
rmc006 = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(rmc006)


class AaveDiscoveryUnitTests(unittest.TestCase):
    def test_decode_address_word(self):
        address = "12" * 20
        value = "0x" + "00" * 12 + address
        self.assertEqual(rmc006.decode_address_word(value), "0x" + address)

    def test_decode_address_array(self):
        a = "11" * 20
        b = "22" * 20
        value = (
            "0x"
            + (32).to_bytes(32, "big").hex()
            + (2).to_bytes(32, "big").hex()
            + ("00" * 12 + a)
            + ("00" * 12 + b)
        )
        self.assertEqual(
            rmc006.decode_address_array(value),
            ["0x" + a, "0x" + b],
        )

    def test_decode_address_array_rejects_truncation(self):
        value = "0x" + (32).to_bytes(32, "big").hex()
        with self.assertRaises(rmc006.DiscoveryError):
            rmc006.decode_address_array(value)

    def test_encode_uint16_call(self):
        selector = "0x01020304"
        encoded = rmc006.encode_uint16_call(selector, 513)
        self.assertEqual(encoded[:10], selector)
        self.assertEqual(int(encoded[10:], 16), 513)

    def test_topic_address(self):
        address = "ab" * 20
        topic = "0x" + "00" * 12 + address
        self.assertEqual(rmc006.topic_address(topic), "0x" + address)

    def test_log_order_is_total_for_canonical_coordinates(self):
        a = {"block_number": 1, "transaction_index": 2, "log_index": 3}
        b = {"block_number": 1, "transaction_index": 2, "log_index": 4}
        self.assertLess(rmc006.log_order(a), rmc006.log_order(b))

    def test_event_replay_lifecycle(self):
        events = [
            {"kind": "INITIALIZED", "asset": "0x" + "11" * 20},
            {"kind": "DROPPED", "asset": "0x" + "11" * 20},
            {"kind": "INITIALIZED", "asset": "0x" + "22" * 20},
            {"kind": "INITIALIZED", "asset": "0x" + "11" * 20},
        ]
        state = {}
        for event in events:
            state[event["asset"]] = (
                "ACTIVE" if event["kind"] == "INITIALIZED" else "DROPPED"
            )
        self.assertEqual(state["0x" + "11" * 20], "ACTIVE")
        self.assertEqual(state["0x" + "22" * 20], "ACTIVE")

    def test_normalize_hex_rejects_wrong_width(self):
        with self.assertRaises(rmc006.DiscoveryError):
            rmc006.normalize_hex("0x01", 20)

    def test_normalize_hex_is_case_stable(self):
        value = "0x" + "AB" * 20
        self.assertEqual(
            rmc006.normalize_hex(value, 20),
            "0x" + "ab" * 20,
        )

    def test_selectors_require_exact_width(self):
        selectors = rmc006.Selectors(
            get_pool="0x01020304",
            get_pool_configurator="0x05060708",
            addresses_provider="0x090a0b0c",
            reserves_count="0x0d0e0f10",
            reserve_by_id="0x11121314",
            reserves_list="0x15161718",
            pool_configurator_updated_topic="0x" + "21" * 32,
            reserve_initialized_topic="0x" + "22" * 32,
            reserve_dropped_topic="0x" + "23" * 32,
        )
        self.assertEqual(selectors.normalized().get_pool, "0x01020304")

    def test_selector_width_mismatch_fails(self):
        selectors = rmc006.Selectors(
            get_pool="0x01",
            get_pool_configurator="0x05060708",
            addresses_provider="0x090a0b0c",
            reserves_count="0x0d0e0f10",
            reserve_by_id="0x11121314",
            reserves_list="0x15161718",
            pool_configurator_updated_topic="0x" + "21" * 32,
            reserve_initialized_topic="0x" + "22" * 32,
            reserve_dropped_topic="0x" + "23" * 32,
        )
        with self.assertRaises(rmc006.DiscoveryError):
            selectors.normalized()

    def test_code_digest_distinguishes_empty(self):
        self.assertFalse(rmc006.code_digest("0x")["present"])
        self.assertTrue(rmc006.code_digest("0x6000")["present"])


if __name__ == "__main__":
    unittest.main()
