import copy
import json
import unittest

import oracle_ws_inclusion_audit as audit
from oracle_pending_visibility_probe import AGGREGATOR, INNER_SELECTOR, FORWARD_SELECTOR


def frame(value):
    return json.dumps({'jsonrpc':'2.0', **value})


def ack(rid, result):
    return frame({'id':rid, 'result':result})


def block(n, digest):
    return {'number':hex(n), 'hash':digest,
            'parentHash':'0x'+'0f'*32, 'timestamp':hex(1791954000+n)}


def head(n, digest):
    return frame({'method':'eth_subscription',
      'params':{'subscription':'0xaaa','result':block(n,digest)}})


def sample_tx(hashval=None):
    inner=bytes.fromhex(INNER_SELECTOR)+bytes.fromhex('ff'*64)
    abi=(bytes.fromhex('00'*12+AGGREGATOR[2:])
         +(64).to_bytes(32,'big')+len(inner).to_bytes(32,'big')
         +inner+b'\0'*(-len(inner)%32))
    return {'hash':hashval or '0x'+'77'*32,
            'to':'0x'+'fa'*20,
            'input':'0x'+FORWARD_SELECTOR+abi.hex(),
            'blockHash':None, 'blockNumber':None, 'transactionIndex':None}


def pending(tx):
    return frame({'method':'eth_subscription',
      'params':{'subscription':'0xbbb','result':tx}})


def sample_log(txhash, bn, block_hash, idx=7, removed=False):
    return {'address':AGGREGATOR,'transactionHash':txhash,
        'blockHash':block_hash,'blockNumber':hex(bn),
        'logIndex':hex(idx),'removed':removed,
        'topics':[audit.NEW_TRANSMISSION_TOPIC,'0x'+f'{1:064x}'],
        'data':'0x'+(251000000000).to_bytes(32,'big').hex()+'00'*64}


def streamed_log(log):
    return frame({'method':'eth_subscription',
      'params':{'subscription':'0xccc','result':log}})


def witnessed():
    w=audit.Witness(120)
    w.incoming(ack(1,'0x1'))
    w.incoming(ack(2,'0xaaa'))
    w.incoming(ack(3,'0xbbb'))
    w.incoming(ack(4,'0xccc'))
    h1='0x'+'12'*32; h2='0x'+'34'*32
    w.incoming(head(101,h1),when_ns=1_000_000_000)
    w.incoming(pending(sample_tx()),when_ns=2_000_000_000)
    w.incoming(head(102,h2),when_ns=9_000_000_000)
    log=sample_log(sample_tx()['hash'],102,h2)
    w.incoming(streamed_log(log),when_ns=9_100_000_000)
    return w, log, h1, h2


def canonical_receipt(log):
    return {'transactionHash':log['transactionHash'],
            'blockHash':log['blockHash'],
            'blockNumber':log['blockNumber'],'status':'0x1',
            'gasUsed':'0x5208','effectiveGasPrice':'0x3b9aca00',
            'logs':[log]}


def provider(log, h1, h2):
    def fetch(method,params):
        if method=='eth_getBlockByNumber':
            n=int(params[0],16)
            if n==101:return block(101,h1)
            if n==102:return block(102,h2)
            raise ValueError('unknown height')
        if method=='eth_getLogs':return [log]
        if method=='eth_getTransactionReceipt':
            if params[0]==log['transactionHash']:return canonical_receipt(log)
            return None
        raise AssertionError('unapproved method')
    return fetch


