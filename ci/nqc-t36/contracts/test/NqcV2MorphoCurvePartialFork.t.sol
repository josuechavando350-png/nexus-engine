// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";

interface IV2PartialERC20 {
    function balanceOf(address owner) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function totalSupply() external view returns (uint256);
}

interface ICurveStableSwapPartial {
    function coins(uint256 i) external view returns (address);
    function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256);
    function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256);
}

/// @notice READ-ONLY historical fork probe that intentionally REVERTS after
///         two real Curve swaps, before liquidation or flash repayment.
/// @dev Returning the interim USDtb as "profit" would be fraudulent because
///      the original USDT lender is not repaid. The custom revert exposes the
///      amount Curve actually would transfer, while rolling back ALL state.
contract MorphoCurvePartialProbe {
    error WrongCaller();
    error WrongAsset();
    error MissingFlashPrincipal();
    error WrongCoinConfiguration();
    error ERC20ApprovalFailed();
    error ObservedExchangeQuoteMismatch();
    error IncompleteInputConsumption();
    error CapturedPartialRoute(
        uint256 inputUsdt,
        uint256 afterThreepoolUsdc,
        uint256 afterUsdTbPoolUsdTb,
        uint256 remainingBorrowedUsdt,
        uint256 remainingIntermediateUsdc
    );

    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USDC = 0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDTB = 0xC139190F447e929f090Edeb554D95AbB8b18aC1C;
    address internal constant THREEPOOL = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
    address internal constant USDTB_POOL = 0xC2921134073151490193ac7369313C8E0b08e1E7;

    address public immutable deployer;
    address public fundingExecutor;

    constructor() {
        deployer = msg.sender;
    }

    function bind(address onlyExecutor) external {
        if (msg.sender != deployer || fundingExecutor != address(0) || onlyExecutor == address(0)) {
            revert WrongCaller();
        }
        fundingExecutor = onlyExecutor;
    }

    function executeFunded(bytes32, address asset, uint256 principal, bytes calldata)
        external returns (uint256)
    {
        if (msg.sender != fundingExecutor) revert WrongCaller();
        if (asset != USDT) revert WrongAsset();
        if (principal == 0) revert MissingFlashPrincipal();

        // Exact deployed coin indices, no inference from symbols/decimals.
        if (
            ICurveStableSwapPartial(THREEPOOL).coins(2) != USDT
                || ICurveStableSwapPartial(THREEPOOL).coins(1) != USDC
                || ICurveStableSwapPartial(USDTB_POOL).coins(0) != USDC
                || ICurveStableSwapPartial(USDTB_POOL).coins(1) != USDTB
        ) revert WrongCoinConfiguration();

        // Fresh source is a real Morpho flash loan on fork. No vm.deal,
        // vm.store, impersonated whale or test prefunding. If a strategy
        // address coincides with any historic balance, preserve that baseline.
        uint256 usdtBalance = _balance(USDT);
        if (usdtBalance < principal) revert MissingFlashPrincipal();
        uint256 oldUsdt = usdtBalance - principal;
        uint256 oldUsdc = _balance(USDC);
        uint256 oldUsdTb = _balance(USDTB);

        uint256 quotedUsdc = ICurveStableSwapPartial(THREEPOOL).get_dy(2, 1, principal);
        if (quotedUsdc == 0) revert ObservedExchangeQuoteMismatch();
        _approve(USDT, THREEPOOL, principal);
        uint256 tradedUsdc = ICurveStableSwapPartial(THREEPOOL).exchange(
            2, 1, principal, quotedUsdc
        );
        uint256 observedUsdc = _balance(USDC) - oldUsdc;
        if (tradedUsdc != quotedUsdc || observedUsdc != quotedUsdc) {
            revert ObservedExchangeQuoteMismatch();
        }
        if (_balance(USDT) != oldUsdt) revert IncompleteInputConsumption();

        uint256 quotedUsdTb = ICurveStableSwapPartial(USDTB_POOL).get_dy(
            0, 1, observedUsdc
        );
        if (quotedUsdTb == 0) revert ObservedExchangeQuoteMismatch();
        _approve(USDC, USDTB_POOL, observedUsdc);
        uint256 tradedUsdTb = ICurveStableSwapPartial(USDTB_POOL).exchange(
            0, 1, observedUsdc, quotedUsdTb
        );
        uint256 observedUsdTb = _balance(USDTB) - oldUsdTb;
        if (tradedUsdTb != quotedUsdTb || observedUsdTb != quotedUsdTb) {
            revert ObservedExchangeQuoteMismatch();
        }
        if (_balance(USDC) != oldUsdc) revert IncompleteInputConsumption();

        // ALWAYS revert. Without USDtb liquidation + collateral-to-USDT
        // monetization, a Morpho USDT flash loan cannot be settled.
        revert CapturedPartialRoute(
            principal, observedUsdc, observedUsdTb,
            _balance(USDT) - oldUsdt, _balance(USDC) - oldUsdc
        );
    }

    function _approve(address asset, address spender, uint256 amount) internal {
        (bool okZero, bytes memory dataZero) = asset.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, 0)
        );
        if (!okZero || (dataZero.length != 0 && !abi.decode(dataZero, (bool)))) {
            revert ERC20ApprovalFailed();
        }
        (bool ok, bytes memory data) = asset.call(
            abi.encodeWithSignature("approve(address,uint256)", spender, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert ERC20ApprovalFailed();
        }
    }

    function _balance(address asset) internal view returns (uint256) {
        return IV2PartialERC20(asset).balanceOf(address(this));
    }
}

