// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";
import {
    MockFlashToken, MockFundedStrategy, MockAaveFlashPool, MockBalancerVault
} from "./NqcFlashFundingExecutor.t.sol";

contract MockMorphoFlashRelay {
    function relay(address receiver, uint256 assets, bytes calldata data) external {
        NqcFlashFundingExecutorV2(receiver).onMorphoFlashLoan(assets, data);
    }
}

/// @notice Explicitly synthetic. Does NOT prove Morpho deployed runtime behavior.
contract MockMorphoBlueFlash {
    enum Mode { Honest, NoTransfer, NoPull, WrongAmount, WrongCallbackSender }
    Mode public mode;
    MockMorphoFlashRelay public immutable relay;

    constructor() {
        relay = new MockMorphoFlashRelay();
    }

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        MockFlashToken t = MockFlashToken(token);
        uint256 baseline = t.balanceOf(address(this));
        if (mode != Mode.NoTransfer) {
            require(t.transfer(msg.sender, assets), "MORPHO_TRANSFER");
        }
        if (mode == Mode.WrongCallbackSender) {
            relay.relay(msg.sender, assets, data);
        } else {
            uint256 returnedAssets = mode == Mode.WrongAmount ? assets + 1 : assets;
            NqcFlashFundingExecutorV2(msg.sender).onMorphoFlashLoan(returnedAssets, data);
        }
        if (mode != Mode.NoPull) {
            require(t.transferFrom(msg.sender, address(this), assets), "MORPHO_REPAY");
            require(t.balanceOf(address(this)) == baseline, "MORPHO_BALANCE");
        }
    }
}

