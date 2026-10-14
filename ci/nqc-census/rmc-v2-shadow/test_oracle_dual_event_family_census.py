import copy
from hashlib import sha256
from unittest.mock import patch
import unittest

import oracle_dual_event_family_census as dual


def header(n):
    return {'number':hex(n), 'hash':'0x'+sha256(str(n).encode()).hexdigest(),
            'parentHash':'0x'+sha256(str(n-1).encode()).hexdigest(),
            'timestamp':hex(1000000000+n*12)}


def event(n,topic,idx=1,round_id=100,answer=250000000000):
    primary=topic==dual.NEW_TRANSMISSION_TOPIC
    return {'address':dual.AGGREGATOR,
        'topics':[topic,'0x'+round_id.to_bytes(32,'big').hex()],
        'blockNumber':hex(n),'blockHash':header(n)['hash'],
        'transactionHash':'0x'+sha256(f'{n}:{idx}'.encode()).hexdigest(),
        'logIndex':hex(idx),'removed':False,
        'data':('0x'+answer.to_bytes(32,'big').hex()+'00'*(7*32))
               if primary else '0x'}


def fake_transport(events,fail=None):
    def run(method,params):
        if method==fail:
            raise OSError('provider rate limited, still censored')
        if method=='eth_chainId':
            return '0x1'
        if method=='eth_getBlockByNumber':
            n=100000 if params[0]=='latest' else int(params[0],16)
            return header(n)
        if method=='eth_getLogs':
            q=params[0];a=int(q['fromBlock'],16);b=int(q['toBlock'],16)
            return [x for x in events if a<=int(x['blockNumber'],16)<=b
                    and x['topics'][0]==q['topics'][0]]
        raise AssertionError('write or unapproved network read')
    return run


def factory(drpc,blast=None,blast_error=None):
    return lambda name: fake_transport(
         drpc if name=='drpc' else drpc if blast is None else blast,
         fail=blast_error if name=='blast' else None)


def valid_events():
    # First trigger's exact family: secondary-only; second: primary + secondary.
    return [event(99700,dual.SECONDARY_ROUND_TOPIC,1),
            event(99800,dual.NEW_TRANSMISSION_TOPIC,2,answer=248000000000),
            event(99800,dual.SECONDARY_ROUND_TOPIC,3)]


