#!/usr/bin/env python3
"""Adversarial regressions: public paymaster APIs are NOT authorized NQC gas."""
from __future__ import annotations
import copy
import io
import json
import tempfile
import unittest
import warnings
import zipfile
from pathlib import Path
from unittest.mock import patch

import rmc011_external_gas_liability_gate as m


def base_budget():
    costs = []
    for overhead, tip in ((0,0),(50_000,1_000_000_000),
                          (100_000,2_000_000_000),(200_000,5_000_000_000),
                          (300_000,10_000_000_000)):
        gas = m.FORK_GAS_CALL_UNITS + 21_000 + overhead
        price = m.GAS_BASE_FEE_WEI + tip
        native_cost = gas * price
        costs.append({
            "modeled_gas_units_including_intrinsic_and_assumed_overhead":gas,
            "modeled_effective_gas_price_wei":str(price),
            "modeled_native_eth_gas_cost_wei":str(native_cost),
            "remaining_weth_equivalent_at_1_to_1_eth_weth_before_all_other_costs_wei":
                str(m.SURPLUS_WETH_WEI-native_cost),
            "gas_sponsor_authorized":False,
            "actual_transaction_receipt_gas_verified":False,
            "original_transaction_calldata_and_failed_attempts_modeled":False,
        })
    return {
        "status":"RMC016_RANK1_FORK_GAS_BREAK_EVEN_SENSITIVITY_DIAGNOSTIC_NOT_NET",
        "retrospective_competitor_source_tx":m.WINNER_TX,
        "physical_flash_liquidation_call_gas_units":m.FORK_GAS_CALL_UNITS,
        "historical_winner_block_gas_base_fee_wei_per_gas":str(m.GAS_BASE_FEE_WEI),
        "source_real_fork_after_flash_surplus_weth_wei":str(m.SURPLUS_WETH_WEI),
        "source_preblock_oracle_weth_usd_1e8":str(m.HISTORICAL_WETH_PRICE_BASE_1E8),
        "historical_base_fee_source_operator_count":2,
        "historical_base_fee_two_operator_consensus":True,
        "source_premium_and_liquidation_completed_only_in_fork":True,
        "measured_call_gas_excludes_tx_intrinsic_and_offchain_fees":True,
        "eth_weth_1_to_1_par_budget_does_not_fund_native_gas":True,
        "no_ex_ante_candidate_detection_proven":True,
        "sponsor_collateral_or_repayment_agreement_proven":False,
        "actual_nexus_priority_or_builder_price_proven":False,
        "competition_inclusion_and_capture_proven":False,
        "zero_own_capital_including_eth_gas_proven":False,
        "nexus_realized_profitability_proven":False,
        "monthly_reliable_capacity_proven":False,
        "real_market_census_closed":False,
        "sensitivity_cases":costs,
    }


def base_registry():
    return {
        "schema_version":1,
        "stage":"RMC-011",
        "contract":"NQC_RMC011_EXTERNAL_CAPITAL_PROVIDER_REGISTRY_V1",
        "registry_scope":"NQC_EXECUTION_AUTHORIZED_EXTERNAL_CAPITAL_PROVIDERS",
        "status":"DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE",
        "provider_count":0,
        "providers":[],
        "provider_backed_families":["EXTERNAL_GAS_SPONSOR","EXTERNAL_GAS_CREDIT"],
        "non_claims":["NO_EXTERNAL_GAS_SOURCE_IS_CLAIMED_AVAILABLE"],
        "terminal_semantics":{
            "terminal_availability_requires_authenticated_provider_evidence":True},
    }


def base_executor():
    return (b'address public immutable operator;\n'
            b'if (msg.sender != operator) revert NotOperator();\n'
            b'_safeTransfer(plan.asset, operator, realizedProfitAsset);\n'
            b'function execute(FlashExecutionPlan calldata plan, bytes calldata payload)\n')


def source_fixture(path,report=None,*,invalid=False,duplicate=False,manifest_loss=False):
    if report is None:
        report = base_budget()
    report=copy.deepcopy(report)
    report["report_sha256"]=m.sha256(m.canonical(report))
    blobs = {name:(m.canonical(report) if name=="fork-gas-break-even.json" else
                   (b"fake CI fixture\n"))
             for name in m.GAS_MEMBERS-{"archive.sha256"}}
    declared = {k:m.sha256(v) for k,v in blobs.items()}
    if invalid:
        declared["fork-gas-break-even.json"]="a"*64
    manifest = "".join(value+"  "+key+"\n" for key,value in sorted(declared.items())
                       if not manifest_loss or key!="forge-build.txt")
    blobs["archive.sha256"]=manifest.encode()
    with zipfile.ZipFile(path,"w") as z:
        for k in sorted(blobs):
            z.writestr(k,blobs[k])
        if duplicate:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore",UserWarning)
                z.writestr("archive.sha256",manifest.encode())
    return m.sha256(path.read_bytes()),report["report_sha256"]


