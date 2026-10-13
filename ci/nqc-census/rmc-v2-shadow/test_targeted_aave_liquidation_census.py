"""Deterministic adversarial tests: exact-targeted historical LiquidationCall census."""
from __future__ import annotations
import copy
import importlib.util
from pathlib import Path
import unittest

SPEC=importlib.util.spec_from_file_location(
    'postwindow',Path(__file__).with_name('targeted_aave_liquidation_census.py'))
assert SPEC and SPEC.loader
m=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)

WETH='0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'
HASH_B='0x'+'b'*64
TX='0x'+'f'*64
SRC='0x'+'a'*64
STATE='0x'+'9'*64


def fake_header(height):
    digest={m.PREVIOUS_END:m.PREVIOUS_END_HASH,
            m.START:SRC,m.END:m.END_HASH,m.START+7:HASH_B}.get(height, '0x'+'8'*64)
    parent={m.START:m.PREVIOUS_END_HASH,
            m.END:m.END_PARENT}.get(height,'0x'+'7'*64)
    return {'number':hex(height),'hash':digest,'parentHash':parent,
            'timestamp':'0x67000001','stateRoot':STATE}


def make_log(collateral=m.SUSDE,debt=m.USDTB,block=m.START+7):
    event_data=('0x'+ format(472000*10**18,'064x')+
                format(388000*10**18,'064x')+
                '0'*24 + '1'*40+format(0,'064x'))
    return {'address':m.AAVE, 'topics':[m.TOPIC,m.topic_for(collateral),
            m.topic_for(debt),'0x'+'0'*24+'2'*40],
            'data':event_data, 'blockNumber':hex(block),'blockHash':HASH_B,
            'transactionHash':TX,'transactionIndex':'0x1','logIndex':'0x0',
            'removed':False}

class FakeTransport:
    def __init__(self,log=None,*,alter_on_second=False):
        self.log=log
        self.alter_on_second=alter_on_second
        self.end_header_calls=0
        self.calls=[]
        self.malformed_stream=None
        self.aborting=None
        self.logs_by_stream=None
        self.max_range=None
    def __call__(self,url,method,params):
        self.calls.append((method,params))
        if method=='eth_chainId':return '0x1'
        if method=='eth_getBlockByNumber':
            height=int(params[0],16)
            header=fake_header(height)
            if height==m.END:
                self.end_header_calls+=1
                if self.alter_on_second and self.end_header_calls>1:
                    header['hash']='0x'+'4'*64
            return header
        if method=='eth_getLogs':
            query=params[0];start=int(query['fromBlock'],16);end=int(query['toBlock'],16)
            if self.max_range is not None and end-start+1>self.max_range:
                raise m.SourceError('max block range exceeded')
            stream='collateral' if len(query['topics'])==2 else 'debt'
            if self.aborting is not None:
                raise m.SourceError(self.aborting)
            if self.malformed_stream == stream:
                event=make_log()
                event['topics'][1]='0x'+'0'*24+WETH[2:]
                event['topics'][2]='0x'+'0'*24+WETH[2:]
                return [event]
            if self.logs_by_stream is not None:
                return self.logs_by_stream.get(stream,[])
            if self.log is None or not start<=int(self.log['blockNumber'],16)<=end:
                return []
            token = m.topic_addr(self.log['topics'][1 if stream=='collateral' else 2])
            return [self.log] if token in m.TARGETS else []
        if method=='eth_getTransactionReceipt':
            return {'transactionHash':TX,'blockHash':HASH_B,
                    'blockNumber':hex(m.START+7),'status':'0x1',
                    'logs':[self.log],'gasUsed':'0xf4240','effectiveGasPrice':'0x3b9aca00'}
        raise AssertionError('unexpected transport '+method)

def mock_rpc(name,transport):
    return m.RPC(name,min_interval=0,request_limit=80,transport=transport)

