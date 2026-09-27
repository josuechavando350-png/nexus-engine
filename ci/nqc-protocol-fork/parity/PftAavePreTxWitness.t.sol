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
            address(0xffeFa70b6dEAaB975eF15A6474Ce9c4214d82b02),
            address(0x5e0481CaD8bffd5453635f4770F44B2194DDf6e02),
            address(0x63FEdFa44b742D43c430f416dB596d7BeC8eD0B8),
            address(0x0eCE0B16103922A4288f17832b83b3BfCDfB64F8),
            address(0x9D36250d3C929B5C4f70fa4125aAB0951F8A250E),
            address(0xC087195a816e1f247F1865189D76C6BE0aeD9982),
            address(0x2B7C013fD7CD09D315Fc431030Db55d58FFAc21E),
            address(0xA1025868e2A0455b9b17792fD434273884102D38),
            address(0xf65db52A04372F8529Ec077844D2164AF432DE38),
            address(0x84EE0a392652A008dEb77A2486D88AFda547fc40),
            address(0x95368a0462B6CaaF86F0aFE41BDd48469B734a3F),
            address(0x7F6e4c9cCAb9334CD205A06d0d3eDC2bE174F458),
            address(0x01b55690Fe60653A0e14fE49A3E24Fd0b8fD8e7f),
            address(0x95a46112679f65da65b81a544b5b86fF270DD865)
        ];

        for (uint256 i = 0; i < borrowers.length; ++i) {
            _assertLiquidatable(TX_MULTI, borrowers[i]);
        }
    }

    function testFork_PreTxUsdcLiquidationIsEligible() public {
        _selectTransactionFork(TX_USDC, BLOCK_USDC, PARENT_USDC);
        _assertLiquidatable(TX_USDC, address(0x8A47b469D1023F43DF528E0C020Aa212E962Ac27));
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
