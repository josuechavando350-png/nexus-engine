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
    address internal constant AAVE = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    uint256 internal constant FIRST_HISTORICAL_BLOCK = 26_142_067;
    uint256 internal constant LAST_HISTORICAL_BLOCK = 26_142_078;
    uint256 internal constant EXPECTED_USDC_SURPLUS = 2_273_989_378;
    uint256 internal constant EXPECTED_PRINCIPAL = 48_993_353_728;
    uint256 internal constant EXPECTED_PREMIUM = 24_496_677;
    uint256 internal constant EXPECTED_WETH = 20_140_477_263_386_042_567;

    /// @notice Exact original PR698 state and bounded local next-block state.
    /// @dev 1ppm drift bound is a POST-HOC experimental tolerance, not a
    ///      certification of all market regimes or arbitrary future delays.
    event LocalOneShotStateDrift(
        bytes32 originalAccountKeccak,
        bytes32 actualExecutionAccountKeccak,
        uint256[6] originalWords,
        uint256[6] executionWords,
        uint256 localBlockTimestamp
    );

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
                // Foundry dry-runs CREATE at the source oracle-tx0 block; Anvil
            // MINES the actual local EOA tx at sourceBlock+1. Both must pass,
            // and the authenticated REAL local receipt is required at +1.
            (block.number == FIRST_HISTORICAL_BLOCK ||
                block.number == FIRST_HISTORICAL_BLOCK + 1),
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
        require(ok && currentAccount.length == 192, "EXECUTION_AAVE_ABI_REQUIRED");
        // The exact six-word historical tx0 prestate was independently proved
        // by nqc_local_one_shot_eoa.py BEFORE synthetic CREATE. EVM execution
        // advances one locally mined block; normalized debt/collateral
        // interest indices change minutely. Do NOT claim byte-identical
        // execution-time ABI or overwrite Aave storage to force equality.
        uint256[6] memory originalWords =
            abi.decode(originalPreWinnerAccountABI, (uint256[6]));
        uint256[6] memory executionWords =
            abi.decode(currentAccount, (uint256[6]));
        for (uint256 i; i < 6; ++i) {
            if (i == 0 || i == 1 || i == 5) {
                uint256 sourceWord = originalWords[i];
                require(sourceWord > 0, "NONPOSITIVE_CANONICAL_RISK_WORD");
                uint256 tolerance = sourceWord / 1_000_000 + 1;
                require(
                    executionWords[i] >= sourceWord - tolerance &&
                        executionWords[i] <= sourceWord + tolerance,
                    "EXECUTION_STATE_EXCEEDS_ONE_PPM_DRIFT"
                );
            } else {
                // Non-debt risk configuration, available borrowing and LTV
                // MUST be byte-for-byte unchanged across this one local block.
                require(executionWords[i] == originalWords[i],
                    "SOURCE_ACCOUNT_CONFIG_CHANGED");
            }
        }
        require(
            originalWords[5] > 0 && originalWords[5] < 1 ether &&
                executionWords[5] > 0 && executionWords[5] < 1 ether,
            "PREWINNER_OR_EXECUTION_HF_NOT_LIQUIDATABLE"
        );
        emit LocalOneShotStateDrift(
            keccak256(originalPreWinnerAccountABI),
            keccak256(currentAccount),
            originalWords,
            executionWords,
            block.timestamp
        );
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


interface VmNqcOneShotBroadcast {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function envBytes(string calldata) external returns (bytes memory);
    function envBytes32(string calldata) external returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice ONE --broadcast EOA CREATE tx strictly to a locally validated
///         127.0.0.1 Anvil fork. The Python runner, NOT this Solidity script,
///         enforces that URL, exact PR698/PR700/PR723 evidence, and test keys.
contract NqcV2OneShotBroadcastScript {
    VmNqcOneShotBroadcast private constant vm =
        VmNqcOneShotBroadcast(
            address(uint160(uint256(keccak256("hevm cheat code"))))
        );

    function run() external {
        address borrower = vm.envAddress("NQC_BORROWER");
        uint256 principal = vm.envUint("NQC_PRINCIPAL");
        uint256 collateral = vm.envUint("NQC_COLLATERAL");
        uint256 premium = vm.envUint("NQC_FLASH_FEE");
        bytes32 originalWinner = vm.envBytes32("NQC_WINNER_TX");
        bytes32 originalParentHash = vm.envBytes32("NQC_PARENT_HASH");
        bytes memory sourceAccount = vm.envBytes("NQC_PRESTATE_ABI");

        // Nothing except one Solidity constructor runs under startBroadcast.
        vm.startBroadcast();
        new NqcV2OneShotAtomicLocal(
            borrower, principal, collateral, premium,
            originalWinner, originalParentHash, sourceAccount
        );
        vm.stopBroadcast();
    }
}
