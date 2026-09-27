// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice NEW T39 measured repair source. This is not recovered historical source.
interface IERC20BackrunMinimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAaveV3FlashPoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IUniswapV2PairWitnessMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

contract NqcV2BackrunExecutor {
    error ZeroAddress();
    error NotOperator();
    error Reentrancy();
    error ActivePlanExists(bytes32 activePlanHash);
    error WrongChain(uint256 expected, uint256 actual);
    error WrongTargetBlock(uint256 expected, uint256 actual);
    error InvalidParentHash();
    error ParentHashMismatch(bytes32 expected, bytes32 actual);
    error InvalidFlashAmount();
    error InvalidMinProfit();
    error InvalidProvenance();
    error EmptyRoute();
    error RouteTooLong(uint256 length);
    error InvalidRoute(uint256 index);
    error DuplicateRoutePair(uint256 firstIndex, uint256 secondIndex);
    error RouteCycle(uint256 firstIndex, uint256 secondIndex);
    error PairIdentityMismatch(
        uint256 index,
        address expectedToken0,
        address expectedToken1,
        address actualToken0,
        address actualToken1
    );
    error ReserveWitnessMismatch(
        uint256 index,
        uint112 expectedReserve0,
        uint112 expectedReserve1,
        uint112 actualReserve0,
        uint112 actualReserve1
    );
    error InvalidCallbackSender(address sender);
    error InvalidInitiator(address initiator);
    error InvalidFlashAsset(address asset);
    error InvalidFlashPrincipal(uint256 expected, uint256 actual);
    error NoActivePlan();
    error CallbackAlreadyConsumed();
    error PlanHashMismatch(bytes32 expected, bytes32 actual);
    error InsufficientFreshBalance(address token, uint256 required, uint256 available);
    error InsufficientProfit(uint256 required, uint256 actual);
    error BalanceDecreasedBelowBaseline(address token, uint256 baseline, uint256 current);
    error TokenCallFailed(address token, bytes4 selector);
    error CallbackNotConsumed();

    uint256 internal constant MAX_HOPS = 4;

    struct HopWitness {
        address pair;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
        uint112 reserve0;
        uint112 reserve1;
    }

    struct ExecutionPlan {
        uint256 chainId;
        uint256 targetBlock;
        bytes32 parentHash;
        address flashAsset;
        uint256 flashAmount;
        uint256 minProfit;
        bytes32 targetProvenance;
        bytes32 candidateProvenance;
        HopWitness[] hops;
    }

    struct BalanceBaseline {
        address token;
        uint256 balance;
    }

    struct CallbackContext {
        bytes32 planHash;
        ExecutionPlan plan;
        BalanceBaseline[] baselines;
    }

    address public immutable operator;
    IAaveV3FlashPoolMinimal public immutable pool;

    bool private entered;
    bytes32 private activePlanHash;
    bool private callbackConsumed;

    event BackrunExecuted(
        bytes32 indexed planHash,
        bytes32 indexed targetProvenance,
        bytes32 indexed candidateProvenance,
        uint256 targetBlock,
        bytes32 parentHash,
        address flashAsset,
        uint256 flashAmount,
        uint256 premium,
        uint256 realizedProfit
    );

    constructor(address operator_, address pool_) {
        if (operator_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        operator = operator_;
        pool = IAaveV3FlashPoolMinimal(pool_);
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    function hashPlan(ExecutionPlan memory plan) public pure returns (bytes32) {
        return keccak256(abi.encode(plan));
    }

    function execute(ExecutionPlan calldata plan)
        external
        onlyOperator
        nonReentrant
        returns (uint256 realizedProfit)
    {
        _validatePlan(plan);
        _validateWitnesses(plan);
        if (activePlanHash != bytes32(0)) revert ActivePlanExists(activePlanHash);

        BalanceBaseline[] memory baselines = _captureBaselines(plan);
        uint256 flashBaseline = _baselineOf(baselines, plan.flashAsset);
        bytes32 planHash = keccak256(abi.encode(plan));

        activePlanHash = planHash;
        callbackConsumed = false;

        CallbackContext memory context = CallbackContext({
            planHash: planHash,
            plan: plan,
            baselines: baselines
        });

        pool.flashLoanSimple(
            address(this),
            plan.flashAsset,
            plan.flashAmount,
            abi.encode(context),
            0
        );

        if (!callbackConsumed) revert CallbackNotConsumed();
        activePlanHash = bytes32(0);

        uint256 finalFlashBalance = _balanceOf(plan.flashAsset);
        if (finalFlashBalance < flashBaseline) {
            revert BalanceDecreasedBelowBaseline(plan.flashAsset, flashBaseline, finalFlashBalance);
        }
        realizedProfit = finalFlashBalance - flashBaseline;
        if (realizedProfit < plan.minProfit) {
            revert InsufficientProfit(plan.minProfit, realizedProfit);
        }

        _safeTransfer(plan.flashAsset, operator, realizedProfit);
        _sweepFreshResidues(plan, baselines);
    }

    /// @dev Aave V3 is an explicit new repair funding choice, not a historical-source claim.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(pool)) revert InvalidCallbackSender(msg.sender);
        if (initiator != address(this)) revert InvalidInitiator(initiator);

        bytes32 expectedActive = activePlanHash;
        if (expectedActive == bytes32(0)) revert NoActivePlan();
        if (callbackConsumed) revert CallbackAlreadyConsumed();

        CallbackContext memory context = abi.decode(params, (CallbackContext));
        bytes32 actualPlanHash = keccak256(abi.encode(context.plan));
        if (context.planHash != expectedActive || actualPlanHash != expectedActive) {
            revert PlanHashMismatch(expectedActive, actualPlanHash);
        }

        _validatePlan(context.plan);
        _validateWitnesses(context.plan);

        if (asset != context.plan.flashAsset) revert InvalidFlashAsset(asset);
        if (amount != context.plan.flashAmount) {
            revert InvalidFlashPrincipal(context.plan.flashAmount, amount);
        }

        callbackConsumed = true;

        uint256 length = context.plan.hops.length;
        for (uint256 i; i < length; ++i) {
            HopWitness memory hop = context.plan.hops[i];
            uint256 freshInput = _freshBalance(context.baselines, hop.tokenIn);
            if (freshInput < hop.amountIn) {
                revert InsufficientFreshBalance(hop.tokenIn, hop.amountIn, freshInput);
            }
            _swapExactOutput(hop, i);
        }

        uint256 baseline = _baselineOf(context.baselines, context.plan.flashAsset);
        uint256 balance = _balanceOf(context.plan.flashAsset);
        uint256 repayment = amount + premium;
        uint256 required = baseline + repayment + context.plan.minProfit;
        if (balance < required) {
            uint256 fresh = balance >= baseline ? balance - baseline : 0;
            uint256 profitBeforeRepay = fresh > repayment ? fresh - repayment : 0;
            revert InsufficientProfit(context.plan.minProfit, profitBeforeRepay);
        }

        _forceApprove(context.plan.flashAsset, address(pool), repayment);

        emit BackrunExecuted(
            context.planHash,
            context.plan.targetProvenance,
            context.plan.candidateProvenance,
            context.plan.targetBlock,
            context.plan.parentHash,
            context.plan.flashAsset,
            context.plan.flashAmount,
            premium,
            balance - baseline - repayment
        );
        return true;
    }

    function _validatePlan(ExecutionPlan memory plan) internal view {
        if (block.chainid != plan.chainId) revert WrongChain(plan.chainId, block.chainid);
        if (plan.targetBlock == 0 || block.number != plan.targetBlock) {
            revert WrongTargetBlock(plan.targetBlock, block.number);
        }
        if (plan.parentHash == bytes32(0)) revert InvalidParentHash();

        bytes32 actualParent = blockhash(plan.targetBlock - 1);
        if (actualParent != plan.parentHash) {
            revert ParentHashMismatch(plan.parentHash, actualParent);
        }

        if (plan.flashAsset == address(0)) revert ZeroAddress();
        if (plan.flashAmount == 0) revert InvalidFlashAmount();
        if (plan.minProfit == 0) revert InvalidMinProfit();
        if (
            plan.targetProvenance == bytes32(0) ||
            plan.candidateProvenance == bytes32(0) ||
            plan.targetProvenance == plan.candidateProvenance
        ) revert InvalidProvenance();

        uint256 length = plan.hops.length;
        if (length == 0) revert EmptyRoute();
        if (length > MAX_HOPS) revert RouteTooLong(length);

        if (plan.hops[0].tokenIn != plan.flashAsset) revert InvalidRoute(0);
        if (plan.hops[0].amountIn != plan.flashAmount) revert InvalidRoute(0);
        if (plan.hops[length - 1].tokenOut != plan.flashAsset) {
            revert InvalidRoute(length - 1);
        }

        for (uint256 i; i < length; ++i) {
            HopWitness memory hop = plan.hops[i];
            if (
                hop.pair == address(0) ||
                hop.tokenIn == address(0) ||
                hop.tokenOut == address(0) ||
                hop.tokenIn == hop.tokenOut ||
                hop.amountIn == 0 ||
                hop.amountOut == 0
            ) revert InvalidRoute(i);

            if (i != 0) {
                HopWitness memory previous = plan.hops[i - 1];
                if (previous.tokenOut != hop.tokenIn || previous.amountOut != hop.amountIn) {
                    revert InvalidRoute(i);
                }
            }

            for (uint256 j; j < i; ++j) {
                HopWitness memory prior = plan.hops[j];
                if (prior.pair == hop.pair) revert DuplicateRoutePair(j, i);
                if (
                    i + 1 != length &&
                    (prior.tokenIn == hop.tokenOut || prior.tokenOut == hop.tokenOut)
                ) revert RouteCycle(j, i);
            }
        }
    }

    function _validateWitnesses(ExecutionPlan memory plan) internal view {
        uint256 length = plan.hops.length;
        for (uint256 i; i < length; ++i) {
            HopWitness memory hop = plan.hops[i];
            IUniswapV2PairWitnessMinimal pair = IUniswapV2PairWitnessMinimal(hop.pair);
            address actualToken0 = pair.token0();
            address actualToken1 = pair.token1();
            bool forward = actualToken0 == hop.tokenIn && actualToken1 == hop.tokenOut;
            bool reverse = actualToken0 == hop.tokenOut && actualToken1 == hop.tokenIn;
            if (!forward && !reverse) {
                revert PairIdentityMismatch(
                    i,
                    hop.tokenIn,
                    hop.tokenOut,
                    actualToken0,
                    actualToken1
                );
            }

            (uint112 reserve0, uint112 reserve1,) = pair.getReserves();
            if (reserve0 != hop.reserve0 || reserve1 != hop.reserve1) {
                revert ReserveWitnessMismatch(
                    i,
                    hop.reserve0,
                    hop.reserve1,
                    reserve0,
                    reserve1
                );
            }
        }
    }

    function _swapExactOutput(HopWitness memory hop, uint256 routeIndex) private {
        IUniswapV2PairWitnessMinimal pair = IUniswapV2PairWitnessMinimal(hop.pair);
        address token0 = pair.token0();
        address token1 = pair.token1();

        uint256 amount0Out;
        uint256 amount1Out;
        if (token0 == hop.tokenIn && token1 == hop.tokenOut) {
            amount1Out = hop.amountOut;
        } else if (token1 == hop.tokenIn && token0 == hop.tokenOut) {
            amount0Out = hop.amountOut;
        } else {
            revert InvalidRoute(routeIndex);
        }

        uint256 beforeOut = _balanceOf(hop.tokenOut);
        _safeTransfer(hop.tokenIn, hop.pair, hop.amountIn);
        pair.swap(amount0Out, amount1Out, address(this), "");
        uint256 afterOut = _balanceOf(hop.tokenOut);
        uint256 received = afterOut >= beforeOut ? afterOut - beforeOut : 0;
        if (received < hop.amountOut) {
            revert InsufficientFreshBalance(hop.tokenOut, hop.amountOut, received);
        }
    }

    function _captureBaselines(ExecutionPlan calldata plan)
        private
        view
        returns (BalanceBaseline[] memory baselines)
    {
        uint256 length = plan.hops.length;
        baselines = new BalanceBaseline[](length + 1);
        baselines[0] = BalanceBaseline(plan.flashAsset, _balanceOf(plan.flashAsset));
        for (uint256 i; i < length; ++i) {
            address token = plan.hops[i].tokenOut;
            baselines[i + 1] = BalanceBaseline(token, _balanceOf(token));
        }
    }

    function _baselineOf(BalanceBaseline[] memory baselines, address token)
        private
        pure
        returns (uint256)
    {
        uint256 length = baselines.length;
        for (uint256 i; i < length; ++i) {
            if (baselines[i].token == token) return baselines[i].balance;
        }
        return 0;
    }

    function _freshBalance(BalanceBaseline[] memory baselines, address token)
        private
        view
        returns (uint256)
    {
        uint256 baseline = _baselineOf(baselines, token);
        uint256 current = _balanceOf(token);
        if (current < baseline) {
            revert BalanceDecreasedBelowBaseline(token, baseline, current);
        }
        return current - baseline;
    }

    function _sweepFreshResidues(
        ExecutionPlan calldata plan,
        BalanceBaseline[] memory baselines
    ) private {
        uint256 length = plan.hops.length;
        for (uint256 i; i < length; ++i) {
            address token = plan.hops[i].tokenOut;
            if (token == plan.flashAsset) continue;
            uint256 fresh = _freshBalance(baselines, token);
            if (fresh != 0) _safeTransfer(token, operator, fresh);
        }
    }

    function _balanceOf(address token) private view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20BackrunMinimal.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) {
            revert TokenCallFailed(token, IERC20BackrunMinimal.balanceOf.selector);
        }
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20BackrunMinimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IERC20BackrunMinimal.transfer.selector);
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0) || !_tryApprove(token, spender, amount)) {
            revert TokenCallFailed(token, IERC20BackrunMinimal.approve.selector);
        }
    }

    function _tryApprove(address token, address spender, uint256 amount)
        private
        returns (bool)
    {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20BackrunMinimal.approve.selector, spender, amount)
        );
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }
}