class Rmc011ThirdPartyGasLiabilityTests(unittest.TestCase):
    def diagnose(self):
        with patch.object(m,"T36_RAW_GIT_BLOB",m.git_blob(base_executor())):
            return m.diagnose(base_budget(),base_registry(),base_executor())

    def test_zero_authorized_provider_admission(self):
        a=self.diagnose()
        self.assertEqual(a["status"],
          "RMC011_EXTERNAL_NATIVE_GAS_SPONSOR_NOT_ADMITTED_SOURCE_BOUND")
        self.assertEqual(a["authorized_external_gas_providers"],0)
        self.assertEqual(a["available_external_native_gas_wei_proven"],"0")
        for key in (
            "provider_discovery_global_nonexistence_proven",
            "erc4337_entrypoint_deposit_queried_or_proven",
            "paymaster_userop_quote_or_signature_obtained",
            "operator_invoice_recource_liability_excluded_by_contract",
            "pre_execution_native_gas_route_or_entrypoint_deposit_authenticated",
            "non_prefunded_full_native_gas_transaction_executed",
            "real_sponsor_identity_and_failure_liability_acceptance_proven",
            "profit_weth_delivered_to_userop_sender_and_postop_collected_proven",
            "ex_ante_detection_and_competition_capture_proven",
            "nqc_executable_with_own_capital_zero",
            "nqc_realized_net_profit_proven",
            "rmc011_terminal_closed","real_market_census_closed",
        ):
            self.assertIs(a[key],False,key)

    def test_requires_no_operator_prefunding_or_invoiced_debt(self):
        a=self.diagnose()
        values={r["family"]:r for r in a["tested_route_templates"]}
        self.assertFalse(values["OPERATOR_INVOICED_ERC20_GAS_MANAGER"]["nqc_executable"])
        self.assertFalse(values["OPERATOR_FUNDED_PAYMASTER_DEPOSIT"]["nqc_executable"])
        self.assertFalse(values["THIRD_PARTY_FUNDED_SIGNER_OR_BUILDER"]["nqc_executable"])
        self.assertFalse(values["ERC4337_THIRD_PARTY_FUNDED_PAYMASTER"]["nqc_executable"])

    def test_t36_operator_is_not_auto_userop_sender(self):
        a=self.diagnose()
        terms=a["t36_payout_and_smart_account_binding"]
        self.assertEqual(terms["operator_binding"],"IMMUTABLE_OPERATOR_ADDRESS")
        self.assertEqual(terms["real_flash_surplus_destination"],
                         "EXECUTOR_OPERATOR_NOT_AUTOMATIC_4337_USEROP_SENDER")
        self.assertFalse(terms["paymaster_postop_token_settlement_proven"])

    def test_t36_executor_code_mutation_fails(self):
        with patch.object(m,"T36_RAW_GIT_BLOB",m.git_blob(base_executor())):
            with self.assertRaisesRegex(ValueError,"Git blob"):
                m.inspect_unmodified_executor(base_executor()+b"\n// unexpected mutation\n")

    def test_t36_without_operator_payout_fails_even_if_hash_claimed(self):
        malformed=base_executor().replace(
            b'_safeTransfer(plan.asset, operator, realizedProfitAsset);',
            b'_safeTransfer(plan.asset, attacker, realizedProfitAsset);')
        with patch.object(m,"T36_RAW_GIT_BLOB",m.git_blob(malformed)):
            with self.assertRaisesRegex(ValueError,"payout/operator"):
                m.inspect_unmodified_executor(malformed)

    def test_registry_count_injection_denied(self):
        registry=base_registry()
        registry["provider_count"]=1
        with patch.object(m,"REGISTRY_GIT_BLOB",m.git_blob(m.canonical(registry))):
            with self.assertRaisesRegex(ValueError,"count drift"):
                m.read_original_registry(m.canonical(registry))

    def test_fake_authorized_sponsor_in_registry_denied(self):
        registry=base_registry()
        registry["provider_count"]=1
        registry["providers"]=[{"name":"Fake-Paymaster","free":True}]
        with patch.object(m,"REGISTRY_GIT_BLOB",m.git_blob(m.canonical(registry))):
            with self.assertRaises(ValueError):
                m.read_original_registry(m.canonical(registry))

    def test_original_registry_canonical_source(self):
        registry=base_registry()
        data=m.canonical(registry)
        with patch.object(m,"REGISTRY_GIT_BLOB",m.git_blob(data)):
            observed=m.read_original_registry(data)
        self.assertEqual(observed["provider_count"],0)

    def test_registry_incomplete_evidence_denied(self):
        registry=base_registry()
        registry["terminal_semantics"]["terminal_availability_requires_authenticated_provider_evidence"]=False
        raw=m.canonical(registry)
        with patch.object(m,"REGISTRY_GIT_BLOB",m.git_blob(raw)):
            with self.assertRaises(ValueError):
                m.read_original_registry(raw)

    def test_duplicate_json_auth_field_denied(self):
        with self.assertRaisesRegex(ValueError,"duplicate"):
            m.unique_json(b'{"provider_count":0,"provider_count":1}')

    def test_wrong_sha_registry_rejected_even_with_empty(self):
        with self.assertRaisesRegex(ValueError,"Git blob"):
            m.read_original_registry(m.canonical(base_registry()))

    def test_sponsor_revert_risk_not_zero_if_profitable(self):
        a=self.diagnose()
        self.assertEqual(len(a["native_gas_and_revert_liability_stress"]),15)
        for row in a["native_gas_and_revert_liability_stress"]:
            self.assertGreater(int(row["native_eth_prefund_needed_wei"]),0)
            self.assertEqual(row["sponsor_revert_loss_eth_wei_if_no_weth_collected"],
                             row["native_eth_prefund_needed_wei"])
            self.assertFalse(row["postop_reimbursement_authenticated"])
            self.assertFalse(row["nqc_recource_free_credit_contract_signed"])

    def test_hypothetical_admin_fee_is_integer_ceiling(self):
        rows=m.modeled_postop_liability(base_budget())
        fifth=rows[1]
        self.assertEqual(fifth["hypothetical_admin_fee_bps"],800)
        underlying=int(fifth["native_eth_prefund_needed_wei"])
        self.assertEqual(int(fifth["hypothetical_sponsor_weth_reimbursement_wei"]),
                         underlying+(underlying*800+9999)//10000)

    def test_surplus_can_be_overrun_by_sponsor_fees(self):
        data=base_budget()
        data["sensitivity_cases"][-1]["modeled_native_eth_gas_cost_wei"] = \
            str(m.SURPLUS_WETH_WEI+10)
        results=m.modeled_postop_liability(data)
        self.assertFalse(results[-1]["hypothetical_positive_only_if_capture_and_postop_work"])
        self.assertLess(int(results[-1]["hypothetical_weth_after_fee_and_gas_wei"]),0)
        self.assertFalse(results[-1]["nqc_native_eth_prefunding_available"])

    def test_gas_zero_or_synthetic_float_denied(self):
        for value in ("-1","0.6","1e2",True,12,None,"00"):
            with self.assertRaises(ValueError):
                m.nat(value,"gas")

    def test_expected_source_members_authenticated(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"proof.zip"
            sha,report_sha=source_fixture(path)
            with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",report_sha):
                result=m.read_authenticated_budget(path)
            self.assertEqual(result["physical_flash_liquidation_call_gas_units"],
                             m.FORK_GAS_CALL_UNITS)
            self.assertEqual(result["report_sha256"],report_sha)

    def test_archive_member_changed_denied(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"proof.zip"
            sha,report_sha=source_fixture(path,invalid=True)
            with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",report_sha):
                with self.assertRaisesRegex(ValueError,"member SHA256"):
                    m.read_authenticated_budget(path)

    def test_archive_missing_one_sha_denied(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"proof.zip"
            sha,report_sha=source_fixture(path,manifest_loss=True)
            with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",report_sha):
                with self.assertRaisesRegex(ValueError,"incomplete"):
                    m.read_authenticated_budget(path)

    def test_duplicate_archive_entry_denied(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/"proof.zip"
            sha,report_sha=source_fixture(path,duplicate=True)
            with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",report_sha):
                with self.assertRaisesRegex(ValueError,"duplicate"):
                    m.read_authenticated_budget(path)

    def test_source_inflated_gas_or_surplus_denied(self):
        for key,value in (
            ("physical_flash_liquidation_call_gas_units",1),
            ("source_real_fork_after_flash_surplus_weth_wei","999999999999999999999"),
            ("source_preblock_oracle_weth_usd_1e8","999"),
            ("zero_own_capital_including_eth_gas_proven",True),
            ("historical_base_fee_two_operator_consensus",False),
        ):
            with tempfile.TemporaryDirectory() as d:
                path=Path(d)/"proof.zip"
                obj=base_budget()
                obj[key]=value
                sha,rep=source_fixture(path,report=obj)
                with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",rep):
                    with self.assertRaisesRegex(ValueError,"overclaimed or drifted"):
                        m.read_authenticated_budget(path)

    def test_source_sensitivity_conservation_denied(self):
        obj=base_budget()
        obj["sensitivity_cases"][1]["modeled_native_eth_gas_cost_wei"]="1"
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"proof.zip"
            sha,rep=source_fixture(p,report=obj)
            with patch.object(m,"GAS_ARCHIVE_SHA",sha),patch.object(m,"GAS_REPORT_SHA",rep):
                with self.assertRaisesRegex(ValueError,"conservation"):
                    m.read_authenticated_budget(p)

    def test_full_diagnostic_determinism_and_no_nexus_PnL(self):
        a=self.diagnose()
        b=self.diagnose()
        self.assertEqual(a,b)
        expected=m.sha256(m.canonical({k:v for k,v in a.items() if k!="report_sha256"}))
        self.assertEqual(a["report_sha256"],expected)
        self.assertEqual(a["available_external_native_gas_wei_proven"],"0")
        self.assertFalse(a["real_market_census_closed"])


if __name__=="__main__":
    unittest.main()
