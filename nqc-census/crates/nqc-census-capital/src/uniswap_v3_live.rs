//! RMC-011 Uniswap V3 permissionless flash-capital discovery primitives.
//!
//! Deployment documentation is only a discovery root. Runtime code, full
//! PoolCreated history, direct factory membership and pool balances remain
//! block-pinned chain evidence obligations.

use nqc_census_chain::{abi, evm::CodeScan, ChainError};
use nqc_census_core::{Address, LogTopic, RawLogEnvelope};

pub const UNISWAP_V3_FACTORY: &str = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
pub const UNISWAP_V3_DEPLOYMENT_REPOSITORY: &str = "Uniswap/v3-periphery";
pub const UNISWAP_V3_DEPLOYMENT_COMMIT: &str =
    "0682387198a24c7cd63566a2c58398533860a5d1";
pub const UNISWAP_V3_DEPLOYMENT_BLOB: &str = "c0af53cb35bdef902965262c23b34f5d39baf343";
pub const UNISWAP_V3_DEPLOYMENT_PATH: &str = "deploys.md";

const GET_POOL: &str = "getPool(address,address,uint24)";
const POOL_CREATED: &str = "PoolCreated(address,address,uint24,int24,address)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniswapV3FactoryInterface {
    pub get_pool: [u8; 4],
    pub pool_created_topic: [u8; 32],
}

pub fn uniswap_v3_factory_interface() -> UniswapV3FactoryInterface {
    UniswapV3FactoryInterface {
        get_pool: abi::selector(GET_POOL),
        pool_created_topic: abi::event_topic(POOL_CREATED),
    }
}

pub fn verify_uniswap_v3_factory_runtime(code: &[u8]) -> Result<(), ChainError> {
    if code.is_empty() {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory has no runtime code".into(),
        ));
    }
    let interface = uniswap_v3_factory_interface();
    let scan = CodeScan::new(code);
    if scan.truncated_push() {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime has truncated PUSH data".into(),
        ));
    }
    if !scan.has_selector(interface.get_pool) {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime does not evidence getPool selector".into(),
        ));
    }
    if !scan.has_word(&interface.pool_created_topic) {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime does not evidence PoolCreated topic".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UniswapV3PoolIdentity {
    pub token0: Address,
    pub token1: Address,
    pub fee_pips: u32,
    pub tick_spacing: i32,
    pub pool: Address,
}

fn topic_address(topic: &LogTopic, label: &'static str) -> Result<Address, ChainError> {
    let bytes = topic.as_bytes();
    if bytes[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "Uniswap V3 {label} topic has non-canonical address padding"
        )));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&bytes[12..]);
    Address::new(address).map_err(ChainError::from)
}

fn topic_u24(topic: &LogTopic, label: &'static str) -> Result<u32, ChainError> {
    let bytes = topic.as_bytes();
    if bytes[..29].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "Uniswap V3 {label} topic has non-canonical uint24 padding"
        )));
    }
    Ok((u32::from(bytes[29]) << 16) | (u32::from(bytes[30]) << 8) | u32::from(bytes[31]))
}

fn decode_i24_word(word: &[u8; 32]) -> Result<i32, ChainError> {
    let raw =
        (u32::from(word[29]) << 16) | (u32::from(word[30]) << 8) | u32::from(word[31]);
    let negative = raw & 0x0080_0000 != 0;
    let expected_padding = if negative { 0xff } else { 0x00 };
    if word[..29]
        .iter()
        .any(|byte| *byte != expected_padding)
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 tickSpacing has non-canonical int24 sign extension".into(),
        ));
    }
    Ok(if negative {
        (raw | 0xff00_0000) as i32
    } else {
        raw as i32
    })
}

