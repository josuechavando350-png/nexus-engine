"""Strict canonical Aave oracle-chain, two-source and anti-SVR tests (NO TRADE)."""
from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Lock
import copy
import json
import time
import unittest

import aave_three_asset_live_oracle_route as m

HEIGHT=26_299_805
H="0x"+"aa"*32
P="0x"+"bb"*32
ROOT="0x"+"cc"*32
PROVIDER="0x"+"11"*20
ORACLE="0x"+"22"*20
SOURCE={"WETH":"0x"+"31"*20,"USDC":"0x"+"32"*20,
        "USDT":"0x"+"33"*20}
AGG="0x"+"40"*20
PRICE={"WETH":254164650000,"USDC":100000000,"USDT":99850000}
ABI_RUNTIME="0x"+"6001600055"*7


def word(n):
    return "0x"+f"{n:064x}"


def signed_word(n):
    return f"{(n+(1<<256) if n<0 else n):064x}"


class VirtualTimer:
    def __init__(self):
        self.value=100.0
        self.lock=Lock()
    def now(self):
        with self.lock:return self.value
    def sleep(self,n):
        with self.lock:self.value+=n


class Fixture:
    def __init__(self,mode=None):
        self.mode=mode
        self.calls=[]
        self.lock=Lock()
        self.head_calls={"drpc":0,"publicnode":0}
        self.clock={}
        self.timestamp=int(time.time())-27

    def get_transport(self,provider):
        def transport(url,method,args):
            if url!=m.borrow.RPC_ENDPOINTS[provider]:
                raise AssertionError("foreign provider URL")
            with self.lock:
                self.calls.append((provider,method,copy.deepcopy(args)))
            if method=="eth_chainId":
                return "0x2" if self.mode=="wrong_chain" and provider=="publicnode" else "0x1"
            if method=="eth_blockNumber":
                return hex(HEIGHT+12 if self.mode=="tip_split" and provider=="publicnode"
                           else HEIGHT+2)
            if method=="eth_getBlockByNumber":
                if args!=[hex(HEIGHT),False]:
                    raise AssertionError("unexpected block read")
                with self.lock:
                    self.head_calls[provider]+=1
                    nth=self.head_calls[provider]
                changed=(self.mode=="wrong_header" and provider=="publicnode" or
                         self.mode=="reorg" and nth>1 and provider=="drpc")
                return {
                    "number":hex(HEIGHT),
                    "hash":"0x"+"dd"*32 if changed else H,
                    "parentHash":P,"stateRoot":ROOT,
                    "timestamp":hex(self.timestamp-400 if self.mode=="stale" else self.timestamp)
                }
            if method=="eth_getCode":
                address,block=args
                if block!={"blockHash":H,"requireCanonical":True}:
                    raise AssertionError("not fixed block EIP1898")
                if self.mode=="no_code" and address==SOURCE["WETH"]:
                    return "0x"
                if self.mode=="code_diverge" and provider=="publicnode" and address==ORACLE:
                    return "0x6002600055"
                return ABI_RUNTIME
            if method!="eth_call":
                raise AssertionError("nonread-only method unexpectedly requested")
            tx,block=args
            if block!={"blockHash":H,"requireCanonical":True}:
                raise AssertionError("eth_call not canonical")
            address=tx["to"]
            data=tx["data"]
            if address==m.POOL and data==m.SELECTORS["ADDRESSES_PROVIDER"]:
                return word(int(PROVIDER,16))
            if address==PROVIDER and data==m.SELECTORS["getPriceOracle"]:
                return word(int(ORACLE,16))
            if address==ORACLE:
                if data==m.SELECTORS["BASE_CURRENCY"]:
                    return word(0)
                if data==m.SELECTORS["BASE_CURRENCY_UNIT"]:
                    return word(0 if self.mode=="zero_unit" else 10**8)
                for sym,asset in m.ASSETS:
                    if data==m.call_address(m.SELECTORS["getSourceOfAsset"],asset):
                        if self.mode=="source_diverge" and provider=="publicnode" and sym=="WETH":
                            return word(int(SOURCE["USDC"],16))
                        return word(int(SOURCE[sym],16))
                    if data==m.call_address(m.SELECTORS["getAssetPrice"],asset):
                        amount=PRICE[sym]
                        if self.mode=="price_diverge" and provider=="publicnode" and sym=="WETH":
                            amount+=1
                        if self.mode=="zero_price" and sym=="USDC":
                            amount=0
                        return word(amount)
                raise AssertionError("bad Oracle calldata")
            if address in set(SOURCE.values()):
                if data==m.SELECTORS["aggregator"]:
                    if self.mode=="aggregator_absent":
                        raise m.SourceSelectorUnavailable("execution reverted; no ABI selector")
                    if self.mode=="http429" and provider=="publicnode":
                        raise OSError("HTTP 429 source unavailable")
                    return word(int(AGG,16)) if address==SOURCE["WETH"] else word(0)
                if data==m.SELECTORS["decimals"]:
                    return word(8)
                if data==m.SELECTORS["latestRoundData"]:
                    if self.mode=="round_absent":
                        raise m.SourceSelectorUnavailable("execution reverted; no latestRoundData")
                    val=(-1 if self.mode=="negative_round" and
                         address==SOURCE["USDT"] else 254164650000)
                    if self.mode=="round_malformed" and address==SOURCE["WETH"]:
                        return "0x1234"
                    return "0x"+("".join([signed_word(8),signed_word(val),
                          signed_word(self.timestamp-150),signed_word(self.timestamp-1),
                          signed_word(8)]))
                raise AssertionError("unapproved source selector")
            if address==AGG:
                if data!=m.SELECTORS["latestRoundData"]:
                    raise AssertionError("only one-hop aggregator round read authorized")
                if self.mode=="aggregator_inner_absent":
                    raise m.SourceSelectorUnavailable("execution reverted: optional selector")
                if self.mode=="aggregator_inner_429":
                    raise OSError("HTTP 429 from one-hop aggregator public source")
                return "0x"+("".join([
                    signed_word(8),signed_word(PRICE["WETH"]),
                    signed_word(self.timestamp-150),
                    signed_word(self.timestamp-1),signed_word(8),
                ]))
            raise AssertionError("not one of the authenticated routing contracts")
        return transport


