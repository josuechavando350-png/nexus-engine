from __future__ import annotations

import copy
import unittest

from fixture import rich_payload, row_for
from runtime.common import canonical_json
from runtime.foundation_specs import FOUNDATION_SPECS, SOURCE_MODULES, TARGET_MODULES
from runtime.manifest import source_to_target_map
from runtime.runner import run_foundation_100, run_module


class Foundation601To700Tests(unittest.TestCase):
    def test_exact_100_source_target_mapping(self):
        self.assertEqual(TARGET_MODULES, tuple(f'M{i}' for i in range(601, 701)))
        self.assertEqual(SOURCE_MODULES, tuple(f'M{i}' for i in range(1601, 1701)))
        mapping = source_to_target_map()
        self.assertEqual(mapping['M1601'], 'M601')
        self.assertEqual(mapping['M1700'], 'M700')
        for source in SOURCE_MODULES:
            self.assertEqual(mapping[source], f'M{int(source[1:]) - 1000}')

    def test_family_cardinality_is_exact(self):
        counts = {}
        for spec in FOUNDATION_SPECS.values():
            counts[spec['family']] = counts.get(spec['family'], 0) + 1
        self.assertEqual(counts, {
            'SEMANTIC_INTENT': 25,
            'HTML_FOUNDATION': 25,
            'EDGE_FOUNDATION': 24,
            'RELATIONAL_FOUNDATION': 26,
        })

    def test_operations_are_unique_and_not_id_clones(self):
        operations = [spec['operation'] for spec in FOUNDATION_SPECS.values()]
        self.assertEqual(len(operations), 100)
        self.assertEqual(len(set(operations)), 100)
        self.assertFalse(any('metric_' in op or 'router_' in op and op.rsplit('_', 1)[-1].isdigit() for op in operations))
        self.assertGreaterEqual(len({spec['formula'] for spec in FOUNDATION_SPECS.values()}), 12)

    def test_all_100_execute_successfully(self):
        receipts = run_foundation_100(rich_payload(), {})
        self.assertEqual(len(receipts), 100)
        self.assertTrue(all(r['execution_status'] == 'SUCCESS' for r in receipts.values()))
        self.assertTrue(all(r['output']['metric_ppm'] == 1_000_000 for r in receipts.values()))
        self.assertEqual(len({r['algorithm'] for r in receipts.values()}), 100)

    def test_deterministic_byte_for_byte(self):
        payload = rich_payload()
        first = canonical_json(run_foundation_100(payload, {}))
        second = canonical_json(run_foundation_100(copy.deepcopy(payload), {}))
        self.assertEqual(first, second)

    def test_missing_evidence_is_insufficient(self):
        receipt = run_module('M601', {'intent_semantic_records': [row_for('M602')]}, {})
        self.assertEqual(receipt['execution_status'], 'INSUFFICIENT_DATA')
        self.assertEqual(receipt['finding_status'], 'NOT_APPLICABLE')

    def test_float_is_rejected_fail_closed(self):
        payload = rich_payload()
        payload['intent_semantic_records'][0]['entity_hits'] = 1.0
        receipt = run_module('M601', payload, {})
        self.assertEqual(receipt['execution_status'], 'ERROR')
        self.assertEqual(receipt['reason_code'], 'floats_not_allowed')

    def test_conflicting_duplicate_is_rejected(self):
        payload = rich_payload()
        duplicate = row_for('M601')
        duplicate['entity_hits'] = 9
        payload['intent_semantic_records'].append(duplicate)
        receipt = run_module('M601', payload, {})
        self.assertEqual(receipt['execution_status'], 'ERROR')
        self.assertIn('conflicting_duplicate', receipt['reason_code'])

    def test_config_is_hash_bound(self):
        payload = rich_payload()
        default = run_module('M601', payload, {})
        changed = run_module('M601', payload, {'m601_threshold_ppm': 800_000})
        self.assertNotEqual(default['module_config_hash'], changed['module_config_hash'])
        self.assertNotEqual(default['evidence_hash'], changed['evidence_hash'])

    def test_edge_is_symmetric_not_bot_content_switching(self):
        op = FOUNDATION_SPECS['M673']['operation']
        self.assertEqual(op, 'error_page_symmetry')
        receipt = run_module('M673', rich_payload(), {})
        self.assertEqual(receipt['output']['metric_ppm'], 1_000_000)
        self.assertEqual(receipt['execution_status'], 'SUCCESS')

    def test_relational_ppm_inputs_are_bounded(self):
        payload = rich_payload()
        for row in payload['relational_foundation_records']:
            if row['module_id'] == 'M694':
                row['observed_density_ppm'] = 1_000_001
        receipt = run_module('M694', payload, {})
        self.assertEqual(receipt['execution_status'], 'ERROR')
        self.assertIn('above_one_million', receipt['reason_code'])


if __name__ == '__main__':
    unittest.main()
