// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmNqcPricePath {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }
    function envString(string calldata key) external returns (string memory);
    function envUint(string calldata key) external returns (uint256);
    function envBytes32(string calldata key) external returns (bytes32);
    function createSelectFork(string calldata rpc, bytes32 txHash) external returns (uint256);
    function transact(bytes32 txHash) external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}
interface IAaveNqcPathPool {
    function ADDRESSES_PROVIDER() external view returns (address);
}
interface IAaveNqcPathProvider {
    function getPriceOracle() external view returns (address);
}
interface IAaveNqcPathOracle {
    function getSourceOfAsset(address asset) external view returns (address);
    function getAssetPrice(address asset) external view returns (uint256);
}
interface IChainlinkNqcPathProxy {
    function aggregator() external view returns (address);
    function latestRoundData()
        external view
        returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Strictly an historical fork read-only EVM experiment.
/// @dev vm.transact replays an already-confirmed transaction inside a local fork.
///      No wallet, signed order, broadcast, oracle mutation or live swap.
contract NqcV2OraclePricePathTest {
    VmNqcPricePath constant vm = VmNqcPricePath(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant AGGREGATOR = 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8;

    event log_named_uint(string key, uint256 value);
    event log_named_address(string key, address value);

    function testPinnedConfirmedOracleTransactionPricePath() public {
        bytes32 hash = vm.envBytes32("NQC_CONFIRMED_TX");
        uint256 number = vm.envUint("NQC_CONFIRMED_BLOCK");
        uint256 whenTime = vm.envUint("NQC_CONFIRMED_TIMESTAMP");
        bytes32 parent = vm.envBytes32("NQC_CONFIRMED_PARENT");
        bytes32 topic = vm.envBytes32("NQC_EXPECTED_TOPIC");
        uint256 roundId = vm.envUint("NQC_EXPECTED_ROUND");
        vm.createSelectFork(vm.envString("NQC_RPC_URL"), hash);

        require(
            block.chainid == 1 && block.number == number && block.timestamp == whenTime,
            "NOT_PINNED_CANONICAL_TX_PRESTATE"
        );
        require(blockhash(number - 1) == parent, "CANONICAL_PARENT_HASH_MISMATCH");
        address priceOracle = IAaveNqcPathProvider(IAaveNqcPathPool(POOL).ADDRESSES_PROVIDER()).getPriceOracle();
        require(priceOracle.code.length > 0, "AAVE_ORACLE_NOT_DEPLOYED");
        IAaveNqcPathOracle oracle = IAaveNqcPathOracle(priceOracle);
        address proxyAddress = oracle.getSourceOfAsset(WETH);
        require(proxyAddress.code.length > 0, "WETH_SOURCE_MISSING");
        IChainlinkNqcPathProxy proxy = IChainlinkNqcPathProxy(proxyAddress);
        require(proxy.aggregator() == AGGREGATOR, "DYNAMIC_WETH_AGGREGATOR_DRIFT");

        uint256 beforePrice = oracle.getAssetPrice(WETH);
        (uint80 roundBefore, int256 answerBefore,,, ) = proxy.latestRoundData();
        require(beforePrice > 0 && answerBefore > 0, "BAD_CANONICAL_PRESTATE_PRICE");

        vm.recordLogs();
        vm.transact(hash);
        VmNqcPricePath.Log[] memory logs = vm.getRecordedLogs();
        uint256 matches;
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == AGGREGATOR && logs[i].topics.length == 2
                    && logs[i].topics[0] == topic && uint256(logs[i].topics[1]) == roundId
            ) {
                ++matches;
            }
        }
        require(matches == 1, "EXPECTED_ORACLE_EVENT_NOT_REPLAYED_EXACTLY_ONCE");
        require(oracle.getSourceOfAsset(WETH) == proxyAddress && proxy.aggregator() == AGGREGATOR,
            "ORACLE_SOURCE_CHANGED_DURING_TX");

        uint256 afterPrice = oracle.getAssetPrice(WETH);
        (uint80 roundAfter, int256 answerAfter,,, ) = proxy.latestRoundData();
        require(afterPrice > 0 && answerAfter > 0, "BAD_CANONICAL_POSTSTATE_PRICE");

        emit log_named_uint("NQC_AAVE_PRICE_BEFORE", beforePrice);
        emit log_named_uint("NQC_AAVE_PRICE_AFTER", afterPrice);
        emit log_named_uint("NQC_CHAINLINK_ANSWER_BEFORE", uint256(answerBefore));
        emit log_named_uint("NQC_CHAINLINK_ANSWER_AFTER", uint256(answerAfter));
        emit log_named_uint("NQC_CHAINLINK_ROUND_BEFORE", roundBefore);
        emit log_named_uint("NQC_CHAINLINK_ROUND_AFTER", roundAfter);
        emit log_named_uint("NQC_PRICE_CHANGED", beforePrice == afterPrice ? 0 : 1);
        emit log_named_uint("NQC_MATCHED_ORACLE_EVENT", matches);
        emit log_named_address("NQC_AAVE_PRICE_ORACLE", priceOracle);
        emit log_named_address("NQC_CHAINLINK_PRICE_SOURCE", proxyAddress);
    }
}