class EventIdentity(unittest.TestCase):
    def test_topic_padding(self):
        self.assertEqual(m.topic_addr(m.topic_for(m.SUSDE)),m.SUSDE)
        with self.assertRaisesRegex(m.SourceError,'padding'):
            m.topic_addr('0x'+'1'*64)
    def test_pair_in_both_indexed_streams(self):
        a=m.normalize(make_log(),m.START,m.END,'collateral')
        b=m.normalize(make_log(),m.START,m.END,'debt')
        self.assertEqual(a,b)
        self.assertEqual(a['collateral_asset'],m.SUSDE)
        self.assertEqual(a['debt_asset'],m.USDTB)
        self.assertEqual(a['debt_to_cover_raw'],str(472000*10**18))
    def test_wrong_asset_in_response_rejected(self):
        with self.assertRaisesRegex(m.SourceError,'filter'):
            log=make_log()
            log['topics'][1]='0x'+'0'*24+WETH[2:]
            m.normalize(log,m.START,m.END,'collateral')
    def test_spoofed_pool_or_topic_rejected(self):
        l=make_log();l['address']=WETH
        with self.assertRaisesRegex(m.SourceError,'pool'):
            m.normalize(l,m.START,m.END,'collateral')
        l=make_log();l['topics'][0]='0x'+'0'*64
        with self.assertRaisesRegex(m.SourceError,'signature'):
            m.normalize(l,m.START,m.END,'collateral')
    def test_outside_interval_rejected(self):
        with self.assertRaisesRegex(m.SourceError,'outside requested'):
            m.normalize(make_log(block=m.START-1),m.START,m.END,'debt')
    def test_zero_debt_and_bad_receive_atoken_rejected(self):
        l=make_log();l['data']='0x'+'0'*64+l['data'][66:]
        with self.assertRaisesRegex(m.SourceError,'zero-sized'):
            m.normalize(l,m.START,m.END,'debt')
        l=make_log();l['data']=l['data'][:-64]+format(2,'064x')
        with self.assertRaisesRegex(m.SourceError,'malformed liquidator'):
            m.normalize(l,m.START,m.END,'debt')
    def test_event_removed_or_lost_fails(self):
        l=make_log();l['removed']=True
        with self.assertRaisesRegex(m.SourceError,'removed'):
            m.normalize(l,m.START,m.END,'collateral')
        l=make_log();l.pop('data')
        with self.assertRaisesRegex(m.SourceError,'missing log field'):
            m.normalize(l,m.START,m.END,'collateral')
    def test_header_anchors_and_parent(self):
        m.checked_header(fake_header(m.END),m.END,m.END_HASH,m.END_PARENT)
        h=fake_header(m.START);h['parentHash']='0x'+'0'*64
        with self.assertRaisesRegex(m.SourceError,'parent'):
            m.checked_header(h,m.START,None,m.PREVIOUS_END_HASH)

