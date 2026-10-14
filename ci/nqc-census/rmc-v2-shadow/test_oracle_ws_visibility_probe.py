import copy
import json
import unittest

import oracle_ws_visibility_probe as ws
from oracle_pending_visibility_probe import AGGREGATOR, FORWARD_SELECTOR, INNER_SELECTOR


def msg(value):
    return json.dumps({'jsonrpc': '2.0', **value})


def response(rid, result):
    return msg({'id': rid, 'result': result})


def subscribed():
    r = ws.report_template()
    ws.handle_rpc_message(r, response(1, '0x1'))
    ws.handle_rpc_message(r, response(2, '0xaaa1'))
    ws.handle_rpc_message(r, response(3, '0xbbb2'))
    return r


def head(number=26190000):
    return msg({'method': 'eth_subscription',
                'params': {'subscription': '0xaaa1', 'result': {
                    'number': hex(number), 'hash': '0x' + '12'*32,
                    'parentHash': '0x'+'34'*32, 'timestamp': '0x6a000000'}}})


def pending(tx):
    return msg({'method': 'eth_subscription',
                'params': {'subscription': '0xbbb2', 'result': tx}})


def oracle_tx(mode='forward'):
    inner = bytes.fromhex(INNER_SELECTOR) + bytes.fromhex('51'*64)
    if mode == 'direct':
        address=AGGREGATOR
        data='0x'+inner.hex()
    else:
        address='0x'+'ab'*20
        raw=(bytes.fromhex('00'*12+AGGREGATOR[2:])
             +(64).to_bytes(32,'big')
             +len(inner).to_bytes(32,'big')
             +inner+b'\0'*(-len(inner)%32))
        data='0x'+FORWARD_SELECTOR+raw.hex()
    return {'hash':'0x'+'ac'*32,'to':address, 'input':data,
            'blockHash':None,'blockNumber':None,'transactionIndex':None}


