import copy
import unittest

import postwindow_economic_envelope as e


def producer():
    cases = []
    for label, pinned in e.EXPECTED_CASES.items():
        principal = 48_993_353_728 if 'USDC' in label else 3_324_204_460
        fee = (principal * 5 + 9999) // 10000
        m = {'NQC_SURPLUS': pinned['surplus'], 'NQC_EXECUTE_CALL_GAS': pinned['call_gas'],
             'NQC_BASE_FEE_WEI': 2_000_000_000, 'NQC_PRINCIPAL': principal,
             'NQC_FLASH_FEE': fee, 'NQC_SWAP_OUTPUT': principal + fee + pinned['surplus'],
             'NQC_PRODUCTION_GAS_SPONSORED': 0, 'NQC_PROFIT_FLOOR_ROLLBACK': 1}
        cases.append({'label': label, 'provider_metrics': {'drpc': m, 'blast': copy.deepcopy(m)},
                      'two_endpoint_parity': True})
    return {'status': 'TWO_ENDPOINT_HISTORICAL_ROUTE_SURPLUS_BEFORE_NATIVE_COSTS',
            'source_zip_sha256': e.EXPECTED_PARENT_ARTIFACT,
            'attribution_zip_sha256': e.EXPECTED_ATTRIBUTION_ARTIFACT,
            'attribution_producer_full_ci_passed': False,
            'historical_selection_uses_future_winner': True,
            'native_gas_payment_modeled': False, 'gas_metric_is_receipt_gas_used': False,
            'nqc_net_margin_proven': False, 'prospective_detection_proven': False,
            'external_nonrecourse_gas_funding_proven': False,
            'P2_shadow_certified': False, 'RMC_closed': False,
            'commercial_score_upgrade': False, 'canary_live_authorized': False,
            'nqc_realized_pnl_usd': '0', 'errors': [], 'cases': cases}


class EconomicEnvelopeTests(unittest.TestCase):
    def setUp(self):
        self.p = producer()

    def reject(self, p):
        with self.assertRaises(e.Rejected):
            e.authenticated_cases(p)

    def test_exact_producer_structure(self):
        cs = e.authenticated_cases(self.p)
        self.assertEqual(len(cs), 2)
        self.assertEqual(cs[0]['surplus_asset_micros'], 2_273_989_378)

    def test_partial_attribution_cannot_be_promoted(self):
        p = copy.deepcopy(self.p)
        p['attribution_producer_full_ci_passed'] = True
        self.reject(p)

    def test_unproven_gas_cannot_become_receipt_gas(self):
        p = copy.deepcopy(self.p)
        p['gas_metric_is_receipt_gas_used'] = True
        self.reject(p)

    def test_invented_sponsor_rejected(self):
        p = copy.deepcopy(self.p)
        p['cases'][0]['provider_metrics']['drpc']['NQC_PRODUCTION_GAS_SPONSORED'] = 1
        p['cases'][0]['provider_metrics']['blast']['NQC_PRODUCTION_GAS_SPONSORED'] = 1
        self.reject(p)

    def test_one_provider_missing_or_changed(self):
        p = copy.deepcopy(self.p)
        del p['cases'][0]['provider_metrics']['blast']
        self.reject(p)
        p = copy.deepcopy(self.p)
        p['cases'][0]['provider_metrics']['blast']['NQC_SURPLUS'] += 1
        self.reject(p)

    def test_mutated_producer_profit_and_fee_rejected(self):
        p = copy.deepcopy(self.p)
        for provider in ('drpc', 'blast'):
            p['cases'][0]['provider_metrics'][provider]['NQC_FLASH_FEE'] -= 1
        self.reject(p)
        p = copy.deepcopy(self.p)
        for provider in ('drpc', 'blast'):
            p['cases'][0]['provider_metrics'][provider]['NQC_SURPLUS'] += 1
            p['cases'][0]['provider_metrics'][provider]['NQC_SWAP_OUTPUT'] += 1
        self.reject(p)

    def test_duplicate_label_rejected(self):
        p = copy.deepcopy(self.p)
        p['cases'][1] = p['cases'][0]
        self.reject(p)

    def test_missing_or_incorrect_no_claim(self):
        for field in ('RMC_closed', 'nqc_net_margin_proven', 'prospective_detection_proven'):
            p = copy.deepcopy(self.p)
            p[field] = True
            self.reject(p)

    def test_negative_sensitivity_is_possible(self):
        s = e.scenario(150_882_941, 2_500_000, 30 * e.GWEI, 400_000,
                       100_000_000, 100_000_000, 100_000_000)
        self.assertLess(s['residual_asset_micros_hypothetical_not_net_pnl'], 0)

    def test_monotone_costs_and_integer_rounding(self):
        x = e.scenario(100_000_000, 1_500_000, 3 * e.GWEI, 300_000, 0, 0, 0)
        y = e.scenario(100_000_000, 1_500_000, 4 * e.GWEI, 300_000, 0, 0, 0)
        self.assertLess(y['residual_asset_micros_hypothetical_not_net_pnl'],
                        x['residual_asset_micros_hypothetical_not_net_pnl'])
        self.assertEqual(e.ceildiv(10, 3), 4)
        self.assertEqual(e.ceildiv(9, 3), 3)

    def test_break_even_fee_monotone_in_gas(self):
        a = e.scenario(200_000_000, 1_250_000, e.GWEI, 200_000, 0, 0, 0)
        b = e.scenario(200_000_000, 2_500_000, e.GWEI, 200_000, 0, 0, 0)
        self.assertEqual(a['break_even_effective_gas_price_wei_assumed'],
                         b['break_even_effective_gas_price_wei_assumed'] * 2)

    def test_output_remains_non_certified_even_when_sensitivity_positive(self):
        x = e.build(self.p, {'zip_sha256': 'test'})
        self.assertEqual(len(x['cases']), 2)
        self.assertTrue(x['cases'][0]['positive_sensitivity_scenarios'] > 0)
        self.assertFalse(x['capital_constraint_own_capital_zero_fulfilled'])
        self.assertFalse(x['nqc_net_pnl_certified'])
        self.assertFalse(x['prospective_detection_and_inclusion_authenticated'])
        self.assertEqual(x['nqc_realized_pnl_usd'], '0')
        self.assertEqual(x['cases'][0]['scenarios_count'], 216)

    def test_duplicate_json_keys_rejected(self):
        with self.assertRaises(e.Rejected):
            e.strict_json(b'{"status": "PASS", "status": "FAIL"}')

    def test_nonfinite_json_rejected(self):
        with self.assertRaises(e.Rejected):
            e.strict_json(b'{"x": NaN}')

    def test_zip_source_wrong_digest_fail_closed(self):
        with self.assertRaises(e.Rejected):
            e.authenticate_archive(b'fake artifact')

    def test_traversal_path_rejected(self):
        for path in ('../x', 'a/../b', '/root/a', './x', 'a\\b'):
            with self.assertRaises(e.Rejected):
                e.safe_name(path)

    def test_scenario_no_float_and_negative_inputs(self):
        with self.assertRaises(e.Rejected):
            e.scenario(100, 1, 2, 100, -1, 0, 0)
        with self.assertRaises(e.Rejected):
            e.scenario(100, 1, 2, 100.0, 0, 0, 0)


if __name__ == '__main__':
    unittest.main()
