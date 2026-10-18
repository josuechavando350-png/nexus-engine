#!/usr/bin/env python3
"""Generate a Foundry transaction-prestate witness for every admitted Aave liquidation."""
import argparse
import json
from pathlib import Path

POOL = "87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"


def num_addr(value: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 40 or any(c not in "0123456789abcdef" for c in raw):
        raise ValueError(f"invalid address: {value}")
    # Leading 00 forces Solidity to parse a numeric literal rather than an address literal.
    return f"address(uint160(0x00{raw}))"


def b32(value: str) -> str:
    raw = value.lower().removeprefix("0x")
    if len(raw) != 64 or any(c not in "0123456789abcdef" for c in raw):
        raise ValueError(f"invalid bytes32: {value}")
    return f"bytes32(0x{raw})"


def load_case(path: Path):
    doc = json.loads(path.read_text())
    if doc["schema_version"] != 1 or doc["strategy_family"] != "liquidation":
        raise ValueError(f"unexpected fixture schema: {path}")
    if doc["chain_id"] != 1 or doc["expected"]["receipt_status"] != "0x1":
        raise ValueError(f"fixture is not admitted mainnet success: {path}")
    observed = doc["account"]["observed_liquidations"]
    if len(observed) != doc["account"]["total_liquidation_log_count"]:
        raise ValueError(f"liquidation count mismatch: {path}")
    if len(observed) != doc["expected"]["liquidation_log_count"]:
        raise ValueError(f"expected liquidation count mismatch: {path}")
    return doc


def observed_expr(case, event, index):
    return f"""Observed({{
            index: {index},
            transactionHash: {b32(case["provenance"]["transaction_hash"])},
            blockNumber: {int(case["block_number"])},
            parentHash: {b32(case["parent_hash"])},
            borrower: {num_addr(event["borrower"])},
            collateralAsset: {num_addr(event["collateral_asset"])},
            debtAsset: {num_addr(event["debt_asset"])},
            expectedDebtToCover: {int(event["debt_to_cover"])},
            expectedCollateralToLiquidator: {int(event["liquidated_collateral_amount"])}
        }})"""


def generate(cases):
    all_cases = []
    for case in cases:
        for event in case["account"]["observed_liquidations"]:
            all_cases.append((case, event))
    if len(all_cases) != 16:
        raise ValueError(f"expected exactly 16 admitted liquidations, got {len(all_cases)}")

    functions = []
    global_index = 0
    for fixture_index, case in enumerate(cases):
        calls = []
        for event in case["account"]["observed_liquidations"]:
            calls.append(f"        _capture({observed_expr(case, event, global_index)});")
            global_index += 1
        functions.append(f"""
    function testFork_CaptureFixture{fixture_index}LiquidationMatrix() public {{
        vm.createSelectFork(vm.envString("PFT_RPC_URL"), {b32(case["provenance"]["transaction_hash"])});
        require(block.number == {int(case["block_number"])}, "PRETX_BLOCK");
        require(blockhash(block.number - 1) == {b32(case["parent_hash"])}, "PRETX_PARENT");
{chr(10).join(calls)}
    }}
""")

    return f'''// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface PftMatrixVm {{
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

struct PftMatrixReserveData {{
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

struct PftMatrixCollateralConfig {{
    uint16 ltv;
    uint16 liquidationThreshold;
    uint16 liquidationBonus;
}}

interface PftMatrixPool {{
    function ADDRESSES_PROVIDER() external view returns (address);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function getReserveData(address asset) external view returns (PftMatrixReserveData memory);
    function getUserEMode(address user) external view returns (uint256);
    function getEModeCategoryCollateralConfig(uint8 id)
        external view returns (PftMatrixCollateralConfig memory);
    function getEModeCategoryCollateralBitmap(uint8 id) external view returns (uint128);
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

interface PftMatrixProvider {{
    function getPriceOracle() external view returns (address);
}}

interface PftMatrixOracle {{
    function BASE_CURRENCY_UNIT() external view returns (uint256);
    function getAssetPrice(address asset) external view returns (uint256);
}}

interface PftMatrixBalanceToken {{
    function balanceOf(address user) external view returns (uint256);
}}

contract PftAaveLiquidationMatrixWitnessTest {{
    PftMatrixVm private constant vm =
        PftMatrixVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PftMatrixPool private constant POOL =
        PftMatrixPool(address(uint160(0x00{POOL})));

    error PftObservedFlashPremium(uint256 premium);
    error PftPremiumProbeUnexpectedSuccess();
    error PftPremiumProbeUnexpectedRevert(bytes32 digest, uint256 length);

    struct Observed {{
        uint256 index;
        bytes32 transactionHash;
        uint256 blockNumber;
        bytes32 parentHash;
        address borrower;
        address collateralAsset;
        address debtAsset;
        uint256 expectedDebtToCover;
        uint256 expectedCollateralToLiquidator;
    }}

    struct Captured {{
        uint16 collateralReserveId;
        uint16 debtReserveId;
        uint256 collateralConfiguration;
        uint256 debtConfiguration;
        address collateralAToken;
        address debtVariableToken;
        uint256 collateralUnit;
        uint256 debtUnit;
        uint256 reserveBonus;
        uint256 effectiveBonus;
        uint256 protocolFeeBps;
        uint256 userEMode;
        uint256 baseUnit;
        uint256 collateralPrice;
        uint256 debtPrice;
        uint256 borrowerCollateral;
        uint256 borrowerDebt;
        uint256 totalCollateralBase;
        uint256 totalDebtBase;
        uint256 liquidationThreshold;
        uint256 healthFactor;
        uint256 flashPremiumBps;
        uint256 observedCallbackFlashPremium;
    }}

{''.join(functions)}
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {{
        require(msg.sender == address(POOL), "PREMIUM_CALLBACK_SENDER");
        require(initiator == address(this), "PREMIUM_CALLBACK_INITIATOR");
        (address expectedAsset, uint256 expectedAmount) =
            abi.decode(params, (address, uint256));
        require(asset == expectedAsset, "PREMIUM_CALLBACK_ASSET");
        require(amount == expectedAmount, "PREMIUM_CALLBACK_AMOUNT");
        revert PftObservedFlashPremium(premium);
    }}

    function _observeFlashPremium(address asset, uint256 amount)
        private
        returns (uint256 premium)
    {{
        try POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(asset, amount),
            0
        ) {{
            revert PftPremiumProbeUnexpectedSuccess();
        }} catch (bytes memory reason) {{
            if (reason.length != 36) {{
                revert PftPremiumProbeUnexpectedRevert(
                    keccak256(reason),
                    reason.length
                );
            }}
            bytes32 firstWord;
            assembly {{
                firstWord := mload(add(reason, 0x20))
                premium := mload(add(reason, 0x24))
            }}
            if (bytes4(firstWord) != PftObservedFlashPremium.selector) {{
                revert PftPremiumProbeUnexpectedRevert(
                    keccak256(reason),
                    reason.length
                );
            }}
        }}
    }}

    function _loadReserveState(Observed memory observed)
        private
        view
        returns (Captured memory c)
    {{
        PftMatrixReserveData memory collateral =
            POOL.getReserveData(observed.collateralAsset);
        PftMatrixReserveData memory debt =
            POOL.getReserveData(observed.debtAsset);
        require(collateral.aTokenAddress != address(0), "NO_ATOKEN");
        require(debt.variableDebtTokenAddress != address(0), "NO_VTOKEN");

        uint256 collateralDecimals = (collateral.configuration >> 48) & 0xff;
        uint256 debtDecimals = (debt.configuration >> 48) & 0xff;
        require(collateralDecimals <= 77 && debtDecimals <= 77, "DECIMALS");

        c.collateralReserveId = collateral.id;
        c.debtReserveId = debt.id;
        c.collateralConfiguration = collateral.configuration;
        c.debtConfiguration = debt.configuration;
        c.collateralAToken = collateral.aTokenAddress;
        c.debtVariableToken = debt.variableDebtTokenAddress;
        c.collateralUnit = 10 ** collateralDecimals;
        c.debtUnit = 10 ** debtDecimals;
        c.reserveBonus = (collateral.configuration >> 32) & 0xffff;
        c.protocolFeeBps = (collateral.configuration >> 152) & 0xffff;
        c.userEMode = POOL.getUserEMode(observed.borrower);
        require(c.userEMode <= type(uint8).max, "EMODE_RANGE");
        c.effectiveBonus = c.reserveBonus;

        if (c.userEMode != 0) {{
            PftMatrixCollateralConfig memory category =
                POOL.getEModeCategoryCollateralConfig(uint8(c.userEMode));
            uint128 bitmap =
                POOL.getEModeCategoryCollateralBitmap(uint8(c.userEMode));
            if (
                collateral.id < 128
                    && (bitmap & (uint128(1) << collateral.id)) != 0
            ) {{
                c.effectiveBonus = category.liquidationBonus;
            }}
        }}
    }}

    function _loadOracleAndAccountState(
        Observed memory observed,
        Captured memory c
    ) private view returns (Captured memory) {{
        PftMatrixOracle oracle = PftMatrixOracle(
            PftMatrixProvider(POOL.ADDRESSES_PROVIDER()).getPriceOracle()
        );
        c.baseUnit = oracle.BASE_CURRENCY_UNIT();
        c.collateralPrice = oracle.getAssetPrice(observed.collateralAsset);
        c.debtPrice = oracle.getAssetPrice(observed.debtAsset);
        c.borrowerCollateral =
            PftMatrixBalanceToken(c.collateralAToken).balanceOf(observed.borrower);
        c.borrowerDebt =
            PftMatrixBalanceToken(c.debtVariableToken).balanceOf(observed.borrower);

        (
            c.totalCollateralBase,
            c.totalDebtBase,
            ,
            c.liquidationThreshold,
            ,
            c.healthFactor
        ) = POOL.getUserAccountData(observed.borrower);

        require(c.baseUnit != 0, "ZERO_BASE_UNIT");
        require(c.collateralPrice != 0 && c.debtPrice != 0, "ZERO_PRICE");
        require(
            c.borrowerDebt >= observed.expectedDebtToCover,
            "EVENT_DEBT_GT_PRESTATE"
        );
        require(c.healthFactor < 1e18, "NOT_LIQUIDATABLE");
        return c;
    }}

    function _writeWitness(Observed memory observed, Captured memory c) private {{
        string memory key = string.concat("witness-", vm.toString(observed.index));
        vm.serializeUint(key, "case_index", observed.index);
        vm.serializeBytes32(key, "transaction_hash", observed.transactionHash);
        vm.serializeUint(key, "block_number", observed.blockNumber);
        vm.serializeBytes32(key, "parent_hash", observed.parentHash);
        vm.serializeUint(key, "block_timestamp", block.timestamp);
        vm.serializeAddress(key, "pool", address(POOL));
        vm.serializeAddress(key, "borrower", observed.borrower);
        vm.serializeAddress(key, "collateral_asset", observed.collateralAsset);
        vm.serializeAddress(key, "debt_asset", observed.debtAsset);
        vm.serializeUint(key, "collateral_reserve_id", c.collateralReserveId);
        vm.serializeUint(key, "debt_reserve_id", c.debtReserveId);
        vm.serializeUint(
            key,
            "collateral_configuration",
            c.collateralConfiguration
        );
        vm.serializeUint(key, "debt_configuration", c.debtConfiguration);
        vm.serializeAddress(key, "collateral_atoken", c.collateralAToken);
        vm.serializeAddress(key, "debt_variable_token", c.debtVariableToken);
        vm.serializeUint(key, "collateral_unit", c.collateralUnit);
        vm.serializeUint(key, "debt_unit", c.debtUnit);
        vm.serializeUint(key, "oracle_base_unit", c.baseUnit);
        vm.serializeUint(
            key,
            "collateral_price_oracle_units",
            c.collateralPrice
        );
        vm.serializeUint(key, "debt_price_oracle_units", c.debtPrice);
        vm.serializeUint(
            key,
            "borrower_collateral_balance",
            c.borrowerCollateral
        );
        vm.serializeUint(key, "borrower_variable_debt", c.borrowerDebt);
        vm.serializeUint(key, "total_collateral_base", c.totalCollateralBase);
        vm.serializeUint(key, "total_debt_base", c.totalDebtBase);
        vm.serializeUint(key, "health_factor_wad", c.healthFactor);
        vm.serializeUint(
            key,
            "liquidation_threshold_bps",
            c.liquidationThreshold
        );
        vm.serializeUint(key, "user_emode_category", c.userEMode);
        vm.serializeUint(
            key,
            "reserve_liquidation_bonus_bps",
            c.reserveBonus
        );
        vm.serializeUint(
            key,
            "effective_liquidation_bonus_bps",
            c.effectiveBonus
        );
        vm.serializeUint(
            key,
            "liquidation_protocol_fee_bps",
            c.protocolFeeBps
        );
        vm.serializeUint(key, "flash_loan_premium_bps", c.flashPremiumBps);
        vm.serializeUint(
            key,
            "observed_callback_flash_premium",
            c.observedCallbackFlashPremium
        );
        vm.serializeUint(key, "flash_loan_callback_observed", 1);
        vm.serializeUint(
            key,
            "observed_debt_to_cover",
            observed.expectedDebtToCover
        );
        string memory json = vm.serializeUint(
            key,
            "observed_collateral_to_liquidator",
            observed.expectedCollateralToLiquidator
        );
        string memory path = string.concat(
            vm.envString("PFT_WITNESS_DIR"),
            "/",
            vm.toString(observed.index),
            ".json"
        );
        vm.writeJson(json, path);
    }}

    function _capture(Observed memory observed) private {{
        require(block.number == observed.blockNumber, "OBSERVED_BLOCK");
        require(
            blockhash(block.number - 1) == observed.parentHash,
            "OBSERVED_PARENT"
        );

        Captured memory c = _loadReserveState(observed);
        c = _loadOracleAndAccountState(observed, c);
        c.flashPremiumBps = uint256(POOL.FLASHLOAN_PREMIUM_TOTAL());
        c.observedCallbackFlashPremium =
            _observeFlashPremium(observed.debtAsset, observed.expectedDebtToCover);
        _writeWitness(observed, c);
    }}
}}
'''


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--multi", type=Path, required=True)
    ap.add_argument("--single", type=Path, required=True)
    ap.add_argument("--boundary", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    multi = load_case(args.multi)
    single = load_case(args.single)
    boundary = load_case(args.boundary)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generate([multi, single, boundary]))
