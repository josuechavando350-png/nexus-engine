"""Fail-closed tests for PR709/710 historical activation timing ledger."""
import copy
import unittest

import oracle_reactive_window_ledger as gate


def fixtures():
    rounds = [
      (24872, 26188304, 71,
       "0x018575d2656cfdcc86c7872aaf2fc30adc3c3d0fd3e737b803a49400c0752846",
       26188305, 53,
       "0xa8a98d467ecfb7f57e9329d9ce0f57b4b0380d502817802ed269bb1e75d3650f",
       250951678541, 250578590318, 12),
      (24873, 26188605, 51,
       "0x40f4ae52f33b32ecd02c02b5ff5da61218a5788a85984677aa0071ab12883475",
       26188605, 52,
       "0xa4cc4c2316845821c0882ded765d8ee66c55405074ae0eed00c0ce8df1f8d2c3",
       250578590318, 250468000000, 0),
    ]
    order={"status":"SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY",
           "cross_endpoint_receipt_parity":False, "errors":[],
           "nqc_realized_pnl_usd":"0",
           "RMC_closed":False, "P2_shadow_certified":False,
           "canary_live_authorized":False,"commercial_score_upgrade":False,
           "sources":{"drpc":{"status":"ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED"},
                      "blast":{"status":"INCOMPLETE_RECEIPT_SOURCE"}},
           "rounds":[]}
    prices={"status":"TWO_RPC_HISTORICAL_PRICE_PATH_PARITY_NO_LIVE_CAPTURE",
            "errors":[], "nqc_realized_pnl_usd":"0",
            "RMC_closed":False, "P2_shadow_certified":False,
            "canary_live_authorized":False,"commercial_score_upgrade":False,
            "source":{"producer_commit":gate.HEAD709, "zip_sha256":gate.SHA709,
                      "producer_source_status":"SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY",
                      "PR707_two_operator_receipt_parity_inherited":False},
            "cases":[]}
    for rid,bp,ip,txp,bs,isec,txs,old,new,elapsed in rounds:
        order['rounds'].append({
          'round_id':rid,
          'ordering':"SECONDARY_AFTER_PRIMARY_FUTURE_BLOCK"
                     if bp!=bs else "SECONDARY_AFTER_PRIMARY_SAME_BLOCK",
          'primary':{'block':bp,'transaction_index':ip,'tx_hash':txp},
          'secondary':{'block':bs,'transaction_index':isec,'tx_hash':txs},
          'block_height_difference_secondary_minus_primary':bs-bp,
          'block_timestamp_difference_seconds':elapsed})
        for family,block,txindex,txhash,before,after,answer,delta in [
            (gate.PRIMARY,bp,ip,txp,old,old,new,0),
            (gate.SECONDARY,bs,isec,txs,old,new,None,1)]:
            metric={'NQC_AAVE_PRICE_BEFORE':before, 'NQC_AAVE_PRICE_AFTER':after,
                    'NQC_CHAINLINK_ANSWER_BEFORE':before,
                    'NQC_CHAINLINK_ANSWER_AFTER':after,
                    'AAVE_PRICE_DELTA_RAW':after-before,
                    'NQC_PRICE_CHANGED':delta,
                    'NQC_MATCHED_ORACLE_EVENT':1,
                    'source_event_family':family,
                    'historical_only':True,
                    'source_event_does_not_guarantee_price_change':True}
            prices['cases'].append({
                'source_parity':True,
                'case':{'round_id':rid, 'family':family,'block':block,
                        'timestamp':10000000+block*12,
                        'tx_index':txindex, 'tx_hash':txhash,
                        'source_price_answer_raw':answer},
                'dRPC':metric, 'BlastAPI':copy.deepcopy(metric)})
    return order,prices


