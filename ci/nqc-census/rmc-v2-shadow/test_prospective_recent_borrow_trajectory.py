"""Falsify guessed risk trajectories and false commercial authority."""
import copy
import unittest

import prospective_recent_borrow_trajectory as track
import prospective_recent_borrow_cohort as src
import test_prospective_recent_borrow_cohort as fixture


def dual_source(**overrides):
    def make(provider):
        original=fixture.mock_rpc()
        def transport(url,method,params):
            if overrides.get('prior_source_error')==provider and method=='eth_call':
                if params[1]['blockHash']==fixture.hash32(fixture.LAST-track.HORIZON_BLOCKS):
                    raise OSError('HTTP 429 synthetic, stop retries')
            value=original(url,method,params)
            if method=='eth_call' and overrides.get('hf_shift'):
                who=int(params[0]['data'][-40:],16)
                if who==1 and params[1]['blockHash']==fixture.hash32(fixture.LAST-track.HORIZON_BLOCKS):
                    return fixture.abi_account(src.WAD+src.WAD//20,5000)
            if method=='eth_call' and overrides.get('mismatch_prior')==provider:
                who=int(params[0]['data'][-40:],16)
                if who==1 and params[1]['blockHash']==fixture.hash32(fixture.LAST-track.HORIZON_BLOCKS):
                    return fixture.abi_account(src.WAD+500,5000)
            return value
        return transport
    return make


class FreshBorrowTwoSnapshotTests(unittest.TestCase):
    def base(self,source_factory=None):
        return src.collect(transport_factory=source_factory or fixture.sources(),
                           current_unix=fixture.NOW)

    def test_all_borrowers_now_capacity_64_without_changed_event_truth(self):
        self.assertEqual(src.MAX_RECENT_ACCOUNTS,64)
        self.assertEqual(src.MAX_RPC_CALLS_PER_SOURCE,200)

    def test_complete_two_url_risk_trajectory_not_earnings(self):
        original=self.base()
        result=track.derive(original,transport_factory=dual_source())
        self.assertEqual(result['status'],
            'TWO_URL_SAME_COHORT_TWO_BLOCK_HORIZONS_HF_TRENDS_NOT_EXECUTABLE')
        self.assertEqual(result['selected_borrowers_before_HF'],3)
        self.assertEqual(len(result['trajectories']),3)
        self.assertEqual(result['block_gap'],12)
        self.assertEqual(result['hf_declining_without_causal_attribution_count'],0)
        self.assertEqual(result['hf_rising_without_causal_attribution_count'],0)
        self.assertEqual(result['hf_unchanged_count'],2)
        self.assertEqual(result['latest_borrow_after_previous_head_count'],1)
        self.assertFalse(result['competitive_capture_proven'])
        self.assertFalse(result['P2_shadow_certified'])
        self.assertEqual(result['nqc_realized_pnl_usd'],'0')

    def test_distinct_borrower_hf_fall_does_not_become_oracle_or_liquidation(self):
        parent=self.base()
        result=track.derive(parent,transport_factory=dual_source(hf_shift=True))
        self.assertEqual(result['status'],
            'TWO_URL_SAME_COHORT_TWO_BLOCK_HORIZONS_HF_TRENDS_NOT_EXECUTABLE')
        self.assertEqual(result['hf_declining_without_causal_attribution_count'],1)
        falling=[x for x in result['trajectories']
                 if x['trajectory_class']=='DEBT_ACTIVE_HF_FELL_NO_CAUSE_ASSIGNED']
        self.assertEqual(len(falling),1)
        self.assertFalse(falling[0]['causal_oracle_price_change_proven'])
        self.assertFalse(falling[0]['profitable_competitive_liquidation_proven'])
        self.assertFalse(result['actual_liquidation_executability_proven'])

    def test_selected_after_old_head_not_a_comparable_trend(self):
        result=track.derive(self.base(),transport_factory=dual_source())
        row=next(x for x in result['trajectories']
                 if x['latest_indexed_borrow_block']>result['previous_head']['number'])
        self.assertEqual(row['trajectory_class'],
            'LATEST_BORROW_AFTER_PRIOR_HEAD_NO_COMPARABLE_TREND')
        self.assertFalse(row['comparable_borrower_hf_trajectory'])
        self.assertIsNone(row['hf_change_wad'])

    def test_bad_previous_source_http429_does_not_claim_market_absence(self):
        out=track.derive(self.base(),transport_factory=dual_source(prior_source_error='drpc'))
        self.assertEqual(out['status'],
            'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')
        self.assertIn('PREVIOUS_BLOCK_OR_ACCOUNT_SOURCE_INCOMPLETE',out['reason'])
        self.assertFalse(out['commercial_score_upgrade'])
        self.assertFalse(out['net_profit_verified'])

    def test_old_rpc_state_mismatch_cannot_promote(self):
        out=track.derive(self.base(),transport_factory=dual_source(mismatch_prior='publicnode'))
        self.assertEqual(out['status'],
            'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')
        self.assertEqual(out['nqc_realized_pnl_usd'],'0')

    def test_source_bad_nonquorum_state_fails_closed(self):
        parent=self.base()
        parent['borrower_accounts_exact_two_url_parity']=False
        out=track.derive(parent,transport_factory=dual_source())
        self.assertEqual(out['status'],
            'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')

    def test_source_commercial_promotion_is_rejected(self):
        for k,v in [('nqc_realized_pnl_usd','100'),('commercial_score_upgrade',True),
                    ('route_feasibility_proven',True),('shadow_P2_certified',True)]:
            parent=self.base();parent[k]=v
            with self.subTest(k=k):
                x=track.derive(parent,transport_factory=dual_source())
                self.assertEqual(x['status'],
                    'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')

    def test_cohort_missing_member_invalid(self):
        parent=self.base()
        parent['selected_source_cohort'].pop()
        out=track.derive(parent,transport_factory=dual_source())
        self.assertEqual(out['status'],
            'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')

    def test_duplicate_source_borrower_invalid(self):
        parent=self.base()
        parent['selected_source_cohort'][1]['borrower']=parent['selected_source_cohort'][0]['borrower']
        out=track.derive(parent,transport_factory=dual_source())
        self.assertEqual(out['status'],
            'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')

    def test_malformed_health_integer_rejected(self):
        parent=self.base()
        cohort=parent['selected_source_cohort']
        current=parent['state_reports']['drpc']['accounts']
        earlier=copy.deepcopy(current)
        earlier[0]['risk']['health_factor_wad']='1e18'
        with self.assertRaises(track.Rejected):
            track.trajectory(cohort,earlier,current,fixture.LAST-12,fixture.LAST)

    def test_no_full_history_when_earlier_debt_was_zero(self):
        parent=self.base()
        cohort=parent['selected_source_cohort']
        current=copy.deepcopy(parent['state_reports']['drpc']['accounts'])
        previous=copy.deepcopy(current)
        previous[1]['risk']['total_debt_base_raw']='0'
        out=track.trajectory(cohort,previous,current,fixture.LAST-12,fixture.LAST)
        self.assertFalse(out[1]['comparable_borrower_hf_trajectory'])
        self.assertEqual(out[1]['trajectory_class'],
                         'NO_CONSISTENT_POSITIVE_DEBT_HF_BASELINE')

    def test_wrong_horizon_not_unverified_continuity(self):
        parent=self.base()
        cohort=parent['selected_source_cohort']
        current=parent['state_reports']['drpc']['accounts']
        with self.assertRaises(track.Rejected):
            track.trajectory(cohort,current,current,fixture.LAST-13,fixture.LAST)

    def test_incomplete_base_source_is_not_a_negative_market_census(self):
        parent=self.base()
        parent['status']='INCOMPLETE_RECENT_BORROW_SOURCE_NOT_MARKET_ABSENCE'
        x=track.derive(parent,transport_factory=dual_source())
        self.assertTrue(x['not_a_complete_active_borrower_census'])
        self.assertEqual(x['status'],
           'INCOMPLETE_FRESH_BORROW_TRAJECTORY_NOT_MARKET_ABSENCE')

    def test_source_original_retained_no_future_winners(self):
        r=track.derive(self.base(),transport_factory=dual_source())
        self.assertTrue(r['no_future_winner_selection'])
        self.assertTrue(r['same_account_source_not_complete_borrower_universe'])
        self.assertFalse(r['oracle_driver_or_intervening_account_actions_reconciled'])
        self.assertTrue(r['block_gap_is_not_local_mempool_lead_time'])
        self.assertFalse(r['native_gas_nonrecourse_sponsor_proven'])

    def test_enforced_capped_extra_reads_per_provider(self):
        r=track.derive(self.base(),transport_factory=dual_source())
        for row in r['source_older_state'].values():
            self.assertLessEqual(row['read_only_calls'],track.MAX_EXTRA_RPC_CALLS_PER_SOURCE)
            self.assertLessEqual(row['total_calls_in_both_stages'],
                                 track.MAX_COMBINED_READ_CALLS_PER_SOURCE)


if __name__=='__main__':unittest.main()
