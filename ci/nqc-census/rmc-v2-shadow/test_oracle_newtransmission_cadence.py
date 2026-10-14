import copy
from hashlib import sha256
import unittest

import oracle_newtransmission_cadence as cad


def h(n):
    return '0x'+sha256(str(n).encode()).hexdigest()


def hdr(n):
    return {'number':hex(n),'hash':h(n),'parentHash':h(n-1),
            'timestamp':hex(n*12+10000000)}


def event(n, answer, index=5):
    # NewTransmission first unindexed data word is the signed int192 answer.
    return {'address':cad.AGGREGATOR,'topics':[cad.NEW_TRANSMISSION_TOPIC,
            '0x'+'01'*32],
            'blockNumber':hex(n),'blockHash':h(n),
            'transactionHash':h(n*100+index),
            'logIndex':hex(index),'removed':False,
            'data':'0x'+answer.to_bytes(32,'big').hex()+'00'*64}


def transport_for(events, source='drpc', reject=None):
    def transport(method, params):
        if reject==method:
            raise OSError('RPC rate limited')
        if method=='eth_chainId':return '0x1'
        if method=='eth_getBlockByNumber':
            n=100000 if params[0]=='latest' else int(params[0],16)
            return hdr(n)
        if method=='eth_getLogs':
            lo=int(params[0]['fromBlock'],16)
            hi=int(params[0]['toBlock'],16)
            return [e for e in events if lo<=int(e['blockNumber'],16)<=hi]
        raise AssertionError('forbidden method')
    return transport


def factory(events, blast_events=None, error_on_blast=None):
    return lambda name: transport_for(
        events if name=='drpc' else
        (events if blast_events is None else blast_events),
        name, error_on_blast if name=='blast' else None)


def secondary_event(n, round_id=5, index=7):
    return {'address':cad.AGGREGATOR,
            'topics':[cad.SECONDARY_ROUND_TOPIC,'0x'+f'{round_id:064x}'],
            'blockNumber':hex(n),'blockHash':h(n),
            'transactionHash':h(n*100+index),
            'logIndex':hex(index),'removed':False,'data':'0x'}


