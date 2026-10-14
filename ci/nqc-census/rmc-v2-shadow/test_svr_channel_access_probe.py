#!/usr/bin/env python3
"""Offline source and fail-closed tests for NQC public MEV-Share read-only probe."""
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from urllib.error import HTTPError
from urllib.request import Request
import svr_channel_access_probe as s

class FakeResponse(io.BytesIO):
    def __init__(self, raw, url=s.SSE_URL, status=200):
        super().__init__(raw)
        self.url=url
        self.code=status
    def geturl(self):return self.url
    def getcode(self):return self.code

class Tests(unittest.TestCase):
    def test_http_controls_censor_not_market_absence(self):
        self.assertEqual(s.classification(403),"BLOCKED_SOURCE_ACCESS_CONTROL")
        self.assertEqual(s.classification(429),"INCOMPLETE_SOURCE_RATE_LIMIT")
    def test_sse_partial_event_not_profit(self):
        fake=b':ping\n\ndata: {"hash":"0x'+b'11'*32+b'","txs":[{}]}\n\n'
        o=s.consume_sse(FakeResponse(fake))
        self.assertEqual(o['sse_data_messages'],1)
        self.assertEqual(o['partial_hints_censored'],1)
        self.assertFalse(o['winning_bundle_inclusion_proven'])
        self.assertFalse(o['pre_builder_deadline_proven'])
        self.assertTrue(o['event_hash_is_double_keccak_not_ethereum_receipt_hash'])
        self.assertNotIn('event_hash',o['sampled'][0])
    def test_empty_source_never_zero_market_claim(self):
        o=s.consume_sse(FakeResponse(b''))
        self.assertEqual(o['sse_data_messages'],0)
        self.assertFalse(o['stream_coverage_exhaustive'])
        self.assertIn('INCOMPLETE',o['status'])
    def test_url_allowlist_excludes_other_domain_and_transactions(self):
        for url in ('https://relay.flashbots.net', 'https://example.com',
                    s.SSE_URL+'/api/v1/history?limit=100000'):
            with self.assertRaises(ValueError):
                s.open_fixed(url, opener=lambda req,timeout: FakeResponse(b''))
    def test_redirect_rejected(self):
        with self.assertRaisesRegex(ValueError,'redirect'):
            s.open_fixed(s.SSE_URL, opener=lambda req,timeout: FakeResponse(b'',url='https://example.com'))
    def test_precommit_before_first_network(self):
        with TemporaryDirectory() as tmp:
            path=Path(tmp)/'run'
            def blocked(req: Request, timeout):
                self.assertTrue((path/'precommit-before-network.json').exists())
                self.assertEqual(req.full_url,s.SSE_URL)
                self.assertEqual(req.get_method(),'GET')
                raise HTTPError(req.full_url,403,'Forbidden',{},None)
            report=s.run(path,opener=blocked)
            self.assertEqual(report['result'],'BLOCKED_SOURCE_ACCESS_CONTROL')
            self.assertEqual(report['source_http_status'],403)
            self.assertFalse(report['public_sse_http_200_observed'])
    def test_history_archive_bounded(self):
        def opened(req,timeout):
            if req.full_url==s.HISTORY_INFO:
                return FakeResponse(b'{"maxBlock":100,"maxLimit":500}',url=req.full_url)
            self.assertEqual(req.full_url,s.HISTORY+'?blockStart=92&blockEnd=100&limit=25&offset=0')
            return FakeResponse(b'[]',url=req.full_url)
        r=s.bounded_archive_read(opener=opened)
        self.assertEqual(r['range_start'],92)
        self.assertTrue(r['history_not_source_time_proof'])
    def test_partial_source_still_recorded_sanitized(self):
        with TemporaryDirectory() as tmp:
            path=Path(tmp)/'run'
            calls=[]
            def opened(req,timeout):
                calls.append(req.full_url)
                return FakeResponse(b':ping\n\ndata: {"hash":"0x'+b'22'*32+b'"}\n\n')
            out=s.run(path,opener=opened,archive=lambda opener: {'status':'SKIPPED_FOR_UNIT_TEST'})
            self.assertEqual(calls,[s.SSE_URL])
            self.assertEqual(out['result'],'PUBLIC_MEV_SHARE_SSE_HTTP_200_NOT_SVR_ACCESS_PROOF')
            self.assertFalse(out['NQC_pre_inclusion_edge_proven'])
            self.assertEqual(out['stream']['partial_hints_censored'],1)

if __name__=='__main__': unittest.main()