/// @notice On Ethereum archive block, real deployed Morpho and two real Curve
/// pools must execute both legs before a mandatory proof-bearing rollback.
/// @dev No Aave liquidation, Fluid sUSDe monetization, nonrecourse gas,
/// builder bid, competition capture or actual NQC profit is established.
contract NqcV2MorphoCurvePartialForkTest {
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant USDC = 0xA0b86991C6218b36C1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDTB = 0xC139190F447e929f090Edeb554D95AbB8b18aC1C;
    address internal constant THREEPOOL = 0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7;
    address internal constant USDTB_POOL = 0xC2921134073151490193ac7369313C8E0b08e1E7;
    uint256 internal constant BLOCK = 26_184_741;
    bytes32 internal constant PARENT =
        0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66;

    uint256 internal constant FIRST_MINIMAL_USDT = 472_461_610_796;
    uint256 internal constant FIRST_PREVIOUS_USDT = 472_461_610_795;
    uint256 internal constant SECOND_MINIMAL_USDT = 472_697_861_244;

    uint256 internal constant FIRST_TARGET_USDTB = 472_000 ether;
    uint256 internal constant SECOND_TARGET_USDTB = 472_236 ether;
    uint256 internal constant FIRST_CURVE_USDC = 471_915_315_148;
    uint256 internal constant SECOND_CURVE_USDC = 472_151_287_461;
    uint256 internal constant FIRST_CURVE_USDTB_QUOTE =
        472_000_000_000_693_417_947_036;
    uint256 internal constant SECOND_CURVE_USDTB_QUOTE =
        472_236_000_000_914_279_535_684;
    uint256 internal constant FIRST_PREVIOUS_USDTB_QUOTE =
        471_999_999_999_693_300_984_149;

    MorphoCurvePartialProbe internal strategy;
    NqcFlashFundingExecutorV2 internal executor;

    function setUp() public {
        require(block.chainid == 1 && block.number == BLOCK, "WRONG_CANONICAL_BLOCK");
        require(blockhash(block.number - 1) == PARENT, "PARENT_MISMATCH");
        require(
            MORPHO.code.length > 0 && THREEPOOL.code.length > 0
                && USDTB_POOL.code.length > 0 && USDT.code.length > 0
                && USDC.code.length > 0 && USDTB.code.length > 0,
            "ACTUAL_DEPLOYED_CONTRACT_MISSING"
        );
        strategy = new MorphoCurvePartialProbe();
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        strategy.bind(address(executor));
    }

    function testRealMorphoAndCurveQuoteIdentitiesAtPinnedBlock() public view {
        require(
            IV2PartialERC20(USDT).balanceOf(MORPHO) == 65_666_477_002_958,
            "MORPHO_USDT_SOURCE_STATE_DRIFT"
        );
        _assertQuotedPath(FIRST_MINIMAL_USDT, FIRST_CURVE_USDC, FIRST_CURVE_USDTB_QUOTE);
        _assertQuotedPath(SECOND_MINIMAL_USDT, SECOND_CURVE_USDC, SECOND_CURVE_USDTB_QUOTE);
        require(
            ICurveStableSwapPartial(THREEPOOL).coins(2) == USDT
                && ICurveStableSwapPartial(THREEPOOL).coins(1) == USDC
                && ICurveStableSwapPartial(USDTB_POOL).coins(0) == USDC
                && ICurveStableSwapPartial(USDTB_POOL).coins(1) == USDTB,
            "CURVE_POOL_INDEX_CHANGE"
        );
    }

    function testRealMorphoCurveTwoHopRevertsAfterAcquiringAtLeast472000USDtb() public {
        _simulateTwoHopAndRollback(
            FIRST_MINIMAL_USDT, FIRST_TARGET_USDTB,
            FIRST_CURVE_USDC, FIRST_CURVE_USDTB_QUOTE, true
        );
    }

    function testRealMorphoCurvePreviousSingleUSDTBaseUnitFallsShort() public {
        _simulateTwoHopAndRollback(
            FIRST_PREVIOUS_USDT, FIRST_TARGET_USDTB,
            0, FIRST_PREVIOUS_USDTB_QUOTE, false
        );
    }

    function testRealMorphoCurveQuoteCanCoverPrincipalPlusAaveIllustrativePremium() public {
        _simulateTwoHopAndRollback(
            SECOND_MINIMAL_USDT, SECOND_TARGET_USDTB,
            SECOND_CURVE_USDC, SECOND_CURVE_USDTB_QUOTE, true
        );
    }

    function _assertQuotedPath(uint256 usdtIn, uint256 expectedUsdc, uint256 expectedUsdTb)
        internal view
    {
        uint256 usdc = ICurveStableSwapPartial(THREEPOOL).get_dy(2, 1, usdtIn);
        require(usdc == expectedUsdc, "REAL_CURVE_3POOL_QUOTE_CHANGED");
        uint256 usdTb = ICurveStableSwapPartial(USDTB_POOL).get_dy(0, 1, usdc);
        require(usdTb == expectedUsdTb, "REAL_CURVE_USDTB_QUOTE_CHANGED");
    }

    function _simulateTwoHopAndRollback(
        uint256 usdtIn, uint256 targetUsdTb,
        uint256 expectedUsdc, uint256 expectedUsdTb, bool reachesTarget
    ) internal {
        uint256 lenderBefore = IV2PartialERC20(USDT).balanceOf(MORPHO);
        uint256 threepoolBefore = IV2PartialERC20(USDT).balanceOf(THREEPOOL);
        uint256 usdtbPoolBefore = IV2PartialERC20(USDTB).balanceOf(USDTB_POOL);
        uint256 borrowerBefore = IV2PartialERC20(USDT).balanceOf(address(this));
        uint256 strategyBefore = IV2PartialERC20(USDT).balanceOf(address(strategy));
        bytes memory payload = abi.encodePacked("MORPHO_CURVE_PARTIAL_FORK", usdtIn);
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan = _plan(usdtIn, payload);
        try executor.execute(plan, payload) returns (uint256) {
            revert("NOT_ALLOWED_TO_COMPLETE_UNREPAID_MORPHO_FLASH");
        } catch (bytes memory reason) {
            require(reason.length == 164, "EXPECTED_PARTIAL_ROUTE_REVERT_NOT_RECEIVED");
            bytes4 selector;
            uint256 borrowed;
            uint256 usdcOutput;
            uint256 usdTbOutput;
            uint256 leftoverUsdt;
            uint256 leftoverUsdc;
            assembly ("memory-safe") {
                selector := mload(add(reason, 0x20))
                borrowed := mload(add(reason, 0x24))
                usdcOutput := mload(add(reason, 0x44))
                usdTbOutput := mload(add(reason, 0x64))
                leftoverUsdt := mload(add(reason, 0x84))
                leftoverUsdc := mload(add(reason, 0xa4))
            }
            require(selector == MorphoCurvePartialProbe.CapturedPartialRoute.selector,
                    "INCOMPLETE_CURVE_ACQUISITION");
            require(borrowed == usdtIn, "INCORRECT_FUNDING_AMOUNT");
            require(expectedUsdc == 0 || usdcOutput == expectedUsdc, "WRONG_USDC_AMOUNT");
            require(usdTbOutput == expectedUsdTb, "EXECUTED_SWAP_NE_QUOTED_OUTPUT");
            require(leftoverUsdt == 0 && leftoverUsdc == 0, "PARTIAL_INPUT_NOT_CONSUMED");
            if (reachesTarget) {
                require(usdTbOutput >= targetUsdTb, "UNDER_TARGET");
            } else {
                require(usdTbOutput < targetUsdTb, "NEIGHBOR_SHOULD_NOT_SUFFICE");
            }
        }
        // The failure is intentional: Morpho USDT cannot be repaid by USDtb.
        // This test is proof of partial swap execution and full rollback, not
        // successful liquidation, flash settlement or positive NQC P&L.
        require(IV2PartialERC20(USDT).balanceOf(MORPHO) == lenderBefore,
                "FLASH_LENDER_LOST_TOKENS");
        require(IV2PartialERC20(USDT).balanceOf(THREEPOOL) == threepoolBefore,
                "CURVE_3POOL_STATE_NOT_ROLLED_BACK");
        require(IV2PartialERC20(USDTB).balanceOf(USDTB_POOL) == usdtbPoolBefore,
                "CURVE_USDTB_POOL_STATE_NOT_ROLLED_BACK");
        require(IV2PartialERC20(USDT).balanceOf(address(this)) == borrowerBefore,
                "OPERATOR_INVENTORY_CHANGED");
        require(IV2PartialERC20(USDT).balanceOf(address(strategy)) == strategyBefore,
                "STRATEGY_STOLE_OR_LOST_USDT");
        require(!executor.consumedExecutionIdentity(plan.executionIdentityHash),
                "REVERT_SHOULD_NOT_CONSUME_IDENTITY");
    }

    function _plan(uint256 usdtIn, bytes memory payload)
        internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory)
    {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutorV2.FundingLeg({
            sourceKind: 3,
            lender: MORPHO,
            principal: usdtIn,
            expectedFee: 0,
            callbackSemanticsHash: keccak256("MORPHO_FLASH_CALLBACK_FORK_ONLY"),
            sourceEvidenceHash: keccak256("RMC_V2_PARTIAL_ROUTE_ALWAYS_REVERTS")
        });
        return NqcFlashFundingExecutorV2.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("RMC_PARTIAL",payload)),
            fundingPlanHash: keccak256(abi.encodePacked("RMC_MORPHO_FUNDING",payload)),
            anchorHash: keccak256(abi.encodePacked(PARENT,payload)),
            canonicalGeneration: 1,
            asset: USDT,
            principalRequired: usdtIn,
            minProfitAsset: 0,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }
}