contract NqcFlashFundingExecutorV2MorphoTest {
    error ExpectedRevert();
    error UnexpectedRevert(bytes4 expected, bytes4 actual);

    MockFlashToken private token;
    MockFundedStrategy private strategy;
    MockMorphoBlueFlash private morpho;
    MockAaveFlashPool private aave;
    MockBalancerVault private balancer;
    NqcFlashFundingExecutorV2 private executor;

    function setUp() public {
        token = new MockFlashToken();
        strategy = new MockFundedStrategy();
        morpho = new MockMorphoBlueFlash();
        aave = new MockAaveFlashPool(7);
        balancer = new MockBalancerVault(3);
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        token.mint(address(morpho), 1_000_000);
    }

    function testMorphoRepaysExactPrincipalPreservesBaselineAndSweepsOnlyFreshProfit() public {
        uint256 baseline = 777;
        token.mint(address(executor), baseline);
        strategy.configure(35, 0, false);
        bytes memory payload = hex"010203";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan = _morphoPlan(payload, 35);
        uint256 before = token.balanceOf(address(morpho));
        uint256 operatorBefore = token.balanceOf(address(this));
        uint256 returned = executor.execute(plan, payload);
        require(returned == 35, "GROSS_ASSET_PROFIT");
        require(token.balanceOf(address(morpho)) == before, "LENDER_RESTORATION");
        require(token.balanceOf(address(executor)) == baseline, "BASELINE_PRESERVED");
        require(token.balanceOf(address(this)) == operatorBefore + 35, "OPERATOR_SWEEP");
        require(token.allowance(address(executor), address(morpho)) == 0, "NO_ALLOWANCE");
    }

    function testMorphoCannotSatisfyProfitFloorWithOldInventory() public {
        token.mint(address(executor), 1_000_000);
        strategy.configure(0, 0, false);
        bytes memory payload = hex"02";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.InsufficientForRepaymentAndProfit.selector
        );
    }

    function testMorphoMockSkippingTransferCannotFakeLoan() public {
        strategy.configure(25, 0, false);
        morpho.setMode(MockMorphoBlueFlash.Mode.NoTransfer);
        bytes memory payload = hex"03";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.InsufficientFreshPrincipal.selector
        );
    }

    function testMorphoMockSkippingPullCannotFakeProfit() public {
        strategy.configure(25, 0, false);
        morpho.setMode(MockMorphoBlueFlash.Mode.NoPull);
        bytes memory payload = hex"04";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.LenderRepaymentBalanceMismatch.selector
        );
    }

    function testMorphoIncorrectCallbackAmountRejected() public {
        strategy.configure(25, 0, false);
        morpho.setMode(MockMorphoBlueFlash.Mode.WrongAmount);
        bytes memory payload = hex"05";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.InvalidCallbackAmount.selector
        );
    }

    function testMorphoWrongCallbackSenderRejected() public {
        strategy.configure(25, 0, false);
        morpho.setMode(MockMorphoBlueFlash.Mode.WrongCallbackSender);
        bytes memory payload = hex"06";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.InvalidCallbackSender.selector
        );
    }

    function testMorphoCannotChargeUnplannedFlashFee() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"07";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan = _morphoPlan(payload, 1);
        plan.legs[0].expectedFee = 1;
        _expectRevert(plan, payload, NqcFlashFundingExecutorV2.InvalidLeg.selector);
    }

    function testMorphoStrategyCannotLieAboutReturnedAmount() public {
        strategy.configure(25, 1, true);
        bytes memory payload = hex"08";
        _expectRevert(
            _morphoPlan(payload, 1), payload,
            NqcFlashFundingExecutorV2.StrategyReturnedMismatch.selector
        );
    }

    function testMorphoExecutionIdentityCannotReplay() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"09";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan = _morphoPlan(payload, 10);
        executor.execute(plan, payload);
        _expectRevert(
            plan, payload,
            NqcFlashFundingExecutorV2.ExecutionAlreadyConsumed.selector
        );
    }

    function testMorphoPlusAaveNestedReverseRepayment() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"0a";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _nestedPlan(payload, true);
        uint256 morphoBefore = token.balanceOf(address(morpho));
        uint256 returned = executor.execute(plan, payload);
        require(returned == 18, "NET_ASSET_RETAINED");
        require(token.balanceOf(address(morpho)) == morphoBefore, "MORPHO_BALANCE");
        require(token.balanceOf(address(aave)) == 307, "AAVE_PRINCIPAL_AND_FEE");
        require(token.balanceOf(address(this)) == 18, "SWEEP");
    }

    function testAavePlusMorphoNestedReverseRepayment() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"0b";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _nestedPlan(payload, false);
        uint256 morphoBefore = token.balanceOf(address(morpho));
        uint256 returned = executor.execute(plan, payload);
        require(returned == 18, "NET_ASSET_RETAINED");
        require(token.balanceOf(address(morpho)) == morphoBefore, "MORPHO_BALANCE");
        require(token.balanceOf(address(aave)) == 307, "AAVE_PRINCIPAL_AND_FEE");
        require(token.balanceOf(address(this)) == 18, "SWEEP");
    }

    function testMorphoRejectsDuplicateLender() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"0c";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _nestedPlan(payload, true);
        plan.legs[1].lender = plan.legs[0].lender;
        _expectRevert(plan, payload, NqcFlashFundingExecutorV2.DuplicateLender.selector);
    }

    function testMorphoWrongPayloadHashRejectedBeforeFunding() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"0d";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _morphoPlan(payload, 10);
        _expectRevert(
            plan, hex"0e",
            NqcFlashFundingExecutorV2.PayloadHashMismatch.selector
        );
    }

    function testMorphoZeroProfitCanReturnWithoutProfitsButNotClaimRevenue() public {
        strategy.configure(0, 0, false);
        bytes memory payload = hex"0f";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _morphoPlan(payload, 0);
        uint256 outcome = executor.execute(plan, payload);
        require(outcome == 0, "NO_ASSET_SURPLUS");
        require(token.balanceOf(address(this)) == 0, "NO_REVENUE");
        require(token.balanceOf(address(morpho)) == 1_000_000, "LOAN_REPAID");
    }

    function _leg(uint8 kind, address lender, uint256 principal, uint256 fee)
        internal pure returns (NqcFlashFundingExecutorV2.FundingLeg memory)
    {
        return NqcFlashFundingExecutorV2.FundingLeg({
            sourceKind: kind,
            lender: lender,
            principal: principal,
            expectedFee: fee,
            callbackSemanticsHash: keccak256(abi.encodePacked("CALLBACK", kind, lender)),
            sourceEvidenceHash: keccak256(abi.encodePacked("SYNTHETIC_NOT_REAL", kind, lender))
        });
    }

    function _morphoPlan(bytes memory payload, uint256 minProfit)
        internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory)
    {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](1);
        legs[0] = _leg(3, address(morpho), 700, 0);
        return _plan(legs, 700, minProfit, payload);
    }

    function _nestedPlan(bytes memory payload, bool morphoFirst)
        internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory)
    {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](2);
        if (morphoFirst) {
            legs[0] = _leg(3, address(morpho), 700, 0);
            legs[1] = _leg(1, address(aave), 300, 7);
        } else {
            legs[0] = _leg(1, address(aave), 300, 7);
            legs[1] = _leg(3, address(morpho), 700, 0);
        }
        return _plan(legs, 1_000, 18, payload);
    }

    function _plan(
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs,
        uint256 principal,
        uint256 minProfit,
        bytes memory payload
    ) internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory) {
        return NqcFlashFundingExecutorV2.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: block.number,
            executionIdentityHash: keccak256(abi.encodePacked("EXECUTION_V2", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("FUNDING_V2", payload)),
            anchorHash: keccak256(abi.encodePacked("ANCHOR_V2", payload)),
            canonicalGeneration: 1,
            asset: address(token),
            principalRequired: principal,
            minProfitAsset: minProfit,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _expectRevert(
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan,
        bytes memory payload,
        bytes4 expected
    ) internal {
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            bytes4 actual;
            if (reason.length >= 4) {
                assembly ("memory-safe") { actual := mload(add(reason, 0x20)) }
            }
            if (actual != expected) revert UnexpectedRevert(expected, actual);
        }
    }
}
