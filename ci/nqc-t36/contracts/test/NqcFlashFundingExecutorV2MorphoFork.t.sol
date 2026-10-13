// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutorV2} from "../src/NqcFlashFundingExecutorV2.sol";

interface IERC20MorphoForkBalance {
    function balanceOf(address owner) external view returns (uint256);
}

/// @notice Only returns the borrowed USDT principal. No mint, deposit or
///         prefunded fee fixture is used on the fork.
contract ForkMorphoUSDTPrincipalReturnStrategy {
    error NotExecutor();
    error AlreadyBound();
    error WrongAsset();
    error WrongPrincipal();
    error TokenTransferFailed();

    address public immutable owner;
    address public executor;
    address public immutable asset;

    constructor(address asset_) {
        owner = msg.sender;
        asset = asset_;
    }

    function bind(address executor_) external {
        if (msg.sender != owner || executor != address(0)) revert AlreadyBound();
        executor = executor_;
    }

    function executeFunded(bytes32, address token, uint256 principal, bytes calldata)
        external
        returns (uint256 returnedAssetUnits)
    {
        if (msg.sender != executor) revert NotExecutor();
        if (token != asset) revert WrongAsset();
        if (IERC20MorphoForkBalance(token).balanceOf(address(this)) != principal) {
            revert WrongPrincipal();
        }
        // Ethereum USDT is compatible with non-returning ERC20 transfer paths;
        // a typed IERC20.transfer(address,uint256) that decodes a bool may fail.
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSignature("transfer(address,uint256)", msg.sender, principal)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert TokenTransferFailed();
        }
        return principal;
    }
}

