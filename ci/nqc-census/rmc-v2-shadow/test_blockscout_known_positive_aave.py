#!/usr/bin/env python3
"""Purely synthetic positive-anchor forgery rejection tests; zero RPC."""
from copy import deepcopy
import unittest
import blockscout_known_positive_aave as p

def topic(address):return '0x'+'0'*24+address[2:]
def log():
    return {
        'address':p.POOL,'topics':[p.LIQ,topic(p.WETH),topic(p.WETH),topic('0x'+'2'*40)],
        'data':'0x'+format(p.PRINCIPAL,'064x')+format(p.PRINCIPAL+123,'064x')+
            '0'*24+'3'*40+format(0,'064x'),
        'blockNumber':hex(p.BLOCK),'blockHash':p.HASH,
        'transactionHash':p.TX,'transactionIndex':'0x1','logIndex':'0x1'
    }
def response(rows):return {'status':'1','message':'OK','result':rows}

class IndexerRealPositiveWitnessTests(unittest.TestCase):
    def test_known_event_witness_is_only_indexer_confirmation(self):
        out=p.validate(response([log()]))
        self.assertEqual(out['matching_real_liquidation_events'],1)
        self.assertFalse(out['whole_indexer_history_complete_certified'])
        self.assertFalse(out['Nexus_won_liquidation'])
        self.assertEqual(out['nqc_realized_pnl_usd'],'0')
    def test_empty_indexer_history_rejected_for_real_positive(self):
        with self.assertRaisesRegex(p.Rejected,'known-positive source'):
            p.validate({'status':'0','message':'No logs found','result':[]})
    def test_error_response_refused(self):
        with self.assertRaises(p.Rejected):p.validate({'status':'0','message':'NOTOK','result':'rate limit'})
    def test_wrong_transaction_rejected_even_if_event_present(self):
        x=log();x['transactionHash']='0x'+'4'*64
        with self.assertRaisesRegex(p.Rejected,'not uniquely'):
            p.validate(response([x]))
    def test_wrong_block_hash_rejected(self):
        x=log();x['blockHash']='0x'+'a'*64
        with self.assertRaisesRegex(p.Rejected,'canonical block'):
            p.validate(response([x]))
    def test_wrong_collateral_rejected(self):
        x=log();x['topics'][1]=topic('0x'+'5'*40)
        with self.assertRaisesRegex(p.Rejected,'differs from immutable'):
            p.validate(response([x]))
    def test_wrong_debt_rejected(self):
        x=log();x['topics'][2]=topic('0x'+'5'*40)
        with self.assertRaisesRegex(p.Rejected,'differs from immutable'):
            p.validate(response([x]))
    def test_forged_principal_rejected(self):
        x=log();x['data']='0x'+format(p.PRINCIPAL+1,'064x')+x['data'][66:]
        with self.assertRaisesRegex(p.Rejected,'differs from immutable'):
            p.validate(response([x]))
    def test_duplicate_event_rejected(self):
        with self.assertRaisesRegex(p.Rejected,'duplicate'):
            p.validate(response([log(),log()]))
    def test_outside_block_rejected(self):
        x=log();x['blockNumber']=hex(p.BLOCK-1)
        with self.assertRaisesRegex(p.Rejected,'height'):
            p.validate(response([x]))
    def test_fake_pool_rejected(self):
        x=log();x['address']=p.WETH
        with self.assertRaisesRegex(p.Rejected,'origin'):
            p.validate(response([x]))
    def test_corrupted_event_payload_rejected(self):
        x=log();x['data']='0xdead'
        with self.assertRaisesRegex(p.Rejected,'ABI'):
            p.validate(response([x]))
    def test_non_liquidation_topic_rejected(self):
        x=log();x['topics'][0]='0x'+'0'*64
        with self.assertRaisesRegex(p.Rejected,'LiquidationCall'):
            p.validate(response([x]))
    def test_duplicate_json_fields_rejected(self):
        with self.assertRaises(p.Rejected):
            p.strict_json('{"status":"1","status":"0","result":[]}')
    def test_no_p2_certification_from_indexer(self):
        d=p.validate(response([log()]))
        self.assertFalse(d['p2_shadow_certified'])
        self.assertFalse(d['rmc_closed'])
        self.assertFalse(d['commercial_score_upgrade'])
    def test_untrusted_result_truncation_rejected(self):
        with self.assertRaisesRegex(p.Rejected,'truncated'):
            p.validate(response([log() for _ in range(950)]))

if __name__=='__main__':unittest.main()
