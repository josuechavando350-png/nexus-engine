// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";

interface Vm {
    function deal(address account, uint256 newBalance) external;
}

interface IAaveV3PoolView {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IBalancerVaultView {
    function getProtocolFeesCollector() external view returns (address);
}

interface IBalancerProtocolFeesCollectorView {
    function getFlashLoanFeePercentage() external view returns (uint256);
}

interface IWethMinimal is IERC20FlashMinimal {
    function deposit() external payable;
}

contract ForkFundingReturnStrategy {
    uint256 public topUpWei;

    receive() external payable {}

    function configure(uint256 topUpWei_) external {
        topUpWei = topUpWei_;
    }

    function executeFunded(
        bytes32,
        address asset,
        uint256 principal,
        bytes calldata
    ) external returns (uint256 returnedAssetUnits) {
        uint256 topUp = topUpWei;
        if (topUp != 0) {
            IWethMinimal(asset).deposit{value: topUp}();
        }
        returnedAssetUnits = principal + topUp;
        require(IWethMinimal(asset).transfer(msg.sender, returnedAssetUnits), "RETURN");
    }
}

/// @notice Historical Ethereum mainnet fork parity for the exact T36 executor.
/// @dev No live authority, signer, nonce, relay, or market-P&L claim is made by these tests.
///      The ETH top-up is a deterministic test fixture used only to pay real protocol fees.
contract NqcFlashFundingExecutorForkTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    uint256 internal constant PINNED_BLOCK = 20_000_000;
    uint256 internal constant AAVE_PRINCIPAL = 1 ether;
    uint256 internal constant BALANCER_PRINCIPAL = 1 ether;
    uint256 internal constant PERCENTAGE_FACTOR = 10_000;
    uint256 internal constant HALF_PERCENTAGE_FACTOR = 5_000;
    uint256 internal constant ONE = 1e18;

    ForkFundingReturnStrategy internal strategy;
    NqcFlashFundingExecutor internal executor;

    function setUp() public {
        require(block.chainid == 1, "NOT_MAINNET");
        require(block.number == PINNED_BLOCK, "WRONG_BLOCK");
        require(AAVE_V3_POOL.code.length != 0, "AAVE_CODE_MISSING");
        require(BALANCER_V2_VAULT.code.length != 0, "BALANCER_CODE_MISSING");
        require(WETH.code.length != 0, "WETH_CODE_MISSING");

        strategy = new ForkFundingReturnStrategy();
        executor = new NqcFlashFundingExecutor(address(this), address(strategy));
    }

    function testHistoricalMainnetAaveV3FlashLoanSimpleParity() public {
        bytes memory payload = hex"3601";
        uint256 fee = _aaveFee(AAVE_PRINCIPAL);
        vm.deal(address(strategy), fee);
        strategy.configure(fee);

        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = _leg(1, AAVE_V3_POOL, AAVE_PRINCIPAL, fee, "AAVE_V3");
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            _plan(payload, AAVE_PRINCIPAL, legs);

        uint256 realized = executor.execute(plan, payload);
        require(realized == 0, "AAVE_REALIZED_NOT_ZERO");
        require(IERC20FlashMinimal(WETH).balanceOf(address(executor)) == 0, "AAVE_BASELINE_DRIFT");
    }

    function testHistoricalMainnetBalancerV2FlashLoanParity() public {
        bytes memory payload = hex"3602";
        uint256 fee = _balancerFee(BALANCER_PRINCIPAL);
        vm.deal(address(strategy), fee);
        strategy.configure(fee);

        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = _leg(2, BALANCER_V2_VAULT, BALANCER_PRINCIPAL, fee, "BALANCER_V2");
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            _plan(payload, BALANCER_PRINCIPAL, legs);

        uint256 realized = executor.execute(plan, payload);
        require(realized == 0, "BALANCER_REALIZED_NOT_ZERO");
        require(IERC20FlashMinimal(WETH).balanceOf(address(executor)) == 0, "BALANCER_BASELINE_DRIFT");
    }

    function testHistoricalMainnetNestedAaveBalancerReverseRepaymentParity() public {
        bytes memory payload = hex"3636";
        uint256 aaveFee = _aaveFee(AAVE_PRINCIPAL);
        uint256 balancerFee = _balancerFee(BALANCER_PRINCIPAL);
        uint256 totalFee = aaveFee + balancerFee;
        vm.deal(address(strategy), totalFee);
        strategy.configure(totalFee);

        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](2);
        legs[0] = _leg(1, AAVE_V3_POOL, AAVE_PRINCIPAL, aaveFee, "AAVE_V3");
        legs[1] = _leg(2, BALANCER_V2_VAULT, BALANCER_PRINCIPAL, balancerFee, "BALANCER_V2");
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            _plan(payload, AAVE_PRINCIPAL + BALANCER_PRINCIPAL, legs);

        uint256 operatorBefore = IERC20FlashMinimal(WETH).balanceOf(address(this));
        uint256 realized = executor.execute(plan, payload);

        require(realized == 0, "NESTED_REALIZED_NOT_ZERO");
        require(IERC20FlashMinimal(WETH).balanceOf(address(this)) == operatorBefore, "OPERATOR_DRIFT");
        require(IERC20FlashMinimal(WETH).balanceOf(address(executor)) == 0, "NESTED_BASELINE_DRIFT");
    }

    function _plan(
        bytes memory payload,
        uint256 principalRequired,
        NqcFlashFundingExecutor.FundingLeg[] memory legs
    ) internal view returns (NqcFlashFundingExecutor.FlashExecutionPlan memory plan) {
        plan = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId: 1,
            validThroughBlock: PINNED_BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("T36_FORK_EXECUTION", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("T36_FORK_FUNDING", payload)),
            anchorHash: keccak256(abi.encodePacked("T36_FORK_ANCHOR", PINNED_BLOCK, payload)),
            canonicalGeneration: 1,
            asset: WETH,
            principalRequired: principalRequired,
            minProfitAsset: 0,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _leg(
        uint8 sourceKind,
        address lender,
        uint256 principal,
        uint256 expectedFee,
        string memory domain
    ) internal pure returns (NqcFlashFundingExecutor.FundingLeg memory) {
        return NqcFlashFundingExecutor.FundingLeg({
            sourceKind: sourceKind,
            lender: lender,
            principal: principal,
            expectedFee: expectedFee,
            callbackSemanticsHash: keccak256(abi.encodePacked("T36_CALLBACK_SEMANTICS_V1", domain)),
            sourceEvidenceHash: keccak256(abi.encodePacked("ETHEREUM_MAINNET_BLOCK_20000000", lender))
        });
    }

    function _aaveFee(uint256 amount) internal view returns (uint256) {
        uint256 premium = uint256(IAaveV3PoolView(AAVE_V3_POOL).FLASHLOAN_PREMIUM_TOTAL());
        if (amount == 0 || premium == 0) return 0;
        return (amount * premium + HALF_PERCENTAGE_FACTOR) / PERCENTAGE_FACTOR;
    }

    function _balancerFee(uint256 amount) internal view returns (uint256) {
        address collector = IBalancerVaultView(BALANCER_V2_VAULT).getProtocolFeesCollector();
        uint256 pct = IBalancerProtocolFeesCollectorView(collector).getFlashLoanFeePercentage();
        if (amount == 0 || pct == 0) return 0;
        return ((amount * pct) - 1) / ONE + 1;
    }
}
