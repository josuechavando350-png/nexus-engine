#!/usr/bin/env python3
"""No-network, synthetic-only checks for source-limited Blockscout preflight."""
from __future__ import annotations
from copy import deepcopy
import unittest
import blockscout_aave_250_indexer_preflight as m

WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'

def topic(address):return '0x'+'0'*24+address[2:]
def sample(collateral=WETH,debt=WETH):
    return {
        'address':m.POOL,
        'topics':[m.TOPIC,topic(collateral),topic(debt),topic('0x'+'1'*40)],
        'blockNumber':hex(m.START+1),
        'blockHash':'0x'+'a'*64,
        'transactionHash':'0x'+'b'*64,
        'logIndex':'0x1',
        'data':'0x'+('0'*64)*4,
    }
def response(rows,status='1',message='OK'):
    return {'status':status,'message':message,'result':rows}

class IndexerNegativeTests(unittest.TestCase):
    def test_indexer_empty_array_not_terminal_aave_census(self):
        doc=m.validate_response(response([]))
        self.assertEqual(doc['indexer_targeted_susde_or_usdtb_events'],0)
        self.assertFalse(doc['indexer_completeness_or_finality_certified'])
        self.assertFalse(doc['second_rpc_independent_operator_attestation'])
        self.assertEqual(doc['nqc_realized_pnl_usd'],'0')
    def test_explicit_documented_no_logs_can_be_zero_only_for_250(self):
        doc=m.validate_response(response([],status='0',message='No records found'))
        self.assertTrue(doc['no_claim_for_remaining_89140_blocks'])
        self.assertEqual(doc['from_block'],m.START)
    def test_other_assets_not_susde_usdtb_are_not_false_hits(self):
        doc=m.validate_response(response([sample()]))
        self.assertEqual(doc['indexer_unfiltered_aave_liquidation_events'],1)
        self.assertEqual(doc['indexer_targeted_susde_or_usdtb_events'],0)
    def test_susde_as_collateral_mismatch_fails(self):
        with self.assertRaisesRegex(m.SourceRejected,'MISMATCH'):
            m.validate_response(response([sample(collateral=m.SUSDE)]))
    def test_usdtb_as_debt_mismatch_fails(self):
        with self.assertRaisesRegex(m.SourceRejected,'MISMATCH'):
            m.validate_response(response([sample(debt=m.USDTB)]))
    def test_reverse_target_pair_also_fails(self):
        with self.assertRaisesRegex(m.SourceRejected,'MISMATCH'):
            m.validate_response(response([sample(collateral=m.USDTB,debt=m.SUSDE)]))
    def test_api_error_must_not_look_like_empty(self):
        with self.assertRaisesRegex(m.SourceRejected,'provider error'):
            m.validate_response(response([],status='0',message='NOTOK'))
    def test_apikey_error_must_fail_closed(self):
        with self.assertRaises(m.SourceRejected):
            m.validate_response({'status':'0','message':'NOTOK','result':'Missing API key'})
    def test_inconsistent_success_envelope_rejected(self):
        with self.assertRaises(m.SourceRejected):
            m.validate_response({'status':'1','message':'OK','result':None})
    def test_partial_logs_cap_refused(self):
        with self.assertRaisesRegex(m.SourceRejected,'truncated'):
            m.validate_response(response([sample() for _ in range(m.MAX_ROWS)]))
    def test_duplicate_log_ids_cannot_reconcile(self):
        with self.assertRaisesRegex(m.SourceRejected,'duplicate'):
            m.validate_response(response([sample(),sample()]))
    def test_mismatched_contract_address_rejected(self):
        x=sample();x['address']=m.SUSDE
        with self.assertRaisesRegex(m.SourceRejected,'Pool deployment'):
            m.validate_response(response([x]))
    def test_wrong_topic0_rejected(self):
        x=sample();x['topics'][0]='0x'+'f'*64
        with self.assertRaisesRegex(m.SourceRejected,'non-LiquidationCall'):
            m.validate_response(response([x]))
    def test_invalid_data_word_count_rejected(self):
        x=sample();x['data']='0x1234'
        with self.assertRaisesRegex(m.SourceRejected,'four 32-byte'):
            m.validate_response(response([x]))
    def test_malformed_indexed_topic_address_rejected(self):
        x=sample();x['topics'][1]='0x'+'1'*64
        with self.assertRaisesRegex(m.SourceRejected,'malformed indexed'):
            m.validate_response(response([x]))
    def test_log_outside_250_block_range_rejected(self):
        x=sample();x['blockNumber']=hex(m.END+1)
        with self.assertRaisesRegex(m.SourceRejected,'outside fixed'):
            m.validate_response(response([x]))
    def test_unpinned_log_hash_rejected(self):
        x=sample();x['blockHash']='0x11'
        with self.assertRaisesRegex(m.SourceRejected,'identity'):
            m.validate_response(response([x]))
    def test_invalid_transaction_hash_rejected(self):
        x=sample();x['transactionHash']='0x123'
        with self.assertRaisesRegex(m.SourceRejected,'identity'):
            m.validate_response(response([x]))
    def test_spoofed_duplicate_json_fields_fail(self):
        with self.assertRaises(m.SourceRejected):
            m.json_strict('{"status":"1","status":"0","message":"OK","result":[]}')
    def test_wrong_data_sources_not_counted_as_eth_execution(self):
        doc=m.validate_response(response([]))
        self.assertFalse(doc['nqc_captured_liquidation'])
        self.assertFalse(doc['p2_shadow_certified'])
        self.assertFalse(doc['rmc_closed'])
        self.assertFalse(doc['commercial_score_upgrade'])

if __name__=='__main__':unittest.main()
