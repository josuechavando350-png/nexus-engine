// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";

interface VmAaveFork {
    function deal(address account, uint256 newBalance) external;
}

interface IAavePoolFlashFee {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IWethForkFeeFixture is IERC20FlashMinimal {
    function deposit() external payable;
}

contract NqcAaveFlashFeeOnlyFixture {
    uint256 public payablePremium;

    receive() external payable {}

    function configure(uint256 expectedFee) external {
        payablePremium = expectedFee;
    }

    function executeFunded(bytes32, address asset, uint256 principal, bytes calldata)
        external
        returns (uint256 returnedAssetUnits)
    {
        uint256 topUp = payablePremium;
        if (topUp != 0) {
            IWethForkFeeFixture(asset).deposit{value: topUp}();
        }
        returnedAssetUnits = principal + topUp;
        require(IWethForkFeeFixture(asset).transfer(msg.sender, returnedAssetUnits), "RETURN_FAIL");
    }
}

/// @notice WETH flashLoanSimple mainnet fork test at the RMC011/012 A1 anchor.
/// @dev Uses explicit vm.deal to pre-fund any flash fee in the local fork.
///      This is not a liquidation, a real external gas sponsor or a proof
///      that zero-operator-capital execution is achievable.
contract NqcRmc011AaveFlashPhysicalForkTest {
    VmAaveFork private constant vm =
        VmAaveFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    uint256 private constant ANCHOR_BLOCK = 26_095_351;
    uint256 private constant ONE_WETH = 1 ether;

    NqcAaveFlashFeeOnlyFixture internal strategy;
    NqcFlashFundingExecutor internal executor;

    receive() external payable {}

    function setUp() public {
        require(block.chainid == 1, "WRONG_CHAIN");
        require(block.number == ANCHOR_BLOCK, "WRONG_D08_ANCHOR");
        require(AAVE_POOL.code.length > 0 && WETH.code.length > 0, "MISSING_REAL_CODE");
        strategy = new NqcAaveFlashFeeOnlyFixture();
        executor = new NqcFlashFundingExecutor(address(this), address(strategy));
    }

    function _weth() internal pure returns (IWethForkFeeFixture) {
        return IWethForkFeeFixture(WETH);
    }

    function _poolPremium(uint256 principal) internal view returns (uint256) {
        uint256 bps = uint256(IAavePoolFlashFee(AAVE_POOL).FLASHLOAN_PREMIUM_TOTAL());
        require(bps > 0 && bps <= 10_000, "POOL_PREMIUM_NOT_POSITIVE");
        return (principal * bps + 5_000) / 10_000;
    }

    function _plan(uint256 expectedFee, uint256 minProfit, bytes memory payload)
        internal
        pure
        returns (NqcFlashFundingExecutor.FlashExecutionPlan memory plan)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: AAVE_POOL,
            principal: ONE_WETH,
            expectedFee: expectedFee,
            callbackSemanticsHash: keccak256("T36_AAVE_FLASH_SIMPLE_REAL_CALLBACK"),
            // This is a fork fixture commitment, NOT an admitted financing provider.
            sourceEvidenceHash: keccak256("RMC011_A1_TEST_ONLY_NO_PROVIDER_ADMISSION")
        });
        plan = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId: 1,
            validThroughBlock: ANCHOR_BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("RMC011_A1_FORK", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("RMC011_A1_FUNDING_FIXTURE", payload)),
            anchorHash: keccak256(abi.encodePacked("RMC011_A1", ANCHOR_BLOCK, payload)),
            canonicalGeneration: 1,
            asset: WETH,
            principalRequired: ONE_WETH,
            minProfitAsset: minProfit,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _revertedExecute(NqcFlashFundingExecutor.FlashExecutionPlan memory plan, bytes memory payload)
        internal
    {
        uint256 baseline = _weth().balanceOf(address(executor));
        uint256 poolBefore = _weth().balanceOf(AAVE_POOL);
        (bool ok, ) = address(executor).call(
            abi.encodeWithSelector(executor.execute.selector, plan, payload)
        );
        require(!ok, "UNFUNDED_OR_INVALID_PLAN_EXECUTED");
        require(_weth().balanceOf(address(executor)) == baseline, "REVERT_USED_EXISTING_FUNDS");
        require(_weth().balanceOf(AAVE_POOL) == poolBefore, "REVERT_CHANGED_POOL");
        require(!executor.consumedExecutionIdentity(plan.executionIdentityHash), "REPLAY_ID_MUTATED");
    }

    function testHistoricalA1PoolReportsNonZeroFlashPremium() public view {
        require(_poolPremium(ONE_WETH) > 0, "ZERO_FEE_FORK_CANNOT_FALSIFY_UNFUNDED_PATH");
    }

    function testHistoricalAaveFlashBorrowAndAtomicRepaymentWithExplicitFeeFixture() public {
        uint256 fee = _poolPremium(ONE_WETH);
        vm.deal(address(strategy), fee);
        strategy.configure(fee);
        bytes memory payload = hex"110101";
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan = _plan(fee, 0, payload);

        uint256 poolBefore = _weth().balanceOf(AAVE_POOL);
        uint256 executorBefore = _weth().balanceOf(address(executor));
        uint256 operatorBefore = _weth().balanceOf(address(this));
        require(poolBefore >= ONE_WETH, "HISTORICAL_POOL_HAS_INSUFFICIENT_WETH");
        uint256 realized = executor.execute(plan, payload);
        require(realized == 0, "FIXTURE_CANNOT_CLAIM_POSITIVE_NET_PROFIT");
        require(executor.consumedExecutionIdentity(plan.executionIdentityHash), "IDENTITY_NOT_CONSUMED");
        require(_weth().balanceOf(address(executor)) == executorBefore, "EXECUTOR_BASELINE_DRIFT");
        require(_weth().balanceOf(AAVE_POOL) == poolBefore + fee, "POOL_REPAYMENT_FEE_MISMATCH");
        require(_weth().balanceOf(address(this)) == operatorBefore, "OPERATOR_RECEIVED_FREE_WETH");
    }

    function testInsufficientFlashPremiumMustAtomicallyRevert() public {
        uint256 fee = _poolPremium(ONE_WETH);
        strategy.configure(0);
        bytes memory payload = hex"110102";
        _revertedExecute(_plan(fee, 0, payload), payload);
    }

    function testForgedZeroPremiumCannotBypassRealAaveCallback() public {
        require(_poolPremium(ONE_WETH) > 0, "NOT_A_POSITIVE_FEE_TEST");
        strategy.configure(0);
        bytes memory payload = hex"110103";
        _revertedExecute(_plan(0, 0, payload), payload);
    }

    function testExistingExecutorBalanceCannotSubsidizeMissingPremium() public {
        uint256 fee = _poolPremium(ONE_WETH);
        vm.deal(address(this), 1 ether);
        _weth().deposit{value: 0.2 ether}();
        require(_weth().transfer(address(executor), 0.2 ether), "PRESEED_FAILED");
        strategy.configure(0);
        bytes memory payload = hex"110104";
        _revertedExecute(_plan(fee, 0, payload), payload);
    }

    function testExistingExecutorBalanceCannotSubsidizePositiveProfitClaim() public {
        uint256 fee = _poolPremium(ONE_WETH);
        vm.deal(address(this), 1 ether);
        _weth().deposit{value: 0.2 ether}();
        require(_weth().transfer(address(executor), 0.2 ether), "PRESEED_FAILED");
        vm.deal(address(strategy), fee);
        strategy.configure(fee);
        bytes memory payload = hex"110105";
        _revertedExecute(_plan(fee, 1, payload), payload);
    }
}
