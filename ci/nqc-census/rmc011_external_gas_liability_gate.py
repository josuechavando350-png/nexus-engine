#!/usr/bin/env python3
"""RMC011: fail-closed third-party native gas credit/paymaster underwriting.

This read-only diagnostic authenticates the original successful real-fork gas
budget and RMC011 provider authorization inventory. Provider documentation,
hypothetical postOp settlement or a positive gas-adjusted surplus NEVER creates
an authorized third-party facility or a working ERC-4337 UserOperation.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

GAS_ARCHIVE_SHA = "2f31b24005ac3050574d6669b904415d09a438648575cdcbdbbd2b5a4dcf40e9"
GAS_REPORT_SHA = "83aaa0010fc409daa3a7abe19e2441ba0d085ec8fb5f3673ae8b44a735870909"
REGISTRY_GIT_BLOB = "a9c1427bb05828d08ade537899ee1b8e43b97ed2"
T36_RAW_GIT_BLOB = "aa3883fa141aa096006e90e56d8d4150c9ee14ef"
SPONSOR_IMPORTER_GIT_BLOB = "5a301f92850bd00594996cbf013d9e4f74867d62"
CREDIT_IMPORTER_GIT_BLOB = "090f23df1326a0e6feb6f3afbe2151278d3b9499"
PRE_EXECUTION_DELIVERY = "PRE_EXECUTION_NATIVE_GAS_TO_BORROWER_NO_OPERATOR_PREFUND_V1"
WINNER_TX = "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba"
FORK_GAS_CALL_UNITS = 562357
GAS_BASE_FEE_WEI = 59451728
SURPLUS_WETH_WEI = 90814117763741536
HISTORICAL_WETH_PRICE_BASE_1E8 = 250480170000
GAS_MEMBERS = frozenset({
    "archive.sha256", "forge-build.txt", "forge-version.txt",
    "fork-gas-break-even.json", "formatted-physical-source.sha256",
    "physical-fork-gas-test.txt", "source-files.sha256",
})
ALLOWED_GAS_FAMILIES = frozenset({"EXTERNAL_GAS_SPONSOR", "EXTERNAL_GAS_CREDIT"})
FEE_BPS_SENSITIVITIES = (0, 800, 2000)
DEC = re.compile(r"(?:0|[1-9][0-9]*)\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


def need(value: bool, reason: str) -> None:
    if not value:
        raise ValueError(reason)


def sha256(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


def canonical(obj: object) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True) + "\n").encode()


def unique_json(raw: bytes):
    def reject_duplicate(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, "JSON duplicate key")
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=reject_duplicate)


def nat(value, label):
    need(type(value) is str and DEC.fullmatch(value) is not None, label + " noncanonical uint")
    return int(value)


def git_blob(contents: bytes):
    return hashlib.sha1(b"blob " + str(len(contents)).encode() + b"\0" + contents).hexdigest()


def read_authenticated_budget(archive: Path):
    raw = archive.read_bytes()
    need(len(raw) < 100000 and sha256(raw) == GAS_ARCHIVE_SHA,
         "source successful historical-fork economic ZIP sha256 mismatch")
    with zipfile.ZipFile(archive) as z:
        info = z.infolist()
        names = [member.filename for member in info]
        need(len(names) == len(set(names)) and set(names) == GAS_MEMBERS,
             "source economic ZIP missing/duplicate members")
        for member in info:
            need(member.filename == Path(member.filename).name and member.file_size < 40000
                 and (member.external_attr >> 16) & 0o170000 != 0o120000,
                 "unsafe or oversized source archive member")
        blobs = {name: z.read(name) for name in names}
    checked = set()
    for line in blobs["archive.sha256"].decode("ascii").splitlines():
        need(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+", line) is not None,
             "invalid original budget evidence-manifest")
        digest, filename = line.split("  ")
        need(filename in GAS_MEMBERS - {"archive.sha256"} and filename not in checked,
             "duplicate or unknown source manifest line")
        need(digest == sha256(blobs[filename]), "source archive member SHA256 mismatch")
        checked.add(filename)
    need(checked == GAS_MEMBERS - {"archive.sha256"},
         "incomplete original source evidence SHA coverage")
    data = unique_json(blobs["fork-gas-break-even.json"])
    need(type(data) is dict and data.get("report_sha256") == GAS_REPORT_SHA,
         "budget original report commitment mismatch")
    report = dict(data)
    original = report.pop("report_sha256")
    need(sha256(canonical(report)) == original, "gas budget report content tampered")
    need(data.get("status") ==
         "RMC016_RANK1_FORK_GAS_BREAK_EVEN_SENSITIVITY_DIAGNOSTIC_NOT_NET"
         and data.get("retrospective_competitor_source_tx") == WINNER_TX
         and data.get("physical_flash_liquidation_call_gas_units") == FORK_GAS_CALL_UNITS
         and nat(data.get("historical_winner_block_gas_base_fee_wei_per_gas"), "base fee") ==
             GAS_BASE_FEE_WEI
         and nat(data.get("source_real_fork_after_flash_surplus_weth_wei"), "surplus") ==
             SURPLUS_WETH_WEI
         and nat(data.get("source_preblock_oracle_weth_usd_1e8"), "WETH price") ==
             HISTORICAL_WETH_PRICE_BASE_1E8
         and data.get("historical_base_fee_source_operator_count") == 2
         and data.get("historical_base_fee_two_operator_consensus") is True
         and data.get("source_premium_and_liquidation_completed_only_in_fork") is True
         and data.get("measured_call_gas_excludes_tx_intrinsic_and_offchain_fees") is True
         and data.get("eth_weth_1_to_1_par_budget_does_not_fund_native_gas") is True
         and data.get("no_ex_ante_candidate_detection_proven") is True
         and data.get("sponsor_collateral_or_repayment_agreement_proven") is False
         and data.get("actual_nexus_priority_or_builder_price_proven") is False
         and data.get("competition_inclusion_and_capture_proven") is False
         and data.get("zero_own_capital_including_eth_gas_proven") is False
         and data.get("nexus_realized_profitability_proven") is False
         and data.get("monthly_reliable_capacity_proven") is False
         and data.get("real_market_census_closed") is False,
         "source gas budget overclaimed or drifted")
    cases = data.get("sensitivity_cases")
    need(type(cases) is list and len(cases) == 5,
         "source gas-budget stress scenarios absent")
    previous_units = 0
    for row in cases:
        units = row.get("modeled_gas_units_including_intrinsic_and_assumed_overhead")
        need(type(units) is int and units > previous_units
             and row.get("gas_sponsor_authorized") is False
             and row.get("actual_transaction_receipt_gas_verified") is False
             and row.get("original_transaction_calldata_and_failed_attempts_modeled") is False,
             "source gas scenarios invalid or falsely sponsored")
        previous_units = units
        effective = nat(row.get("modeled_effective_gas_price_wei"), "modeled effective")
        cost = nat(row.get("modeled_native_eth_gas_cost_wei"), "native gas cost")
        left = int(row.get("remaining_weth_equivalent_at_1_to_1_eth_weth_before_all_other_costs_wei"))
        need(units * effective == cost and SURPLUS_WETH_WEI - cost == left
             and effective >= GAS_BASE_FEE_WEI,
             "gas-sensitivity conservation or source base fee invalid")
    return data


def read_original_registry(blob: bytes):
    need(len(blob) < 6000 and git_blob(blob) == REGISTRY_GIT_BLOB,
         "source NQC real gas authorization registry Git blob changed")
    data = unique_json(blob)
    need(type(data) is dict and data.get("schema_version") == 1
         and data.get("stage") == "RMC-011"
         and data.get("contract") == "NQC_RMC011_EXTERNAL_CAPITAL_PROVIDER_REGISTRY_V1"
         and data.get("registry_scope") ==
             "NQC_EXECUTION_AUTHORIZED_EXTERNAL_CAPITAL_PROVIDERS"
         and data.get("status") == "DECLARED_EMPTY_NOT_TERMINAL_EVIDENCE"
         and data.get("provider_count") == 0
         and data.get("providers") == []
         and ALLOWED_GAS_FAMILIES.issubset(set(data.get("provider_backed_families", [])))
         and "NO_EXTERNAL_GAS_SOURCE_IS_CLAIMED_AVAILABLE" in data.get("non_claims", [])
         and data.get("terminal_semantics", {}).get(
             "terminal_availability_requires_authenticated_provider_evidence") is True,
         "original D11 authorized provider registry semantics/count drift")
    return data


def inspect_unmodified_executor(source: bytes):
    need(git_blob(source) == T36_RAW_GIT_BLOB,
         "actual T36 executor Git blob changed, abandon binding")
    code = source.decode("utf-8")
    for phrase in (
        "address public immutable operator;",
        "if (msg.sender != operator) revert NotOperator();",
        "_safeTransfer(plan.asset, operator, realizedProfitAsset);",
        "function execute(FlashExecutionPlan calldata plan, bytes calldata payload)",
    ):
        need(phrase in code, "the original T36 payout/operator contract was not preserved")
    return {
        "executor_raw_git_blob": T36_RAW_GIT_BLOB,
        "operator_binding": "IMMUTABLE_OPERATOR_ADDRESS",
        "real_flash_surplus_destination": "EXECUTOR_OPERATOR_NOT_AUTOMATIC_4337_USEROP_SENDER",
        "entrypoint_paymaster_adapter_present_in_this_executor": False,
        "paymaster_postop_token_settlement_proven": False,
    }


def inspect_existing_rust_gas_importers(sponsor_module: bytes, credit_module: bytes):
    for label, data, expected in (
        ("EXTERNAL_GAS_SPONSOR", sponsor_module, SPONSOR_IMPORTER_GIT_BLOB),
        ("EXTERNAL_GAS_CREDIT", credit_module, CREDIT_IMPORTER_GIT_BLOB),
    ):
        need(git_blob(data) == expected,
             label + " original Rust adapter Git blob drift")
        src = data.decode("utf-8")
        need(PRE_EXECUTION_DELIVERY in src
             and "if operator_prefund_required {" in src
             and "provider_observations" in src,
             label + " importer no longer has exact no-operator-prefund source semantics")
    return {
        "sponsor_importer_raw_git_blob": SPONSOR_IMPORTER_GIT_BLOB,
        "gas_credit_importer_raw_git_blob": CREDIT_IMPORTER_GIT_BLOB,
        "both_importers_observe_native_prepayment_to_borrower": True,
        "erc4337_entrypoint_deposit_delivery_semantics_equivalent": False,
        "erc4337_paymaster_can_be_relabelled_as_existing_native_credit_without_new_adapter": False,
        "onchain_identity_and_liability_from_untrusted_json_authenticated": False,
        "no_existing_importer_authority_issued": True,
    }


def candidate_route_templates():
    # Technical categories only. Public documentation is NOT a product quote
    # or permission to sponsor this WETH liquidator/operation.
    shared = (
        "PROVIDER_ACCOUNT_AND_BILLING_LIABILITY_NOT_VERIFIED",
        "NO_COUNTERSIGNED_INDEPENDENT_NON_RECOURSE_GAS_COMMITMENT",
        "NO_REAL_ENTRYPOINT_PAYMASTER_DEPOSIT_OR_PROVIDER_NATIVE_SIGNER_PROOF",
        "NO_SIGNED_OPERATION_SPECIFIC_FUNDING_QUOTE",
        "NO_EXTERNAL_FAIL_AND_REVERT_GAS_RISK_ACCEPTANCE",
        "NO_NQC_SMART_ACCOUNT_OPERATOR_AND_PROFIT_SWEEP_PARITY",
        "NO_ACTUAL_POSTOP_WETH_COLLECTION_OR_REPAYMENT_TEST",
        "NO_PRODUCTION_CAPACITY_OR_PRIVATE_INCLUSION_ACCEPTANCE",
    )
    return [
        {"family":"ERC4337_THIRD_PARTY_FUNDED_PAYMASTER",
         "provider_availability_claim":"NOT_OBSERVED_OR_AUTHORIZED_FOR_NQC",
         "onchain_native_gas_payer":"INDEPENDENT_PAYMASTER_ENTRYPOINT_DEPOSIT",
         "token_settlement":"WETH_AFTER_EXECUTION_AT_USEROP_SENDER",
         "unverified_requirements":list(shared),
         "nqc_executable":False},
        {"family":"THIRD_PARTY_FUNDED_SIGNER_OR_BUILDER",
         "provider_availability_claim":"NOT_OBSERVED_OR_AUTHORIZED_FOR_NQC",
         "onchain_native_gas_payer":"EXTERNAL_ETH_FUNDED_TRANSACTION_SENDER",
         "token_settlement":"CONTRACT_BOUND_WETH_OR_ETH_SUCCESS_AND_FAILURE_TERMS",
         "unverified_requirements":list(shared),
         "nqc_executable":False},
        {"family":"OPERATOR_INVOICED_ERC20_GAS_MANAGER",
         "provider_availability_claim":"NOT_ADMISSIBLE_UNDER_OWN_CAPITAL_ZERO",
         "onchain_native_gas_payer":"PROVIDER_FRONTED_BUT_OPERATOR_LIABLE_BY_INVOICE",
         "token_settlement":"ERC20_WETH_AND_MONTHLY_INVOICE",
         "unverified_requirements":["OPERATOR_MONTHLY_BILLING_LIABILITY_IS_OWN_CAPITAL_EXPOSURE"],
         "nqc_executable":False},
        {"family":"OPERATOR_FUNDED_PAYMASTER_DEPOSIT",
         "provider_availability_claim":"NOT_ADMISSIBLE_UNDER_OWN_CAPITAL_ZERO",
         "onchain_native_gas_payer":"SELF_FUNDED_ENTRYPOINT_DEPOSIT",
         "token_settlement":"NOT_EXTERNAL",
         "unverified_requirements":["OPERATOR_NATIVE_GAS_PREPAYMENT"],
         "nqc_executable":False},
    ]


def modeled_postop_liability(budget):
    scenarios=[]
    for row in budget["sensitivity_cases"]:
        reserved_native = nat(row["modeled_native_eth_gas_cost_wei"], "modeled native ETH gas")
        units = row["modeled_gas_units_including_intrinsic_and_assumed_overhead"]
        for fee_bps in FEE_BPS_SENSITIVITIES:
            # Fee BPS are stress assumptions, NOT Alchemy/Pimlico quotes.
            extra_weth = (reserved_native * fee_bps + 9999) // 10000
            weth_to_repay_sponsor = reserved_native + extra_weth
            remaining = SURPLUS_WETH_WEI - weth_to_repay_sponsor
            scenarios.append({
                "historical_retrospective_candidate": WINNER_TX,
                "modeled_gas_units_not_full_userop_receipt": units,
                "hypothetical_admin_fee_bps": fee_bps,
                "native_eth_prefund_needed_wei": str(reserved_native),
                "hypothetical_sponsor_weth_reimbursement_wei": str(weth_to_repay_sponsor),
                "hypothetical_weth_after_fee_and_gas_wei": str(remaining),
                "hypothetical_positive_only_if_capture_and_postop_work": remaining > 0,
                "sponsor_revert_loss_eth_wei_if_no_weth_collected": str(reserved_native),
                "postop_reimbursement_authenticated": False,
                "nqc_native_eth_prefunding_available": False,
                "nqc_nonrecourse_credit_contract_signed": False,
            })
    need(len(scenarios) == 5 * len(FEE_BPS_SENSITIVITIES),
         "admin/liability stress coverage incomplete")
    return scenarios


def diagnose(budget, registry, executor_source: bytes,
             sponsor_adapter_source: bytes, credit_adapter_source: bytes):
    need(budget["status"] == "RMC016_RANK1_FORK_GAS_BREAK_EVEN_SENSITIVITY_DIAGNOSTIC_NOT_NET"
            and registry["provider_count"] == 0 and registry["providers"] == [],
            "gas sources cannot be promoted without source authentication")
    binding = inspect_unmodified_executor(executor_source)
    importers = inspect_existing_rust_gas_importers(
        sponsor_adapter_source, credit_adapter_source)
    routes = candidate_route_templates()
    scenarios = modeled_postop_liability(budget)
    result = {
        "schema_version": 1,
        "status": "RMC011_EXTERNAL_NATIVE_GAS_SPONSOR_NOT_ADMITTED_SOURCE_BOUND",
        "scope": "SINGLE_RETROSPECTIVE_WETH_FORK_GAS_ROUTE_PRE_ADMISSION_ONLY",
        "source_original_budget_zip_sha256": GAS_ARCHIVE_SHA,
        "source_original_budget_report_sha256": GAS_REPORT_SHA,
        "source_provider_registry_git_blob": REGISTRY_GIT_BLOB,
        "source_executor_git_blob": T36_RAW_GIT_BLOB,
        "source_gas_sponsor_adapter_git_blob": SPONSOR_IMPORTER_GIT_BLOB,
        "source_gas_credit_adapter_git_blob": CREDIT_IMPORTER_GIT_BLOB,
        "historical_winner_tx": WINNER_TX,
        "historical_weth_liquidation_fork_surplus_wei": str(SURPLUS_WETH_WEI),
        "measured_evm_call_gas_units": FORK_GAS_CALL_UNITS,
        "original_historical_winner_base_fee_wei_per_gas": str(GAS_BASE_FEE_WEI),
        "authorized_external_gas_providers": 0,
        "available_external_native_gas_wei_proven": "0",
        "provider_discovery_global_nonexistence_proven": False,
        "tested_route_templates": routes,
        "t36_payout_and_smart_account_binding": binding,
        "rmc011_source_importer_native_gas_semantics": importers,
        "native_gas_and_revert_liability_stress": scenarios,
        "erc4337_entrypoint_deposit_queried_or_proven": False,
        "paymaster_userop_quote_or_signature_obtained": False,
        "operator_invoice_recourse_liability_excluded_by_contract": False,
        "pre_execution_native_gas_route_or_entrypoint_deposit_authenticated": False,
        "non_prefunded_full_native_gas_transaction_executed": False,
        "real_sponsor_identity_and_failure_liability_acceptance_proven": False,
        "profit_weth_delivered_to_userop_sender_and_postop_collected_proven": False,
        "ex_ante_detection_and_competition_capture_proven": False,
        "nqc_executable_with_own_capital_zero": False,
        "nqc_realized_net_profit_proven": False,
        "rmc011_terminal_closed": False,
        "real_market_census_closed": False,
        "remaining_hard_blocks": [
            "ZERO_INDEPENDENT_NQC_AUTHORIZED_GAS_SPONSORS",
            "NO_EXTERNAL_ENTRYPOINT_DEPOSIT_OR_PREFUNDED_NATIVE_TX_SENDER_ADMISSION",
            "NO_NONRECOURSE_SPONSOR_CONTRACT_FOR_SUCCESS_AND_REVERT_FEES",
            "NO_VERIFIED_WETH_POSTOP_REPAYMENT_OR_ACCOUNT_PAYOUT",
            "NO_FULL_USEROP_VERIFICATION_POSTOP_AND_FAILURE_GAS_QUOTE",
            "NO_COMPETITIVE_EX_ANTE_SIGNAL_OR_PRODUCTION_INCLUSION",
        ],
        "scope_limit": "This negative report proves only that this Git head has no configured execution-authorized external gas sponsor; it does not prove all third-party capital unavailable globally.",
    }
    result["report_sha256"] = sha256(canonical(result))
    return result


def audit(gas_zip: Path, registry_path: Path, executor_path: Path,
          sponsor_adapter_path: Path, credit_adapter_path: Path):
    return diagnose(
        read_authenticated_budget(gas_zip),
        read_original_registry(registry_path.read_bytes()),
        executor_path.read_bytes(),
        sponsor_adapter_path.read_bytes(),
        credit_adapter_path.read_bytes(),
    )


def main():
    parser = argparse.ArgumentParser()
    for label in ("gas-zip", "provider-registry", "executor-source",
                  "sponsor-adapter", "credit-adapter", "out"):
        parser.add_argument("--" + label, type=Path, required=True)
    args = parser.parse_args()
    need(not args.out.exists(), "append-only sponsor diagnostic output required")
    report = audit(args.gas_zip, args.provider_registry, args.executor_source,
                   args.sponsor_adapter, args.credit_adapter)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(canonical(report))
    print(report["status"],
          "authorized_external_sponsors", report["authorized_external_gas_providers"],
          "hypothetical_stress_rows",len(report["native_gas_and_revert_liability_stress"]),
          "NQC_GAS_AND_NET_PNL_UNPROVEN")


if __name__ == "__main__":
    main()