class DualFamilyOracleTruthTests(unittest.TestCase):
    def setUp(self):
        self.source={'historical_positive':True}

    def test_corrected_topic_and_historical_actual_signatures(self):
        self.assertEqual(dual.NEW_TRANSMISSION_TOPIC,
            '0xc797025feeeaf2cd924c99e9205acb8ec04d5cad21c41ce637a38fb6dee6016a')
        self.assertEqual(dual.SECONDARY_ROUND_TOPIC,
            '0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b')
        self.assertNotEqual(dual.NEW_TRANSMISSION_TOPIC,dual.SUPERSEDED_TOPIC)

    def test_secondary_round_has_no_price_answer(self):
        e=dual.parse_event(event(99700,dual.SECONDARY_ROUND_TOPIC),99700,99700)
        self.assertEqual(e['event_family'],'SECONDARY_ROUND_ID_UPDATED')
        self.assertIsNone(e['price_answer_raw'])
        self.assertEqual(e['round_id'],100)

    def test_primary_newtransmission_answer_and_round(self):
        e=dual.parse_event(event(99800,dual.NEW_TRANSMISSION_TOPIC,round_id=101),99800,99800)
        self.assertEqual(e['event_family'],'PRIMARY_NEW_TRANSMISSION')
        self.assertEqual(e['price_answer_raw'],250000000000)
        self.assertEqual(e['round_id'],101)

    def test_previous_wrong_topic_never_becomes_valid(self):
        m=event(99800,dual.NEW_TRANSMISSION_TOPIC)
        m['topics'][0]=dual.SUPERSEDED_TOPIC
        with self.assertRaises(ValueError):
            dual.parse_event(m,99800,99800)

    def test_secondary_cannot_carry_fabricated_price_data(self):
        m=event(99800,dual.SECONDARY_ROUND_TOPIC)
        m['data']='0x'+'00'*32
        with self.assertRaises(ValueError):
            dual.parse_event(m,99800,99800)

    def test_primary_requires_integer_abi_and_correct_indexed_round(self):
        for mutation in (
            {'data':'0x00'}, {'topics':[dual.NEW_TRANSMISSION_TOPIC]},
            {'topics':[dual.NEW_TRANSMISSION_TOPIC,'0x'+'ff'*32]},
            {'data':'0x'+'00'*256}):
            m=event(99800,dual.NEW_TRANSMISSION_TOPIC)
            m.update(mutation)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                dual.parse_event(m,99800,99800)

    def test_reorg_or_wrong_emitter_is_not_admitted(self):
        mutations=[
          {'removed':True},{'address':'0x'+'00'*20},
          {'blockNumber':hex(99900)}, {'blockHash':'0x00'},
        ]
        for mutation in mutations:
            m=event(99800,dual.NEW_TRANSMISSION_TOPIC)
            m.update(mutation)
            with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                dual.parse_event(m,99800,99800)

    def test_complete_two_source_dual_family_research(self):
        with patch.object(dual,'authenticate_historical',return_value=self.source):
            report=dual.run(b'fixture',factory(valid_events()))
        self.assertEqual(report['status'],'TWO_ENDPOINT_DUAL_FAMILY_PINNED_CENSUS_NO_CAPTURE')
        self.assertTrue(report['cross_endpoint_event_parity'])
        s=report['two_source_descriptive_summary']
        self.assertEqual(s['primary_newtransmission_events'],1)
        self.assertEqual(s['secondary_round_update_events'],2)
        self.assertEqual(s['unique_transactions_union'],3)
        self.assertEqual(s['secondary_only_transactions'],2)
        self.assertEqual(s['primary_only_transactions'],1)
        self.assertTrue(s['secondary_event_has_no_price_answer'])
        self.assertFalse(report['net_capture_pnl_proven'])
        self.assertFalse(report['future_signal_public_mempool_visibility_proven'])
        self.assertEqual(report['nqc_realized_pnl_usd'],'0')

    def test_same_tx_report_and_secondary_not_double_counted(self):
        e1=event(99800,dual.NEW_TRANSMISSION_TOPIC,1)
        e2=event(99800,dual.SECONDARY_ROUND_TOPIC,2)
        e2['transactionHash']=e1['transactionHash']
        s=dual.descriptive_summary(
            [dual.parse_event(e,99800,99800)|{'block_timestamp':1011976000}
             for e in [e1,e2]],1011975900,1011977000)
        self.assertEqual(s['unique_transactions_union'],1)
        self.assertEqual(s['dual_family_same_transaction_count'],1)
        self.assertEqual(s['secondary_only_transactions'],0)

    def test_wrong_secondary_log_hash_fails_a_source(self):
        events=valid_events();events[0]['blockHash']='0x'+'aa'*32
        with patch.object(dual,'authenticate_historical',return_value=self.source):
            result=dual.run(b'fixture',factory(events))
        self.assertEqual(result['status'],'INCOMPLETE_DUAL_FAMILY_ORACLE_SOURCE_CENSUS')
        self.assertEqual(result['sources']['drpc']['status'],'INCOMPLETE_DUAL_FAMILY_SOURCE')

    def test_cross_provider_event_set_disagreement_fails_authority(self):
        with patch.object(dual,'authenticate_historical',return_value=self.source):
            result=dual.run(b'fixture',factory(valid_events(),blast=valid_events()[:-1]))
        self.assertEqual(result['status'],'MISMATCH_DUAL_FAMILY_NO_SOURCE_AUTHORITY')
        self.assertIn('PRIMARY_SECONDARY_EVENT_SET_DIFFERENCE',result['mismatch_ledger'])

    def test_one_provider_error_keeps_partial_descriptive_truth(self):
        with patch.object(dual,'authenticate_historical',return_value=self.source):
            result=dual.run(b'fixture',factory(valid_events(),blast_error='eth_getLogs'))
        self.assertEqual(result['status'],'SINGLE_SOURCE_DUAL_FAMILY_DESCRIPTIVE_ONLY')
        self.assertFalse(result['cross_endpoint_event_parity'])
        self.assertEqual(result['one_source_descriptive_summary']['total_dual_family_events'],3)
        self.assertEqual(result['sources']['blast']['status'],'INCOMPLETE_DUAL_FAMILY_SOURCE')
        self.assertFalse(result['net_capture_pnl_proven'])

    def test_hash_original_source_artifact_tamper_rejected(self):
        with self.assertRaises(ValueError):
            dual.authenticate_historical(b'invalid-fake-zip')

    def test_single_source_zero_is_time_window_scoped_not_no_market(self):
        with patch.object(dual,'authenticate_historical',return_value=self.source):
            result=dual.run(b'fixture',factory([]))
        self.assertEqual(result['status'],'TWO_ENDPOINT_DUAL_FAMILY_PINNED_CENSUS_NO_CAPTURE')
        self.assertEqual(result['two_source_descriptive_summary']['total_dual_family_events'],0)
        self.assertFalse(result['two_source_descriptive_summary']
                         ['future_frequency_or_capture_probability_calibrated'])

    def test_no_broadcast_or_unbounded_log_request_allowed(self):
        rpc=dual.old.RPC('drpc',lambda *_:None)
        with self.assertRaises(ValueError):
            rpc.call('eth_sendRawTransaction',['0xdead'])
        with self.assertRaises(ValueError):
            rpc.call('eth_getLogs',[{'address':dual.AGGREGATOR,
                'topics':['0x'+'dd'*32],
                'fromBlock':'0x1','toBlock':'0x2'}])
        self.assertEqual(rpc.calls,0)


if __name__=='__main__':
    unittest.main()
