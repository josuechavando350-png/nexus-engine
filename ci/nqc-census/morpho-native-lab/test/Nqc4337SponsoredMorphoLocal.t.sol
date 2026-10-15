// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// NQC SECURITY-SCOPED RESEARCH ONLY.
// This models essential EIP-4337 accounting/authorization semantics locally;
// it is NOT the actual eth-infinitism EntryPoint, bundler, Alchemy or ZeroDev.
// The liquidation below uses AUTHENTIC pinned Morpho.sol, but local test-only
// collateral, oracle, DEX pricing, gas funds and sponsorship policy.
// NO MAINNET EXECUTION OR GAS UNDERWRITING IS CERTIFIED.
import {Morpho} from "../lib/morpho-blue/src/Morpho.sol";
import {MarketParams, Id} from "../lib/morpho-blue/src/interfaces/IMorpho.sol";
import {MarketParamsLib} from "../lib/morpho-blue/src/libraries/MarketParamsLib.sol";
import {NqcMorphoNativeCallbackLab, NqcMarketParams} from "../src/NqcMorphoNativeCallbackLab.sol";
import {LocalToken, LocalOracle, LocalDex, LocalBorrower} from "./NqcMorphoNativeCallbackLab.t.sol";

interface VmNqcLocal {
    function deal(address who, uint256 newBalance) external;
}

// Intent preapproval and an immutable EntryPoint are TEST STAND-INS for the
// deployed smart account's signature verification and nonce management.
contract Nqc4337IntentAccountLocal {
    address public immutable entryPoint;
    address public immutable owner;
    mapping(bytes32 => bool) public approved;
    error OnlyOwner();
    error OnlyEntryPoint();
    error InvalidOrConsumedIntent();
    constructor(address point, address accountOwner) {
        require(point != address(0) && accountOwner != address(0), "BAD_ACCOUNT");
        entryPoint = point;
        owner = accountOwner;
    }
    function authorizeIntent(bytes32 digest) external {
        if (msg.sender != owner) revert OnlyOwner();
        approved[digest] = true;
    }
    function validateIntent(bytes32 digest, address target, bytes calldata payload) external {
        if (msg.sender != entryPoint) revert OnlyEntryPoint();
        bytes32 expected = keccak256(abi.encode(
            block.chainid, address(this), target, keccak256(payload)
        ));
        if (digest != expected || !approved[digest]) revert InvalidOrConsumedIntent();
        approved[digest] = false;
    }
    function executeFromEntryPoint(address target, bytes calldata payload)
        external returns (bytes memory result)
    {
        if (msg.sender != entryPoint) revert OnlyEntryPoint();
        (bool ok, bytes memory ret) = target.call(payload);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }
}

contract Nqc4337GasSponsorVaultLocal {
    address public immutable entryPoint;
    address public immutable authorizedAccount;
    address public immutable authorizedExecutor;
    uint256 public immutable maxFeePerOperation;
    error WrongBillingCaller();
    error SponsorshipNotAllowed();
    error EmptySponsorDeposit();
    constructor(
        address point, address account, address executor, uint256 cap
    ) {
        require(point != address(0) && account != address(0) && executor != address(0));
        require(cap > 0, "ZERO_FEE_CAP");
        entryPoint = point;
        authorizedAccount = account;
        authorizedExecutor = executor;
        maxFeePerOperation = cap;
    }
    receive() external payable {}
    function allows(address account, address executor, uint256 feeWei)
        external view returns (bool)
    {
        return account == authorizedAccount && executor == authorizedExecutor
            && feeWei > 0 && feeWei <= maxFeePerOperation
            && address(this).balance >= feeWei;
    }
    function settle(address payable beneficiary, uint256 costWei) external {
        if (msg.sender != entryPoint) revert WrongBillingCaller();
        if (costWei == 0 || costWei > maxFeePerOperation) revert SponsorshipNotAllowed();
        if (address(this).balance < costWei) revert EmptySponsorDeposit();
        (bool ok,) = beneficiary.call{value: costWei}("");
        require(ok, "SPONSOR_FEE_TRANSFER");
    }
}

