#!/usr/bin/env python3
"""Offline adversarial unit tests; no network, keys, bundle or gas."""
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qs,urlsplit

import svr_archive_positive_controls as m

H=lambda h:'0x'+format(h,'064x')
P=lambda h:'0x'+format(h-1,'064x')
TOPIC=m.SECONDARY_TOPIC

def word(v):return int(v).to_bytes(32,'big').hex()
def rounddata(before=False):
    rid=101 if before else 102
    return '0x'+''.join(word(v) for v in (rid,241000000000+rid,150,160+rid,rid))

class FakeSource:
    def __init__(self,label,variant='ok'):
        self.label=label;self.variant=variant;self.calls=0;self.pins=set();self.transcript=[];self.seen=[]
    def call(self,method,params):
        self.calls+=1;self.seen.append((method,params))
        if method=='eth_chainId':return '0x2' if self.variant=='wrong_chain' else '0x1'
        if method=='eth_getBlockByNumber':
            h=int(params[0],16)
            return dict(number=hex(h),hash=H(h) if self.variant!='wrong_hash' else '0x'+'cd'*32,
                        parentHash=P(h),stateRoot='0x'+'ab'*32,timestamp=hex(200+h))
        if method in ('eth_getTransactionReceipt','eth_getTransactionByHash'):
            txhash=params[0]
            case=next(x for x in m.POSITIVE if x['tx_hash']==txhash)
            base={'transactionHash':txhash,'blockHash':H(case['block']),
                  'blockNumber':hex(case['block']),'transactionIndex':hex(case['index'])}
            if method=='eth_getTransactionReceipt':
                base.update(status='0x1',logs=[{
                    'address':m.WETH_AGGREGATOR,'topics':[m.SECONDARY_TOPIC],
                    'transactionHash':txhash,'blockHash':H(case['block']),
                    'blockNumber':hex(case['block']),'removed':False}])
                if self.variant=='no_positive_log':base['logs']=[]
                if self.variant=='bad_receipt_status':base['status']='0x0'
            else:
                base={'hash':txhash,'blockHash':H(case['block']),
                      'blockNumber':hex(case['block']), 'transactionIndex':hex(case['index']),
                      'input':'0x'}
            return base
        if method=='eth_call':
            h=int(params[1]['blockHash'][2:],16)
            return rounddata(before=(h in {c['block']-1 for c in m.POSITIVE}))
        raise RuntimeError('unknown method')

def pair(variant='ok'):
    return {k:FakeSource(k,variant if k=='publicnode' else 'ok') for k in m.RPCS}

class FakeResponse:
    def __init__(self,url,body,status=200):
        self.url=url;self.payload=json.dumps(body).encode();self.status=status
        self.fd=io.BytesIO(self.payload)
    def geturl(self):return self.url
    def getcode(self):return self.status
    def read(self,n):return self.fd.read(n)
    def __enter__(self):return self
    def __exit__(self,*args):return None

class FakeArchive:
    def __init__(self,with_exact=True, cap=False, not_archived=False):
        self.with_exact=with_exact;self.cap=cap;self.not_archived=not_archived
        self.calls=0;self.log=[];self.pages=[]
    def info(self):
        return {'minBlock':26193940 if self.not_archived else 26100000,
                'maxBlock':26199999,'maxLimit':2 if self.cap else 400}
    def inspect(self,control,meta):
        if self.not_archived:return {'status':'INCOMPLETE_TARGET_RANGE_NOT_ARCHIVED',
                                    'archive_complete_in_bounded_range':False}
        row={'block':control['block_number']-1,'timestamp':1792020000,
             'hint':{'hash':control['expected_event_double_keccak'] if self.with_exact else '0x'+'11'*32,
                     'txs':[{'functionSelector':'0x6fadcf72'}]}}
        verdict=m.inspect_event(m.canonical(row['hint']).strip())
        self.calls+=1
        return {'status':'BOUNDED_PUBLIC_ARCHIVE_EXHAUSTED_NOT_PRIVATE_ACCESS',
                'archive_complete_in_bounded_range':True,
                'exact_double_hash_matches':int(self.with_exact),
                'matched_classification':verdict['result'],'hint_rows':1}

