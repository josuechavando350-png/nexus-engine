// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";

contract MockFlashToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function burn(address from, uint256 amount) external {
        uint256 balance = balanceOf[from];
        require(balance >= amount, "BALANCE");
        unchecked { balanceOf[from] = balance - amount; }
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        uint256 balance = balanceOf[msg.sender];
        require(balance >= amount, "BALANCE");
        unchecked { balanceOf[msg.sender] = balance - amount; }
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
        if (approved != type(uint256).max) allowance[from][msg.sender] = approved - amount;
        unchecked { balanceOf[from] = balance - amount; }
        balanceOf[to] += amount;
        return true;
    }
}

contract MockFundedStrategy {
    uint256 public extraProfit;
    uint256 public declaredDelta;
    bool public lieAboutReturn;

    function configure(uint256 extraProfit_, int256 declaredDelta_, bool lie_) external {
        extraProfit = extraProfit_;
        declaredDelta = uint256(declaredDelta_ < 0 ? -declaredDelta_ : declaredDelta_);
        lieAboutReturn = lie_;
    }

    function executeFunded(
        bytes32,
        address asset,
        uint256 principal,
        bytes calldata
    ) external returns (uint256 returnedAssetUnits) {
        MockFlashToken token = MockFlashToken(asset);
        token.mint(address(this), extraProfit);
        uint256 amount = principal + extraProfit;
        require(token.transfer(msg.sender, amount), "RETURN");
        returnedAssetUnits = lieAboutReturn ? amount + declaredDelta + 1 : amount;
    }
}

contract MockAaveFlashPool {
    uint256 public fee;

    constructor(uint256 fee_) { fee = fee_; }

    function setFee(uint256 fee_) external { fee = fee_; }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16
    ) external {
        MockFlashToken token = MockFlashToken(asset);
        token.mint(receiverAddress, amount);
        bool ok = NqcFlashFundingExecutor(receiverAddress).executeOperation(
            asset, amount, fee, receiverAddress, params
        );
        require(ok, "CALLBACK");
        require(token.transferFrom(receiverAddress, address(this), amount + fee), "REPAY");
    }
}

contract MockBalancerVault {
    uint256 public fee;

    constructor(uint256 fee_) { fee = fee_; }

    function setFee(uint256 fee_) external { fee = fee_; }

    function flashLoan(
        address recipient,
        IERC20FlashMinimal[] calldata tokens,
        uint256[] calldata amounts,
        bytes calldata userData
    ) external {
        require(tokens.length == 1 && amounts.length == 1, "VECTOR");
        MockFlashToken token = MockFlashToken(address(tokens[0]));
        uint256 beforeBalance = token.balanceOf(address(this));
        token.mint(recipient, amounts[0]);
        uint256[] memory fees = new uint256[](1);
        fees[0] = fee;
        NqcFlashFundingExecutor(recipient).receiveFlashLoan(tokens, amounts, fees, userData);
        require(token.balanceOf(address(this)) == beforeBalance + amounts[0] + fee, "REPAY");
    }
}

