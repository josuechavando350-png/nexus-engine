// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";
import {NqcRmc016WethActualLiquidationStrategy} from "./NqcRmc016RankOneSelfFinancingFork.t.sol";

interface VmRmc011Postop {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function warp(uint256 timestamp) external;
    function roll(uint256 blockNumber) external;
}

interface IAaveRmc011Postop {
    function getUserAccountData(address borrower) external view returns (
        uint256 collateral, uint256 debt, uint256 available,
        uint256 threshold, uint256 ltv, uint256 hf
    );
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

/// @dev TEST-ONLY smart-account/operator proxy. Not an ERC-4337-compatible
/// account, not an EntryPoint adapter and not an authorized provider.
contract NqcRmc011PostopAccountFixture {
    address public immutable facade;
    address public immutable weth;
    address public immutable paymaster;
    NqcFlashFundingExecutor public executor;
    bool public configured;

    constructor(address facade_, address weth_, address paymaster_) {
        require(facade_ != address(0) && weth_ != address(0) && paymaster_ != address(0),
                "INVALID_ACCOUNT_FIXTURE");
        facade = facade_;
        weth = weth_;
        paymaster = paymaster_;
    }

    modifier onlyFacade() {
        require(msg.sender == facade, "UNAUTHORIZED_FIXTURE_CALLER");
        _;
    }

    function setExecutor(address executor_) external onlyFacade {
        require(!configured && executor_ != address(0), "EXECUTOR_ALREADY_SET");
        configured = true;
        executor = NqcFlashFundingExecutor(executor_);
    }

    function executeAndApprove(
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan,
        bytes memory payload,
        uint256 maxCharge,
        uint256 minimumAccountRetention
    ) external onlyFacade returns (uint256 surplus) {
        require(configured && maxCharge > 0, "NOT_CONFIGURED_OR_ZERO_CHARGE");
        uint256 beforeAmount = IERC20FlashMinimal(weth).balanceOf(address(this));
        surplus = executor.execute(plan, payload);
        require(IERC20FlashMinimal(weth).balanceOf(address(this)) == beforeAmount + surplus,
                "REAL_T36_WETH_OPERATOR_SWEEP_MISMATCH");
        require(surplus >= maxCharge + minimumAccountRetention,
                "INSUFFICIENT_NEW_WETH_TO_REPAY_GAS");
        // Allow only the fixture collector exactly this bounded reimbursement.
        require(IERC20FlashMinimal(weth).approve(paymaster, 0), "CLEAR_FIRST");
        require(IERC20FlashMinimal(weth).approve(paymaster, maxCharge), "APPROVAL_FALSE");
    }

    function clearPostopAllowance() external onlyFacade {
        require(IERC20FlashMinimal(weth).approve(paymaster, 0), "REVOKE_FALSE");
    }
}

/// @dev TEST-ONLY ERC20 pull. It does NOT front native ETH or implement
/// validatePaymasterUserOp/postOp or EntryPoint deposit/slashing semantics.
contract NqcRmc011PaymasterCollectionFixture {
    address public immutable facade;
    address public immutable weth;
    address public immutable treasury;

    constructor(address facade_, address weth_, address treasury_) {
        require(facade_ != address(0) && weth_ != address(0) && treasury_ != address(0),
                "INVALID_PAYMASTER_FIXTURE");
        facade = facade_;
        weth = weth_;
        treasury = treasury_;
    }

    function pullFromAccount(address account, uint256 amount) external {
        require(msg.sender == facade, "UNAUTHORIZED_POSTOP_COLLECTOR");
        require(IERC20FlashMinimal(weth).transferFrom(account, treasury, amount),
                "POSTOP_TOKEN_COLLECTION_FAILED");
    }
}

/// @dev Atomic sequencing fixture: NOT a real ERC-4337 EntryPoint.
/// Pull fail reverts entire fixture tx; real EntryPoint failure accounting
/// may differ and is specifically NOT certified by these tests.
contract NqcRmc011EntryPointLikeFacadeFixture {
    address public immutable owner;
    address public immutable weth;
    address public immutable treasury;
    bool public configured;

    NqcRmc011PostopAccountFixture public account;
    NqcRmc011PaymasterCollectionFixture public collector;

    constructor(address weth_, address treasury_) {
        owner = msg.sender;
        weth = weth_;
        treasury = treasury_;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "UNAUTHORIZED_TEST_ENTRYPOINT_OWNER");
        _;
    }

