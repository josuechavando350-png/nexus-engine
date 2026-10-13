// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";

interface IV2FluidToken {
    function balanceOf(address owner) external view returns (uint256);
}

interface IV2FluidT1 {
    function DEX_ID() external view returns (uint256);
    function swapIn(bool zeroToOne, uint256 amountIn, uint256 minOut, address to)
        external
        payable
        returns (uint256 amountOut);
}

interface IV2FluidReserves {
    function estimateSwapIn(address dex, bool zeroToOne, uint256 amountIn, uint256 minOut)
        external
        payable
        returns (uint256 amountOut);
}

/// @notice Morpho funds this test with real sUSDe; Fluid swaps into real USDT
///         against deployed contracts on a historical mainnet fork. The
///         partial route MUST revert before Morpho repayment.
/// @dev A permissive minOut=1 is for diagnostics only. It is NOT a
///      safe production slippage bound or profitability/availability claim.
contract MorphoFluidRevertingProbe {
    error BadExecutor();
    error WrongToken();
    error IncompletePrincipal();
    error ApprovalFailed();
    error FluidNoOutput();
    error OutputMismatch();
    error OldInventoryConsumed();
    error FluidIntermediateSwap(
        uint256 sUsdeIn, uint256 usdtReceived, uint256 initialSUsde, uint256 initialUsdt
    );

    address internal constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant FLUID = 0x1DD125C32e4B5086c63CC13B3cA02C4A2a61Fa9b;

    address public immutable owner;
    address public trustedExecutor;

    constructor() {
        owner = msg.sender;
    }

    function bindExecutor(address executor_) external {
        if (msg.sender != owner || trustedExecutor != address(0) || executor_ == address(0)) {
            revert BadExecutor();
        }
        trustedExecutor = executor_;
    }

    function executeFunded(bytes32, address asset, uint256 principal, bytes calldata)
        external
        returns (uint256)
    {
        if (msg.sender != trustedExecutor) revert BadExecutor();
        if (asset != SUSDE || principal == 0) revert WrongToken();
        uint256 startingSUsde = IV2FluidToken(SUSDE).balanceOf(address(this));
        uint256 startingUsdt = IV2FluidToken(USDT).balanceOf(address(this));
        if (startingSUsde < principal) revert IncompletePrincipal();

        _approve(SUSDE, FLUID, principal);
        uint256 reportedUsdt = IV2FluidT1(FLUID).swapIn(true, principal, 1, address(this));
        uint256 received = IV2FluidToken(USDT).balanceOf(address(this)) - startingUsdt;
        if (reportedUsdt != received) revert OutputMismatch();
        if (received == 0) revert FluidNoOutput();
        if (IV2FluidToken(SUSDE).balanceOf(address(this)) != startingSUsde - principal) {
            revert OldInventoryConsumed();
        }

        // We deliberately have USDT now, not the original borrowed sUSDe.
        // Without a collateral/swap and same-asset funding repayment loop,
        // this is NOT a valid completed flash transaction.
        revert FluidIntermediateSwap(principal, received, startingSUsde, startingUsdt);
    }

    function _approve(address token, address spender, uint256 amount) private {
        (bool reset, bytes memory resetData) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, 0));
        if (!reset || (resetData.length != 0 && !abi.decode(resetData, (bool)))) {
            revert ApprovalFailed();
        }
        (bool set, bytes memory setData) =
            token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
        if (!set || (setData.length != 0 && !abi.decode(setData, (bool)))) {
            revert ApprovalFailed();
        }
    }
}

