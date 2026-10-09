#!/usr/bin/env python3
"""Whole-window coverage and provider independence on actual RPC transcripts."""
import copy
import gzip
import json
from pathlib import Path
import tempfile
import unittest

from rmc015_full_window_incidence import collect, reconcile, requests
from rmc016_winner_net_audit import digest

ROOT = Path(__file__).parent


class FullWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        packed = (ROOT / 'recovered-rmc016/full-7200-window-20261009.json.gz').read_bytes()
        manifest = json.loads((ROOT / 'recovered-rmc016/full-window-acquisition.json').read_bytes())
        assert digest(packed) == manifest['compressed_sha256']
        raw = gzip.decompress(packed)
        assert digest(raw) == manifest['raw_sha256']
        cls.original = json.loads(raw)

    def rejected(self, mutation, reason):
        documents = copy.deepcopy(self.original)
        mutation(documents)
        with self.assertRaisesRegex(ValueError, reason): reconcile(documents)

    def test_whole_range_counts_are_not_opportunity_or_profit_claims(self):
        report = reconcile(self.original)
        self.assertEqual(report['covered_block_count'], 7200)
        self.assertEqual(report['last_block'] - report['first_block'] + 1, 7200)
        self.assertEqual(report['independent_operator_count'], 2)
        self.assertEqual(report['executed_event_count'], 2)
        self.assertFalse(report['real_market_census_closed'])
        self.assertFalse(report['unexecuted_opportunity_absence_proven'])
        self.assertFalse(report['prior_14_shard_artifacts_promoted'])

    def test_different_chunk_sizes_cover_every_block_exactly_once(self):
        for width in (50, 480):
            ranges = [p[0] for m,p in requests(width)[4:-2]]
            blocks = [n for p in ranges for n in range(int(p['fromBlock'],16), int(p['toBlock'],16)+1)]
            self.assertEqual(blocks, list(range(26095352, 26102552)))

    def test_pseudodiversity_rejected(self):
        self.rejected(lambda ds: ds.__setitem__(1, copy.deepcopy(ds[0])), 'independent operators')

    def test_endpoint_relabel_rejected(self):
        self.rejected(lambda ds: ds[0].update(url=ds[1]['url']), 'endpoint mismatch')

    def test_missing_shard_rejected(self):
        self.rejected(lambda ds: ds[0]['exchanges'].pop(4), 'incomplete coverage')

    def test_repeated_or_shifted_range_rejected(self):
        self.rejected(lambda ds: ds[0]['exchanges'][5].update(params=ds[0]['exchanges'][4]['params']),
                      'coverage request gap')

    def test_rpc_error_cannot_be_zero_market(self):
        self.rejected(lambda ds: ds[0]['exchanges'][4].update(result=None), 'cannot become zero')

    def test_positive_control_omission_rejected(self):
        self.rejected(lambda ds: ds[0]['exchanges'][3].update(result=[]), 'positive control')

    def test_wrong_chain_rejected(self):
        self.rejected(lambda ds: ds[0]['exchanges'][0].update(result='0xa'), 'wrong chain')

    def test_reorg_during_scan_rejected(self):
        self.rejected(lambda ds: ds[0]['exchanges'][-1]['result'].update(hash='0x'+'f'*64),
                      'anchor changed')

    def test_independent_anchor_conflict_rejected(self):
        def mutate(ds):
            for index in (2, -1): ds[1]['exchanges'][index]['result']['hash']='0x'+'e'*64
        self.rejected(mutate, 'independent anchor mismatch')

    def test_one_provider_omitting_real_events_rejected(self):
        def mutate(ds):
            for entry in ds[1]['exchanges'][4:-2]: entry['result'] = []
        self.rejected(mutate, 'executed-event mismatch')

    def test_reselected_or_invented_cohort_rejected(self):
        with self.assertRaisesRegex(ValueError, 'watchlist commitment'):
            reconcile(self.original, b'{"account":"0x0000000000000000000000000000000000000000"}\n')

    def test_transport_failure_writes_explicit_blocker(self):
        def unavailable(*_): raise OSError('HTTP 429')
        with tempfile.TemporaryDirectory() as temp:
            report = collect(Path(temp)/'attempt', call=unavailable, pause=lambda _: None)
            self.assertEqual(report['status'], 'SOURCE_ACQUISITION_OR_RECONCILIATION_BLOCKED')
            self.assertNotIn('executed_event_count', report)
            self.assertFalse(report['real_market_census_closed'])


if __name__ == '__main__': unittest.main()