    function configure(address account_, address collector_) external onlyOwner {
        require(!configured, "TEST_FACADE_ALREADY_CONFIGURED");
        account = NqcRmc011PostopAccountFixture(account_);
        collector = NqcRmc011PaymasterCollectionFixture(collector_);
        require(account.facade() == address(this) && collector.facade() == address(this)
                && account.weth() == weth && collector.weth() == weth
                && account.paymaster() == collector_, "TEST_ONLY_BINDING_MISMATCH");
        configured = true;
    }

    function setExecutor(address executor_) external onlyOwner {
        require(configured, "TEST_FACADE_NOT_CONFIGURED");
        account.setExecutor(executor_);
    }

    function executeThenMockPostop(
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan,
        bytes memory payload,
        uint256 quotedTokenCharge,
        uint256 minimumAccountRetention
    ) external onlyOwner returns (uint256 surplus) {
        require(configured && quotedTokenCharge > 0, "NO_MOCK_POSTOP");
        uint256 priorAccountWeth = IERC20FlashMinimal(weth).balanceOf(address(account));
        uint256 priorTreasuryWeth = IERC20FlashMinimal(weth).balanceOf(treasury);
        surplus = account.executeAndApprove(
            plan, payload, quotedTokenCharge, minimumAccountRetention);
        collector.pullFromAccount(address(account), quotedTokenCharge);
        account.clearPostopAllowance();
        require(IERC20FlashMinimal(weth).balanceOf(treasury) ==
                priorTreasuryWeth + quotedTokenCharge, "MOCK_SPONSOR_WETH_NOT_COLLECTED");
        require(IERC20FlashMinimal(weth).balanceOf(address(account)) ==
                priorAccountWeth + surplus - quotedTokenCharge,
                "TOKEN_SETTLEMENT_CONSERVATION_FAILURE");
        require(IERC20FlashMinimal(weth).allowance(address(account), address(collector)) == 0,
                "TOKEN_SPENDER_ALLOWANCE_NOT_REVOKED");
    }
}

