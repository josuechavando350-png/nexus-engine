// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20BackrunMinimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IV2BackrunPairMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves()
        external
        view
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice NEW measured replacement for the unavailable historical V2 backrun executor.
/// @dev This source is not recovered historical source. Flash-funding callback semantics remain
///      owned by the independently certified T36 NqcFlashFundingExecutor; this contract is the
///      funded strategy boundary that binds canonical backrun context and executes exact V2 hops.
contract NqcV2BackrunStrategyMeasured {
    error NotFundingExecutor(address expected, address actual);
    error ReentrantExecution();
    error WrongChain(uint256 expected, uint256 actual);
    error WrongTargetBlock(uint256 expected, uint256 actual);
    error WrongParentHash(bytes32 expected, bytes32 actual);
    error InvalidExecutionIdentity();
    error ExecutionIdentityMismatch(bytes32 expected, bytes32 actual);
    error ExecutionAlreadyConsumed(bytes32 executionIdentityHash);
    error InvalidProvenance();
    error InvalidAsset();
    error InvalidPrincipal();
    error InvalidMinProfit();
    error InvalidHopCount(uint256 length);
    error InvalidHop(uint256 index);
    error RouteDiscontinuity(uint256 index);
    error RouteDoesNotReturnToFundingAsset();
    error DuplicatePair(uint256 firstIndex, uint256 secondIndex);
    error RepeatedIntermediateToken(uint256 firstIndex, uint256 secondIndex);
    error PairIdentityMismatch(uint256 index);
    error ReserveWitnessMismatch(
        uint256 index,
        uint256 expectedReserve0,
        uint256 expectedReserve1,
        uint256 actualReserve0,
        uint256 actualReserve1
    );
    error QuoteMismatch(uint256 index, uint256 expectedAmountOut, uint256 actualAmountOut);
    error FreshInputMismatch(uint256 index, uint256 expectedAmount, uint256 actualAmount);
    error PairReceivedMismatch(uint256 index, uint256 expectedAmount, uint256 actualAmount);
    error OutputReceivedMismatch(uint256 index, uint256 expectedAmount, uint256 actualAmount);
    error BaselineUnderflow(address token, uint256 balance, uint256 requiredFresh);
    error IntermediateBaselineViolation(address token, uint256 baseline, uint256 finalBalance);
    error InsufficientProfit(uint256 requiredFreshReturn, uint256 actualFreshReturn);
    error FinalBaselineViolation(uint256 baseline, uint256 finalBalance);
    error TokenCallFailed(address token, bytes4 selector);

    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_HOPS = 4;

    struct Hop {
        address pair;
        address tokenIn;
        address tokenOut;
        uint256 reserve0;
        uint256 reserve1;
        uint32 feeBps;
        uint256 amountIn;
        uint256 amountOut;
    }

    struct BackrunPlan {
        uint256 chainId;
        uint256 targetBlock;
        bytes32 parentHash;
        bytes32 executionIdentityHash;
        bytes32 targetProvenanceHash;
        bytes32 candidateProvenanceHash;
        address asset;
        uint256 minProfitAsset;
        Hop[] hops;
    }

    address public immutable fundingExecutor;
    bool private entered;
    mapping(bytes32 => bool) public consumedExecutionIdentity;

    event BackrunExecuted(
        bytes32 indexed executionIdentityHash,
        bytes32 indexed targetProvenanceHash,
        bytes32 indexed candidateProvenanceHash,
        bytes32 planHash,
        uint256 targetBlock,
        bytes32 parentHash,
        address asset,
        uint256 principal,
        uint256 returnedAssetUnits,
        uint256 realizedProfitAsset
    );

    constructor(address fundingExecutor_) {
        if (fundingExecutor_ == address(0)) revert InvalidAsset();
        fundingExecutor = fundingExecutor_;
    }

    function hashPlan(BackrunPlan calldata plan) external pure returns (bytes32) {
        return keccak256(abi.encode(plan));
    }

    /// @notice Funded strategy entry point compatible with T36 INqcFundedStrategy.
    function executeFunded(
        bytes32 executionIdentityHash,
        address asset,
        uint256 principal,
        bytes calldata payload
    ) external returns (uint256 returnedAssetUnits) {
        if (msg.sender != fundingExecutor) {
            revert NotFundingExecutor(fundingExecutor, msg.sender);
        }
        if (entered) revert ReentrantExecution();
        entered = true;

        BackrunPlan memory plan = abi.decode(payload, (BackrunPlan));
        _validatePlan(plan, executionIdentityHash, asset, principal);

        if (consumedExecutionIdentity[executionIdentityHash]) {
            revert ExecutionAlreadyConsumed(executionIdentityHash);
        }
        consumedExecutionIdentity[executionIdentityHash] = true;

        (address[] memory routeTokens, uint256[] memory baselines) =
            _captureBaselines(plan, principal);

        _validateAllPairWitnesses(plan);

        for (uint256 i; i < plan.hops.length; ++i) {
            _executeHop(plan.hops[i], i, baselines[i], baselines[i + 1]);
        }

        uint256 finalAssetBalance = _balanceOf(plan.asset, address(this));
        uint256 assetBaseline = baselines[0];
        if (finalAssetBalance < assetBaseline) {
            revert BaselineUnderflow(plan.asset, finalAssetBalance, 0);
        }
        returnedAssetUnits = finalAssetBalance - assetBaseline;
        uint256 requiredFreshReturn = principal + plan.minProfitAsset;
        if (returnedAssetUnits < requiredFreshReturn) {
            revert InsufficientProfit(requiredFreshReturn, returnedAssetUnits);
        }

        for (uint256 i = 1; i + 1 < routeTokens.length; ++i) {
            uint256 finalIntermediate = _balanceOf(routeTokens[i], address(this));
            if (finalIntermediate != baselines[i]) {
                revert IntermediateBaselineViolation(
                    routeTokens[i], baselines[i], finalIntermediate
                );
            }
        }

        _safeTransfer(plan.asset, fundingExecutor, returnedAssetUnits);
        uint256 postReturn = _balanceOf(plan.asset, address(this));
        if (postReturn != assetBaseline) {
            revert FinalBaselineViolation(assetBaseline, postReturn);
        }

        entered = false;

        emit BackrunExecuted(
            executionIdentityHash,
            plan.targetProvenanceHash,
            plan.candidateProvenanceHash,
            keccak256(abi.encode(plan)),
            plan.targetBlock,
            plan.parentHash,
            plan.asset,
            principal,
            returnedAssetUnits,
            returnedAssetUnits - principal
        );
    }

    function _validatePlan(
        BackrunPlan memory plan,
        bytes32 executionIdentityHash,
        address asset,
        uint256 principal
    ) private view {
        if (plan.chainId != block.chainid) revert WrongChain(plan.chainId, block.chainid);
        if (plan.targetBlock != block.number) {
            revert WrongTargetBlock(plan.targetBlock, block.number);
        }
        bytes32 actualParent = blockhash(block.number - 1);
        if (plan.parentHash != actualParent) {
            revert WrongParentHash(plan.parentHash, actualParent);
        }
        if (plan.executionIdentityHash == bytes32(0)) revert InvalidExecutionIdentity();
        if (plan.executionIdentityHash != executionIdentityHash) {
            revert ExecutionIdentityMismatch(plan.executionIdentityHash, executionIdentityHash);
        }
        if (
            plan.targetProvenanceHash == bytes32(0)
                || plan.candidateProvenanceHash == bytes32(0)
                || plan.targetProvenanceHash == plan.candidateProvenanceHash
        ) revert InvalidProvenance();
        if (asset == address(0) || plan.asset != asset) revert InvalidAsset();
        if (principal == 0) revert InvalidPrincipal();
        if (plan.minProfitAsset == 0) revert InvalidMinProfit();

        uint256 length = plan.hops.length;
        if (length < 2 || length > MAX_HOPS) revert InvalidHopCount(length);
        if (plan.hops[0].tokenIn != asset) revert RouteDiscontinuity(0);
        if (plan.hops[0].amountIn != principal) revert InvalidPrincipal();
        if (plan.hops[length - 1].tokenOut != asset) {
            revert RouteDoesNotReturnToFundingAsset();
        }

        for (uint256 i; i < length; ++i) {
            Hop memory hop = plan.hops[i];
            if (
                hop.pair == address(0) || hop.tokenIn == address(0) || hop.tokenOut == address(0)
                    || hop.tokenIn == hop.tokenOut || hop.reserve0 == 0 || hop.reserve1 == 0
                    || hop.feeBps >= BPS || hop.amountIn == 0 || hop.amountOut == 0
            ) revert InvalidHop(i);

            if (i + 1 < length) {
                Hop memory next = plan.hops[i + 1];
                if (hop.tokenOut != next.tokenIn || hop.amountOut != next.amountIn) {
                    revert RouteDiscontinuity(i);
                }
                if (hop.tokenOut == asset) revert RouteDiscontinuity(i);
            }

            for (uint256 j; j < i; ++j) {
                if (plan.hops[j].pair == hop.pair) revert DuplicatePair(j, i);
            }
        }

        for (uint256 i = 1; i < length; ++i) {
            address token = plan.hops[i].tokenIn;
            for (uint256 j = 1; j < i; ++j) {
                if (plan.hops[j].tokenIn == token) {
                    revert RepeatedIntermediateToken(j, i);
                }
            }
        }
    }

    function _captureBaselines(BackrunPlan memory plan, uint256 principal)
        private
        view
        returns (address[] memory tokens, uint256[] memory baselines)
    {
        uint256 length = plan.hops.length;
        tokens = new address[](length + 1);
        baselines = new uint256[](length + 1);

        tokens[0] = plan.asset;
        uint256 assetBalance = _balanceOf(plan.asset, address(this));
        if (assetBalance < principal) {
            revert BaselineUnderflow(plan.asset, assetBalance, principal);
        }
        baselines[0] = assetBalance - principal;

        for (uint256 i = 1; i < length; ++i) {
            tokens[i] = plan.hops[i].tokenIn;
            baselines[i] = _balanceOf(tokens[i], address(this));
        }
        tokens[length] = plan.asset;
        baselines[length] = baselines[0];
    }

    function _validateAllPairWitnesses(BackrunPlan memory plan) private view {
        for (uint256 i; i < plan.hops.length; ++i) {
            Hop memory hop = plan.hops[i];
            IV2BackrunPairMinimal pair = IV2BackrunPairMinimal(hop.pair);
            address token0 = pair.token0();
            address token1 = pair.token1();
            bool forward = token0 == hop.tokenIn && token1 == hop.tokenOut;
            bool reverse = token0 == hop.tokenOut && token1 == hop.tokenIn;
            if (!forward && !reverse) revert PairIdentityMismatch(i);

            (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
            if (uint256(reserve0) != hop.reserve0 || uint256(reserve1) != hop.reserve1) {
                revert ReserveWitnessMismatch(
                    i, hop.reserve0, hop.reserve1, uint256(reserve0), uint256(reserve1)
                );
            }

            uint256 reserveIn = forward ? hop.reserve0 : hop.reserve1;
            uint256 reserveOut = forward ? hop.reserve1 : hop.reserve0;
            uint256 actualAmountOut =
                _quoteExactIn(hop.amountIn, reserveIn, reserveOut, hop.feeBps);
            if (actualAmountOut != hop.amountOut) {
                revert QuoteMismatch(i, hop.amountOut, actualAmountOut);
            }
        }
    }

    function _executeHop(
        Hop memory hop,
        uint256 index,
        uint256 inputBaseline,
        uint256 outputBaseline
    ) private {
        uint256 beforeInput = _balanceOf(hop.tokenIn, address(this));
        if (beforeInput < inputBaseline) {
            revert BaselineUnderflow(hop.tokenIn, beforeInput, hop.amountIn);
        }
        uint256 freshInput = beforeInput - inputBaseline;
        if (freshInput != hop.amountIn) {
            revert FreshInputMismatch(index, hop.amountIn, freshInput);
        }

        uint256 pairInputBefore = _balanceOf(hop.tokenIn, hop.pair);
        _safeTransfer(hop.tokenIn, hop.pair, hop.amountIn);
        uint256 pairInputAfter = _balanceOf(hop.tokenIn, hop.pair);
        uint256 pairReceived =
            pairInputAfter >= pairInputBefore ? pairInputAfter - pairInputBefore : 0;
        if (pairReceived != hop.amountIn) {
            revert PairReceivedMismatch(index, hop.amountIn, pairReceived);
        }

        uint256 beforeOutput = _balanceOf(hop.tokenOut, address(this));
        address token0 = IV2BackrunPairMinimal(hop.pair).token0();
        uint256 amount0Out = token0 == hop.tokenOut ? hop.amountOut : 0;
        uint256 amount1Out = token0 == hop.tokenOut ? 0 : hop.amountOut;
        IV2BackrunPairMinimal(hop.pair).swap(amount0Out, amount1Out, address(this), "");

        uint256 afterOutput = _balanceOf(hop.tokenOut, address(this));
        uint256 outputReceived =
            afterOutput >= beforeOutput ? afterOutput - beforeOutput : 0;
        if (outputReceived != hop.amountOut) {
            revert OutputReceivedMismatch(index, hop.amountOut, outputReceived);
        }
        if (afterOutput < outputBaseline || afterOutput - outputBaseline != hop.amountOut) {
            uint256 actualFresh = afterOutput >= outputBaseline ? afterOutput - outputBaseline : 0;
            revert OutputReceivedMismatch(index, hop.amountOut, actualFresh);
        }
    }

    function _quoteExactIn(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 feeBps
    ) private pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }

    function _balanceOf(address token, address account) private view returns (uint256) {
        return IERC20BackrunMinimal(token).balanceOf(account);
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20BackrunMinimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IERC20BackrunMinimal.transfer.selector);
        }
    }
}
