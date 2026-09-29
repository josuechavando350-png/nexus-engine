use crate::DiscoveryError;
use nqc_census_chain::{abi, evm::CodeScan};
use nqc_census_core::{Address, Hash32, RawLogEnvelope};

const ADDRESSES_PROVIDER: &str = "ADDRESSES_PROVIDER()";
const RESERVES_COUNT: &str = "getReservesCount()";
const RESERVE_BY_ID: &str = "getReserveAddressById(uint16)";
const RESERVES_LIST: &str = "getReservesList()";
const RESERVE_DATA: &str = "getReserveData(address)";
const GET_POOL: &str = "getPool()";
const GET_POOL_CONFIGURATOR: &str = "getPoolConfigurator()";
const GET_PRICE_ORACLE: &str = "getPriceOracle()";
const FLASHLOAN_PREMIUM_TOTAL: &str = "FLASHLOAN_PREMIUM_TOTAL()";
const BASE_CURRENCY: &str = "BASE_CURRENCY()";
const BASE_CURRENCY_UNIT: &str = "BASE_CURRENCY_UNIT()";
const RESERVE_INITIALIZED: &str = "ReserveInitialized(address,address,address,address,address)";
const RESERVE_DROPPED: &str = "ReserveDropped(address)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AaveDiscoveryInterface {
    pub addresses_provider: [u8; 4],
    pub reserves_count: [u8; 4],
    pub reserve_by_id: [u8; 4],
    pub reserves_list: [u8; 4],
    pub reserve_data: [u8; 4],
    pub get_pool: [u8; 4],
    pub get_pool_configurator: [u8; 4],
    pub get_price_oracle: [u8; 4],
    pub flashloan_premium_total: [u8; 4],
    pub base_currency: [u8; 4],
    pub base_currency_unit: [u8; 4],
    pub reserve_initialized_topic: [u8; 32],
    pub reserve_dropped_topic: [u8; 32],
}

pub fn aave_interface() -> AaveDiscoveryInterface {
    AaveDiscoveryInterface {
        addresses_provider: abi::selector(ADDRESSES_PROVIDER),
        reserves_count: abi::selector(RESERVES_COUNT),
        reserve_by_id: abi::selector(RESERVE_BY_ID),
        reserves_list: abi::selector(RESERVES_LIST),
        reserve_data: abi::selector(RESERVE_DATA),
        get_pool: abi::selector(GET_POOL),
        get_pool_configurator: abi::selector(GET_POOL_CONFIGURATOR),
        get_price_oracle: abi::selector(GET_PRICE_ORACLE),
        flashloan_premium_total: abi::selector(FLASHLOAN_PREMIUM_TOTAL),
        base_currency: abi::selector(BASE_CURRENCY),
        base_currency_unit: abi::selector(BASE_CURRENCY_UNIT),
        reserve_initialized_topic: abi::event_topic(RESERVE_INITIALIZED),
        reserve_dropped_topic: abi::event_topic(RESERVE_DROPPED),
    }
}

/// Presence in runtime bytecode is evidence, not semantic certification. Live
/// calls must still prove the exact deployment behavior.
pub fn verify_pool_runtime(code: &[u8]) -> Result<(), DiscoveryError> {
    if code.is_empty() {
        return Err(DiscoveryError::InvalidInterface("Pool has no runtime code"));
    }
    let declared = aave_interface();
    let scan = CodeScan::new(code);
    if scan.truncated_push() {
        return Err(DiscoveryError::InvalidInterface(
            "Pool runtime has truncated PUSH data",
        ));
    }
    for selector in [
        declared.addresses_provider,
        declared.reserves_count,
        declared.reserve_by_id,
        declared.reserves_list,
        declared.reserve_data,
    ] {
        if !scan.has_selector(selector) {
            return Err(DiscoveryError::InvalidInterface(
                "required Pool selector not evidenced in runtime",
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReserveInitializedEvent {
    pub asset: Address,
    pub a_token: Address,
    pub stable_debt_token: Option<Address>,
    pub variable_debt_token: Address,
    pub interest_rate_strategy: Option<Address>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReserveDroppedEvent {
    pub asset: Address,
}

fn topic_address(topic: &Hash32) -> Result<Address, DiscoveryError> {
    let bytes = topic.as_bytes();
    if bytes[..12].iter().any(|byte| *byte != 0) {
        return Err(DiscoveryError::InvalidInterface(
            "indexed address has non-canonical padding",
        ));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&bytes[12..]);
    Ok(Address::new(address)?)
}

fn word_address_optional(word: &[u8; 32]) -> Result<Option<Address>, DiscoveryError> {
    Ok(match abi::decode_address(word)? {
        Some(value) => Some(Address::new(value)?),
        None => None,
    })
}

fn word_address(word: &[u8; 32], field: &'static str) -> Result<Address, DiscoveryError> {
    word_address_optional(word)?.ok_or(DiscoveryError::InvalidReserve(field))
}

pub fn decode_reserve_initialized(
    configurator: Address,
    log: &RawLogEnvelope,
) -> Result<ReserveInitializedEvent, DiscoveryError> {
    if log.removed() || log.emitter() != configurator {
        return Err(DiscoveryError::InvalidInterface(
            "non-canonical ReserveInitialized log",
        ));
    }
    let topics = log.topics();
    let declared = aave_interface();
    if topics.len() != 3 || topics[0].as_bytes() != &declared.reserve_initialized_topic {
        return Err(DiscoveryError::InvalidInterface(
            "ReserveInitialized topic layout mismatch",
        ));
    }
    let asset = topic_address(&topics[1])?;
    let a_token = topic_address(&topics[2])?;
    let words = abi::words(log.data())?;
    if words.len() != 3 {
        return Err(DiscoveryError::InvalidInterface(
            "ReserveInitialized data word count mismatch",
        ));
    }
    Ok(ReserveInitializedEvent {
        asset,
        a_token,
        stable_debt_token: word_address_optional(&words[0])?,
        variable_debt_token: word_address(&words[1], "zero variable debt token")?,
        interest_rate_strategy: word_address_optional(&words[2])?,
    })
}

pub fn decode_reserve_dropped(
    configurator: Address,
    log: &RawLogEnvelope,
) -> Result<ReserveDroppedEvent, DiscoveryError> {
    if log.removed() || log.emitter() != configurator {
        return Err(DiscoveryError::InvalidInterface(
            "non-canonical ReserveDropped log",
        ));
    }
    let topics = log.topics();
    let declared = aave_interface();
    if topics.len() != 2 || topics[0].as_bytes() != &declared.reserve_dropped_topic {
        return Err(DiscoveryError::InvalidInterface(
            "ReserveDropped topic layout mismatch",
        ));
    }
    if !log.data().is_empty() {
        return Err(DiscoveryError::InvalidInterface(
            "ReserveDropped must have empty data",
        ));
    }
    Ok(ReserveDroppedEvent {
        asset: topic_address(&topics[1])?,
    })
}
