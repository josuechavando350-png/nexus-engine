// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";

interface IAaveUSDtbForkPool {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function getConfiguration(address reserve) external view returns (uint256 configurationData);
    function getUserAccountData(address borrower)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IERC20USDtbFork {
    function balanceOf(address account) external view returns (uint256);
}

/// @notice Test-only principal return: never mints/provides USDtb fees.
/// @dev Real Aave positive flash requires amount + premium; this deliberately
///      cannot pay the missing fee, and the call must revert atomically.
contract ForkUSDtbPrincipalOnlyStrategy {
    error WrongExecutor();
    error WrongAsset();
    error WrongPrincipal();
    error TokenTransferFailed();

    address public immutable approvedExecutor;
    address public immutable underlyingAsset;

    constructor(address executor_, address token_) {
        approvedExecutor = executor_;
        underlyingAsset = token_;
    }

    function executeFunded(bytes32, address token, uint256 principal, bytes calldata)
        external
        returns (uint256 returnedAssetUnits)
    {
        if (msg.sender != approvedExecutor) revert WrongExecutor();
        if (token != underlyingAsset) revert WrongAsset();
        if (IERC20USDtbFork(token).balanceOf(address(this)) != principal) {
            revert WrongPrincipal();
        }
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSignature("transfer(address,uint256)", msg.sender, principal));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
        return principal;
    }
}

