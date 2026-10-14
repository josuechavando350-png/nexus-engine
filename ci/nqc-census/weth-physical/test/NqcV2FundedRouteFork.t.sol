// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";

interface VmNqcRoute {
    function envString(string calldata) external returns (string memory);
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes(string calldata) external returns (bytes memory);
    function envBytes32(string calldata) external returns (bytes32);
    function createSelectFork(string calldata, bytes32) external returns (uint256);
}

interface IAaveNqcRoute {
    function liquidationCall(address, address, address, uint256, bool) external;
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface IUniswapNqcRoute {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
    function factory() external view returns (address);
    function WETH9() external view returns (address);
}

interface IFactoryNqcRoute {
    function getPool(address, address, uint24) external view returns (address);
}

/// @notice LOCAL TEST HARNESS ONLY. Fixed Aave liquidation and one preselected
/// Uniswap v3 500 fee pool; not a deployable production routing strategy.
contract NqcV2HistoricalRouteHarness {
    address public constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address public constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address public constant ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address public immutable operator;
    address public immutable debt;
    address public immutable borrower;
    uint256 public immutable expectedCollateral;
    address public executor;
    uint256 public soldWeth;
    uint256 public swapOutput;
    uint256 public debtSpent;

    constructor(address debt_, address borrower_, uint256 collateral_) {
        operator = msg.sender;
        debt = debt_;
        borrower = borrower_;
        expectedCollateral = collateral_;
    }

    function setExecutor(address value) external {
        require(msg.sender == operator && executor == address(0), "SETUP_ONLY");
        executor = value;
    }

    function tokenCall(address token, bytes memory data) internal {
        (bool ok, bytes memory result) = token.call(data);
        require(ok && (result.length == 0 || (result.length == 32 && abi.decode(result, (bool)))), "TOKEN_CALL");
    }

    function approve(address token, address spender, uint256 amount) internal {
        tokenCall(token, abi.encodeWithSelector(IERC20FlashMinimal.approve.selector, spender, 0));
        if (amount != 0) {
            tokenCall(token, abi.encodeWithSelector(IERC20FlashMinimal.approve.selector, spender, amount));
        }
    }

    function executeFunded(bytes32, address asset, uint256 principal, bytes calldata payload)
        external
        returns (uint256 returnedAssetUnits)
    {
        require(msg.sender == executor && asset == debt, "CALLBACK_AUTH");
        require(IERC20FlashMinimal(debt).balanceOf(address(this)) == principal, "FRESH_PRINCIPAL_ONLY");
        require(IERC20FlashMinimal(WETH).balanceOf(address(this)) == 0, "NO_PRELOADED_COLLATERAL");
        uint256 minimumSwapOutput = abi.decode(payload, (uint256));
        require(minimumSwapOutput > principal, "REPAYMENT_FLOOR_REQUIRED");
        approve(debt, POOL, principal);
        IAaveNqcRoute(POOL).liquidationCall(WETH, debt, borrower, principal, false);
        approve(debt, POOL, 0);
        debtSpent = principal - IERC20FlashMinimal(debt).balanceOf(address(this));
        require(debtSpent == principal, "HISTORICAL_DEBT_AMOUNT_MISMATCH");
        soldWeth = IERC20FlashMinimal(WETH).balanceOf(address(this));
        require(soldWeth == expectedCollateral, "HISTORICAL_COLLATERAL_AMOUNT_MISMATCH");
        approve(WETH, ROUTER, soldWeth);
        swapOutput = IUniswapNqcRoute(ROUTER)
            .exactInputSingle(
                IUniswapNqcRoute.ExactInputSingleParams({
                tokenIn: WETH,
                tokenOut: debt,
                fee: 500,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: soldWeth,
                amountOutMinimum: minimumSwapOutput,
                sqrtPriceLimitX96: 0
            })
            );
        approve(WETH, ROUTER, 0);
        require(IERC20FlashMinimal(WETH).balanceOf(address(this)) == 0, "INCOMPLETE_SWAP");
        returnedAssetUnits = IERC20FlashMinimal(debt).balanceOf(address(this));
        require(returnedAssetUnits == swapOutput, "SWAP_OUTPUT_BALANCE_MISMATCH");
        tokenCall(debt, abi.encodeWithSelector(IERC20FlashMinimal.transfer.selector, executor, returnedAssetUnits));
    }
}

/// @notice Counterfactual historical route, excluding the original winner.
/// No inventory injection, oracle mutation, signing or broadcast. The native
/// gas payer, deployment, inclusion and prospective discovery remain unproven.
contract NqcV2FundedRouteForkTest {
    VmNqcRoute constant vm = VmNqcRoute(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant ROUTER = 0xE592427A0AEce92De3Edee1F18E0157C05861564;
    address constant FACTORY = 0x1F98431c8aD98523631AE4a59f267346ea31F984;
    NqcFlashFundingExecutor executor;
    NqcV2HistoricalRouteHarness strategy;
    address debt;
    address borrower;
    address swapPool;
    uint256 principal;
    uint256 fee;
    bytes32 winner;
    bytes prestate;

    event log_named_uint(string key, uint256 val);
    event log_named_bytes32(string key, bytes32 val);
    event log_named_address(string key, address val);

    function account() internal view returns (bytes memory raw) {
        bool ok;
        (ok, raw) = POOL.staticcall(abi.encodeWithSignature("getUserAccountData(address)", borrower));
        require(ok && raw.length == 192, "ACCOUNT_READ_FAILED");
    }

    function poolState() internal view returns (bytes memory raw) {
        bool ok;
        (ok, raw) = swapPool.staticcall(abi.encodeWithSignature("slot0()"));
        require(ok && raw.length == 224, "SWAP_POOL_STATE_FAILED");
    }

    function setUp() public {
        winner = vm.envBytes32("NQC_WINNER_TX");
        vm.createSelectFork(vm.envString("NQC_RPC_URL"), winner);
        require(
            block.chainid == 1 && block.number == vm.envUint("NQC_WINNER_BLOCK")
                && block.timestamp == vm.envUint("NQC_WINNER_TIMESTAMP"),
            "CANONICAL_CONTEXT"
        );
        require(blockhash(block.number - 1) == vm.envBytes32("NQC_PARENT_HASH"), "CANONICAL_PARENT");
        borrower = vm.envAddress("NQC_BORROWER");
        debt = vm.envAddress("NQC_DEBT_ASSET");
        principal = vm.envUint("NQC_PRINCIPAL");
        prestate = vm.envBytes("NQC_PRESTATE_ABI");
        require(keccak256(account()) == keccak256(prestate), "EXACT_PRE_WINNER_ACCOUNT_REQUIRED");
        (,,,,, uint256 hf) = abi.decode(prestate, (uint256, uint256, uint256, uint256, uint256, uint256));
        require(hf < 1 ether, "NOT_LIQUIDATABLE");
        require(
            IUniswapNqcRoute(ROUTER).factory() == FACTORY && IUniswapNqcRoute(ROUTER).WETH9() == WETH,
            "CANONICAL_ROUTER"
        );
        swapPool = IFactoryNqcRoute(FACTORY).getPool(WETH, debt, 500);
        require(swapPool.code.length > 0, "PRESELECTED_POOL_MISSING");
        uint256 bps = IAaveNqcRoute(POOL).FLASHLOAN_PREMIUM_TOTAL();
        require(bps == 5, "HISTORICAL_FLASH_FEE_DRIFT");
        // These historical Aave forks use percentMulCeil. Half-up rounding
        // underquotes the USDT callback by one base unit and must fail closed.
        fee = (principal * bps + 9999) / 10000;
        strategy = new NqcV2HistoricalRouteHarness(debt, borrower, vm.envUint("NQC_COLLATERAL"));
        executor = new NqcFlashFundingExecutor(address(this), address(strategy));
        strategy.setExecutor(address(executor));
        emptyInventories();
    }

    function emptyInventories() internal view {
        require(
            IERC20FlashMinimal(debt).balanceOf(address(strategy)) == 0
                && IERC20FlashMinimal(debt).balanceOf(address(executor)) == 0
                && IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0
                && IERC20FlashMinimal(WETH).balanceOf(address(executor)) == 0,
            "NONZERO_INVENTORY"
        );
    }

    function plan(bytes memory payload, uint256 minProfit)
        internal
        view
        returns (NqcFlashFundingExecutor.FlashExecutionPlan memory p)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs = new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: POOL,
            principal: principal,
            expectedFee: fee,
            callbackSemanticsHash: keccak256("T36_CANONICAL_REAL_AAVE_CALLBACK"),
            sourceEvidenceHash: keccak256("HISTORICAL_TEST_ONLY_NOT_CAPITAL_OR_GAS_COMMITMENT")
        });
        p = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId: 1,
            validThroughBlock: block.number,
            executionIdentityHash: keccak256(abi.encode(winner, debt, principal, payload)),
            fundingPlanHash: keccak256(abi.encode("LOCAL_AAVE_FIXTURE", winner, payload)),
            anchorHash: keccak256(abi.encode(blockhash(block.number - 1), winner, prestate)),
            canonicalGeneration: 1,
            asset: debt,
            principalRequired: principal,
            minProfitAsset: minProfit,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function testHistoricalAtomicRouteSurplus() public {
        bytes memory payload = abi.encode(principal + fee + 1);
        NqcFlashFundingExecutor.FlashExecutionPlan memory p = plan(payload, 1);
        uint256 beforeBalance = IERC20FlashMinimal(debt).balanceOf(address(this));
        uint256 beforeGas = gasleft();
        uint256 surplus = executor.execute(p, payload);
        uint256 measuredCallGas = beforeGas - gasleft();
        require(surplus > 0 && strategy.swapOutput() == principal + fee + surplus, "ECONOMIC_IDENTITY");
        require(IERC20FlashMinimal(debt).balanceOf(address(this)) == beforeBalance + surplus, "OPERATOR_CREDIT");
        require(executor.consumedExecutionIdentity(p.executionIdentityHash), "IDENTITY_NOT_CONSUMED");
        emptyInventories();
        emit log_named_uint("NQC_PRINCIPAL", principal);
        emit log_named_uint("NQC_FLASH_FEE", fee);
        emit log_named_uint("NQC_SOLD_WETH", strategy.soldWeth());
        emit log_named_uint("NQC_SWAP_OUTPUT", strategy.swapOutput());
        emit log_named_uint("NQC_SURPLUS", surplus);
        // Gross gasleft delta, after setup calls: neither receipt gasUsed nor
        // a cold transaction estimate. Excludes native gas payment/refunds,
        // calldata/intrinsic/deployment/builder/sponsor/revert-attempt costs.
        emit log_named_uint("NQC_EXECUTE_CALL_GAS", measuredCallGas);
        emit log_named_uint("NQC_BASE_FEE_WEI", block.basefee);
        emit log_named_uint("NQC_PRODUCTION_GAS_SPONSORED", 0);
        emit log_named_address("NQC_SWAP_POOL", swapPool);
        emit log_named_bytes32("NQC_ROUTER_CODEHASH", ROUTER.codehash);
        emit log_named_bytes32("NQC_SWAP_POOL_CODEHASH", swapPool.codehash);
    }

