import copy
from hashlib import sha256
import unittest

import oracle_rpc_source_capability_matrix as m


def hash_of(n):
    return '0x'+sha256(str(n).encode()).hexdigest()


def header(n):
    return {'number':hex(n),'hash':hash_of(n),'parentHash':hash_of(n-1),
            'timestamp':hex(1700000000+n*12)}


def oracle_log(n,tx,index,kind):
    primary=kind=='primary'
    return {'address':m.AGGREGATOR,
            'transactionHash':tx,'blockHash':hash_of(n),'blockNumber':hex(n),
            'logIndex':hex(index), 'removed':False,
            'topics':[m.NEW_TRANSMISSION_TOPIC if primary else m.SECONDARY_ROUND_TOPIC,
                      '0x'+'00'*31+'01'],
            'data':('0x'+(245000000000).to_bytes(32,'big').hex()+'00'*64
                    if primary else '0x')}


def corpus():
    historical=[
        oracle_log(26142067,m.HISTORICAL[0]['tx'],8,'secondary'),
        oracle_log(26149038,m.HISTORICAL[1]['tx'],17,'secondary'),
        oracle_log(26149038,m.HISTORICAL[1]['tx'],18,'primary'),
    ]
    recent=[
        oracle_log(26188834,hash_of(8810001),4,'primary'),
        oracle_log(26188850,hash_of(8810002),7,'secondary'),
    ]
    return historical,recent


def endpoint(reject_or=False,reject_secondary=False,wrong_receipt=False,
             mutate_recent=False,reject_address=False):
    past,recent=corpus()
    def request(method,params):
        if method=='eth_chainId': return '0x1'
        if method=='eth_getBlockByNumber':
            n=26188900 if params[0]=='latest' else int(params[0],16)
            return header(n)
        if method=='eth_getTransactionReceipt':
            tx=params[0]
            events=[e for e in past if e['transactionHash']==tx]
            n=int(events[0]['blockNumber'],16)
            result={'transactionHash':tx,'blockHash':hash_of(n),'blockNumber':hex(n),
                    'transactionIndex':'0x0','status':'0x1','logs':copy.deepcopy(events)}
            if wrong_receipt: result['blockHash']=hash_of(n+1)
            return result
        if method=='eth_getLogs':
            q=params[0]
            topics=q.get('topics')
            filter_topic=topics[0] if topics else None
            if filter_topic is None and reject_address: raise ValueError('HTTP_400_ADDRESS')
            if isinstance(filter_topic,list) and reject_or: raise ValueError('JSON_RPC_ERROR_-32000')
            if filter_topic==m.SECONDARY_ROUND_TOPIC and reject_secondary: raise ValueError('HTTP_400')
            lo,hi=int(q['fromBlock'],16),int(q['toBlock'],16)
            selected=[copy.deepcopy(e) for e in past+recent if
                lo<=int(e['blockNumber'],16)<=hi and
                (filter_topic is None or
                 (e['topics'][0] in filter_topic if isinstance(filter_topic,list)
                  else e['topics'][0]==filter_topic))]
            if mutate_recent:
                for e in selected:
                    if int(e['blockNumber'],16)>26188000: e['data']='0x'
            return selected
        raise AssertionError('unapproved method '+method)
    return request


