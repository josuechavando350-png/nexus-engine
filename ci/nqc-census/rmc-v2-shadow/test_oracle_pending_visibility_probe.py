import copy
import json
import unittest

import oracle_pending_visibility_probe as p


def latest(n=26190000, digest=None):
    h=digest or '0x'+'12'*32
    return {'number':hex(n),'hash':h,'parentHash':'0x'+'34'*32,
            'timestamp':'0x6a000000','transactions':[]}


def pending(head=None, txs=None):
    head=head or latest()
    return {'number':hex(int(head['number'],16)+1), 'hash':None,
            'parentHash':head['hash'],'transactions':txs if txs is not None else []}


def oracle_tx(kind='forward', selector=None):
    inner=bytes.fromhex(selector or p.INNER_SELECTOR)+bytes.fromhex('42'*64)
    if kind=='direct':
        data='0x'+inner.hex()
        dest=p.AGGREGATOR
    else:
        fill=inner+b'\x00'*(-len(inner)%32)
        body=(bytes.fromhex('00'*12+p.AGGREGATOR[2:])+
              (64).to_bytes(32,'big')+
              len(inner).to_bytes(32,'big')+fill)
        data='0x'+p.FORWARD_SELECTOR+body.hex()
        dest='0x'+'bb'*20
    return {'hash':'0x'+'ab'*32,'to':dest,'input':data,
            'blockHash':None,'blockNumber':None,'transactionIndex':None}


