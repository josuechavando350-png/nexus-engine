use alloy::{
    eips::BlockId,
    primitives::{keccak256, Address, B256, U256},
    providers::{DynProvider, Provider},
    sol,
};
use nqc_aave_events::{AaveEventDecoder, DecodeError};
use nqc_aave_reader::{AaveLocalReader, ReaderError, ReserveReadTarget};
use nqc_aave_sync::{ReserveConfigurationBits, AAVE_V3_MAX_RESERVES};
use nqc_core::{mul_div_floor, wad, MathError};
use nqc_hot_state::{AaveHotState, EModeCategory, HotStateError, ReserveConfig, ReserveRuntime};
use nqc_state::{CanonicalBlock, RethIpcSource, StateError};
use thiserror::Error;

sol! {
    struct ReserveConfigurationMap {
        uint256 data;
    }

    struct ReserveDataLegacy {
        ReserveConfigurationMap configuration;
        uint128 liquidity_index;
        uint128 current_liquidity_rate;
        uint128 variable_borrow_index;
        uint128 current_variable_borrow_rate;
        uint128 current_stable_borrow_rate;
        uint40 last_update_timestamp;
        uint16 id;
        address a_token_address;
        address stable_debt_token_address;
        address variable_debt_token_address;
        address interest_rate_strategy_address;
        uint128 accrued_to_treasury;
        uint128 unbacked;
        uint128 isolation_mode_total_debt;
    }

    struct CollateralConfig {
        uint16 ltv;
        uint16 liquidation_threshold;
        uint16 liquidation_bonus;
    }

    #[sol(rpc)]
    interface IAaveMarketPoolView {
        function ADDRESSES_PROVIDER() external view returns (address);
        function getReservesCount() external view returns (uint256);
        function getReserveAddressById(uint16 id) external view returns (address);
        function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
        function FLASHLOAN_PREMIUM_TOTAL() external view returns (uint128);
        function getLiquidationGracePeriod(address asset) external view returns (uint40);
        function getEModeCategoryCollateralConfig(uint8 id) external view returns (CollateralConfig memory);
        function getEModeCategoryCollateralBitmap(uint8 id) external view returns (uint128);
        function getEModeCategoryBorrowableBitmap(uint8 id) external view returns (uint128);
        function getEModeCategoryLtvzeroBitmap(uint8 id) external view returns (uint128);
        function getIsEModeCategoryIsolated(uint8 id) external view returns (bool);
    }

    #[sol(rpc)]
    interface IAaveAddressesProviderView {
        function getPriceOracle() external view returns (address);
    }

    #[sol(rpc)]
    interface IAavePriceOracleView {
        function BASE_CURRENCY() external view returns (address);
        function BASE_CURRENCY_UNIT() external view returns (uint256);
        function getAssetPrice(address asset) external view returns (uint256);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarketReserve {
    pub asset: Address,
    pub reserve_id: u16,
    pub configuration: ReserveConfigurationBits,
    pub a_token: Address,
    pub variable_debt_token: Address,
    pub price_oracle_units: U256,
    pub price_usd_wad: U256,
    pub liquidity_index_ray: U256,
    pub variable_borrow_index_ray: U256,
    pub liquidity_rate_ray: U256,
    pub variable_borrow_rate_ray: U256,
    pub last_update_timestamp: u64,
    pub liquidation_bonus_bps: u32,
    pub liquidation_protocol_fee_bps: u32,
    pub flash_loan_enabled: bool,
    pub liquidation_grace_period_until: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MarketEModeCategory {
    pub category_id: u8,
    pub liquidation_threshold_bps: u32,
    pub liquidation_bonus_bps: u32,
    pub collateral_bitmap: u128,
    pub borrowable_bitmap: u128,
    pub ltvzero_bitmap: u128,
    pub isolated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AaveMarketSnapshot {
    pub chain_id: u64,
    pub pool: Address,
    pub addresses_provider: Address,
    pub price_oracle: Address,
    pub anchor: CanonicalBlock,
    pub oracle_base_currency: Address,
    pub oracle_base_unit: U256,
    pub flash_loan_premium_bps: u32,
    pub reserves: Vec<MarketReserve>,
    pub emode_categories: Vec<MarketEModeCategory>,
}

impl AaveMarketSnapshot {
    pub fn apply(
        &self,
        hot_state: &mut AaveHotState,
        reader: &mut AaveLocalReader,
        decoder: &mut AaveEventDecoder,
    ) -> Result<(), MarketError> {
        if reader.chain_id() != self.chain_id {
            return Err(MarketError::ReaderChainMismatch {
                expected: self.chain_id,
                actual: reader.chain_id(),
            });
        }
        if reader.pool() != self.pool || decoder.pool() != self.pool {
            return Err(MarketError::PoolMismatch);
        }

        for reserve in &self.reserves {
            hot_state.configure_reserve(
                reserve.asset,
                ReserveConfig {
                    reserve_id: reserve.reserve_id,
                    token_unit: reserve.configuration.token_unit(),
                    liquidation_threshold_bps: reserve.configuration.liquidation_threshold_bps(),
                },
                ReserveRuntime {
                    price_usd_wad: reserve.price_usd_wad,
                    liquidity_index_ray: reserve.liquidity_index_ray,
                    variable_borrow_index_ray: reserve.variable_borrow_index_ray,
                    liquidity_rate_ray: reserve.liquidity_rate_ray,
                    variable_borrow_rate_ray: reserve.variable_borrow_rate_ray,
                    last_update_timestamp: reserve.last_update_timestamp,
                },
            )?;
            reader.register_reserve(ReserveReadTarget {
                asset: reserve.asset,
                reserve_id: reserve.reserve_id,
                a_token: reserve.a_token,
                variable_debt_token: reserve.variable_debt_token,
            })?;
            decoder.register_atoken(reserve.asset, reserve.a_token)?;
        }

        for category in &self.emode_categories {
            hot_state.configure_emode_category(
                category.category_id,
                EModeCategory {
                    liquidation_threshold_bps: category.liquidation_threshold_bps,
                    liquidation_bonus_bps: category.liquidation_bonus_bps,
                    collateral_bitmap: category.collateral_bitmap,
                    borrowable_bitmap: category.borrowable_bitmap,
                    ltvzero_bitmap: category.ltvzero_bitmap,
                    isolated: category.isolated,
                },
            )?;
        }
        Ok(())
    }

    #[must_use]
    pub fn reserve(&self, asset: Address) -> Option<&MarketReserve> {
        self.reserves.iter().find(|reserve| reserve.asset == asset)
    }

    #[must_use]
    pub fn emode_category(&self, category_id: u8) -> Option<&MarketEModeCategory> {
        self.emode_categories
            .iter()
            .find(|category| category.category_id == category_id)
    }


    #[must_use]
    pub fn snapshot_hash(&self) -> B256 {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"NQC_AAVE_MARKET_SNAPSHOT_V1");
        bytes.extend_from_slice(&self.chain_id.to_be_bytes());
        bytes.extend_from_slice(self.pool.as_slice());
        bytes.extend_from_slice(self.addresses_provider.as_slice());
        bytes.extend_from_slice(self.price_oracle.as_slice());
        encode_anchor(&mut bytes, self.anchor);
        bytes.extend_from_slice(self.oracle_base_currency.as_slice());
        bytes.extend_from_slice(&self.oracle_base_unit.to_be_bytes::<32>());
        bytes.extend_from_slice(&self.flash_loan_premium_bps.to_be_bytes());

        let mut reserves: Vec<&MarketReserve> = self.reserves.iter().collect();
        reserves.sort_unstable_by_key(|reserve| (reserve.reserve_id, reserve.asset));
        bytes.extend_from_slice(&(reserves.len() as u64).to_be_bytes());
        for reserve in reserves {
            bytes.extend_from_slice(reserve.asset.as_slice());
            bytes.extend_from_slice(&reserve.reserve_id.to_be_bytes());
            bytes.extend_from_slice(&reserve.configuration.0.to_be_bytes::<32>());
            bytes.extend_from_slice(reserve.a_token.as_slice());
            bytes.extend_from_slice(reserve.variable_debt_token.as_slice());
            for value in [
                reserve.price_oracle_units,
                reserve.price_usd_wad,
                reserve.liquidity_index_ray,
                reserve.variable_borrow_index_ray,
                reserve.liquidity_rate_ray,
                reserve.variable_borrow_rate_ray,
            ] {
                bytes.extend_from_slice(&value.to_be_bytes::<32>());
            }
            bytes.extend_from_slice(&reserve.last_update_timestamp.to_be_bytes());
            bytes.extend_from_slice(&reserve.liquidation_bonus_bps.to_be_bytes());
            bytes.extend_from_slice(&reserve.liquidation_protocol_fee_bps.to_be_bytes());
            bytes.push(u8::from(reserve.flash_loan_enabled));
            bytes.extend_from_slice(&reserve.liquidation_grace_period_until.to_be_bytes());
        }

        let mut categories: Vec<&MarketEModeCategory> = self.emode_categories.iter().collect();
        categories.sort_unstable_by_key(|category| category.category_id);
        bytes.extend_from_slice(&(categories.len() as u64).to_be_bytes());
        for category in categories {
            bytes.push(category.category_id);
            bytes.extend_from_slice(&category.liquidation_threshold_bps.to_be_bytes());
            bytes.extend_from_slice(&category.liquidation_bonus_bps.to_be_bytes());
            bytes.extend_from_slice(&category.collateral_bitmap.to_be_bytes());
            bytes.extend_from_slice(&category.borrowable_bitmap.to_be_bytes());
            bytes.extend_from_slice(&category.ltvzero_bitmap.to_be_bytes());
            bytes.push(u8::from(category.isolated));
        }
        keccak256(bytes)
    }
}

fn encode_anchor(bytes: &mut Vec<u8>, anchor: CanonicalBlock) {
    bytes.extend_from_slice(&anchor.number.to_be_bytes());
    bytes.extend_from_slice(anchor.hash.as_slice());
    bytes.extend_from_slice(&anchor.timestamp.to_be_bytes());
    match anchor.base_fee_per_gas {
        Some(value) => {
            bytes.push(1);
            bytes.extend_from_slice(&value.to_be_bytes());
        }
        None => {
            bytes.push(0);
            bytes.extend_from_slice(&0u64.to_be_bytes());
        }
    }
}

#[derive(Clone)]
pub struct AaveMarketBootstrap {
    source: RethIpcSource,
    provider: DynProvider,
    pool: Address,
    chain_id: u64,
}

impl AaveMarketBootstrap {
    pub async fn from_reth(
        source: &RethIpcSource,
        pool: Address,
        expected_chain_id: u64,
    ) -> Result<Self, MarketError> {
        if pool == Address::ZERO {
            return Err(MarketError::ZeroPoolAddress);
        }
        let chain_id = source.chain_id().await?;
        if chain_id != expected_chain_id {
            return Err(MarketError::ChainIdMismatch {
                expected: expected_chain_id,
                actual: chain_id,
            });
        }
        Ok(Self {
            source: source.clone(),
            provider: source.provider(),
            pool,
            chain_id,
        })
    }

    pub async fn bootstrap_latest(&self) -> Result<AaveMarketSnapshot, MarketError> {
        let anchor = self.source.latest_canonical_block().await?;
        self.bootstrap_at(anchor).await
    }

    pub async fn bootstrap_at(&self, anchor: CanonicalBlock) -> Result<AaveMarketSnapshot, MarketError> {
        self.source.ensure_canonical(anchor).await?;
        let block = BlockId::hash_canonical(anchor.hash);
        let pool = IAaveMarketPoolView::new(self.pool, &self.provider);

        let addresses_provider = pool
            .ADDRESSES_PROVIDER()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        if addresses_provider == Address::ZERO {
            return Err(MarketError::ZeroAddressesProvider);
        }

        let provider_contract = IAaveAddressesProviderView::new(addresses_provider, &self.provider);
        let price_oracle = provider_contract
            .getPriceOracle()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        if price_oracle == Address::ZERO {
            return Err(MarketError::ZeroPriceOracle);
        }

        let oracle = IAavePriceOracleView::new(price_oracle, &self.provider);
        let oracle_base_currency = oracle
            .BASE_CURRENCY()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        let oracle_base_unit = oracle
            .BASE_CURRENCY_UNIT()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        if oracle_base_unit == U256::ZERO {
            return Err(MarketError::ZeroOracleBaseUnit);
        }
        if oracle_base_currency != Address::ZERO {
            return Err(MarketError::UnsupportedNonUsdOracleBase(oracle_base_currency));
        }

        let reserve_count_raw = pool
            .getReservesCount()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        let reserve_count = u256_to_u16(reserve_count_raw)?;
        if reserve_count > AAVE_V3_MAX_RESERVES {
            return Err(MarketError::ReserveCountTooLarge(reserve_count));
        }

        let premium = pool
            .FLASHLOAN_PREMIUM_TOTAL()
            .block(block)
            .call()
            .await
            .map_err(contract_error)?;
        let flash_loan_premium_bps = u128_to_u32(premium)?;

        let mut reserves = Vec::with_capacity(usize::from(reserve_count));
        for reserve_id in 0..reserve_count {
            let asset = pool
                .getReserveAddressById(reserve_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if asset == Address::ZERO {
                continue;
            }

            let reserve_data = pool
                .getReserveData(asset)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if reserve_data.id != reserve_id {
                return Err(MarketError::ReserveIdMismatch {
                    expected: reserve_id,
                    actual: reserve_data.id,
                    asset,
                });
            }
            if reserve_data.a_token_address == Address::ZERO
                || reserve_data.variable_debt_token_address == Address::ZERO
            {
                return Err(MarketError::InvalidReserveTokens(asset));
            }

            let configuration = ReserveConfigurationBits(reserve_data.configuration.data);
            let price_oracle_units = oracle
                .getAssetPrice(asset)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            if price_oracle_units == U256::ZERO {
                return Err(MarketError::ZeroAssetPrice(asset));
            }
            let price_usd_wad = normalize_usd_price(price_oracle_units, oracle_base_unit)?;
            let liquidation_grace_period_until = pool
                .getLiquidationGracePeriod(asset)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;

            reserves.push(MarketReserve {
                asset,
                reserve_id,
                configuration,
                a_token: reserve_data.a_token_address,
                variable_debt_token: reserve_data.variable_debt_token_address,
                price_oracle_units,
                price_usd_wad,
                liquidity_index_ray: U256::from(reserve_data.liquidity_index),
                variable_borrow_index_ray: U256::from(reserve_data.variable_borrow_index),
                liquidity_rate_ray: U256::from(reserve_data.current_liquidity_rate),
                variable_borrow_rate_ray: U256::from(reserve_data.current_variable_borrow_rate),
                last_update_timestamp: reserve_data.last_update_timestamp,
                liquidation_bonus_bps: configuration.liquidation_bonus_bps(),
                liquidation_protocol_fee_bps: configuration.liquidation_protocol_fee_bps(),
                flash_loan_enabled: configuration.flash_loan_enabled(),
                liquidation_grace_period_until,
            });
        }
        reserves.sort_unstable_by_key(|reserve| reserve.reserve_id);

        let emode_categories = self.read_emode_categories(block).await?;
        self.source.ensure_canonical(anchor).await?;

        Ok(AaveMarketSnapshot {
            chain_id: self.chain_id,
            pool: self.pool,
            addresses_provider,
            price_oracle,
            anchor,
            oracle_base_currency,
            oracle_base_unit,
            flash_loan_premium_bps,
            reserves,
            emode_categories,
        })
    }
}

impl AaveMarketBootstrap {
    async fn read_emode_categories(
        &self,
        block: BlockId,
    ) -> Result<Vec<MarketEModeCategory>, MarketError> {
        let pool = IAaveMarketPoolView::new(self.pool, &self.provider);
        let mut categories = Vec::new();
        for category_id in 1..=u8::MAX {
            let config = pool
                .getEModeCategoryCollateralConfig(category_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            let collateral_bitmap = pool
                .getEModeCategoryCollateralBitmap(category_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;

            if config.liquidation_threshold == 0 && collateral_bitmap == 0 {
                continue;
            }
            let borrowable_bitmap = pool
                .getEModeCategoryBorrowableBitmap(category_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            let ltvzero_bitmap = pool
                .getEModeCategoryLtvzeroBitmap(category_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            let isolated = pool
                .getIsEModeCategoryIsolated(category_id)
                .block(block)
                .call()
                .await
                .map_err(contract_error)?;
            categories.push(MarketEModeCategory {
                category_id,
                liquidation_threshold_bps: u32::from(config.liquidation_threshold),
                liquidation_bonus_bps: u32::from(config.liquidation_bonus),
                collateral_bitmap,
                borrowable_bitmap,
                ltvzero_bitmap,
                isolated,
            });
        }
        Ok(categories)
    }
}

fn normalize_usd_price(price: U256, base_unit: U256) -> Result<U256, MarketError> {
    Ok(mul_div_floor(price, wad(), base_unit)?)
}

fn u256_to_u16(value: U256) -> Result<u16, MarketError> {
    if value > U256::from(u16::MAX) {
        return Err(MarketError::InvalidReserveCount(value));
    }
    Ok(value.as_limbs()[0] as u16)
}

fn u128_to_u32(value: u128) -> Result<u32, MarketError> {
    u32::try_from(value).map_err(|_| MarketError::InvalidFlashLoanPremium(value))
}

fn contract_error(error: impl std::fmt::Display) -> MarketError {
    MarketError::Contract(error.to_string())
}

#[derive(Debug, Error)]
pub enum MarketError {
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Math(#[from] MathError),
    #[error(transparent)]
    HotState(#[from] HotStateError),
    #[error(transparent)]
    Reader(#[from] ReaderError),
    #[error(transparent)]
    Decode(#[from] DecodeError),
    #[error("configured Aave pool address is zero")]
    ZeroPoolAddress,
    #[error("expected chain id {expected}, connected Reth reports {actual}")]
    ChainIdMismatch { expected: u64, actual: u64 },
    #[error("Aave Pool returned zero ADDRESSES_PROVIDER")]
    ZeroAddressesProvider,
    #[error("Aave AddressesProvider returned zero price oracle")]
    ZeroPriceOracle,
    #[error("Aave oracle returned zero BASE_CURRENCY_UNIT")]
    ZeroOracleBaseUnit,
    #[error("NQC currently requires USD-based Aave oracle; base currency is {0}")]
    UnsupportedNonUsdOracleBase(Address),
    #[error("Aave reserve count {0} exceeds the 128-reserve user bitmap")]
    ReserveCountTooLarge(u16),
    #[error("Aave reserve count is outside u16 range: {0}")]
    InvalidReserveCount(U256),
    #[error("Aave reserve {asset} reports id {actual}, expected historical slot {expected}")]
    ReserveIdMismatch {
        expected: u16,
        actual: u16,
        asset: Address,
    },
    #[error("Aave reserve has zero aToken or variable debt token: {0}")]
    InvalidReserveTokens(Address),
    #[error("Aave oracle returned zero price for reserve {0}")]
    ZeroAssetPrice(Address),
    #[error("Aave flash-loan premium is outside u32 range: {0}")]
    InvalidFlashLoanPremium(u128),
    #[error("market snapshot pool does not match reader/decoder")]
    PoolMismatch,
    #[error("market snapshot chain id {expected} does not match reader {actual}")]
    ReaderChainMismatch { expected: u64, actual: u64 },
    #[error("Aave contract read failed over local Reth IPC: {0}")]
    Contract(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_price_normalization_supports_non_wad_oracle_decimals() -> Result<(), MarketError> {
        let price_8_decimals = U256::from(3_500_00000000u64);
        assert_eq!(
            normalize_usd_price(price_8_decimals, U256::from(100_000_000u64))?,
            U256::from(3_500u64) * wad()
        );
        Ok(())
    }

    #[test]
    fn reserve_configuration_decodes_protocol_fee() {
        let raw = U256::from(777u64) << 152;
        assert_eq!(ReserveConfigurationBits(raw).liquidation_protocol_fee_bps(), 777);
    }

    #[test]
    fn reserve_count_is_range_checked() {
        assert_eq!(u256_to_u16(U256::from(128u64)).ok(), Some(128));
        assert!(matches!(
            u256_to_u16(U256::from(u32::MAX)),
            Err(MarketError::InvalidReserveCount(_))
        ));
    }


    fn hash_test_reserve(id: u16, asset_byte: u8, price: u64) -> MarketReserve {
        MarketReserve {
            asset: Address::repeat_byte(asset_byte),
            reserve_id: id,
            configuration: ReserveConfigurationBits(U256::from(18u64) << 48),
            a_token: Address::repeat_byte(asset_byte.wrapping_add(10)),
            variable_debt_token: Address::repeat_byte(asset_byte.wrapping_add(20)),
            price_oracle_units: U256::from(price),
            price_usd_wad: U256::from(price) * wad(),
            liquidity_index_ray: U256::from(1u8),
            variable_borrow_index_ray: U256::from(1u8),
            liquidity_rate_ray: U256::ZERO,
            variable_borrow_rate_ray: U256::ZERO,
            last_update_timestamp: 100,
            liquidation_bonus_bps: 10_500,
            liquidation_protocol_fee_bps: 1_000,
            flash_loan_enabled: true,
            liquidation_grace_period_until: 0,
        }
    }

    fn hash_test_snapshot(reserves: Vec<MarketReserve>) -> AaveMarketSnapshot {
        AaveMarketSnapshot {
            chain_id: 1,
            pool: Address::repeat_byte(1),
            addresses_provider: Address::repeat_byte(2),
            price_oracle: Address::repeat_byte(3),
            anchor: CanonicalBlock {
                number: 100,
                hash: B256::repeat_byte(4),
                timestamp: 1_700_000_000,
                base_fee_per_gas: Some(20_000_000_000),
            },
            oracle_base_currency: Address::ZERO,
            oracle_base_unit: U256::from(100_000_000u64),
            flash_loan_premium_bps: 5,
            reserves,
            emode_categories: vec![MarketEModeCategory {
                category_id: 1,
                liquidation_threshold_bps: 9_500,
                liquidation_bonus_bps: 10_100,
                collateral_bitmap: 1,
                borrowable_bitmap: 2,
                ltvzero_bitmap: 0,
                isolated: false,
            }],
        }
    }

    #[test]
    fn snapshot_hash_is_order_independent_but_value_sensitive() {
        let a = hash_test_reserve(0, 10, 3_000);
        let b = hash_test_reserve(1, 11, 1);
        let left = hash_test_snapshot(vec![a.clone(), b.clone()]);
        let right = hash_test_snapshot(vec![b, a]);
        assert_eq!(left.snapshot_hash(), right.snapshot_hash());

        let mut drifted = right.clone();
        drifted.reserves[0].price_usd_wad += U256::from(1u8);
        assert_ne!(left.snapshot_hash(), drifted.snapshot_hash());
    }
}