class WsPendingSignalTests(unittest.TestCase):
    def test_handshake_chain_and_both_subscriptions(self):
        r=subscribed()
        self.assertTrue(r['chain_id_verified'])
        self.assertTrue(r['subscriptions']['newHeads']['accepted'])
        self.assertTrue(r['subscriptions']['drpc_pendingTransactions']['accepted'])

    def test_wrong_chain_rejected_as_source_unavailable(self):
        r=ws.report_template()
        ws.handle_rpc_message(r,response(1,'0x89'))
        ws.handle_rpc_message(r,response(2,'0xabc'))
        ws.handle_rpc_message(r,response(3,'0xdef'))
        self.assertEqual(ws.conclude(r)['status'],'SOURCE_SUBSCRIPTION_OR_CHAIN_UNAVAILABLE')

    def test_pending_subscription_error_is_not_success(self):
        r=ws.report_template()
        ws.handle_rpc_message(r, response(1,'0x1'))
        ws.handle_rpc_message(r,response(2,'0x123'))
        ws.handle_rpc_message(r,msg({'id':3,'error':{'code':-32601,'message':'unsupported'}}))
        self.assertEqual(ws.conclude(r)['status'],'SOURCE_SUBSCRIPTION_OR_CHAIN_UNAVAILABLE')
        self.assertEqual(r['subscription_or_rpc_errors'][0]['kind'],'SUBSCRIPTION_REJECTED')

    def test_unsupported_hash_only_censored(self):
        r=subscribed()
        ws.handle_rpc_message(r, head(), now='2026-10-13T22:00:00Z')
        ws.handle_rpc_message(r,pending('0x'+'ac'*32))
        self.assertEqual(ws.conclude(r)['status'],'FULL_PENDING_TX_OBJECTS_NOT_SUPPORTED')

    def test_oracle_candidate_first_process_observation_unconfirmed(self):
        r=subscribed()
        ws.handle_rpc_message(r,head(),now='2026-10-13T22:01:00Z')
        ws.handle_rpc_message(r,pending(oracle_tx()),now='2026-10-13T22:01:01Z')
        self.assertEqual(r['candidate_count_total'],1)
        c=r['candidate_matches'][0]
        self.assertEqual(c['observed_head_number'],26190000)
        self.assertEqual(c['first_observed_by_this_process_utc'],'2026-10-13T22:01:01Z')
        self.assertTrue(c['first_seen_by_node_unproven'])
        self.assertEqual(ws.conclude(r)['status'],'PENDING_ETH_USD_CANDIDATE_UNCONFIRMED')
        self.assertFalse(r['observed_before_canonical_inclusion_proven'])
        self.assertFalse(r['prospective_capture_proven'])

    def test_direct_aggregator_report(self):
        r=subscribed()
        ws.handle_rpc_message(r,head())
        ws.handle_rpc_message(r,pending(oracle_tx('direct')))
        self.assertEqual(r['candidate_matches'][0]['kind'],'direct_aggregator_report_candidate')

    def test_non_oracle_pending_tx_no_false_causality(self):
        r=subscribed()
        ws.handle_rpc_message(r,head())
        tx=oracle_tx(); tx['to']='0x'+'98'*20;tx['input']='0xdeadbeef'
        ws.handle_rpc_message(r,pending(tx))
        self.assertEqual(r['pending_full_tx_objects_valid'],1)
        self.assertEqual(ws.conclude(r)['status'],
                         'NO_ORACLE_CANDIDATE_IN_BOUNDED_WS_STREAM_NOT_ABSENCE')

    def test_mined_metadata_never_admitted(self):
        r=subscribed()
        ws.handle_rpc_message(r,head())
        tx=oracle_tx();tx['blockNumber']='0x1901'
        ws.handle_rpc_message(r,pending(tx))
        self.assertEqual(r['candidate_count_total'],0)
        self.assertEqual(r['pending_invalid_tx_objects'],1)

    def test_unapproved_sub_id_censored(self):
        r=subscribed()
        frame=msg({'method':'eth_subscription',
                   'params':{'subscription':'0x999','result':oracle_tx()}})
        ws.handle_rpc_message(r,frame)
        self.assertEqual(r['candidate_count_total'],0)
        self.assertEqual(r['pending_invalid_tx_objects'],1)

    def test_duplicate_json_keys_rejected(self):
        r=subscribed()
        with self.assertRaises(ValueError):
            ws.handle_rpc_message(r,'{"jsonrpc":"2.0","jsonrpc":"2.0","id":1}')

    def test_rpc_call_is_never_a_transaction_submission(self):
        r=subscribed()
        with self.assertRaises(ValueError):
            ws.handle_rpc_message(r,msg({'id':6,'result':'0x123'}))

    def test_subscription_error_does_not_claim_supported_feed(self):
        r=ws.report_template()
        ws.handle_rpc_message(r,response(1,'0x1'))
        ws.handle_rpc_message(r,response(2,'0xbeef'))
        ws.handle_rpc_message(r,msg({'id':3,'error':{'code':-32000,'message':'quota'}}))
        self.assertFalse(r['subscriptions']['drpc_pendingTransactions']['accepted'])

    def test_head_invalid_hash_is_rejected(self):
        r=subscribed()
        invalid=head().replace('0x'+'12'*32,'0xdead')
        with self.assertRaises(ValueError):
            ws.handle_rpc_message(r,invalid)

    def test_pending_bad_oracle_abi_cannot_match(self):
        r=subscribed()
        ws.handle_rpc_message(r,head())
        tx=oracle_tx()
        tx['input']=tx['input'][:-2]
        ws.handle_rpc_message(r,pending(tx))
        self.assertEqual(r['candidate_count_total'],0)

    def test_candidate_evidence_bounded(self):
        r=subscribed()
        ws.handle_rpc_message(r,head())
        for n in range(ws.MAX_EVIDENCE_CANDIDATES+5):
            tx=oracle_tx()
            tx['hash']='0x'+f'{n+1:064x}'
            ws.handle_rpc_message(r,pending(tx))
        self.assertEqual(r['candidate_count_total'],ws.MAX_EVIDENCE_CANDIDATES+5)
        self.assertEqual(len(r['candidate_matches']),ws.MAX_EVIDENCE_CANDIDATES)

    def test_accepted_but_idle_subscription_not_a_pass(self):
        r=subscribed()
        self.assertEqual(ws.conclude(r)['status'],'CENSORED_NO_HEAD_OR_PENDING_HEARTBEAT')

    def test_more_than_max_frame_rejected(self):
        r=subscribed()
        with self.assertRaises(ValueError):
            ws.handle_rpc_message(r,b' '* (ws.MAX_FRAME_BYTES+1))

    def test_observation_budget_and_no_claims(self):
        import asyncio
        with self.assertRaises(ws.Rejected):
            asyncio.run(ws.observe(0,100))
        with self.assertRaises(ws.Rejected):
            asyncio.run(ws.observe(90,50000))
        r=ws.report_template()
        self.assertEqual(r['nqc_realized_pnl_usd'],'0')
        self.assertFalse(r['nqc_net_pnl_certified'])
        self.assertFalse(r['commercial_score_upgrade'])
        self.assertFalse(r['RMC_closed'])


if __name__ == '__main__':
    unittest.main()