class OracleInclusionAuditTests(unittest.TestCase):
    def test_new_transmission_subscription_valid(self):
        w=audit.Witness(120)
        w.incoming(ack(4,'0xccce'))
        self.assertTrue(w.output['oracle_logs_subscription']['accepted'])

    def test_subscribe_failure_censored(self):
        w=audit.Witness(120)
        w.incoming(frame({'id':4,'error':{'code':-32601}}))
        self.assertIn('ORACLE_LOGS_SUBSCRIPTION_REJECTED',w.output['source_limitations'])

    def test_true_pending_candidate_uses_preselected_selector(self):
        w, log, _, _=witnessed()
        self.assertIn(sample_tx()['hash'],w.pending)
        self.assertEqual(w.output['oracle_logs_distinct'],1)
        self.assertEqual(w.pending[sample_tx()['hash']]['kind'],
                         'forwarded_aggregator_report_candidate')

    def test_duplicate_log_not_double_counted(self):
        w,log,_,_=witnessed()
        w.incoming(streamed_log(log))
        self.assertEqual(w.output['oracle_logs_distinct'],1)
        self.assertEqual(w.output['oracle_logs_notifications'],2)

    def test_removed_oracle_log_not_canonical_positive(self):
        w,log,_,_=witnessed()
        orphan=copy.deepcopy(log);orphan['removed']=True
        w.incoming(streamed_log(orphan))
        self.assertEqual(w.output['oracle_logs_removed'],1)
        self.assertEqual(w.output['oracle_logs_distinct'],1)

    def test_other_topic_does_not_create_new_transmission(self):
        w,log,_,_=witnessed()
        mut=copy.deepcopy(log)
        mut['topics'][0]='0x'+'aa'*32;mut['logIndex']='0x8'
        w.incoming(streamed_log(mut))
        self.assertEqual(w.output['oracle_logs_invalid'],1)
        self.assertEqual(w.output['oracle_logs_distinct'],1)

    def test_authentic_historical_secondary_round_topic_without_price(self):
        w, primary, h1, h2 = witnessed()
        secondary = copy.deepcopy(primary)
        secondary['logIndex'] = '0x8'
        secondary['topics'][0] = audit.SECONDARY_ROUND_TOPIC
        secondary['data'] = '0x'
        w.incoming(streamed_log(secondary))
        self.assertEqual(w.output['oracle_logs_distinct'], 2)
        parsed = audit.parse_log(secondary)
        self.assertEqual(parsed['event_type'], 'SECONDARY_ROUND_ID_UPDATED')
        self.assertIsNone(parsed['primary_answer_raw'])
        self.assertEqual(parsed['event_topic0'], audit.SECONDARY_ROUND_TOPIC)

    def test_generic_ocr2_topic_rejected(self):
        w, primary, h1, h2 = witnessed()
        forged = copy.deepcopy(primary)
        forged['topics'][0] = '0xf6a97944f31ea060dfde0566e4167c1a1082551e64b60ecb14d599a9d023d451'
        forged['logIndex'] = '0x8'
        w.incoming(streamed_log(forged))
        self.assertEqual(w.output['oracle_logs_invalid'], 1)
        self.assertEqual(w.output['oracle_logs_distinct'], 1)

    def test_multi_event_same_oracle_tx_is_not_two_winners(self):
        w, primary, h1, h2 = witnessed()
        secondary = copy.deepcopy(primary)
        secondary['logIndex'] = '0x8'
        secondary['topics'][0] = audit.SECONDARY_ROUND_TOPIC
        secondary['data'] = '0x'
        w.incoming(streamed_log(secondary))
        def both(method,params):
            if method=='eth_getLogs': return [primary,secondary]
            if method=='eth_getTransactionReceipt':
                raw = canonical_receipt(primary)
                raw['logs'] = [primary,secondary]
                return raw
            return provider(primary,h1,h2)(method,params)
        result = audit.reconcile(w,audit.RPC(transport=both))
        self.assertEqual(result['status'],'PROSPECTIVE_ORACLE_LOGS_RECONCILED_NO_CAPTURE')
        self.assertEqual(result['confirmed_oracle_updates_in_ws_head_span'],2)
        self.assertEqual(result['distinct_confirmed_oracle_update_transactions'],1)
        self.assertEqual(result['oracle_update_kinds'],{
            'SECONDARY_ROUND_ID_UPDATED':1,'PRIMARY_NEW_TRANSMISSION':1})
        self.assertEqual(result['confirmed_oracle_receipts_verified'],2)
        self.assertFalse(result['profitable_competitive_capture_proven'])

    def test_mined_pending_metadata_rejected(self):
        w=audit.Witness(120)
        w.incoming(ack(1,'0x1'));w.incoming(ack(2,'0xaaa'))
        w.incoming(ack(3,'0xbbb'));w.incoming(ack(4,'0xccc'))
        t=sample_tx(); t['blockNumber']='0x65'
        w.incoming(pending(t))
        self.assertNotIn(t['hash'],w.pending)

    def test_canonical_proof_with_prior_process_pending(self):
        w,log,h1,h2=witnessed()
        result=audit.reconcile(w,audit.RPC(transport=provider(log,h1,h2)))
        self.assertEqual(result['status'],'PROSPECTIVE_ORACLE_LOGS_RECONCILED_NO_CAPTURE')
        self.assertEqual(result['confirmed_oracle_updates_in_ws_head_span'],1)
        self.assertEqual(result['confirmed_oracle_receipts_verified'],1)
        self.assertEqual(result['confirmed_oracle_with_prior_process_pending_observation'],1)
        self.assertEqual(result['oracle_pending_to_head_lead_ms'],[7000])
        self.assertFalse(result['profitable_competitive_capture_proven'])
        self.assertFalse(result['pending_first_seen_by_node_proven'])
        self.assertEqual(result['nqc_realized_pnl_usd'],'0')

    def test_canonical_oracle_not_observed_pending_is_not_private_flow_proof(self):
        w,log,h1,h2=witnessed()
        w.pending.clear()
        result=audit.reconcile(w,audit.RPC(transport=provider(log,h1,h2)))
        self.assertEqual(result['confirmed_oracle_without_prior_process_pending_observation'],1)
        self.assertFalse(result['mempool_exhaustiveness_proven'])
        self.assertEqual(result['oracle_pending_to_head_lead_ms'],[])

    def test_bad_receipt_event_invalidates_positive_proof(self):
        w,log,h1,h2=witnessed()
        altered=copy.deepcopy(log);altered['logIndex']='0x6'
        def wrong(method,params):
            if method=='eth_getTransactionReceipt':return canonical_receipt(altered)
            return provider(log,h1,h2)(method,params)
        result=audit.reconcile(w,audit.RPC(transport=wrong))
        self.assertEqual(result['confirmed_oracle_receipts_verified'],0)
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP')
        self.assertTrue(any(x.startswith('ORACLE_RECEIPT_FAILED')
                            for x in result['source_limitations']))

    def test_wrong_canonical_header_censored(self):
        w,log,h1,h2=witnessed()
        def bad(method,params):
            if method=='eth_getBlockByNumber' and params[0]==hex(101):
                return block(101,'0x'+'f1'*32)
            return provider(log,h1,h2)(method,params)
        result=audit.reconcile(w,audit.RPC(transport=bad))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP')
        self.assertTrue(any(x.startswith('CANONICAL_RECONCILIATION_FAILED')
                            for x in result['source_limitations']))

    def test_no_logs_with_valid_canonical_headers_is_informative_not_capture(self):
        w,log,h1,h2=witnessed()
        def empty(method,params):
            if method=='eth_getLogs':return []
            return provider(log,h1,h2)(method,params)
        result=audit.reconcile(w,audit.RPC(transport=empty))
        self.assertEqual(result['confirmed_oracle_updates_in_ws_head_span'],0)
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP')
        self.assertIn('WS_ORACLE_LOG_NOT_IN_CANONICAL_RESULT',result['source_limitations'])
        self.assertFalse(result['profitable_competitive_capture_proven'])

    def test_clean_zero_oracle_logs_scope_does_not_claim_market_absence(self):
        w,log,h1,h2=witnessed()
        w.stream_logs.clear()
        w.unique_log_ids.clear()
        w.output['oracle_logs_distinct']=0
        w.output['oracle_logs_notifications']=0
        def empty(method,params):
            if method=='eth_getLogs': return []
            return provider(log,h1,h2)(method,params)
        result=audit.reconcile(w,audit.RPC(transport=empty))
        self.assertEqual(result['status'],'NO_ORACLE_TRANSMISSIONS_IN_BOUNDED_CANONICAL_SPAN')
        self.assertEqual(result['confirmed_oracle_updates_in_ws_head_span'],0)
        self.assertFalse(result['mempool_exhaustiveness_proven'])

    def test_canonical_event_missing_in_ws_stream_is_not_a_clean_pass(self):
        w,log,h1,h2=witnessed()
        w.stream_logs.clear()
        w.unique_log_ids.clear()
        w.output['oracle_logs_distinct']=0
        result=audit.reconcile(w,audit.RPC(transport=provider(log,h1,h2)))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP')
        self.assertIn('CANONICAL_NEW_TRANSMISSION_MISSING_IN_WS_STREAM',
                      result['source_limitations'])

    def test_missing_required_subscription_censored(self):
        w,_,_,_=witnessed()
        w.output['oracle_logs_subscription']['accepted']=False
        result=audit.reconcile(w,audit.RPC(transport=lambda *_:None))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_PENDING_TO_CANONICAL_OVERLAP')
        self.assertEqual(result['rpc_calls_used'],0)

    def test_unsigned_unexpected_http_methods_rejected(self):
        r=audit.RPC(transport=lambda *_:None)
        for method,params in [('eth_sendRawTransaction',['0xabcd']),
                              ('eth_getLogs',[{'address':AGGREGATOR,'topics':[],
                                               'fromBlock':'0x1','toBlock':'0x2'}]),
                              ('eth_getTransactionReceipt',['0x01'])]:
            with self.subTest(method=method),self.assertRaises(ValueError):
                r.call(method,params)
        self.assertEqual(r.calls,0)

    def test_excess_getlogs_span_rejected(self):
        r=audit.RPC(transport=lambda *_:None)
        with self.assertRaises(ValueError):
            r.call('eth_getLogs',[{'address':AGGREGATOR,
                'topics':[audit.NEW_TRANSMISSION_TOPIC],
                'fromBlock':'0x1','toBlock':'0x50'}])

    def test_wrong_topic_invalid(self):
        w,log,h1,h2=witnessed()
        changed=copy.deepcopy(log);changed['topics'][0]='0x'+'23'*32
        with self.assertRaises(ValueError):
            audit.parse_log(changed)

    def test_frame_with_duplicate_json_key_rejected(self):
        w=audit.Witness(120)
        with self.assertRaises(ValueError):
            w.incoming('{"jsonrpc":"2.0","jsonrpc":"2.0","id":4}')

    def test_append_only_bounded_intake_and_false_net_rejected(self):
        w=audit.Witness(120)
        self.assertFalse(w.output['net_pnl_certified'])
        self.assertFalse(w.output['nonrecourse_native_gas_sponsor_proven'])
        self.assertFalse(w.output['commercial_score_upgrade'])
        self.assertFalse(w.output['RMC_closed'])
        self.assertEqual(w.output['nqc_realized_pnl_usd'],'0')


if __name__ == '__main__':
    unittest.main()
