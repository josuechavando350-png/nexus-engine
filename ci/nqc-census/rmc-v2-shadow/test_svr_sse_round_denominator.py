#!/usr/bin/env python3
"""Offline deterministic adversarial unit tests for prospective source witness."""
import io
import json
import unittest

import svr_sse_round_denominator as audit
import svr_channel_access_probe as channel

H="0x"+"aa"*32
P="0x"+"bb"*32
ROOT="0x"+"cc"*32
HEIGHT=26194510

def word(v):
    return int(v).to_bytes(32,"big").hex()

def rounddata(rid=120,price=241004830000,updated=125):
    return "0x"+"".join(word(v) for v in (rid,price,updated-5,updated,rid))

class Stub:
    def __init__(self, variant="ok"):
        self.variant=variant
        self.calls=0
        self.transcript=[]
        self.seen=[]
    def call(self,meth,args):
        self.calls+=1
        self.seen.append((meth,args))
        if meth=="eth_chainId":
            return "0x2" if self.variant=="other_chain" else "0x1"
        if meth=="eth_blockNumber":
            return hex(HEIGHT+2)
        if meth=="eth_getBlockByNumber":
            return {"number":hex(HEIGHT),"hash":H if self.variant!="header_split" else "0x"+"dd"*32,
                    "parentHash":P,"stateRoot":ROOT,"timestamp":hex(170)}
        if meth=="eth_getCode":
            return "0x60006001"
        if meth=="eth_call":
            if args[0]["data"]==audit.AGGREGATOR_SELECTOR:
                value=int(audit.WETH_AGGREGATOR,16)
                if self.variant=="wrong_aggregator":value=12345
                return "0x"+word(value)
            if self.variant=="price_split":return rounddata(price=241004830001)
            if self.variant=="time_after_block":return rounddata(updated=180)
            return rounddata()
        raise AssertionError("non-readonly method")

def sample(rid,height):
    return {"block":{"number":height},
            "proxy_round":{"round_id":str(rid),"updated_at":rid+100}}

