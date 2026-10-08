// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor, IERC20FlashMinimal} from "../src/NqcFlashFundingExecutor.sol";
import {NqcRmc016WethActualLiquidationStrategy} from "./NqcRmc016RankOneSelfFinancingFork.t.sol";

/// @notice Original ERC-4337 v0.7 packed EntryPoint ABI, not a local mock.
struct NqcPackedUserOperation {
    address sender;
    uint256 nonce;
    bytes initCode;
    bytes callData;
    bytes32 accountGasLimits;
    uint256 preVerificationGas;
    bytes32 gasFees;
    bytes paymasterAndData;
    bytes signature;
}

interface INqcEntryPointV07 {
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function getUserOpHash(NqcPackedUserOperation calldata op) external view returns (bytes32);
    function balanceOf(address account) external view returns (uint256);
    function depositTo(address account) external payable;
    function handleOps(NqcPackedUserOperation[] calldata ops, address payable beneficiary)
        external;
}

interface INqcRmc011Weth {
    function balanceOf(address a) external view returns (uint256);
    function allowance(address a, address b) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transferFrom(address sender, address to, uint256 amount) external returns (bool);
}

interface INqcRmc011Health {
    function getUserAccountData(address borrower)
        external
        view
        returns (uint256, uint256, uint256, uint256, uint256, uint256);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
}

interface VmNqcRealEntryPointFork {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest)
        external
        returns (uint8 v, bytes32 r, bytes32 s);
    function deal(address who, uint256 newBalance) external;
    function warp(uint256 timestamp) external;
    function roll(uint256 number) external;
    function fee(uint256 baseFee) external;
    function txGasPrice(uint256 newGasPrice) external;
    function prank(address msgSender, address txOrigin) external;
}

/// @notice Minimal test-owned ERC-4337 v0.7 IAccount wired to original T36.
///         Signed by a documented fixed TEST key only in a local fork.
///         Not an audited production smart account, factory or signer.
contract NqcRmc011V07TestAccount {
    address public immutable entryPoint;
    address public immutable signer;
    address public immutable paymaster;
    address public immutable weth;
    address public immutable fixture;
    NqcFlashFundingExecutor public immutable executor;

    constructor(
        address entryPoint_, address signer_, address paymaster_,
        address weth_, address fixture_, address strategy_
    ) {
        require(entryPoint_ != address(0) && signer_ != address(0)
            && paymaster_ != address(0) && weth_ != address(0), "BAD_ACCOUNT");
        entryPoint = entryPoint_;
        signer = signer_;
        paymaster = paymaster_;
        weth = weth_;
        fixture = fixture_;
        executor = new NqcFlashFundingExecutor(address(this), strategy_);
    }

    function validateUserOp(
        NqcPackedUserOperation calldata op,
        bytes32 opHash,
        uint256 missingAccountFunds
    ) external view returns (uint256 validationData) {
        require(msg.sender == entryPoint && op.sender == address(this),
                "FORGED_ENTRYPOINT_ACCOUNT");
        require(missingAccountFunds == 0, "USEROP_TRIES_TO_SPEND_OWN_ETH");
        if (op.signature.length != 65) return 1;
        bytes32 r;
        bytes32 s;
        uint8 v;
        bytes calldata sig = op.signature;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (ecrecover(opHash, v, r, s) != signer) return 1;
        return 0;
    }

    function executeLiquidation(
        NqcFlashFundingExecutor.FlashExecutionPlan calldata plan,
        bytes calldata payload,
        uint256 maximumWethCharge
    ) external returns (uint256 surplus) {
        require(msg.sender == entryPoint, "NOT_REAL_ENTRYPOINT");
        require(maximumWethCharge > 0, "NO_FEE_CEILING");
        require(INqcRmc011Weth(weth).balanceOf(address(this)) == 0,
                "ACCOUNT_CANNOT_SUBSIDIZE_THIS_TEST");
        surplus = executor.execute(plan, payload);
        require(surplus >= maximumWethCharge && surplus > 0,
                "INSUFFICIENT_FRESH_WETH_TO_PAY_SPONSOR");
        require(INqcRmc011Weth(weth).balanceOf(address(this)) == surplus,
                "REAL_T36_SWEEP_NOT_IN_USEROP_SENDER");
        require(INqcRmc011Weth(weth).approve(paymaster, maximumWethCharge),
                "WETH_APPROVAL_FAILED");
    }

    function clearPaymasterAllowance() external {
        require(msg.sender == paymaster, "NOT_CONFIGURED_PAYMASTER");
        require(INqcRmc011Weth(weth).approve(paymaster, 0), "WETH_REVOKE_FAILED");
    }
}

