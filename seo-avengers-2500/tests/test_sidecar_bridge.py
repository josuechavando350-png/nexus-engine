from __future__ import annotations

import unittest
from unittest.mock import patch

from sidecar import execute_suite


class SidecarBridgeTests(unittest.TestCase):
    def _receipts(self):
        receipts = {}
        for number in range(1001, 2501):
            module_id = f"M{number}"
            receipts[module_id] = {
                "module": module_id,
                "policy_status": "SAFE_WHITE_HAT",
                "action_mode": "OBSERVE_ONLY",
                "execution_status": "SUCCESS",
                "finding_status": "NO_FINDING",
                "evidence_hash": "sha256:" + ("a" * 64),
            }
        return receipts

    def test_execute_request_delegates_to_exact_local_runner(self):
        receipts = self._receipts()
        with patch.object(execute_suite, "run_batch_1001_2500", return_value=receipts) as runner:
            result = execute_suite.execute_request({
                "schema_version": 1,
                "payload": {"content_documents": []},
                "config": {},
            })
        runner.assert_called_once_with({"content_documents": []}, {})
        self.assertEqual(result["schema_version"], 1)
        self.assertEqual(result["receipt_count"], 1500)
        self.assertEqual(result["first_module"], "M1001")
        self.assertEqual(result["last_module"], "M2500")
        self.assertEqual(result["terminal_evidence_hash"], receipts["M2500"]["evidence_hash"])
        self.assertRegex(result["execution_hash"], r"^sha256:[0-9a-f]{64}$")
        self.assertEqual(tuple(result["receipts"]), tuple(f"M{i}" for i in range(1001, 2501)))

    def test_execute_request_rejects_extra_fields(self):
        with self.assertRaisesRegex(ValueError, "unexpected_request_keys"):
            execute_suite.execute_request({
                "schema_version": 1,
                "payload": {},
                "config": {},
                "surprise": True,
            })

    def test_execute_request_rejects_wrong_schema(self):
        with self.assertRaisesRegex(ValueError, "unsupported_request_schema"):
            execute_suite.execute_request({"schema_version": 2, "payload": {}, "config": {}})

    def test_execute_request_rejects_non_mapping_payload_or_config(self):
        with self.assertRaisesRegex(TypeError, "payload_must_be_mapping"):
            execute_suite.execute_request({"schema_version": 1, "payload": [], "config": {}})
        with self.assertRaisesRegex(TypeError, "config_must_be_mapping"):
            execute_suite.execute_request({"schema_version": 1, "payload": {}, "config": []})


if __name__ == "__main__":
    unittest.main()
