from __future__ import annotations

import copy
import unittest

from fixture import rich_payload
from runtime.catalog import DELEGATED_MODULES, NEW_MODULES, TOTAL_MODULES, module_registry
from runtime.common import canonical_json
from runtime.manifest import MODULE_SPECS, SOURCE_MODULES, TARGET_MODULES, source_to_target_map
from runtime.runner import run_new_200
from runtime.service import execute_avengers_800


class Avengers800Tests(unittest.TestCase):
    def test_registry_is_exactly_800(self):
        registry = module_registry()
        self.assertEqual(TOTAL_MODULES, 800)
        self.assertEqual(tuple(registry), tuple(f'M{i}' for i in range(1, 801)))
        self.assertNotIn('M801', registry)
        self.assertEqual(len(DELEGATED_MODULES), 600)
        self.assertEqual(len(NEW_MODULES), 200)
        self.assertTrue(all(registry[f'M{i}']['status'] == 'DELEGATED_PRODUCTION' for i in range(1, 601)))
        self.assertTrue(all(registry[f'M{i}']['status'] == 'IMPLEMENTED_PRODUCTION' for i in range(601, 801)))

    def test_source_mapping_is_exactly_sequential(self):
        self.assertEqual(TARGET_MODULES, tuple(f'M{i}' for i in range(601, 801)))
        self.assertEqual(SOURCE_MODULES, tuple(f'M{i}' for i in range(1601, 1801)))
        mapping = source_to_target_map()
        self.assertEqual(len(mapping), 200)
        for source in SOURCE_MODULES:
            self.assertEqual(mapping[source], f'M{int(source[1:]) - 1000}')

    def test_200_operations_are_unique(self):
        operations = [spec['operation'] for spec in MODULE_SPECS.values()]
        self.assertEqual(len(operations), 200)
        self.assertEqual(len(set(operations)), 200)

    def test_all_new_200_execute_successfully(self):
        receipts = run_new_200(rich_payload(), {})
        self.assertEqual(len(receipts), 200)
        self.assertTrue(all(r['execution_status'] == 'SUCCESS' for r in receipts.values()))
        self.assertEqual(len({r['algorithm'] for r in receipts.values()}), 200)

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        first = canonical_json(run_new_200(payload, {}))
        second = canonical_json(run_new_200(copy.deepcopy(payload), {}))
        self.assertEqual(first, second)

    def test_service_is_deny_by_default_and_delegates_first_600(self):
        payload = rich_payload()
        disabled = execute_avengers_800(payload, {})
        self.assertFalse(disabled['enabled'])
        self.assertEqual(disabled['delegated_modules'], 600)
        self.assertEqual(disabled['executed_new_modules'], 0)
        self.assertEqual(disabled['receipts'], {})
        enabled = execute_avengers_800(payload, {'CONFIG_SEO_AVENGERS_800': True})
        self.assertTrue(enabled['enabled'])
        self.assertEqual(enabled['total_modules'], 800)
        self.assertEqual(enabled['delegated_runtime'], 'seo-avengers-600')
        self.assertEqual(enabled['delegated_modules'], 600)
        self.assertEqual(enabled['executed_new_modules'], 200)
        self.assertEqual(tuple(enabled['receipts']), TARGET_MODULES)


if __name__ == '__main__':
    unittest.main()
