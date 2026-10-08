#!/usr/bin/env python3
"""Adversarial contracts for authenticated winner-baseline / net-attribution."""
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from zipfile import ZipFile

HERE = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location('rmc016_winner_net_audit', HERE / 'rmc016_winner_net_audit.py')
AUD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUD)


def sha_byte(b):
    return f'{b:02x}'*32


def tx(b, gross, gas):
    costs = {k: '0' for k in AUD.COSTS}
    costs['gas_base_fee'] = str(gas//2)
    costs['gas_priority_fee'] = str(gas - gas//2)
    return {
        'transaction_hash': '0x' + sha_byte(b),
        'block_number': 11+b,
        'transaction_index': b,
        'pre_state_commitment': sha_byte(100+b),
        'winner_receipt_sha256': sha_byte(110+b),
        'transaction_economics_commitment': sha_byte(120+b),
        'historical_oracle_gross_edge_usd_wad': str(gross),
        'historical_gas_paid_usd_wad': str(gas),
        'costs': costs,
        'cost_evidence': {k:sha_byte(150) for k in AUD.COSTS},
    }


class WinnerAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.rows = [tx(1,100,10),tx(2,200,20)]
        self.summary = {
            'historical_winner_transaction_count': 2,
            'start_block': 10,
            'end_block': 20,
            'historical_market_gross_oracle_edge_usd_wad': '300',
            'historical_winner_gas_usd_wad': '30',
        }
        self.source = {'authority': {'transaction_economics_sha256': ''}}

    def ledger(self, rows=None, canonical=True):
        rows = self.rows if rows is None else rows
        payload = b''.join(AUD.canonical(row) for row in rows)
        if not canonical:
            payload = (json.dumps(rows[0],separators=(', ', ': ')) + '\n').encode() + b''.join(AUD.canonical(row) for row in rows[1:])
        p = self.root/'winner.jsonl'
        p.write_bytes(payload)
        self.source['authority']['transaction_economics_sha256'] = AUD.digest(payload)
        return p

    def check_rejected(self, rows, substring):
        with self.assertRaisesRegex(ValueError,substring):
            AUD.validate_complete_winner_ledger(self.ledger(rows),self.summary,self.source)

    def test_canonical_complete_ledger_is_only_market_accounting(self):
        observed = AUD.validate_complete_winner_ledger(self.ledger(),self.summary,self.source)
        self.assertEqual(observed['transaction_count'],2)
        self.assertEqual(observed['winner_net_after_declared_costs_usd_wad'],'270')
        self.assertFalse(observed['nexus_profitability_proven'])
        self.assertFalse(observed['nexus_capture_probability_calibrated'])

    def test_missing_winner_fails_closed(self):
        self.check_rejected(self.rows[:1],'exactly the authenticated winner')

    def test_duplicate_transaction_fails(self):
        rows = copy.deepcopy(self.rows)
        rows[1]['transaction_hash'] = rows[0]['transaction_hash']
        self.check_rejected(rows, 'duplicated')

    def test_unknown_gas_fee_cannot_disappear(self):
        rows=copy.deepcopy(self.rows)
        rows[0]['costs']['gas_base_fee']='0'
        self.check_rejected(rows,'gas components')

    def test_hidden_cost_taxonomy_not_accepted(self):
        rows=copy.deepcopy(self.rows)
        del rows[0]['costs']['swap_fee']
        self.check_rejected(rows,'full 15-component')

    def test_zero_cost_without_evidence_is_rejected(self):
        rows=copy.deepcopy(self.rows)
        rows[0]['cost_evidence']['swap_fee']='0'*64
        self.check_rejected(rows,'missing cost evidence')

    def test_noncanonical_row_refused_even_if_hash_is_rebound(self):
        with self.assertRaisesRegex(ValueError,'noncanonical JSONL'):
            AUD.validate_complete_winner_ledger(self.ledger(canonical=False),self.summary,self.source)

    def test_negative_or_float_costs_refused(self):
        for bad in ['-1','1.5',1.5,True]:
            rows=copy.deepcopy(self.rows)
            rows[0]['costs']['swap_fee']=bad
            self.check_rejected(rows,'canonical integer string')

    def test_window_and_timestamp_mismatch_refused(self):
        rows=copy.deepcopy(self.rows)
        rows[0]['block_number']=9
        self.check_rejected(rows,'outside authenticated window')

    def test_aggregate_winner_net_not_implicitly_extended(self):
        rows=copy.deepcopy(self.rows)
        rows[1]['historical_oracle_gross_edge_usd_wad']='250'
        self.check_rejected(rows,'gross does not reconcile')
        rows=copy.deepcopy(self.rows)
        rows[1]['historical_gas_paid_usd_wad']='25'
        rows[1]['costs']['gas_priority_fee']='15'
        self.check_rejected(rows,'gas does not reconcile')

    def test_missing_or_mutated_source_sha_is_rejected(self):
        path=self.ledger()
        path.write_bytes(path.read_bytes()+b'\n')
        with self.assertRaisesRegex(ValueError,'ledger SHA256 differs'):
            AUD.validate_complete_winner_ledger(path,self.summary,self.source)

    def test_no_receipt_or_pre_state_witness_refused(self):
        rows=copy.deepcopy(self.rows)
        rows[0]['winner_receipt_sha256']='0'*64
        self.check_rejected(rows,'independently bound')

    def test_zip_duplicate_and_noncanonical_manifest_rejected(self):
        p=self.root/'test.zip'
        files={'a.json':b'{}\n'}
        self.make_zip(p,files)
        self.assertEqual(AUD.verify_archive(p,AUD.digest(p.read_bytes()),set(files)),files)
        with ZipFile(p,'w') as z:
            z.writestr('a.json',b'{}\n');z.writestr('a.json',b'{}\n')
            z.writestr('archive.sha256',AUD.digest(b'{}\n')+'  a.json\n')
        with self.assertRaisesRegex(ValueError,'duplicate ZIP'):
            AUD.verify_archive(p,AUD.digest(p.read_bytes()),set(files))

    @staticmethod
    def make_zip(path,files):
        with ZipFile(path,'w') as z:
            for name,data in files.items():z.writestr(name,data)
            z.writestr('archive.sha256',''.join(f'{AUD.digest(data)}  {name}\n' for name,data in sorted(files.items())))

    def test_audit_hash_is_deterministic_and_no_revenue_claim(self):
        b={'status':'AGGREGATE_AUTHENTICATED_TRANSACTION_LEDGER_MISSING','gross_minus_observed_winner_gas_usd_wad':'300','nexus_monthly_pnl_estimate_usd_wad':None}
        with patch.object(AUD,'authenticated_baseline',return_value=(copy.deepcopy(b),{})):
            left=AUD.audit(Path('a'),Path('b'),Path('c'))
            right=AUD.audit(Path('a'),Path('b'),Path('c'))
        self.assertEqual(left,right)
        self.assertIsNone(left['nexus_monthly_pnl_estimate_usd_wad'])
        self.assertNotIn('NEXUS_PROFIT_CERTIFIED',str(left))

    def test_strict_aggregate_type_and_source_pin(self):
        self.assertEqual(AUD.usd_wad(10**18+200),'1.000000000000000200')
        for bad in [True,0,-1,'+3','01','1.1']:
            with self.assertRaises(ValueError):AUD.uint(bad,'test')
        with self.assertRaisesRegex(ValueError,'Git blob'):
            # Real baseline requires independently supplied exact D16 Git blob.
            AUD.require(AUD.git_blob_hash(b'{}')==AUD.D16_PRODUCTION_BLOB_SHA,'Git blob mismatch')


if __name__=='__main__': unittest.main()
