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


def generate(multi, single):
    all_cases = []
    for case in (multi, single):
        for event in case["account"]["observed_liquidations"]:
            all_cases.append((case, event))
    if len(all_cases) != 15:
        raise ValueError(f"expected exactly 15 admitted liquidations, got {len(all_cases)}")

    by_tx = [(multi, list(range(0, len(multi["account"]["observed_liquidations"]))))]
    by_tx.append((single, [len(multi["account"]["observed_liquidations"])]))

    functions = []
    global_index = 0
    for case in (multi, single):
        calls = []
        for event in case["account"]["observed_liquidations"]:
            calls.append(f"        _capture({observed_expr(case, event, global_index)});")
            global_index += 1
        suffix = "Multiasset" if len(case["account"]["observed_liquidations"]) > 1 else "Single"
        functions.append(f"""
    function testFork_Capture{suffix}LiquidationMatrix() public {{
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

    function _capture(Observed memory observed) private {{
        require(block.number == observed.blockNumber, "OBSERVED_BLOCK");
        require(blockhash(block.number - 1) == observed.parentHash, "OBSERVED_PARENT");

        PftMatrixReserveData memory collateral = POOL.getReserveData(observed.collateralAsset);
        PftMatrixReserveData memory debt = POOL.getReserveData(observed.debtAsset);
        require(collateral.aTokenAddress != address(0), "NO_ATOKEN");
        require(debt.variableDebtTokenAddress != address(0), "NO_VTOKEN");

        uint256 collateralDecimals = (collateral.configuration >> 48) & 0xff;
        uint256 debtDecimals = (debt.configuration >> 48) & 0xff;
        require(collateralDecimals <= 77 && debtDecimals <= 77, "DECIMALS");
        uint256 collateralUnit = 10 ** collateralDecimals;
        uint256 debtUnit = 10 ** debtDecimals;

        uint256 reserveBonus = (collateral.configuration >> 32) & 0xffff;
        uint256 protocolFeeBps = (collateral.configuration >> 152) & 0xffff;

        uint256 userEMode = POOL.getUserEMode(observed.borrower);
        require(userEMode <= type(uint8).max, "EMODE_RANGE");
        uint256 effectiveBonus = reserveBonus;
        if (userEMode != 0) {{
            PftMatrixCollateralConfig memory category =
                POOL.getEModeCategoryCollateralConfig(uint8(userEMode));
            uint128 bitmap = POOL.getEModeCategoryCollateralBitmap(uint8(userEMode));
            if (collateral.id < 128 && (bitmap & (uint128(1) << collateral.id)) != 0) {{
                effectiveBonus = category.liquidationBonus;
            }}
        }}

        address provider = POOL.ADDRESSES_PROVIDER();
        PftMatrixOracle oracle =
            PftMatrixOracle(PftMatrixProvider(provider).getPriceOracle());
        uint256 baseUnit = oracle.BASE_CURRENCY_UNIT();
        uint256 collateralPrice = oracle.getAssetPrice(observed.collateralAsset);
        uint256 debtPrice = oracle.getAssetPrice(observed.debtAsset);
        uint256 borrowerCollateral =
            PftMatrixBalanceToken(collateral.aTokenAddress).balanceOf(observed.borrower);
        uint256 borrowerDebt =
            PftMatrixBalanceToken(debt.variableDebtTokenAddress).balanceOf(observed.borrower);

        (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            ,
            uint256 liquidationThreshold,
            ,
            uint256 healthFactor
        ) = POOL.getUserAccountData(observed.borrower);

        uint256 flashPremiumBps = uint256(POOL.FLASHLOAN_PREMIUM_TOTAL());
        uint256 observedCallbackFlashPremium =
            _observeFlashPremium(observed.debtAsset, observed.expectedDebtToCover);

        require(baseUnit != 0, "ZERO_BASE_UNIT");
        require(collateralPrice != 0 && debtPrice != 0, "ZERO_PRICE");
        require(borrowerDebt >= observed.expectedDebtToCover, "EVENT_DEBT_GT_PRESTATE");
        require(healthFactor < 1e18, "NOT_LIQUIDATABLE");

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
        vm.serializeUint(key, "collateral_reserve_id", collateral.id);
        vm.serializeUint(key, "debt_reserve_id", debt.id);
        vm.serializeUint(key, "collateral_configuration", collateral.configuration);
        vm.serializeUint(key, "debt_configuration", debt.configuration);
        vm.serializeAddress(key, "collateral_atoken", collateral.aTokenAddress);
        vm.serializeAddress(key, "debt_variable_token", debt.variableDebtTokenAddress);
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
        vm.serializeUint(key, "liquidation_threshold_bps", liquidationThreshold);
        vm.serializeUint(key, "user_emode_category", userEMode);
        vm.serializeUint(key, "reserve_liquidation_bonus_bps", reserveBonus);
        vm.serializeUint(key, "effective_liquidation_bonus_bps", effectiveBonus);
        vm.serializeUint(key, "liquidation_protocol_fee_bps", protocolFeeBps);
        vm.serializeUint(key, "flash_loan_premium_bps", flashPremiumBps);
        vm.serializeUint(
            key,
            "observed_callback_flash_premium",
            observedCallbackFlashPremium
        );
        vm.serializeUint(key, "flash_loan_callback_observed", 1);
        vm.serializeUint(key, "observed_debt_to_cover", observed.expectedDebtToCover);
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
}}
'''


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--multi", type=Path, required=True)
    ap.add_argument("--single", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    args = ap.parse_args()
    multi = load_case(args.multi)
    single = load_case(args.single)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(generate(multi, single))