/// @notice Actual Ethereum fork uses the deployed Morpho Blue and Tether USDT.
/// @dev This does NOT involve Aave liquidation, DEX swaps, externally sponsored
///      gas, prospective detection, a trading strategy or real NQC P&L.
contract NqcFlashFundingExecutorV2MorphoForkTest {
    address internal constant MORPHO_BLUE =
        0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant USDT =
        0xdAC17F958D2ee523a2206206994597C13D831ec7;

    uint256 internal constant BLOCK_NUMBER = 26_184_741;
    bytes32 internal constant PARENT_HASH =
        0x53ddf49d46b566154bbb876ae76839331ee43b01beab19190b813eecbda5ec66;
    // A separate, lower-trust Blockscout source reported this exact raw USDT
    // balance at this block. Require full equality from the fork RPC.
    uint256 internal constant REPORTED_MORPHO_USDT_RAW = 65_666_477_002_958;

    ForkMorphoUSDTPrincipalReturnStrategy internal strategy;
    NqcFlashFundingExecutorV2 internal executor;

    function setUp() public {
        require(block.chainid == 1, "ETHEREUM_ONLY");
        require(block.number == BLOCK_NUMBER, "BLOCK_MISMATCH");
        require(blockhash(block.number - 1) == PARENT_HASH, "PARENT_HASH_MISMATCH");
        require(MORPHO_BLUE.code.length > 0, "MORPHO_CODE_MISSING");
        require(USDT.code.length > 0, "USDT_CODE_MISSING");

        strategy = new ForkMorphoUSDTPrincipalReturnStrategy(USDT);
        executor = new NqcFlashFundingExecutorV2(address(this), address(strategy));
        strategy.bind(address(executor));
    }

    function testRealForkUSDTBalanceMatchesPinnedExternalObservation() public view {
        require(_balance(MORPHO_BLUE) == REPORTED_MORPHO_USDT_RAW, "FORK_BALANCE_MISMATCH");
        require(REPORTED_MORPHO_USDT_RAW > 472_000 * 1e6, "CAPACITY_INSUFFICIENT");
        require(_balance(address(executor)) == 0, "EXECUTOR_PREEXISTING_BALANCE");
        require(_balance(address(strategy)) == 0, "STRATEGY_PREEXISTING_BALANCE");
        require(_balance(address(this)) == 0, "OPERATOR_PREEXISTING_BALANCE");
    }

    function testRealForkMorphoOneUSDTFlashPrincipalReturnsExactly() public {
        _verifyExactRealFlashReturn(1e6, hex"f001");
    }

    function testRealForkMorphoFourHundredSeventyTwoThousandUSDTFlashPrincipalReturnsExactly()
        public
    {
        // This is a same-asset flash callback demonstration, NOT a USDtb
        // collateral/debt liquidation, route quote or committed funding offer.
        _verifyExactRealFlashReturn(472_000 * 1e6, hex"f002");
    }

    function testRealForkMorphoArtificialProfitFloorMustRevertAtomically() public {
        uint256 beforeLender = _balance(MORPHO_BLUE);
        uint256 beforeOperator = _balance(address(this));
        bytes memory payload = hex"f003";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(1e6, 1, payload);
        try executor.execute(plan, payload) returns (uint256) {
            revert("MUST_REVERT_WITHOUT_GENUINE_PROFIT");
        } catch (bytes memory reason) {
            require(_selector(reason) ==
                NqcFlashFundingExecutorV2.InsufficientForRepaymentAndProfit.selector,
                "INCORRECT_REVERT_REASON");
        }
        require(_balance(MORPHO_BLUE) == beforeLender, "REVERT_LENDER_BALANCE_CHANGED");
        require(_balance(address(this)) == beforeOperator, "REVERT_OPERATOR_GAINED");
        require(_balance(address(executor)) == 0, "REVERT_EXECUTOR_BALANCE_CHANGED");
        require(!executor.consumedExecutionIdentity(plan.executionIdentityHash),
                "REVERT_CONSUMED_IDENTITY");
    }

    function testRealForkMorphoUnsolicitedCallbackDenied() public {
        uint256 principal = 1e6;
        bytes memory payload = hex"f004";
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(principal, 0, payload);
        NqcFlashFundingExecutorV2.CallbackEnvelope memory envelope =
            NqcFlashFundingExecutorV2.CallbackEnvelope({
                plan: plan, payload: payload, legIndex: 0
            });
        try executor.onMorphoFlashLoan(principal, abi.encode(envelope)) {
            revert("UNEXPECTED_CALLBACK_ACCEPTED");
        } catch (bytes memory reason) {
            require(_selector(reason) == NqcFlashFundingExecutorV2.NoExecutionActive.selector,
                    "INVALID_REVERT_SELECTOR");
        }
    }

    function _verifyExactRealFlashReturn(uint256 principal, bytes memory payload) internal {
        require(_balance(MORPHO_BLUE) >= principal, "NOMINAL_LIQUIDITY_LOW");
        uint256 lenderBefore = _balance(MORPHO_BLUE);
        uint256 operatorBefore = _balance(address(this));
        uint256 totalSupplyBefore = _totalSupply();
        NqcFlashFundingExecutorV2.FlashExecutionPlan memory plan =
            _plan(principal, 0, payload);
        uint256 returnedProfit = executor.execute(plan, payload);
        require(returnedProfit == 0, "UNPROVEN_PNL_IN_TEST");
        require(_balance(MORPHO_BLUE) == lenderBefore, "EXACT_REPAYMENT_FAILED");
        require(_balance(address(this)) == operatorBefore, "ZERO_OWN_CAPITAL_TOKEN");
        require(_balance(address(strategy)) == 0, "STRATEGY_BALANCE_DRIFT");
        require(_balance(address(executor)) == 0, "EXECUTOR_BALANCE_DRIFT");
        require(_allowance(address(executor), MORPHO_BLUE) == 0, "REMAINING_APPROVAL");
        require(_totalSupply() == totalSupplyBefore, "NO_MINTED_CAPITAL_PERMITTED");
        require(executor.consumedExecutionIdentity(plan.executionIdentityHash),
                "NO_EXECUTION_ID_REPLAY_PROTECTION");
    }

    function _plan(uint256 principal, uint256 profitFloor, bytes memory payload)
        internal view returns (NqcFlashFundingExecutorV2.FlashExecutionPlan memory)
    {
        NqcFlashFundingExecutorV2.FundingLeg[] memory legs =
            new NqcFlashFundingExecutorV2.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutorV2.FundingLeg({
            sourceKind: 3,
            lender: MORPHO_BLUE,
            principal: principal,
            expectedFee: 0,
            callbackSemanticsHash: keccak256("REAL_MORPHO_BLUE_FLASH_CALLBACK_FORK_ONLY"),
            sourceEvidenceHash: keccak256("ETH_26184741_MORPHO_FORK_TEST_NOT_CAPITAL_ADMISSION")
        });
        return NqcFlashFundingExecutorV2.FlashExecutionPlan({
            chainId: block.chainid,
            validThroughBlock: BLOCK_NUMBER,
            executionIdentityHash: keccak256(abi.encodePacked("NQC_MORPHO_FORK_TEST", payload)),
            fundingPlanHash: keccak256(abi.encodePacked("NQC_MORPHO_FUNDING", payload)),
            anchorHash: keccak256(abi.encodePacked("ETH_26184741", PARENT_HASH, payload)),
            canonicalGeneration: 1,
            asset: USDT,
            principalRequired: principal,
            minProfitAsset: profitFloor,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _balance(address owner_) internal view returns (uint256) {
        return IERC20MorphoForkBalance(USDT).balanceOf(owner_);
    }

    function _allowance(address owner_, address spender_) internal view returns (uint256) {
        (bool ok, bytes memory data) = USDT.staticcall(
            abi.encodeWithSignature("allowance(address,address)", owner_, spender_)
        );
        require(ok && data.length >= 32, "ALLOWANCE_READ_FAILED");
        return abi.decode(data, (uint256));
    }

    function _totalSupply() internal view returns (uint256) {
        (bool ok, bytes memory data) = USDT.staticcall(
            abi.encodeWithSignature("totalSupply()")
        );
        require(ok && data.length >= 32, "TOTAL_SUPPLY_READ_FAILED");
        return abi.decode(data, (uint256));
    }

    function _selector(bytes memory raw) internal pure returns (bytes4 value) {
        if (raw.length >= 4) {
            assembly ("memory-safe") { value := mload(add(raw, 0x20)) }
        }
    }
}
