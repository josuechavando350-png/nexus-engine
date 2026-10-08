#!/usr/bin/env python3
"""Adversarial, no-network historical fork-gas budgeting regressions."""
from __future__ import annotations

import copy
from decimal import Decimal
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import zipfile

import rmc016_rank1_fork_gas_budget as m


def fixture_fork_source():
    return {
        "schema_version": 1,
        "status": "RMC016_RANK1_COUNTERFACTUAL_AAVE_WETH_SURPLUS_FORK_PASS_NOT_NET",
        "source_sha256": m.SOURCE_TIME_ZIP_SHA,
        "fork_block_previous": m.BLOCK-1,
        "simulated_execution_block": m.BLOCK,
        "flash_weth_principal_wei": str(m.PRINCIPAL_WEI),
        "actual_pool_flash_fee_wei": str(m.FLASH_FEE_WEI),
        "remaining_weth_after_real_aave_liquidation_and_flash_fee_wei": str(m.SURPLUS_WEI),
        "test_minted_fee_or_collateral_wei": "0",
        "no_original_intrablock_transactions_replayed": True,
        "selected_retroactively_from_competitor": True,
        "native_gas_sponsorship_verified": False,
        "builder_inclusion_and_competition_capture_proven": False,
        "gas_slippage_mev_failure_costs_completely_verified": False,
        "nexus_realized_net_profit_proven": False,
        "real_market_census_closed": False,
    }


def fixture_price():
    return {
        "schema_version":1,
        "status":"TWO_HISTORICAL_WETH_WINNER_PREBLOCK_ORACLE_PRICES_PASS",
        "source_scope":"TWO_OBSERVED_COMPETITOR_WINNERS_NOT_NEXUS",
        "nexus_capture_proven":False,
        "nexus_realized_profitability_proven":False,
        "real_market_census_closed":False,
        "transactions":[{
            "transaction_hash":m.WINNER_TX,
            "block_number":m.BLOCK,
            "preblock":{
                "block":m.BLOCK-1,"hash":m.PREVIOUS_BLOCK_HASH,
                "oracle_usd_base_1e8":str(m.USD_ORACLE_PRICE_1E8),
            },
            "block_end":{"block":m.BLOCK,"hash":m.BLOCK_HASH},
            "two_operator_preblock_oracle_consensus":True,
            "exact_transaction_prestate_proven":False,
        },{
            "transaction_hash":"0x"+"1"*64,
            "block_number":m.BLOCK+1,
        }]
    }


def zip_fixture(path: Path, report, report_name: str, members: set[str]):
    report = copy.deepcopy(report)
    report["report_sha256"] = m.digest(m.canonical(report))
    files = {name: (m.canonical(report) if name == report_name else
                    b"deterministic historical immutability fixture\n")
             for name in members - {"archive.sha256"}}
    manifest = "".join(
        m.digest(files[name]) + "  " + name + "\n"
        for name in sorted(files)
    ).encode()
    files["archive.sha256"] = manifest
    with zipfile.ZipFile(path,"w") as z:
        for name in sorted(files):
            z.writestr(name,files[name])
    return m.digest(path.read_bytes())


def success_log(*,gas=550_000,surplus=m.SURPLUS_WEI,fee=m.FLASH_FEE_WEI):
    return (
        "[PASS] testZeroOwnWethFeeWithoutExternalSponsorHasPositiveForkSurplus() (gas: 600000)\n"
        "  NQC_RANK1_FORK_EXECUTE_CALL_GAS_UNITS: "+str(gas)+"\n"
        "  NQC_RANK1_FORK_WETH_SURPLUS_WEI: "+str(surplus)+"\n"
        "  NQC_RANK1_FORK_FLASH_FEE_WEI: "+str(fee)+"\n"
        "  NQC_RANK1_FORK_PRODUCTION_GAS_SPONSORED: 0\n"
        "[PASS] testImpossibleProfitClaimRevertsAndCannotSpendExistingBalances() (gas: 650000)\n"
        "Suite result: ok. 2 passed; 0 failed; 0 skipped\n"
    )


def provider_reply(url,method,params,*,basefee=500_000_000):
    if method=="eth_chainId":
        return "0x1"
    if method=="eth_getBlockByNumber":
        assert params==[hex(m.BLOCK),False]
        return {"number":hex(m.BLOCK),"hash":m.BLOCK_HASH,
                "parentHash":m.PREVIOUS_BLOCK_HASH,"stateRoot":"0x"+"a"*64,
                "baseFeePerGas":hex(basefee),"gasUsed":hex(16_000_000),
                "gasLimit":hex(30_000_000)}
    raise AssertionError("request outside read-only source-only envelope")


