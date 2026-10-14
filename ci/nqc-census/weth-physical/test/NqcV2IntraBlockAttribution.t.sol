// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmNqcAttribution {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function envString(string calldata) external returns (string memory);
    function envUint(string calldata) external returns (uint256);
    function envAddress(string calldata) external returns (address);
    function envBytes(string calldata) external returns (bytes memory);
    function envBytes32(string calldata) external returns (bytes32);
    function envBytes32(string calldata, string calldata) external returns (bytes32[] memory);
    function createSelectFork(string calldata, uint256) external returns (uint256);
    function createSelectFork(string calldata, bytes32) external returns (uint256);
    function warp(uint256) external;
    function roll(uint256) external;
    function transact(bytes32) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

/// @notice Retrospective LOCAL replay only. No NQC route, keys, funding or broadcast.
contract NqcV2IntraBlockAttributionTest {
    VmNqcAttribution constant vm = VmNqcAttribution(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    event log_named_uint(string key, uint256 val);
    event log_named_bytes(string key, bytes val);

    function account(address borrower) internal view returns (bytes memory raw) {
        bool ok;
        (ok, raw) = POOL.staticcall(abi.encodeWithSignature("getUserAccountData(address)", borrower));
        require(ok && raw.length == 192, "ACCOUNT_READ_FAILED");
    }

    function hf(bytes memory raw) internal pure returns (uint256 value) {
        (,,,,, value) = abi.decode(raw, (uint256, uint256, uint256, uint256, uint256, uint256));
    }

    function winnerContext(uint256 number, uint256 timestamp, bytes32 parent) internal view {
        require(block.chainid == 1 && block.number == number && block.timestamp == timestamp, "WRONG_FORK_CONTEXT");
        require(blockhash(number - 1) == parent, "WRONG_PARENT_HASH");
    }

    function testTimePrefixAndHistoricalWinner() public {
        string memory rpc = vm.envString("NQC_RPC_URL");
        address borrower = vm.envAddress("NQC_BORROWER");
        uint256 number = vm.envUint("NQC_WINNER_BLOCK");
        uint256 timestamp = vm.envUint("NQC_WINNER_TIMESTAMP");
        bytes32 parent = vm.envBytes32("NQC_PARENT_HASH");
        bytes32 txHash = vm.envBytes32("NQC_WINNER_TX");
        bytes32[] memory prefix = vm.envBytes32("NQC_PREFIX_TXS", ",");
        require(
            prefix.length == vm.envUint("NQC_WINNER_INDEX") && prefix.length > 0 && prefix.length <= 10,
            "PREFIX_LENGTH_MISMATCH"
        );

        vm.createSelectFork(rpc, number - 1);
        require(
            block.chainid == 1 && block.number == number - 1 && block.timestamp == vm.envUint("NQC_PARENT_TIMESTAMP"),
            "WRONG_PARENT_CONTEXT"
        );
        bytes memory beforeTime = account(borrower);
        require(
            keccak256(beforeTime) == keccak256(vm.envBytes("NQC_PARENT_ACCOUNT_ABI")), "SOURCE_PARENT_ACCOUNT_MISMATCH"
        );
        vm.warp(timestamp);
        vm.roll(number);
        bytes memory timeOnly = account(borrower);
        emit log_named_uint("NQC_PARENT_HF", hf(beforeTime));
        emit log_named_uint("NQC_TIME_ONLY_HF", hf(timeOnly));

        // Foundry replays precisely the transactions BEFORE txHash, excluding the winner.
        vm.createSelectFork(rpc, txHash);
        winnerContext(number, timestamp, parent);
        bytes memory referencePrestate = account(borrower);
        emit log_named_bytes("NQC_REFERENCE_PRESTATE_ABI", referencePrestate);
        emit log_named_uint("NQC_REFERENCE_PRESTATE_HF", hf(referencePrestate));

        // Independently replay each prefix transaction from the real index-zero context.
        vm.createSelectFork(rpc, prefix[0]);
        winnerContext(number, timestamp, parent);
        bytes memory start = account(borrower);
        require(keccak256(start) == keccak256(timeOnly), "TIME_ONLY_START_STATE_MISMATCH");
        uint256 firstCrossing = type(uint256).max;
        for (uint256 i; i < prefix.length; ++i) {
            vm.transact(prefix[i]);
            bytes memory afterPrefix = account(borrower);
            emit log_named_uint("NQC_PREFIX_INDEX", i);
            emit log_named_uint("NQC_PREFIX_HF", hf(afterPrefix));
            if (firstCrossing == type(uint256).max && hf(afterPrefix) < 1 ether) firstCrossing = i;
        }
        require(keccak256(account(borrower)) == keccak256(referencePrestate), "PREFIX_PRESTATE_MISMATCH");
        emit log_named_uint("NQC_FIRST_PREFIX_CROSSING_INDEX", firstCrossing);
        emit log_named_uint("NQC_PREFIX_ACCOUNT_PARITY", 1);

        // A historical competitor positive control, not an NQC execution or profit claim.
        bytes32[] memory expectedTopics = vm.envBytes32("NQC_EVENT_TOPICS", ",");
        bytes memory expectedData = vm.envBytes("NQC_EVENT_DATA");
        vm.recordLogs();
        vm.transact(txHash);
        VmNqcAttribution.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == POOL
                    && keccak256(abi.encode(logs[i].topics)) == keccak256(abi.encode(expectedTopics))
                    && keccak256(logs[i].data) == keccak256(expectedData)
            ) ++matches;
        }
        require(matches == 1, "HISTORICAL_LIQUIDATION_EVENT_MISMATCH");
        emit log_named_uint("NQC_WINNER_EVENT_PARITY", matches);
        emit log_named_uint("NQC_POST_WINNER_HF", hf(account(borrower)));
    }
}