class OracleSourceMatrixTests(unittest.TestCase):
    def test_historical_positive_and_exact_recent_source_parity(self):
        output=m.run(lambda name:endpoint())
        self.assertEqual(output['status'],'TWO_SOURCE_ADDRESS_ONLY_ORACLE_EVENT_PARITY')
        self.assertTrue(output['two_source_recent_parity'])
        self.assertTrue(output['two_source_positive_control_parity'])
        self.assertTrue(output['two_source_address_positive_control_parity'])
        self.assertTrue(output['two_source_address_recent_parity'])
        self.assertEqual(output['confirmed_address_recent_oracle_events'],2)
        self.assertEqual(output['confirmed_recent_oracle_update_events'],2)
        self.assertEqual(output['confirmed_recent_oracle_update_transactions'],2)
        self.assertEqual(output['recent_anchor']['first']['block'],26188821)
        self.assertEqual(output['recent_anchor']['last']['block'],26188884)
        self.assertEqual([x['status'] for x in output['providers']['drpc']
                         ['positive_controls'][0]['individual_queries']],['PARITY','PARITY'])
        self.assertEqual(output['nqc_realized_pnl_usd'],'0')
        self.assertFalse(output['prospective_detection_proven'])
        self.assertFalse(output['net_pnl_certified'])

    def test_or_query_failure_does_not_erase_single_topic_capability(self):
        output=m.run(lambda name:endpoint(reject_or=True))
        self.assertTrue(output['two_source_positive_control_parity'])
        self.assertTrue(output['two_source_recent_parity'])
        self.assertEqual(output['providers']['drpc']['positive_controls'][0]
                         ['or_query']['status'],'ERROR')
        self.assertEqual(output['confirmed_recent_oracle_update_events'],2)
        self.assertTrue(output['two_source_address_positive_control_parity'])

    def test_address_only_recovers_primary_event_when_topic_rpc_rejects(self):
        output=m.run(lambda name:endpoint(reject_or=True,
                         reject_secondary=(name=='blast')))
        self.assertTrue(output['two_source_address_positive_control_parity'])
        self.assertTrue(output['two_source_address_recent_parity'])
        self.assertEqual(output['confirmed_address_recent_oracle_events'],2)
        self.assertEqual(output['status'],'TWO_SOURCE_ADDRESS_ONLY_ORACLE_EVENT_PARITY')
        self.assertFalse(output['two_source_positive_control_parity'])

    def test_address_only_missing_source_fails_closed(self):
        out=m.run(lambda name:endpoint(reject_address=(name=='blast'),
                                      reject_secondary=(name=='blast')))
        self.assertEqual(out['status'],'INCOMPLETE_ORACLE_RPC_SOURCE_CAPABILITY')
        self.assertFalse(out['two_source_address_recent_parity'])
        self.assertIsNone(out['confirmed_address_recent_oracle_events'])

    def test_address_only_unknown_event_family_recorded_without_fake_price(self):
        n=26188834
        row=oracle_log(n,hash_of(12),14,'secondary')
        row['topics'][0]='0x'+'99'*32
        parsed=m.filter_address_logs([row],n,n)
        self.assertEqual(parsed['events'],[])
        self.assertEqual(parsed['unknown_topic_counts'],{'0x'+'99'*32:1})

    def test_historical_positive_control_must_not_be_invented(self):
        result=m.run(lambda name:endpoint(wrong_receipt=True))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_RPC_SOURCE_CAPABILITY')
        self.assertFalse(result['two_source_positive_control_parity'])

    def test_provider_error_is_not_zero_event_claim(self):
        result=m.run(lambda name:endpoint(reject_secondary=(name=='blast')))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_RPC_SOURCE_CAPABILITY')
        self.assertTrue(result['providers']['drpc']['recent_complete'])
        self.assertFalse(result['providers']['blast']['recent_complete'])
        self.assertIsNone(result['confirmed_recent_oracle_update_events'])

    def test_positive_receipt_parse_exact_two_types(self):
        past,_=corpus()
        e=m.control_receipt(endpoint()('eth_getTransactionReceipt',
                             [m.HISTORICAL[1]['tx']]),m.HISTORICAL[1]['tx'],
                             {'block':26149038,'hash':hash_of(26149038)})
        self.assertEqual({x['event_type'] for x in e},
                          {'PRIMARY_NEW_TRANSMISSION','SECONDARY_ROUND_ID_UPDATED'})

    def test_missing_oracle_receipt_event_rejected(self):
        past,_=corpus()
        receipt=endpoint()('eth_getTransactionReceipt',[m.HISTORICAL[0]['tx']])
        receipt['logs']=[]
        with self.assertRaises(ValueError):
            m.control_receipt(receipt,m.HISTORICAL[0]['tx'],
                     {'block':26142067,'hash':hash_of(26142067)})

    def test_log_topic_mismatch_rejected(self):
        row=oracle_log(26188834,hash_of(88),7,'primary')
        row['topics'][0]='0x'+'fa'*32
        with self.assertRaises(ValueError):m.filter_logs([row],26188830,26188850)

    def test_outside_range_rejected(self):
        row=oracle_log(26188834,hash_of(88),7,'primary')
        with self.assertRaises(ValueError):m.filter_logs([row],26188000,26188010)

    def test_duplicate_log_rejected(self):
        row=oracle_log(26188834,hash_of(88),7,'primary')
        with self.assertRaises(ValueError):m.filter_logs([row,row],26188800,26188850)

    def test_write_methods_and_wrong_rpc_queries_forbidden(self):
        r=m.RPC('drpc',transport=lambda *_:None)
        attempts=[
            ('eth_sendRawTransaction',['0xff']),
            ('eth_getTransactionReceipt',['0x'+'ff'*32]),
            ('eth_getLogs',[{'address':m.AGGREGATOR,'topics':[m.EVENT_TOPICS],
                  'fromBlock':'0x1','toBlock':'0x88'}]),
            ('eth_getBlockByNumber',['pending',True])]
        for method,args in attempts:
            with self.subTest(method=method),self.assertRaises(ValueError):
                r.call(method,args)
        self.assertEqual(r.calls,0)

    def test_source_error_does_not_claim_commercial_capture(self):
        result=m.run(lambda name: endpoint(reject_or=True,
                                     reject_secondary=(name=='blast')))
        self.assertFalse(result['prospective_detection_proven'])
        self.assertFalse(result['commercial_score_upgrade'])
        self.assertFalse(result['external_nonrecourse_gas_proven'])
        self.assertFalse(result['RMC_closed'])
        self.assertEqual(result['nqc_realized_pnl_usd'],'0')


if __name__=='__main__':
    unittest.main()
