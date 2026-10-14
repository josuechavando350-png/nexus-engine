import copy
from hashlib import sha256
from unittest.mock import patch
import unittest

import oracle_round_transaction_order as o
from oracle_dual_event_family_census import NEW_TRANSMISSION_TOPIC,SECONDARY_ROUND_TOPIC


def h(n):
    return '0x'+sha256(str(n).encode()).hexdigest()


def header(n):
    return {'number':hex(n),'hash':h(n),
            'parentHash':h(n-1),'timestamp':hex(10000000+n*12)}


def proof_event(round_id,block,family,log_index,tx_index,answer=250000000000):
    primary=family=='PRIMARY_NEW_TRANSMISSION'
    topic=NEW_TRANSMISSION_TOPIC if primary else SECONDARY_ROUND_TOPIC
    data=('0x'+answer.to_bytes(32,'big').hex()+'00'*(7*32)) if primary else '0x'
    raw={'address':o.AGGREGATOR,'topics':[topic,
        '0x'+round_id.to_bytes(32,'big').hex()],
        'blockNumber':hex(block),'blockHash':h(block),
        'transactionHash':h(block*100+tx_index),
        'logIndex':hex(log_index),'removed':False,'data':data}
    item=o.parse_event(raw,block,block)
    item['block_timestamp']=int(header(block)['timestamp'],16)
    item['_receipt_log']=raw
    item['_tx_idx']=tx_index
    return item


def fixture():
    pairs=[
        proof_event(24872,20000,'PRIMARY_NEW_TRANSMISSION',1,4),
        proof_event(24872,20001,'SECONDARY_ROUND_ID_UPDATED',2,1),
        proof_event(24873,20300,'PRIMARY_NEW_TRANSMISSION',5,2),
        proof_event(24873,20300,'SECONDARY_ROUND_ID_UPDATED',7,6),
    ]
    return sorted(pairs,key=lambda x:(x['block_number'],x['log_index']))


def receipt(event):
    return {'transactionHash':event['transaction_hash'],
        'blockNumber':hex(event['block_number']),
        'blockHash':event['block_hash'],
        'transactionIndex':hex(event['_tx_idx']),
        'status':'0x1','gasUsed':'0x5208',
        'effectiveGasPrice':'0x77359400',
        'logs':[event['_receipt_log']]}


def transport(events,invalid=None):
    txs={e['transaction_hash']:e for e in events}
    def call(method,params):
        if method=='eth_chainId':return '0x1'
        if method=='eth_getBlockByNumber':
            return header(int(params[0],16))
        if method=='eth_getTransactionReceipt':
            e=txs[params[0]]
            r=receipt(e)
            if invalid=='status':r['status']='0x0'
            if invalid=='hash':r['blockHash']='0x'+'ff'*32
            if invalid=='event_data':r['logs'][0]['data']='0x00'
            return r
        raise AssertionError('unexpected method')
    return call