class WitnessTests(unittest.TestCase):
    def test_known_canonical_target(self):
        self.assertEqual(audit.WETH_PROXY,"0x5424384b256154046e9667ddfaaa5e550145215e")
        self.assertEqual(audit.WETH_AGGREGATOR,"0x7c7fdfca295a787ded12bb5c1a49a8d2cc20e3f8")

    def test_round_decoder_positive_integer_and_abi(self):
        r=audit.decode_round(rounddata())
        self.assertEqual(r["answer_raw"],"241004830000")
        self.assertEqual(r["updated_at"],125)
        with self.assertRaises(audit.Reject):
            audit.decode_round("0x1234")
        with self.assertRaises(audit.Reject):
            audit.decode_round(rounddata(price=0))
        with self.assertRaises(audit.Reject):
            audit.decode_round(rounddata(price=2**256-1))

    def test_aggregator_address_word_strict(self):
        self.assertEqual(audit.decode_address("0x"+word(int(audit.WETH_AGGREGATOR,16))),
                         audit.WETH_AGGREGATOR)
        for bad in (0, 2**160):
            with self.assertRaises(audit.Reject):
                audit.decode_address("0x"+word(bad))

    def test_rpc_deny_sign_broadcast_bundles_arbitrary_reads(self):
        rpc=audit.ReadOnly("drpc",transport=lambda *args:None,
                           sleeper=lambda _:None,monotonic=lambda:1.0)
        bad=[
            ("eth_sendRawTransaction",["0xaaa"]),
            ("eth_sign",["0x00"]),
            ("mev_sendBundle",[]),
            ("eth_getLogs",[]),
            ("eth_call",[{"to":audit.WETH_PROXY,"data":"0xdeadbeef"},
                         {"blockHash":H,"requireCanonical":True}]),
            ("eth_call",[{"to":audit.WETH_PROXY,"data":audit.ROUND_SELECTOR},"latest"]),
            ("eth_getCode",["0x"+"11"*20,{"blockHash":H,"requireCanonical":True}]),
        ]
        for method,params in bad:
            with self.subTest(method=method,params=params):
                with self.assertRaises(audit.Reject):
                    rpc.call(method,params)
        self.assertEqual(rpc.calls,0)

    def test_pinned_dual_source_success_and_unchanged_headers(self):
        left,right=Stub(),Stub()
        snap=audit.snapshot({"drpc":left,"publicnode":right})
        self.assertTrue(snap["same_block_two_RPC_parity"])
        self.assertEqual(snap["proxy_round"]["round_id"],"120")
        for src in (left,right):
            pins=[params[1] for method,params in src.seen
                  if method in ("eth_getCode","eth_call")]
            self.assertTrue(pins)
            self.assertTrue(all(p=={"blockHash":H,"requireCanonical":True} for p in pins))

    def test_wrong_chain_fatal(self):
        with self.assertRaises(audit.Reject):
            audit.snapshot({"drpc":Stub(),"publicnode":Stub("other_chain")})

    def test_source_disagreement_is_not_negative_oracle_update(self):
        for variant in ("header_split","wrong_aggregator","price_split","time_after_block"):
            with self.subTest(variant=variant):
                with self.assertRaises(audit.Reject):
                    audit.snapshot({"drpc":Stub(),"publicnode":Stub(variant)})

    def test_no_round_advance_has_no_target_recall_denominator(self):
        a,b=sample(120,10),sample(120,30)
        self.assertEqual(audit.classify(a,b,{"status":"PROSPECTIVE_SOURCE_LOCAL_HINTS_OBSERVED_NOT_PREINCLUSION_PROOF"}),
                         "NO_WETH_ROUND_ADVANCE_BETWEEN_PINNED_BOOKENDS")

    def test_no_round_advance_with_truncated_sse_must_be_censored(self):
        a,b=sample(120,10),sample(120,30)
        self.assertEqual(audit.classify(a,b,{"status":"BOUNDED_SSE_BYTE_CAP_INCOMPLETE"}),
                         "NO_WETH_ROUND_ADVANCE_SSE_CENSORED")

    def test_round_advance_not_builder_or_inclusion_proof(self):
        a,b=sample(120,10),sample(121,30)
        self.assertEqual(audit.classify(a,b,{"status":"PROSPECTIVE_SOURCE_LOCAL_HINTS_OBSERVED_NOT_PREINCLUSION_PROOF"}),
                         "WETH_FEED_CHANGED_IN_BOOKENDS_NOT_PREINCLUSION_PROOF")
        self.assertEqual(audit.classify(a,b,{"status":"BOUNDED_SSE_EOF_INCOMPLETE"}),
                         "WETH_FEED_CHANGED_BUT_SSE_OBSERVATION_CENSORED")

    def test_reorg_or_missing_bookend_censored(self):
        a,b=sample(121,10),sample(120,30)
        self.assertEqual(audit.classify(a,b,{}),"INCOMPLETE_FEED_ROUND_REGRESSION")
        self.assertEqual(audit.classify(None,b,{}),"INCOMPLETE_MISSING_BOOKEND_SNAPSHOT")
        self.assertEqual(audit.classify(a,a,{}),"INCOMPLETE_NO_FORWARD_CANONICAL_HEIGHT")

    def test_default_prior_public_SSE_budget_unchanged(self):
        self.assertEqual(channel.MAX_STREAM_SECONDS,24)
        self.assertEqual(channel.MAX_STREAM_BYTES,524288)
        self.assertEqual(audit.MAX_SECONDS,180)
        self.assertEqual(audit.MAX_SSE_BYTES,20000000)
        self.assertEqual(audit.MAX_EVENTS,8000)
        with self.assertRaises(ValueError):
            channel.consume_sse(io.BytesIO(b""),max_seconds=181)
        with self.assertRaises(ValueError):
            channel.consume_sse(io.BytesIO(b""),max_bytes=20000001)

    def test_partial_sse_not_economic_capture(self):
        payload=json.dumps({"hash":"0x"+"33"*32,"txs":[{}]}).encode()
        stream=io.BytesIO(b"data:"+payload+b"\n\n")
        r=channel.consume_sse(stream,max_seconds=180,max_bytes=20000000,max_events=8000)
        self.assertEqual(r["partial_hints_censored"],1)
        self.assertEqual(r["decoded_target_unauthenticated"],0)
        self.assertFalse(r["winning_bundle_inclusion_proven"])
        self.assertFalse(r["pre_builder_deadline_proven"])

if __name__=="__main__":
    unittest.main()