class OracleActivationLedgerTests(unittest.TestCase):
    def setUp(self):
        self.order,self.prices=fixtures()

    def build(self):
        return gate.build(self.order,self.prices,
                          {'order':{'producer_commit':gate.HEAD709},
                           'price':{'producer_commit':gate.HEAD710}})

    def reject(self):
        with self.assertRaises(gate.Rejected): self.build()

    def test_two_round_paths_and_window_classification(self):
        d=self.build()
        self.assertEqual(d['status'],
                         'TWO_HISTORICAL_SECONDARY_PRICE_ACTIVATIONS_REPRODUCED_NO_CAPTURE')
        self.assertEqual(d['secondary_only_price_activation_count'],2)
        self.assertEqual(d['next_block_secondary_count'],1)
        self.assertEqual(d['same_block_secondary_count'],1)
        self.assertEqual(d['rounds'][0]['block_gap'],1)
        self.assertEqual(d['rounds'][1]['block_gap'],0)
        self.assertIn('NONE_IF_TRIGGER_IS_ONLY_CONFIRMED_PRIMARY_HEAD',
                      d['rounds'][1]['post_primary_local_head_reactive_slot'])

    def test_eth_only_hypothetical_hf_bound_not_promoted(self):
        d=self.build()
        for row in d['rounds']:
            hf=row['hypothetical_eth_only_hf_crossing_band']
            self.assertGreater(hf['upper_wad_exclusive_approx'],gate.WAD)
            self.assertTrue(hf['assumes_only_weth_collateral_unchanged_stable_debt'])
            self.assertFalse(hf['real_aave_integer_hf_replay_proven'])
            self.assertFalse(row['borrower_at_risk_identified_in_this_round'])
        self.assertFalse(d['candidate_borrower_hf_crossing_proven'])
        self.assertFalse(d['nqc_net_profit_authenticated'])
        self.assertEqual(d['nqc_realized_pnl_usd'],'0')

    def test_report_answer_matches_later_active_aave_price(self):
        d=self.build()
        self.assertEqual(d['rounds'][0]['primary_report_price_raw'],250578590318)
        self.assertEqual(d['rounds'][1]['primary_report_price_raw'],250468000000)

    def test_actual_delta_millibps_from_integer_math(self):
        d=self.build()
        self.assertEqual(d['rounds'][0]['decline_millibasis_points_floor'],
                         (250951678541-250578590318)*10_000_000//250951678541)
        self.assertEqual(d['rounds'][1]['decline_millibasis_points_floor'],
                         (250578590318-250468000000)*10_000_000//250578590318)

    def test_price_first_provider_parity_missing_rejected(self):
        self.prices['cases'][0]['source_parity']=False
        self.reject()

    def test_provider_price_mismatch_rejected(self):
        self.prices['cases'][1]['BlastAPI']['NQC_AAVE_PRICE_AFTER']+=1
        self.reject()

    def test_source_status_mismatch_rejected(self):
        self.prices['status']='INCOMPLETE'
        self.reject()

    def test_original_blast_429_must_remain_incomplete(self):
        self.order['sources']['blast']['status']='ALL_FOUR_RECEIPTS_CANONICAL_ORDER_VERIFIED'
        self.reject()

    def test_source_operator_independence_false_promotion_rejected(self):
        self.prices['source']['PR707_two_operator_receipt_parity_inherited']=True
        self.reject()

    def test_primary_price_change_fails(self):
        self.prices['cases'][0]['dRPC']['NQC_PRICE_CHANGED']=1
        self.prices['cases'][0]['BlastAPI']['NQC_PRICE_CHANGED']=1
        self.reject()

    def test_secondary_price_unchanged_fails(self):
        x=self.prices['cases'][1]
        for k in ('dRPC','BlastAPI'):
            x[k]['NQC_AAVE_PRICE_AFTER']=x[k]['NQC_AAVE_PRICE_BEFORE']
            x[k]['NQC_PRICE_CHANGED']=0
            x[k]['AAVE_PRICE_DELTA_RAW']=0
            x[k]['NQC_CHAINLINK_ANSWER_AFTER']=x[k]['NQC_AAVE_PRICE_AFTER']
        self.reject()

    def test_wrong_primary_report_answer_rejected(self):
        self.prices['cases'][2]['case']['source_price_answer_raw']+=1
        self.reject()

    def test_paired_receipt_hash_drift_rejected(self):
        self.order['rounds'][0]['secondary']['tx_hash']='0x'+'ff'*32
        self.reject()

    def test_ordering_label_drift_rejected(self):
        self.order['rounds'][1]['ordering']='SECONDARY_AFTER_PRIMARY_FUTURE_BLOCK'
        self.reject()

    def test_same_block_primary_not_before_secondary_rejected(self):
        self.order['rounds'][1]['primary']['transaction_index']=53
        self.prices['cases'][2]['case']['tx_index']=53
        self.reject()

    def test_duplicate_round_rejected(self):
        self.order['rounds'][1]['round_id']=24872
        self.reject()

    def test_fabricated_profit_rejected(self):
        self.prices['nqc_realized_pnl_usd']='10000'
        self.reject()

    def test_fabricated_shadow_certification_rejected(self):
        self.order['P2_shadow_certified']=True
        self.reject()

    def test_untrusted_archive_rejected(self):
        for payload in (b'',b'not a zip',b'\x00'*20):
            with self.assertRaises(gate.Rejected):
                gate.authenticate_archive(payload,gate.SHA709,gate.HEAD709,
                                          'round-receipt-order.json')

    def test_malformed_json_duplicate_keys_rejected(self):
        with self.assertRaises(gate.Rejected):
            gate.strict_json(b'{"rounds":[],"rounds":[]}')

    def test_bad_counterparty_profit_gas_claims_not_present(self):
        r=self.build()
        self.assertFalse(r['public_mempool_first_seen_proven'])
        self.assertFalse(r['cold_transaction_gas_authenticated'])
        self.assertFalse(r['builder_ordering_available_proven'] if
                         'builder_ordering_available_proven' in r else
                         r['confirmed_block_reactive_capture_proven'])


if __name__=="__main__":
    unittest.main()
