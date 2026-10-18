#!/usr/bin/env python3
"""Generate exact-prestate witness and recovered-Rust classifier for Aave default-close candidates."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

POOL = "87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
DEFAULT_TAG = "default_close_factor_candidate"


def n(v):
    if isinstance(v, int):
        return v
    if isinstance(v, str):
        return int(v, 0)
    raise ValueError(f"unexpected integer encoding {v!r}")


def num_addr(value: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 40 or any(c not in "0123456789abcdef" for c in raw):
        raise ValueError(f"invalid address: {value}")
    return f"address(uint160(0x00{raw}))"


def b32(value: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 64 or any(c not in "0123456789abcdef" for c in raw):
        raise ValueError(f"invalid bytes32: {value}")
    return f"bytes32(0x{raw})"


def topic_address(value: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 64:
        raise ValueError(f"invalid indexed address topic {value}")
    return "0x" + raw[-40:]


def parse_liquidation_log(log: dict) -> dict:
    topics = [str(x).lower() for x in log.get("topics", [])]
    if len(topics) != 4:
        raise ValueError("LiquidationCall must have four topics")
    data = str(log.get("data", "")).lower().removeprefix("0x")
    if len(data) != 64 * 4:
        raise ValueError(f"unexpected LiquidationCall data length {len(data)}")
    words = [data[i : i + 64] for i in range(0, len(data), 64)]
    return {
        "collateral_asset": topic_address(topics[1]),
        "debt_asset": topic_address(topics[2]),
        "borrower": topic_address(topics[3]),
        "observed_debt_to_cover": int(words[0], 16),
        "observed_collateral_to_liquidator": int(words[1], 16),
        "liquidator": "0x" + words[2][-40:],
        "receive_atoken": bool(int(words[3], 16)),
    }


def candidate_events(config_path: Path, discovery_root: Path) -> list[dict]:
    config = json.loads(config_path.read_text())
    candidates = [
        c for c in config.get("candidates", []) if DEFAULT_TAG in c.get("class_tags", [])
    ]
    if not candidates:
        raise ValueError("no default close-factor candidates configured")

    events = []
    for candidate in candidates:
        case_id = candidate["case_id"]
        tx_hash = candidate["transaction_hash"].lower()
        observations_path = discovery_root / "providers" / f"{case_id}.json"
        observations = json.loads(observations_path.read_text())
        valid = [
            o
            for o in observations
            if o.get("rpc_ok")
            and str(o.get("receipt_status", "")).lower() == "0x1"
            and str(o.get("transaction_hash", "")).lower() == tx_hash
        ]
        if len(valid) < 2:
            raise ValueError(f"{case_id}: fewer than two valid provider observations")

        anchors = {
            (
                n(o["block_number"]),
                str(o["block_hash"]).lower(),
                str(o["parent_hash"]).lower(),
            )
            for o in valid
        }
        if len(anchors) != 1:
            raise ValueError(f"{case_id}: provider anchor dissent")

        normalized_logs = []
        for o in valid:
            logs = o.get("liquidation_logs", [])
            if len(logs) != 1:
                raise ValueError(
                    f"{case_id}: expected exactly one LiquidationCall, got {len(logs)}"
                )
            normalized_logs.append(
                json.dumps(logs[0], sort_keys=True, separators=(",", ":")).lower()
            )
        if len(set(normalized_logs)) != 1:
            raise ValueError(f"{case_id}: provider LiquidationCall dissent")

        first = valid[0]
        event = parse_liquidation_log(first["liquidation_logs"][0])
        if event["observed_debt_to_cover"] <= 0:
            raise ValueError(f"{case_id}: zero observed debt")
        block_number, block_hash, parent_hash = next(iter(anchors))
        events.append(
            {
                "case_index": len(events),
                "case_id": case_id,
                "transaction_hash": tx_hash,
                "block_number": block_number,
                "block_hash": block_hash,
                "parent_hash": parent_hash,
                **event,
            }
        )
    return events


def observed_expr(event: dict) -> str:
    return f"""Observed({{
            index: {event['case_index']},
            transactionHash: {b32(event['transaction_hash'])},
            blockNumber: {event['block_number']},
            parentHash: {b32(event['parent_hash'])},
            borrower: {num_addr(event['borrower'])},
            collateralAsset: {num_addr(event['collateral_asset'])},
            debtAsset: {num_addr(event['debt_asset'])},
            observedDebtToCover: {event['observed_debt_to_cover']}
        }})"""


def generate_solidity(events: list[dict]) -> str:
    tests = []
    for event in events:
        tests.append(
            f"""
    function testFork_CaptureCandidate{event['case_index']}() public {{
        vm.createSelectFork(vm.envString("PFT_RPC_URL"), {b32(event['transaction_hash'])});
        require(block.number == {event['block_number']}, "PRETX_BLOCK");
        require(blockhash(block.number - 1) == {b32(event['parent_hash'])}, "PRETX_PARENT");
        _capture({observed_expr(event)});
    }}
