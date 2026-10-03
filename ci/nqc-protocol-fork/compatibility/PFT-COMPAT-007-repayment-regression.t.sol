// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcAaveV3ExecutorTest} from "./NqcAaveV3Executor.t.sol";
import {NqcAaveV3Executor} from "../src/NqcAaveV3Executor.sol";

interface PftLogRecorder {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract PftRepaymentRegressionTest is NqcAaveV3ExecutorTest {
    PftLogRecorder private constant vm =
        PftLogRecorder(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testFuzzRepaymentEventAndBaselines(uint96 debtBase, uint96 collateralBase, uint96 profit)
        public
    {
        debt.mint(address(executor), debtBase);
        collateral.mint(address(executor), collateralBase);
        NqcAaveV3Executor.ExecutionPlan memory plan =
            _oneHopPlan(500, 1_010 + uint256(profit), profit);
        vm.recordLogs();
        _assertEq(executor.execute(plan), profit);
        _assertEq(debt.balanceOf(address(executor)), debtBase);
        _assertEq(collateral.balanceOf(address(executor)), collateralBase);
        _assertEq(debt.balanceOf(address(this)), profit);
        // Liquidation debt + flash principal + premium, with approval consumed.
        _assertEq(debt.balanceOf(address(pool)), 2_010);
        _assertEq(debt.allowance(address(executor), address(pool)), 0);

        PftLogRecorder.Log[] memory logs = vm.getRecordedLogs();
        _assertEq(logs.length, 1);
        require(logs[0].emitter == address(executor), "EVENT_EMITTER");
        _assertEq(logs[0].topics.length, 4);
        require(
            logs[0].topics[0]
                == keccak256("LiquidationExecuted(bytes32,address,address,address,uint256,uint256,uint256)"),
            "EVENT_SIGNATURE"
        );
        require(logs[0].topics[1] == keccak256(abi.encode(plan)), "PLAN_HASH");
        require(logs[0].topics[2] == bytes32(uint256(uint160(plan.borrower))), "BORROWER");
        require(logs[0].topics[3] == bytes32(uint256(uint160(address(collateral)))), "COLLATERAL");
        require(
            keccak256(logs[0].data)
                == keccak256(abi.encode(address(debt), uint256(1_000), uint256(10), uint256(profit))),
            "EVENT_DATA"
        );
    }

    function testFuzzOneUnitProfitShortfallRevertsAtomically(uint96 debtBase, uint96 profit) public {
        debt.mint(address(executor), debtBase);
        NqcAaveV3Executor.ExecutionPlan memory plan =
            _oneHopPlan(500, 1_010 + uint256(profit), uint256(profit) + 1);
        try executor.execute(plan) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            require(
                keccak256(reason)
                    == keccak256(
                        abi.encodeWithSelector(
                            NqcAaveV3Executor.InsufficientProfit.selector,
                            uint256(profit) + 1,
                            uint256(profit)
                        )
                    ),
                "EXACT_REVERT"
            );
        }
        _assertEq(debt.balanceOf(address(executor)), debtBase);
        _assertEq(debt.balanceOf(address(this)), 0);
        _assertEq(debt.balanceOf(address(pool)), 0);
        _assertEq(debt.allowance(address(executor), address(pool)), 0);
        _assertEq(collateral.balanceOf(address(executor)), 0);
    }
}
