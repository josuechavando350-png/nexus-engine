#!/usr/bin/env python3
"""Adversarial source recovery and gas allocation boundaries, real original rows."""
import copy
import unittest
from pathlib import Path

from rmc016_recovered_winner_ledger import inspect_original_rows
from rmc016_winner_net_audit import canonical, digest, parse_json
from rmc_operator_gas_budget import gas_budget_stress, read_scenario

ROOT = Path(__file__).parent
LEDGER = ROOT / 'recovered-rmc016/rmc016-observed-transaction-economics.jsonl'
SOURCE = ROOT / 'rmc016-production-evidence.json'
SCENARIO = ROOT / 'operator-gas-scenario.json'


class RecoveredLedgerTests(unittest.TestCase):
    def setUp(self):
        self.raw = LEDGER.read_bytes()
        self.authority = parse_json(SOURCE.read_bytes())['authority']
        self.rows = [parse_json(line) for line in self.raw.splitlines()]

    def modified(self, change, error):
        rows = copy.deepcopy(self.rows)
        change(rows)
        raw = b''.join(canonical(row) for row in rows)
        # Hypothetical re-pinning tests semantic checks, never production source.
        authority = copy.deepcopy(self.authority)
        authority['transaction_economics_sha256'] = digest(raw)
        with self.assertRaisesRegex(ValueError, error):
            inspect_original_rows(raw, authority)

    def test_original_127_rows_and_139_events_conserve_exact_aggregates(self):
        report = inspect_original_rows(self.raw, self.authority)
        self.assertEqual(report['transaction_count'], 127)
        self.assertEqual(report['event_count'], 139)
        self.assertEqual(report['positive_partial_residual_transaction_count'], 83)
        self.assertEqual(report['nonpositive_partial_residual_transaction_count'], 44)
        self.assertEqual(report['partial_residual_after_winner_gas_usd_wad'],
                         '136901040429717286157971')
        self.assertIsNone(report['nqc_net_pnl_usd_wad'])
        self.assertFalse(report['all_execution_costs_reconciled'])

    def test_changed_original_bytes_rejected(self):
        with self.assertRaisesRegex(ValueError, 'SHA256 mismatch'):
            inspect_original_rows(self.raw + b'\n', self.authority)

    def test_incomplete_rows_rejected(self):
        self.modified(lambda rows: rows.pop(), 'transaction count')

    def test_duplicate_transaction_rejected(self):
        self.modified(lambda rows: rows[1].update(transaction_hash=rows[0]['transaction_hash']),
                      'duplicate transaction')

    def test_duplicate_execution_position_rejected(self):
        def duplicate(rows):
            rows[1].update(block_number=rows[0]['block_number'],
                           transaction_index=rows[0]['transaction_index'])
        self.modified(duplicate, 'transaction position')

    def test_missing_costs_must_not_disappear(self):
        self.modified(lambda rows: rows[0].update(omitted_costs=[]), 'omitted costs')

    def test_net_claim_rejected(self):
        self.modified(lambda rows: rows[0].update(nqc_net_pnl_claimed=True), 'NQC profit')

    def test_gas_receipt_arithmetic_rejected(self):
        self.modified(lambda rows: rows[0].update(gas_used=rows[0]['gas_used']+1), 'gas arithmetic')

    def test_boolean_gas_is_not_integer(self):
        self.modified(lambda rows: rows[0].update(gas_used=True), 'invalid integer')

    def test_residual_cannot_inflate(self):
        self.modified(lambda rows: rows[0].update(
            gross_oracle_edge_minus_observed_winner_gas_usd_wad='500'), 'residual arithmetic')

    def test_outside_window_rejected(self):
        self.modified(lambda rows: rows[0].update(block_number=1), 'pinned window')

    def test_aggregate_mutation_rejected(self):
        for key, error in [('definite_episode_count', 'event count'),
                           ('observed_market_debt_principal_usd_wad', 'principal sum'),
                           ('observed_market_gross_oracle_edge_usd_wad', 'gross sum'),
                           ('observed_winner_gas_cost_usd_wad', 'gas sum')]:
            authority = copy.deepcopy(self.authority)
            authority[key] = int(authority[key]) + 1
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, error):
                inspect_original_rows(self.raw, authority)

    def test_duplicate_json_key_rejected(self):
        raw = self.raw.replace(b'"gas_used":', b'"gas_used":1,"gas_used":', 1)
        authority = copy.deepcopy(self.authority)
        authority['transaction_economics_sha256'] = digest(raw)
        with self.assertRaisesRegex(ValueError, 'duplicate JSON key'):
            inspect_original_rows(raw, authority)