class ThreeAssetOracleRouteTests(unittest.TestCase):
    def make(self,mode=None):
        with TemporaryDirectory() as p:
            folder=Path(p)
            f=Fixture(mode)
            def reader_factory(provider,transport):
                timer=VirtualTimer()
                f.clock[provider]=timer
                return m.RPC(provider,transport,
                             clock=timer.now,sleeper=timer.sleep)
            report=m.collect(folder,transport_factory=f.get_transport,
                             reader_factory=reader_factory)
            seal=json.loads((folder/"assets-and-ABI-sealed-before-network.json").read_text())
            return report,f,seal

    def test_known_pool_and_three_original_asset_identifiers_are_fixed(self):
        self.assertEqual([x for x,_ in m.ASSETS],["WETH","USDC","USDT"])
        self.assertEqual(m.POOL,"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2")
        self.assertEqual(m.SELECTORS["ADDRESSES_PROVIDER"],"0x0542975c")
        self.assertEqual(m.SELECTORS["getPriceOracle"],"0xfca513a8")
        self.assertEqual(m.SELECTORS["getSourceOfAsset"],"0x92bf2be0")

    def test_complete_immutable_oracle_route_and_six_bytecode_hashes(self):
        r,f,seal=self.make()
        self.assertEqual(r["status"],
            "CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY")
        self.assertEqual(r["errors"],[])
        self.assertEqual(r["block"]["number"],HEIGHT)
        self.assertEqual(r["pool_provider_oracle"]["pool_addresses_provider"],PROVIDER)
        self.assertEqual(r["pool_provider_oracle"]["onchain_price_oracle"],ORACLE)
        self.assertEqual(len(r["asset_routes"]),3)
        self.assertEqual([v["aave_oracle_registered_source"] for v in r["asset_routes"]],
                         list(SOURCE.values()))
        self.assertTrue(r["EIP1898_same_canonical_block_two_public_source_parity"])
        self.assertTrue(r["pool_provider_oracle"]["all_contract_runtime_equal_two_sources"])

    def test_original_asset_seal_is_written_before_first_new_RPC(self):
        with TemporaryDirectory() as path:
            target=Path(path)
            f=Fixture()
            def wrap(provider):
                upstream=f.get_transport(provider)
                def check(url,method,args):
                    self.assertTrue((target/"assets-and-ABI-sealed-before-network.json").is_file())
                    return upstream(url,method,args)
                return check
            def reader_factory(provider,transport):
                timer=VirtualTimer()
                return m.RPC(provider,transport,
                             clock=timer.now,sleeper=timer.sleep)
            r=m.collect(target,transport_factory=wrap,reader_factory=reader_factory)
            self.assertEqual(r["status"],
                "CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY")
            self.assertEqual(f.calls[0][1],"eth_chainId")

    def test_every_ethereum_RPC_is_readonly_canonical_when_state_sensitive(self):
        r,f,_=self.make()
        self.assertTrue(all(method in {"eth_chainId","eth_blockNumber",
            "eth_getBlockByNumber","eth_getCode","eth_call"}
            for _,method,_ in f.calls))
        self.assertEqual(set(p for p,_,_ in f.calls),{"drpc","publicnode"})
        self.assertTrue(all(arg[1]=={"blockHash":H,"requireCanonical":True}
            for _,method,arg in f.calls if method in ("eth_getCode","eth_call")))
        self.assertLessEqual(max(r["source_rpc_call_counts"].values()),m.MAX_CALLS)

    def test_same_block_Aave_prices_and_base_unit_not_feed_price_guess(self):
        r,_,_=self.make()
        self.assertEqual(r["pool_provider_oracle"]["oracle_base_currency_unit"],"100000000")
        self.assertIsNone(r["pool_provider_oracle"]["oracle_base_currency"])
        self.assertEqual([int(x["oracle_get_asset_price_raw"]) for x in r["asset_routes"]],
                         list(PRICE.values()))
        self.assertTrue(all(v["do_not_interpret_source_rounddata_as_same_economic_price"]
                            for v in r["asset_routes"]))

    def test_one_optional_source_aggregator_hop_is_not_SVR_onboarding(self):
        r,_,_=self.make()
        self.assertEqual(r["asset_routes"][0][
            "optional_resolved_one_hop_aggregator"]["address"],AGG)
        onehop=r["asset_routes"][0]["optional_resolved_one_hop_aggregator"]
        self.assertEqual(onehop["optional_onchain_one_hop_aggregator_round"]["status"],
                         "SELECTOR_RESPONSE_IDENTICAL_TWO_SOURCES")
        self.assertTrue(onehop["optional_onchain_one_hop_aggregator_round"][
            "answer_equals_oracle_price_raw_not_a_price_unit_certification"])
        self.assertTrue(onehop["optional_onchain_one_hop_aggregator_round"][
            "answer_equals_source_wrapper_round_raw_if_available"])
        self.assertTrue(onehop[
            "still_not_a_private_svr_or_orderflow_access_certificate"])
        self.assertTrue(r["source_address_does_not_prove_dedicated_Chainlink_SVR"])
        self.assertFalse(r["asset_routes"][0]["SVR_eligible_private_update_channel_proven"])
        self.assertFalse(r["first_seen_pre_inclusion_report"])
        self.assertFalse(r["nqc_live_profit_or_sponsorship_proven"])

    def test_one_hop_round_signed_age_is_measured_not_assumed_fresh(self):
        r,fixture,_=self.make()
        w=r["asset_routes"][0]
        h=w["optional_source_round_data"]
        self.assertEqual(h["signed_age_relative_to_canonical_block_seconds"],
                         r["block"]["timestamp"]-(fixture.timestamp-1))
        self.assertTrue(h["oracle_price_equals_source_answer_at_same_decimals"])
        self.assertFalse(w["SVR_eligible_private_update_channel_proven"])

    def test_inner_aggregator_explicit_selector_revert_is_optional_not_svr_denial(self):
        r,_,_=self.make("aggregator_inner_absent")
        self.assertEqual(r["status"],
            "CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY")
        nested=r["asset_routes"][0]["optional_resolved_one_hop_aggregator"][
            "optional_onchain_one_hop_aggregator_round"]
        self.assertEqual(nested["status"],
            "SOURCE_SELECTOR_UNAVAILABLE_NO_PRIVATE_ACCESS_PROOF")

    def test_inner_aggregator_transport_429_is_fatal_source_incomplete(self):
        r,_,_=self.make("aggregator_inner_429")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertTrue(r["errors"])
        self.assertFalse(r["EIP1898_same_canonical_block_two_public_source_parity"])

    def test_source_without_aggregator_selector_remains_explicitly_unknown(self):
        r,_,_=self.make("aggregator_absent")
        self.assertEqual(r["status"],
            "CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY")
        self.assertTrue(all(x["optional_source_aggregator_selector"]["status"]==
            "SOURCE_SELECTOR_UNAVAILABLE_NO_PRIVATE_ACCESS_PROOF"
                            for x in r["asset_routes"]))
        self.assertTrue(all(x["optional_resolved_one_hop_aggregator"] is None
                            for x in r["asset_routes"]))

    def test_feed_without_rounddata_selector_not_falsely_treated_as_stale(self):
        r,_,_=self.make("round_absent")
        self.assertEqual(r["status"],
            "CURRENT_AAVE_THREE_ASSET_ONCHAIN_ORACLE_ROUTE_NO_SVR_AUTHORITY")
        self.assertTrue(all(x["optional_source_round_data"]["status"]==
            "SOURCE_SELECTOR_UNAVAILABLE_NO_PRIVATE_ACCESS_PROOF" for x in r["asset_routes"]))

    def test_source_negative_round_answer_does_not_replace_Aave_asset_price(self):
        r,_,_=self.make("negative_round")
        self.assertEqual(r["asset_routes"][2]["optional_source_round_data"][
            "decoded"]["signed_answer_raw"],"-1")
        self.assertEqual(int(r["asset_routes"][2]["oracle_get_asset_price_raw"]),PRICE["USDT"])

    def test_offchain_rejection_or_wrong_chain_is_censored_not_feed_absence(self):
        r,_,_=self.make("wrong_chain")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertTrue(r["errors"])
        self.assertEqual(r["asset_routes"],[])

    def test_canonical_provider_header_disagreement_censors_routing(self):
        r,_,_=self.make("wrong_header")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertIsNone(r["pool_provider_oracle"])
        self.assertEqual(len(r["asset_routes"]),0)

    def test_provider_oracle_runtime_bytecode_divergence_censored(self):
        r,_,_=self.make("code_diverge")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertTrue(r["errors"])

    def test_source_address_conflict_censors_routing(self):
        r,_,_=self.make("source_diverge")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertLess(len(r["asset_routes"]),3)

    def test_current_Aave_price_cross_source_mismatch_censored(self):
        r,_,_=self.make("price_diverge")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertTrue(r["errors"])

    def test_unconfigured_zero_price_cannot_promote_three_valid_routes(self):
        r,_,_=self.make("zero_price")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")

    def test_feed_code_absent_is_not_source_verified(self):
        r,_,_=self.make("no_code")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")

    def test_bad_chain_tip_or_block_age_not_called_oracle(self):
        for mode in ("tip_split","stale"):
            with self.subTest(mode=mode):
                r,f,_=self.make(mode)
                self.assertEqual(r["status"],
                    "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
                self.assertIsNone(r["pool_provider_oracle"])

    def test_reorg_after_collection_fails_even_with_all_initial_parity(self):
        r,_,_=self.make("reorg")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertFalse(r["EIP1898_same_canonical_block_two_public_source_parity"])

    def test_malformed_source_round_data_censored_not_proven_chainlink(self):
        r,_,_=self.make("round_malformed")
        self.assertEqual(r["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")

    def test_transport_rate_limit_cannot_be_misclassified_as_optional_selector_absence(self):
        report,_,_=self.make("http429")
        self.assertEqual(report["status"],
            "INCOMPLETE_AAVE_ORACLE_ROUTE_SOURCE_NOT_SVR_DENIAL")
        self.assertFalse(report["EIP1898_same_canonical_block_two_public_source_parity"])
        self.assertTrue(report["errors"])

    def test_only_verified_JSONRPC_EVM_reverts_map_to_optional_absence(self):
        response={"jsonrpc":"2.0","id":433,"error":{
            "code":3,"message":"execution reverted: selector not available"}}
        call=m.RPC.network
        from unittest.mock import patch
        class FakeHTTP:
            def __enter__(self):return self
            def __exit__(self,*args):return False
            def read(self,n):return m.canonical(response)
        with patch.object(m,"urlopen",return_value=FakeHTTP()):
            with self.assertRaises(m.SourceSelectorUnavailable):
                call(m.borrow.RPC_ENDPOINTS["drpc"],"eth_call",
                     [{"to":m.POOL,"data":m.SELECTORS["ADDRESSES_PROVIDER"]},
                      {"blockHash":"0x"+"ab"*32,"requireCanonical":True}])
        response["error"]={"code":429,"message":"execution reverted: rate limit"}
        with patch.object(m,"urlopen",return_value=FakeHTTP()):
            with self.assertRaises(m.Rejected) as error:
                call(m.borrow.RPC_ENDPOINTS["drpc"],"eth_call",
                     [{"to":m.POOL,"data":m.SELECTORS["ADDRESSES_PROVIDER"]},
                      {"blockHash":"0x"+"ab"*32,"requireCanonical":True}])
            self.assertNotIsInstance(error.exception,m.SourceSelectorUnavailable)

    def test_decimals_and_zero_address_ABI_validation(self):
        self.assertIsNone(m.optional_address_word(word(0)))
        self.assertEqual(m.address_word(word(int(PROVIDER,16))),PROVIDER)
        with self.assertRaises(m.Rejected):
            m.address_word(word(0))
        with self.assertRaises(m.Rejected):
            m.address_word("0x1234")
        with self.assertRaises(m.Rejected):
            m.word_int("0x1234")

    def test_methods_reject_arbitrary_assets_and_ETH_writes(self):
        client=m.RPC("drpc",lambda *_:None)
        for method,args in (
            ("eth_sendRawTransaction",["0x1234"]),
            ("eth_sendTransaction",[]),
            ("eth_getLogs",[]),
            ("eth_call",[{"to":ORACLE,"data":m.SELECTORS["getPriceOracle"]},
                        {"blockHash":H,"requireCanonical":True}]),
        ):
            with self.subTest(method=method),self.assertRaises(m.Rejected):
                client.call(method,args)
        self.assertEqual(client.calls,0)
        with self.assertRaises(m.Rejected):
            m.call_address(m.SELECTORS["getAssetPrice"],"0x"+"ff"*20 if False else "X")

    def test_no_canonical_route_or_risk_claim_without_positive_source(self):
        r,_,_=self.make()
        self.assertFalse(r["signed_or_submitted_mainnet_tx"])
        self.assertFalse(r["market_wide_opportunity_recurrence_proven"])
        self.assertFalse(r["commercial_score_upgrade"])
        self.assertFalse(r["RMC_closed"])
        self.assertFalse(r["P2_shadow_certified"])
        self.assertFalse(r["canary_live_authorized"])
        self.assertFalse(r["user_mxn2000_spent"])
        self.assertTrue(r["OWN_CAPITAL_ZERO_INCLUDING_GAS_UNCHANGED"])
        self.assertEqual(r["nqc_realized_pnl_usd"],"0")


if __name__=="__main__":
    unittest.main()