contract NqcFlashFundingExecutorTest {
    error ExpectedRevert();
    error WrongError(bytes4 expected, bytes4 actual);

    MockFlashToken internal token;
    MockFundedStrategy internal strategy;
    MockAaveFlashPool internal aave;
    MockBalancerVault internal balancer;
    NqcFlashFundingExecutor internal executor;

    function setUp() public {
        token = new MockFlashToken();
        strategy = new MockFundedStrategy();
        aave = new MockAaveFlashPool(7);
        balancer = new MockBalancerVault(3);
        executor = new NqcFlashFundingExecutor(address(this), address(strategy));
    }

    function testNestedAaveBalancerFundingRepaysInReverseAndPreservesBaseline() public {
        uint256 baseline = 777;
        token.mint(address(executor), baseline);
        strategy.configure(25, 0, false);
        bytes memory payload = hex"01020304";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 15);

        uint256 operatorBefore = token.balanceOf(address(this));
        uint256 realized = executor.execute(plan, payload);

        _assertEq(realized, 15);
        _assertEq(token.balanceOf(address(executor)), baseline);
        _assertEq(token.balanceOf(address(this)) - operatorBefore, 15);
        _assertEq(token.balanceOf(address(aave)), 707);
        _assertEq(token.balanceOf(address(balancer)), 303);
    }

    function testPreexistingExecutorBalanceCannotSubsidizeMissingFeeOrProfit() public {
        token.mint(address(executor), 1_000_000);
        strategy.configure(9, 0, false);
        bytes memory payload = hex"aa";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 0);
        _expectInsufficient(plan, payload);
    }

    function testObservedAaveFeeMustEqualPlanFee() public {
        strategy.configure(25, 0, false);
        aave.setFee(8);
        bytes memory payload = hex"bb";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 1);
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.InvalidCallbackFee.selector);
        }
    }

    function testObservedBalancerFeeMustEqualPlanFee() public {
        strategy.configure(25, 0, false);
        balancer.setFee(4);
        bytes memory payload = hex"cc";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 1);
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.InvalidCallbackFee.selector);
        }
    }

    function testPayloadMutationIsRejectedBeforeBorrowing() public {
        strategy.configure(25, 0, false);
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(hex"0102", 1);
        try executor.execute(plan, hex"0103") returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.PayloadHashMismatch.selector);
        }
    }

    function testExecutionIdentityCannotReplay() public {
        strategy.configure(25, 0, false);
        bytes memory payload = hex"deadbeef";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 1);
        executor.execute(plan, payload);
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.ExecutionAlreadyConsumed.selector);
        }
    }

    function testStrategyReturnDeclarationMustMatchObservedBalance() public {
        strategy.configure(25, 1, true);
        bytes memory payload = hex"dd";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 1);
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.StrategyReturnedMismatch.selector);
        }
    }

    function testDuplicateLenderRejected() public {
        bytes memory payload = hex"ee";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(payload, 1);
        plan.legs[1].lender = plan.legs[0].lender;
        plan.legs[1].sourceKind = plan.legs[0].sourceKind;
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.DuplicateLender.selector);
        }
    }

    function _expectInsufficient(
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan,
        bytes memory payload
    ) internal {
        try executor.execute(plan, payload) returns (uint256) {
            revert ExpectedRevert();
        } catch (bytes memory reason) {
            _assertSelector(reason, NqcFlashFundingExecutor.InsufficientForRepaymentAndProfit.selector);
        }
    }

    function _plan(bytes memory payload, uint256 minProfit)
        internal
        view
        returns (NqcFlashFundingExecutor.FlashExecutionPlan memory plan)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs = new NqcFlashFundingExecutor.FundingLeg[](2);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: address(aave),
            principal: 700,
            expectedFee: 7,
            callbackSemanticsHash: keccak256("AAVE_V3_FLASH_LOAN_SIMPLE_CALLBACK_V1"),
            sourceEvidenceHash: keccak256("AAVE_SOURCE_EVIDENCE")
        });
        legs[1] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 2,
            lender: address(balancer),
            principal: 300,
            expectedFee: 3,
            callbackSemanticsHash: keccak256("BALANCER_V2_FLASH_LOAN_CALLBACK_V1"),
            sourceEvidenceHash: keccak256("BALANCER_SOURCE_EVIDENCE")
        });
        plan = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: block.number,
            executionIdentityHash: keccak256(abi.encodePacked("execution", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("funding", payload)),
            anchorHash: keccak256(abi.encodePacked("anchor", payload)),
            canonicalGeneration: 1,
            asset: address(token),
            principalRequired: 1_000,
            minProfitAsset: minProfit,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _assertEq(uint256 actual, uint256 expected) internal pure {
        require(actual == expected, "ASSERT_EQ");
    }

    function _assertSelector(bytes memory reason, bytes4 expected) internal pure {
        bytes4 actual;
        if (reason.length >= 4) {
            assembly ("memory-safe") { actual := mload(add(reason, 0x20)) }
        }
        if (actual != expected) revert WrongError(expected, actual);
    }
}