class Tests(unittest.TestCase):
    def test_keccak_empty_and_flashbots_double_hash_vector(self):
        self.assertEqual(m.keccak256(b'').hex(),
          'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470')
        original='d2d662b8aa0e8d86ea75d363522c9ede42ef538ae353da564d501c044a885293'
        self.assertEqual(m.keccak256(bytes.fromhex(original)).hex(),
          '90b4f5664cc201c3aa112d6bb2fa414c4aee10f00994692b282c1d14a1db6e4d')
        self.assertNotEqual(m.keccak256(bytes.fromhex(original)).hex(),original)

    def test_frozen_two_source_transactions(self):
        self.assertEqual(len(m.POSITIVE),2)
        self.assertEqual([c['block'] for c in m.POSITIVE],[26193643,26193944])
        self.assertEqual(len({c['tx_hash'] for c in m.POSITIVE}),2)
        self.assertTrue(all(m.HEX32.fullmatch(c['tx_hash']) for c in m.POSITIVE))

    def test_rpc_allowlist_rejects_sign_send_others(self):
        c=m.RPC('drpc',transport=lambda *args:None)
        for method,params in [('eth_sendRawTransaction',[]),('eth_sign',[]),
                              ('eth_getLogs',[]),('mev_sendBundle',[]),
                              ('eth_getTransactionReceipt',['0x'+'11'*32]),
                              ('eth_call',[{'to':m.WETH_AGGREGATOR,'data':m.ROUND_SELECTOR},'latest'])]:
            with self.subTest(method=method):
                with self.assertRaises(m.Rejected):c.call(method,params)
        self.assertEqual(c.calls,0)

    def test_two_rpc_positive_receipt_logs_and_prepost_round(self):
        peers=pair()
        for case in m.POSITIVE:
            rec=m.verified_transaction(case,peers)
            self.assertTrue(rec['canonical_receipt_verified'])
            self.assertEqual(rec['canonical_tx_block_timestamp'],200+case['block'])
            self.assertTrue(rec['round_advanced'])
            self.assertEqual(rec['oracle_topics'],[m.SECONDARY_TOPIC])
            self.assertTrue(m.HEX32.fullmatch(rec['expected_event_double_keccak']))
            self.assertIsNone(rec['report_median_raw'])
        self.assertEqual(peers['drpc'].calls,16)
        self.assertEqual(peers['publicnode'].calls,16)

    def test_canonical_source_parity_fail_closed(self):
        for variant in ('wrong_hash','no_positive_log','bad_receipt_status'):
            with self.subTest(variant=variant):
                with self.assertRaises(m.Rejected):
                    m.verified_transaction(m.POSITIVE[0],pair(variant))

    def test_archive_partial_matching_hash_censored(self):
        ctrl={'block_number':26193944,
              'expected_event_double_keccak':'0x'+'22'*32}
        a=FakeArchive()
        res=a.inspect(ctrl,a.info())
        self.assertEqual(res['exact_double_hash_matches'],1)
        self.assertEqual(res['matched_classification'],'INCOMPLETE_HINT_CENSORED')

    def test_archive_absence_of_exact_hash_cannot_prove_private_denial(self):
        ctrl={'block_number':26193944,'expected_event_double_keccak':'0x'+'22'*32}
        res=FakeArchive(with_exact=False).inspect(ctrl,FakeArchive().info())
        self.assertEqual(res['exact_double_hash_matches'],0)
        self.assertEqual(res['status'],'BOUNDED_PUBLIC_ARCHIVE_EXHAUSTED_NOT_PRIVATE_ACCESS')

    def test_not_archived_stays_incomplete(self):
        ctrl={'block_number':26193643,'expected_event_double_keccak':'0x'+'22'*32}
        a=FakeArchive(not_archived=True)
        res=a.inspect(ctrl,a.info())
        self.assertEqual(res['status'],'INCOMPLETE_TARGET_RANGE_NOT_ARCHIVED')
        self.assertFalse(res['archive_complete_in_bounded_range'])

    def test_info_validated_and_read_only_get(self):
        calls=[]
        def opener(req,timeout):
            calls.append((req.full_url,req.get_method()))
            return FakeResponse(req.full_url,{'minBlock':25000000,'maxBlock':27000000,'maxLimit':400})
        arc=m.Archive(opener=opener)
        self.assertEqual(arc.info()['maxLimit'],400)
        self.assertEqual(calls,[(m.HISTORY_INFO,'GET')])

    def test_archive_wrong_host_and_wrong_window_no_network(self):
        calls=[]
        def opener(req,timeout):
            calls.append(req.full_url)
            return FakeResponse(req.full_url,[])
        archive=m.Archive(opener=opener)
        denied=(
            "https://other.example/api/v1/history?blockStart=26193936&blockEnd=26193945&limit=400&offset=0",
            m.HISTORY+"?blockStart=26193936&blockEnd=26193945&limit=400&offset=0&extra=1",
            m.HISTORY+"?blockStart=26193936&blockEnd=26193945&limit=400&offset=1600",
            m.HISTORY+"?blockStart=123456&blockEnd=123465&limit=400&offset=0",
        )
        for url in denied:
            with self.subTest(url=url):
                with self.assertRaises(m.Rejected):archive.get(url)
        self.assertEqual(calls,[])

    def test_archive_bounded_exact_match_from_synthetic_public_history(self):
        control={"block_number":26193944,
                 "canonical_tx_block_timestamp":1792020040,
                 "report_median_raw":"241555715191",
                 "expected_event_double_keccak":"0x"+"cc"*32}
        observed=[]
        def opener(req,timeout):
            observed.append(req.full_url)
            if req.full_url==m.HISTORY_INFO:
                data={"minBlock":26000000,"maxBlock":27000000,"maxLimit":400}
            else:
                data=[{"block":26193943,"timestamp":1792020000,
                      "hint":{"hash":control["expected_event_double_keccak"],"txs":[{}]}}]
            return FakeResponse(req.full_url,data)
        archive=m.Archive(opener=opener,sleeper=lambda _:None,monotonic=lambda:1.0)
        meta=archive.info()
        res=archive.inspect(control,meta)
        self.assertEqual(res["exact_double_hash_matches"],1)
        self.assertEqual(res["matching_double_hash_hint_partial"],1)
        self.assertEqual(res["target_report_decoded_unauthenticated"],0)
        self.assertTrue(res["archive_complete_in_bounded_range"])
        self.assertEqual(len(res["matching_archive_source_timings"]),1)
        self.assertEqual(res["matching_archive_source_timings"][0][
            "nominal_included_slot_minus_source_timestamp_seconds"],40)
        self.assertTrue(res["matching_archive_source_timings"][0][
            "source_archive_tip_before_included_height"])
        self.assertFalse(res["matching_archive_source_timings"][0][
            "NQC_process_first_seen_proven"])
        self.assertEqual(len(observed),2)

    def test_archive_4_page_cap_is_incomplete_not_no_hint(self):
        ctrl={"block_number":26193944,"expected_event_double_keccak":"0x"+"22"*32}
        def opener(req,timeout):
            if req.full_url==m.HISTORY_INFO:
                return FakeResponse(req.full_url,{"minBlock":25000000,
                                                 "maxBlock":27000000,"maxLimit":1})
            return FakeResponse(req.full_url,[{"block":26193943,"timestamp":1792020000,
                    "hint":{"hash":"0x"+"11"*32,"txs":[{}]}}])
        arc=m.Archive(opener=opener,sleeper=lambda _:None,monotonic=lambda:1.0)
        res=arc.inspect(ctrl,arc.info())
        self.assertEqual(res["status"],"INCOMPLETE_ARCHIVE_PAGINATION_CAP")
        self.assertEqual(res["page_count"],4)
        self.assertFalse(res["archive_complete_in_bounded_range"])

    def test_no_http403_retry_or_redirect(self):
        n=[0]
        def opener(req,timeout):
            n[0]+=1
            raise HTTPError(req.full_url,403,'denied',{},None)
        arc=m.Archive(opener=opener)
        with self.assertRaises(HTTPError):arc.info()
        self.assertEqual(n[0],1)
        self.assertEqual(arc.calls,1)

    def test_invalid_header_round_and_hash_fail(self):
        with self.assertRaises(m.Rejected):m.canonical_header({'number':'0x1'},1)
        with self.assertRaises(m.Rejected):m.decode_round('0x00')
        with self.assertRaises(m.Rejected):m.decode_round('0x'+word(0)*5)
        with self.assertRaises(m.Rejected):m.keccak256(b'x'*3000)

    def test_full_source_control_precommit_before_first_call(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'evidence'
            sources=pair()
            class CheckedSource:
                def __init__(self,upstream):self.upstream=upstream
                def call(self,method,params):
                    self_outer.assertTrue((target/'source-precommit.json').is_file())
                    return self.upstream.call(method,params)
                @property
                def calls(self):return self.upstream.calls
                @property
                def transcript(self):return self.upstream.transcript
                @property
                def pins(self):return self.upstream.pins
            self_outer=self
            wrapped={k:CheckedSource(v) for k,v in sources.items()}
            a=FakeArchive()
            data=m.run(target,rpc_clients=wrapped,archive=a)
            self.assertEqual(len(data['positive_controls']),2)
            self.assertEqual(data['source_errors'],[])
            self.assertEqual(data['nqc_realized_pnl_usd'],'0')
            self.assertFalse(data['private_first_seen_proven'])
            self.assertEqual(a.calls,2)
            self.assertEqual(data['status'],
               'ONCHAIN_CONTROLS_AND_ARCHIVE_BOUNDED_READ_COMPLETE_NO_PROSPECTIVE_AUTHORITY')

    def test_source_control_unknown_because_bad_ethereum_chain(self):
        with tempfile.TemporaryDirectory() as temp:
            target=Path(temp)/'evidence'
            res=m.run(target,rpc_clients=pair('wrong_chain'),archive=FakeArchive())
            self.assertEqual(res['status'],'INCOMPLETE_SOURCE_CONTROLS')
            self.assertEqual(len(res['positive_controls']),0)
            self.assertFalse(res['win_inclusion_proven'])

if __name__=='__main__':unittest.main()
