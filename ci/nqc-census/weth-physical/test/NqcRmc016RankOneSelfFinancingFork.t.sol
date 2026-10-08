// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";

interface VmRmc016 {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function roll(uint256 value) external;
    function warp(uint256 value) external;
}

interface IAavePoolRmc016 {
    function getUserAccountData(address borrower)
        external view returns (
            uint256 collateralBase, uint256 debtBase, uint256 availableBorrowBase,
            uint256 liquidationThreshold, uint256 ltv, uint256 healthFactor
        );
    function liquidationCall(
        address collateralAsset, address debtAsset, address borrower,
        uint256 debtToCover, bool receiveAToken
    ) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

contract NqcRmc016WethActualLiquidationStrategy {
    address public immutable weth;
    address public immutable pool;
    address public immutable borrower;
    address public immutable operator;
    address public executor;

    constructor(address weth_, address pool_, address borrower_) {
        weth = weth_;
        pool = pool_;
        borrower = borrower_;
        operator = msg.sender;
    }

    function setExecutor(address executor_) external {
        require(msg.sender == operator && executor == address(0), "TEST_EXECUTOR_SETUP_ONLY");
        executor = executor_;
    }

    function executeFunded(bytes32, address asset, uint256 principal, bytes calldata)
        external returns (uint256 returnedAssetUnits)
    {
        require(msg.sender == executor && asset == weth, "UNAUTHORIZED_STRATEGY_CALLBACK");
        // No vm.deal, ERC20 deal, preloaded strategy inventory or fee sponsor.
        require(IERC20FlashMinimal(weth).balanceOf(address(this)) == principal,
                "NON_FRESH_STRATEGY_PRINCIPAL");
        require(IERC20FlashMinimal(weth).approve(pool, principal), "APPROVE_REAL_AAVE");
        IAavePoolRmc016(pool).liquidationCall(weth, weth, borrower, principal, false);
        require(IERC20FlashMinimal(weth).approve(pool, 0), "CLEAR_REAL_AAVE_APPROVAL");

        returnedAssetUnits = IERC20FlashMinimal(weth).balanceOf(address(this));
        require(returnedAssetUnits > principal, "NO_LIQUIDATION_BONUS_IN_WETH");
        require(IERC20FlashMinimal(weth).transfer(msg.sender, returnedAssetUnits),
                "RETURN_SEIZED_WETH_TO_FLASH_EXECUTOR");
    }
}

/// @notice Exact source-derived historical WETH/WETH liquidation attempt from
/// the predecessor fork moved ONLY to the winner block's timestamp.
/// @dev Retrospective competitor selection, no in-block tx replay. No native
/// gas sponsor, capital admission, execution inclusion or live Nexus P&L.
contract NqcRmc016RankOneSelfFinancingForkTest {
    VmRmc016 internal constant vm =
        VmRmc016(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    uint256 internal constant PREVIOUS_BLOCK = 25_938_047;
    uint256 internal constant WINNER_BLOCK = 25_938_048;
    uint256 internal constant REPAY_PRINCIPAL = 10_684_013_854_557_827_871;
    uint256 internal constant PREVIOUS_HF_WAD = 1_000_000_001_993_818_630;
    uint256 internal constant TIME_ONLY_HF_WAD = 999_999_999_704_293_538;

    NqcFlashFundingExecutor internal flashExecutor;
    NqcRmc016WethActualLiquidationStrategy internal strategy;
    address internal borrower;
    uint256 internal winnerTime;

    event log_named_uint(string label, uint256 value);

    function setUp() public {
        require(block.chainid == 1 && block.number == PREVIOUS_BLOCK,
                "NOT_CANONICAL_PREDECESSOR_FORK");
        borrower = vm.envAddress("NQC_RMC016_RANK1_BORROWER");
        winnerTime = vm.envUint("NQC_RMC016_RANK1_WINNER_TIMESTAMP");
        uint256 previousTime = vm.envUint("NQC_RMC016_RANK1_PREVIOUS_TIMESTAMP");
        require(block.timestamp == previousTime && winnerTime > previousTime,
                "CANONICAL_HISTORICAL_TIMESTAMPS_NOT_PINNED");

        strategy = new NqcRmc016WethActualLiquidationStrategy(WETH, POOL, borrower);
        flashExecutor = new NqcFlashFundingExecutor(address(this), address(strategy));
        strategy.setExecutor(address(flashExecutor));

        require(IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0,
                "STRATEGY_OWNS_PREEXISTING_WETH");
        require(IERC20FlashMinimal(WETH).balanceOf(address(flashExecutor)) == 0,
                "FLASH_EXECUTOR_OWNS_PREEXISTING_WETH");
    }

    function _hf() internal view returns (uint256 hf) {
        (,,,,,hf) = IAavePoolRmc016(POOL).getUserAccountData(borrower);
    }

    function _advanceClockOnly() internal {
        require(_hf() == PREVIOUS_HF_WAD, "SOURCE_PREVIOUS_HF_MISMATCH");
        vm.roll(WINNER_BLOCK);
        vm.warp(winnerTime);
        require(_hf() == TIME_ONLY_HF_WAD, "SOURCE_TIME_ONLY_HF_MISMATCH");
        require(_hf() < 1 ether, "BORROWER_NOT_ELIGIBLE_AT_SIMULATED_WINNER_TIME");
    }

    function _fee(uint256 principal) internal view returns (uint256) {
        uint256 premiumBps = uint256(IAavePoolRmc016(POOL).FLASHLOAN_PREMIUM_TOTAL());
        require(premiumBps == 5, "HISTORICAL_FEE_BPS_CHANGED");
        return (principal * premiumBps + 5000) / 10000;
    }

    function _plan(bytes memory payload, uint256 fee, uint256 minProfit)
        internal pure returns (NqcFlashFundingExecutor.FlashExecutionPlan memory p)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind:1,
            lender:POOL,
            principal:REPAY_PRINCIPAL,
            expectedFee:fee,
            callbackSemanticsHash:keccak256("T36_CANONICAL_REAL_AAVE_CALLBACK"),
            // This nonzero hash is a test fixture only, NOT a capital quote.
            sourceEvidenceHash:keccak256("RMC016_FORK_ONLY_UNFUNDED_GAS_NO_AUTHORIZED_PROVIDER")
        });
        p = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId:1,
            validThroughBlock:WINNER_BLOCK,
            executionIdentityHash:keccak256(abi.encodePacked("RMC016_RANK1_TIME_ONLY",payload)),
            fundingPlanHash:keccak256(abi.encodePacked("RMC016_RANK1_FLASH_FIXTURE",payload)),
            anchorHash:keccak256(abi.encodePacked("RMC016_RANK1_PREBLOCK",payload)),
            canonicalGeneration:1,
            asset:WETH,
            principalRequired:REPAY_PRINCIPAL,
            minProfitAsset:minProfit,
            payloadHash:keccak256(payload),
            legs:legs
        });
    }

    function testZeroOwnWethFeeWithoutExternalSponsorHasPositiveForkSurplus() public {
        _advanceClockOnly();
        bytes memory payload = hex"163701";
        uint256 flashFee = _fee(REPAY_PRINCIPAL);
        uint256 operatorWethBefore = IERC20FlashMinimal(WETH).balanceOf(address(this));
        uint256 output = flashExecutor.execute(_plan(payload, flashFee, 1), payload);

        require(output > 0, "NO_WETH_SURPLUS_AFTER_FLASH_FEE");
        require(IERC20FlashMinimal(WETH).balanceOf(address(this)) ==
                operatorWethBefore + output, "FRESH_PROFIT_NOT_SWEPT_TO_OPERATOR");
        require(IERC20FlashMinimal(WETH).balanceOf(address(flashExecutor)) == 0,
                "EXECUTOR_POST_REPAYMENT_WETH_DRIFT");
        require(IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0,
                "STRATEGY_POST_REPAYMENT_WETH_DRIFT");
        emit log_named_uint("NQC_RANK1_FORK_WETH_SURPLUS_WEI", output);
        emit log_named_uint("NQC_RANK1_FORK_FLASH_FEE_WEI", flashFee);
        emit log_named_uint("NQC_RANK1_FORK_PRODUCTION_GAS_SPONSORED", 0);
    }

    function testImpossibleProfitClaimRevertsAndCannotSpendExistingBalances() public {
        _advanceClockOnly();
        bytes memory payload = hex"163702";
        uint256 fee = _fee(REPAY_PRINCIPAL);
        uint256 operatorBefore = IERC20FlashMinimal(WETH).balanceOf(address(this));
        uint256 debtorHfBefore = _hf();

        NqcFlashFundingExecutor.FlashExecutionPlan memory p =
            _plan(payload, fee, type(uint96).max);
        (bool ok,) = address(flashExecutor).call(
            abi.encodeWithSelector(flashExecutor.execute.selector,p,payload)
        );
        require(!ok, "UNSUPPORTED_PROFIT_WAS_ACCEPTED");
        require(IERC20FlashMinimal(WETH).balanceOf(address(this)) == operatorBefore,
                "FAILED_OPERATION_CREDITED_WETH");
        require(IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0,
                "FAILED_OPERATION_STRATEGY_WETH_DRIFT");
        require(IERC20FlashMinimal(WETH).balanceOf(address(flashExecutor)) == 0,
                "FAILED_OPERATION_EXECUTOR_WETH_DRIFT");
        require(_hf() == debtorHfBefore, "FAILED_LIQUIDATION_MUTATED_BORROWER");
        require(!flashExecutor.consumedExecutionIdentity(p.executionIdentityHash),
                "FAILED_OPERATION_CONSUMED_IDENTITY");
    }
}
