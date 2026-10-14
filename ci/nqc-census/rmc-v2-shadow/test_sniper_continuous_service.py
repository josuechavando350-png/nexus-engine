import contextlib
import copy
import io
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import sniper_continuous_service as s
import sniper_readonly_journal as j

NOW = 1791939600
COMMIT = 'a'*40


def sample(epoch=NOW):
    return {'schema_version': 1, 'contract': 'NQC_V2_READ_ONLY_SNIPER_PROSPECTIVE_SNAPSHOT',
            'status': s.GOOD, 'p2_shadow_certified': False, 'rmc_closed': False,
            'commercial_score_upgrade': False, 'nqc_realized_pnl_usd': '0',
            'observed_epoch_seconds': epoch, 'provider_count': 3,
            'accounts_consistent_across_successful_endpoints': True,
            'successful_provider_ids': ['drpc', 'publicnode', 'blast'],
            'pinned_block': {'number': 26187000, 'timestamp': epoch-36},
            'hf_below_one_state_count_not_execution_admission': 0}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def cycle(self, epoch=NOW, report=None):
        with contextlib.redirect_stdout(io.StringIO()):
            return s.cycle(self.root, COMMIT, ('drpc', 'publicnode', 'blast'), now=epoch,
                           free_bytes=s.MIN_FREE_BYTES, observer=lambda _: sample(epoch) if report is None else report)

    def test_healthy_fresh_sample_not_uptime_claim(self):
        self.cycle()
        d = s.health_check(self.root, now=NOW)
        self.assertFalse(d['server_24_7_uptime_certified'])

    def test_restart_appends_without_overwrite(self):
        first = self.cycle()
        old = (self.root/first['journal_day_utc']/first['snapshot_file']).read_bytes()
        second = self.cycle(NOW+60)
        self.assertEqual(second['sequence'], 1)
        self.assertEqual((self.root/first['journal_day_utc']/first['snapshot_file']).read_bytes(), old)

    def test_daily_rotation_preserves_previous_chain(self):
        first = self.cycle()
        old = (self.root/first['journal_day_utc']/'journal.jsonl').read_bytes()
        second = self.cycle(NOW+86400)
        self.assertNotEqual(first['journal_day_utc'], second['journal_day_utc'])
        self.assertEqual(second['sequence'], 0)
        self.assertEqual((self.root/first['journal_day_utc']/'journal.jsonl').read_bytes(), old)

    def test_second_writer_refused(self):
        with s.writer_lock(self.root):
            with self.assertRaisesRegex(j.JournalError, 'another observer'):
                with s.writer_lock(self.root):
                    self.fail('acquired duplicate lock')

    def test_lock_released_after_failure(self):
        with self.assertRaises(RuntimeError):
            with s.writer_lock(self.root):
                raise RuntimeError()
        with s.writer_lock(self.root):
            pass

    def test_disk_pressure_preserves_data(self):
        self.cycle()
        old = (self.root/'health.json').read_bytes()
        with self.assertRaisesRegex(j.JournalError, 'GiB'):
            s.cycle(self.root, COMMIT, (), free_bytes=0, observer=lambda _: self.fail('network called'))
        self.assertEqual((self.root/'health.json').read_bytes(), old)

    def test_stale_sample_rejected(self):
        self.cycle()
        with self.assertRaisesRegex(j.JournalError, 'stale'):
            s.health_check(self.root, now=NOW+241)

    def test_future_sample_rejected(self):
        self.cycle()
        with self.assertRaisesRegex(j.JournalError, 'future'):
            s.health_check(self.root, now=NOW-1)

    def test_alive_single_source_is_not_healthy(self):
        d = sample(); d['status'] = 'SINGLE_ENDPOINT_RESEARCH_ONLY_NOT_P2'; d['provider_count'] = 1
        self.cycle(report=d)
        with self.assertRaisesRegex(j.JournalError, 'two-endpoint'):
            s.health_check(self.root, now=NOW)

    def test_corrupt_snapshot_prevents_restart(self):
        first = self.cycle()
        (self.root/first['journal_day_utc']/first['snapshot_file']).write_text('{}')
        with self.assertRaisesRegex(j.JournalError, 'content mismatch'):
            self.cycle(NOW+60)

    def test_deadline_escapes_provider_exception_handler(self):
        def hung(_):
            try:
                time.sleep(1)
            except Exception:
                self.fail('deadline swallowed by provider')
        with patch.object(s, 'SAMPLE_TIMEOUT', .01), patch.object(s.obs, 'observe', hung):
            with self.assertRaises(TimeoutError):
                s.bounded_observe(('drpc',))

    def test_exception_is_recorded_as_unverified(self):
        def failed(_):
            raise TimeoutError('deadline')
        with contextlib.redirect_stdout(io.StringIO()):
            state = s.cycle(self.root, COMMIT, (), now=NOW, free_bytes=s.MIN_FREE_BYTES, observer=failed)
        self.assertEqual(state['sample_status'], 'UNVERIFIED_NO_OBSERVATION')


if __name__ == '__main__':
    unittest.main()
