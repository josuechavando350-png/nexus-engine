use crate::DiscoveryError;
use nqc_census_chain::{abi, evm::CodeScan};
use nqc_census_core::{Address, LogTopic, RawLogEnvelope};

const ALL_PAIRS_LENGTH: &str = "allPairsLength()";
const ALL_PAIRS: &str = "allPairs(uint256)";
const GET_PAIR: &str = "getPair(address,address)";
const TOKEN0: &str = "token0()";
const TOKEN1: &str = "token1()";
const PAIR_CREATED: &str = "PairCreated(address,address,address,uint256)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct V2FactoryInterface {
    pub all_pairs_length: [u8; 4],
    pub all_pairs: [u8; 4],
    pub get_pair: [u8; 4],
    pub token0: [u8; 4],
    pub token1: [u8; 4],
    pub pair_created_topic: [u8; 32],
}

pub fn factory_interface() -> V2FactoryInterface {
    V2FactoryInterface {
        all_pairs_length: abi::selector(ALL_PAIRS_LENGTH),
        all_pairs: abi::selector(ALL_PAIRS),
        get_pair: abi::selector(GET_PAIR),
        token0: abi::selector(TOKEN0),
        token1: abi::selector(TOKEN1),
        pair_created_topic: abi::event_topic(PAIR_CREATED),
    }
}

/// Bytecode presence is a necessary condition, not semantic authority. The
/// caller must additionally execute the selectors and reconcile their results.
pub fn verify_factory_runtime(code: &[u8]) -> Result<(), DiscoveryError> {
    if code.is_empty() {
        return Err(DiscoveryError::InvalidInterface(
            "factory has no runtime code",
        ));
    }
    let declared = factory_interface();
    let scan = CodeScan::new(code);
    if scan.truncated_push() {
        return Err(DiscoveryError::InvalidInterface(
            "runtime has truncated PUSH data",
        ));
    }
    for selector in [
        declared.all_pairs_length,
        declared.all_pairs,
        declared.get_pair,
    ] {
        if !scan.has_selector(selector) {
            return Err(DiscoveryError::InvalidInterface(
                "required factory selector not evidenced in runtime",
            ));
        }
    }
    if !scan.has_word(&declared.pair_created_topic) {
        return Err(DiscoveryError::InvalidInterface(
            "PairCreated topic not evidenced in runtime",
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairCreatedEvent {
    pub token0: Address,
    pub token1: Address,
    pub pair: Address,
    pub ordinal: u64,
}

fn topic_address(topic: &LogTopic) -> Result<Address, DiscoveryError> {
    let bytes = topic.as_bytes();
    if bytes[..12].iter().any(|byte| *byte != 0) {
        return Err(DiscoveryError::InvalidInterface(
            "indexed address has non-canonical padding",
        ));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&bytes[12..]);
    Address::new(address).map_err(DiscoveryError::from)
}

pub fn decode_pair_created(
    factory: Address,
    log: &RawLogEnvelope,
) -> Result<PairCreatedEvent, DiscoveryError> {
    if log.removed() {
        return Err(DiscoveryError::InvalidInterface("removed PairCreated log"));
    }
    if log.emitter() != factory {
        return Err(DiscoveryError::InvalidInterface(
            "wrong PairCreated emitter",
        ));
    }
    let topics = log.topics();
    if topics.len() != 3 {
        return Err(DiscoveryError::InvalidInterface(
            "PairCreated must have exactly three topics",
        ));
    }
    let declared = factory_interface();
    if topics[0].as_bytes() != &declared.pair_created_topic {
        return Err(DiscoveryError::InvalidInterface("wrong PairCreated topic0"));
    }
    let token0 = topic_address(&topics[1])?;
    let token1 = topic_address(&topics[2])?;
    if token0 >= token1 {
        return Err(DiscoveryError::InvalidPair(
            "PairCreated token order is not canonical",
        ));
    }
    let words = abi::words(log.data())?;
    if words.len() != 2 {
        return Err(DiscoveryError::InvalidInterface(
            "PairCreated data must contain pair and ordinal",
        ));
    }
    let pair = abi::decode_address(&words[0])?
        .ok_or(DiscoveryError::InvalidPair("PairCreated emitted zero pair"))?;
    let pair = Address::new(pair)?;
    let ordinal = abi::decode_u64(&words[1])?;
    if ordinal == 0 {
        return Err(DiscoveryError::InvalidPair("PairCreated ordinal is zero"));
    }
    if pair == factory || pair == token0 || pair == token1 {
        return Err(DiscoveryError::InvalidPair(
            "pair collides with factory/token address",
        ));
    }
    Ok(PairCreatedEvent {
        token0,
        token1,
        pair,
        ordinal,
    })
}
