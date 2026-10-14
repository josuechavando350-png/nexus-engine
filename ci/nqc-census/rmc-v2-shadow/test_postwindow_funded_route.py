import copy
import unittest
from unittest.mock import patch

import postwindow_funded_route as route


class FundedRouteEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.case = {'event': {'debt_raw': '1000000', 'collateral_raw': '1000000000000000'}}
        self.metrics = {'NQC_PRINCIPAL': 1000000, 'NQC_FLASH_FEE': 500,
            'NQC_SOLD_WETH': 1000000000000000, 'NQC_SWAP_OUTPUT': 1010500,
            'NQC_SURPLUS': 10000, 'NQC_EXECUTE_CALL_GAS': 700000,
            'NQC_BASE_FEE_WEI': 1000000000, 'NQC_PRODUCTION_GAS_SPONSORED': 0,
            'NQC_PROFIT_FLOOR_ROLLBACK': 1}

    def output(self, changes=None):
        m = dict(self.metrics, **(changes or {}))
        return ('[PASS] testHistoricalAtomicRouteSurplus()\n'
                '[PASS] testImpossibleProfitRollsBackEntireRoute()\n'
                'Suite result: ok. 2 passed; 0 failed; 0 skipped\n' +
                ''.join(f'  {k}: {v}\n' for k, v in m.items()) +
                '  NQC_SWAP_POOL: 0x' + '12'*20 + '\n' +
                '  NQC_ROUTER_CODEHASH: 0x' + '34'*32 + '\n' +
                '  NQC_SWAP_POOL_CODEHASH: 0x' + '56'*32 + '\n')

    def test_complete_identity_is_accepted(self):
        self.assertEqual(route.parse_metrics(self.output(), self.case)['NQC_SURPLUS'], 10000)

    def test_invalid_economic_identity_is_rejected(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output({'NQC_SURPLUS': 10001}), self.case)

    def test_incorrect_fee_is_rejected_even_with_balanced_equation(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output({'NQC_FLASH_FEE': 501, 'NQC_SURPLUS': 9999}), self.case)

    def test_zero_surplus_is_not_profit(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output({'NQC_SWAP_OUTPUT': 1000500, 'NQC_SURPLUS': 0}), self.case)

    def test_actual_usdt_ceil_fee_accepts_one_unit_above_half_up(self):
        self.case['event']['debt_raw'] = '3324204460'
        changes = {'NQC_PRINCIPAL': 3324204460, 'NQC_FLASH_FEE': 1662103,
                   'NQC_SWAP_OUTPUT': 3325876563, 'NQC_SURPLUS': 10000}
        self.assertEqual(route.parse_metrics(self.output(changes), self.case)['NQC_FLASH_FEE'], 1662103)

    def test_actual_usdt_half_up_fee_rejected_even_with_balanced_equation(self):
        self.case['event']['debt_raw'] = '3324204460'
        changes = {'NQC_PRINCIPAL': 3324204460, 'NQC_FLASH_FEE': 1662102,
                   'NQC_SWAP_OUTPUT': 3325876562, 'NQC_SURPLUS': 10000}
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output(changes), self.case)

    def test_historical_size_mutation_is_rejected(self):
        case = copy.deepcopy(self.case)
        case['event']['collateral_raw'] = '1'
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output(), case)

    def test_duplicate_metric_is_rejected(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output() + '  NQC_SURPLUS: 10000\n', self.case)

    def test_missing_rollback_is_rejected(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output({'NQC_PROFIT_FLOOR_ROLLBACK': 0}), self.case)

    def test_false_sponsorship_promotion_is_rejected(self):
        with self.assertRaises(ValueError):
            route.parse_metrics(self.output({'NQC_PRODUCTION_GAS_SPONSORED': 1}), self.case)

    def test_wrong_or_failed_test_cannot_pass(self):
        for output in (self.output().replace('2 passed; 0 failed', '1 passed; 1 failed'),
                       self.output().replace('testHistoricalAtomicRouteSurplus', 'testUnrelated')):
            with self.assertRaises(ValueError):
                route.parse_metrics(output, self.case)

    def test_missing_or_duplicate_route_identity_is_rejected(self):
        for output in (self.output().replace('NQC_ROUTER_CODEHASH', 'UNKNOWN_HASH'),
                       self.output() + '  NQC_SWAP_POOL: 0x' + '12'*20 + '\n'):
            with self.assertRaises(ValueError):
                route.parse_metrics(output, self.case)

    def test_corrupt_parent_archive_is_rejected(self):
        with self.assertRaises(ValueError):
            route.authenticate(b'not the authenticated parent', b'not attribution')

    def test_corrupt_attribution_is_rejected(self):
        with patch.object(route.attribution, 'authenticate', return_value=[]):
            with self.assertRaises(ValueError):
                route.authenticate(b'parent fixture', b'not authenticated attribution')


if __name__ == '__main__':
    unittest.main()