/// @notice ERC-4337 v0.7 IPaymaster test fixture. Deposit is minted via
///         Foundry vm.deal and sent to REAL deployed EntryPoint.depositTo.
///         NOT a real independent financial provider nor approved sponsorship.
contract NqcRmc011V07TestPaymaster {
    address public immutable entryPoint;
    address public immutable weth;
    address public immutable treasury;
    address public immutable fixture;
    address public allowedAccount;
    uint16 public serviceFeeBps;
    // A single signed provider quote would be required in production. This is
    // only a TEST-ONLY immutable-before-operation gas overhead sensitivity.
    bool public overheadQuoteSet;
    uint256 public quotedPostopOverheadWei;
    uint256 public collectedWeth;
    uint256 public lastActualGasCostWei;
    uint256 public revertedOperationGasLossWei;
    uint8 public lastMode;
    uint256 public postOpCount;

    constructor(address entryPoint_, address weth_, address treasury_,
                address fixture_, uint16 feeBps_) {
        require(entryPoint_ != address(0) && weth_ != address(0) &&
                treasury_ != address(0) && fixture_ != address(0) &&
                feeBps_ <= 10_000, "BAD_PAYMASTER_FIXTURE");
        entryPoint = entryPoint_;
        weth = weth_;
        treasury = treasury_;
        fixture = fixture_;
        serviceFeeBps = feeBps_;
    }

    function setAuthorizedAccount(address account_) external {
        require(msg.sender == fixture && allowedAccount == address(0) &&
                account_ != address(0), "TEST_ACCOUNT_BOUND_ONCE");
        allowedAccount = account_;
    }

    function configureTestPostopOverheadQuote(uint256 quoteWei) external {
        require(msg.sender == fixture && !overheadQuoteSet && postOpCount == 0,
                "OVERHEAD_QUOTE_CANNOT_CHANGE");
        require(quoteWei > 0 && quoteWei <= 0.005 ether,
                "TEST_OVERHEAD_QUOTE_OUT_OF_RANGE");
        quotedPostopOverheadWei = quoteWei;
        overheadQuoteSet = true;
    }

    function depositFixtureEth() external payable {
        require(msg.sender == fixture && msg.value > 0, "TEST_ONLY_EXTERNAL_ETH");
        INqcEntryPointV07(entryPoint).depositTo{value: msg.value}(address(this));
    }

    function validatePaymasterUserOp(
        NqcPackedUserOperation calldata op,
        bytes32,
        uint256 maxCost
    ) external view returns (bytes memory context, uint256 validationData) {
        require(msg.sender == entryPoint && op.sender == allowedAccount,
                "UNAUTHORIZED_V07_SPONSOR");
        require(maxCost > 0 && maxCost <= 0.05 ether, "GAS_QUOTE_CAP_BREACH");
        // PostOp will charge actual gas (including validation and execution),
        // with the modeled 8% TEST ONLY surcharge.
        context = abi.encode(op.sender, maxCost);
        return (context, 0);
    }

    function postOp(
        uint8 mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external {
        require(msg.sender == entryPoint, "NOT_REAL_ENTRYPOINT_POSTOP");
        (address sender, uint256 maxCost) = abi.decode(context, (address, uint256));
        require(sender == allowedAccount && actualUserOpFeePerGas > 0,
                "POSTOP_SENDER_OR_GAS_DRIFT");
        require(actualGasCost <= maxCost, "POSTOP_PAST_MAX_COST");
        lastMode = mode;
        lastActualGasCostWei = actualGasCost;
        postOpCount++;
        if (mode == 0) {
            uint256 costWithServiceFee =
                (actualGasCost * (10_000 + serviceFeeBps) + 9_999) / 10_000
                + quotedPostopOverheadWei;
            require(INqcRmc011Weth(weth).transferFrom(
                sender, treasury, costWithServiceFee), "POSTOP_REAL_ERC20_COLLECTION_FAILED");
            NqcRmc011V07TestAccount(sender).clearPaymasterAllowance();
            collectedWeth += costWithServiceFee;
        } else {
            // No freshly earned WETH exists on revert. The third-party
            // deposit STILL loses native ETH for the failed UserOperation.
            revertedOperationGasLossWei += actualGasCost;
        }
    }
}

/// @notice REAL Ethereum v0.7 EntryPoint.handleOps and real Aave flash+liquidation,
/// using TEST-funded paymaster ETH deposit and TEST-only account/paymaster.
/// No provider is authorized; no NQC real gas funding/profit is claimed.
contract NqcRmc011RealEntryPointV07ForkTest {
    VmNqcRealEntryPointFork internal constant vm =
        VmNqcRealEntryPointFork(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant ENTRYPOINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address internal constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    address internal constant MOCK_TREASURY = address(uint160(0xBA5E));
    address internal constant MOCK_BENEFICIARY = address(uint160(0xBEEF));
    address internal constant MOCK_BUNDLER = address(uint160(0xAABBCC));
    uint256 internal constant PREVIOUS_BLOCK = 25938047;
    uint256 internal constant WINNER_BLOCK = 25938048;
    uint256 internal constant PRINCIPAL = 10_684_013_854_557_827_871;
    uint256 internal constant ORIGINAL_FORK_SURPLUS = 90_814_117_763_741_536;
    uint256 internal constant PREVIOUS_HF = 1_000_000_001_993_818_630;
    uint256 internal constant WINNER_TIME_ONLY_HF = 999_999_999_704_293_538;
    uint256 internal constant TEST_SIGNER_KEY = 0xA11CE01234;
    uint256 internal constant TEST_SPONSOR_DEPOSIT = 0.02 ether;
    uint256 internal constant TEST_MAX_WETH_GAS_CHARGE = 0.02 ether;

    NqcRmc011V07TestAccount internal account;
    NqcRmc011V07TestPaymaster internal paymaster;
    NqcRmc016WethActualLiquidationStrategy internal strategy;
    address internal borrower;
    uint256 internal winnerTime;

    event log_named_uint(string name, uint256 value);

    function setUp() public {
        require(block.chainid == 1 && block.number == PREVIOUS_BLOCK,
                "NOT_SOURCE_PREDECESSOR");
        require(ENTRYPOINT.code.length > 1000, "REAL_ENTRYPOINT_V07_NOT_DEPLOYED");
        borrower = vm.envAddress("NQC_RMC016_RANK1_BORROWER");
        winnerTime = vm.envUint("NQC_RMC016_RANK1_WINNER_TIMESTAMP");
        require(block.timestamp == vm.envUint("NQC_RMC016_RANK1_PREVIOUS_TIMESTAMP")
                && winnerTime > block.timestamp, "CLOCK_SOURCE_IDENTITY_MISMATCH");
        strategy = new NqcRmc016WethActualLiquidationStrategy(WETH, POOL, borrower);
        paymaster = new NqcRmc011V07TestPaymaster(
            ENTRYPOINT, WETH, MOCK_TREASURY, address(this), 800);
        account = new NqcRmc011V07TestAccount(
            ENTRYPOINT, vm.addr(TEST_SIGNER_KEY), address(paymaster),
            WETH, address(this), address(strategy));
        paymaster.setAuthorizedAccount(address(account));
        strategy.setExecutor(address(account.executor()));

        require(address(account).balance == 0, "ACCOUNT_HAS_NATIVE_OWN_CAPITAL");
        require(INqcRmc011Weth(WETH).balanceOf(address(account)) == 0 &&
                INqcRmc011Weth(WETH).balanceOf(address(paymaster)) == 0 &&
                INqcRmc011Weth(WETH).balanceOf(address(strategy)) == 0,
                "UNEXPECTED_TEST_PREFUNDED_TOKEN_INVENTORY");
        require(INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster)) == 0,
                "PAYMASTER_ALREADY_FUNDED_BY_OTHER_PROVIDER");
    }

    function _hf() internal view returns (uint256 h) {
        (,,,,, h) = INqcRmc011Health(POOL).getUserAccountData(borrower);
    }

    function _timeOnly() internal {
        require(_hf() == PREVIOUS_HF, "PREVIOUS_TWO_RPC_HF_DRIFT");
        vm.roll(WINNER_BLOCK);
        vm.warp(winnerTime);
        vm.fee(59_451_728); // Previously authenticated winning-block basefee.
        vm.txGasPrice(2_059_451_728); // 2 gwei hypothetical priority tip.
        require(_hf() == WINNER_TIME_ONLY_HF, "TIME_ONLY_HF_DRIFT");
    }

    function _testFundDepositFromMintedThirdPartyEth() internal {
        // This is explicitly a TEST-MINTED "sponsor" and NOT NQC capital.
        vm.deal(address(this), TEST_SPONSOR_DEPOSIT);
        paymaster.depositFixtureEth{value: TEST_SPONSOR_DEPOSIT}();
        require(INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster)) ==
                TEST_SPONSOR_DEPOSIT, "REAL_ENTRYPOINT_DEPOSIT_MISMATCH");
    }

    function _plan(bytes memory payload, uint256 minProfit)
        internal pure returns (NqcFlashFundingExecutor.FlashExecutionPlan memory p)
    {
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1, lender: POOL, principal: PRINCIPAL,
            expectedFee: (PRINCIPAL * 5 + 5000) / 10000,
            callbackSemanticsHash: keccak256("T36_CANONICAL_REAL_AAVE_CALLBACK"),
            sourceEvidenceHash: keccak256("TEST_ONLY_ENTRYPOINT_NATIVE_DEPOSIT_NOT_APPROVED")
        });
        p = NqcFlashFundingExecutor.FlashExecutionPlan({
            chainId:1, validThroughBlock:WINNER_BLOCK,
            executionIdentityHash:keccak256(abi.encodePacked("RMC011_V07_FORK",payload)),
            fundingPlanHash:keccak256(abi.encodePacked("RMC011_UNAUTHORIZED_FLASH_SOURCE",payload)),
            anchorHash:keccak256("RMC011_SOURCE_PREBLOCK_CLOCK_ONLY"),
            canonicalGeneration:1, asset:WETH,
            principalRequired:PRINCIPAL, minProfitAsset:minProfit,
            payloadHash:keccak256(payload),legs:legs
        });
    }

    function _op(bytes memory payload, uint256 minProfit, bool badSignature)
        internal
        returns (NqcPackedUserOperation memory op)
    {
        bytes memory executable = abi.encodeCall(
            NqcRmc011V07TestAccount.executeLiquidation,
            (_plan(payload,minProfit),payload,TEST_MAX_WETH_GAS_CHARGE)
        );
        op = NqcPackedUserOperation({
            sender:address(account),
            nonce:INqcEntryPointV07(ENTRYPOINT).getNonce(address(account),0),
            initCode:new bytes(0),
            callData:executable,
            accountGasLimits:bytes32((uint256(300_000)<<128)|uint256(2_000_000)),
            preVerificationGas:150_000,
            gasFees:bytes32((uint256(2_000_000_000)<<128)|uint256(5_000_000_000)),
            paymasterAndData:abi.encodePacked(
                address(paymaster),uint128(300_000),uint128(400_000)
            ),
            signature:new bytes(0)
        });
        bytes32 userHash = INqcEntryPointV07(ENTRYPOINT).getUserOpHash(op);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            badSignature ? uint256(0xBADDD) : TEST_SIGNER_KEY, userHash);
        op.signature = abi.encodePacked(r,s,v);
    }

    function _executeUserOperation(NqcPackedUserOperation memory op) internal {
        NqcPackedUserOperation[] memory ops = new NqcPackedUserOperation[](1);
        ops[0] = op;
        // A test-only bundler pays the top-level transaction fee; it is
        // NOT an authorized external NQC gas source or a real signed op.
        vm.deal(MOCK_BUNDLER, 0.05 ether);
        vm.prank(MOCK_BUNDLER, MOCK_BUNDLER);
        INqcEntryPointV07(ENTRYPOINT).handleOps(ops,payable(MOCK_BENEFICIARY));
    }

    function testRealHistoricalEntryPointV07CodePresentWithoutSponsor() public view {
        require(ENTRYPOINT.code.length > 1000,"NOT_REAL_ENTRYPOINT");
        require(INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster)) == 0,
                "PROVIDER_SHOULD_NOT_BE_FUNDED_YET");
        require(address(account).balance == 0,"ACCOUNT_EOA_PREFUND_NOT_ZERO");
    }

    function testRealHandleOpsChargesActualTestPaymasterDepositAndCollectsWeth() public {
        _timeOnly();
        _testFundDepositFromMintedThirdPartyEth();

        uint256 beforeDeposit = INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        uint256 beforeTreasury = INqcRmc011Weth(WETH).balanceOf(MOCK_TREASURY);
        uint256 beforeBeneficiary = MOCK_BENEFICIARY.balance;
        bytes memory payload = hex"433701";
        _executeUserOperation(_op(payload,1,false));

        uint256 afterDeposit = INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        uint256 nativeSpentByTestSponsor = beforeDeposit-afterDeposit;
        uint256 collectedWeth = INqcRmc011Weth(WETH).balanceOf(MOCK_TREASURY)-beforeTreasury;
        uint256 remainingWeth = INqcRmc011Weth(WETH).balanceOf(address(account));
        require(nativeSpentByTestSponsor > 0 &&
                nativeSpentByTestSponsor < TEST_SPONSOR_DEPOSIT,
                "REAL_ENTRYPOINT_NOT_CHARGED_TO_PAYMASTER");
        require(MOCK_BENEFICIARY.balance > beforeBeneficiary,
                "REAL_BUNDLER_BENEFICIARY_WAS_NOT_PAID_ETH");
        require(collectedWeth > 0 && collectedWeth < TEST_MAX_WETH_GAS_CHARGE,
                "NO_BOUNDED_POSTOP_WETH_COLLECTION");
        // Genuine v0.7 EntryPoint also pays for postOp and other overhead
        // AFTER actualGasCost is passed into the paymaster. Here the 8%
        // TEST fee demonstrably UNDER-recovers all EntryPoint native gas.
        // Preserve that economically negative sponsor outcome. Never raise
        // the fee or synthesize profit merely to make this test pass.
        require(collectedWeth < nativeSpentByTestSponsor,
                "HISTORICAL_8PCT_TEST_SPONSOR_UNDERRECOVERY_CHANGED");
        require(collectedWeth == paymaster.collectedWeth() && paymaster.lastMode() == 0,
                "REAL_POSTOP_NOT_CALLED");
        uint256 postOpInputGasCost = paymaster.lastActualGasCostWei();
        require(paymaster.postOpCount() == 1 && postOpInputGasCost > 0,
                "REAL_PAYMASTER_ACCOUNTING_NOT_EXECUTED");
        // Actual EntryPoint charge is larger than the fee basis passed
        // into postOp. The paymaster does NOT receive its final total
        // gas debit as the postOp actualGasCost input.
        require(postOpInputGasCost < nativeSpentByTestSponsor &&
                collectedWeth == (postOpInputGasCost * 10_800 + 9_999) / 10_000,
                "REAL_ENTRYPOINT_POSTOP_BILLING_BASIS_DRIFT");
        require(collectedWeth + remainingWeth == ORIGINAL_FORK_SURPLUS,
                "REAL_ENTRYPOINT_WETH_PROFIT_CONSERVATION_BROKEN");
        require(INqcRmc011Weth(WETH).allowance(address(account),address(paymaster)) == 0,
                "POSTOP_ALLOWANCE_NOT_REVOKED");
        require(address(account).balance == 0 &&
                INqcRmc011Weth(WETH).balanceOf(address(strategy)) == 0 &&
                INqcRmc011Weth(WETH).balanceOf(address(account.executor())) == 0,
                "OPERATOR_BALANCE_FUNDING_OR_ROUTING_DRIFT");
        emit log_named_uint("NQC_V07_REAL_ENTRYPOINT_SPONSOR_TEST_DEPOSIT_SPENT_WEI",
                            nativeSpentByTestSponsor);
        emit log_named_uint("NQC_V07_REAL_ENTRYPOINT_POSTOP_COLLECTED_WETH_WEI",
                            collectedWeth);
        emit log_named_uint("NQC_V07_TEST_SPONSOR_UNRECOVERED_ETH_PAR_WEI",
                            nativeSpentByTestSponsor - collectedWeth);
        emit log_named_uint("NQC_V07_POSTOP_INPUT_ACTUAL_GAS_COST_WEI",postOpInputGasCost);
        emit log_named_uint("NQC_V07_FULL_DEPOSIT_CHARGE_BEYOND_POSTOP_INPUT_WEI",
                            nativeSpentByTestSponsor - postOpInputGasCost);
        emit log_named_uint("NQC_V07_TEST_SPONSOR_8PCT_FULL_GAS_RECOVERY_PROVEN",0);
        emit log_named_uint("NQC_V07_REAL_ENTRYPOINT_ACCOUNT_WETH_REMAINING_WEI",
                            remainingWeth);
        emit log_named_uint("NQC_V07_REAL_PROVIDER_GAS_AUTHORIZED",0);
    }

    function testPrequotedTestPostOpOverheadCoversOneSuccessfulSponsorDepositCharge() public {
        _timeOnly();
        // TEST sensitivity only, not a real provider quote and not a promise
        // that this amount covers future gas regimes or reverted attempts.
        uint256 quote = 700_000_000_000_000; // 0.0007 WETH at ETH/WETH par.
        paymaster.configureTestPostopOverheadQuote(quote);
        _testFundDepositFromMintedThirdPartyEth();
        uint256 beforeDeposit=INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        _executeUserOperation(_op(hex"433705",1,false));
        uint256 afterDeposit=INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        uint256 nativeGas=beforeDeposit-afterDeposit;
        uint256 collected=paymaster.collectedWeth();
        require(nativeGas > 0 && collected >= nativeGas,
                "PREQUOTED_TEST_OVERHEAD_FAILED_TO_COVER_GAS");
        require(collected + INqcRmc011Weth(WETH).balanceOf(address(account)) ==
                ORIGINAL_FORK_SURPLUS,"WETH_ACCOUNTING_WITH_QUOTE_CHANGED");
        require(paymaster.postOpCount() == 1 && paymaster.lastMode() == 0,
                "REAL_ENTRYPOINT_POSTOP_NOT_EXECUTED");
        require(INqcRmc011Weth(WETH).allowance(address(account),address(paymaster)) == 0,
                "TEST_PAYMASTER_ALLOWANCE_DID_NOT_CLEAR");
        emit log_named_uint("NQC_V07_TEST_QUOTED_POSTOP_RESERVE_WEI",quote);
        emit log_named_uint("NQC_V07_TEST_QUOTED_SUCCESS_SPONSOR_NATIVE_GAS_DEBIT_WEI",nativeGas);
        emit log_named_uint("NQC_V07_TEST_QUOTED_SUCCESS_WETH_COLLECTED_WEI",collected);
        emit log_named_uint("NQC_V07_TEST_QUOTED_SUCCESS_COVERAGE_WEI",collected-nativeGas);
        emit log_named_uint("NQC_V07_TEST_QUOTED_SUCCESS_PRODUCTION_SPONSOR_PROVEN",0);
    }

    function testUnfundedRealEntryPointPaymasterCannotExecuteLiquidation() public {
        _timeOnly();
        bytes memory payload = hex"433702";
        NqcPackedUserOperation memory operation = _op(payload,1,false);
        NqcPackedUserOperation[] memory ops = new NqcPackedUserOperation[](1);
        ops[0] = operation;
        uint256 hfBefore = _hf();
        (bool ok,) = ENTRYPOINT.call(abi.encodeWithSelector(
            INqcEntryPointV07.handleOps.selector,ops,payable(MOCK_BENEFICIARY)));
        require(!ok, "REAL_ENTRYPOINT_ACCEPTED_UNFUNDED_GAS");
        require(_hf() == hfBefore,"UNFUNDED_ATTEMPT_MUTATED_REAL_BORROWER");
        require(INqcRmc011Weth(WETH).balanceOf(address(account)) == 0,
                "UNFUNDED_ATTEMPT_CREATED_WETH");
    }

    function testFakeSignatureRejectedByRealEntryPointValidation() public {
        _timeOnly();
        _testFundDepositFromMintedThirdPartyEth();
        uint256 beforeDeposit = INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        NqcPackedUserOperation memory operation = _op(hex"433703",1,true);
        NqcPackedUserOperation[] memory ops = new NqcPackedUserOperation[](1);
        ops[0] = operation;
        (bool ok,) = ENTRYPOINT.call(abi.encodeWithSelector(
            INqcEntryPointV07.handleOps.selector,ops,payable(MOCK_BENEFICIARY)));
        require(!ok,"FAKE_SIGNED_USEROP_APPROVED");
        require(INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster)) ==
                beforeDeposit,"FAILED_SIGNATURE_CHARGED_DEPOSIT_IN_REVERTED_BUNDLE");
        require(INqcRmc011Weth(WETH).balanceOf(address(account)) == 0,
                "FAKE_SIGNED_USEROP_CREATED_WETH");
    }

    function testRevertingUserOperationStillChargesThirdPartyNativeDeposit() public {
        _timeOnly();
        _testFundDepositFromMintedThirdPartyEth();
        uint256 beforeDeposit = INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        uint256 borrowerBefore = _hf();
        _executeUserOperation(_op(hex"433704",type(uint96).max,false));
        uint256 afterDeposit = INqcEntryPointV07(ENTRYPOINT).balanceOf(address(paymaster));
        require(afterDeposit < beforeDeposit,
                "REVERTED_OPERATION_WAS_FREE_TO_GAS_SPONSOR");
        require(paymaster.lastMode() == 1 && paymaster.postOpCount() == 1,
                "REAL_ENTRYPOINT_DID_NOT_CALL_REVERT_POSTOP");
        require(paymaster.revertedOperationGasLossWei() > 0 &&
                paymaster.collectedWeth() == 0,
                "REVERTED_OPERATION_DID_NOT_IMPOSE_SPONSOR_NATIVE_LOSS");
        require(_hf() == borrowerBefore, "FAILED_USEROP_MUTATED_BORROWER");
        require(INqcRmc011Weth(WETH).balanceOf(address(account)) == 0,
                "REVERTED_USEROP_MINTED_ACCOUNT_WETH");
        emit log_named_uint("NQC_V07_REVERTED_USEROP_SPONSOR_ETH_DEPOSIT_LOSS_WEI",
                            beforeDeposit-afterDeposit);
        emit log_named_uint("NQC_V07_REVERTED_USEROP_WETH_REIMBURSEMENT_WEI",0);
    }
}
