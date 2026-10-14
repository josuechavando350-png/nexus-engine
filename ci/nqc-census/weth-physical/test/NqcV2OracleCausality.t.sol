// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmNqcOracleCausality {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function envString(string calldata name) external returns (string memory);
    function envUint(string calldata name) external returns (uint256);
    function envAddress(string calldata name) external returns (address);
    function envBytes32(string calldata name) external returns (bytes32);
    function createSelectFork(string calldata url, bytes32 txHash) external returns (uint256);
    function transact(bytes32 txHash) external;
    function mockCall(address target, bytes calldata calldataPrefix, bytes calldata response) external;
    function clearMockedCalls() external;
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

interface IAaveNqcOraclePool {
    function ADDRESSES_PROVIDER() external view returns (address);
    function getUserAccountData(address account)
        external
        view
        returns (
            uint256 totalCollateralBase,
            uint256 totalDebtBase,
            uint256 availableBorrowsBase,
            uint256 currentLiquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

interface IAaveNqcAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface IAaveNqcPriceOracle {
    function getAssetPrice(address asset) external view returns (uint256);
    function getSourceOfAsset(address asset) external view returns (address);
}

interface IChainlinkNqcOracleProxy {
    function aggregator() external view returns (address);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Historical research ONLY. No keys, no broadcast, no live gas, no oracle state override.
/// @dev The only oracle override is a Foundry mockCall inside an ephemeral fork.
contract NqcV2OracleCausalityTest {
    VmNqcOracleCausality constant vm =
        VmNqcOracleCausality(address(uint160(uint256(keccak256("hevm cheat code")))));
    IAaveNqcOraclePool constant POOL = IAaveNqcOraclePool(0x87870Bca3F3fD6335C3F4Ce8392D69350B4fA4E2);
    address constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    address constant ETH_USD_DUAL_AGGREGATOR = 0x7c7FdFCa295a787ded12Bb5c1A49A8D2cC20E3F8;

    event log_named_uint(string key, uint256 val);

    function healthFactor(address borrower) internal view returns (uint256 hf) {
        (,,,,, hf) = POOL.getUserAccountData(borrower);
    }

    function testFirstOracleUpdatePriceFreeze() public {
        address borrower = vm.envAddress("NQC_BORROWER");
        uint256 number = vm.envUint("NQC_WINNER_BLOCK");
        uint256 timestamp = vm.envUint("NQC_WINNER_TIMESTAMP");
        bytes32 parentHash = vm.envBytes32("NQC_PARENT_HASH");
        bytes32 firstTx = vm.envBytes32("NQC_FIRST_TX");

        // createSelectFork(txHash) is the chain state before that transaction.
        vm.createSelectFork(vm.envString("NQC_RPC_URL"), firstTx);
        require(block.chainid == 1 && block.number == number && block.timestamp == timestamp, "CONTEXT_DRIFT");
        require(blockhash(number - 1) == parentHash, "PARENT_DRIFT");

        address priceOracle = IAaveNqcAddressesProvider(POOL.ADDRESSES_PROVIDER()).getPriceOracle();
        require(priceOracle.code.length > 0, "NO_PRICE_ORACLE_CODE");
        IAaveNqcPriceOracle oracle = IAaveNqcPriceOracle(priceOracle);
        address source = oracle.getSourceOfAsset(WETH);
        require(source.code.length > 0, "NO_CANONICAL_WETH_PRICE_SOURCE");
        IChainlinkNqcOracleProxy proxy = IChainlinkNqcOracleProxy(source);
        require(proxy.aggregator() == ETH_USD_DUAL_AGGREGATOR, "AAVE_WETH_AGGREGATOR_DRIFT");

        uint256 priceBefore = oracle.getAssetPrice(WETH);
        (, int256 feedBefore,,, ) = proxy.latestRoundData();
        uint256 hfBefore = healthFactor(borrower);
        require(priceBefore > 0 && feedBefore > 0, "NO_BEFORE_PRICE");
        require(hfBefore == vm.envUint("NQC_HF_BEFORE_TX0") && hfBefore >= 1 ether, "START_HF_MISMATCH");

        vm.recordLogs();
        vm.transact(firstTx);
        VmNqcOracleCausality.Log[] memory txLogs = vm.getRecordedLogs();
        uint256 aggregatorEvents;
        for (uint256 i; i < txLogs.length; ++i) {
            if (txLogs[i].emitter == ETH_USD_DUAL_AGGREGATOR) ++aggregatorEvents;
        }
        require(aggregatorEvents > 0, "NO_DUAL_AGGREGATOR_LOG");
        require(proxy.aggregator() == ETH_USD_DUAL_AGGREGATOR, "AGGREGATOR_CHANGED_DURING_TX");
        require(oracle.getSourceOfAsset(WETH) == source, "SOURCE_CHANGED_DURING_TX");

        uint256 priceAfter = oracle.getAssetPrice(WETH);
        (, int256 feedAfter,,, ) = proxy.latestRoundData();
        uint256 hfAfter = healthFactor(borrower);
        require(priceAfter > 0 && priceAfter < priceBefore, "ORACLE_PRICE_NOT_DOWN");
        require(feedAfter > 0 && feedAfter < feedBefore, "FEED_ANSWER_NOT_DOWN");
        require(hfAfter == vm.envUint("NQC_HF_AFTER_TX0") && hfAfter < 1 ether, "POST_TX0_HF_MISMATCH");

        // Only in a local fork: retain the post-TX0 state but freeze Aave's
        // WETH price at the pre-TX0 value to test the causal price path.
        vm.mockCall(
            priceOracle,
            abi.encodeWithSelector(IAaveNqcPriceOracle.getAssetPrice.selector, WETH),
            abi.encode(priceBefore)
        );
        uint256 frozenHF = healthFactor(borrower);
        require(frozenHF >= 1 ether, "WETH_PRICE_ALONE_NOT_SUFFICIENT_TO_RESTORE_HEALTH");
        vm.clearMockedCalls();
        uint256 afterClear = healthFactor(borrower);
        require(afterClear == hfAfter, "COUNTERFACTUAL_CLEANUP_DRIFT");

        emit log_named_uint("NQC_ORACLE_PRICE_BEFORE", priceBefore);
        emit log_named_uint("NQC_ORACLE_PRICE_AFTER", priceAfter);
        emit log_named_uint("NQC_FEED_ANSWER_BEFORE", uint256(feedBefore));
        emit log_named_uint("NQC_FEED_ANSWER_AFTER", uint256(feedAfter));
        emit log_named_uint("NQC_HF_BEFORE_TX0", hfBefore);
        emit log_named_uint("NQC_HF_AFTER_TX0", hfAfter);
        emit log_named_uint("NQC_HF_PRICE_FROZEN", frozenHF);
        emit log_named_uint("NQC_HF_AFTER_CLEAR", afterClear);
        emit log_named_uint("NQC_PRICE_FREEZE_REVERTS_TRIGGER", 1);
    }
}
