"""Adversarial offline commercial capacity checks; no forecast or live orders."""
import copy
import unittest

import postwindow_competition_capacity_hurdle as gate


def fixture():
    weth,usdc,usdt=gate.WETH,gate.USDC,gate.USDT
    pairs=[('0x'+f'{n:040x}','0x'+f'{(n+500):040x}') for n in range(1,20)]
    rows=[]
    def add(n,pair,logid):
        rows.append({'tx_hash':'0x'+f'{n:064x}', 'block':26_095_352+n,
                     'log_index':logid, 'collateral_asset':pair[0],
                     'debt_asset':pair[1]})
    for n in range(1,10):
        add(n,(weth,usdc),100+n)
    for n in [9]+list(range(10,16)):
        add(n,(weth,usdt),200+n)
    for n in range(16,48):
        add(n,pairs[(n-16)%len(pairs)],300+n)
    # 2 additional cross-pair memberships; source has 3 in all, one
    # already is the WETH stable overlap.
    add(16,pairs[1],900)
    add(17,pairs[2],901)
    add(1,(weth,usdc),902)
    add(10,(weth,usdt),903)
    add(18,pairs[2],904)
    assert len(rows)==53 and len({x['tx_hash'] for x in rows})==47
    assert len({(x['collateral_asset'],x['debt_asset']) for x in rows})==21
    unique={}
    for x in rows:
        unique.setdefault((x['collateral_asset'],x['debt_asset']),set()).add(x['tx_hash'])
    rank=[{'collateral_asset':k[0], 'debt_asset':k[1],
           'distinct_historical_winner_tx_count':len(v)}
          for k,v in unique.items()]
    report={'status':'INDEXER_DISCOVERY_RANKING_ONLY_NOT_CANONICAL_P2_OR_PNL',
        'source_rest_indexer_full_onchain_completeness':False,
        'block_and_tx_receipt_independent_quorum':False,
        'capturable_future_opportunities_established':False,
        'commercial_score_upgrade':False,'RMC_closed':False,
        'P2_shadow_certified':False, 'nqc_realized_pnl_usd':'0',
        'indexed_event_count':53,'unique_indexed_winner_tx_count':47,
        'unique_indexed_pair_count':21,
        'window':{'start':26095352,'end':26184741,'inclusive_blocks':89390},
        'ranked_pairs':rank}
    econ={'WETH_COLLATERAL_USDC_DEBT':{'surplus_asset_micros':2273989378},
          'WETH_COLLATERAL_USDT_DEBT':{'surplus_asset_micros':150882941}}
    return report,rows,econ


