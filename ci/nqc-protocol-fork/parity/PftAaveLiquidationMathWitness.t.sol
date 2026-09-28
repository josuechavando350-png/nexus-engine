// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface PftLiquidationVm {
    function envString(string calldata name) external returns (string memory value);
    function createSelectFork(string calldata urlOrAlias, bytes32 transaction)
        external
        returns (uint256 forkId);
    function serializeUint(string calldata objectKey, string calldata valueKey, uint256 value)
        external
        returns (string memory json);
    function serializeAddress(string calldata objectKey, string calldata valueKey, address value)
        external
        returns (string memory json);
    function serializeBytes32(string calldata objectKey, string calldata valueKey, bytes32 value)
        external
        returns (string memory json);
    function writeJson(string calldata json, string calldata path) external;
}

struct PftReserveDataLegacy {
    uint256 configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
}

struct PftCollateralConfig {
    uint16 ltv;
    uint16 liquidationThreshold;
    uint16 liquidationBonus;
}

interface PftAaveLiquidationPool {
    function ADDRESSES_PROVIDER() external view returns (address);
    function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
    function getReserveData(address asset) external view returns (PftReserveDataLegacy memory);
    function getUserEMode(address user) external view returns (uint256);
    function getEModeCategoryCollateralConfig(uint8 id)
        external
        view
        returns (PftCollateralConfig memory);
    function getEModeCategoryCollateralBitmap(uint8 id) external view returns (uint128);
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

interface PftAaveAddressesProvider {
    function getPriceOracle() external view returns (address);
}

interface PftAaveOracle {
    function BASE_CURRENCY_UNIT() external view returns (uint256);
    function getAssetPrice(address asset) external view returns (uint256);
}

interface PftBalanceToken {
    function balanceOf(address user) external view returns (uint256);
}

struct PftSingleCaptured {
    uint256 collateralReserveId;
    uint256 debtReserveId;
    uint256 collateralConfiguration;
    uint256 debtConfiguration;
    address collateralAToken;
    address debtVariableToken;
    uint256 collateralUnit;
    uint256 debtUnit;
    uint256 oracleBaseUnit;
    uint256 collateralPrice;
    uint256 debtPrice;
    uint256 borrowerCollateral;
    uint256 borrowerDebt;
    uint256 totalCollateralBase;
    uint256 totalDebtBase;
    uint256 healthFactor;
    uint256 liquidationThreshold;
    uint256 userEMode;
    uint256 reserveBonus;
    uint256 effectiveBonus;
    uint256 protocolFeeBps;
    uint256 flashPremiumBps;
    uint256 observedCallbackFlashPremium;
}

contract PftAaveLiquidationMathWitnessTest {
    PftLiquidationVm private constant vm =
        PftLiquidationVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    PftAaveLiquidationPool private constant POOL =
        PftAaveLiquidationPool(0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2);

    error PftObservedFlashPremium(uint256 premium);
    error PftPremiumProbeUnexpectedSuccess();
    error PftPremiumProbeUnexpectedRevert(bytes32 digest, uint256 length);

    bytes32 private constant TX_USDC =
        0xa36fcaa8b9572a15b81dbeeb9731ff9c7b9e7542de7b52834b9349526364cfc5;
    uint256 private constant BLOCK_USDC = 25_437_474;
    bytes32 private constant PARENT_USDC =
        0x033656168ee1dba1934f77171fe572c866282e97738b79434cb8c01b6e6f88f2;

    address private constant BORROWER =
        address(uint160(0x008a47b469d1023f43df528e0c020aa212e962ac27));
    address private constant COLLATERAL =
        address(uint160(0x00e6a934089bbee34f832060ce98848359883749b3));
    address private constant DEBT =
        address(uint160(0x00a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48));

    uint256 private constant OBSERVED_DEBT_TO_COVER = 186_298_226;
    uint256 private constant OBSERVED_COLLATERAL_TO_LIQUIDATOR =
        191_729_812_904_943_722_712;

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        require(msg.sender == address(POOL), "PREMIUM_CALLBACK_SENDER");
        require(initiator == address(this), "PREMIUM_CALLBACK_INITIATOR");
        (address expectedAsset, uint256 expectedAmount) =
            abi.decode(params, (address, uint256));
        require(asset == expectedAsset, "PREMIUM_CALLBACK_ASSET");
        require(amount == expectedAmount, "PREMIUM_CALLBACK_AMOUNT");
        revert PftObservedFlashPremium(premium);
    }