/// @notice One historical real-Aave-liquidation WETH payment-asset wiring test.
/// @dev Only token flow is tested. No EntryPoint UserOperation, native sponsor,
/// quote/policy/validation, postOp code, signatures, gas economics or captured P&L.
contract NqcRmc011WethPostopOperatorForkTest {
    VmRmc011Postop internal constant vm =
        VmRmc011Postop(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    address internal constant MOCK_SPONSOR_TREASURY = address(uint160(0xBA5E));
    uint256 internal constant PREVIOUS_BLOCK = 25_938_047;
    uint256 internal constant WINNER_BLOCK = 25_938_048;
    uint256 internal constant DEBT_WETH_WEI = 10_684_013_854_557_827_871;
    uint256 internal constant BEFORE_HF_WAD = 1_000_000_001_993_818_630;
    uint256 internal constant CLOCK_ONLY_HF_WAD = 999_999_999_704_293_538;
    uint256 internal constant EXPECTED_SURPLUS_WEI = 90_814_117_763_741_536;

    NqcRmc011EntryPointLikeFacadeFixture internal facade;
    NqcRmc011PaymasterCollectionFixture internal mockCollector;
    NqcRmc011PostopAccountFixture internal smartAccount;
    NqcRmc016WethActualLiquidationStrategy internal strategy;
    NqcFlashFundingExecutor internal flashExecutor;

    address internal borrower;
    uint256 internal winnerTime;

    event log_named_uint(string label, uint256 value);

    function setUp() public {
        require(block.chainid == 1 && block.number == PREVIOUS_BLOCK,
                "WRONG_PREDECESSOR_FORK");
        borrower = vm.envAddress("NQC_RMC016_RANK1_BORROWER");
        winnerTime = vm.envUint("NQC_RMC016_RANK1_WINNER_TIMESTAMP");
        require(block.timestamp == vm.envUint("NQC_RMC016_RANK1_PREVIOUS_TIMESTAMP")
                && winnerTime > block.timestamp, "CLOCK_EVIDENCE_DRIFT");

        facade = new NqcRmc011EntryPointLikeFacadeFixture(WETH, MOCK_SPONSOR_TREASURY);
        mockCollector = new NqcRmc011PaymasterCollectionFixture(
            address(facade), WETH, MOCK_SPONSOR_TREASURY);
        smartAccount = new NqcRmc011PostopAccountFixture(
            address(facade), WETH, address(mockCollector));

        strategy = new NqcRmc016WethActualLiquidationStrategy(WETH, POOL, borrower);
        flashExecutor = new NqcFlashFundingExecutor(address(smartAccount), address(strategy));
        strategy.setExecutor(address(flashExecutor));
        facade.configure(address(smartAccount), address(mockCollector));
        facade.setExecutor(address(flashExecutor));

        require(IERC20FlashMinimal(WETH).balanceOf(address(smartAccount)) == 0
                && IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0
                && IERC20FlashMinimal(WETH).balanceOf(address(flashExecutor)) == 0,
                "ZERO_INVENTORY_FIXTURE_REQUIRED");
    }

    function _healthFactor() internal view returns (uint256 hf) {
        (,,,,,hf) = IAaveRmc011Postop(POOL).getUserAccountData(borrower);
    }

    function _timeOnly() internal {
        require(_healthFactor() == BEFORE_HF_WAD, "ORIGINAL_HEALTH_EVIDENCE_DRIFT");
        vm.warp(winnerTime);
        vm.roll(WINNER_BLOCK);
        require(_healthFactor() == CLOCK_ONLY_HF_WAD,
                "TIME_ONLY_LIQUIDATABILITY_DRIFT");
    }

    function _flashFee() internal view returns (uint256) {
        uint256 basisPoints = uint256(IAaveRmc011Postop(POOL).FLASHLOAN_PREMIUM_TOTAL());
        require(basisPoints == 5, "HISTORICAL_POOL_FEE_DRIFT");
        return (DEBT_WETH_WEI * basisPoints + 5000) / 10000;
    }

    function _plan(bytes memory payload, uint256 fee)
        internal pure returns (NqcFlashFundingExecutor.FlashExecutionPlan memory p)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: POOL,
            principal: DEBT_WETH_WEI,
            expectedFee: fee,
            callbackSemanticsHash: keccak256("RMC011_POSTOP_REAL_AAVE_CALLBACK"),
            // Nonzero identity is a fork fixture, not authorized gas capital.
            sourceEvidenceHash: keccak256("RMC011_UNAUTHORIZED_PAYMASTER_FIXTURE")
        });
        p = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId: 1,
            validThroughBlock: WINNER_BLOCK,
            executionIdentityHash: keccak256(abi.encodePacked("RMC011_AAVE_POSTOP", payload)),
            fundingPlanHash: keccak256("RMC011_FORK_ONLY_FLASH_LIQUIDITY_NOT_AUTHORIZED"),
            anchorHash: keccak256("RMC011_PREBLOCK_TIME_ONLY_ORIGINAL"),
            canonicalGeneration: 1,
            asset: WETH,
            principalRequired: DEBT_WETH_WEI,
            minProfitAsset: 1,
            payloadHash: keccak256(payload),
            legs: legs
        });
    }

    function _modeledGasChargeWeth() internal pure returns (uint256) {
        // Measured previously: 562357 gas for bare T36 call. 200k is an
        // ASSUMED overhead, NOT an actual UserOperation receipt.
        uint256 assumedUnits = 562357 + 21000 + 200000;
        uint256 assumedPrice = 59_451_728 + 5_000_000_000;
        return assumedUnits * assumedPrice;
    }

    function testWethProfitReachesSmartAccountAndMockPostOpCollectsGasInSameFork() public {
        _timeOnly();
        bytes memory payload = hex"011101";
        uint256 fee = _flashFee();
        uint256 charge = _modeledGasChargeWeth();
        uint256 sponsorBefore =
            IERC20FlashMinimal(WETH).balanceOf(MOCK_SPONSOR_TREASURY);
        uint256 accountBefore =
            IERC20FlashMinimal(WETH).balanceOf(address(smartAccount));
        uint256 returned = facade.executeThenMockPostop(
            _plan(payload, fee), payload, charge, 1
        );
        require(returned == EXPECTED_SURPLUS_WEI, "ORIGINAL_FORK_WETH_SURPLUS_CHANGED");
        require(IERC20FlashMinimal(WETH).balanceOf(address(smartAccount)) ==
                accountBefore + returned - charge, "ACCOUNT_RECEIVED_WRONG_POSTOP_WETH");
        require(IERC20FlashMinimal(WETH).balanceOf(MOCK_SPONSOR_TREASURY) ==
                sponsorBefore + charge, "MOCK_POSTOP_COLLECTION_NOT_FROM_EARNED_WETH");
        require(IERC20FlashMinimal(WETH).balanceOf(address(flashExecutor)) == 0
                && IERC20FlashMinimal(WETH).balanceOf(address(strategy)) == 0,
                "STRATEGY_OR_EXECUTOR_RETAINS_WETH");
        emit log_named_uint("NQC_RMC011_FORK_OPERATOR_WETH_SURPLUS_WEI", returned);
        emit log_named_uint("NQC_RMC011_HYPOTHETICAL_GAS_WETH_COLLECTED_WEI", charge);
        emit log_named_uint("NQC_RMC011_FORK_ACCOUNT_WETH_AFTER_POSTOP_WEI", returned - charge);
        emit log_named_uint("NQC_RMC011_REAL_NATIVE_GAS_SPONSOR_AUTHORIZED", 0);
    }

    function testOversizedMockPostOpChargeRevertsWithoutLiquidationStateMutation() public {
        _timeOnly();
        uint256 hfBefore = _healthFactor();
        uint256 beforeAccount =
            IERC20FlashMinimal(WETH).balanceOf(address(smartAccount));
        uint256 beforeTreasury =
            IERC20FlashMinimal(WETH).balanceOf(MOCK_SPONSOR_TREASURY);
        bytes memory payload = hex"011102";
        NqcFlashFundingExecutor.FlashExecutionPlan memory p = _plan(payload, _flashFee());
        // An actually unaffordable gas collection MUST NOT become negative
        // WETH profit or use pre-existing operator funds.
        (bool ok,) = address(facade).call(
            abi.encodeWithSelector(
                facade.executeThenMockPostop.selector,
                p, payload, EXPECTED_SURPLUS_WEI + 1, uint256(0))
        );
        require(!ok, "MOCK_PAYMASTER_OVERCHARGE_ACCEPTED");
        require(_healthFactor() == hfBefore, "FAILED_POSTOP_MUTATED_BORROWER");
        require(IERC20FlashMinimal(WETH).balanceOf(address(smartAccount)) ==
                beforeAccount, "ACCOUNT_WETH_DRIFT_ON_FAILED_POSTOP");
        require(IERC20FlashMinimal(WETH).balanceOf(MOCK_SPONSOR_TREASURY) ==
                beforeTreasury, "SPONSOR_FAKE_PROCEEDS_ON_FAILED_POSTOP");
        require(!flashExecutor.consumedExecutionIdentity(p.executionIdentityHash),
                "FAILED_FACADE_TRANSACTION_CONSUMED_FLASH_EXECUTION");
    }

    function testNoUnprivilegedOperatorExecutionOrPaymasterTokenCollection() public {
        _timeOnly();
        bytes memory payload = hex"011103";
        NqcFlashFundingExecutor.FlashExecutionPlan memory p = _plan(payload, _flashFee());
        (bool ok,) = address(smartAccount).call(
            abi.encodeWithSelector(
                smartAccount.executeAndApprove.selector, p, payload, uint256(1), uint256(1))
        );
        require(!ok, "UNPRIVILEGED_OPERATOR_ABILITY");
        (ok,) = address(mockCollector).call(
            abi.encodeWithSelector(
                mockCollector.pullFromAccount.selector, address(smartAccount), uint256(1))
        );
        require(!ok, "UNPRIVILEGED_WETH_PULL_ABILITY");
        require(!flashExecutor.consumedExecutionIdentity(p.executionIdentityHash),
                "UNAUTHORIZED_CALL_STOLE_EXECUTION_IDENTITY");
    }
}