// Semantic model only: this is NOT compliant with the EIP-4337
// PackedUserOperation or EntryPoint v0.7 gas-metering, stake and nonce rules.
// It models that the sponsor is billed even when the ACCOUNT EXECUTION reverts.
// Fixed gasCostWei comes from local test input, not any gas quote.
contract Nqc4337EntryPointAccountingModel {
    address public immutable owner;
    Nqc4337GasSponsorVaultLocal public sponsor;
    address payable public immutable beneficiary;
    event ModeledUserOp(bool success, bytes32 indexed digest, uint256 sponsorFee);
    constructor(address payable payTo) {
        owner = msg.sender;
        beneficiary = payTo;
    }
    function configureSponsor(Nqc4337GasSponsorVaultLocal vault) external {
        require(msg.sender == owner && address(sponsor) == address(0), "SPONSOR_LOCKED");
        sponsor = vault;
    }
    function submitModeledUserOp(
        Nqc4337IntentAccountLocal account,
        address executor,
        bytes calldata payload,
        bytes32 digest,
        uint256 modeledFeeWei
    ) external returns (bool success, bytes memory executionResult) {
        require(address(sponsor) != address(0), "NO_SPONSOR");
        require(sponsor.allows(address(account), executor, modeledFeeWei),
            "POLICY_OR_SPONSOR_FUNDS");
        account.validateIntent(digest, executor, payload);
        (success, executionResult) = address(account).call(
            abi.encodeCall(Nqc4337IntentAccountLocal.executeFromEntryPoint, (executor, payload))
        );
        // A failure in application execution is NOT a free transaction.
        sponsor.settle(beneficiary, modeledFeeWei);
        emit ModeledUserOp(success, digest, modeledFeeWei);
    }
}

