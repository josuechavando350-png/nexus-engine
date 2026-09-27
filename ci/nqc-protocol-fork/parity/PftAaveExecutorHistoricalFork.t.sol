// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcAaveV3Executor} from "../src/NqcAaveV3Executor.sol";

interface PftExecVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function envString(string calldata name) external returns (string memory value);
    function createSelectFork(string calldata urlOrAlias, bytes32 transaction)
        external
        returns (uint256 forkId);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory logs);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeBytes32(string calldata objectKey, string calldata valueKey, bytes32 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
}

interface PftExecToken {
    function balanceOf(address account) external view returns (uint256);
}

interface PftExecPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestampLast);
}

interface PftExecPool {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

contract PftAaveExecutorHistoricalForkTest {
    PftExecVm private constant vm =
        PftExecVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    bytes32 private constant TX =
        0xc953d5da04ee4dc9f421ac5418f05add5244d9816c50420bbf7bb6cbafc1150a;
    uint256 private constant BLOCK_NUMBER = 25_252_136;
    bytes32 private constant PARENT_HASH =
        0x04a2465e3a87b1103521c1f54e568de209062f08742a0212da24d34eee4aac78;

    address private constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant BORROWER = 0x5E0481cAD8BFF5453635F4770F44b2194DdF6e02;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant USDC = 0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eB48;
    address private constant USDC_WETH_PAIR = 0xB4e16d0168e52D35CaCD2c6185b44281Ec28C9Dc;

    uint256 private constant DEBT_TO_COVER = 554_963_551_478;
    uint256 private constant COLLATERAL_TO_LIQUIDATOR = 368_144_715_101_196_997_895;
    uint256 private constant V2_FEE_BPS = 30;

    event PftExecutorHistoricalForkEvidence(
        uint256 realizedProfit,
        uint256 flashPremium,
        uint256 amountOut,
        bytes32 orderedLogsDigest
    );

    function _quote(uint256 reserveIn, uint256 reserveOut, uint256 amountIn)
        private
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (10_000 - V2_FEE_BPS);
        return amountInWithFee * reserveOut / (reserveIn * 10_000 + amountInWithFee);
    }

    function testFork_ExecutorSettlesHistoricalWethUsdcLiquidation() public {
        string memory rpc = vm.envString("PFT_RPC_URL");
        string memory evidencePath = vm.envString("PFT_EVIDENCE_PATH");
        vm.createSelectFork(rpc, TX);

        require(block.number == BLOCK_NUMBER, "BLOCK");
        require(blockhash(BLOCK_NUMBER - 1) == PARENT_HASH, "PARENT");

        PftExecPair pair = PftExecPair(USDC_WETH_PAIR);
        require(pair.token0() == USDC, "PAIR_TOKEN0");
        require(pair.token1() == WETH, "PAIR_TOKEN1");

        (uint112 reserve0Before, uint112 reserve1Before,) = pair.getReserves();
        uint256 amountOut = _quote(
            uint256(reserve1Before),
            uint256(reserve0Before),
            COLLATERAL_TO_LIQUIDATOR
        );

        uint256 premiumBps = uint256(PftExecPool(POOL).FLASHLOAN_PREMIUM_TOTAL());
        uint256 flashPremium = (DEBT_TO_COVER * premiumBps + 5_000) / 10_000;
        require(amountOut > DEBT_TO_COVER + flashPremium, "NO_EDGE");
        uint256 expectedProfit = amountOut - DEBT_TO_COVER - flashPremium;

        NqcAaveV3Executor executor = new NqcAaveV3Executor(address(this), POOL);
        NqcAaveV3Executor.V2Hop[] memory hops = new NqcAaveV3Executor.V2Hop[](1);
        hops[0] = NqcAaveV3Executor.V2Hop({
            pair: USDC_WETH_PAIR,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: COLLATERAL_TO_LIQUIDATOR,
            amountOut: amountOut
        });
        NqcAaveV3Executor.ExecutionPlan memory plan = NqcAaveV3Executor.ExecutionPlan({
            chainId: 1,
            validThroughBlock: block.number,
            borrower: BORROWER,
            collateralAsset: WETH,
            debtAsset: USDC,
            debtToCover: DEBT_TO_COVER,
            minProfitDebtAsset: 1,
            hops: hops
        });

        uint256 operatorUsdcBefore = PftExecToken(USDC).balanceOf(address(this));
        vm.recordLogs();
        uint256 realizedProfit = executor.execute(plan);
        PftExecVm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 orderedLogsDigest = keccak256(abi.encode(logs));
        uint256 operatorUsdcAfter = PftExecToken(USDC).balanceOf(address(this));

        require(realizedProfit == expectedProfit, "PROFIT");
        require(operatorUsdcAfter - operatorUsdcBefore == realizedProfit, "OPERATOR_DELTA");
        require(PftExecToken(USDC).balanceOf(address(executor)) == 0, "EXECUTOR_USDC");
        require(PftExecToken(WETH).balanceOf(address(executor)) == 0, "EXECUTOR_WETH");

        (uint112 reserve0After, uint112 reserve1After,) = pair.getReserves();
        require(
            uint256(reserve0After) == uint256(reserve0Before) - amountOut,
            "PAIR_RESERVE0"
        );
        require(
            uint256(reserve1After) == uint256(reserve1Before) + COLLATERAL_TO_LIQUIDATOR,
            "PAIR_RESERVE1"
        );

        emit PftExecutorHistoricalForkEvidence(
            realizedProfit,
            flashPremium,
            amountOut,
            orderedLogsDigest
        );

        string memory key = "evidence";
        vm.serializeBytes32(key, "transaction_hash", TX);
        vm.serializeUint(key, "block_number", BLOCK_NUMBER);
        vm.serializeBytes32(key, "parent_hash", PARENT_HASH);
        vm.serializeAddress(key, "executor", address(executor));
        vm.serializeBytes32(key, "executor_runtime_keccak256", keccak256(address(executor).code));
        vm.serializeAddress(key, "borrower", BORROWER);
        vm.serializeAddress(key, "collateral_asset", WETH);
        vm.serializeAddress(key, "debt_asset", USDC);
        vm.serializeAddress(key, "v2_pair", USDC_WETH_PAIR);
        vm.serializeUint(key, "debt_to_cover", DEBT_TO_COVER);
        vm.serializeUint(key, "collateral_to_liquidator", COLLATERAL_TO_LIQUIDATOR);
        vm.serializeUint(key, "pair_reserve0_before", reserve0Before);
        vm.serializeUint(key, "pair_reserve1_before", reserve1Before);
        vm.serializeUint(key, "pair_amount_out", amountOut);
        vm.serializeUint(key, "flash_premium_bps", premiumBps);
        vm.serializeUint(key, "flash_premium", flashPremium);
        vm.serializeUint(key, "realized_profit", realizedProfit);
        vm.serializeUint(key, "operator_usdc_delta", operatorUsdcAfter - operatorUsdcBefore);
        vm.serializeUint(key, "pair_reserve0_after", reserve0After);
        vm.serializeUint(key, "pair_reserve1_after", reserve1After);
        vm.serializeBytes32(key, "ordered_logs_digest", orderedLogsDigest);
        string memory json = vm.serializeUint(key, "ordered_log_count", logs.length);
        vm.writeJson(json, evidencePath);
    }
}
