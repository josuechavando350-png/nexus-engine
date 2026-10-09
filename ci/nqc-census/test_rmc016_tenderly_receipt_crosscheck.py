#!/usr/bin/env python3
"""Mutations against actual source-locked receipts and recorded Tenderly replies."""
import copy
import gzip
import os
from pathlib import Path
import unittest

from rmc016_tenderly_receipt_crosscheck import legacy_or_type2_receipt, reconcile
from rmc016_winner_net_audit import digest, parse_json

ROOT = Path(__file__).parent


class TenderlyCrosscheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.events = Path(os.environ['RMC016_EVENT_ARCHIVE'])
        cls.drpc = Path(os.environ['RMC016_DRPC_ARCHIVE'])
        packed = (ROOT / 'recovered-rmc016/tenderly-receipts-20261009.jsonl.gz').read_bytes()
        manifest = parse_json((ROOT / 'recovered-rmc016/tenderly-acquisition.json').read_bytes())
        assert digest(packed) == manifest['compressed_sha256']
        raw = gzip.decompress(packed)
        assert digest(raw) == manifest['raw_sha256']
        cls.original = [parse_json(line) for line in raw.splitlines()]

    def rejected(self, mutation, message):
        exchanges = copy.deepcopy(self.original)
        mutation(exchanges)
        with self.assertRaisesRegex(ValueError, message):
            reconcile(self.events, self.drpc, exchanges)

    def test_real_full_corpus_matches_original_drpc(self):
        report = reconcile(self.events, self.drpc, self.original)
        self.assertEqual(report['receipt_count'], 127)
        self.assertEqual(report['liquidation_event_count'], 139)
        self.assertEqual(report['gas_paid_wei'], '448369976498898050')
        self.assertEqual(report['provider_mismatch_count'], 0)
        self.assertFalse(report['oracle_usd_prices_independently_verified'])
        self.assertFalse(report['real_market_census_closed'])
        self.assertEqual(report['drpc_original_workflow_overall_status'],
                         'FAILURE_PARTIAL_CHECKPOINT_ONLY')

    def test_reconciliation_is_deterministic_and_does_not_mutate_raw(self):
        before = copy.deepcopy(self.original)
        self.assertEqual(reconcile(self.events, self.drpc, self.original),
                         reconcile(self.events, self.drpc, self.original))
        self.assertEqual(before, self.original)

    def test_missing_receipt_fails(self):
        self.rejected(lambda xs: xs.pop(3), '127 receipts required')

    def test_wrong_chain_fails(self):
        self.rejected(lambda xs: xs[0].update(result='0xa'), 'wrong chain')

    def test_wrong_anchor_fails(self):
        self.rejected(lambda xs: xs[1]['result'].update(hash='0x'+'0'*64), 'hash mismatch')

    def test_mid_acquisition_state_root_change_fails(self):
        self.rejected(lambda xs: xs[-1]['result'].update(stateRoot='0x'+'1'*64), 'anchor changed')

    def test_receipt_gas_mismatch_fails(self):
        self.rejected(lambda xs: xs[3]['result'].update(gasUsed='0x1'), 'receipt mismatch')

    def test_failed_transaction_cannot_be_winner(self):
        self.rejected(lambda xs: xs[3]['result'].update(status='0x0'), 'winner reverted')

    def test_log_omission_fails(self):
        self.rejected(lambda xs: xs[3]['result'].update(logs=[]), 'receipt logs')

    def test_substituted_request_fails(self):
        self.rejected(lambda xs: xs[3].update(params=xs[4]['params']), 'substituted RPC request')

    def test_nonzero_blob_gas_never_disappears(self):
        self.rejected(lambda xs: xs[3]['result'].update(blobGasUsed='0x1'), 'inconsistent blob')

    def test_unknown_or_blob_type_is_not_implicitly_zero(self):
        for kind in (None, '0x3', '0x4'):
            with self.subTest(kind=kind):
                self.rejected(lambda xs: xs[3]['result'].update(type=kind), 'explicit legacy/type-2')

    def test_explicit_zero_adapter_preserves_input(self):
        original = {'type': '0x2', 'blobGasUsed': '0x0', 'gasUsed': '0x100'}
        result = legacy_or_type2_receipt(original)
        self.assertEqual(original['blobGasUsed'], '0x0')
        self.assertNotIn('blobGasUsed', result)
        self.assertEqual(result['gasUsed'], '0x100')


if __name__ == '__main__':
    unittest.main()
