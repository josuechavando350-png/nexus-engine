import unittest
import postwindow_intrablock_attribution as a


def fixture():
    hf = 999000000000000000
    abi = '0x' + ''.join(f'{x:064x}' for x in (120, 100, 0, 8300, 8050, hf))
    return '\n'.join([
        '[PASS] testTimePrefixAndHistoricalWinner() (gas: 123)',
        '  NQC_PARENT_HF: 1001000000000000000',
        '  NQC_TIME_ONLY_HF: 1000999990000000000',
        '  NQC_REFERENCE_PRESTATE_ABI: ' + abi,
        '  NQC_REFERENCE_PRESTATE_HF: ' + str(hf),
        '  NQC_PREFIX_INDEX: 0', '  NQC_PREFIX_HF: ' + str(hf),
        '  NQC_FIRST_PREFIX_CROSSING_INDEX: 0',
        '  NQC_PREFIX_ACCOUNT_PARITY: 1', '  NQC_WINNER_EVENT_PARITY: 1',
        '  NQC_POST_WINNER_HF: 1100000000000000000',
        'Suite result: ok. 1 passed; 0 failed; 0 skipped;',
    ])


class AttributionTests(unittest.TestCase):
    def reject(self, value, count=1):
        with self.assertRaises(a.pre.receipts.Rejected):
            a.parse_metrics(value, count)

    def test_valid_exact_replay(self):
        self.assertEqual(a.parse_metrics(fixture(), 1)['NQC_WINNER_EVENT_PARITY'], 1)

    def test_failed_run(self):
        self.reject(fixture().replace('1 passed; 0 failed', '0 passed; 1 failed'))

    def test_wrong_test(self):
        self.reject(fixture().replace('[PASS]', '[FAIL]'))

    def test_missing_event_parity(self):
        self.reject(fixture().replace('NQC_WINNER_EVENT_PARITY: 1', 'NQC_WINNER_EVENT_PARITY: 0'))

    def test_duplicate_metric(self):
        self.reject(fixture() + '\n  NQC_WINNER_EVENT_PARITY: 1\n')

    def test_missing_prefix(self):
        self.reject(fixture(), 2)

    def test_wrong_prefix_order(self):
        self.reject(fixture().replace('NQC_PREFIX_INDEX: 0', 'NQC_PREFIX_INDEX: 1'))

    def test_inconsistent_crossing(self):
        self.reject(fixture().replace('NQC_FIRST_PREFIX_CROSSING_INDEX: 0',
                                      'NQC_FIRST_PREFIX_CROSSING_INDEX: 1'))

    def test_inconsistent_prestate(self):
        self.reject(fixture().replace('NQC_REFERENCE_PRESTATE_HF: 999000000000000000',
                                      'NQC_REFERENCE_PRESTATE_HF: 999000000000000001'))

    def test_duplicate_abi(self):
        line = next(x for x in fixture().splitlines() if 'PRESTATE_ABI' in x)
        self.reject(fixture() + '\n' + line)

    def test_mutated_archive(self):
        with self.assertRaises(a.pre.receipts.Rejected):
            a.authenticate(b'not the authenticated source')


if __name__ == '__main__':
    unittest.main()