class CompetitionCapacityTruthTests(unittest.TestCase):
    def setUp(self):
        self.report,self.rows,self.econ=fixture()

    def build(self):
        return gate.build(self.report,self.rows,self.econ,{'test':'fixture'})

    def test_two_pair_unique_winners_dedup_not_16(self):
        doc=self.build()
        self.assertEqual(doc['weth_usdc_indexed_winner_txs'],9)
        self.assertEqual(doc['weth_usdt_indexed_winner_txs'],7)
        self.assertEqual(doc['shared_winner_transaction_count'],1)
        self.assertEqual(doc['weth_stable_distinct_transaction_slots'],15)
        self.assertEqual(len(doc['shared_winner_txs']),1)
        self.assertEqual(doc['indexed_distinct_winner_transaction_count'],47)

    def test_homogeneous_optimistic_zero_cost_does_not_prove_monthly_55k(self):
        doc=self.build()
        case=doc['scenarios'][0]
        self.assertEqual(case['synthetic_assumed_combined_cost_per_captured_tx_usd'],0)
        val=case['all_15_distinct_source_txs_proxy_residual_usd_micros_30d']
        expected=(9*2273989378+6*150882941)*216000//89390
        self.assertEqual(val,expected)
        self.assertGreater(val,45_000*gate.USD_MICROS)
        self.assertLess(val,55_000*gate.USD_MICROS)
        self.assertTrue(case['targets'][0]['possible_within_100pct_of_the_15_assumed_slots'])
        self.assertFalse(case['targets'][1]['possible_within_100pct_of_the_15_assumed_slots'])

    def test_synthetic_cost_usdt_unprofitable_must_not_be_forced_to_run(self):
        doc=self.build()
        self.assertEqual(doc['scenarios'][2]['synthetic_assumed_combined_cost_per_captured_tx_usd'],300)
        self.assertEqual(doc['scenarios'][2]['economically_positive_slot_count_under_assumptions'],9)
        projected=9*(2273989378-300000000)*216000//89390
        self.assertEqual(doc['scenarios'][2]['all_15_distinct_source_txs_proxy_residual_usd_micros_30d'],projected)
        self.assertFalse(doc['scenarios'][2]['targets'][0]['possible_within_100pct_of_the_15_assumed_slots'])

    def test_full_capture_is_not_prospective_net_proof(self):
        doc=self.build()
        self.assertFalse(doc['real_capture_fraction_calibrated'])
        self.assertFalse(doc['net_pnl_certified'])
        self.assertFalse(doc['external_nonrecourse_gas_sponsor_certified'])
        self.assertFalse(doc['full_cold_tx_gas_measured'])
        self.assertFalse(doc['RMC_closed'])
        self.assertFalse(doc['P2_shadow_certified'])
        self.assertEqual(doc['realizable_nqc_monthly_net_lower_bound_usd_micros'],0)
        self.assertEqual(doc['nqc_realized_pnl_usd'],'0')
        self.assertTrue(doc['no_markets_frozen_or_excluded'])

    def test_actual_counterparty_competition_does_not_become_our_win(self):
        doc=self.build()
        self.assertTrue(doc['all_competitor_winner_txs_available_to_nqc_unproven'])
        self.assertTrue(doc['historical_winner_selection_and_homogeneous_surplus_lookahead'])
        self.assertFalse(doc['indexer_source_complete_canonical_chain'])

    def test_100_cost_requires_high_capture_but_is_not_probability(self):
        doc=self.build()
        d=doc['scenarios'][1]
        need=d['targets'][0]['capture_share_bps_necessary_under_assumptions']
        self.assertGreater(need,9000)
        self.assertLess(need,10000)
        self.assertTrue(d['failed_bid_costs_not_calibrated'])

    def test_ghost_16th_independent_winner_is_rejected(self):
        changed=copy.deepcopy(self.rows)
        for x in changed:
            if x['debt_asset']==gate.USDT and x['tx_hash']=='0x'+f'{9:064x}':
                x['tx_hash']='0x'+f'{48:064x}'
        with self.assertRaises(gate.Rejected):
            gate.build_market_slots(self.report,changed)

    def test_duplicate_event_identity_rejected(self):
        self.rows[1]=copy.deepcopy(self.rows[0])
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_out_of_range_event_rejected(self):
        self.rows[0]['block']=12345
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_censored_or_thin_indexer_not_promoted(self):
        self.report['source_rest_indexer_full_onchain_completeness']=True
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_fabricated_live_capture_flag_rejected(self):
        self.report['capturable_future_opportunities_established']=True
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_fake_nqc_profit_rejected(self):
        self.report['nqc_realized_pnl_usd']='100'
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_fabricated_shadow_certificate_rejected(self):
        self.report['P2_shadow_certified']=True
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_missing_txs_rejected(self):
        self.rows=self.rows[:45]
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_market_pair_count_mismatch_rejected(self):
        self.report['unique_indexed_pair_count']=20
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_surplus_mutation_rejected(self):
        self.econ['WETH_COLLATERAL_USDC_DEBT']['surplus_asset_micros']+=1
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_bad_stable_coin_pair_rejected(self):
        self.rows[0]['debt_asset']='0x'+'ff'*20
        with self.assertRaises(gate.Rejected):
            self.build()

    def test_more_than_100pct_is_not_feasible(self):
        d=self.build()
        t=d['scenarios'][2]['targets'][1]
        self.assertGreater(t['capture_share_bps_necessary_under_assumptions'],10000)
        self.assertFalse(t['possible_within_100pct_of_the_15_assumed_slots'])

    def test_ceildiv_avoids_understated_capture_requirement(self):
        self.assertEqual(gate.ceildiv(10001,1000),11)
        with self.assertRaises(gate.Rejected):
            gate.ceildiv(1,0)

    def test_untrusted_zip_is_never_accepted(self):
        for raw in (b'not a zip',b'',b'\0'*128):
            with self.assertRaises(gate.Rejected):
                gate.authenticate_index_archive(raw)

    def test_bare_loan_not_a_paid_route(self):
        self.assertEqual(gate.MONTH_TARGET_USD,(45000,55000))
        self.assertEqual(gate.SYNTHETIC_CAPTURE_COST_USD,(0,100,300))


if __name__=="__main__":
    unittest.main()