    function testImpossibleProfitRollsBackEntireRoute() public {
        bytes memory payload = abi.encode(principal + fee + 1);
        NqcFlashFundingExecutor.FlashExecutionPlan memory p = plan(payload, type(uint96).max);
        bytes32 accountBefore = keccak256(account());
        bytes32 poolBefore = keccak256(poolState());
        uint256 operatorBefore = IERC20FlashMinimal(debt).balanceOf(address(this));
        uint256 poolDebtBefore = IERC20FlashMinimal(debt).balanceOf(swapPool);
        uint256 poolWethBefore = IERC20FlashMinimal(WETH).balanceOf(swapPool);
        (bool ok, bytes memory reason) = address(executor).call(abi.encodeCall(executor.execute, (p, payload)));
        require(!ok && reason.length == 68, "EXPECTED_PROFIT_FLOOR_REVERT");
        require(
            bytes4(reason) == NqcFlashFundingExecutor.InsufficientForRepaymentAndProfit.selector,
            "UNRELATED_FAILURE_IS_NOT_A_PROFIT_FLOOR_PASS"
        );
        require(keccak256(account()) == accountBefore && keccak256(poolState()) == poolBefore, "STATE_NOT_ROLLED_BACK");
        require(
            IERC20FlashMinimal(debt).balanceOf(address(this)) == operatorBefore
                && IERC20FlashMinimal(debt).balanceOf(swapPool) == poolDebtBefore
                && IERC20FlashMinimal(WETH).balanceOf(swapPool) == poolWethBefore,
            "BALANCE_NOT_ROLLED_BACK"
        );
        require(!executor.consumedExecutionIdentity(p.executionIdentityHash), "IDENTITY_NOT_ROLLED_BACK");
        require(
            strategy.soldWeth() == 0 && strategy.swapOutput() == 0 && strategy.debtSpent() == 0,
            "HARNESS_NOT_ROLLED_BACK"
        );
        emptyInventories();
        emit log_named_uint("NQC_PROFIT_FLOOR_ROLLBACK", 1);
    }
}