    function _observeFlashPremium(address asset, uint256 amount)
        private
        returns (uint256 premium)
    {
        try POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(asset, amount),
            0
        ) {
            revert PftPremiumProbeUnexpectedSuccess();
        } catch (bytes memory reason) {
            if (reason.length != 36) {
                revert PftPremiumProbeUnexpectedRevert(
                    keccak256(reason),
                    reason.length
                );
            }
            bytes32 firstWord;
            assembly {
                firstWord := mload(add(reason, 0x20))
                premium := mload(add(reason, 0x24))
            }
            if (bytes4(firstWord) != PftObservedFlashPremium.selector) {
                revert PftPremiumProbeUnexpectedRevert(
                    keccak256(reason),
                    reason.length
                );
            }
        }
    }

    function _loadReserveState()
        private
        view
        returns (PftSingleCaptured memory captured)
    {
        PftReserveDataLegacy memory collateral = POOL.getReserveData(COLLATERAL);
        PftReserveDataLegacy memory debt = POOL.getReserveData(DEBT);
        require(collateral.aTokenAddress != address(0), "NO_ATOKEN");
        require(debt.variableDebtTokenAddress != address(0), "NO_VTOKEN");

        uint256 collateralDecimals = (collateral.configuration >> 48) & 0xff;
        uint256 debtDecimals = (debt.configuration >> 48) & 0xff;
        require(collateralDecimals <= 77 && debtDecimals <= 77, "DECIMALS");

        captured.collateralReserveId = collateral.id;
        captured.debtReserveId = debt.id;
        captured.collateralConfiguration = collateral.configuration;
        captured.debtConfiguration = debt.configuration;
        captured.collateralAToken = collateral.aTokenAddress;
        captured.debtVariableToken = debt.variableDebtTokenAddress;
        captured.collateralUnit = 10 ** collateralDecimals;
        captured.debtUnit = 10 ** debtDecimals;
        captured.reserveBonus = (collateral.configuration >> 32) & 0xffff;
        captured.protocolFeeBps = (collateral.configuration >> 152) & 0xffff;

        captured.userEMode = POOL.getUserEMode(BORROWER);
        require(captured.userEMode <= type(uint8).max, "EMODE_RANGE");
        captured.effectiveBonus = captured.reserveBonus;
        if (captured.userEMode != 0) {
            PftCollateralConfig memory category =
                POOL.getEModeCategoryCollateralConfig(uint8(captured.userEMode));
            uint128 bitmap =
                POOL.getEModeCategoryCollateralBitmap(uint8(captured.userEMode));
            if (
                collateral.id < 128
                    && (bitmap & (uint128(1) << collateral.id)) != 0
            ) {
                captured.effectiveBonus = category.liquidationBonus;
            }
        }
    }

    function _loadOracleAndAccountState(PftSingleCaptured memory captured)
        private
        view
        returns (PftSingleCaptured memory)
    {
        address provider = POOL.ADDRESSES_PROVIDER();
        address oracleAddress =
            PftAaveAddressesProvider(provider).getPriceOracle();
        PftAaveOracle oracle = PftAaveOracle(oracleAddress);

        captured.oracleBaseUnit = oracle.BASE_CURRENCY_UNIT();
        captured.collateralPrice = oracle.getAssetPrice(COLLATERAL);
        captured.debtPrice = oracle.getAssetPrice(DEBT);
        captured.borrowerCollateral =
            PftBalanceToken(captured.collateralAToken).balanceOf(BORROWER);
        captured.borrowerDebt =
            PftBalanceToken(captured.debtVariableToken).balanceOf(BORROWER);

        (
            captured.totalCollateralBase,
            captured.totalDebtBase,
            ,
            captured.liquidationThreshold,
            ,
            captured.healthFactor
        ) = POOL.getUserAccountData(BORROWER);

        captured.flashPremiumBps =
            uint256(POOL.FLASHLOAN_PREMIUM_TOTAL());

        require(captured.oracleBaseUnit != 0, "ZERO_BASE_UNIT");
        require(
            captured.collateralPrice != 0 && captured.debtPrice != 0,
            "ZERO_PRICE"
        );
        require(
            captured.borrowerDebt >= OBSERVED_DEBT_TO_COVER,
            "EVENT_DEBT_GT_PRESTATE_DEBT"
        );
        require(captured.healthFactor < 1e18, "NOT_LIQUIDATABLE");
        return captured;
    }

    function _writeWitness(
        PftSingleCaptured memory captured,
        string memory output
    ) private {
        string memory key = "witness";
        vm.serializeBytes32(key, "transaction_hash", TX_USDC);
        vm.serializeUint(key, "block_number", BLOCK_USDC);
        vm.serializeBytes32(key, "parent_hash", PARENT_USDC);
        vm.serializeUint(key, "block_timestamp", block.timestamp);
        vm.serializeAddress(key, "pool", address(POOL));
        vm.serializeAddress(key, "borrower", BORROWER);
        vm.serializeAddress(key, "collateral_asset", COLLATERAL);
        vm.serializeAddress(key, "debt_asset", DEBT);
        vm.serializeUint(
            key,
            "collateral_reserve_id",
            captured.collateralReserveId
        );
        vm.serializeUint(key, "debt_reserve_id", captured.debtReserveId);
        vm.serializeUint(
            key,
            "collateral_configuration",
            captured.collateralConfiguration
        );
        vm.serializeUint(
            key,
            "debt_configuration",
            captured.debtConfiguration
        );
        vm.serializeAddress(
            key,
            "collateral_atoken",
            captured.collateralAToken
        );
        vm.serializeAddress(
            key,
            "debt_variable_token",
            captured.debtVariableToken
        );
        vm.serializeUint(key, "collateral_unit", captured.collateralUnit);
        vm.serializeUint(key, "debt_unit", captured.debtUnit);
        vm.serializeUint(key, "oracle_base_unit", captured.oracleBaseUnit);
        vm.serializeUint(
            key,
            "collateral_price_oracle_units",
            captured.collateralPrice
        );
        vm.serializeUint(
            key,
            "debt_price_oracle_units",
            captured.debtPrice
        );
        vm.serializeUint(
            key,
            "borrower_collateral_balance",
            captured.borrowerCollateral
        );
        vm.serializeUint(
            key,
            "borrower_variable_debt",
            captured.borrowerDebt
        );
        vm.serializeUint(
            key,
            "total_collateral_base",
            captured.totalCollateralBase
        );
        vm.serializeUint(key, "total_debt_base", captured.totalDebtBase);
        vm.serializeUint(key, "health_factor_wad", captured.healthFactor);
        vm.serializeUint(
            key,
            "liquidation_threshold_bps",
            captured.liquidationThreshold
        );
        vm.serializeUint(key, "user_emode_category", captured.userEMode);
        vm.serializeUint(
            key,
            "reserve_liquidation_bonus_bps",
            captured.reserveBonus
        );
        vm.serializeUint(
            key,
            "effective_liquidation_bonus_bps",
            captured.effectiveBonus
        );
        vm.serializeUint(
            key,
            "liquidation_protocol_fee_bps",
            captured.protocolFeeBps
        );
        vm.serializeUint(
            key,
            "flash_loan_premium_bps",
            captured.flashPremiumBps
        );
        vm.serializeUint(
            key,
            "observed_callback_flash_premium",
            captured.observedCallbackFlashPremium
        );
        vm.serializeUint(key, "flash_loan_callback_observed", 1);
        vm.serializeUint(
            key,
            "observed_debt_to_cover",
            OBSERVED_DEBT_TO_COVER
        );
        string memory json = vm.serializeUint(
            key,
            "observed_collateral_to_liquidator",
            OBSERVED_COLLATERAL_TO_LIQUIDATOR
        );
        vm.writeJson(json, output);
    }

    function testFork_WriteExactSingleLiquidationMathWitness() public {
        string memory rpc = vm.envString("PFT_RPC_URL");
        string memory output = vm.envString("PFT_WITNESS_PATH");
        vm.createSelectFork(rpc, TX_USDC);

        require(block.number == BLOCK_USDC, "PRETX_BLOCK");
        require(
            blockhash(BLOCK_USDC - 1) == PARENT_USDC,
            "PRETX_PARENT"
        );

        PftSingleCaptured memory captured = _loadReserveState();
        captured = _loadOracleAndAccountState(captured);
        captured.observedCallbackFlashPremium =
            _observeFlashPremium(DEBT, OBSERVED_DEBT_TO_COVER);
        _writeWitness(captured, output);
    }
}}
