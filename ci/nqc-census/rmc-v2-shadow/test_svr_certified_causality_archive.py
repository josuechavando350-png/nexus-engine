#!/usr/bin/env python3
"""Offline tests of immutable PR700 source truth and historical archive censorship."""
import os
from pathlib import Path
import tempfile
import unittest

import svr_certified_causality_archive as gate
import svr_archive_positive_controls as original
import svr_hf_trigger_archive_audit as controls


class FakeArchive:
    def __init__(self, complete=True, linked=False):
        self.complete=complete;self.linked=linked
        self.calls=0;self.log=[]
    def info(self):
        self.calls+=1
        return {"minBlock":0,"maxBlock":27000000,"maxLimit":400}
    def inspect(self,control,metadata):
        self.calls+=1
        return {"status":"BOUNDED_PUBLIC_ARCHIVE_EXHAUSTED_NOT_PRIVATE_ACCESS"
                   if self.complete else "INCOMPLETE_ARCHIVE_PAGINATION_CAP",
                "archive_complete_in_bounded_range":self.complete,
                "hint_rows":25,"page_count":1,
                "exact_double_hash_matches":1 if self.linked else 0,
                "matching_double_hash_with_decodable_target":1 if self.linked else 0,
                "matching_archive_source_timings":([
                    {"hint_price_matches_onchain_transmit_report":True}]
                    if self.linked else [])}


class CertifiedArchiveTests(unittest.TestCase):
    def test_source_sha256_is_exact_immutable_pr700(self):
        self.assertEqual(gate.SOURCE_ARTIFACT_ID,11871075488)
        self.assertEqual(gate.SOURCE_COMMIT,"9208aa3cb29325ecb3a90557d1c62114c697bf02")
        self.assertEqual(gate.SOURCE_ZIP_SHA256,
            "ca495ebdb9b8c7f8ed8438e5c3226b58b9c31c0d50e44ef35d6fce2cec232dde")
        self.assertEqual([x['index'] for x in controls.CAUSAL_CONTROLS],[0,0])

    def test_bad_source_zip_cannot_create_forged_positives(self):
        with tempfile.TemporaryDirectory() as temp:
            p=Path(temp)/'bad.zip';p.write_bytes(b'not a real historical certificate')
            with self.assertRaises(gate.Reject):
                gate.authenticate_original(p)

    def test_source_artifact_missing_is_incomplete_not_zero(self):
        with tempfile.TemporaryDirectory() as temp:
            output=Path(temp)/'witness'
            r=gate.run(output,archive_file=Path(temp)/'absent.zip',archive=FakeArchive())
            self.assertEqual(r['status'],'INCOMPLETE_PR700_CERTIFICATE_OR_ARCHIVE')
            self.assertFalse(r['pr700_original_artifact_sha256_authenticated'])
            self.assertEqual(len(r['history']),0)
            self.assertEqual(r['realized_nqc_pnl_usd'],'0')

    def test_two_strict_prehistory_price_moving_controls_are_hindsight_only(self):
        self.assertEqual([c['block'] for c in controls.CAUSAL_CONTROLS],[26142067,26149038])
        self.assertEqual([c['index'] for c in controls.CAUSAL_CONTROLS],[0,0])
        self.assertTrue(gate.SOURCE_ZIP_SHA256)

    def test_no_archive_windows_fails_closed(self):
        self.assertEqual(gate.verdict([]),'INCOMPLETE_PR700_CERTIFICATE_OR_ARCHIVE')
        self.assertEqual(gate.verdict([{'archive_complete_in_bounded_range':True}]),
                         'INCOMPLETE_PR700_CERTIFICATE_OR_ARCHIVE')

    def test_unfinished_archive_never_zero_market(self):
        rows=[{'archive_complete_in_bounded_range':True},
              {'archive_complete_in_bounded_range':False}]
        self.assertEqual(gate.verdict(rows),'INCOMPLETE_HISTORICAL_ARCHIVE_COVERAGE_NOT_ABSENCE')

    def test_matching_double_hash_alone_is_not_full_decoded_price(self):
        rows=[{'archive_complete_in_bounded_range':True,
               'exact_double_hash_matches':1,
               'matching_double_hash_with_decodable_target':0,
               'matching_archive_source_timings':[]} for _ in range(2)]
        self.assertEqual(gate.verdict(rows),
            'ZERO_COMPLETE_MATCHES_IN_TWO_BOUNDED_ARCHIVE_WINDOWS_NOT_PRIVATE_DENIAL')

    def test_one_full_link_is_partial_retrospective_only(self):
        a={'archive_complete_in_bounded_range':True,
           'exact_double_hash_matches':1,
           'matching_double_hash_with_decodable_target':1,
           'matching_archive_source_timings':[{'hint_price_matches_onchain_transmit_report':True}]}
        b={'archive_complete_in_bounded_range':True,
           'exact_double_hash_matches':0,
           'matching_double_hash_with_decodable_target':0,
           'matching_archive_source_timings':[]}
        self.assertEqual(gate.verdict([a,b]),
                         'ONE_CERTIFIED_HF_TRIGGER_HINT_FOUND_NOT_CAPTURE_RECALL')
        self.assertEqual(gate.verdict([a,a]),
                         'TWO_CERTIFIED_HF_TRIGGER_HINTS_FOUND_RETROSPECTIVE_ONLY')

    def test_new_client_only_gets_the_two_preselected_windows(self):
        archive=original.Archive(controls=controls.CAUSAL_CONTROLS,max_pages=8,
                                 opener=lambda *args: (_ for _ in ()).throw(
                                     AssertionError('unapproved network')))
        original_window=(original.HISTORY+
            '?blockStart=26193936&blockEnd=26193945&limit=400&offset=0')
        with self.assertRaises(original.Rejected):archive.get(original_window)
        self.assertEqual(archive.calls,0)

    def test_original_zip_full_verification_when_attached_by_ci(self):
        source=os.getenv('NQC_PR700_CERT_ZIP')
        if not source or not Path(source).is_file():
            self.skipTest('the exact PR700 source ZIP must be downloaded before live Actions test')
        cases=gate.authenticate_original(Path(source))
        self.assertEqual(len(cases),2)
        self.assertEqual([c['block_number'] for c in cases],[26142067,26149038])
        self.assertTrue(all(int(c['price_before_raw'])>int(c['price_after_raw'])>0 for c in cases))
        self.assertTrue(all(int(c['hf_before_wad'])>=gate.WAD>int(c['hf_after_wad']) for c in cases))

    def test_real_certified_zip_with_fake_archive_preserves_no_claims(self):
        source=os.getenv('NQC_PR700_CERT_ZIP')
        if not source or not Path(source).is_file():
            self.skipTest('requires downloaded authentic PR700 ZIP')
        with tempfile.TemporaryDirectory() as temp:
            r=gate.run(Path(temp)/'source',archive_file=Path(source),
                       archive=FakeArchive(complete=True,linked=True))
            self.assertEqual(r['status'],'TWO_CERTIFIED_HF_TRIGGER_HINTS_FOUND_RETROSPECTIVE_ONLY')
            self.assertTrue(r['pr700_original_artifact_sha256_authenticated'])
            self.assertEqual(r['new_ethereum_rpc_calls'],0)
            self.assertFalse(r['builder_deadline_proven'])
            self.assertFalse(r['network_local_first_seen_before_inclusion_proven'])
            self.assertFalse(r['nonrecourse_native_gas_sponsor_proven'])
            self.assertEqual(r['realized_nqc_pnl_usd'],'0')

if __name__=='__main__':unittest.main()
