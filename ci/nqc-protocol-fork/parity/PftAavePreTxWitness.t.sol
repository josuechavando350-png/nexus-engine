// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface PftVm {
    function envString(string calldata name) external returns (string memory value);
    function createSelectFork(string calldata urlOrAlias, bytes32 transaction) external returns (uint256 forkId);
}

interface PftAavePoolState {
    function getUserConfiguration(address user) external view returns (uint256);
    function getUserEMode(address user) external view returns (uint256);
    function getUserAccountData(address user)
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

contract PftAavePreTxWitnessTest {
    PftVm private constant vm =
        PftVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PftAavePoolState private constant POOL =
        PftAavePoolState(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);

    uint256 private constant WAD = 1e18;

    bytes32 private constant TX_MULTI =
        0xc953d5da04ee4dc9f421ac5418f05add5244d9816c50420bbf7bb6cbafc1150a;
    uint256 private constant BLOCK_MULTI = 25_252_136;
    bytes32 private constant PARENT_MULTI =
        0x04a2465e3a87b1103521c1f54e568de209062f08742a0212da24d34eee4aac78;

    bytes32 private constant TX_USDC =
        0xa36fcaa8b9572a15b81dbeeb9731ff9c7b9e7542de7b52834b9349526364cfc5;
    uint256 private constant BLOCK_USDC = 25_437_474;
    bytes32 private constant PARENT_USDC =
        0x033656168ee1dba1934f77171fe572c866282e97738b79434cb8c01b6e6f88f2;

    event PreTxWitness(
        bytes32 indexed transactionHash,
        address indexed borrower,
        uint256 totalCollateralBase,
        uint256 totalDebtBase,
        uint256 availableBorrowsBase,
        uint256 liquidationThreshold,
        uint256 ltv,
        uint256 healthFactor,
        uint256 userConfiguration,
        uint256 eModeCategory
    );

    function testFork_PreTxMultiAssetLiquidationsAreEligible() public {
        _selectTransactionFork(TX_MULTI, BLOCK_MULTI, PARENT_MULTI);

        address[14] memory borrowers = [
            address(uint160(0x00ffefa70b6deaab975ef15a6474ce9c4214d82b02)),
            address(uint160(0x005e0481cad8bff5453635f4770f44b2194ddf6e02)),
            address(uint160(0x0063fedfa44b742d43c430f416db596d7bec8ed0b8)),
            address(uint160(0x000ece0b16103922a4288f17832b83b3bfcdfb64f8)),
            address(uint160(0x009d36250d3c929b5c4f70fa4125aab0951f8a250e)),
            address(uint160(0x00c087195a816e1f247f1865189d76c6be0aed9982)),
            address(uint160(0x002b7c013fd7cd09d315fc431030db55d58ffac21e)),
            address(uint160(0x00a1025868e2a0455b9b17792fd434273884102d38)),
            address(uint160(0x00f65db52a04372f8529ec077844d2164af432de38)),
            address(uint160(0x0084ee0a392652a008deb77a2486d88afda547fc40)),
            address(uint160(0x0095368a0462b6caaf86f0afe41bdd48469b734a3f)),
            address(uint160(0x007f6e4c9ccab9334cd205a06d0d3edc2be174f458)),
            address(uint160(0x0001b55690fe60653a0e14fe49a3e24fd0b8fd8e7f)),
            address(uint160(0x0095a46112679f65da65b81a544b5b86ff270dd865))
        ];

        for (uint256 i = 0; i < borrowers.length; ++i) {
            _assertLiquidatable(TX_MULTI, borrowers[i]);
        }
    }

    function testFork_PreTxUsdcLiquidationIsEligible() public {
        _selectTransactionFork(TX_USDC, BLOCK_USDC, PARENT_USDC);
        _assertLiquidatable(TX_USDC, address(uint160(0x008a47b469d1023f43df528e0c020aa212e962ac27)));
    }

    function _selectTransactionFork(bytes32 txHash, uint256 expectedBlock, bytes32 expectedParent) internal {
        string memory rpc = vm.envString("PFT_RPC_URL");
        vm.createSelectFork(rpc, txHash);
        require(block.number == expectedBlock, "PRETX_BLOCK_NUMBER");
        require(blockhash(expectedBlock - 1) == expectedParent, "PRETX_PARENT_HASH");
    }

    function _assertLiquidatable(bytes32 txHash, address borrower) internal {
        (
            uint256 collateral,
            uint256 debt,
            uint256 available,
            uint256 threshold,
            uint256 ltv,
            uint256 hf
        ) = POOL.getUserAccountData(borrower);
        uint256 configuration = POOL.getUserConfiguration(borrower);
        uint256 eMode = POOL.getUserEMode(borrower);

        require(debt > 0, "PRETX_ZERO_DEBT");
        require(hf < WAD, "PRETX_NOT_LIQUIDATABLE");
        require(configuration != 0, "PRETX_EMPTY_CONFIGURATION");

        emit PreTxWitness(
            txHash,
            borrower,
            collateral,
            debt,
            available,
            threshold,
            ltv,
            hf,
            configuration,
            eMode
        );
    }
}
