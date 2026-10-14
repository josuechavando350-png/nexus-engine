// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcFlashFundingExecutor} from "../src/NqcFlashFundingExecutor.sol";
import {NqcV2HistoricalRouteHarness, IAaveNqcRoute}
    from "../test/NqcV2FundedRouteFork.t.sol";

interface VmNqcLocalReceipt {
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function envBytes(string calldata name) external returns (bytes memory);
    function envBytes32(string calldata name) external returns (bytes32);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Script is allowed to BROADCAST ONLY to a validated ephemeral
///         local 127.0.0.1 Anvil fork started by nqc_cold_receipt_runner.py.
///         Anvil RPC URL allowlisting and ephemeral synthetic gas funding are
///         enforced by the caller, not by an unverified CLI user override.
/// @dev Source lives only in the isolated CI proof; NOT a production executor.
contract NqcV2LocalColdReceiptScript {
    VmNqcLocalReceipt internal constant vm =
        VmNqcLocalReceipt(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;

    event log_named_uint(string key, uint256 val);
    event log_named_address(string key, address value);

    function readAccount(address owner) private view returns (bytes memory) {
        (bool ok, bytes memory out) =
            POOL.staticcall(abi.encodeWithSignature("getUserAccountData(address)", owner));
        require(ok && out.length == 192, "AAVE_ACCOUNT_READ_FAILED");
        return out;
    }

    function run() external {
        // These identities originate from PR698 exact immutable source.
        address operator = vm.envAddress("NQC_LOCAL_TEST_OPERATOR");
        address borrower = vm.envAddress("NQC_BORROWER");
        address debt = vm.envAddress("NQC_DEBT_ASSET");
        uint256 principal = vm.envUint("NQC_PRINCIPAL");
        uint256 expectedSeizedWeth = vm.envUint("NQC_COLLATERAL");
        uint256 expectedFee = vm.envUint("NQC_FLASH_FEE");
        uint256 sourceBlock = vm.envUint("NQC_WINNER_BLOCK");
        bytes32 sourceWinner = vm.envBytes32("NQC_WINNER_TX");
        bytes32 sourceParent = vm.envBytes32("NQC_PARENT_HASH");
        bytes memory expectedPrestate = vm.envBytes("NQC_PRESTATE_ABI");

        require(block.chainid == 1, "WRONG_MAINNET_FORK_CONTEXT");
        require(block.number >= sourceBlock - 1 && block.number <= sourceBlock + 6,
            "NOT_REPLAYED_HISTORICAL_BLOCK");
        require(blockhash(sourceBlock - 1) == sourceParent,
            "SOURCE_PARENT_HASH_CHANGED");
        require(keccak256(readAccount(borrower)) == keccak256(expectedPrestate),
            "ORIGINAL_PRE_WINNER_ACCOUNT_ABI_MISMATCH");

        (,,,,, uint256 hf) = abi.decode(
            expectedPrestate, (uint256, uint256, uint256, uint256, uint256, uint256)
        );
        require(hf > 0 && hf < 1 ether, "SOURCE_POSITION_NOT_LIQUIDATABLE");
        require(IAaveNqcRoute(POOL).FLASHLOAN_PREMIUM_TOTAL() == 5,
            "SOURCE_FLASH_FEE_DRIFT");
        require(expectedFee == (principal * 5 + 9999) / 10000,
            "SOURCE_FLASH_FEE_ROUNDING_DRIFT");
        require(debt != WETH && principal > 0 && expectedSeizedWeth > 0,
            "SOURCE_MARKET_AMOUNT_INVALID");

        // The 4 following Solidity state-changing calls are queued for
        // isolated-local Anvil only. This is NOT an Ethereum mainnet sender.
        vm.startBroadcast();
        NqcV2HistoricalRouteHarness strategy =
            new NqcV2HistoricalRouteHarness(debt, borrower, expectedSeizedWeth);
        NqcFlashFundingExecutor coordinator =
            new NqcFlashFundingExecutor(operator, address(strategy));
        strategy.setExecutor(address(coordinator));

        bytes memory payload = abi.encode(principal + expectedFee + 1);
        NqcFlashFundingExecutor.FundingLeg[] memory legs =
            new NqcFlashFundingExecutor.FundingLeg[](1);
        legs[0] = NqcFlashFundingExecutor.FundingLeg({
            sourceKind: 1,
            lender: POOL,
            principal: principal,
            expectedFee: expectedFee,
            callbackSemanticsHash: keccak256("T36_CANONICAL_REAL_AAVE_CALLBACK"),
            sourceEvidenceHash: keccak256("LOCAL_ANVIL_HISTORICAL_FORK_ONLY_NO_SPONSOR")
        });
        NqcFlashFundingExecutor.FlashExecutionPlan memory plan =
            NqcFlashFundingExecutor.FlashExecutionPlan({
                chainId: 1,
                validThroughBlock: block.number + 32,
                executionIdentityHash: keccak256(
                    abi.encode("NQC_LOCAL_ANVIL_COLD_TX",sourceWinner,debt,principal,payload)
                ),
                fundingPlanHash: keccak256(abi.encode(
                    "LOCAL_ANVIL_HISTORICAL_BORROWER",sourceWinner,debt,principal,payload
                )),
                anchorHash: keccak256(abi.encode(sourceParent,sourceWinner,expectedPrestate)),
                canonicalGeneration: 1,
                asset: debt,
                principalRequired: principal,
                minProfitAsset: 1,
                payloadHash: keccak256(payload),
                legs: legs
            });
        uint256 localSurplus = coordinator.execute(plan, payload);
        vm.stopBroadcast();

        require(localSurplus > 0, "LOCAL_FORK_ROUTE_HAS_NO_SURPLUS");
        require(coordinator.consumedExecutionIdentity(plan.executionIdentityHash),
            "FORK_EXECUTION_IDENTITY_NOT_CONSUMED");
        emit log_named_address("NQC_LOCAL_ONLY_STRATEGY",address(strategy));
        emit log_named_address("NQC_LOCAL_ONLY_COORDINATOR",address(coordinator));
        emit log_named_uint("NQC_LOCAL_ONLY_ROUTE_SURPLUS_ASSET",localSurplus);
        emit log_named_uint("NQC_LOCAL_ONLY_SETUP_IS_THREE_EXTRA_TRANSACTIONS",3);
    }
}
