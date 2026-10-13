// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";

interface IAaveUSDtbForkPool {
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function getConfiguration(address reserve) external view returns (uint256 configurationData);
    function getUserEMode(address borrower) external view returns (uint256);
    function getEModeCategoryCollateralConfig(uint8 category)
        external view returns (uint16 ltv, uint16 threshold, uint16 bonus);
    function liquidationCall(
        address collateral, address debtAsset, address user,
        uint256 debtToCover, bool receiveAToken
    ) external;

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

    address public approvedExecutor;
    address public immutable owner;
    address public immutable underlyingAsset;

    constructor(address token_) {
        owner = msg.sender;
        underlyingAsset = token_;
    }

    function bindExecutor(address executor_) external {
        if (msg.sender != owner || approvedExecutor != address(0)) revert WrongExecutor();
        approvedExecutor = executor_;
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
    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant USDTB = 0xC139190F447e929f090Edeb554D95AbB8b18aC1C;
    address internal constant ATOKEN = 0xEc4ef66D4fCeEba34aBB4dE69dB391Bc5476ccc8;
    address internal constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;
    address internal constant SUSDE_ATOKEN = 0x4579a27aF00A62C0EB156349f31B345c08386419;
    address internal constant USDtb_VTOKEN = 0xeA85a065F87FE28Aa8Fbf0D6C7deC472b106252C;
    address internal constant BORROWER = 0x08c14B32C8A48894E4b933090EBcC9CE33B21135;

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
        strategy = new ForkUSDtbPrincipalOnlyStrategy(USDTB);
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        strategy.bindExecutor(address(executor));
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
        (uint256 collateral, uint256 debt,, uint256 threshold,, uint256 hf) =
            pool.getUserAccountData(BORROWER);
        require(collateral > debt && debt > 0, "BORROWER_STATE_UNEXPECTED");
        require(threshold == 9199, "BORROWER_THRESHOLD_UNEXPECTED");
        require(hf > 1e18, "BORROWER_ALREADY_LIQUIDATABLE");
        require(hf > 1_000_140_000_000_000_000, "HF_OUTSIDE_SNAPSHOT_RANGE_LOW");
        require(hf < 1_000_150_000_000_000_000, "HF_OUTSIDE_SNAPSHOT_RANGE_HIGH");
        emit ExactReserveSnapshot(
            IERC20USDtbFork(USDTB).balanceOf(ATOKEN),
            uint256(pool.FLASHLOAN_PREMIUM_TOTAL()),
            pool.getConfiguration(USDTB),
            hf
        );
    }

    function testAaveFeeAdjustedNetCollateralMatchesExactHistoricalReader() public {
        IAaveUSDtbForkPool pool = IAaveUSDtbForkPool(AAVE_POOL);
        require(pool.getUserEMode(BORROWER) == 24, "NOT_EMODE_24");
        (uint16 ltv,uint16 threshold,uint16 bonus) =
            pool.getEModeCategoryCollateralConfig(24);
        require(ltv == 9000 && threshold == 9200 && bonus == 10310,
                "EMODE_24_RULES_CHANGED");
        uint256 reserveConfig = pool.getConfiguration(SUSDE);
        uint256 feeBps = (reserveConfig >> 152) & 0xFFFF;
        require(feeBps == 1000, "HISTORICAL_PROTOCOL_FEE_NOT_1000_BPS");

        uint256 borrowerSusde = IERC20USDtbFork(SUSDE_ATOKEN).balanceOf(BORROWER);
        uint256 borrowerUsdTbDebt = IERC20USDtbFork(USDtb_VTOKEN).balanceOf(BORROWER);
        require(borrowerSusde == 5_401_730_803_933_855_154_759_327,
                "BORROWER_COLLATERAL_CHANGED");
        require(borrowerUsdTbDebt == 6_216_365_161_336_592_826_745_096,
                "BORROWER_USDTB_DEBT_CHANGED");

        uint256 base = (100_000_000 * ILLUSTRATIVE_PRINCIPAL) / 125_127_009;
        uint256 gross = base * bonus / 10_000;
        uint256 bonusPart = gross - (gross * 10_000 / bonus);
        uint256 fee = (bonusPart * feeBps + 9_999) / 10_000;
        uint256 net = gross - fee;
        require(gross == 388_910_438_992_432_081_550_034,
                "EXACT_AAVE_GROSS_MODEL_MISMATCH");
        require(fee == 1_169_371_834_021_861_738_900,
                "EXACT_AAVE_PROTOCOL_FEE_MISMATCH");
        require(net == 387_741_067_158_410_219_811_134,
                "EXACT_NET_SUSDE_MODEL_MISMATCH");
        require(net < 388_000 ether && borrowerSusde > gross,
                "INSUFFICIENT_BORROWER_COLLATERAL_OR_FALSE_GROSS");
    }

