// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcV2BackrunStrategyMeasured} from "../src/NqcV2BackrunStrategyMeasured.sol";

contract MockBackrunToken {
    mapping(address => uint256) public balanceOf;

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
}

contract MockBackrunPair {
    MockBackrunToken public immutable token0;
    MockBackrunToken public immutable token1;
    uint112 private reserve0;
    uint112 private reserve1;

    constructor(MockBackrunToken token0_, MockBackrunToken token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function sync() external {
        reserve0 = uint112(token0.balanceOf(address(this)));
        reserve1 = uint112(token1.balanceOf(address(this)));
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, 1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out == 0 || amount1Out == 0, "ONE_SIDE");
        require(amount0Out < reserve0 && amount1Out < reserve1, "LIQUIDITY");
        if (amount0Out != 0) require(token0.transfer(to, amount0Out), "TOKEN0");
        if (amount1Out != 0) require(token1.transfer(to, amount1Out), "TOKEN1");
        reserve0 = uint112(token0.balanceOf(address(this)));
        reserve1 = uint112(token1.balanceOf(address(this)));
    }
}

contract NqcV2BackrunStrategyMeasuredTest {
    error ExpectedRevert();
    error WrongError(bytes4 expected, bytes4 actual);

    uint256 internal constant BPS = 10_000;

    MockBackrunToken internal asset;
    MockBackrunToken internal middle;
    MockBackrunPair internal pair0;
    MockBackrunPair internal pair1;
    NqcV2BackrunStrategyMeasured internal strategy;

    function setUp() public {
        asset = new MockBackrunToken();
        middle = new MockBackrunToken();
        pair0 = new MockBackrunPair(asset, middle);
        pair1 = new MockBackrunPair(middle, asset);
        strategy = new NqcV2BackrunStrategyMeasured(address(this));

        asset.mint(address(pair0), 10_000);
        middle.mint(address(pair0), 20_000);
        middle.mint(address(pair1), 10_000);
        asset.mint(address(pair1), 10_000);
        pair0.sync();
        pair1.sync();
    }

    function testExactTwoHopBackrunReturnsFreshPrincipalAndProfitPreservingBaseline() public {
        uint256 principal = 1_000;
        uint256 baseline = 777;
        asset.mint(address(strategy), baseline + principal);

        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        uint256 expectedReturn = plan.hops[1].amountOut;
        uint256 callerBefore = asset.balanceOf(address(this));

        uint256 returned =
            strategy.executeFunded(plan.executionIdentityHash, address(asset), principal, abi.encode(plan));

        _assertEq(returned, expectedReturn);
        _assertEq(asset.balanceOf(address(strategy)), baseline);
        _assertEq(asset.balanceOf(address(this)) - callerBefore, expectedReturn);
        require(returned > principal, "NO_PROFIT");
    }

    function testWrongTargetBlockRejectsBeforeEffects() public {
        uint256 principal = 1_000;
        asset.mint(address(strategy), principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        plan.targetBlock = block.number + 1;
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.WrongTargetBlock.selector);
        _assertEq(asset.balanceOf(address(strategy)), principal);
    }

    function testWrongParentHashRejectsBeforeEffects() public {
        uint256 principal = 1_000;
        asset.mint(address(strategy), principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        plan.parentHash = bytes32(uint256(plan.parentHash) ^ 1);
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.WrongParentHash.selector);
        _assertEq(asset.balanceOf(address(strategy)), principal);
    }

    function testReserveWitnessMutationByOneRejectsBeforeEffects() public {
        uint256 principal = 1_000;
        asset.mint(address(strategy), principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        plan.hops[0].reserve0 += 1;
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.ReserveWitnessMismatch.selector);
        _assertEq(asset.balanceOf(address(strategy)), principal);
    }

    function testPreexistingBalanceCannotSubsidizeMinProfitShortfall() public {
        uint256 principal = 1_000;
        uint256 baseline = 1_000_000;
        asset.mint(address(strategy), baseline + principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        uint256 actualProfit = plan.hops[1].amountOut - principal;
        plan.minProfitAsset = actualProfit + 1;
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.InsufficientProfit.selector);
        _assertEq(asset.balanceOf(address(strategy)), baseline + principal);
    }

    function testExecutionIdentityCannotReplay() public {
        uint256 principal = 1_000;
        asset.mint(address(strategy), principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        strategy.executeFunded(plan.executionIdentityHash, address(asset), principal, abi.encode(plan));

        asset.mint(address(strategy), principal);
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.ExecutionAlreadyConsumed.selector);
    }

    function testDuplicatePairReverseDirectionRejects() public {
        uint256 principal = 1_000;
        asset.mint(address(strategy), principal);
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan = _plan(principal, 1);
        plan.hops[1].pair = address(pair0);
        plan.hops[1].reserve0 = plan.hops[0].reserve0;
        plan.hops[1].reserve1 = plan.hops[0].reserve1;
        _expect(plan, principal, NqcV2BackrunStrategyMeasured.DuplicatePair.selector);
    }

    function testPlanHashBindsTargetAndCandidateProvenance() public view {
        NqcV2BackrunStrategyMeasured.BackrunPlan memory original = _plan(1_000, 1);
        bytes32 originalHash = strategy.hashPlan(original);

        NqcV2BackrunStrategyMeasured.BackrunPlan memory targetMutated = _plan(1_000, 1);
        targetMutated.targetProvenanceHash = keccak256("TARGET_MUTATED");
        require(strategy.hashPlan(targetMutated) != originalHash, "TARGET_NOT_BOUND");

        NqcV2BackrunStrategyMeasured.BackrunPlan memory candidateMutated = _plan(1_000, 1);
        candidateMutated.candidateProvenanceHash = keccak256("CANDIDATE_MUTATED");
        require(strategy.hashPlan(candidateMutated) != originalHash, "CANDIDATE_NOT_BOUND");
    }

    function _plan(uint256 principal, uint256 minProfit)
        internal
        view
        returns (NqcV2BackrunStrategyMeasured.BackrunPlan memory plan)
    {
        (uint112 p0r0, uint112 p0r1,) = pair0.getReserves();
        (uint112 p1r0, uint112 p1r1,) = pair1.getReserves();

        uint256 out0 = _quote(principal, uint256(p0r0), uint256(p0r1), 30);
        uint256 out1 = _quote(out0, uint256(p1r0), uint256(p1r1), 30);
        require(out1 > principal, "FIXTURE_NOT_PROFITABLE");

        NqcV2BackrunStrategyMeasured.Hop[] memory hops =
            new NqcV2BackrunStrategyMeasured.Hop[](2);
        hops[0] = NqcV2BackrunStrategyMeasured.Hop({
            pair: address(pair0),
            tokenIn: address(asset),
            tokenOut: address(middle),
            reserve0: uint256(p0r0),
            reserve1: uint256(p0r1),
            feeBps: 30,
            amountIn: principal,
            amountOut: out0
        });
        hops[1] = NqcV2BackrunStrategyMeasured.Hop({
            pair: address(pair1),
            tokenIn: address(middle),
            tokenOut: address(asset),
            reserve0: uint256(p1r0),
            reserve1: uint256(p1r1),
            feeBps: 30,
            amountIn: out0,
            amountOut: out1
        });

        plan = NqcV2BackrunStrategyMeasured.BackrunPlan({
            chainId: block.chainid,
            targetBlock: block.number,
            parentHash: blockhash(block.number - 1),
            executionIdentityHash: keccak256(abi.encodePacked("EXECUTION", principal, minProfit)),
            targetProvenanceHash: keccak256("TARGET_PROVENANCE"),
            candidateProvenanceHash: keccak256("CANDIDATE_PROVENANCE"),
            asset: address(asset),
            minProfitAsset: minProfit,
            hops: hops
        });
    }

    function _quote(uint256 amountIn, uint256 reserveIn, uint256 reserveOut, uint256 feeBps)
        internal
        pure
        returns (uint256)
    {
        uint256 amountInWithFee = amountIn * (BPS - feeBps);
        return (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
    }

    function _expect(
        NqcV2BackrunStrategyMeasured.BackrunPlan memory plan,
        uint256 principal,
        bytes4 expected
    ) internal {
        try strategy.executeFunded(
            plan.executionIdentityHash, address(asset), principal, abi.encode(plan)
        ) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, expected);
        }
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
