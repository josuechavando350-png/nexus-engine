// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";
import {NqcV2HistoricalRouteHarness, IAaveNqcRoute}
    from "../test/NqcV2FundedRouteFork.t.sol";

/// @notice Experimental, HARD-BLOCK-BOUNDED historical fork construction.
///         Entire borrower-specific strategy deployment, coordinator deployment,
///         flash loan, Aave liquidation, Uniswap swap, repayment and USDC payout
///         occur within the one EOA CONTRACT-CREATION transaction.
/// @dev NO production deployability: explicitly restricted to the old mainnet
///      block window 26,142,067..26,142,078. Requires authenticated historical
///      borrower account ABI immediately before the original competitor winner.
///      Intended for isolated Anvil test only. No SVR/builder access proven.
contract NqcV2OneShotAtomicLocal {
    address internal constant AAVE = 0x87870Bca3F3fD6335C3f4ce8392D69350B4fA4E2;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 internal constant FIRST_HISTORICAL_BLOCK = 26_142_067;
    uint256 internal constant LAST_HISTORICAL_BLOCK = 26_142_078;
    uint256 internal constant EXPECTED_USDC_SURPLUS = 2_273_989_378;
    uint256 internal constant EXPECTED_PRINCIPAL = 48_993_353_728;
    uint256 internal constant EXPECTED_PREMIUM = 24_496_677;
    uint256 internal constant EXPECTED_WETH = 20_140_477_263_386_042_567;

    event LocalOneShotLiquidation(
        address indexed ephemeralOperator,
        address indexed strategy,
        address indexed coordinator,
        bytes32 originalCompetitorWinner,
        uint256 actualUSDCProfitTransferred,
        uint256 sourceBlockNumber
    );

    constructor(
        address borrower,
        uint256 principal,
        uint256 collateral,
        uint256 premium,
        bytes32 originalWinner,
        bytes32 originalParentHash,
        bytes memory originalPreWinnerAccountABI
    ) {
        require(
            block.chainid == 1 &&
                block.number >= FIRST_HISTORICAL_BLOCK &&
                block.number <= LAST_HISTORICAL_BLOCK,
            "HISTORICAL_LOCAL_FORK_ONLY"
        );
        require(
            originalParentHash != bytes32(0) &&
                blockhash(FIRST_HISTORICAL_BLOCK - 1) == originalParentHash,
            "CANONICAL_ORIGINAL_PARENT_REQUIRED"
        );
        require(
            borrower != address(0) &&
                principal == EXPECTED_PRINCIPAL &&
                collateral == EXPECTED_WETH &&
                premium == EXPECTED_PREMIUM &&
                originalWinner != bytes32(0),
            "EXACT_ORIGINAL_ROUTE_REQUIRED"
        );
        require(originalPreWinnerAccountABI.length == 192, "SOURCE_PRESTATE_SHAPE");
        (bool ok, bytes memory currentAccount) = AAVE.staticcall(
            abi.encodeWithSignature("getUserAccountData(address)", borrower)
        );
        require(
            ok && keccak256(currentAccount) == keccak256(originalPreWinnerAccountABI),
            "EXACT_ORACLE_TX0_PREWINNER_ABI_REQUIRED"
        );
        (,,,,, uint256 hf) = abi.decode(
            originalPreWinnerAccountABI,
            (uint256, uint256, uint256, uint256, uint256, uint256)
        );
        require(hf > 0 && hf < 1 ether, "NOT_LIQUIDATABLE_PREWINNER");
        require(
            IAaveNqcRoute(AAVE).FLASHLOAN_PREMIUM_TOTAL() == 5 &&
                (principal * 5 + 9_999) / 10_000 == premium,
            "AUTHENTIC_AAVE_FLASH_PREMIUM"
        );
        require(
            IERC20FlashMinimal(USDC).balanceOf(address(this)) == 0 &&
                IERC20FlashMinimal(WETH).balanceOf(address(this)) == 0,
            "NO_ERC20_CAPITAL_INJECTION"
        );

        // These NEW contracts are actually created in THIS SAME EOA transaction.
        NqcV2HistoricalRouteHarness strategy =
            new NqcV2HistoricalRouteHarness(USDC, borrower, collateral);
        NqcFlashFundingExecutor coordinator =
            new NqcFlashFundingExecutor(address(this), address(strategy));
        strategy.setExecutor(address(coordinator));

        bytes memory payload = abi.encode(principal + premium + 1);
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: AAVE,
            principal: principal,
            expectedFee: premium,
            callbackSemanticsHash: keccak256("T36_CANONICAL_REAL_AAVE_CALLBACK"),
            sourceEvidenceHash: keccak256("LOCAL_ONE_SHOT_TEST_NO_SPONSOR")
        });
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            NqcFlashFundingExecutor.FlashExecutionPlan({
                chainId: 1,
                validThroughBlock: block.number,
                executionIdentityHash: keccak256(abi.encode(
                    "HISTORICAL_LOCAL_ONE_EOA_TX", originalWinner, borrower,
                    principal, payload
                )),
                fundingPlanHash: keccak256(abi.encode(
                    "LOCAL_ONE_SHOT_FUNDING",originalWinner,borrower,principal,payload
                )),
                anchorHash: keccak256(abi.encode(
                    originalParentHash,originalWinner,originalPreWinnerAccountABI
                )),
                canonicalGeneration: 1,
                asset: USDC,
                principalRequired: principal,
                minProfitAsset: 1,
                payloadHash: keccak256(payload),
                legs: legs
            });

        uint256 finalProfit = coordinator.execute(plan, payload);
        require(
            finalProfit == EXPECTED_USDC_SURPLUS &&
                IERC20FlashMinimal(USDC).balanceOf(address(this)) == finalProfit &&
                coordinator.consumedExecutionIdentity(plan.executionIdentityHash),
            "EXACT_FLASH_SWAP_SURPLUS_REQUIRED"
        );
        require(
            IERC20FlashMinimal(USDC).transfer(msg.sender, finalProfit),
            "USDC_NOT_PAID_TO_LOCAL_EOA"
        );
        require(
            IERC20FlashMinimal(USDC).balanceOf(address(this)) == 0 &&
                IERC20FlashMinimal(WETH).balanceOf(address(this)) == 0,
            "NO_STRANDED_INVENTORY"
        );
        emit LocalOneShotLiquidation(
            msg.sender,
            address(strategy),
            address(coordinator),
            originalWinner,
            finalProfit,
            block.number
        );
    }
}
