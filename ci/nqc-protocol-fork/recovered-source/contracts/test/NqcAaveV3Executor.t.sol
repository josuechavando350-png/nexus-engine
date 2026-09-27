// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcAaveV3Executor} from "../src/NqcAaveV3Executor.sol";

contract MockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, "BALANCE");
        unchecked {
            balanceOf[msg.sender] = balance - amount;
        }
        balanceOf[to] += amount;
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 approved = allowance[from][msg.sender];
        require(approved >= amount, "ALLOWANCE");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "BALANCE");
        if (approved != type(uint256).max) {
            allowance[from][msg.sender] = approved - amount;
        }
        unchecked {
            balanceOf[from] = balance - amount;
        }
        balanceOf[to] += amount;
        return true;
    }
}

contract MockV2Pair {
    address public immutable token0;
    address public immutable token1;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        if (amount0Out != 0) MockERC20(token0).mint(to, amount0Out);
        if (amount1Out != 0) MockERC20(token1).mint(to, amount1Out);
    }
}

contract MockAavePool {
    uint256 public premium;
    uint256 public collateralOut;

    constructor(uint256 premium_, uint256 collateralOut_) {
        premium = premium_;
        collateralOut = collateralOut_;
    }

    function setCollateralOut(uint256 amount) external {
        collateralOut = amount;
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        MockERC20(asset).mint(receiverAddress, amount);
        bool ok = NqcAaveV3Executor(receiverAddress).executeOperation(
            asset,
            amount,
            premium,
            receiverAddress,
            params
        );
        require(ok, "CALLBACK");
        require(
            MockERC20(asset).transferFrom(receiverAddress, address(this), amount + premium),
            "REPAY"
        );
    }

    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address,
        uint256 debtToCover,
        bool
    ) external {
        require(
            MockERC20(debtAsset).transferFrom(msg.sender, address(this), debtToCover),
            "DEBT"
        );
        if (collateralOut != 0) {
            MockERC20(collateralAsset).mint(msg.sender, collateralOut);
        }
    }

    function invokeCallback(
        NqcAaveV3Executor executor,
        address asset,
        uint256 amount,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        return executor.executeOperation(asset, amount, premium, initiator, params);
    }
}

contract NqcAaveV3ExecutorTest {
    error ExpectedRevert();
    error WrongError(bytes4 expected, bytes4 actual);

    MockERC20 internal collateral;
    MockERC20 internal debt;
    MockAavePool internal pool;
    MockV2Pair internal pair;
    NqcAaveV3Executor internal executor;

    function setUp() public {
        collateral = new MockERC20();
        debt = new MockERC20();
        pool = new MockAavePool(10, 500);
        pair = new MockV2Pair(address(collateral), address(debt));
        executor = new NqcAaveV3Executor(address(this), address(pool));
    }

    function testSuccessfulPlanPreservesBaselineAndPaysOnlyFreshProfit() public {
        uint256 debtBaseline = 777;
        uint256 collateralBaseline = 333;
        debt.mint(address(executor), debtBaseline);
        collateral.mint(address(executor), collateralBaseline);

        NqcAaveV3Executor.ExecutionPlan memory plan = _oneHopPlan(500, 1_100, 80);
        uint256 operatorBefore = debt.balanceOf(address(this));
        uint256 realized = executor.execute(plan);

        _assertEq(realized, 90);
        _assertEq(debt.balanceOf(address(executor)), debtBaseline);
        _assertEq(collateral.balanceOf(address(executor)), collateralBaseline);
        _assertEq(debt.balanceOf(address(this)) - operatorBefore, 90);
    }

    function testPreexistingDebtCannotSubsidizeUnprofitableExecution() public {
        debt.mint(address(executor), 10_000);
        NqcAaveV3Executor.ExecutionPlan memory plan = _oneHopPlan(500, 1_000, 10);

        try executor.execute(plan) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcAaveV3Executor.InsufficientProfit.selector);
        }
    }

    function testPreexistingCollateralCannotSatisfyFreshCollateralRequirement() public {
        collateral.mint(address(executor), 10_000);
        pool.setCollateralOut(0);
        NqcAaveV3Executor.ExecutionPlan memory plan = _oneHopPlan(500, 1_100, 80);

        try executor.execute(plan) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcAaveV3Executor.InsufficientFreshBalance.selector);
        }
    }

    function testDirectCallbackCallerIsRejected() public {
        try executor.executeOperation(address(debt), 1, 0, address(executor), hex"") returns (bool) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcAaveV3Executor.InvalidCallbackSender.selector);
        }
    }

    function testPoolCallbackWithWrongInitiatorIsRejected() public {
        try pool.invokeCallback(executor, address(debt), 1, address(this), hex"") returns (bool) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcAaveV3Executor.InvalidInitiator.selector);
        }
    }

    function testDuplicatePairRouteIsRejected() public {
        NqcAaveV3Executor.V2Hop[] memory hops = new NqcAaveV3Executor.V2Hop[](2);
        hops[0] = NqcAaveV3Executor.V2Hop({
            pair: address(pair),
            tokenIn: address(collateral),
            tokenOut: address(debt),
            amountIn: 500,
            amountOut: 550
        });
        hops[1] = NqcAaveV3Executor.V2Hop({
            pair: address(pair),
            tokenIn: address(debt),
            tokenOut: address(collateral),
            amountIn: 550,
            amountOut: 500
        });
        NqcAaveV3Executor.ExecutionPlan memory plan = NqcAaveV3Executor.ExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: block.number,
            borrower: address(0xB0B),
            collateralAsset: address(collateral),
            debtAsset: address(collateral),
            debtToCover: 1_000,
            minProfitDebtAsset: 1,
            hops: hops
        });

        // Identical assets would reject before route validation, so make the final debt token distinct
        // while preserving a duplicated pair by using a third token and a deliberately invalid pair reuse.
        MockERC20 finalDebt = new MockERC20();
        plan.debtAsset = address(finalDebt);
        hops[1].tokenOut = address(finalDebt);
        plan.hops = hops;

        try executor.execute(plan) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcAaveV3Executor.DuplicateRoutePair.selector);
        }
    }

    function _oneHopPlan(uint256 amountIn, uint256 amountOut, uint256 minProfit)
        internal
        view
        returns (NqcAaveV3Executor.ExecutionPlan memory plan)
    {
        NqcAaveV3Executor.V2Hop[] memory hops = new NqcAaveV3Executor.V2Hop[](1);
        hops[0] = NqcAaveV3Executor.V2Hop({
            pair: address(pair),
            tokenIn: address(collateral),
            tokenOut: address(debt),
            amountIn: amountIn,
            amountOut: amountOut
        });
        plan = NqcAaveV3Executor.ExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: block.number,
            borrower: address(0xB0B),
            collateralAsset: address(collateral),
            debtAsset: address(debt),
            debtToCover: 1_000,
            minProfitDebtAsset: minProfit,
            hops: hops
        });
    }

    function _assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "ASSERT_EQ");
    }

    function _assertSelector(bytes memory reason, bytes4 expected) internal pure {
        bytes4 actual;
        if (reason.length >= 4) {
            assembly ("memory-safe") {
                actual := mload(add(reason, 0x20))
            }
        }
        if (actual != expected) revert WrongError(expected, actual);
    }
}