pub fn decode_uniswap_v3_pool_created(
    factory: Address,
    log: &RawLogEnvelope,
) -> Result<UniswapV3PoolIdentity, ChainError> {
    if log.removed() {
        return Err(ChainError::Evidence(
            "removed Uniswap V3 PoolCreated log".into(),
        ));
    }
    if log.emitter() != factory {
        return Err(ChainError::Evidence(
            "wrong Uniswap V3 PoolCreated emitter".into(),
        ));
    }
    let topics = log.topics();
    if topics.len() != 4 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated must have exactly four topics".into(),
        ));
    }
    let interface = uniswap_v3_factory_interface();
    if topics[0].as_bytes() != &interface.pool_created_topic {
        return Err(ChainError::Evidence(
            "wrong Uniswap V3 PoolCreated topic0".into(),
        ));
    }

    let token0 = topic_address(&topics[1], "token0")?;
    let token1 = topic_address(&topics[2], "token1")?;
    if token0 >= token1 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated token order is not canonical".into(),
        ));
    }
    let fee_pips = topic_u24(&topics[3], "fee")?;
    if fee_pips == 0 || fee_pips >= 1_000_000 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated fee is outside flash-fee domain".into(),
        ));
    }

    let words = abi::words(log.data())?;
    if words.len() != 2 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated data must contain tickSpacing and pool".into(),
        ));
    }
    let tick_spacing = decode_i24_word(&words[0])?;
    if tick_spacing <= 0 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated tickSpacing must be positive".into(),
        ));
    }
    let pool_raw = abi::decode_address(&words[1])?
        .ok_or_else(|| ChainError::Evidence("Uniswap V3 PoolCreated emitted zero pool".into()))?;
    let pool = Address::new(pool_raw)?;
    if pool == factory || pool == token0 || pool == token1 {
        return Err(ChainError::Evidence(
            "Uniswap V3 pool collides with factory/token address".into(),
        ));
    }

    Ok(UniswapV3PoolIdentity {
        token0,
        token1,
        fee_pips,
        tick_spacing,
        pool,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use nqc_census_core::Hash32;

    fn address(byte: u8) -> Address {
        Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
    }

    fn hash(byte: u8) -> Hash32 {
        Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
    }

    fn address_topic(address: Address) -> LogTopic {
        let mut word = [0_u8; 32];
        word[12..].copy_from_slice(address.as_bytes());
        LogTopic::new(word)
    }

    fn fee_topic(fee: u32) -> LogTopic {
        let mut word = [0_u8; 32];
        let encoded = fee.to_be_bytes();
        word[29..].copy_from_slice(&encoded[1..]);
        LogTopic::new(word)
    }

    fn i24_word(value: i32) -> [u8; 32] {
        let mut word = if value < 0 { [0xff; 32] } else { [0_u8; 32] };
        let encoded = value.to_be_bytes();
        word[29..].copy_from_slice(&encoded[1..]);
        word
    }

    fn pool_log(token0: Address, token1: Address, fee: u32, tick: i32, pool: Address) -> RawLogEnvelope {
        let interface = uniswap_v3_factory_interface();
        let mut pool_word = [0_u8; 32];
        pool_word[12..].copy_from_slice(pool.as_bytes());
        let mut data = Vec::with_capacity(64);
        data.extend_from_slice(&i24_word(tick));
        data.extend_from_slice(&pool_word);
        RawLogEnvelope::with_topics(
            address(9),
            hash(8),
            0,
            0,
            vec![
                LogTopic::new(interface.pool_created_topic),
                address_topic(token0),
                address_topic(token1),
                fee_topic(fee),
            ],
            data,
            false,
        )
        .unwrap_or_else(|_| unreachable!())
    }

    #[test]
    fn interface_is_derived_from_exact_signatures() {
        let interface = uniswap_v3_factory_interface();
        assert_eq!(interface.get_pool, abi::selector(GET_POOL));
        assert_eq!(interface.pool_created_topic, abi::event_topic(POOL_CREATED));
    }

    #[test]
    fn decodes_canonical_pool_created() -> Result<(), ChainError> {
        let factory = address(9);
        let decoded = decode_uniswap_v3_pool_created(
            factory,
            &pool_log(address(1), address(2), 3_000, 60, address(3)),
        )?;
        assert_eq!(decoded.token0, address(1));
        assert_eq!(decoded.token1, address(2));
        assert_eq!(decoded.fee_pips, 3_000);
        assert_eq!(decoded.tick_spacing, 60);
        assert_eq!(decoded.pool, address(3));
        Ok(())
    }

    #[test]
    fn rejects_noncanonical_fee_topic_padding() {
        let factory = address(9);
        let mut log = pool_log(address(1), address(2), 3_000, 60, address(3));
        let mut bad_fee = *log.topics()[3].as_bytes();
        bad_fee[0] = 1;
        log = RawLogEnvelope::with_topics(
            factory,
            hash(8),
            0,
            0,
            vec![
                LogTopic::new(uniswap_v3_factory_interface().pool_created_topic),
                address_topic(address(1)),
                address_topic(address(2)),
                LogTopic::new(bad_fee),
            ],
            log.data().to_vec(),
            false,
        )
        .unwrap_or_else(|_| unreachable!());
        assert!(decode_uniswap_v3_pool_created(factory, &log).is_err());
    }

    #[test]
    fn rejects_noncanonical_token_order() {
        let factory = address(9);
        let log = pool_log(address(2), address(1), 3_000, 60, address(3));
        assert!(decode_uniswap_v3_pool_created(factory, &log).is_err());
    }

    #[test]
    fn runtime_requires_get_pool_and_pool_created_topic() {
        let interface = uniswap_v3_factory_interface();
        let mut code = Vec::new();
        code.push(0x63);
        code.extend_from_slice(&interface.get_pool);
        code.push(0x7f);
        code.extend_from_slice(&interface.pool_created_topic);
        code.push(0x00);
        assert!(verify_uniswap_v3_factory_runtime(&code).is_ok());
        assert!(verify_uniswap_v3_factory_runtime(&[]).is_err());
    }
}
