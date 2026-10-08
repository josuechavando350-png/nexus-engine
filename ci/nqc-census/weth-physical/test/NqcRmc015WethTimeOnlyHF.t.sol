// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface VmRmc015Clock {
    function envAddress(string calldata name) external returns (address);
    function envUint(string calldata name) external returns (uint256);
    function roll(uint256 number) external;
    function warp(uint256 timestamp) external;
}

interface IAaveRmc015AccountRisk {
    function getUserAccountData(address user)
        external
        view
        returns (
            uint256 collateralBase,
            uint256 debtBase,
            uint256 availableBorrowsBase,
            uint256 liquidationThreshold,
            uint256 ltv,
            uint256 healthFactor
        );
}

/// @notice Fork-only strictly TIME-ONLY beginning-of-winner-block Aave risk.
/// @dev The borrower was chosen RETROSPECTIVELY from its winning transaction.
///      Only vm.roll and vm.warp are used: no original intra-block transactions,
///      oracle writes, token transfers, capital, native gas funding or live trade.
contract NqcRmc015WethTimeOnlyHfForkTest {
    VmRmc015Clock internal constant vm =
        VmRmc015Clock(address(uint160(uint256(keccak256("hevm cheat code")))));

    address internal constant AAVE_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fa4E2;
    uint256 internal constant WAD = 1 ether;

    event log_named_uint(string key, uint256 val);

    function testPreviousHealthFactorAndWinnerTimestampOnly() public {
        address borrower = vm.envAddress("NQC_RMC015_BORROWER");
        uint256 previous = vm.envUint("NQC_RMC015_PREVIOUS_BLOCK");
        uint256 winner = vm.envUint("NQC_RMC015_WINNER_BLOCK");
        uint256 previousTimestamp = vm.envUint("NQC_RMC015_PREVIOUS_TIMESTAMP");
        uint256 winnerTimestamp = vm.envUint("NQC_RMC015_WINNER_TIMESTAMP");
        uint256 expectedHf = vm.envUint("NQC_RMC015_SOURCE_PREVIOUS_HF");

        require(block.chainid == 1, "HISTORICAL_CHAIN_MISMATCH");
        require(block.number == previous, "NOT_HISTORICAL_PREVIOUS_BLOCK");
        require(block.timestamp == previousTimestamp, "HISTORICAL_TIMESTAMP_DRIFT");
        require(winner == previous + 1 && winnerTimestamp > previousTimestamp,
                "NONCANONICAL_BLOCK_ORDER");
        require(AAVE_POOL.code.length > 100, "REAL_POOL_CODE_UNAVAILABLE");
        require(borrower != address(0), "BORROWER_MISSING");

        (
            uint256 collateralBefore,
            uint256 debtBefore,
            uint256 availableBefore,
            uint256 thresholdBefore,
            uint256 ltvBefore,
            uint256 hfBefore
        ) = IAaveRmc015AccountRisk(AAVE_POOL).getUserAccountData(borrower);

        require(debtBefore > 0 && collateralBefore > 0, "NO_PRESTATE_POSITION");
        require(hfBefore == expectedHf, "PREVIOUS_HF_TWO_RPC_MISMATCH");
        require(hfBefore >= WAD, "PREVIOUS_HF_EXPECTED_HEALTHY");

        // Crucially: NO state-changing underlying mainnet transactions are
        // applied. This isolates deterministic time/index effects only.
        vm.warp(winnerTimestamp);
        vm.roll(winner);

        (
            uint256 collateralAfter,
            uint256 debtAfter,
            uint256 availableAfter,
            uint256 thresholdAfter,
            uint256 ltvAfter,
            uint256 hfAfter
        ) = IAaveRmc015AccountRisk(AAVE_POOL).getUserAccountData(borrower);

        require(block.number == winner && block.timestamp == winnerTimestamp,
                "TIME_ONLY_EVM_CONTEXT_MISMATCH");
        // Aave risk parameters may change only as calculated values with time,
        // not because the fixture calls user-triggered state writes.
        require(thresholdBefore <= 10_000 && thresholdAfter <= 10_000 &&
                ltvBefore <= 10_000 && ltvAfter <= 10_000 &&
                availableBefore <= type(uint256).max && availableAfter <= type(uint256).max,
                "ACCOUNT_DATA_FORMAT_INVALID");
        require(collateralAfter > 0 && debtAfter > 0 && hfAfter > 0,
                "TIME_ONLY_ACCOUNT_DATA_UNAVAILABLE");

        emit log_named_uint("NQC_TIME_ONLY_HF_BEFORE_WAD", hfBefore);
        emit log_named_uint("NQC_TIME_ONLY_HF_AFTER_WAD", hfAfter);
        emit log_named_uint("NQC_TIME_ONLY_COLLATERAL_BASE_AFTER", collateralAfter);
        emit log_named_uint("NQC_TIME_ONLY_DEBT_BASE_AFTER", debtAfter);
        emit log_named_uint("NQC_TIME_ONLY_CROSSED_BELOW_ONE", hfAfter < WAD ? 1 : 0);
    }
}