    function testRealAaveLiquidationRevertsAtHFAboveOneAndPreservesBorrowerState() public {
        IAaveUSDtbForkPool pool = IAaveUSDtbForkPool(AAVE_POOL);
        (,,,,, uint256 hfBefore) = pool.getUserAccountData(BORROWER);
        require(hfBefore == 1_000_145_351_354_931_860, "HF_BLOCK_CHANGED");
        uint256 collateralBefore = IERC20USDtbFork(SUSDE_ATOKEN).balanceOf(BORROWER);
        uint256 debtBefore = IERC20USDtbFork(USDtb_VTOKEN).balanceOf(BORROWER);
        (bool ok, bytes memory errorData) = AAVE_POOL.call(
            abi.encodeWithSelector(
                IAaveUSDtbForkPool.liquidationCall.selector,
                SUSDE, USDTB, BORROWER, ILLUSTRATIVE_PRINCIPAL, false
            )
        );
        require(!ok, "AAVE_MUST_REJECT_NONLIQUIDATABLE_BORROWER");
        require(_selector(errorData) ==
                bytes4(keccak256("HealthFactorNotBelowThreshold()")),
                "NOT_HEALTH_FACTOR_REJECTION");
        (,,,,,uint256 hfAfter) = pool.getUserAccountData(BORROWER);
        require(hfAfter == hfBefore, "REVERT_CHANGED_HEALTH_FACTOR");
        require(IERC20USDtbFork(SUSDE_ATOKEN).balanceOf(BORROWER)==collateralBefore,
                "REVERT_CHANGED_COLLATERAL");
        require(IERC20USDtbFork(USDtb_VTOKEN).balanceOf(BORROWER)==debtBefore,
                "REVERT_CHANGED_USDTB_DEBT");
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
        (bool ok, bytes memory reason) =
            address(executor).call(abi.encodeWithSelector(executor.execute.selector, plan, payload));
        require(!ok, "UNFUNDED_EXECUTION_MUST_REVERT");
        require(
            _selector(reason)
                == NqcFlashFundingExecutorV2.InsufficientForRepaymentAndProfit.selector,
            "UNFUNDED_EXECUTION_MUST_REVERT_AT_FEE_GATE"
        );
        require(IERC20USDtbFork(USDTB).balanceOf(ATOKEN) == cashBefore, "RESERVE_LOST_CASH");
        require(
            IERC20USDtbFork(USDTB).balanceOf(address(this)) == operatorBefore,
            "UNFUNDED_OPERATOR_ASSET_CHANGED"
        );
        require(
            !executor.consumedExecutionIdentity(plan.executionIdentityHash),
            "REVERT_BURNED_EXECUTION_ID"
        );
    }

    function testWrongPremiumCannotPassRealAaveCallback() public {
        bytes memory payload = hex"a101";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(payload, ILLUSTRATIVE_PRINCIPAL, 0, 0);
        uint256 cashBefore = IERC20USDtbFork(USDTB).balanceOf(ATOKEN);
        (bool ok, bytes memory reason) =
            address(executor).call(abi.encodeWithSelector(executor.execute.selector, plan, payload));
        require(!ok, "WRONG_FEE_PLAN_MUST_REVERT");
        require(
            _selector(reason) == NqcFlashFundingExecutorV2.InvalidCallbackFee.selector,
            "WRONG_PREMIUM_REJECT_REASON"
        );
        require(
            IERC20USDtbFork(USDTB).balanceOf(ATOKEN) == cashBefore, "FEE_REVERT_RESERVE_CHANGED"
        );
    }

    function _selector(bytes memory raw) internal pure returns (bytes4 result) {
        if (raw.length >= 4) {
            assembly ("memory-safe") { result := mload(add(raw, 0x20)) }
        }
    }

    function _roundedFee(uint256 amount, uint128 premiumBps) internal pure returns (uint256) {
        return (amount * uint256(premiumBps) + 5_000) / 10_000;
    }

    function _plan(bytes memory payload, uint256 principal, uint256 fee, uint256 profitFloor)
        internal
        view
        returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory)
    {
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
