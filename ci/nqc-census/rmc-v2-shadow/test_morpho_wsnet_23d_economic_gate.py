"""Adversarial unit and source-integration tests; no internet or wallet."""
import copy
import os
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from morpho_wsnet_23d_economic_gate import (
    read_certified_zip, analyze, locate_day, oracle_haircut_profit_micro,
    MARKET, SOURCE_SHA256, SOURCE_EVENTS_SHA256, require,
)


class UnitTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.path = os.environ.get('NQC_PR741_CERTIFIED_SOURCE_ZIP')
        if not cls.path:
            cls.path = '/mnt/data/NQC_PR741_23D_source.zip'
        if not Path(cls.path).exists():
            raise RuntimeError('Source ZIP required for tests; no skip or substitute')
        cls.events,cls.days = read_certified_zip(cls.path)
        cls.audit = analyze(cls.events,cls.days)

    def target(self):
        return [x for x in self.events if x['chain_id']==4663 and x['market_id']==MARKET]

    def test_01_certified_outer_hash(self):
        import hashlib
        self.assertEqual(hashlib.sha256(Path(self.path).read_bytes()).hexdigest(), SOURCE_SHA256)

    def test_02_source_members_and_23day_gate(self):
        self.assertEqual(len(self.days),23)
        self.assertEqual(len(self.events),2565)

    def test_03_raw_event_integrity(self):
        self.assertEqual(len(self.target()),224)
        self.assertTrue(all(e['loan']=='USDG' and e['collateral']=='wsNET' for e in self.target()))

    def test_04_repaid_amount_not_profit(self):
        self.assertEqual(self.audit['source_total_repaid_nominal_usdg_not_profit'],'526735.979790')
        self.assertEqual(self.audit['nqc_realized_pnl_usd'],'0')

    def test_05_tx_dedup(self):
        self.assertEqual(self.audit['source_distinct_winning_txs'],164)
        self.assertGreater(self.audit['source_market_events'],self.audit['source_distinct_winning_txs'])

    def test_06_liquidators(self):
        self.assertEqual(self.audit['source_distinct_liquidator_addresses'],52)
        self.assertEqual(self.audit['source_top_three_principal_percent'],'61.4365')

    def test_07_scope_23_not_30(self):
        self.assertFalse(self.audit['source_30d_complete'])
        self.assertEqual(self.audit['observed_active_complete_24h_windows'],18)

    def test_08_peak_exact_window(self):
        self.assertEqual(self.audit['source_peak_24h_repay_usdg'],'96881.749700')
        self.assertEqual(self.audit['source_peak_24h_window_index'],12)

    def test_09_top_three_exclusion(self):
        s=self.audit['segments']['excluding_top_three_historical_addresses']
        self.assertEqual(s['source_loan_principal_usdg_not_profit'],'203127.857909')
        self.assertEqual(s['distinct_winner_txs'],93)

    def test_10_peak_exclusion(self):
        s=self.audit['segments']['excluding_peak_24h_source_window']
        self.assertEqual(s['source_loan_principal_usdg_not_profit'],'429854.230090')

    def test_11_joint_counterfactual_not_accessible(self):
        s=self.audit['segments']['excluding_both_peak_and_top_three']
        self.assertEqual(s['distinct_winner_txs'],84)
        self.assertEqual(s['active_complete_source_24h_windows'],15)
        self.assertEqual(s['source_loan_principal_usdg_not_profit'],'183167.261965')

    def test_12_five_pct_haircut_not_a_quote(self):
        s=self.audit['segments']['excluding_both_peak_and_top_three']['model']
        self.assertEqual(s[2]['dex_haircut_percent_assumed'],5)
        self.assertEqual(s[2]['nqc_50pct_oracle_model_share_usdg_before_costs'],'6449.551451')

    def test_13_eight_pct_not_five_thousand(self):
        s=self.audit['segments']['excluding_both_peak_and_top_three']['model']
        self.assertEqual(s[3]['nqc_50pct_oracle_model_share_usdg_before_costs'],'3353.766743')
        self.assertFalse(s[3]['exceeds_5000_nominal_not_monthly'])

    def test_14_threshold_correct_unit(self):
        s=self.audit['segments']['excluding_both_peak_and_top_three']['model']
        self.assertTrue(s[2]['exceeds_5000_nominal_not_monthly'])
        self.assertFalse(s[3]['exceeds_5000_nominal_not_monthly'])

    def test_15_negative_haircut_margin_floor_zero(self):
        self.assertEqual(oracle_haircut_profit_micro(self.target(),12),0)

    def test_16_no_realization_no_financing(self):
        self.assertFalse(self.audit['external_gas_sponsor_proven'])
        self.assertFalse(self.audit['same_block_executable_quote_proven'])
        self.assertFalse(self.audit['prospective_first_seen_proven'])

    def test_17_forbidden_future_timestamp_rejected(self):
        with self.assertRaisesRegex(ValueError,'FAIL_CLOSED_UNCERTIFIED_SOURCE_TIME'):
            locate_day(self.days, self.days[-1]['end']+1)

    def test_18_forged_duplicate_liquidator_tx_rejected(self):
        forged=copy.deepcopy(self.events)
        a=next(x for x in forged if x['chain_id']==4663 and x['market_id']==MARKET)
        duplicate=dict(a)
        duplicate['liquidator']='0x1111111111111111111111111111111111111111'
        duplicate['id'] = 'synthetic:event:not-source'
        forged.append(duplicate)
        with self.assertRaisesRegex(ValueError,'FAIL_CLOSED_TARGET_224_EVENTS'):
            analyze(forged,self.days)

    def test_19_forged_bad_debt_rejected(self):
        forged=copy.deepcopy(self.events)
        a=next(x for x in forged if x['chain_id']==4663 and x['market_id']==MARKET)
        a['bad_debt_raw']='1'
        with self.assertRaisesRegex(ValueError,'FAIL_CLOSED_BAD_DEBT_NONZERO'):
            analyze(forged,self.days)

    def test_20_forged_symbol_rejected(self):
        forged=copy.deepcopy(self.events)
        a=next(x for x in forged if x['chain_id']==4663 and x['market_id']==MARKET)
        a['collateral']='NET'
        with self.assertRaisesRegex(ValueError,'FAIL_CLOSED_TOKEN_SYMBOL_DISAGREEMENT'):
            analyze(forged,self.days)

    def test_21_corrupt_source_zip_bytes_rejected(self):
        data=Path(self.path).read_bytes()
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'tampered.zip'
            p.write_bytes(data[:-1]+bytes([data[-1]^1]))
            with self.assertRaisesRegex(ValueError,'FAIL_CLOSED_SOURCE_OUTER_SHA256'):
                read_certified_zip(p)

    def test_22_source_token_identifiers(self):
        t=self.audit['token_identity']
        self.assertEqual(t['loan_token_address'],'0x5fc5360d0400a0fd4f2af552add042d716f1d168')
        self.assertEqual(t['collateral_token_address'],'0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea')

    def test_23_oracle_source_is_not_same_block(self):
        self.assertEqual(self.audit['oracle_information']['source_verified_contract_name'],'LoopbackOracle')
        self.assertFalse(self.audit['oracle_information']['same_block_oracle_state_proven'])

    def test_24_no_implicit_monthly_forecast(self):
        self.assertNotIn('monthly_profit_usd',self.audit)
        self.assertIn('NOT_30D',self.audit['authority'])

if __name__=='__main__':
    unittest.main()
