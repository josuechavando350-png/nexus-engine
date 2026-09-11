from __future__ import annotations

import copy
import unittest

from fixture import rich_payload, row_for
from runtime.common import canonical_json
from runtime.final_specs import FINAL_SPECS, SOURCE_MODULES, TARGET_MODULES
from runtime.manifest import source_to_target_map
from runtime.runner import run_module


class Final751To800Tests(unittest.TestCase):
    def test_exact_50_source_target_mapping(self):
        self.assertEqual(TARGET_MODULES, tuple(f'M{i}' for i in range(751, 801)))
        self.assertEqual(SOURCE_MODULES, tuple(f'M{i}' for i in range(1751, 1801)))
        mapping = source_to_target_map()
        self.assertEqual(mapping['M1751'], 'M751')
        self.assertEqual(mapping['M1800'], 'M800')
        for source in SOURCE_MODULES:
            self.assertEqual(mapping[source], f'M{int(source[1:]) - 1000}')

    def test_family_cardinality_is_exact(self):
        counts = {}
        for spec in FINAL_SPECS.values(): counts[spec['family']] = counts.get(spec['family'], 0) + 1
        self.assertEqual(counts, {'EDGE_PARITY': 24, 'RELATIONAL_BAYES': 26})

    def test_operations_are_unique_and_not_id_clones(self):
        operations = [spec['operation'] for spec in FINAL_SPECS.values()]
        self.assertEqual(len(operations), 50)
        self.assertEqual(len(set(operations)), 50)
        self.assertFalse(any(op.rsplit('_', 1)[-1].isdigit() for op in operations))

    def test_all_50_execute_successfully(self):
        payload = rich_payload()
        receipts = {m: run_module(m, payload, {}) for m in TARGET_MODULES}
        self.assertTrue(all(r['execution_status'] == 'SUCCESS' for r in receipts.values()))
        self.assertTrue(all(r['output']['metric_ppm'] == 1_000_000 for r in receipts.values()))
        self.assertEqual(len({r['algorithm'] for r in receipts.values()}), 50)

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        first = canonical_json({m: run_module(m, payload, {}) for m in TARGET_MODULES})
        second = canonical_json({m: run_module(m, copy.deepcopy(payload), {}) for m in TARGET_MODULES})
        self.assertEqual(first, second)

    def test_crawler_identity_is_evidence_only(self):
        spec = FINAL_SPECS['M754']
        self.assertEqual(spec['operation'], 'crawler_identity_evidence_guard')
        self.assertEqual(spec['input_fields'], ('claimed_crawler_requests', 'verified_identity_requests'))
        receipt = run_module('M754', rich_payload(), {})
        self.assertEqual(receipt['execution_status'], 'SUCCESS')
        self.assertNotIn('content', canonical_json(receipt['output']).casefold())

    def test_missing_crawler_evidence_is_insufficient(self):
        payload = rich_payload()
        row = next(r for r in payload['edge_parity_records'] if r['module_id'] == 'M754')
        row['claimed_crawler_requests'] = 0
        row['verified_identity_requests'] = 0
        receipt = run_module('M754', payload, {})
        self.assertEqual(receipt['execution_status'], 'INSUFFICIENT_DATA')

    def test_float_is_rejected(self):
        payload = rich_payload()
        payload['relational_bayes_records'][-1]['retry_attempts'] = 1.0
        receipt = run_module('M800', payload, {})
        self.assertEqual(receipt['execution_status'], 'ERROR')
        self.assertEqual(receipt['reason_code'], 'floats_not_allowed')

    def test_deadlock_budget_finds_exhaustion(self):
        payload = rich_payload()
        row = next(r for r in payload['relational_bayes_records'] if r['module_id'] == 'M800')
        row['retry_attempts'] = 4
        row['retry_limit'] = 3
        receipt = run_module('M800', payload, {})
        self.assertEqual(receipt['execution_status'], 'SUCCESS')
        self.assertEqual(receipt['finding_status'], 'FINDING')

    def test_config_is_hash_bound(self):
        payload = rich_payload()
        default = run_module('M751', payload, {})
        changed = run_module('M751', payload, {'m751_threshold_ppm': 900_000})
        self.assertNotEqual(default['module_config_hash'], changed['module_config_hash'])
        self.assertNotEqual(default['evidence_hash'], changed['evidence_hash'])


if __name__ == '__main__':
    unittest.main()