/// @notice Executes deployed Morpho and Fluid contracts ONLY in a local
///         Ethereum fork. No real signatures, gas, capital or broadcast.
contract NqcV2MorphoFluidPartialForkTest {
    event log_named_uint(string key, uint256 value);

    address internal constant SUSDE = 0x9D39A5DE30e57443BfF2A8307A4256c8797A3497;
    address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant FLUID = 0x1DD125C32e4B5086c63CC13B3cA02C4A2a61Fa9b;
    address internal constant RESOLVER = 0x05Bd8269A20C472b148246De20E6852091BF16Ff;
    address internal constant FACTORY = 0x91716C4EDA1Fb55e84Bf8b4c7085f84285c19085;

    uint256 internal constant PINNED_BLOCK = 26_184_741;
    bytes32 internal constant PARENT =
        0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66;
    uint256 internal constant MORPHO_SUSDE_NOMINAL_RAW = 93_343_562_174_783_715_605_503_221;
    uint256 internal constant MORPHO_USDT_NOMINAL_RAW = 65_666_477_002_958;

    MorphoFluidRevertingProbe internal strategy;
    NqcFlashFundingExecutorV2 internal executor;

    struct BalancesBefore {
        uint256 morphoSusde;
        uint256 strategySusde;
        uint256 strategyUsdt;
        uint256 fluidSusde;
        uint256 operatorUsdt;
        uint256 operatorSusde;
    }

    function setUp() public {
        require(block.chainid == 1 && block.number == PINNED_BLOCK, "NOT_ETHEREUM_PIN");
        require(blockhash(block.number - 1) == PARENT, "WRONG_PARENT_HASH");
        require(SUSDE.code.length > 0 && USDT.code.length > 0, "TOKEN_CODE_MISSING");
        require(MORPHO.code.length > 0 && FLUID.code.length > 0, "PROTOCOL_CODE_MISSING");
        require(RESOLVER.code.length > 0, "RESOLVER_CODE_MISSING");
        strategy = new MorphoFluidRevertingProbe();
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        strategy.bindExecutor(address(executor));
    }

    function testRealFluidPoolTokenIdentityAndMorphoNominalSUsdePinned() public view {
        require(IV2FluidT1(FLUID).DEX_ID() == 15, "WRONG_FLUID_DEX_ID");
        (bool ok, bytes memory data) = FLUID.staticcall(abi.encodeWithSignature("constantsView()"));
        require(ok && data.length == 18 * 32, "FLUID_CONSTANTS_ABI_INCOMPATIBLE");
        uint256 dexId;
        address poolFactory;
        address token0;
        address token1;
        assembly ("memory-safe") {
            dexId := mload(add(data, 0x20))
            poolFactory := mload(add(data, 0x60))
            token0 := mload(add(data, 0x140))
            token1 := mload(add(data, 0x160))
        }
        require(dexId == 15 && poolFactory == FACTORY, "FLUID_FACTORY_ID_DRIFT");
        require(token0 == SUSDE && token1 == USDT, "SWAP_DIRECTION_OR_TOKENS_WRONG");
        require(
            _balance(SUSDE, MORPHO) == MORPHO_SUSDE_NOMINAL_RAW, "MORPHO_SUSDE_SOURCE_BALANCE_DRIFT"
        );
        require(
            _balance(USDT, MORPHO) == MORPHO_USDT_NOMINAL_RAW, "MORPHO_USDT_SOURCE_BALANCE_DRIFT"
        );
    }

    function testRealMorphoFluidSwapOneThousandSUSDeRevertsWithMeasuredUSDT() public {
        _partialFluidSwap(1_000 ether);
    }

    function testRealMorphoFluidSwapFiftyThousandSUSDeRevertsWithMeasuredUSDT() public {
        _partialFluidSwap(50_000 ether);
    }

    function testRealMorphoFluidSwapTwoHundredThousandSUSDeRevertsWithMeasuredUSDT() public {
        _partialFluidSwap(200_000 ether);
    }

    function testFluidExitCapacitySamplesVersus472461USDTRepaymentThreshold() public {
        // Diagnostic resolver quote sampling only: the original Morpho USDT
        // route requires >= 472461.610797 USDT to fund 472000 USDtb on Curve.
        // This is NOT an Aave liquidation reward or proof of actual repayment.
        uint256[10] memory inputSizes = [
            uint256(250_000), 300_000, 330_000, 350_000, 370_000,
            375_000, 378_000, 380_000, 390_000, 400_000
        ];
        uint256 largestQuoted;
        uint256 positiveEstimates;
        for (uint256 i; i < inputSizes.length; ++i) {
            uint256 raw = inputSizes[i] * 1 ether;
            try IV2FluidReserves(RESOLVER).estimateSwapIn(FLUID,true,raw,1)
                returns (uint256 estimated) {
                emit log_named_uint("NQC_FLUID_SAMPLE_SUSDE_INPUT_UNITS", inputSizes[i]);
                emit log_named_uint("NQC_FLUID_SAMPLE_USDT_OUTPUT_RAW", estimated);
                if (estimated > 0) {
                    positiveEstimates += 1;
                    if (estimated > largestQuoted) largestQuoted = estimated;
                }
            } catch {
                emit log_named_uint("NQC_FLUID_SAMPLE_SUSDE_INPUT_UNITS", inputSizes[i]);
                emit log_named_uint("NQC_FLUID_SAMPLE_USDT_OUTPUT_UNAVAILABLE",1);
            }
        }
        require(positiveEstimates <= inputSizes.length, "BAD_SAMPLE_CARDINALITY");
        emit log_named_uint("NQC_FLUID_SAMPLED_POSITIVE_QUOTES", positiveEstimates);
        emit log_named_uint("NQC_FLUID_SAMPLED_LARGEST_USDT_RAW", largestQuoted);
        emit log_named_uint(
            "NQC_FLUID_SAMPLED_QUOTE_COVERS_MORPHO_ROUTE_INPUT",
            largestQuoted >= 472_461_610_797 ? 1 : 0
        );
        // Finite samples never prove global liquidity capacity, inclusion,
        // gas sponsorship, competitor survival or net P&L.
    }

    function testFluidResolverNoPositive400kEstimateDoesNotProveGlobalCapacity() public {
        uint256 quote = IV2FluidReserves(RESOLVER).estimateSwapIn(FLUID, true, 400_000 ether, 1);
        require(quote == 0, "HISTORICAL_400K_ESTIMATE_DIFFERENT");
        // A zero estimator output is not a proof no external liquidity exists.
        // Do not call swapIn with an unbounded slippage policy.
    }

    function _partialFluidSwap(uint256 collateralAmount) internal {
        BalancesBefore memory beforeBalance = _beforeBalances();
        uint256 estimate =
            IV2FluidReserves(RESOLVER).estimateSwapIn(FLUID, true, collateralAmount, 1);
        require(estimate > 0, "FLUID_ESTIMATOR_NOT_POSITIVE_AT_THIS_SIZE");

        bytes memory payload = abi.encodePacked("FLUID_SUSDE_USDT_TEST", collateralAmount);
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan = _plan(payload, collateralAmount);
        try executor.execute(plan, payload) returns (uint256) {
            revert("MORPHO_FLASH_MUST_NOT_COMPLETE_WITH_USDT");
        } catch (bytes memory reason) {
            uint256 actual = _decodeStrictPartial(reason, collateralAmount);
            emit log_named_uint("NQC_FLUID_SUSDE_INPUT_RAW", collateralAmount);
            emit log_named_uint("NQC_FLUID_ESTIMATED_USDT_RAW", estimate);
            emit log_named_uint("NQC_FLUID_ACTUAL_USDT_RAW", actual);
            emit log_named_uint(
                "NQC_FLUID_ACTUAL_MINUS_ESTIMATE_RAW",
                actual >= estimate ? actual - estimate : estimate - actual
            );
        }
        _assertRestored(beforeBalance, plan.executionIdentityHash);
    }

    function _decodeStrictPartial(bytes memory data, uint256 expectedInput)
        internal
        pure
        returns (uint256 outputUsdt)
    {
        require(data.length == 4 + 4 * 32, "FLUID_PARTIAL_ROUTE_DID_NOT_COMPLETE");
        bytes4 selector;
        uint256 input;
        assembly ("memory-safe") {
            selector := mload(add(data, 0x20))
            input := mload(add(data, 0x24))
            outputUsdt := mload(add(data, 0x44))
        }
        require(
            selector == MorphoFluidRevertingProbe.FluidIntermediateSwap.selector,
            "FLUID_EXPECTED_INTENTIONAL_REVERT"
        );
        require(input == expectedInput && outputUsdt > 0, "WRONG_FLUID_FILL_VALUES");
    }

    function _beforeBalances() internal view returns (BalancesBefore memory p) {
        p.morphoSusde = _balance(SUSDE, MORPHO);
        p.strategySusde = _balance(SUSDE, address(strategy));
        p.strategyUsdt = _balance(USDT, address(strategy));
        p.fluidSusde = _balance(SUSDE, FLUID);
        p.operatorUsdt = _balance(USDT, address(this));
        p.operatorSusde = _balance(SUSDE, address(this));
    }

    function _assertRestored(BalancesBefore memory p, bytes32 identity) internal view {
        require(_balance(SUSDE, MORPHO) == p.morphoSusde, "MORPHO_SUSDE_NOT_ROLLED_BACK");
        require(
            _balance(SUSDE, address(strategy)) == p.strategySusde,
            "STRATEGY_SUSDE_WAS_NOT_ROLLED_BACK"
        );
        require(
            _balance(USDT, address(strategy)) == p.strategyUsdt, "STRATEGY_USDT_WAS_NOT_ROLLED_BACK"
        );
        require(_balance(SUSDE, FLUID) == p.fluidSusde, "FLUID_POOL_CHANGE_NOT_ROLLED_BACK");
        require(_balance(USDT, address(this)) == p.operatorUsdt, "OPERATOR_USDT_CHANGED");
        require(_balance(SUSDE, address(this)) == p.operatorSusde, "OPERATOR_SUSDE_CHANGED");
        require(
            !executor.consumedExecutionIdentity(identity), "FAILED_FLASH_MUST_NOT_CONSUME_IDENTITY"
        );
    }

    function _plan(bytes memory payload, uint256 principal)
        internal
        view
        returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan)
    {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutorV2.FundingLeg({
            sourceKind: 3,
            lender: MORPHO,
            principal: principal,
            expectedFee: 0,
            callbackSemanticsHash: keccak256("MORPHO_SUSDE_REAL_FORK_CALLBACK"),
            sourceEvidenceHash: keccak256("FLUID_PARTIAL_USDT_EXIT_NO_LIQUIDATION")
        });
        return NqcFlashFundingExecutorV2.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: PINNED_BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("MORPHO_FLUID_PARTIAL", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("MORPHO_SUSDE_FUNDING", payload)),
            anchorHash: keccak256(abi.encodePacked(PARENT, payload)),
            canonicalGeneration: 1,
            asset: SUSDE,
            principalRequired: principal,
            minProfitAsset: 0,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _balance(address token, address account) internal view returns (uint256) {
        return IV2FluidToken(token).balanceOf(account);
    }
}