/// @notice Bound to exact Ethereum mainnet block. No live transactions.
/// @dev This test is not a complete route, gas sponsor or profitability proof.
contract NqcFlashFundingExecutorV2AaveUSDtbForkTest {
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4Ce8392D69350B4fA4E2;
    address internal constant USDTB = 0xC139190F447e929f090Edeb554D95AbB8b18aC1C;
    address internal constant ATOKEN = 0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8;
    address internal constant BORROWER = 0x08c14b32c8a48894e4b933090ebcc9ce33b21135;

    uint256 internal constant PINNED_BLOCK = 26_184_741;
    bytes32 internal constant PARENT_HASH =
        0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66;
    uint256 internal constant ILLUSTRATIVE_PRINCIPAL = 472_000 ether;

    NqcFlashFundingExecutorV2 internal executor;
    ForkUSDtbPrincipalOnlyStrategy internal strategy;

    event ExactReserveSnapshot(
        uint256 underlyingAtAToken,
        uint256 premiumTotalBps,
        uint256 reserveConfiguration,
        uint256 healthFactorWad
    );

    function setUp() public {
        require(block.chainid == 1 && block.number == PINNED_BLOCK, "WRONG_CHAIN_OR_BLOCK");
        require(blockhash(block.number - 1) == PARENT_HASH, "CANONICAL_PARENT_MISMATCH");
        require(AAVE_POOL.code.length > 0, "AAVE_POOL_CODE_MISSING");
        require(USDTB.code.length > 0 && ATOKEN.code.length > 0, "USDtb_RESERVE_CODE_MISSING");
        strategy = new ForkUSDtbPrincipalOnlyStrategy(address(0), USDTB);
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        // The strategy MUST reject an unbound coordinator. The pool flash still
        // reaches executeOperation before our principal-only strategy is called.
        // This branch reports truth of reserve/fee gates without a funded strategy.
    }

    function testPinnedAaveUSDtbReserveConfigAndNominalCash() public {
        IAaveUSDtbForkPool pool = IAaveUSDtbForkPool(AAVE_POOL);
        uint256 flags = pool.getConfiguration(USDTB);
        bool active = ((flags >> 56) & 1) == 1;
        bool frozen = ((flags >> 57) & 1) == 1;
        bool paused = ((flags >> 60) & 1) == 1;
        bool flashEnabled = ((flags >> 63) & 1) == 1;
        uint256 cash = IERC20USDtbFork(USDTB).balanceOf(ATOKEN);
        require(active && !frozen && !paused && flashEnabled, "FLASH_DISABLED_OR_PAUSED");
        require(cash >= ILLUSTRATIVE_PRINCIPAL, "UNDERLYING_SHORTFALL");
        uint128 premium = pool.FLASHLOAN_PREMIUM_TOTAL();
        require(premium == 5, "PREMIUM_DIFFERENT_FROM_SNAPSHOT");
    }

    function testPinnedBorrowerHealthFactorExactAtThisBlock() public {
        IAaveUSDtbForkPool pool = IAaveUSDtbForkPool(AAVE_POOL);
        (
            uint256 collateral,
            uint256 debt,
            ,
            uint256 threshold,
            ,
            uint256 hf
        ) = pool.getUserAccountData(BORROWER);
        require(collateral > debt && debt > 0, "BORROWER_STATE_UNEXPECTED");
        require(threshold == 9199, "BORROWER_THRESHOLD_UNEXPECTED");
        require(hf > 1e18, "BORROWER_ALREADY_LIQUIDATABLE");
        require(hf > 1_000_140_000_000_000_000, "HF_OUTSIDE_SNAPSHOT_RANGE_LOW");
        require(hf < 1_000_150_000_000_000_000, "HF_OUTSIDE_SNAPSHOT_RANGE_HIGH");
        emit ExactReserveSnapshot(
            IERC20USDtbFork(USDTB).balanceOf(ATOKEN),
            uint256(pool.FLASHLOAN_PREMIUM_TOTAL()),
            pool.getConfiguration(USDTB), hf
        );
    }

    function testUnfundedFlashFeeRevertsWithoutTouchingReserveOrOperatorBalance() public {
        IAaveUSDtbForkPool pool = IAaveUSDtbForkPool(AAVE_POOL);
        uint256 fee = _roundedFee(ILLUSTRATIVE_PRINCIPAL, pool.FLASHLOAN_PREMIUM_TOTAL());
        require(fee > 0, "UNEXPECTED_ZERO_FEE");
        bytes memory payload = hex"a100";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(payload, ILLUSTRATIVE_PRINCIPAL, fee, 0);
        uint256 cashBefore = IERC20USDtbFork(USDTB).balanceOf(ATOKEN);
        uint256 operatorBefore = IERC20USDtbFork(USDTB).balanceOf(address(this));
        (bool ok,) = address(executor).call(
            abi.encodeWithSelector(executor.execute.selector, plan, payload)
        );
        require(!ok, "UNFUNDED_EXECUTION_MUST_REVERT");
        require(IERC20USDtbFork(USDTB).balanceOf(ATOKEN) == cashBefore, "RESERVE_LOST_CASH");
        require(IERC20USDtbFork(USDTB).balanceOf(address(this)) == operatorBefore,
                "UNFUNDED_OPERATOR_ASSET_CHANGED");
        require(!executor.consumedExecutionIdentity(plan.executionIdentityHash),
                "REVERT_BURNED_EXECUTION_ID");
    }

    function testWrongPremiumCannotPassRealAaveCallback() public {
        bytes memory payload = hex"a101";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(payload, ILLUSTRATIVE_PRINCIPAL, 0, 0);
        uint256 cashBefore = IERC20USDtbFork(USDTB).balanceOf(ATOKEN);
        (bool ok,) = address(executor).call(
            abi.encodeWithSelector(executor.execute.selector, plan, payload)
        );
        require(!ok, "WRONG_FEE_PLAN_MUST_REVERT");
        require(IERC20USDtbFork(USDTB).balanceOf(ATOKEN) == cashBefore,
                "FEE_REVERT_RESERVE_CHANGED");
    }

    function _roundedFee(uint256 amount, uint128 premiumBps) internal pure returns (uint256) {
        return (amount * uint256(premiumBps) + 5_000) / 10_000;
    }

    function _plan(
        bytes memory payload,
        uint256 principal,
        uint256 fee,
        uint256 profitFloor
    ) internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory) {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutorV2.FundingLeg({
            sourceKind: 1,
            lender: AAVE_POOL,
            principal: principal,
            expectedFee: fee,
            callbackSemanticsHash: keccak256("AAVE_V3_USDTB_CALLBACK_HISTORICAL_FORK"),
            sourceEvidenceHash: keccak256("USDtb_RESERVE_NEGATIVE_FEE_FORK_NOT_PROVIDER_ADMISSION")
        });
        return NqcFlashFundingExecutorV2.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: PINNED_BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("AAVE_USDTB_FORK", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("USDtb_FLASH_FORK", payload)),
            anchorHash: keccak256(abi.encodePacked(PARENT_HASH, payload)),
            canonicalGeneration: 1,
            asset: USDTB,
            principalRequired: principal,
            minProfitAsset: profitFloor,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }
}
