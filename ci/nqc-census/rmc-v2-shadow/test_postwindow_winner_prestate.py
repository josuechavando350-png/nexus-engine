#!/usr/bin/env python3
"""Mutation and boundary tests. All RPC responses here are synthetic, not evidence."""
from copy import deepcopy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import postwindow_winner_prestate as m
import test_verify_postwindow_competitor_receipts as old


def abi(hf=m.WAD-1, debt=800, threshold=8000):
    return '0x'+''.join(format(x, '064x') for x in (1000, debt, 0, threshold, 7500, hf))


class Fake(old.Fake):
    def __init__(self):
        super().__init__()
        self.answers = {p['block']-1: abi() for p in m.receipts.PINS}
        self.parent_reads = 0
        self.reorg = False
        self.winner_reorg = False
        self.winner_reads = 0
        self.disagree = False
        self.call_error = False
        self.queries = []
        for p in m.receipts.PINS:
            self.blocks[p['block']]['timestamp'] = '0x6500000d'
            h = old.header(p['block']-1)
            h['hash'], h['parentHash'] = old.PARENT, '0x'+'d'*64
            self.blocks[p['block']-1] = h

    def __call__(self, url, method, params):
        self.queries.append((url, method, deepcopy(params)))
        if method == 'eth_call':
            if self.call_error:
                raise OSError('historical state unavailable')
            # Fixture parents deliberately share a hash; select via borrower call order.
            n = sum(x[1] == 'eth_call' for x in self.queries)-1
            raw = self.answers[m.receipts.PINS[n % 2]['block']-1]
            if self.disagree and url == m.receipts.PROVIDERS['blast'][1]:
                return abi(hf=m.WAD+1)
            return raw
        result = deepcopy(super().__call__(url, method, params))
        if method == 'eth_getBlockByNumber':
            height = int(params[0], 16)
            if height in self.answers:
                self.parent_reads += 1
                if self.reorg and self.parent_reads == 2:
                    result['stateRoot'] = '0x'+'f'*64
            else:
                self.winner_reads += 1
                if self.winner_reorg and self.winner_reads == 2:
                    result['hash'] = '0x'+'f'*64
        return result


def baseline(fake):
    return [{'header': m.receipts.header(fake.blocks[p['block']], p['block']),
             'receipt_witness': m.receipts.verify_receipt(
                 old.receipt(p), m.receipts.header(fake.blocks[p['block']], p['block']),
                 p, old.source_row(p))} for p in m.receipts.PINS]


