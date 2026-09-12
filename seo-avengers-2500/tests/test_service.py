import unittest

from runtime.service import execute_avengers_2500
from test_batch_2201_2400 import fixture


class Avengers2500ServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.payload, cls.config = fixture()

    def test_deny_by_default_executes_nothing(self):
        result = execute_avengers_2500(self.payload, {})
        self.assertFalse(result["enabled"])
        self.assertEqual(result["executed_local_modules"], 0)
        self.assertEqual(result["receipts"], {})
        self.assertFalse(result["release_safe"])
        self.assertEqual(result["reason"], "CLIENT_DISABLED")

    def test_literal_true_executes_exact_local_slice(self):
        config = dict(self.config)
        config["CONFIG_SEO_AVENGERS_2500"] = True
        result = execute_avengers_2500(self.payload, config)
        self.assertTrue(result["enabled"])
        self.assertEqual(result["target_registry_size"], 2500)
        self.assertEqual(result["delegated_production_count"], 1000)
        self.assertEqual(result["executed_local_modules"], 1500)
        self.assertEqual(tuple(result["receipts"]), tuple(f"M{i}" for i in range(1001, 2501)))
        self.assertTrue(result["release_safe"])
        self.assertEqual(result["reason"], "PASS")

    def test_truthy_non_boolean_does_not_enable(self):
        config = dict(self.config)
        config["CONFIG_SEO_AVENGERS_2500"] = 1
        result = execute_avengers_2500(self.payload, config)
        self.assertFalse(result["enabled"])
        self.assertEqual(result["executed_local_modules"], 0)


if __name__ == "__main__":
    unittest.main()
