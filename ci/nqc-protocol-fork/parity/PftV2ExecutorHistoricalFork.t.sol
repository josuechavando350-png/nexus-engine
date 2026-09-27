// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcV2BackrunExecutor} from "../src/NqcV2BackrunExecutor.sol";

interface PftV2ExecVm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function envString(string calldata name) external returns (string memory value);
    function createSelectFork(string calldata urlOrAlias, uint256 blockNumber)
        external
        returns (uint256 forkId);
    function deal(address account, uint256 newBalance) external;
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

interface PftV2ExecWeth {
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface PftV2ExecToken {
    function balanceOf(address account) external view returns (uint256);
}

interface PftV2ExecPair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 timestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

interface PftV2ExecPool {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

contract PftV2ExecutorHistoricalForkTest {
    PftV2ExecVm private constant vm =
        PftV2ExecVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 private constant BLOCK_NUMBER = 25_252_136;
    bytes32 private constant BLOCK_HASH =
        0x49edc621ec5fe843353be319ae1a307be4e37d2a51111ccc07a2c8aae3ff6470;
    bytes32 private constant PARENT_HASH =
        0x04a2465e3a87b1103521c1f54e568de209062f08742a0212da24d34eee4aac78;

    address private constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address private constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address private constant UNI_USDC_WETH =
        0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc;
    address private constant SUSHI_USDC_WETH =
        0x397FF1542f962076d0BFE58eA045FfA2d347ACa0;

    uint256 private constant FEE_BPS = 30;
    uint256 private constant MAX_FLASH_USDC = 500_000 * 1e6;

    struct Cycle {
        uint112 uni0;
        uint112 uni1;
        uint112 sushi0;
        uint112 sushi1;
        uint256 flashAmount;
        uint256 wethOut;
        uint256 usdcOut;
        uint256 premium;
        uint256 expectedProfit;
        uint256 targetWethIn;
        uint256 targetUsdcOut;
    }

    struct RunEvidence {
        address executor;
        bytes32 planHash;
        bytes32 targetProvenance;
        bytes32 candidateProvenance;
        bytes32 orderedLogsDigest;
        uint256 orderedLogCount;
        uint256 operatorDelta;
        uint112 uni0After;
        uint112 uni1After;
        uint112 sushi0After;
        uint112 sushi1After;
    }

    function _flashPremium(uint256 amount, uint256 premiumBps)
        private
        pure
        returns (uint256)
    {
        if (amount == 0 || premiumBps == 0) return 0;
        return (amount * premiumBps - 1) / 10_000 + 1;
    }

    function _quote(uint256 amountIn, uint256 reserveIn, uint256 reserveOut)
        private
        pure
        returns (uint256)
    {
        uint256 amountWithFee = amountIn * (10_000 - FEE_BPS);
        return amountWithFee * reserveOut / (reserveIn * 10_000 + amountWithFee);
    }

    function _pair(address pairAddress) private view returns (PftV2ExecPair pair) {
        pair = PftV2ExecPair(pairAddress);
        require(pair.token0() == USDC, "TOKEN0_NOT_USDC");
        require(pair.token1() == WETH, "TOKEN1_NOT_WETH");
    }

    function _createSyntheticTarget(PftV2ExecPair uni)
        private
        returns (uint256 targetWethIn, uint256 targetUsdcOut)
    {
        (uint112 reserve0, uint112 reserve1,) = uni.getReserves();
        require(reserve0 > 0 && reserve1 > 80, "UNI_EMPTY");
        targetWethIn = uint256(reserve1) / 8;
        require(targetWethIn > 0, "ZERO_TARGET");

        vm.deal(address(this), targetWethIn);
        PftV2ExecWeth(WETH).deposit{value: targetWethIn}();
        require(
            PftV2ExecWeth(WETH).transfer(UNI_USDC_WETH, targetWethIn),
            "TARGET_WETH_TRANSFER"
        );

        targetUsdcOut = _quote(targetWethIn, reserve1, reserve0);
        require(targetUsdcOut > 0 && targetUsdcOut < reserve0, "TARGET_QUOTE");
        uni.swap(targetUsdcOut, 0, address(this), "");
    }

    function _cycle(PftV2ExecPair uni, PftV2ExecPair sushi)
        private
        view
        returns (Cycle memory c)
    {
        (c.uni0, c.uni1,) = uni.getReserves();
        (c.sushi0, c.sushi1,) = sushi.getReserves();
        require(c.uni0 > 0 && c.uni1 > 0 && c.sushi0 > 0 && c.sushi1 > 0, "EMPTY_PAIR");

        c.flashAmount = uint256(c.uni0) / 500;
        if (c.flashAmount > MAX_FLASH_USDC) c.flashAmount = MAX_FLASH_USDC;
        require(c.flashAmount >= 1_000 * 1e6, "FLASH_TOO_SMALL");

        c.wethOut = _quote(c.flashAmount, c.uni0, c.uni1);
        c.usdcOut = _quote(c.wethOut, c.sushi1, c.sushi0);
        uint256 premiumBps = uint256(PftV2ExecPool(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL());
        c.premium = _flashPremium(c.flashAmount, premiumBps);
        require(c.usdcOut > c.flashAmount + c.premium, "SYNTHETIC_TARGET_NO_EDGE");
        c.expectedProfit = c.usdcOut - c.flashAmount - c.premium;
    }

    function _plan(Cycle memory c)
        private
        view
        returns (
            NqcV2BackrunExecutor.ExecutionPlan memory plan,
            bytes32 targetProvenance,
            bytes32 candidateProvenance
        )
    {
        targetProvenance = keccak256(
            abi.encode(
                "PFT_SYNTHETIC_TARGET_OVER_HISTORICAL_STATE",
                BLOCK_HASH,
                c.targetWethIn,
                c.targetUsdcOut
            )
        );
        candidateProvenance = keccak256(
            abi.encode(
                "PFT_REAL_V2_CYCLE_CANDIDATE",
                UNI_USDC_WETH,
                SUSHI_USDC_WETH,
                c.flashAmount,
                c.wethOut,
                c.usdcOut,
                c.uni0,
                c.uni1,
                c.sushi0,
                c.sushi1
            )
        );
        require(targetProvenance != candidateProvenance, "PROVENANCE_COLLISION");

        NqcV2BackrunExecutor.HopWitness[] memory hops =
            new NqcV2BackrunExecutor.HopWitness[](2);
        hops[0] = NqcV2BackrunExecutor.HopWitness({
            pair: UNI_USDC_WETH,
            tokenIn: USDC,
            tokenOut: WETH,
            amountIn: c.flashAmount,
            amountOut: c.wethOut,
            reserve0: c.uni0,
            reserve1: c.uni1
        });
        hops[1] = NqcV2BackrunExecutor.HopWitness({
            pair: SUSHI_USDC_WETH,
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: c.wethOut,
            amountOut: c.usdcOut,
            reserve0: c.sushi0,
            reserve1: c.sushi1
        });

        plan = NqcV2BackrunExecutor.ExecutionPlan({
            chainId: 1,
            targetBlock: BLOCK_NUMBER,
            parentHash: PARENT_HASH,
            flashAsset: USDC,
            flashAmount: c.flashAmount,
            minProfit: 1,
            targetProvenance: targetProvenance,
            candidateProvenance: candidateProvenance,
            hops: hops
        });
    }

    function _execute(
        PftV2ExecPair uni,
        PftV2ExecPair sushi,
        Cycle memory c
    ) private returns (RunEvidence memory e) {
        NqcV2BackrunExecutor executor =
            new NqcV2BackrunExecutor(address(this), AAVE_POOL);
        (
            NqcV2BackrunExecutor.ExecutionPlan memory plan,
            bytes32 targetProvenance,
            bytes32 candidateProvenance
        ) = _plan(c);

        uint256 operatorBefore = PftV2ExecToken(USDC).balanceOf(address(this));
        vm.recordLogs();
        uint256 realized = executor.execute(plan);
        PftV2ExecVm.Log[] memory logs = vm.getRecordedLogs();
        uint256 operatorAfter = PftV2ExecToken(USDC).balanceOf(address(this));

        require(realized == c.expectedProfit, "REALIZED_PROFIT");
        require(operatorAfter - operatorBefore == realized, "OPERATOR_DELTA");
        require(PftV2ExecToken(USDC).balanceOf(address(executor)) == 0, "EXEC_USDC");
        require(PftV2ExecToken(WETH).balanceOf(address(executor)) == 0, "EXEC_WETH");

        (e.uni0After, e.uni1After,) = uni.getReserves();
        (e.sushi0After, e.sushi1After,) = sushi.getReserves();
        require(uint256(e.uni0After) == uint256(c.uni0) + c.flashAmount, "UNI_R0");
        require(uint256(e.uni1After) == uint256(c.uni1) - c.wethOut, "UNI_R1");
        require(uint256(e.sushi0After) == uint256(c.sushi0) - c.usdcOut, "SUSHI_R0");
        require(uint256(e.sushi1After) == uint256(c.sushi1) + c.wethOut, "SUSHI_R1");

        e.executor = address(executor);
        e.planHash = executor.hashPlan(plan);
        e.targetProvenance = targetProvenance;
        e.candidateProvenance = candidateProvenance;
        e.orderedLogsDigest = keccak256(abi.encode(logs));
        e.orderedLogCount = logs.length;
        e.operatorDelta = operatorAfter - operatorBefore;
    }

    function _writeEvidence(
        string memory path,
        Cycle memory c,
        RunEvidence memory e
    ) private {
        string memory key = "evidence";
        vm.serializeUint(key, "block_number", BLOCK_NUMBER);
        vm.serializeBytes32(key, "block_hash", BLOCK_HASH);
        vm.serializeBytes32(key, "parent_hash", PARENT_HASH);
        vm.serializeAddress(key, "aave_pool", AAVE_POOL);
        vm.serializeAddress(key, "uniswap_pair", UNI_USDC_WETH);
        vm.serializeAddress(key, "sushiswap_pair", SUSHI_USDC_WETH);
        vm.serializeAddress(key, "executor", e.executor);
        vm.serializeBytes32(key, "executor_runtime_keccak256", keccak256(e.executor.code));
        vm.serializeBytes32(key, "plan_hash", e.planHash);
        vm.serializeBytes32(key, "target_provenance", e.targetProvenance);
        vm.serializeBytes32(key, "candidate_provenance", e.candidateProvenance);
        vm.serializeUint(key, "synthetic_target_weth_in", c.targetWethIn);
        vm.serializeUint(key, "synthetic_target_usdc_out", c.targetUsdcOut);
        vm.serializeUint(key, "flash_usdc", c.flashAmount);
        vm.serializeUint(key, "flash_premium", c.premium);
        vm.serializeUint(key, "hop0_weth_out", c.wethOut);
        vm.serializeUint(key, "hop1_usdc_out", c.usdcOut);
        vm.serializeUint(key, "realized_profit_usdc", c.expectedProfit);
        vm.serializeUint(key, "operator_usdc_delta", e.operatorDelta);
        vm.serializeUint(key, "uni_reserve0_before", c.uni0);
        vm.serializeUint(key, "uni_reserve1_before", c.uni1);
        vm.serializeUint(key, "uni_reserve0_after", e.uni0After);
        vm.serializeUint(key, "uni_reserve1_after", e.uni1After);
        vm.serializeUint(key, "sushi_reserve0_before", c.sushi0);
        vm.serializeUint(key, "sushi_reserve1_before", c.sushi1);
        vm.serializeUint(key, "sushi_reserve0_after", e.sushi0After);
        vm.serializeUint(key, "sushi_reserve1_after", e.sushi1After);
        vm.serializeBytes32(key, "ordered_logs_digest", e.orderedLogsDigest);
        string memory json = vm.serializeUint(key, "ordered_log_count", e.orderedLogCount);
        vm.writeJson(json, path);
    }

    function testFork_V2ExecutorSettlesSyntheticBackrunOverHistoricalMainnetState() public {
        vm.createSelectFork(vm.envString("PFT_RPC_URL"), BLOCK_NUMBER);
        require(block.number == BLOCK_NUMBER, "BLOCK_NUMBER");
        require(blockhash(BLOCK_NUMBER - 1) == PARENT_HASH, "PARENT_HASH");

        PftV2ExecPair uni = _pair(UNI_USDC_WETH);
        PftV2ExecPair sushi = _pair(SUSHI_USDC_WETH);

        Cycle memory c;
        (c.targetWethIn, c.targetUsdcOut) = _createSyntheticTarget(uni);
        Cycle memory computed = _cycle(uni, sushi);
        computed.targetWethIn = c.targetWethIn;
        computed.targetUsdcOut = c.targetUsdcOut;
        c = computed;

        RunEvidence memory e = _execute(uni, sushi, c);
        _writeEvidence(vm.envString("PFT_EVIDENCE_PATH"), c, e);
    }
}
