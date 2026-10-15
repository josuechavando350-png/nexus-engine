"""Adversarial checks: 23-day source attestation and capture-share arithmetic."""
from __future__ import annotations

import copy
from hashlib import sha256
from pathlib import Path
import os
import tempfile
import unittest
import zipfile

import morpho_capacity_falsification as m

SOURCE = os.environ.get('NQC_ORIGINAL_MORPHO_INDEXER_ZIP',
                        '/mnt/data/NQC_PR741_MORPHO_30DAY_CERTIFIED_INDEXER.zip')

class FailClosedCapacity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.src=Path(SOURCE).read_bytes()
        cls.census,cls.rows=m.checked_zip_bytes(cls.src)
        cls.result=m.compute(cls.rows)

    def test_source_sha_pinned(self):
        self.assertEqual(sha256(self.src).hexdigest(),m.ORIGINAL_ZIP_SHA256)
    def test_manifest_all_nine_members(self):
        with zipfile.ZipFile(Path(SOURCE)) as z:
            self.assertEqual(len(z.read('manifest.sha256').splitlines()),9)
    def test_corrupt_zip_rejected(self):
        broken=bytearray(self.src);broken[240]^=1
        with self.assertRaisesRegex(m.BadEvidence,'ORIGINAL_ZIP_MISMATCH'):
            m.checked_zip_bytes(bytes(broken))
    def test_wrong_extra_member_rejected(self):
        from io import BytesIO
        io=BytesIO()
        with zipfile.ZipFile(io,'w') as z:z.writestr('fake/manifest.sha256',b'')
        with self.assertRaises(m.BadEvidence):m.checked_zip_bytes(io.getvalue())
    def test_original_is_not_complete_month(self):
        self.assertEqual(self.census['days_scoped'],30)
        self.assertEqual(self.census['days_attempted'],24)
        self.assertEqual(sum(d['status']=='COMPLETE_MORPHO_API_DAY_INDEX_ONLY' for d in self.census['daily_source_provenance']),23)
        self.assertFalse(self.result['source_30d_window_complete'])
    def test_verified_original_rows_and_identity(self):
        self.assertEqual(len(self.rows),2565)
        self.assertEqual(len({x['win_id'] for x in self.rows}),1932)
        self.assertEqual(self.result['unique_winning_transactions'],227)
    def test_no_multilog_double_count(self):
        self.assertEqual(self.result['observed_events'],418)
        self.assertGreater(self.result['observed_events'],self.result['unique_winning_transactions'])
        self.assertEqual(m.build_tx(self.rows)['8453:0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa']['events'],11)
    def test_historical_principal_exact(self):
        self.assertEqual(self.result['segments']['whole_observed_submarket']['principal_usdc_source_indexed'],'1281537.248484')
        self.assertEqual(self.result['peak_calendar_utc_day'],'2026-09-15')
        self.assertEqual(self.result['peak_day_principal_usdc'],'823304.949840')
    def test_tail_concentration_not_win_probability(self):
        self.assertEqual(self.result['peak_day_share_percent'],'64.24')
        self.assertEqual(self.result['top_three_liquidator_debt_share_percent'],'82.06')
        self.assertFalse(self.result['direct_competitor_advantage_proven'])
    def test_excluding_peak_and_top_three_already_below_target(self):
        rem=self.result['segments']['excluding_both_peak_and_top_three']
        self.assertEqual(rem['principal_usdc_source_indexed'],'65856.799247')
        self.assertEqual(rem['principal_share_of_complete_23_day_indexed_submarket_percent'],'5.14')
        self.assertEqual(rem['hypothetical_exit_haircuts'][0]['nqc_50percent_before_all_other_costs_usdc'],'4174.022476')
        self.assertFalse(rem['hypothetical_exit_haircuts'][0]['could_pass_5000_only_if_100pct_captured_before_costs'])
    def test_haircut_5pct_reduces_optimistic_remaining_capacity(self):
        rem=self.result['segments']['excluding_both_peak_and_top_three']
        self.assertEqual(rem['hypothetical_exit_haircuts'][2]['exit_haircut_bps_hypothetical'],500)
        self.assertEqual(rem['hypothetical_exit_haircuts'][2]['nqc_50percent_before_all_other_costs_usdc'],'2318.901369')
    def test_no_haircut_at_12percent_can_manufacture_margin(self):
        for seg in self.result['segments'].values():
            self.assertEqual(seg['hypothetical_exit_haircuts'][-1]['nqc_50percent_before_all_other_costs_usdc'],'0.000000')
            self.assertIsNone(seg['hypothetical_exit_haircuts'][-1]['required_capture_of_segment_for_5000_nqc_percent'])
    def test_full_source_wrong_market_cannot_be_admitted(self):
        b=copy.deepcopy(self.rows)
        original=next(x for x in b if x['chain_id']==8453 and x['market_id']==m.MARKET)
        original['collateral']='WrongTicker'
        with self.assertRaisesRegex(m.BadEvidence,'TOKEN_INDEXER_ID_MISMATCH'):m.compute(b)
    def test_duplicate_tx_conflict_not_ignored(self):
        b=copy.deepcopy(self.rows)
        original=next(x for x in b if x['chain_id']==8453 and x['market_id']==m.MARKET and x['tx']=='0x049327359c7be3409a6f0d2f2f0d1d41b32ba7d109d583be0bfe6c696932c0aa')
        original['timestamp']=1
        with self.assertRaisesRegex(m.BadEvidence,'MULTI_LOG_TX_IDENTITY_DIVERGENCE'):m.compute(b)
    def test_wrong_liquidator_address_rejected(self):
        b=copy.deepcopy(self.rows)
        next(x for x in b if x['chain_id']==8453 and x['market_id']==m.MARKET)['liquidator']='0x0000'
        with self.assertRaisesRegex(m.BadEvidence,'INVALID_INDEXED_LIQUIDATOR'):m.compute(b)
    def test_bad_debt_events_not_claimed_as_bonus(self):
        b=copy.deepcopy(self.rows)
        next(x for x in b if x['chain_id']==8453 and x['market_id']==m.MARKET)['bad_debt_raw']='1'
        with self.assertRaisesRegex(m.BadEvidence,'BAD_DEBT_NOT_COVERED_BY_PROFIT_MODEL'):m.compute(b)
    def test_numeric_parser_rejects_unsafe_or_truncated_values(self):
        for bad in (1,True,'01','-1','1.2','1e6',None,'9'*80):
            with self.subTest(bad=bad):
                with self.assertRaises(m.BadEvidence):m.source_uint(bad,'test')
    def test_no_real_capture_profitable_claim(self):
        self.assertEqual(self.result['nqc_realized_pnl_usd'],'0')
        self.assertFalse(self.result['external_gas_sponsor_proven'])
        self.assertTrue(self.result['no_nqc_monthly_forecast_permitted'])
        self.assertFalse(self.result['live_captured_opportunity_proven'])
    def test_cli_end_to_end_with_real_source(self):
        with tempfile.TemporaryDirectory() as d:
            output=Path(d)/'report.json'
            c=m.run(Path(SOURCE),output)
            self.assertTrue(output.is_file())
            self.assertEqual(c['status'],'SOURCE_LOCKED_23D_MORPHO_MARKET_CAPACITY_SENSITIVITY_NOT_PROFIT')
            import json
            self.assertEqual(json.loads(output.read_text())['peak_calendar_utc_day'],'2026-09-15')

if __name__=='__main__': unittest.main()