class GasAnalysisTest(unittest.TestCase):
    def test_fork_measured_call_excludes_simulated_setup(self):
        self.assertEqual(m.measured_call_gas(success_log()),550_000)

    def test_missing_event_or_invalid_suite_denied(self):
        for variation in (
            success_log().replace("Suite result: ok. 2 passed", "Suite result: FAILED. 1 passed"),
            success_log().replace("NQC_RANK1_FORK_EXECUTE_CALL_GAS_UNITS","MISSING_GAS"),
            success_log().replace(
                "[PASS] testImpossibleProfitClaimRevertsAndCannotSpendExistingBalances()",
                "[FAIL] testImpossibleProfitClaimRevertsAndCannotSpendExistingBalances()"),
        ):
            with self.assertRaises(ValueError):
                m.measured_call_gas(variation)

    def test_duplicate_gas_line_denied(self):
        raw=success_log()
        raw+="NQC_RANK1_FORK_EXECUTE_CALL_GAS_UNITS: 550000\n"
        with self.assertRaisesRegex(ValueError,"duplicated"):
            m.measured_call_gas(raw)

    def test_false_flash_fee_or_surplus_denied(self):
        with self.assertRaisesRegex(ValueError,"drift"):
            m.measured_call_gas(success_log(fee=m.FLASH_FEE_WEI+1))
        with self.assertRaisesRegex(ValueError,"drift"):
            m.measured_call_gas(success_log(surplus=m.SURPLUS_WEI+1))

    def test_fake_unbounded_call_gas_rejected(self):
        for bad in (10,0,3_000_000,100_000):
            with self.assertRaisesRegex(ValueError,"drift"):
                m.measured_call_gas(success_log(gas=bad))

    def test_two_provider_true_historical_reference(self):
        evidence=m.historical_base_fee(call=provider_reply)
        self.assertEqual(len(evidence),2)
        self.assertEqual(int(evidence[0]["winner_base_fee_per_gas_wei"]),500_000_000)
        self.assertEqual(evidence[0]["winner_state_root"],evidence[1]["winner_state_root"])

    def test_wrong_historical_chain_denied(self):
        def bad(url,method,params):
            return "0x2" if method=="eth_chainId" else provider_reply(url,method,params)
        with self.assertRaisesRegex(ValueError,"not Ethereum"):
            m.historical_base_fee(call=bad)

    def test_winner_block_reorg_denied(self):
        def bad(url,method,params):
            x=provider_reply(url,method,params)
            if method=="eth_getBlockByNumber":
                x["hash"]="0x"+"f"*64
            return x
        with self.assertRaisesRegex(ValueError,"canonical parent mismatch"):
            m.historical_base_fee(call=bad)

    def test_cross_provider_basefee_disagreement_denied(self):
        def bad(url,method,params):
            return provider_reply(url,method,params,basefee=2 if "blast" in url else 1)
        with self.assertRaisesRegex(ValueError,"disagree"):
            m.historical_base_fee(call=bad)

    def test_cross_provider_header_disagreement_denied(self):
        def bad(url,method,params):
            x=provider_reply(url,method,params)
            if method=="eth_getBlockByNumber" and "blast" in url:
                x["stateRoot"]="0x"+"f"*64
            return x
        with self.assertRaisesRegex(ValueError,"disagree"):
            m.historical_base_fee(call=bad)

    def test_missing_or_invalid_basefee_denied(self):
        for invalid in ("0x00",None,"0x",0,False,"0xGG"):
            def bad(url,method,params):
                x=provider_reply(url,method,params)
                if method=="eth_getBlockByNumber":x["baseFeePerGas"]=invalid
                return x
            with self.assertRaises(ValueError):
                m.historical_base_fee(call=bad)

    def test_nonindependent_operators_denied(self):
        with self.assertRaisesRegex(ValueError,"independently"):
            m.historical_base_fee(call=provider_reply,providers=[
                ("drpc","same","a"),("blast","same","b")])

    def test_no_benefit_reported_when_gas_spends_more_than_surplus(self):
        case=m.economic_sensitivities(900_000,150_000_000_000,m.USD_ORACLE_PRICE_1E8)
        self.assertLess(int(case[0]["remaining_weth_equivalent_at_1_to_1_eth_weth_before_all_other_costs_wei"]),0)
        self.assertFalse(case[0]["budget_case_positive_after_this_gas_only"])

    def test_full_sensitivity_conserves_integer_basis_and_no_gas_sponsor(self):
        tests=m.economic_sensitivities(550_000,500_000_000,m.USD_ORACLE_PRICE_1E8)
        self.assertEqual(len(tests),5)
        self.assertEqual(tests[0]["modeled_gas_units_including_intrinsic_and_assumed_overhead"],571000)
        self.assertEqual(tests[0]["modeled_native_eth_gas_cost_wei"],str(571000*500000000))
        self.assertTrue(tests[0]["budget_case_positive_after_this_gas_only"])
        self.assertTrue(all(t["gas_sponsor_authorized"] is False for t in tests))
        self.assertTrue(all(t["actual_transaction_receipt_gas_verified"] is False for t in tests))
        self.assertTrue(all(t["original_transaction_calldata_and_failed_attempts_modeled"] is False for t in tests))
        self.assertTrue(all(t["remaining_usd_wad_using_prior_block_oracle"].lstrip("-").isdigit() for t in tests))

    def test_missing_source_zip_member_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"source.zip"
            sig=zip_fixture(path,fixture_fork_source(),"physical-liquidation-report.json",
                            m.SOURCE_MEMBERS)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA",sig):
                entries,report=m.read_source_archive(
                    path,sig,m.SOURCE_MEMBERS,"physical-liquidation-report.json")
                self.assertEqual(report["status"],
                    "RMC016_RANK1_COUNTERFACTUAL_AAVE_WETH_SURPLUS_FORK_PASS_NOT_NET")
                self.assertIn("fork-liquidation.txt",entries)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA","f"*64):
                with self.assertRaisesRegex(ValueError,"sha256"):
                    m.read_source_archive(path,m.SOURCE_FORK_ZIP_SHA,
                                          m.SOURCE_MEMBERS,"physical-liquidation-report.json")

    def test_false_positive_realized_pnl_injection_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d)
            fork=d/"fork.zip"
            price=d/"price.zip"
            changed=fixture_fork_source()
            changed["nexus_realized_net_profit_proven"]=True
            sig1=zip_fixture(fork,changed,"physical-liquidation-report.json",m.SOURCE_MEMBERS)
            sig2=zip_fixture(price,fixture_price(),"top-two-weth-prices.json",m.PRICE_MEMBERS)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA",sig1),patch.object(m,"PRICE_ZIP_SHA",sig2):
                with self.assertRaisesRegex(ValueError,"nonclaims"):
                    m.source_witness(fork,price)

    def test_fixture_sources_bind_cross_archive_identity(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);fork=d/"fork.zip";price=d/"price.zip"
            s1=zip_fixture(fork,fixture_fork_source(),"physical-liquidation-report.json",m.SOURCE_MEMBERS)
            s2=zip_fixture(price,fixture_price(),"top-two-weth-prices.json",m.PRICE_MEMBERS)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA",s1),patch.object(m,"PRICE_ZIP_SHA",s2):
                result=m.source_witness(fork,price)
                self.assertEqual(result["source_fork_surplus_wei"],m.SURPLUS_WEI)
                self.assertEqual(result["historical_preblock_weth_usd_oracle_base_1e8"],
                                 m.USD_ORACLE_PRICE_1E8)

    def test_preblock_price_mutation_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);fork=d/"fork.zip";price=d/"price.zip"
            sample=fixture_price()
            sample["transactions"][0]["preblock"]["oracle_usd_base_1e8"]="1"
            s1=zip_fixture(fork,fixture_fork_source(),"physical-liquidation-report.json",m.SOURCE_MEMBERS)
            s2=zip_fixture(price,sample,"top-two-weth-prices.json",m.PRICE_MEMBERS)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA",s1),patch.object(m,"PRICE_ZIP_SHA",s2):
                with self.assertRaisesRegex(ValueError,"price changed"):
                    m.source_witness(fork,price)

    def test_deterministic_full_diagnostic_and_no_profit_claim(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);fork=d/"fork.zip";price=d/"price.zip"
            s1=zip_fixture(fork,fixture_fork_source(),"physical-liquidation-report.json",m.SOURCE_MEMBERS)
            s2=zip_fixture(price,fixture_price(),"top-two-weth-prices.json",m.PRICE_MEMBERS)
            with patch.object(m,"SOURCE_FORK_ZIP_SHA",s1),patch.object(m,"PRICE_ZIP_SHA",s2):
                a=m.audit(fork,price,success_log(),call=provider_reply)
                b=m.audit(fork,price,success_log(),call=provider_reply)
            self.assertEqual(a,b)
            self.assertEqual(a["report_sha256"],m.digest(m.canonical(
                {k:v for k,v in a.items() if k!="report_sha256"})))
            for key in ("sponsor_collateral_or_repayment_agreement_proven",
                        "actual_nexus_tx_intrinsic_calldata_revert_gas_proven",
                        "actual_nexus_priority_or_builder_price_proven",
                        "competition_inclusion_and_capture_proven",
                        "zero_own_capital_including_eth_gas_proven",
                        "nexus_realized_profitability_proven",
                        "monthly_reliable_capacity_proven",
                        "real_market_census_closed"):
                self.assertFalse(a[key])


if __name__ == "__main__":
    unittest.main()