class OraclePendingTests(unittest.TestCase):
    def test_forward_aggregator_target(self):
        result=p.parse_oracle_payload(oracle_tx())
        self.assertEqual(result['target'],p.AGGREGATOR)
        self.assertEqual(result['kind'],'forwarded_aggregator_report_candidate')

    def test_direct_aggregator_target(self):
        self.assertEqual(p.parse_oracle_payload(oracle_tx('direct'))['kind'],
                         'direct_aggregator_report_candidate')

    def test_primary_transmit_forwarded_is_detected(self):
        tx=oracle_tx(selector=p.PRIMARY_TRANSMIT_SELECTOR)
        parsed=p.parse_oracle_payload(tx)
        self.assertEqual(parsed['inner_method_id'],'0x'+p.PRIMARY_TRANSMIT_SELECTOR)
        self.assertEqual(parsed['transmission_path'],'primary')
        self.assertEqual(parsed['kind'],'forwarded_aggregator_report_candidate')

    def test_primary_transmit_direct_is_detected(self):
        tx=oracle_tx('direct',selector=p.PRIMARY_TRANSMIT_SELECTOR)
        parsed=p.parse_oracle_payload(tx)
        self.assertEqual(parsed['inner_method_id'],'0x'+p.PRIMARY_TRANSMIT_SELECTOR)
        self.assertEqual(parsed['transmission_path'],'primary')
        self.assertEqual(parsed['kind'],'direct_aggregator_report_candidate')

    def test_only_source_authenticated_report_selectors_admitted(self):
        self.assertEqual(p.REPORT_SELECTORS,{'ba0cb29e','b1dc65a4'})
        tx=oracle_tx(selector='deadbeef')
        self.assertIsNone(p.parse_oracle_payload(tx))

    def test_non_oracle_target_is_ignored(self):
        tx=oracle_tx()
        tx['input']=tx['input'].replace(p.AGGREGATOR[2:],'aa'*20)
        self.assertIsNone(p.parse_oracle_payload(tx))

    def test_non_report_selector_ignored(self):
        tx=oracle_tx()
        tx['input']=tx['input'].replace(p.INNER_SELECTOR,'deadbeef')
        self.assertIsNone(p.parse_oracle_payload(tx))

    def test_malformed_forward_rejected(self):
        tx=oracle_tx()
        tx['input']=tx['input'][:-2]
        with self.assertRaises(p.Rejected):p.parse_oracle_payload(tx)

    def test_offset_mutation_rejected(self):
        tx=oracle_tx()
        raw=bytearray.fromhex(tx['input'][2:])
        raw[4+63]=96
        tx['input']='0x'+raw.hex()
        with self.assertRaises(p.Rejected):p.parse_oracle_payload(tx)

    def test_nonzero_padding_rejected(self):
        tx=oracle_tx()
        tx['input']=tx['input'][:-2]+'ff'
        with self.assertRaises(p.Rejected):p.parse_oracle_payload(tx)

    def test_duplicate_json_and_nan_rejected(self):
        for raw in (b'{"a":1,"a":2}',b'{"a":NaN}'):
            with self.assertRaises(p.Rejected):p.strict_json(raw)

    def test_no_target_not_market_absence(self):
        a=p.classify_view(latest(),pending(),latest())
        self.assertEqual(a['status'],'NO_TARGET_IN_BOUNDED_PENDING_VIEW_NOT_MARKET_ABSENCE')
        self.assertEqual(a['pending_transactions_count'],0)

    def test_positive_pending_candidate_is_not_capture(self):
        a=p.classify_view(latest(),pending(txs=[oracle_tx()]),latest())
        self.assertEqual(a['status'],'PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW')
        self.assertEqual(len(a['candidates']),1)

    def test_mined_block_substitution_censored(self):
        b=pending();b['hash']='0x'+'56'*32
        self.assertEqual(p.classify_view(latest(),b,latest())['status'],
                         'CENSORED_PENDING_NOT_UNMINED_VIEW')

    def test_head_movement_censored(self):
        self.assertEqual(p.classify_view(latest(),pending(),latest(26190001,
                         '0x'+'33'*32))['status'],'CENSORED_HEAD_MOVED_DURING_RPC_READ')

    def test_wrong_pending_parent_censored(self):
        b=pending();b['parentHash']='0x'+'ff'*32
        self.assertEqual(p.classify_view(latest(),b,latest())['status'],
                         'CENSORED_PENDING_PARENT_NOT_CURRENT_TIP')

    def test_hash_only_pending_censored(self):
        a=p.classify_view(latest(),pending(txs=['0x'+'aa'*32]),latest())
        self.assertEqual(a['status'],'CENSORED_PENDING_TRANSACTION_OBJECTS_MISSING')

    def test_pending_mined_metadata_is_not_preinclusion(self):
        tx=oracle_tx();tx['blockNumber']=hex(26190001)
        a=p.classify_view(latest(),pending(txs=[tx]),latest())
        self.assertEqual(a['status'],'CENSORED_MALFORMED_PENDING_TXS')
        self.assertEqual(a['candidates'],[])

    def test_duplicate_pending_hash_censored(self):
        tx=oracle_tx()
        a=p.classify_view(latest(),pending(txs=[tx,copy.deepcopy(tx)]),latest())
        self.assertEqual(a['status'],'PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW')
        self.assertEqual(a['invalid_candidates'],1)

    def test_rpc_allowlist_rejects_transmit_and_bad_tags(self):
        r=p.RPC('drpc',lambda url,method,params:None)
        for method,args in (('eth_sendRawTransaction',['0xabcd']),
                            ('eth_getBlockByNumber',['latest',True]),
                            ('eth_call',[{}])):
            with self.subTest(method=method),self.assertRaises(p.Rejected):
                r.call(method,args)

    def test_rpc_only_accepts_known_source(self):
        old=p.PROVIDERS['drpc']
        p.PROVIDERS['drpc']=('wrong','https://example.net')
        try:
            with self.assertRaises(p.Rejected):p.RPC('drpc')
        finally:
            p.PROVIDERS['drpc']=old

    def test_sample_receipt_null_is_not_a_win(self):
        def source(_url,method,params):
            if method=='eth_getBlockByNumber':
                return latest() if params==['latest',False] else pending(txs=[oracle_tx()])
            if method=='eth_getTransactionReceipt': return None
            raise AssertionError(method)
        r=p.RPC('drpc',source)
        result=r.sample()
        self.assertEqual(result['status'],'PENDING_ORACLE_CANDIDATES_IN_SINGLE_RPC_VIEW')
        self.assertTrue(result['candidates'][0]['receipt_null_at_probe'])

    def test_receipt_race_censors(self):
        def source(_url,method,params):
            if method=='eth_getBlockByNumber':
                return latest() if params==['latest',False] else pending(txs=[oracle_tx()])
            if method=='eth_getTransactionReceipt':return {'status':'0x1'}
            raise AssertionError(method)
        r=p.RPC('drpc',source)
        result=r.sample()
        self.assertEqual(result['status'],'CENSORED_MINED_RECEIPT_RACE')
        self.assertFalse(result['candidates'][0]['receipt_null_at_probe'])

    def test_probe_negative_not_promoted_to_capture(self):
        def transport(_):
            def source(_url,method,params):
                if method=='eth_chainId':return '0x1'
                return latest() if params==['latest',False] else pending()
            return source
        result=p.probe(1,0,transport_factory=transport,sleeper=lambda x:None)
        self.assertEqual(result['status'],'BOUNDED_OBSERVATION_NO_TARGET_NOT_EXHAUSTIVE')
        self.assertFalse(result['prospective_capture_proven'])
        self.assertFalse(result['pending_channel_exhaustive'])
        self.assertEqual(result['nqc_realized_pnl_usd'],'0')

    def test_degraded_endpoint_not_zero_opportunities(self):
        def transport(provider):
            def source(_url,method,params):
                if provider=='blast':raise OSError('429 rate limited')
                if method=='eth_chainId':return '0x1'
                return latest() if params==['latest',False] else pending()
            return source
        result=p.probe(1,0,transport_factory=transport,sleeper=lambda x:None)
        self.assertEqual(result['status'],'INCOMPLETE_PENDING_SOURCE_CAPABILITY')
        self.assertEqual(result['providers']['blast']['status'],'SOURCE_FAILURE_CENSORED')
        self.assertFalse(result['prospective_capture_proven'])

    def test_two_provider_overlap_remains_uncalibrated(self):
        def transport(_):
            def source(_url,method,params):
                if method=='eth_chainId':return '0x1'
                if method=='eth_getTransactionReceipt':return None
                return latest() if params==['latest',False] else pending(txs=[oracle_tx()])
            return source
        result=p.probe(1,0,transport_factory=transport,sleeper=lambda x:None)
        self.assertEqual(result['status'],'PENDING_ORACLE_REPORT_OBSERVED_UNCALIBRATED')
        self.assertEqual(result['cross_provider_overlap_hashes'],[oracle_tx()['hash']])
        self.assertFalse(result['prospective_capture_proven'])
        self.assertFalse(result['mempool_first_seen_time_proven'])

    def test_out_of_scope_parameters_and_sampling_rejected(self):
        for args in [(0,0),(7,0),(1,-1),(1,31),(True,0)]:
            with self.subTest(args=args),self.assertRaises(p.Rejected):
                p.probe(*args,transport_factory=lambda _:lambda *a:None,sleeper=lambda x:None)


    def test_interleaves_providers_for_temporal_comparison(self):
        order=[]
        def transport(provider):
            def source(_url,method,params):
                if method=='eth_chainId': return '0x1'
                if params==['pending',True]:
                    order.append(provider)
                    return pending()
                return latest()
            return source
        result=p.probe(2,0,transport_factory=transport,sleeper=lambda _:None)
        self.assertEqual(order,['drpc','blast','drpc','blast'])
        self.assertEqual(result['valid_pending_snapshots_per_provider'],{'drpc':2,'blast':2})
        self.assertEqual(result['pending_transaction_objects_examined_per_provider'],
                         {'drpc':0,'blast':0})
        self.assertEqual(result['polling_order'],'round_robin_drpc_then_blast_each_round')

    def test_degraded_source_preserves_useful_other_source_counts(self):
        def transport(provider):
            def source(_url,method,params):
                if provider=='blast': raise OSError('HTTP 429')
                if method=='eth_chainId': return '0x1'
                if params==['pending',True]: return pending(txs=[oracle_tx('direct')])
                if method=='eth_getTransactionReceipt': return None
                return latest()
            return source
        result=p.probe(2,0,transport_factory=transport,sleeper=lambda _:None)
        self.assertEqual(result['status'],'PENDING_ORACLE_REPORT_OBSERVED_UNCALIBRATED')
        self.assertEqual(result['valid_pending_snapshots_per_provider'],{'drpc':2,'blast':0})
        self.assertEqual(result['providers']['blast']['status'],'SOURCE_FAILURE_CENSORED')
        self.assertFalse(result['prospective_capture_proven'])


if __name__=='__main__':
    unittest.main()
