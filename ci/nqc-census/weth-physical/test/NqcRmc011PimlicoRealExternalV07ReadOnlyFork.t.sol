// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcPackedUserOperation} from "./NqcRmc011EntryPointV07ActualFork.t.sol";

interface INqcRealPimlicoV07 {
    function entryPoint() external view returns (address);
    function getDeposit() external view returns (uint256);
    function validatePaymasterUserOp(
        NqcPackedUserOperation calldata op,
        bytes32 opHash,
        uint256 requiredPrefund
    ) external returns (bytes memory context, uint256 validationData);
    function postOp(
        uint8 mode,
        bytes calldata context,
        uint256 actualGasCost,
        uint256 actualUserOpFeePerGas
    ) external;
}

interface INqcRealMainnetEntryPointV07 {
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Read-only safety/identity checks of a real independent, deployed
///         Ethereum Pimlico SingletonPaymasterV7, at historical RMC016 anchor.
/// @dev It deliberately NEVER impersonates Pimlico's signing key or uses its
///      gas deposit. Existence of pooled collateral is NOT NQC credit allocation.
contract NqcRmc011RealExternalPaymasterSourceForkTest {
    address internal constant ENTRYPOINT =
        0x0000000071727De22E5E9d8BAf0edAc6f37da032;
    address internal constant PAYMASTER =
        0x777777777777AeC03fd955926DbF81597e66834C;
    uint256 internal constant ANCHOR = 25_938_047;

    event log_named_bytes32(string label, bytes32 value);
    event log_named_uint(string label, uint256 value);

    function setUp() public view {
        require(block.chainid == 1 && block.number == ANCHOR,
                "WRONG_INDEPENDENT_PROVIDER_ANCHOR");
        require(ENTRYPOINT.code.length > 1000 && PAYMASTER.code.length > 1000,
                "REAL_EXTERNAL_PROVIDER_CODE_ABSENT");
    }

    function testActualDeployedSingletonV7BindsCorrectHistoricalEntryPoint() public {
        require(INqcRealPimlicoV07(PAYMASTER).entryPoint() == ENTRYPOINT,
                "ACTUAL_EXTERNAL_PAYMASTER_WRONG_ENTRYPOINT");
        uint256 entryPointDeposited =
            INqcRealMainnetEntryPointV07(ENTRYPOINT).balanceOf(PAYMASTER);
        require(INqcRealPimlicoV07(PAYMASTER).getDeposit() == entryPointDeposited,
                "REAL_PAYMASTER_AND_ENTRYPOINT_TOTAL_BALANCE_MISMATCH");
        // This is TOTAL THIRD-PARTY provider inventory. No signed authorization
        // to NQC exists; never mark a real gas facility available on this basis.
        emit log_named_bytes32(
            "NQC_REAL_EXTERNAL_PAYMASTER_HISTORICAL_RUNTIME_SHA256",
            sha256(PAYMASTER.code)
        );
        emit log_named_uint(
            "NQC_REAL_EXTERNAL_PAYMASTER_TOTAL_ENTRYPOINT_NATIVE_DEPOSIT_WEI",
            entryPointDeposited
        );
        emit log_named_uint("NQC_REAL_EXTERNAL_PAYMASTER_NQC_SIGNED_QUOTE_PROVEN",0);
    }

    function testUnsignedDirectPaymasterValidationAlwaysRejectsCaller() public {
        NqcPackedUserOperation memory fake;
        fake.sender = address(this);
        fake.nonce = 0;
        fake.initCode = new bytes(0);
        fake.callData = new bytes(0);
        fake.paymasterAndData = new bytes(0);
        fake.signature = new bytes(0);

        uint256 beforeDeposit =
            INqcRealMainnetEntryPointV07(ENTRYPOINT).balanceOf(PAYMASTER);
        (bool success,) = PAYMASTER.call(abi.encodeWithSelector(
            INqcRealPimlicoV07.validatePaymasterUserOp.selector,
            fake, bytes32(uint256(1)), uint256(1)
        ));
        require(!success, "REAL_PIMLICO_AUTHORIZATION_BYPASSED");
        require(INqcRealMainnetEntryPointV07(ENTRYPOINT).balanceOf(PAYMASTER) ==
                beforeDeposit, "UNAUTHORIZED_VALIDATION_DREW_PROVIDER_FUNDS");
    }

    function testDirectUnsolicitedPostOpCannotSpendProviderDeposit() public {
        uint256 beforeDeposit =
            INqcRealMainnetEntryPointV07(ENTRYPOINT).balanceOf(PAYMASTER);
        (bool success,) = PAYMASTER.call(abi.encodeWithSelector(
            INqcRealPimlicoV07.postOp.selector,
            uint8(0), hex"", uint256(1), uint256(1)
        ));
        require(!success, "REAL_PROVIDER_POSTOP_CAN_BE_SPOOFED");
        require(INqcRealMainnetEntryPointV07(ENTRYPOINT).balanceOf(PAYMASTER) ==
                beforeDeposit, "UNAUTHORIZED_POSTOP_DREW_PROVIDER_NATIVE_GAS");
    }
}
