#!/usr/bin/env python3
"""RMC016: source-bound fork-only measured-gas break-even diagnostics.

Measures ONLY the one Foundry EVM call executing real Aave flashLoanSimple +
liquidationCall + repayment, then compares its gas with historical base fees.
Never asserts production gasUsed, externally funded native ETH, inclusion,
adversarial capture, realized P&L or a monthly run rate.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

from rmc016_probe_historical_rpc import PROVIDERS, rpc
from rmc016_weth_cashflow_audit import WETH, canonical, require, digest, signed_usd_wad

SOURCE_FORK_ZIP_SHA = "9af974b4f87a68ef9e9dcf932e146b2440f197939b8bd75a7e993755b06c8bf1"
PRICE_ZIP_SHA = "5ae6c45b53ded26f327270758c248f7f4ec0ff1365f550e54dcf28feb4a83a03"
SOURCE_TIME_ZIP_SHA = "7d813c6cad278a5044d1c4ce57492efb07c5c0d73d69481769f92a4cc4151185"
WINNER_TX = "0x6313fb267755f3cfa48214bf74309505984306129ee09a558efe4801006dcbba"
BLOCK = 25938048
BLOCK_HASH = "0xf143f9988199037938e4dff57aaf24301a4c26770aefc0ec64774954cbf2dbe4"
PREVIOUS_BLOCK_HASH = "0x42cf44b75185587327a1aa8fc859cc5f49a639e7256547511430d6068b6f09ab"
PRINCIPAL_WEI = 10684013854557827871
FLASH_FEE_WEI = 5342006927278914
SURPLUS_WEI = 90814117763741536
USD_ORACLE_PRICE_1E8 = 250480170000
INTRINSIC_GAS_BUDGET = 21000
UINT = re.compile(r"(?:0|[1-9][0-9]*)\Z")
HEX_QUANTITY = re.compile(r"0x(?:0|[1-9a-f][0-9a-f]*)\Z")
HEX64 = re.compile(r"0x[0-9a-f]{64}\Z")
SOURCE_MEMBERS = {
    "archive.sha256", "build.txt", "fork-liquidation.txt",
    "formatted-tested-source.sha256", "original-sources.sha256",
    "physical-liquidation-report.json",
}
PRICE_MEMBERS = {"archive.sha256", "top-two-weth-prices.json"}
SENSITIVITIES = (
    (0, 0),
    (50_000, 1_000_000_000),
    (100_000, 2_000_000_000),
    (200_000, 5_000_000_000),
    (300_000, 10_000_000_000),
)


def require_nonnegative_decimal(value, label):
    require(type(value) is str and UINT.fullmatch(value) is not None,
            label + " is not canonical nonnegative decimal")
    return int(value)


def quantity(value, label):
    require(type(value) is str and HEX_QUANTITY.fullmatch(value) is not None,
            label + " not canonical hex quantity")
    return int(value, 16)


def unique_json(blob):
    def pairs_unique(pairs):
        d = {}
        for k, v in pairs:
            require(k not in d, "duplicate JSON key")
            d[k] = v
        return d
    return json.loads(blob, object_pairs_hook=pairs_unique)


def read_source_archive(path, expected_sha, members, report_name):
    raw = path.read_bytes()
    require(len(raw) <= 100_000 and digest(raw) == expected_sha,
            "immutable ZIP sha256 does not match exact pinned artifact")
    with zipfile.ZipFile(path) as z:
        infos = z.infolist()
        names = [x.filename for x in infos]
        require(len(names) == len(set(names)) and set(names) == members,
                "unexpected/missing/duplicate ZIP entries")
        for item in infos:
            require(item.filename == Path(item.filename).name and
                    item.file_size < 40_000 and
                    (item.external_attr >> 16) & 0o170000 != 0o120000,
                    "unsafe or oversized source ZIP member")
        content = {name: z.read(name) for name in names}
    validated = set()
    for line in content["archive.sha256"].decode("ascii").splitlines():
        require(re.fullmatch(r"[0-9a-f]{64}  [a-zA-Z0-9._-]+", line) is not None,
                "inner SHA manifest record invalid")
        sig, name = line.split("  ")
        require(name in members - {"archive.sha256"} and name not in validated,
                "duplicate/extra source SHA manifest record")
        require(sig == digest(content[name]), "original source ZIP inner digest differs")
        validated.add(name)
    require(validated == members - {"archive.sha256"}, "missing source ZIP SHA entries")
    report = unique_json(content[report_name])
    require(type(report) is dict, "report is not JSON object")
    original_commitment = report.pop("report_sha256", None)
    require(type(original_commitment) is str and
            original_commitment == digest(canonical(report)),
            "inner source report SHA256 commitment differs")
    report["report_sha256"] = original_commitment
    return content, report


def source_witness(fork_zip, price_zip):
    _, source = read_source_archive(
        fork_zip, SOURCE_FORK_ZIP_SHA, SOURCE_MEMBERS, "physical-liquidation-report.json")
    _, price = read_source_archive(
        price_zip, PRICE_ZIP_SHA, PRICE_MEMBERS, "top-two-weth-prices.json")
    require(source.get("status") ==
            "RMC016_RANK1_COUNTERFACTUAL_AAVE_WETH_SURPLUS_FORK_PASS_NOT_NET"
            and source.get("source_sha256") == SOURCE_TIME_ZIP_SHA
            and source.get("fork_block_previous") == BLOCK - 1
            and source.get("simulated_execution_block") == BLOCK
            and source.get("flash_weth_principal_wei") == str(PRINCIPAL_WEI)
            and source.get("actual_pool_flash_fee_wei") == str(FLASH_FEE_WEI)
            and source.get("remaining_weth_after_real_aave_liquidation_and_flash_fee_wei") == str(SURPLUS_WEI)
            and source.get("test_minted_fee_or_collateral_wei") == "0"
            and source.get("no_original_intrablock_transactions_replayed") is True
            and source.get("selected_retroactively_from_competitor") is True
            and source.get("native_gas_sponsorship_verified") is False
            and source.get("builder_inclusion_and_competition_capture_proven") is False
            and source.get("gas_slippage_mev_failure_costs_completely_verified") is False
            and source.get("nexus_realized_net_profit_proven") is False
            and source.get("real_market_census_closed") is False,
            "original real fork source does not match exact historical nonclaims")
    require(price.get("status") ==
            "TWO_HISTORICAL_WETH_WINNER_PREBLOCK_ORACLE_PRICES_PASS"
            and price.get("source_scope") == "TWO_OBSERVED_COMPETITOR_WINNERS_NOT_NEXUS"
            and price.get("nexus_capture_proven") is False
            and price.get("nexus_realized_profitability_proven") is False
            and price.get("real_market_census_closed") is False,
            "historical WETH oracle source overclaims")
    txs = price.get("transactions")
    require(type(txs) is list and len(txs) == 2, "unexpected historical price sample")
    rows = [x for x in txs if x.get("transaction_hash") == WINNER_TX]
    require(len(rows) == 1, "rank-one price sample not authenticated")
    ref = rows[0]
    require(ref.get("block_number") == BLOCK and
            ref.get("preblock", {}).get("block") == BLOCK - 1 and
            ref["preblock"].get("hash") == PREVIOUS_BLOCK_HASH and
            ref.get("block_end", {}).get("block") == BLOCK and
            ref["block_end"].get("hash") == BLOCK_HASH and
            ref.get("two_operator_preblock_oracle_consensus") is True and
            ref.get("exact_transaction_prestate_proven") is False,
            "source oracle reference block mismatch or lookahead claim")
    p = require_nonnegative_decimal(
        ref["preblock"].get("oracle_usd_base_1e8"), "rank-one previous-block WETH price")
    require(p == USD_ORACLE_PRICE_1E8,
            "immutable previously authenticated rank-one oracle price changed")
    return {
        "original_fork_report_sha256": source["report_sha256"],
        "original_price_report_sha256": price["report_sha256"],
        "source_fork_surplus_wei": SURPLUS_WEI,
        "historical_preblock_weth_usd_oracle_base_1e8": p,
    }


def measured_call_gas(raw):
    require(type(raw) is str and len(raw) < 250_000, "fork test log unavailable/oversized")
    require("Suite result: ok. 2 passed; 0 failed; 0 skipped" in raw and
            "[PASS] testZeroOwnWethFeeWithoutExternalSponsorHasPositiveForkSurplus()" in raw and
            "[PASS] testImpossibleProfitClaimRevertsAndCannotSpendExistingBalances()" in raw,
            "physical test success and adversarial rollback not demonstrated")
    evidence = {
        "NQC_RANK1_FORK_EXECUTE_CALL_GAS_UNITS": (100_000, 3_000_000),
        "NQC_RANK1_FORK_WETH_SURPLUS_WEI": (SURPLUS_WEI, SURPLUS_WEI),
        "NQC_RANK1_FORK_FLASH_FEE_WEI": (FLASH_FEE_WEI, FLASH_FEE_WEI),
        "NQC_RANK1_FORK_PRODUCTION_GAS_SPONSORED": (0, 0),
    }
    values = {}
    for label, (minimum, maximum) in evidence.items():
        matches = re.findall(r"^\s*" + re.escape(label) + r": ([0-9]+)\s*$",
                             raw, flags=re.MULTILINE)
        require(len(matches) == 1, "fork log missing/duplicated precise " + label)
        value = require_nonnegative_decimal(matches[0], label)
        require(minimum <= value <= maximum, "fork log original quantity drift: " + label)
        values[label] = value
    return values["NQC_RANK1_FORK_EXECUTE_CALL_GAS_UNITS"]


def one_provider(provider, call=rpc):
    pid, operator, url = provider
    require(call(url, "eth_chainId", []) == "0x1",
            "gas reference not Ethereum mainnet")
    block = call(url, "eth_getBlockByNumber", [hex(BLOCK), False])
    require(type(block) is dict and
            quantity(block.get("number"), "winner number") == BLOCK and
            block.get("hash") == BLOCK_HASH and
            block.get("parentHash") == PREVIOUS_BLOCK_HASH,
            "winner block or canonical parent mismatch")
    state_root = block.get("stateRoot")
    require(type(state_root) is str and HEX64.fullmatch(state_root) is not None,
            "historical block state root invalid")
    base_fee = quantity(block.get("baseFeePerGas"), "baseFeePerGas")
    gas_limit = quantity(block.get("gasLimit"), "winner block gas limit")
    gas_used = quantity(block.get("gasUsed"), "winner block gas consumed")
    require(gas_limit > 0 and gas_used <= gas_limit,
            "historical block gas metrics inconsistent")
    require(base_fee > 0, "historical base fee absent")
    return {
        "provider_id": pid, "operator": operator, "winner_block": BLOCK,
        "winner_block_hash": BLOCK_HASH, "previous_block_hash": PREVIOUS_BLOCK_HASH,
        "winner_state_root": state_root,
        "winner_base_fee_per_gas_wei": str(base_fee),
        "winner_block_gas_used": str(gas_used),
        "winner_block_gas_limit": str(gas_limit),
    }


def historical_base_fee(call=rpc, providers=None):
    operators = providers or [x for x in PROVIDERS if x[0] in ("drpc", "blast")]
    require(len(operators) == 2 and [x[0] for x in operators] == ["drpc", "blast"]
            and operators[0][1] != operators[1][1],
            "two independently operated RPCs required")
    rows = [one_provider(x, call=call) for x in operators]
    fields = ("winner_block", "winner_block_hash", "previous_block_hash",
              "winner_state_root", "winner_base_fee_per_gas_wei",
              "winner_block_gas_used", "winner_block_gas_limit")
    require(all(rows[0][k] == rows[1][k] for k in fields),
            "two independent RPC operators disagree on historical gas/base fee")
    return rows


def economic_sensitivities(gas_call, base_fee, price):
    require(type(gas_call) is int and gas_call > 100_000 and gas_call < 3_000_000,
            "fork call gas out of source-bounded domain")
    require(type(base_fee) is int and base_fee > 0,
            "missing winner-block gas base fee")
    require(price == USD_ORACLE_PRICE_1E8, "preblock oracle source not exact")
    cases = []
    for overhead, tip in SENSITIVITIES:
        # 21k intrinsic is a budgeting constant, not an authenticated whole
        # transaction receipt and is NOT a claim about all calldata costs.
        units = gas_call + INTRINSIC_GAS_BUDGET + overhead
        effective = base_fee + tip
        modeled_eth_wei = units * effective
        remaining = SURPLUS_WEI - modeled_eth_wei
        cases.append({
            "additional_unmeasured_overhead_gas_units_assumed": overhead,
            "hypothetical_tip_wei_per_gas": str(tip),
            "historical_winner_base_fee_per_gas_wei": str(base_fee),
            "modeled_effective_gas_price_wei": str(effective),
            "modeled_gas_units_including_intrinsic_and_assumed_overhead": units,
            "modeled_native_eth_gas_cost_wei": str(modeled_eth_wei),
            "remaining_weth_equivalent_at_1_to_1_eth_weth_before_all_other_costs_wei": str(remaining),
            "remaining_usd_wad_using_prior_block_oracle": str(
                signed_usd_wad(remaining, str(price))),
            "budget_case_positive_after_this_gas_only": remaining > 0,
            "max_effective_wei_per_gas_break_even_this_budget": str(
                SURPLUS_WEI // units),
            "gas_sponsor_authorized": False,
            "actual_transaction_receipt_gas_verified": False,
            "original_transaction_calldata_and_failed_attempts_modeled": False,
        })
    return cases


def audit(fork_zip, price_zip, fork_log_text, *, call=rpc, providers=None):
    sourced = source_witness(fork_zip, price_zip)
    gas_units = measured_call_gas(fork_log_text)
    observations = historical_base_fee(call=call, providers=providers)
    base_fee = int(observations[0]["winner_base_fee_per_gas_wei"])
    cases = economic_sensitivities(
        gas_units, base_fee, sourced["historical_preblock_weth_usd_oracle_base_1e8"])
    report = {
        "schema_version": 1,
        "status": "RMC016_RANK1_FORK_GAS_BREAK_EVEN_SENSITIVITY_DIAGNOSTIC_NOT_NET",
        "source_sha256": {
            "original_flash_liquidation_artifact_zip": SOURCE_FORK_ZIP_SHA,
            "original_rank1_oracle_price_zip": PRICE_ZIP_SHA,
            "original_real_fork_report": sourced["original_fork_report_sha256"],
            "original_historical_oracle_report": sourced["original_price_report_sha256"],
        },
        "historical_winner_block": BLOCK,
        "historical_winner_block_hash": BLOCK_HASH,
        "retrospective_competitor_source_tx": WINNER_TX,
        "physical_flash_liquidation_call_gas_units": gas_units,
        "measured_call_gas_includes_real_protocol_execution": True,
        "measured_call_gas_excludes_tx_intrinsic_and_offchain_fees": True,
        "historical_winner_block_gas_base_fee_wei_per_gas": str(base_fee),
        "historical_base_fee_source_operator_count": len(observations),
        "historical_base_fee_two_operator_consensus": True,
        "source_preblock_oracle_weth_usd_1e8": str(USD_ORACLE_PRICE_1E8),
        "source_real_fork_after_flash_surplus_weth_wei": str(SURPLUS_WEI),
        "source_flash_fee_wei": str(FLASH_FEE_WEI),
        "source_premium_and_liquidation_completed_only_in_fork": True,
        "sensitivity_cases": cases,
        "eth_weth_1_to_1_par_budget_does_not_fund_native_gas": True,
        "base_fee_of_winning_block_is_not_preblock_ex_ante_price": True,
        "no_ex_ante_candidate_detection_proven": True,
        "sponsor_collateral_or_repayment_agreement_proven": False,
        "actual_nexus_tx_intrinsic_calldata_revert_gas_proven": False,
        "actual_nexus_priority_or_builder_price_proven": False,
        "competition_inclusion_and_capture_proven": False,
        "zero_own_capital_including_eth_gas_proven": False,
        "nexus_realized_profitability_proven": False,
        "monthly_reliable_capacity_proven": False,
        "real_market_census_closed": False,
        "historical_source_operator_observations": observations,
    }
    report["report_sha256"] = digest(canonical(report))
    return report


def main():
    parser = argparse.ArgumentParser()
    for name in ("fork-zip", "price-zip", "fork-log", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    options = parser.parse_args()
    require(not options.out.exists(), "append-only gas diagnostic required")
    out = audit(
        options.fork_zip, options.price_zip,
        options.fork_log.read_text(encoding="utf-8"),
    )
    options.out.parent.mkdir(parents=True, exist_ok=True)
    options.out.write_bytes(canonical(out))
    print(
        out["status"],
        "physical_call_gas", out["physical_flash_liquidation_call_gas_units"],
        "historical_base_fee_wei", out["historical_winner_block_gas_base_fee_wei_per_gas"],
        "budget_cases_positive",
        sum(x["budget_case_positive_after_this_gas_only"] for x in out["sensitivity_cases"]),
        "nexus_net_pnl_UNPROVEN",
    )


if __name__ == "__main__":
    main()
