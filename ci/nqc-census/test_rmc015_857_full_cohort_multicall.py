#!/usr/bin/env python3
"""Adversarial onchain multicall EVM array encoding and full-cohort accounting."""
import copy
import unittest
from unittest.mock import patch
import rmc015_857_full_cohort_multicall as m
import rmc015_post_anchor_causal_sampler as origin
from test_rmc015_post_anchor_causal_sampler import fixture

R="0x"+"a"*64
S="0x"+"b"*64
T="0x"+"c"*64
CODE="0x"+"5b00"*650
OPERATORS=[("drpc","dRPC","https://drpc.invalid"),
           ("blast","BlastAPI","https://blast.invalid")]


def fixture_result(health, debt):
    payload=[10**16,debt,0,8500,7500,health]
    return b"".join(m.uint_word(x) for x in payload)


def result_bytes(states):
    n=len(states)
    tuples=[]
    offsets=[]
    off=32*n
    for health,debt in states:
        item=m.uint_word(1)+m.uint_word(64)+m.uint_word(192)+fixture_result(health,debt)
        offsets.append(m.uint_word(off))
        off+=len(item)
        tuples.append(item)
    return "0x"+(m.uint_word(32)+m.uint_word(n)+b"".join(offsets)+b"".join(tuples)).hex()


def calldata_account_addresses(payload):
    assert payload.startswith(m.AGGREGATE3)
    data=bytes.fromhex(payload[10:])
    assert int.from_bytes(data[:32],"big")==32
    n=int.from_bytes(data[32:64],"big")
    assert 1<=n<=m.BATCH_SIZE
    table=64
    result=[]
    for i in range(n):
        off=int.from_bytes(data[table+i*32:table+(i+1)*32],"big")
        start=table+off
        assert data[start:start+32] == bytes.fromhex(origin.POOL[2:]).rjust(32,b"\x00")
        assert int.from_bytes(data[start+32:start+64],"big")==0
        assert int.from_bytes(data[start+64:start+96],"big")==96
        assert int.from_bytes(data[start+96:start+128],"big")==36
        assert data[start+128:start+132] == bytes.fromhex(origin.GET_ACCOUNT_DATA[2:])
        result.append("0x"+data[start+144:start+164].hex())
    return result


def rpc(url,method,params):
    if method=="eth_chainId":
        return "0x1"
    if method=="eth_getBlockByNumber":
        n=int(params[0],16)
        assert params[1] is False
        if n==origin.ANCHOR:
            return {"number":hex(n),"hash":origin.ANCHOR_HASH,"parentHash":R,
                    "stateRoot":T,"timestamp":"0x64"}
        if n==origin.FIRST:
            return {"number":hex(n),"hash":S,"parentHash":origin.ANCHOR_HASH,
                    "stateRoot":T,"timestamp":"0x70"}
        if n==origin.LATER:
            return {"number":hex(n),"hash":R,"parentHash":S,
                    "stateRoot":T,"timestamp":"0x80"}
    if method=="eth_getCode":
        assert params[0]==m.MULTICALL and params[1] in tuple(hex(x) for x in m.BLOCKS)
        return CODE
    if method=="eth_call":
        tx,block=params
        assert tx["to"]==m.MULTICALL
        assert tx["gas"]==hex(m.ABSOLUTE_MAX_ETH_CALL_GAS)
        assert block in tuple(hex(x) for x in m.BLOCKS)
        addresses=calldata_account_addresses(tx["data"])
        states=[]
        for addr in addresses:
            idx=int(addr,16)
            if block==hex(origin.FIRST):
                states.append((origin.WAD+idx,1_000_000))
            elif idx%10==0:
                states.append((origin.WAD-1,2_000_000))
            elif idx%8==0:
                states.append((2**256-1,0))
            else:
                states.append((origin.WAD+idx,1_000_000))
        return result_bytes(states)
    raise AssertionError("unexpected RPC method")


