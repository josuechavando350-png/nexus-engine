// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IAaveV3PoolMinimal {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}

interface IUniswapV2PairMinimal {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata data) external;
}

/// @notice Minimal atomic executor. It contains no discovery, pricing, routing, or bidding logic.
/// Every economic decision is made offchain, simulated against the same canonical state, and
/// encoded into an immutable per-call execution plan.
contract NqcAaveV3Executor {
    error NotOperator();
    error Reentrancy();
    error WrongChain(uint256 expected, uint256 actual);
    error Expired(uint256 validThroughBlock, uint256 currentBlock);
    error ZeroAddress();
    error IdenticalAssets();
    error ZeroDebtToCover();
    error EmptyRoute();
    error RouteTooLong(uint256 length);
    error InvalidRoute(uint256 index);
    error DuplicateRoutePair(uint256 firstIndex, uint256 secondIndex);
    error RouteCycle(uint256 firstIndex, uint256 secondIndex);
    error InvalidCallbackSender(address sender);
    error InvalidInitiator(address initiator);
    error InvalidFlashAsset(address asset);
    error InvalidFlashAmount(uint256 amount);
    error InsufficientFreshBalance(address token, uint256 required, uint256 available);
    error InsufficientProfit(uint256 required, uint256 actual);
    error TokenCallFailed(address token, bytes4 selector);
    error BalanceDecreasedBelowBaseline(address token, uint256 baseline, uint256 current);
    error PlanHashMismatch(bytes32 expected, bytes32 actual);

    uint256 internal constant MAX_HOPS = 4;

    struct V2Hop {
        address pair;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 amountOut;
    }

    struct ExecutionPlan {
        uint256 chainId;
        uint256 validThroughBlock;
        address borrower;
        address collateralAsset;
        address debtAsset;
        uint256 debtToCover;
        uint256 minProfitDebtAsset;
        V2Hop[] hops;
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
    IAaveV3PoolMinimal public immutable pool;
    bool private entered;

    event LiquidationExecuted(
        bytes32 indexed planHash,
        address indexed borrower,
        address indexed collateralAsset,
        address debtAsset,
        uint256 debtToCover,
        uint256 premium,
        uint256 realizedProfitDebtAsset
    );

    constructor(address operator_, address pool_) {
        if (operator_ == address(0) || pool_ == address(0)) revert ZeroAddress();
        operator = operator_;
        pool = IAaveV3PoolMinimal(pool_);
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

    function execute(ExecutionPlan calldata plan)
        external
        onlyOperator
        nonReentrant
        returns (uint256 realizedProfitDebtAsset)
    {
        _validatePlan(plan);
        BalanceBaseline[] memory baselines = _captureBaselines(plan);
        uint256 debtBaseline = _baselineOf(baselines, plan.debtAsset);
        bytes32 planHash = keccak256(abi.encode(plan));

        CallbackContext memory context = CallbackContext({
            planHash: planHash,
            plan: plan,
            baselines: baselines
        });
        pool.flashLoanSimple(address(this), plan.debtAsset, plan.debtToCover, abi.encode(context), 0);

        uint256 finalDebtBalance = _balanceOf(plan.debtAsset);
        if (finalDebtBalance < debtBaseline) {
            revert BalanceDecreasedBelowBaseline(plan.debtAsset, debtBaseline, finalDebtBalance);
        }
        realizedProfitDebtAsset = finalDebtBalance - debtBaseline;
        if (realizedProfitDebtAsset < plan.minProfitDebtAsset) {
            revert InsufficientProfit(plan.minProfitDebtAsset, realizedProfitDebtAsset);
        }

        _safeTransfer(plan.debtAsset, operator, realizedProfitDebtAsset);
        _sweepFreshResidues(plan, baselines);
    }

    /// @notice Aave V3 flashLoanSimple callback.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(pool)) revert InvalidCallbackSender(msg.sender);
        if (initiator != address(this)) revert InvalidInitiator(initiator);

        CallbackContext memory context = abi.decode(params, (CallbackContext));
        ExecutionPlan memory plan = context.plan;
        bytes32 actualPlanHash = keccak256(abi.encode(plan));
        if (actualPlanHash != context.planHash) {
            revert PlanHashMismatch(context.planHash, actualPlanHash);
        }
        if (asset != plan.debtAsset) revert InvalidFlashAsset(asset);
        if (amount != plan.debtToCover) revert InvalidFlashAmount(amount);
        if (block.chainid != plan.chainId) revert WrongChain(plan.chainId, block.chainid);
        if (block.number > plan.validThroughBlock) revert Expired(plan.validThroughBlock, block.number);

        _forceApprove(plan.debtAsset, address(pool), plan.debtToCover);
        pool.liquidationCall(
            plan.collateralAsset,
            plan.debtAsset,
            plan.borrower,
            plan.debtToCover,
            false
        );
        _forceApprove(plan.debtAsset, address(pool), 0);

        uint256 freshCollateral = _freshBalance(context.baselines, plan.collateralAsset);
        if (freshCollateral < plan.hops[0].amountIn) {
            revert InsufficientFreshBalance(
                plan.collateralAsset,
                plan.hops[0].amountIn,
                freshCollateral
            );
        }

        uint256 length = plan.hops.length;
        for (uint256 i; i < length; ++i) {
            V2Hop memory hop = plan.hops[i];
            uint256 available = _freshBalance(context.baselines, hop.tokenIn);
            if (available < hop.amountIn) {
                revert InsufficientFreshBalance(hop.tokenIn, hop.amountIn, available);
            }
            _swapExactOutput(hop, i);
        }

        uint256 debtBaseline = _baselineOf(context.baselines, plan.debtAsset);
        uint256 debtBalance = _balanceOf(plan.debtAsset);
        uint256 repayment = amount + premium;
        uint256 requiredBalance = debtBaseline + repayment + plan.minProfitDebtAsset;
        if (debtBalance < requiredBalance) {
            uint256 freshDebt = debtBalance >= debtBaseline ? debtBalance - debtBaseline : 0;
            uint256 realizedBeforeRepay = freshDebt > repayment ? freshDebt - repayment : 0;
            revert InsufficientProfit(plan.minProfitDebtAsset, realizedBeforeRepay);
        }

        _forceApprove(plan.debtAsset, address(pool), repayment);
        emit LiquidationExecuted(
            context.planHash,
            plan.borrower,
            plan.collateralAsset,
            plan.debtAsset,
            plan.debtToCover,
            premium,
            debtBalance - debtBaseline - repayment
        );
        return true;
    }

    function _validatePlan(ExecutionPlan calldata plan) private view {
        if (block.chainid != plan.chainId) revert WrongChain(plan.chainId, block.chainid);
        if (block.number > plan.validThroughBlock) revert Expired(plan.validThroughBlock, block.number);
        if (
            plan.borrower == address(0) ||
            plan.collateralAsset == address(0) ||
            plan.debtAsset == address(0)
        ) revert ZeroAddress();
        if (plan.collateralAsset == plan.debtAsset) revert IdenticalAssets();
        if (plan.debtToCover == 0) revert ZeroDebtToCover();

        uint256 length = plan.hops.length;
        if (length == 0) revert EmptyRoute();
        if (length > MAX_HOPS) revert RouteTooLong(length);
        if (plan.hops[0].tokenIn != plan.collateralAsset) revert InvalidRoute(0);
        if (plan.hops[length - 1].tokenOut != plan.debtAsset) revert InvalidRoute(length - 1);

        for (uint256 i; i < length; ++i) {
            V2Hop calldata hop = plan.hops[i];
            if (
                hop.pair == address(0) ||
                hop.tokenIn == address(0) ||
                hop.tokenOut == address(0) ||
                hop.tokenIn == hop.tokenOut ||
                hop.amountIn == 0 ||
                hop.amountOut == 0
            ) revert InvalidRoute(i);
            if (i != 0) {
                V2Hop calldata previous = plan.hops[i - 1];
                if (hop.tokenIn != previous.tokenOut || hop.amountIn != previous.amountOut) {
                    revert InvalidRoute(i);
                }
            }
            for (uint256 j; j < i; ++j) {
                V2Hop calldata prior = plan.hops[j];
                if (prior.pair == hop.pair) revert DuplicateRoutePair(j, i);
                if (prior.tokenIn == hop.tokenOut || prior.tokenOut == hop.tokenOut) {
                    revert RouteCycle(j, i);
                }
            }
        }
    }

    function _swapExactOutput(V2Hop memory hop, uint256 routeIndex) private {
        IUniswapV2PairMinimal pair = IUniswapV2PairMinimal(hop.pair);
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
        // debt + collateral + every hop tokenOut. Duplicate entries are harmless because
        // baseline lookup returns the first exact token match and all captures happen pre-loan.
        uint256 length = plan.hops.length;
        baselines = new BalanceBaseline[](length + 2);
        baselines[0] = BalanceBaseline(plan.debtAsset, _balanceOf(plan.debtAsset));
        baselines[1] = BalanceBaseline(plan.collateralAsset, _balanceOf(plan.collateralAsset));
        for (uint256 i; i < length; ++i) {
            address token = plan.hops[i].tokenOut;
            baselines[i + 2] = BalanceBaseline(token, _balanceOf(token));
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
        if (current < baseline) revert BalanceDecreasedBelowBaseline(token, baseline, current);
        return current - baseline;
    }

    function _sweepFreshResidues(ExecutionPlan calldata plan, BalanceBaseline[] memory baselines) private {
        uint256 length = plan.hops.length;
        for (uint256 i; i < length + 1; ++i) {
            address token = i == 0 ? plan.collateralAsset : plan.hops[i - 1].tokenOut;
            if (token == plan.debtAsset) continue;
            uint256 fresh = _freshBalance(baselines, token);
            if (fresh != 0) _safeTransfer(token, operator, fresh);
        }
    }

    function _balanceOf(address token) private view returns (uint256 balance) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSelector(IERC20Minimal.balanceOf.selector, address(this))
        );
        if (!ok || data.length < 32) revert TokenCallFailed(token, IERC20Minimal.balanceOf.selector);
        balance = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenCallFailed(token, IERC20Minimal.transfer.selector);
        }
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        if (_tryApprove(token, spender, amount)) return;
        if (!_tryApprove(token, spender, 0) || !_tryApprove(token, spender, amount)) {
            revert TokenCallFailed(token, IERC20Minimal.approve.selector);
        }
    }

    function _tryApprove(address token, address spender, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.approve.selector, spender, amount)
        );
        return ok && (data.length == 0 || (data.length >= 32 && abi.decode(data, (bool))));
    }
}
