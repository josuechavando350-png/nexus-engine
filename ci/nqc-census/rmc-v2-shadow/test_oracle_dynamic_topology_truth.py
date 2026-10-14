import copy
from hashlib import sha256
import unittest

import oracle_dynamic_topology_truth as truth


def h(n):
    return '0x'+sha256(str(n).encode()).hexdigest()


def header(n):
    return {'number':hex(n),'hash':h(n),
            'parentHash':h(n-1),
            'timestamp':hex(1700000000+n*12)}


def word(value):
    return '0x'+value.to_bytes(32,'big').hex()


def address_word(address):
    return '0x'+('00'*12)+address[2:]


def round_data():
    values=(100,251000000000,1700000010,1700000011,100)
    return '0x'+''.join(x.to_bytes(32,'big').hex() for x in values)


def receipt(pin,topic=None):
    topic=topic or truth.NEW_TRANSMISSION_TOPIC
    return {'transactionHash':pin['tx'],
            'blockNumber':hex(pin['block']),
            'blockHash':h(pin['block']),
            'transactionIndex':'0x0','status':'0x1',
            'logs':[{'address':truth.AGGREGATOR,
                     'topics':[topic,'0x'+'ff'*32],
                     'logIndex':'0x2','data':'0x'+'ff'*32}]}


def fake_source(aggregator=truth.AGGREGATOR,historical_topic=None,
                bad_chain=False):
    provider='0x'+'11'*20
    oracle='0x'+'22'*20
    price_source='0x'+'33'*20
    def call(method,params):
        if method=='eth_chainId':return '0x89' if bad_chain else '0x1'
        if method=='eth_getBlockByNumber':
            n=26190000 if params[0]=='latest' else int(params[0],16)
            return header(n)
        if method=='eth_getTransactionReceipt':
            pin=next(x for x in truth.HISTORICAL if x['tx']==params[0])
            return receipt(pin,historical_topic)
        if method=='eth_call':
            selector=params[0]['data'][:10]
            result={
                truth.SELECTORS['addresses_provider']:address_word(provider),
                truth.SELECTORS['get_price_oracle']:address_word(oracle),
                truth.SELECTORS['get_source_of_asset']:address_word(price_source),
                truth.SELECTORS['asset_price']:word(251000000000),
                truth.SELECTORS['aggregator']:address_word(aggregator),
                truth.SELECTORS['decimals']:word(8),
                truth.SELECTORS['round']:round_data(),
            }
            return result[selector]
        raise AssertionError('unknown method')
    return call


class OracleTopologyTests(unittest.TestCase):
    def test_aave_current_topology_exact_historical_positives_two_providers(self):
        result=truth.run(lambda _ :fake_source())
        self.assertEqual(result['status'],'TWO_ENDPOINT_CURRENT_AAVE_ORACLE_TOPOLOGY_PARITY_ONLY')
        self.assertTrue(result['cross_source_parity'])
        self.assertEqual(result['anchor']['block'],26189984)
        for provider in ('drpc','blast'):
            v=result['sources'][provider]
            self.assertTrue(v['topology']['static_target_matches'])
            self.assertEqual(v['topology']['source_decimals'],8)
            self.assertEqual(len(v['historical_receipts']),2)
            self.assertTrue(all(x['contains_expected_new_transmission_topic']
                                for x in v['historical_receipts']))
        self.assertFalse(result['net_capture_proven'])
        self.assertFalse(result['static_oracle_target_currently_active_proven'])
        self.assertEqual(result['nqc_realized_pnl_usd'],'0')

    def test_dynamic_aggregator_rotation_is_explicit_negative_evidence(self):
        changed='0x'+'44'*20
        result=truth.run(lambda _:fake_source(aggregator=changed))
        self.assertTrue(result['cross_source_parity'])
        self.assertFalse(result['sources']['drpc']['topology']['static_target_matches'])
        self.assertEqual(result['sources']['drpc']['topology']
                         ['source_underlying_aggregator'],changed)

    def test_historical_topic_not_assumed(self):
        wrong='0x'+'ef'*32
        result=truth.run(lambda _:fake_source(historical_topic=wrong))
        self.assertTrue(result['cross_source_parity'])
        self.assertTrue(all(not x['contains_expected_new_transmission_topic']
                            for x in result['sources']['drpc']['historical_receipts']))
        self.assertFalse(result['prospective_hf_trigger_proven'])

    def test_source_disagreement_censored(self):
        result=truth.run(lambda provider:fake_source(
            aggregator='0x'+'44'*20 if provider=='blast' else truth.AGGREGATOR))
        self.assertEqual(result['status'],'MISMATCH_NO_ORACLE_IDENTITY_AUTHORITY')
        self.assertEqual(result['mismatch'],['PROVIDER_TOPIC_OR_TOPOLOGY_MISMATCH'])

    def test_historical_tx_wrong_status_or_order_fails(self):
        pin=truth.HISTORICAL[0];head=truth.chain_header(header(pin['block']),pin['block'])
        for key,bad in (('status','0x0'),('transactionIndex','0x1'),
                        ('blockHash','0x'+'ff'*32)):
            raw=receipt(pin);raw[key]=bad
            with self.subTest(key=key),self.assertRaises(ValueError):
                truth.historical_receipt(raw,pin,head)

    def test_wrong_source_chain_censored(self):
        result=truth.run(lambda _:fake_source(bad_chain=True))
        self.assertEqual(result['status'],'INCOMPLETE_ORACLE_TOPOLOGY_AND_TOPIC_AUDIT')
        self.assertTrue(result['mismatch'][0].startswith('ANCHOR_FAILURE'))

    def test_missing_abi_source_and_noncanonical_padding_rejected(self):
        with self.assertRaises(ValueError):truth.address_word('0x'+'ff'*32)
        with self.assertRaises(ValueError):truth.address_word('0x'+'00'*32)
        with self.assertRaises(ValueError):truth.parse_round('0x00')
        with self.assertRaises(ValueError):truth.read_word('0x1111')

    def test_abi_round_price_and_updated_at(self):
        parsed=truth.parse_round(round_data())
        self.assertEqual(parsed['answer_raw'],'251000000000')
        self.assertEqual(parsed['updated_at'],1700000011)

    def test_rpc_strict_readonly_calls_only(self):
        rpc=truth.RPC('drpc',lambda *_:None)
        with self.assertRaises(ValueError):rpc.call('eth_sendRawTransaction',['0xdead'])
        with self.assertRaises(ValueError):rpc.call('eth_getTransactionReceipt',['0x'+'cd'*32])
        with self.assertRaises(ValueError):rpc.call('eth_call',[
            {'to':truth.POOL,'data':'0xdeadbeef'},
            {'blockHash':h(26190000),'requireCanonical':True}])
        self.assertEqual(rpc.calls,0)

    def test_no_oracle_emitter_historical_is_rejected(self):
        pin=truth.HISTORICAL[0];head=truth.chain_header(header(pin['block']),pin['block'])
        raw=receipt(pin);raw['logs'][0]['address']='0x'+'99'*20
        with self.assertRaises(ValueError):
            truth.historical_receipt(raw,pin,head)


if __name__=='__main__':
    unittest.main()
