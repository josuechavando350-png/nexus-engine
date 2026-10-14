#!/usr/bin/env python3
"""Offline, adversarial, deterministic tests; zero public/private RPC calls."""
import json
import unittest
import svr_hint_admission as g


def word(n):
    return n.to_bytes(32, 'big', signed=False)


def signed(n):
    return (n%(1<<256)).to_bytes(32,'big')


def encode_report(values=(241004830000, 241004840000, 241004850000)):
    return (word(1792015847) + bytes(32) + word(128) + signed(0) +
            word(len(values)) + b''.join(signed(n) for n in values))


def pack(payload):
    return word(len(payload)) + payload + bytes((-len(payload))%32)


def encode_secondary(report=None):
    report = encode_report() if report is None else report
    r = pack(report)
    rs = word(1) + bytes(32)
    ss = word(1) + bytes(32)
    head = bytes(96) + word(224) + word(224+len(r)) + word(224+len(r)+len(rs)) + bytes(32)
    return g.SECONDARY_SELECTOR + head + r + rs + ss


def encode_forward(to=g.WETH_AGGREGATOR, nested=None):
    nested = encode_secondary() if nested is None else nested
    return g.FORWARD_SELECTOR + word(int(to,16)) + word(64) + pack(nested)


def event(*, to=g.WETH_AGGREGATOR, call=None, hint_selector='0x6fadcf72', missing=False):
    tx = {'to':'0x'+'11'*20,'functionSelector':hint_selector,
          'callData':'0x'+(encode_forward(to) if call is None else call).hex()}
    if missing:
        del tx['callData']
    return json.dumps({'hash':'0x'+'ab'*32,'txs':[tx]},sort_keys=True).encode()


class HintAdmissionTests(unittest.TestCase):
    def test_golden_exact_forward_and_secondary_selectors(self):
        self.assertEqual(g.FORWARD_SELECTOR.hex(), '6fadcf72')
        self.assertEqual(g.SECONDARY_SELECTOR.hex(), 'ba0cb29e')

    def test_target_price_is_decoded_but_never_promoted(self):
        r=g.inspect_event(event())
        self.assertEqual(r['result'],'TARGET_PRICE_DECODED_UNAUTHENTICATED')
        self.assertEqual(r['report']['median_signed_int192_raw'],'241004840000')
        self.assertEqual(r['report']['observation_count'],3)
        for prop in ('oracle_price_authority','actual_preinclusion_reception_proven',
                     'builder_deadline_proven','liquidation_eligible_proven',
                     'net_profit_proven','native_gas_funding_proven'):
            self.assertFalse(r[prop])
        self.assertTrue(r['report_value_is_raw_not_USD'])

    def test_typo_in_official_typescript_example_does_not_pass(self):
        r=g.inspect_event(event(hint_selector='6fadc72'))
        self.assertEqual(r['result'],'INVALID_HINT_CENSORED')

    def test_partial_hints_are_not_mistaken_for_negative_feed(self):
        self.assertEqual(g.inspect_event(event(missing=True))['result'],
                         'INCOMPLETE_HINT_CENSORED')
        h=json.dumps({'hash':'0x'+'ab'*32}).encode()
        self.assertEqual(g.inspect_event(h)['result'],'INCOMPLETE_HINT_CENSORED')

    def test_non_target_aggregator_never_promoted(self):
        r=g.inspect_event(event(to='0x'+'22'*20))
        self.assertEqual(r['result'],'NO_TARGET_IN_COMPLETE_BOUNDED_HINT')

    def test_missing_or_different_outer_selector_is_not_target(self):
        r=g.inspect_event(event(hint_selector='0x12345678'))
        self.assertEqual(r['result'],'NO_TARGET_IN_COMPLETE_BOUNDED_HINT')

    def test_outer_hint_and_actual_calldata_disagreement_fails_closed(self):
        r=g.inspect_event(event(call=b'\x12\x34\x56\x78'+encode_forward()[4:]))
        self.assertEqual(r['result'],'INVALID_HINT_CENSORED')

    def test_truncated_forwarder_and_padded_data_are_rejected(self):
        self.assertEqual(g.inspect_event(event(call=encode_forward()[:-5]))['result'],
                         'INVALID_HINT_CENSORED')
        bad=encode_forward()+bytes(32)
        self.assertEqual(g.inspect_event(event(call=bad))['result'],
                         'INVALID_HINT_CENSORED')

    def test_report_unsorted_or_zero_fails_closed(self):
        for values in [(5,4,6),(0,2,3)]:
            raw=encode_forward(nested=encode_secondary(encode_report(values)))
            self.assertEqual(g.inspect_event(event(call=raw))['result'],
                             'INVALID_HINT_CENSORED')

    def test_int192_sign_extension_and_negative_price_rejected(self):
        raw=encode_forward(nested=encode_secondary(encode_report((-1,2,3))))
        self.assertEqual(g.inspect_event(event(call=raw))['result'],'INVALID_HINT_CENSORED')
        raw=encode_forward(nested=encode_secondary(encode_report((1,2,1<<191))))
        self.assertEqual(g.inspect_event(event(call=raw))['result'],'INVALID_HINT_CENSORED')

    def test_signature_region_alias_fails(self):
        raw=bytearray(encode_forward())
        nested, _ = g.decode_forward(bytes(raw))
        self.assertEqual(nested,g.WETH_AGGREGATOR)
        # Direct test validates transport-private signer arrays cannot alias report.
        tx=bytearray(encode_secondary())
        tx[4+128:4+160]=word(224)
        with self.assertRaises(g.InvalidHint):
            g.decode_secondary(bytes(tx))

    def test_duplicate_json_and_nonstandard_constants_rejected(self):
        self.assertEqual(g.inspect_event(b'{"hash":"0x'+b'ab'*32+b'","hash":"duplicate"}')['result'],
                         'INVALID_HINT_CENSORED')
        self.assertEqual(g.inspect_event(b'{"hash":NaN}')['result'],
                         'INVALID_HINT_CENSORED')

    def test_deadline_requires_authenticated_source_and_independent_cutoff(self):
        self.assertEqual(g.deadline_gate(actual_source_proven=False,
             recv_monotonic_ns=1,ready_monotonic_ns=2,independent_builder_cutoff_ns=10),
             'INCOMPLETE_NO_AUTHENTICATED_SOURCE_OR_CLOCK')
        self.assertEqual(g.deadline_gate(actual_source_proven=True,
             recv_monotonic_ns=1,ready_monotonic_ns=2),
             'INCOMPLETE_BUILDER_DEADLINE_UNKNOWN')

    def test_deadline_after_cutoff_fails(self):
        self.assertEqual(g.deadline_gate(actual_source_proven=True,
             recv_monotonic_ns=2,ready_monotonic_ns=6,independent_builder_cutoff_ns=6),
             'FAIL_PREPARED_AT_OR_AFTER_BUILDER_CUTOFF')

    def test_only_real_documented_cutoff_can_produce_narrow_prepared_status(self):
        self.assertEqual(g.deadline_gate(actual_source_proven=True,
             recv_monotonic_ns=2,ready_monotonic_ns=6,independent_builder_cutoff_ns=7),
             'PREPARED_BEFORE_CUTOFF_ONLY_NOT_INCLUSION_OR_PROFIT')


if __name__=='__main__':
    unittest.main()
