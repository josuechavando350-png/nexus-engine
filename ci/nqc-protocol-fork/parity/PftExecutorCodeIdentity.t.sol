// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {NqcAaveV3Executor} from "../src/NqcAaveV3Executor.sol";
import {NqcV2BackrunExecutor} from "../src/NqcV2BackrunExecutor.sol";

interface PftIdentityVm {
    function envString(string calldata name) external returns (string memory value);
    function serializeBytes32(string calldata objectKey, string calldata valueKey, bytes32 value)
        external
        returns (string memory json);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
}

contract PftExecutorCodeIdentityTest {
    PftIdentityVm private constant vm =
        PftIdentityVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    address private constant OPERATOR = 0x1111111111111111111111111111111111111111;
    address private constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

    function testWriteRuntimeIdentity() public {
        NqcAaveV3Executor aave = new NqcAaveV3Executor(OPERATOR, POOL);
        NqcV2BackrunExecutor v2 = new NqcV2BackrunExecutor(OPERATOR, POOL);

        bytes32 aaveHash = keccak256(address(aave).code);
        bytes32 v2Hash = keccak256(address(v2).code);
        require(aaveHash != bytes32(0) && v2Hash != bytes32(0), "ZERO_CODE_HASH");
        require(address(aave).code.length > 0 && address(v2).code.length > 0, "ZERO_CODE");

        string memory key = "identity";
        vm.serializeBytes32(key, "aave_runtime_keccak256", aaveHash);
        vm.serializeBytes32(key, "v2_runtime_keccak256", v2Hash);
        vm.serializeUint(key, "aave_runtime_length", address(aave).code.length);
        string memory json = vm.serializeUint(key, "v2_runtime_length", address(v2).code.length);
        vm.writeJson(json, vm.envString("PFT_IDENTITY_PATH"));
    }
}