class PinnedOracleCadenceTests(unittest.TestCase):

    def test_historical_dualaggregator_topic_constants_not_generic_ocr2(self):
        self.assertEqual(cad.SECONDARY_ROUND_TOPIC,
          '0x8d530b9ddc4b318d28fdd4c3a21fcfecece54c1a72a824f262985b99afef009b')
        self.assertEqual(cad.NEW_TRANSMISSION_TOPIC,
          '0xc797025feeeaf2cd924c99e9205ac8ec04d5cad21c41ce637a38fb6dee6016a')
        self.assertNotIn('0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451',
                         cad.EVENT_TOPICS)

    def test_secondary_round_id_emits_no_price_and_counts_as_update(self):
        events=[secondary_event(99700,3),event(99800,250000000000),
                secondary_event(99820,4)]
        result=cad.run(factory(events))
        self.assertEqual(result['status'],
           'TWO_ENDPOINT_PINNED_ORACLE_EVENT_PARITY_DESCRIPTIVE_ONLY')
        stats=result['two_endpoint_descriptive_cadence']
        self.assertEqual(stats['canonical_oracle_update_events_total'],3)
        self.assertEqual(stats['canonical_secondary_round_events'],2)
        self.assertEqual(stats['canonical_new_transmission_events'],1)
        self.assertEqual(stats['price_direction_primary_only_bps'],[])
        self.assertFalse(stats['secondary_event_contains_price_value'])

    def test_secondary_payload_must_be_empty_and_topic_exact(self):
        log=secondary_event(99800,5)
        clean=cad.canonical_event(log,99800,99800)
        self.assertEqual(clean['event_type'],'SECONDARY_ROUND_ID_UPDATED')
        self.assertIsNone(clean['answer_raw'])
        invalid=copy.deepcopy(log)
        invalid['data']='0x00'
        with self.assertRaises(ValueError):
            cad.canonical_event(invalid,99800,99800)
        wrong=copy.deepcopy(log)
        wrong['topics'][0]='0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451'
        with self.assertRaises(ValueError):
            cad.canonical_event(wrong,99800,99800)

    def test_both_endpoint_parity_and_arrival_interval(self):
        # tip 100000, selected stable end 99984
        events=[event(99700,250000000000),event(99800,247500000000)]
        result=cad.run(factory(events))
        self.assertEqual(result['status'],
           'TWO_ENDPOINT_PINNED_ORACLE_EVENT_PARITY_DESCRIPTIVE_ONLY')
        self.assertTrue(result['cross_endpoint_event_parity'])
        self.assertEqual(result['first']['number'],99265)
        self.assertEqual(result['last']['number'],99984)
        self.assertEqual(result['two_endpoint_descriptive_cadence']
                         ['median_interarrival_seconds'],1200)
        self.assertEqual(result['two_endpoint_descriptive_cadence']
                         ['downward_changes_of_at_least_50bps'],1)
        self.assertEqual(result['two_endpoint_descriptive_cadence']
                         ['downward_changes_of_at_least_100bps'],1)
        self.assertFalse(result['net_pnl_certified'])
        self.assertFalse(result['prospective_liquidation_capture_proven'])

    def test_shards_are_bounded_exhaustive_and_disjoint(self):
        shards=cad.shard_ranges(99265,99984)
        self.assertEqual(shards[0],(99265,99296))
        self.assertEqual(shards[-1],(99969,99984))
        self.assertEqual(len(shards),23)
        self.assertEqual([n for start,end in shards for n in range(start,end+1)],
                         list(range(99265,99985)))

    def test_out_of_budget_shards_rejected(self):
        for args in [(0,720),(1,721),(100,99)]:
            with self.subTest(args=args),self.assertRaises(ValueError):
                cad.shard_ranges(*args)

    def test_empty_exact_scope_is_not_revenue_or_absence_of_future_events(self):
        result=cad.run(factory([]))
        self.assertEqual(result['status'],
           'TWO_ENDPOINT_PINNED_ORACLE_EVENT_PARITY_DESCRIPTIVE_ONLY')
        self.assertEqual(result['two_endpoint_descriptive_cadence']
                         ['canonical_new_transmission_events'],0)
        self.assertFalse(result['two_endpoint_descriptive_cadence']
                         ['future_arrival_rate_calibrated'])

    def test_one_endpoint_failure_yields_incomplete_not_zero_events(self):
        e=[event(99800,245000000000)]
        result=cad.run(factory(e,error_on_blast='eth_getLogs'))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_CADENCE_CENSUS')
        self.assertFalse(result['cross_endpoint_event_parity'])
        self.assertEqual(len(result['sources']['drpc']['events']),1)
        self.assertEqual(result['sources']['blast']['status'],'INCOMPLETE_SOURCE')

    def test_cross_endpoint_log_price_mismatch_detected(self):
        e=[event(99800,245000000000)]
        b=[event(99800,246000000000)]
        result=cad.run(factory(e,blast_events=b))
        self.assertEqual(result['status'],'MISMATCH_NO_EVENT_AUTHORITY')
        self.assertEqual(result['source_mismatch_ledger'][0]['kind'],'EVENT_SET_DIFFERENCE')

    def test_malformed_oracle_price_event_rejected(self):
        e=event(99800,250000000000)
        mutations=[]
        m=copy.deepcopy(e);m['address']='0x'+'00'*20;mutations.append(m)
        m=copy.deepcopy(e);m['topics'][0]='0x'+'ab'*32;mutations.append(m)
        m=copy.deepcopy(e);m['removed']=True;mutations.append(m)
        m=copy.deepcopy(e);m['data']='0x';mutations.append(m)
        m=copy.deepcopy(e);m['data']='0x'+(0).to_bytes(32,'big').hex();mutations.append(m)
        m=copy.deepcopy(e);m['blockNumber']=hex(100000);mutations.append(m)
        for m in mutations:
            with self.subTest(m=m),self.assertRaises(ValueError):
                cad.canonical_event(m,99700,99900)

    def test_block_hash_drift_rejects_forged_event(self):
        e=event(99800,245000000000)
        e['blockHash']='0x'+'ff'*32
        result=cad.run(factory([e]))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_CADENCE_CENSUS')
        self.assertEqual(result['sources']['drpc']['status'],'INCOMPLETE_SOURCE')

    def test_duplicate_oracle_log_identity_rejected(self):
        e=event(99800,245000000000)
        result=cad.run(factory([e,copy.deepcopy(e)]))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_CADENCE_CENSUS')

    def test_rpc_forbids_writes_and_unbounded_log_scans(self):
        rpc=cad.RPC('drpc',lambda *_:None)
        with self.assertRaises(ValueError):
            rpc.call('eth_sendRawTransaction',['0xdeadbeef'])
        with self.assertRaises(ValueError):
            rpc.call('eth_getLogs',[{'address':cad.AGGREGATOR,
              'topics':[cad.NEW_TRANSMISSION_TOPIC],'fromBlock':'0x1','toBlock':'0x100'}])
        self.assertEqual(rpc.calls,0)

    def test_wrong_rpc_chain_is_not_truth(self):
        def wrong(method,params):
            if method=='eth_chainId':return '0x89'
            return hdr(100000)
        result=cad.run(lambda name:wrong)
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_CADENCE_CENSUS')
        self.assertEqual(result['source_mismatch_ledger'][0]['kind'],'ANCHOR_OR_QUERY_FAILURE')

    def test_cadence_requires_trusted_monotonic_times(self):
        e=[{'block_number':3,'block_hash':h(3),'tx_hash':h(3),
            'log_index':1,'answer_raw':100,'block_timestamp':200,
            'event_data_sha256':'00'*32},
           {'block_number':4,'block_hash':h(4),'tx_hash':h(4),
            'log_index':1,'answer_raw':90,'block_timestamp':100,
            'event_data_sha256':'11'*32}]
        with self.assertRaises(ValueError):
            cad.cadence(e,1,300)


if __name__=='__main__':
    unittest.main()