"""
        )
    return f'''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface PftProbeVm {{
    function envString(string calldata name) external returns (string memory value);
    function createSelectFork(string calldata urlOrAlias, bytes32 transaction)
        external returns (uint256 forkId);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external returns (string memory json);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external returns (string memory json);
    function serializeBytes32(string calldata objectKey, string calldata valueKey, bytes32 value)
        external returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
    function toString(uint256 value) external pure returns (string memory stringifiedValue);
}}

struct PftProbeReserveData {{
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}}

interface PftProbePool {{
    function ADDRESSES_PROVIDER() external view returns (address);
    function getReserveData(address asset) external view returns (PftProbeReserveData memory);
    function getUserAccountData(address user)
        external view returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}}

interface PftProbeProvider {{
    function getPriceOracle() external view returns (address);
}}

interface PftProbeOracle {{
    function BASE_CURRENCY_UNIT() external view returns (uint256);
    function getAssetPrice(address asset) external view returns (uint256);
}}

interface PftProbeBalanceToken {{
    function balanceOf(address user) external view returns (uint256);
}}

contract PftAaveDefaultCloseCandidateProbeTest {{
    PftProbeVm private constant vm =
        PftProbeVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PftProbePool private constant POOL =
        PftProbePool(address(uint160(0x00{POOL})));

    struct Observed {{
        uint256 index;
        bytes32 transactionHash;
        uint256 blockNumber;
        bytes32 parentHash;
        address borrower;
        address collateralAsset;
        address debtAsset;
        uint256 observedDebtToCover;
    }}

{''.join(tests)}
    function _capture(Observed memory observed) private {{
        PftProbeReserveData memory collateral = POOL.getReserveData(observed.collateralAsset);
        PftProbeReserveData memory debt = POOL.getReserveData(observed.debtAsset);
        require(collateral.aTokenAddress != address(0), "NO_ATOKEN");
        require(debt.variableDebtTokenAddress != address(0), "NO_VTOKEN");

        uint256 collateralDecimals = (collateral.configuration >> 48) & 0xff;
        uint256 debtDecimals = (debt.configuration >> 48) & 0xff;
        require(collateralDecimals <= 77 && debtDecimals <= 77, "DECIMALS");
        uint256 collateralUnit = 10 ** collateralDecimals;
        uint256 debtUnit = 10 ** debtDecimals;

        PftProbeOracle oracle = PftProbeOracle(
            PftProbeProvider(POOL.ADDRESSES_PROVIDER()).getPriceOracle()
        );
        uint256 baseUnit = oracle.BASE_CURRENCY_UNIT();
        uint256 collateralPrice = oracle.getAssetPrice(observed.collateralAsset);
        uint256 debtPrice = oracle.getAssetPrice(observed.debtAsset);
        uint256 borrowerCollateral =
            PftProbeBalanceToken(collateral.aTokenAddress).balanceOf(observed.borrower);
        uint256 borrowerDebt =
            PftProbeBalanceToken(debt.variableDebtTokenAddress).balanceOf(observed.borrower);
        (uint256 totalCollateralBase, uint256 totalDebtBase, , , , uint256 healthFactor) =
            POOL.getUserAccountData(observed.borrower);

        require(baseUnit != 0, "ZERO_BASE_UNIT");
        require(collateralPrice != 0 && debtPrice != 0, "ZERO_PRICE");
        require(borrowerDebt >= observed.observedDebtToCover, "EVENT_DEBT_GT_PRESTATE");
        require(healthFactor < 1e18, "NOT_LIQUIDATABLE");

        string memory key = string.concat("candidate-", vm.toString(observed.index));
        vm.serializeUint(key, "case_index", observed.index);
        vm.serializeBytes32(key, "transaction_hash", observed.transactionHash);
        vm.serializeUint(key, "block_number", observed.blockNumber);
        vm.serializeBytes32(key, "parent_hash", observed.parentHash);
        vm.serializeAddress(key, "borrower", observed.borrower);
        vm.serializeAddress(key, "collateral_asset", observed.collateralAsset);
        vm.serializeAddress(key, "debt_asset", observed.debtAsset);
        vm.serializeUint(key, "collateral_unit", collateralUnit);
        vm.serializeUint(key, "debt_unit", debtUnit);
        vm.serializeUint(key, "oracle_base_unit", baseUnit);
        vm.serializeUint(key, "collateral_price_oracle_units", collateralPrice);
        vm.serializeUint(key, "debt_price_oracle_units", debtPrice);
        vm.serializeUint(key, "borrower_collateral_balance", borrowerCollateral);
        vm.serializeUint(key, "borrower_variable_debt", borrowerDebt);
        vm.serializeUint(key, "total_collateral_base", totalCollateralBase);
        vm.serializeUint(key, "total_debt_base", totalDebtBase);
        vm.serializeUint(key, "health_factor_wad", healthFactor);
        string memory json = vm.serializeUint(
            key, "observed_debt_to_cover", observed.observedDebtToCover
        );
        string memory path = string.concat(
            vm.envString("PFT_WITNESS_DIR"), "/", vm.toString(observed.index), ".json"
        );
        vm.writeJson(json, path);
    }}
}}
'''


REQUIRED_WITNESS = {
    "case_index",
    "transaction_hash",
    "block_number",
    "parent_hash",
    "borrower",
    "collateral_asset",
    "debt_asset",
    "collateral_unit",
    "debt_unit",
    "oracle_base_unit",
    "collateral_price_oracle_units",
    "debt_price_oracle_units",
    "borrower_collateral_balance",
    "borrower_variable_debt",
    "total_collateral_base",
    "total_debt_base",
    "health_factor_wad",
    "observed_debt_to_cover",
}


def rs(v) -> str:
    return f'U256::from_str("{n(v)}")?'


def generate_rust(witness_dir: Path, metadata_path: Path) -> str:
    metadata = json.loads(metadata_path.read_text())
    events = metadata["candidates"]
    witnesses = []
    for event in events:
        idx = int(event["case_index"])
        witness = json.loads((witness_dir / f"{idx}.json").read_text())
        missing = sorted(REQUIRED_WITNESS - set(witness))
        if missing:
            raise ValueError(f"case {idx} missing witness fields {missing}")
        if n(witness["case_index"]) != idx:
            raise ValueError(f"case {idx} index mismatch")
        for key in ("transaction_hash", "parent_hash", "borrower", "collateral_asset", "debt_asset"):
            if str(witness[key]).lower() != str(event[key]).lower():
                raise ValueError(f"case {idx} metadata mismatch: {key}")
        if n(witness["observed_debt_to_cover"]) != int(event["observed_debt_to_cover"]):
            raise ValueError(f"case {idx} metadata mismatch: observed_debt_to_cover")
        witnesses.append(witness)

    lines = [
        "use alloy::primitives::U256;",
        "use nqc_aave_math::{max_liquidatable_debt, LiquidationSizingInput, FULL_CLOSE_HF_WAD};",
        "use nqc_core::{mul_div_ceil, mul_div_floor};",
        "use std::str::FromStr;",
        "type Error = Box<dyn std::error::Error>;",
        "fn main() -> Result<(), Error> {",
        "let mut candidates = 0u64;",
        "let mut exact_default_close_matches = 0u64;",
    ]
    for i, w in enumerate(witnesses):
        lines += [
            "{",
            f"let health_factor = {rs(w['health_factor_wad'])};",
            f"let total_debt_base = {rs(w['total_debt_base'])};",
            f"let borrower_collateral = {rs(w['borrower_collateral_balance'])};",
            f"let borrower_debt = {rs(w['borrower_variable_debt'])};",
            f"let collateral_price = {rs(w['collateral_price_oracle_units'])};",
            f"let debt_price = {rs(w['debt_price_oracle_units'])};",
            f"let collateral_unit = {rs(w['collateral_unit'])};",
            f"let debt_unit = {rs(w['debt_unit'])};",
            f"let base_unit = {rs(w['oracle_base_unit'])};",
            f"let observed_debt = {rs(w['observed_debt_to_cover'])};",
            "let reserve_collateral_base =",
            "    mul_div_floor(borrower_collateral, collateral_price, collateral_unit)?;",
            "let reserve_debt_base =",
            "    mul_div_ceil(borrower_debt, debt_price, debt_unit)?;",
            "let close_threshold = U256::from(2_000u64) * base_unit;",
            "let default_close =",
            "    health_factor > U256::from(FULL_CLOSE_HF_WAD)",
            "    && health_factor < U256::from(1_000_000_000_000_000_000u64)",
            "    && reserve_collateral_base >= close_threshold",
            "    && reserve_debt_base >= close_threshold;",
            "let max_debt = max_liquidatable_debt(LiquidationSizingInput {",
            "    health_factor_wad: health_factor,",
            "    total_debt_base_wad: total_debt_base,",
            "    reserve_debt_amount: borrower_debt,",
            "    reserve_debt_base_wad: reserve_debt_base,",
            "    reserve_collateral_base_wad: reserve_collateral_base,",
            "    debt_asset_price_base_wad: debt_price,",
            "    debt_asset_unit: debt_unit,",
            "    min_base_max_close_factor_threshold_wad: close_threshold,",
            "})?;",
            "if observed_debt > max_debt {",
            f'    return Err(format!("case {i}: historical debt exceeds recovered cap: observed={{}} cap={{}}", observed_debt, max_debt).into());',
            "}",
            "let exact_cap = default_close && observed_debt == max_debt;",
            "if exact_cap { exact_default_close_matches += 1; }",
            "candidates += 1;",
            f'println!("AAVE_DEFAULT_CLOSE_CANDIDATE case={i} block={n(w["block_number"])} default_close={{}} observed_debt={{}} max_debt={{}} reserve_debt_base={{}} reserve_collateral_base={{}} health_factor={{}} exact_cap={{}}", default_close, observed_debt, max_debt, reserve_debt_base, reserve_collateral_base, health_factor, exact_cap);',
            "}",
        ]
    lines += [
        f'if candidates != {len(witnesses)} {{ return Err("candidate count mismatch".into()); }}',
        "if exact_default_close_matches == 0 {",
        '    return Err("no historical candidate exactly exercised the recovered default close-factor cap".into());',
        "}",
        'println!("AAVE_DEFAULT_CLOSE_CANDIDATE_PASS candidates={} exact_default_close_matches={} unexplained_mismatches=0", candidates, exact_default_close_matches);',
        "Ok(())",
        "}",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="command", required=True)

    w = sub.add_parser("witness")
    w.add_argument("--config", type=Path, required=True)
    w.add_argument("--discovery-root", type=Path, required=True)
    w.add_argument("--solidity-output", type=Path, required=True)
    w.add_argument("--metadata-output", type=Path, required=True)

    c = sub.add_parser("classify")
    c.add_argument("--witness-dir", type=Path, required=True)
    c.add_argument("--metadata", type=Path, required=True)
    c.add_argument("--rust-output", type=Path, required=True)

    args = ap.parse_args()
    if args.command == "witness":
        events = candidate_events(args.config, args.discovery_root)
        args.solidity_output.parent.mkdir(parents=True, exist_ok=True)
        args.metadata_output.parent.mkdir(parents=True, exist_ok=True)
        args.solidity_output.write_text(generate_solidity(events))
        args.metadata_output.write_text(
            json.dumps({"schema_version": 1, "candidates": events}, indent=2, sort_keys=True) + "\n"
        )
        print(f"AAVE_DEFAULT_CLOSE_CANDIDATE_WITNESS_PLAN candidates={len(events)}")
    else:
        args.rust_output.parent.mkdir(parents=True, exist_ok=True)
        args.rust_output.write_text(generate_rust(args.witness_dir, args.metadata))


if __name__ == "__main__":
    main()