class CoverageAndQuorum(unittest.TestCase):
    def test_exhaustive_empty_single_source(self):
        r=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=20000)
        self.assertEqual(r['total_targeted_events'],0)
        self.assertEqual(r['summary']['unique_transactions'],0)
        self.assertEqual(r['status'],'COMPLETE_SINGLE_PUBLIC_RPC_TARGETED_HISTORICAL_ONLY')
        self.assertTrue(m.interval_cover(r['shards']))
        self.assertFalse(r['independent_operator_authenticity_proven'])
        self.assertFalse(r['p2_shadow_certified'])
    def test_one_event_in_both_streams_deduped(self):
        t=FakeTransport(log=make_log())
        r=m.report_for_provider(mock_rpc('publicnode',t),span=20000)
        self.assertEqual(r['total_targeted_events'],1)
        self.assertEqual(r['summary']['susde_collateral_usdtb_debt'],1)
        self.assertEqual(r['summary']['unique_transactions'],1)
        self.assertEqual(len(r['receipt_checks']),1)
        self.assertTrue(r['receipt_checks'][0]['receipt_identity_matches'])
    def test_two_distinct_endpoints_same_empty_events(self):
        a=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=40000)
        b=m.report_for_provider(mock_rpc('drpc',FakeTransport()),span=30000)
        both=m.compare_reports(a,b)
        self.assertEqual(both['total_targeted_events'],0)
        self.assertEqual(both['status'],'TWO_DISTINCT_PUBLIC_ENDPOINTS_EXACT_EVENTS_MATCH')
        self.assertFalse(both['independent_rpc_operator_authentication_proven'])
    def test_duplicate_provider_cannot_upgrade(self):
        a=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=30000)
        with self.assertRaisesRegex(m.SourceError,'same endpoint'):
            m.compare_reports(a,copy.deepcopy(a))
    def test_mismatched_results_cannot_certify_absence(self):
        a=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=30000)
        b=m.report_for_provider(mock_rpc('drpc',FakeTransport(make_log())),span=30000)
        with self.assertRaisesRegex(m.SourceError,'event mismatch'):
            m.compare_reports(a,b)
    def test_tampered_events_digest_rejected(self):
        r=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=45000)
        s=copy.deepcopy(r);s['events_sha256']='0'*64
        with self.assertRaisesRegex(m.SourceError,'digest'):
            m.compare_reports(r,s)
    def test_missing_gap_and_overlap_rejected(self):
        for rows in ([{'start':m.START+1,'end':m.END}],
                     [{'start':m.START,'end':m.START+2},
                      {'start':m.START+2,'end':m.END}],
                     [{'start':m.START,'end':m.END-1}]):
            with self.subTest(rows=rows),self.assertRaises(m.SourceError):
                m.interval_cover(rows)
    def test_temporally_changed_header_rejected(self):
        transport=FakeTransport(alter_on_second=True)
        with self.assertRaisesRegex(m.SourceError,'headers differ'):
            m.report_for_provider(mock_rpc('publicnode',transport),span=30000)
    def test_malformed_rpc_stream_fails_not_empty(self):
        transport=FakeTransport();transport.malformed_stream='collateral'
        with self.assertRaises(m.SourceError):
            m.report_for_provider(mock_rpc('publicnode',transport),span=30000)
    def test_deterministic_block_range_splitting_covers_every_block(self):
        t=FakeTransport();t.max_range=15000
        r=m.report_for_provider(mock_rpc('publicnode',t),span=30000)
        self.assertTrue(m.interval_cover(r['shards']))
        self.assertGreater(len(r['shards']),3)
        self.assertEqual(r['total_targeted_events'],0)
    def test_rate_limit_aborts_not_claims_zero(self):
        t=FakeTransport();t.aborting='RPC_JSON_ERROR_429 too many requests'
        with self.assertRaisesRegex(m.SourceError,'429'):
            m.report_for_provider(mock_rpc('publicnode',t),span=30000)
    def test_mismatched_receipt_commitment_rejected(self):
        a=m.report_for_provider(mock_rpc('publicnode',FakeTransport(make_log())),span=40000)
        b=copy.deepcopy(a);b['provider_id']='drpc';b['operator_label']='dRPC'
        b['receipt_checks'][0]['receipt_effective_gas_price_wei_raw']='123'
        b['receipt_checks_sha256']=m.sha(b['receipt_checks'])
        with self.assertRaisesRegex(m.SourceError,'receipt mismatch'):
            m.compare_reports(a,b)
    def test_rate_limit_override_only_for_synthetic_transport(self):
        with self.assertRaisesRegex(m.SourceError,'minimum spacing'):
            m.RPC('publicnode',min_interval=0)
        m.RPC('publicnode',min_interval=0,transport=FakeTransport())
    def test_unauthorized_rate_error_does_not_split(self):
        for code in ('429 rate limited','403 forbidden','api key unauthorized'):
            self.assertFalse(m.permitted_split(m.SourceError(code)))
        self.assertTrue(m.permitted_split(m.SourceError('max block range exceeded')))
    def test_http_400_does_not_automatically_trigger_retry_split(self):
        self.assertFalse(m.permitted_split(m.SourceError(
            'RPC_HTTP_400: invalid params: unsupported topic query')))
        self.assertTrue(m.permitted_split(m.SourceError(
            'RPC_HTTP_400: block range too large for plan')))
    def test_http_403_from_provider_never_split(self):
        self.assertFalse(m.permitted_split(m.SourceError(
            'RPC_HTTP_403: forbidden for this endpoint')))
    def test_incomplete_status_cannot_be_reconciled(self):
        r=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=30000)
        s=copy.deepcopy(r);s['status']='PARTIAL_SOURCE_CENSORED'
        with self.assertRaisesRegex(m.SourceError,'incomplete'):
            m.compare_reports(r,s)
    def test_unauthenticated_report_cannot_claim_p2(self):
        r=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),span=30000)
        s=copy.deepcopy(r);s['p2_shadow_certified']=True
        with self.assertRaisesRegex(m.SourceError,'commercial/Shadow'):
            m.compare_reports(r,s)
    def test_receipt_absence_rejects_positive(self):
        transport=FakeTransport(log=make_log())
        old=transport.__call__
        def wrap(url,method,params):
            if method=='eth_getTransactionReceipt':return None
            return old(url,method,params)
        with self.assertRaisesRegex(m.SourceError,'missing receipt'):
            m.report_for_provider(mock_rpc('publicnode',wrap),span=30000)
    def test_summary_classes_exact_pair_only(self):
        events=[m.normalize(make_log(),m.START,m.END,'collateral')]
        summary=m.classify(events)
        self.assertEqual(summary['susde_collateral_usdtb_debt'],1)
        self.assertEqual(summary['usdtb_collateral_susde_debt'],0)
        self.assertEqual(summary['events_referencing_susde'],1)
        self.assertEqual(summary['events_referencing_usdtb'],1)
    def test_restricted_ranges_not_full_absence_claim(self):
        r=m.report_for_provider(mock_rpc('publicnode',FakeTransport()),
                                start=m.START,end=m.START+100,span=100)
        self.assertEqual(r['window']['end'],m.START+100)
        with self.assertRaisesRegex(m.SourceError,'wrong post-window bounds'):
            m.compare_reports(r,copy.deepcopy(r)|{'provider_id':'drpc'})

if __name__=='__main__':unittest.main()