contract Nqc4337SponsoredMorphoLocalTest {
    using MarketParamsLib for MarketParams;
    VmNqcLocal private constant vm = VmNqcLocal(address(uint160(
        uint256(keccak256("hevm cheat code"))
    )));
    LocalToken private usdc;
    LocalToken private cbxrp;
    LocalOracle private oracle;
    LocalDex private dex;
    LocalBorrower private borrower;
    Morpho private morpho;
    NqcMorphoNativeCallbackLab private executor;
    Nqc4337IntentAccountLocal private smartAccount;
    Nqc4337GasSponsorVaultLocal private sponsor;
    Nqc4337EntryPointAccountingModel private entryPoint;
    MarketParams private market;
    NqcMarketParams private nqc;
    address payable private constant BENEFICIARY = payable(address(0xBEEF));
    uint256 private constant SPONSOR_FUND = 1e16;  // TEST LOCAL: 0.01 synthetic ETH
    uint256 private constant MODELED_GAS_FEE = 5e13; // TEST LOCAL: 0.00005 synthetic ETH
    uint256 private constant MIN_PROFIT = 50e6;
    uint256 private constant SEIZED = 500e6;
    uint256 private constant MAX_REPAY = 600e6;
    uint256 private constant MIN_SWAP_OUT = 490e6;

    function setUp() public {
        usdc = new LocalToken();
        cbxrp = new LocalToken();
        oracle = new LocalOracle(13 * 10 ** 35);  // synthetic 1.3 loan / collateral
        morpho = new Morpho(address(this));      // authentic Morpho upstream
        morpho.enableIrm(address(0));
        morpho.enableLltv(625 * 10 ** 15);
        market = MarketParams({
            loanToken: address(usdc),
            collateralToken: address(cbxrp),
            oracle: address(oracle),
            irm: address(0),
            lltv: 625 * 10 ** 15
        });
        morpho.createMarket(market);
        usdc.mint(address(this), 100_000e6);
        usdc.approve(address(morpho), 100_000e6);
        morpho.supply(market, 100_000e6, 0, address(this), "");
        borrower = new LocalBorrower();
        cbxrp.mint(address(borrower), 1000e6);
        borrower.open(morpho, market, cbxrp, 1000e6, 700e6);
        dex = new LocalDex(usdc, cbxrp);
        usdc.mint(address(dex), 100_000e6);
        nqc = NqcMarketParams({
            loanToken: address(usdc), collateralToken: address(cbxrp),
            oracle: address(oracle), irm: address(0), lltv: 625 * 10 ** 15
        });
        entryPoint = new Nqc4337EntryPointAccountingModel(BENEFICIARY);
        smartAccount = new Nqc4337IntentAccountLocal(address(entryPoint), address(this));
        executor = new NqcMorphoNativeCallbackLab(
            address(morpho), address(dex), address(smartAccount), nqc
        );
        sponsor = new Nqc4337GasSponsorVaultLocal(
            address(entryPoint), address(smartAccount), address(executor),
            2 * MODELED_GAS_FEE
        );
        entryPoint.configureSponsor(sponsor);
        // Cheatcode creates TEST-ONLY native balance; no public ETH or sponsor exists.
        vm.deal(address(this), SPONSOR_FUND);
        (bool ok,) = address(sponsor).call{value: SPONSOR_FUND}("");
        require(ok, "TEST_SPONSOR_FUNDING_FAILED");
        oracle.setPrice(1e36); // synthetic shock makes borrower unhealthy
    }

    function _payload(bytes32 executionId) internal view returns (bytes memory) {
        return abi.encodeCall(
            NqcMorphoNativeCallbackLab.execute,
            (nqc, address(borrower), SEIZED, MAX_REPAY, MIN_PROFIT, MIN_SWAP_OUT,
             block.number, executionId)
        );
    }
    function _digest(bytes memory payload) internal view returns (bytes32) {
        return keccak256(abi.encode(
            block.chainid, address(smartAccount), address(executor), keccak256(payload)
        ));
    }
    function _submit(bytes memory payload, uint256 fee)
        internal returns (bool, bytes memory)
    {
        bytes32 digest = _digest(payload);
        smartAccount.authorizeIntent(digest);
        return entryPoint.submitModeledUserOp(
            smartAccount, address(executor), payload, digest, fee
        );
    }

    function testLocalSponsorPaysAndSmartAccountReceivesAtomicMorphoSurplus() public {
        uint256 vaultBefore = address(sponsor).balance;
        uint256 beneficiaryBefore = BENEFICIARY.balance;
        uint256 debtSharesBefore;
        (, debtSharesBefore,) = morpho.position(market.id(), address(borrower));
        require(address(smartAccount).balance == 0, "SMART_ACCOUNT_HAS_NATIVE_BALANCE");
        (bool ok,) = _submit(_payload(bytes32(uint256(101))), MODELED_GAS_FEE);
        require(ok, "AUTHENTIC_SOURCE_LIQUIDATION_FAILED");
        require(usdc.balanceOf(address(smartAccount)) >= MIN_PROFIT,
            "SMART_ACCOUNT_DID_NOT_RECEIVE_SURPLUS");
        require(address(smartAccount).balance == 0, "SMART_ACCOUNT_GAS_WAS_REQUIRED");
        require(address(sponsor).balance == vaultBefore - MODELED_GAS_FEE,
            "SPONSOR_NOT_DEBITED");
        require(BENEFICIARY.balance == beneficiaryBefore + MODELED_GAS_FEE,
            "MODEL_BENEFICIARY_NOT_PAID");
        uint256 debtSharesAfter;
        (, debtSharesAfter,) = morpho.position(market.id(), address(borrower));
        require(debtSharesAfter < debtSharesBefore, "MORPHO_NOT_REPAID");
        require(usdc.balanceOf(address(executor)) == 0, "EXECUTOR_LEFT_USDC");
        require(cbxrp.balanceOf(address(executor)) == 0, "EXECUTOR_LEFT_COLLATERAL");
        require(usdc.allowance(address(executor), address(morpho)) == 0,
            "MORPHO_ALLOWANCE_NOT_RESET");
        require(cbxrp.allowance(address(executor), address(dex)) == 0,
            "DEX_ALLOWANCE_NOT_RESET");
        require(executor.used(bytes32(uint256(101))), "EXECUTION_ID_NOT_CONSUMED");
    }

    function testFailedAtomicSwapRevertsMorphoButStillChargesSponsor() public {
        dex.setRate(8 * 10 ** 17);
        uint256 beforeVault = address(sponsor).balance;
        uint256 beforeBeneficiary = BENEFICIARY.balance;
        uint256 borrowerCollateral = cbxrp.balanceOf(address(borrower));
        uint256 morphoCash = usdc.balanceOf(address(morpho));
        (bool ok,) = _submit(_payload(bytes32(uint256(102))), MODELED_GAS_FEE);
        require(!ok, "EXPECTED_APPLICATION_FAILURE");
        require(address(sponsor).balance == beforeVault - MODELED_GAS_FEE,
            "FAILED_EXECUTION_GAS_WAS_WRONGLY_FREE");
        require(BENEFICIARY.balance == beforeBeneficiary + MODELED_GAS_FEE,
            "FAILED_EXECUTION_SPONSOR_NOT_CHARGED");
        require(cbxrp.balanceOf(address(borrower)) == borrowerCollateral,
            "MORPHO_COLLATERAL_FAILED_ROLLBACK");
        require(usdc.balanceOf(address(morpho)) == morphoCash,
            "MORPHO_DEBT_CASH_FAILED_ROLLBACK");
        require(!executor.used(bytes32(uint256(102))), "EXECUTION_REVERT_NOT_ATOMIC");
        require(usdc.balanceOf(address(smartAccount)) == 0,
            "FAILING_OP_COLLECTED_FAKE_PROFIT");
        require(address(smartAccount).balance == 0, "ACCOUNT_GAS_BALANCE_CHANGED");
    }

    function testSponsorCannotPayFromNothingAndNoApplicationExecutes() public {
        vm.deal(address(sponsor), 0);
        bytes memory payload = _payload(bytes32(uint256(103)));
        bytes32 digest = _digest(payload);
        smartAccount.authorizeIntent(digest);
        (bool ok,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(executor), payload, digest, MODELED_GAS_FEE)
        ));
        require(!ok, "SPONSOR_MAGICAL_GAS");
        require(usdc.balanceOf(address(smartAccount)) == 0, "UNFUNDED_EXECUTION");
        require(smartAccount.approved(digest), "UNFUNDED_MUST_NOT_CONSUME_AUTH");
    }

    function testExecutorRejectsCallerNotSmartAccount() public {
        (bool ok, bytes memory reason) = address(executor).call(
            _payload(bytes32(uint256(104)))
        );
        require(!ok && reason.length >= 4, "UNAUTHORIZED_CALLER_ACCEPTED");
        bytes4 got;
        assembly ("memory-safe") { got := mload(add(reason, 32)) }
        require(got == NqcMorphoNativeCallbackLab.WrongCaller.selector,
            "UNEXPECTED_REJECT_REASON");
    }

    function testReplayAndAlteredPayloadCannotUseSameAuthorization() public {
        bytes memory payload = _payload(bytes32(uint256(105)));
        bytes32 digest = _digest(payload);
        smartAccount.authorizeIntent(digest);
        (bool first,) = entryPoint.submitModeledUserOp(
            smartAccount, address(executor), payload, digest, MODELED_GAS_FEE
        );
        require(first, "FIRST_AUTH_FAILED");
        uint256 vaultAfter = address(sponsor).balance;
        (bool replay,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(executor), payload, digest, MODELED_GAS_FEE)
        ));
        require(!replay, "REPLAY_ACCEPTED");
        require(address(sponsor).balance == vaultAfter, "REPLAY_SPONSOR_CHARGED");
        bytes memory altered = _payload(bytes32(uint256(106)));
        (bool forgery,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(executor), altered, digest, MODELED_GAS_FEE)
        ));
        require(!forgery, "ALTERED_CALLDATA_ACCEPTED");
        require(address(sponsor).balance == vaultAfter, "FORGED_SPONSOR_CHARGED");
    }

    function testFailedOpConsumesIntentAndCannotFreelyRetry() public {
        dex.setRate(8 * 10 ** 17);
        bytes memory payload = _payload(bytes32(uint256(107)));
        bytes32 digest = _digest(payload);
        smartAccount.authorizeIntent(digest);
        (bool first,) = entryPoint.submitModeledUserOp(
            smartAccount, address(executor), payload, digest, MODELED_GAS_FEE
        );
        require(!first, "SHOULD_REVERT");
        require(!smartAccount.approved(digest), "REVERTED_EXECUTION_RESET_REPLAY_GUARD");
        uint256 balanceAfter = address(sponsor).balance;
        (bool next,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(executor), payload, digest, MODELED_GAS_FEE)
        ));
        require(!next, "INVALID_RETRY_ACCEPTED");
        require(address(sponsor).balance == balanceAfter, "RETRY_PAID");
    }

    function testSponsorPolicyRejectsUnapprovedTargetOrExcessCharge() public {
        bytes memory payload = _payload(bytes32(uint256(108)));
        bytes32 digest = _digest(payload);
        smartAccount.authorizeIntent(digest);
        uint256 beforeSponsor = address(sponsor).balance;
        (bool wrongTarget,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(borrower), payload, digest, MODELED_GAS_FEE)
        ));
        require(!wrongTarget, "OTHER_TARGET_AUTHORIZED");
        (bool highFee,) = address(entryPoint).call(abi.encodeCall(
            Nqc4337EntryPointAccountingModel.submitModeledUserOp,
            (smartAccount, address(executor), payload, digest, MODELED_GAS_FEE * 3)
        ));
        require(!highFee, "UNCAPPED_FEE_ACCEPTED");
        require(address(sponsor).balance == beforeSponsor, "BAD_SPONSOR_FEE");
        require(smartAccount.approved(digest), "FAILED_VALIDATION_USED_INTENT");
    }
}