class TestFull857CohortMulticall(unittest.TestCase):
    def runreal(self,call=rpc,providers=OPERATORS):
        s,b=fixture()
        return m.assess(s,b,call=call,providers=providers)

    def test_abi_roundtrip_20_independent_response_fixture(self):
        addresses=["0x"+f"{n:040x}" for n in range(1,21)]
        calldata=m.encode_batch(addresses)
        self.assertEqual(calldata_account_addresses(calldata),addresses)
        r=m.decode_batch(result_bytes([(origin.WAD+i,1_000_000) for i in range(20)]),20)
        self.assertEqual(len(r),20)
        self.assertEqual(r[-1]["hf"],origin.WAD+19)

    def test_857_all_healthy_source_members_and_all_two_future_states(self):
        x=self.runreal()
        self.assertEqual(x["status"],"RMC015_857_FIXED_COHORT_MULTICALL_FUTURE_STATE_PASS_NOT_CAPTURE")
        self.assertEqual(x["borrowers_fixed_using_only_anchor_data"],857)
        self.assertEqual(x["future_block_numbers"],[origin.FIRST,origin.LATER])
        for n in m.BLOCKS:
            counts=x["future_full_population_observations"][str(n)]["end_snapshot_counts"]
            self.assertEqual(sum(counts.values()),857)
        self.assertEqual(x["future_full_population_observations"][str(origin.FIRST)][
            "end_snapshot_counts"]["BELOW_ONE_AT_ENDPOINT"],0)
        self.assertGreater(x["future_full_population_observations"][str(origin.LATER)][
            "end_snapshot_counts"]["BELOW_ONE_AT_ENDPOINT"],0)
        self.assertGreater(x["future_full_population_observations"][str(origin.LATER)][
            "end_snapshot_counts"]["NO_DEBT_AT_ENDPOINT"],0)
        self.assertEqual(x["report_sha256"],origin.sha(origin.canonical(
            {k:v for k,v in x.items() if k!="report_sha256"})))

    def test_identity_and_economic_nonclaims_fail_closed(self):
        x=self.runreal()
        self.assertFalse(x["lookahead_used_to_select_cohort"])
        for key in (
          "three_account_states_entire_time_window_reconstructed",
          "competitor_winning_transactions_used_to_select_cohort",
          "sample_representative_of_all_protocol_accounts",
          "early_signal_captured_by_nqc_live",
          "winner_inclusion_and_builder_auction_measured",
          "nqc_nonrecourse_gas_or_external_capital_approved",
          "route_executable_or_liquidation_bonus_proven",
          "nqc_monthly_income_15k_55k_predicted",
          "rmc015_terminal_closed","real_market_census_closed",
        ):
            self.assertIs(x[key],False,key)
        self.assertEqual(x["nqc_realized_net_profit_usd"],"0")

    def test_abi_no_empty_or_above_batch(self):
        with self.assertRaisesRegex(ValueError,"batch size"):
            m.encode_batch([])
        with self.assertRaisesRegex(ValueError,"batch size"):
            m.encode_batch(["0x"+"1"*40]*21)

    def test_corrupted_array_abi_success_fail(self):
        response=bytearray(bytes.fromhex(result_bytes([(origin.WAD,100)])[2:]))
        response[64:96]=m.uint_word(32)
        self.assertEqual(m.decode_batch("0x"+response.hex(),1)[0]["debt"],100)
        response[96:128]=m.uint_word(0)
        with self.assertRaisesRegex(ValueError,"failed"):
            m.decode_batch("0x"+response.hex(),1)

    def test_single_missing_return_rejected(self):
        with self.assertRaisesRegex(ValueError,"members"):
            m.decode_batch(result_bytes([(origin.WAD,100)]),2)

    def test_disallowed_noncanonical_tuple_offsets(self):
        response=bytearray(bytes.fromhex(result_bytes([(origin.WAD,100)])[2:]))
        response[64:96]=m.uint_word(0)
        with self.assertRaisesRegex(ValueError,"tuple offset"):
            m.decode_batch("0x"+response.hex(),1)

    def test_truncated_abi_fails(self):
        b=result_bytes([(origin.WAD,100)])
        with self.assertRaises(ValueError):
            m.decode_batch(b[:-64],1)

    def test_unknown_parent_hash_or_anchor_reorg_fails(self):
        def bad(url,method,params):
            x=rpc(url,method,params)
            if method=="eth_getBlockByNumber" and int(params[0],16)==origin.FIRST:
                x["parentHash"]=R
            return x
        with self.assertRaisesRegex(ValueError,"child"):
            self.runreal(call=bad)

    def test_multicall_historical_code_missing_fails(self):
        def bad(url,method,params):
            return "0x" if method=="eth_getCode" else rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"not deployed"):
            self.runreal(call=bad)

    def test_cross_operator_future_state_mismatch_fails(self):
        def bad(url,method,params):
            x=rpc(url,method,params)
            if "blast.invalid" in url and method=="eth_call":
                tx,block=params
                if block==hex(origin.LATER):
                    n=len(calldata_account_addresses(tx["data"]))
                    return result_bytes([(origin.WAD+100,5_000_000)]*n)
            return x
        with self.assertRaisesRegex(ValueError,"mismatch"):
            self.runreal(call=bad)

    def test_pseudodiverse_sources_disallowed(self):
        with self.assertRaisesRegex(ValueError,"independent"):
            self.runreal(providers=[OPERATORS[0],OPERATORS[0]])

    def test_wrong_chain_rejected(self):
        def bad(url,method,params):
            return "0x2" if method=="eth_chainId" else rpc(url,method,params)
        with self.assertRaisesRegex(ValueError,"not Ethereum"):
            self.runreal(call=bad)

    def test_no_private_addresses_in_output(self):
        s,b=fixture()
        x=self.runreal()
        raw=origin.canonical(x)
        for row in b.splitlines():
            addr=origin.unique_json(row)["account"]
            self.assertNotIn(addr.encode(),raw)
        self.assertNotIn(b'"identity_commitment"',raw)

    def test_zero_source_watchlist_digest_fails(self):
        s,b=fixture()
        s["watchlist_commitment_sha256"]="0"*64
        with self.assertRaisesRegex(ValueError,"watchlist SHA256"):
            m.all_preselected(s,b)

    def test_eth_call_gas_is_bounded(self):
        x=self.runreal()
        self.assertEqual(m.ABSOLUTE_MAX_ETH_CALL_GAS,30_000_000)

    def test_full_857_batch_cardinality_includes_last_partial(self):
        self.assertEqual(m.BATCH_SIZE,20)
        self.assertEqual(m.EXPECTED_BORROWERS,857)
        self.assertEqual(sum(min(20,857-i) for i in range(0,857,20)),857)


if __name__=="__main__":
    unittest.main()