class PredecessorTests(unittest.TestCase):
    def execute(self, fake=None, rows=None, source=None, transcript=None):
        fake = fake or Fake()
        with patch.object(m.receipts.indexed, 'authenticate_archive', return_value=(
                rows if rows is not None else [old.source_row(p) for p in m.receipts.PINS])), \
             patch.object(m, 'authenticate_receipts', return_value=(
                 source if source is not None else baseline(fake))):
            return m.run(b'fixture', b'fixture', transport=fake, transcript=transcript)

    def test_positive_parity_is_research_only(self):
        f = Fake()
        transcript = []
        report = self.execute(f, transcript=transcript)
        self.assertEqual(len(transcript), 30)
        self.assertEqual(len(report['witnesses']), 2)
        self.assertEqual(report['nqc_realized_pnl_usd'], '0')
        for key in ('RMC_closed', 'P2_shadow_certified', 'canary_live_authorized',
                    'commercial_score_upgrade', 'prospective_detection_proven',
                    'atomic_execution_proven', 'rpc_operator_independence_proven'):
            self.assertIs(report[key], False)
        for witness in report['witnesses']:
            self.assertFalse(witness['exact_winner_transaction_prestate_reconstructed'])
            self.assertEqual(witness['winner_block_elapsed_seconds'], 12)

    def test_every_state_read_is_hash_pinned_without_override(self):
        f = Fake()
        self.execute(f)
        calls = [q for q in f.queries if q[1] == 'eth_call']
        self.assertEqual(len(calls), 4)
        for _, _, params in calls:
            self.assertEqual(len(params), 2)
            self.assertEqual(params[1], {'blockHash': old.PARENT, 'requireCanonical': True})
            self.assertEqual(set(params[0]), {'to', 'data'})

    def test_one_wei_health_boundary(self):
        self.assertTrue(m.decode_account(abi(m.WAD-1))['debt_positive_and_hf_below_one'])
        for hf in (m.WAD, m.WAD+1, 2**256-1):
            self.assertFalse(m.decode_account(abi(hf))['debt_positive_and_hf_below_one'])

    def test_no_debt_is_negative_evidence_not_failure_or_trigger(self):
        a = m.decode_account(abi(hf=0, debt=0))
        self.assertFalse(a['debt_positive_and_hf_below_one'])
        self.assertEqual(a['classification'], 'NO_DEBT_AT_PREDECESSOR')

    def test_healthy_prior_state_is_not_relabelled_liquidatable(self):
        f = Fake()
        f.answers = {key: abi(m.WAD+100) for key in f.answers}
        r = self.execute(f)
        self.assertTrue(all(w['account_data']['classification'] ==
                            'HF_NOT_BELOW_ONE_AT_PREDECESSOR' for w in r['witnesses']))

    def test_bad_abi_rejected(self):
        for raw in ('0x', abi()[:-1], abi()+'00', '0x'+'g'*384, 7, None):
            with self.subTest(raw=str(raw)[:10]), self.assertRaises(m.Rejected):
                m.decode_account(raw)

    def test_invalid_basis_points_rejected(self):
        with self.assertRaisesRegex(m.Rejected, 'bps'):
            m.decode_account(abi(threshold=10001))

    def test_provider_disagreement_fails(self):
        f = Fake(); f.disagree = True
        with self.assertRaisesRegex(m.Rejected, 'parity mismatch'):
            self.execute(f)

    def test_reorg_after_call_fails(self):
        f = Fake(); f.reorg = True
        with self.assertRaisesRegex(m.Rejected, 'changed'):
            self.execute(f)

    def test_winner_reorg_after_call_fails(self):
        f = Fake(); f.winner_reorg = True
        with self.assertRaisesRegex(m.Rejected, 'changed'):
            self.execute(f)

    def test_parent_must_link_to_winner(self):
        f = Fake(); f.blocks[m.receipts.PINS[0]['block']-1]['hash'] = '0x'+'e'*64
        with self.assertRaisesRegex(m.Rejected, 'ancestry'):
            self.execute(f)

    def test_parent_time_must_precede_winner(self):
        f = Fake(); f.blocks[m.receipts.PINS[0]['block']-1]['timestamp'] = '0x6500000d'
        with self.assertRaisesRegex(m.Rejected, 'ancestry/time'):
            self.execute(f)

    def test_historical_winner_source_cannot_drift(self):
        f = Fake(); b = baseline(f); b[0]['header']['state_root'] = '0x'+'f'*64
        with self.assertRaisesRegex(m.Rejected, 'immutable'):
            self.execute(f, source=b)

    def test_actual_receipt_still_required(self):
        f = Fake(); f.bad_receipts.add('drpc')
        with self.assertRaisesRegex(m.Rejected, 'missing Ethereum'):
            self.execute(f)

    def test_historical_gas_cannot_drift(self):
        f = Fake(); f.logs[m.receipts.PINS[0]['tx']]['gasUsed'] = '0x1'
        with self.assertRaisesRegex(m.Rejected, 'differs from source'):
            self.execute(f)

    def test_borrower_identity_cannot_drift(self):
        rows = [old.source_row(p) for p in m.receipts.PINS]
        rows[0]['borrower_sha256'] = '0'*64
        with self.assertRaisesRegex(m.Rejected, 'borrower'):
            self.execute(rows=rows)

    def test_wrong_chain_fails(self):
        f = Fake(); f.bad_chain.add('blast')
        with self.assertRaisesRegex(m.Rejected, 'Ethereum'):
            self.execute(f)

    def test_state_unavailable_retains_failure_transcript(self):
        f = Fake(); f.call_error = True; transcript = []
        with self.assertRaises(OSError):
            self.execute(f, transcript=transcript)
        self.assertEqual(transcript[-1]['method'], 'eth_call')
        self.assertIn('error', transcript[-1])
        self.assertNotIn('result', transcript[-1])

    def test_no_network_before_immutable_archive_authentication(self):
        f = Fake()
        with self.assertRaises(ValueError):
            m.run(b'tampered', b'tampered', transport=f)
        self.assertEqual(f.queries, [])

    def test_receipt_archive_tampering_rejected(self):
        with self.assertRaisesRegex(m.Rejected, 'SHA256'):
            m.authenticate_receipts(b'tampered')

    def test_one_endpoint_is_not_parity(self):
        for providers in (('drpc',), ('drpc', 'drpc'), ('drpc', 'other')):
            with self.assertRaisesRegex(m.Rejected, 'distinct'):
                m.run(b'', b'', provider_ids=providers)

    def test_writes_and_state_override_forbidden(self):
        f = Fake(); rpc = m.RPC('drpc', f)
        for method in ('eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'debug_traceCall'):
            with self.assertRaisesRegex(m.Rejected, 'non-read-only'):
                rpc.call(method, [])
        params = [{'to': m.receipts.source.POOL, 'data': m.SELECTOR+'0'*24+'e'*40},
                  {'blockHash': old.PARENT, 'requireCanonical': True}]
        mutations = [params+[{}], [params[0], 'latest'],
                     [params[0], {'blockHash': old.PARENT, 'requireCanonical': False}],
                     [dict(params[0], value='0x1'), params[1]],
                     [dict(params[0], data='0xdeadbeef'), params[1]]]
        for bad in mutations:
            with self.assertRaisesRegex(m.Rejected, 'hash-pinned'):
                rpc.call('eth_call', bad)
        self.assertEqual(f.queries, [])

    def test_budget_is_bounded(self):
        rpc = m.RPC('drpc', Fake())
        for _ in range(m.MAX_CALLS): rpc.call('eth_chainId', [])
        with self.assertRaisesRegex(m.Rejected, 'budget'):
            rpc.call('eth_chainId', [])

    def test_cli_preserves_failure_evidence_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); a = root/'bad.zip'; a.write_bytes(b'bad')
            out = root/'attempt'
            argv = ['probe', '--indexer-artifact', str(a), '--receipt-artifact', str(a),
                    '--out-dir', str(out)]
            with patch('sys.argv', argv), self.assertRaises(ValueError): m.main()
            self.assertTrue((out/'failure.json').is_file())
            self.assertEqual(json.loads((out/'rpc-transcript.json').read_text()), [])
            self.assertFalse((out/'predecessor-witnesses.json').exists())
            before = (out/'failure.json').read_bytes()
            with patch('sys.argv', argv), self.assertRaises(FileExistsError): m.main()
            self.assertEqual((out/'failure.json').read_bytes(), before)


if __name__ == '__main__': unittest.main()