class OracleRoundOrderingTests(unittest.TestCase):
    def test_rounds_group_by_exact_uint32(self):
        e=fixture()
        # Fake fixture extra metadata is outside producer source identity.
        groups=o.group_rounds(e)
        self.assertEqual(set(groups),{24872,24873})
        self.assertEqual(len(groups[24873]['SECONDARY_ROUND_ID_UPDATED']),1)

    def test_producer_hash_tampering_rejected(self):
        with self.assertRaises(ValueError):o.auth_zip(b'not valid')

    def test_two_endpoint_receipt_parity_and_order(self):
        events=fixture()
        clean=[{k:v for k,v in e.items() if not k.startswith('_')}
               for e in events]
        with patch.object(o,'auth_zip',return_value=({},clean,{})):
            report=o.run(b'fixture',lambda _name:transport(events))
        self.assertEqual(report['status'],'TWO_ENDPOINT_ORACLE_ROUND_ORDER_RECONCILED_NO_CAPTURE')
        self.assertTrue(report['cross_endpoint_receipt_parity'])
        self.assertEqual(len(report['rounds']),2)
        one,two=report['rounds']
        self.assertEqual(one['block_height_difference_secondary_minus_primary'],1)
        self.assertEqual(one['block_timestamp_difference_seconds'],12)
        self.assertEqual(one['ordering'],'SECONDARY_AFTER_PRIMARY_FUTURE_BLOCK')
        self.assertEqual(two['block_height_difference_secondary_minus_primary'],0)
        self.assertEqual(two['ordering'],'SECONDARY_AFTER_PRIMARY_SAME_BLOCK')
        self.assertFalse(report['profitable_aave_liquidation_capture_proven'])
        self.assertFalse(report['available_same_block_ordering_proven'])
        self.assertEqual(report['nqc_realized_pnl_usd'],'0')

    def test_wrong_or_reverted_receipt_rejected(self):
        events=fixture()
        e=events[0]
        for kind in ('status','hash','event_data'):
            raw=transport(events,kind)('eth_getTransactionReceipt',[e['transaction_hash']])
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                o.verify_receipt(raw,e,
                    o.cadence.canonical_header(header(e['block_number']),e['block_number']))

    def test_one_provider_failure_is_partial_evidence(self):
        events=fixture()
        clean=[{k:v for k,v in e.items() if not k.startswith('_')}
               for e in events]
        def sources(name):
            if name=='blast':return lambda *_: (_ for _ in ()).throw(OSError('RPC 400'))
            return transport(events)
        with patch.object(o,'auth_zip',return_value=({},clean,{})):
            report=o.run(b'fixture',sources)
        self.assertEqual(report['status'],'SINGLE_ENDPOINT_ROUND_ORDER_DESCRIPTIVE_ONLY')
        self.assertFalse(report['cross_endpoint_receipt_parity'])
        self.assertEqual(len(report['rounds']),2)

    def test_duplicate_or_missing_round_family_rejected(self):
        e=fixture()
        verified=[{
            'round_id':r['round_id'],'event_family':r['event_family'],
            'tx_hash':r['transaction_hash'],'block':r['block_number'],
            'transaction_index':r['_tx_idx'],'timestamp':r['block_timestamp']
        } for r in e]
        for candidate in (verified[:-1],verified+[copy.deepcopy(verified[0])]):
            with self.assertRaises(ValueError):o.round_pairs(candidate)

    def test_false_gas_or_wrong_emitter_is_rejected(self):
        e=fixture()[0]
        r=receipt(e)
        r['gasUsed']='0x0'
        with self.assertRaises(ValueError):
            o.verify_receipt(r,e,o.cadence.canonical_header(
                header(e['block_number']),e['block_number']))
        r=receipt(e)
        r['logs'][0]['address']='0x'+'ee'*20
        with self.assertRaises(ValueError):
            o.verify_receipt(r,e,o.cadence.canonical_header(
                header(e['block_number']),e['block_number']))

    def test_readonly_call_contract_rejects_bad_parameters(self):
        rpc=o.RPC('drpc',lambda *_:None)
        for method,params in (
            ('eth_sendRawTransaction',['0xabcd']),
            ('eth_getTransactionReceipt',['0x'+'ff'*32]),
            ('eth_getBlockByNumber',['latest',False])):
            with self.subTest(method=method),self.assertRaises(ValueError):
                rpc.call(method,params,allowed_hashes=set(),allowed_blocks=set())
        self.assertEqual(rpc.calls,0)

    def test_no_commercial_claims_in_synthetic_consensus(self):
        events=fixture()
        clean=[{k:v for k,v in e.items() if not k.startswith('_')} for e in events]
        with patch.object(o,'auth_zip',return_value=({},clean,{})):
            r=o.run(b'fixture',lambda _:transport(events))
        for key in ('pending_first_seen_by_any_operator_proven',
                    'available_same_block_ordering_proven',
                    'profitable_aave_liquidation_capture_proven',
                    'native_gas_external_nonrecourse_proven',
                    'RMC_closed','P2_shadow_certified','canary_live_authorized',
                    'commercial_score_upgrade'):
            self.assertFalse(r[key])


if __name__=='__main__':
    unittest.main()