class GasScenarioTests(unittest.TestCase):
    def setUp(self):
        self.scenario = read_scenario(SCENARIO.read_bytes())

    def test_budget_does_not_claim_zero_own_capital_or_external_sponsor(self):
        self.assertFalse(self.scenario['external_gas_sponsor_required_for_this_scenario'])
        self.assertTrue(self.scenario['operator_gas_loss_borne_by_operator'])
        self.assertFalse(self.scenario['live_execution_authorized'])

    def test_no_spending_or_balance_authority_from_declaration(self):
        for key in ('live_execution_authorized', 'gas_asset_and_balance_verified',
                    'historical_zero_own_capital_certificates_reclassified'):
            scenario = dict(self.scenario, **{key: True})
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'unsupported scenario'):
                read_scenario(canonical(scenario))

    def test_gas_cannot_be_reallocated_to_principal_or_collateral(self):
        for key in ('operator_principal_budget_mxn_wad', 'operator_collateral_budget_mxn_wad'):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, 'cannot fund'):
                read_scenario(canonical(dict(self.scenario, **{key: '1'})))

    def test_budget_cannot_increase_or_use_float(self):
        for bad in ('2000000000000000000001', 2000.0, True, '-1'):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                read_scenario(canonical(dict(self.scenario, operator_gas_budget_mxn_wad=bad)))

    def test_full_sample_exceeds_mxn_budget_even_without_failed_attempts(self):
        gas = 1144134260592713842029
        result = gas_budget_stress(self.scenario, gas)
        self.assertEqual(len(result['cases']), 9)
        self.assertTrue(all(not c['within_declared_mxn_budget_at_reference_fx'] for c in result['cases']))
        self.assertEqual(result['declared_currency'], 'MXN')
        self.assertEqual(int(result['reference_equivalent_budget_usd_wad']),
                         2000 * 10**36 // 18416300000000000000)
        self.assertEqual(int(result['cases'][1]['modeled_gas_spend_usd_wad']), gas * 2)
        self.assertFalse(result['native_asset_prefunding_sufficient_proven'])

    def test_dollars_cannot_silently_replace_user_pesos(self):
        for mutation in ({'declared_currency': 'USD'},
                         {'operator_gas_budget_usd_wad': '2000000000000000000000'}):
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'Mexican pesos'):
                read_scenario(canonical(dict(self.scenario, **mutation)))

    def test_fx_inversion_or_unverified_conversion_rejected(self):
        for mutation in ({'mxn_per_usd_wad': '542996310494'},
                         {'mxn_per_usd_wad': 18.4163},
                         {'native_gas_purchase_quote_verified': True}):
            scenario = copy.deepcopy(self.scenario)
            scenario['fx_reference'].update(mutation)
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, 'FX reference'):
                read_scenario(canonical(scenario))

    def test_peso_cost_rounds_up_while_dollar_equivalent_rounds_down(self):
        case = gas_budget_stress(self.scenario, 1)['cases'][0]
        self.assertEqual(case['modeled_gas_spend_at_reference_fx_mxn_wad'], '19')

    def test_zero_negative_float_and_bool_observed_cost_rejected(self):
        for value in (0, -1, True, 1.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                gas_budget_stress(self.scenario, value)


if __name__ == '__main__':
    unittest.main()
