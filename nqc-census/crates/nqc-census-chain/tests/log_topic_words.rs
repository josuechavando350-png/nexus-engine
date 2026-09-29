//! RMC-003.2 through the chain-evidence layer: a zero log topic (an indexed
//! zero address) is acquired, certified and replayed like any other topic,
//! while zero transaction and block hashes from a provider stay rejected.

use nqc_census_chain::abi;
use nqc_census_chain::acquire::{raw_log_semantics, Acquisition};
use nqc_census_chain::hex;
use nqc_census_chain::job::{run_job, JobSpec, LogFilter};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSpec;
use nqc_census_chain::testkit::{Faults, SimChain, SimLog, SimNetwork, SimProvider};
use nqc_census_chain::transport::{HttpReply, RetryPolicy, Transport};
use nqc_census_chain::ChainError;
use nqc_census_core::{Address, IdentityError, LogTopic};
use nqc_census_store::{Store, StoreConfig};
use std::error::Error;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const A: u16 = 0x0a01;
const B: u16 = 0x0b01;
const BASE: u64 = 20_000_000;

fn emitter() -> Result<Address, Box<dyn Error>> {
    Ok(Address::new([0x2f; 20])?)
}

fn topic0() -> [u8; 32] {
    abi::event_topic("ImplementationUpdated(address,address)")
}

fn address_word(byte: u8) -> [u8; 32] {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(&[byte; 20]);
    word
}

fn temp_store(name: &str) -> Result<(std::path::PathBuf, Store), Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!(
        "nqc-topic-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let store = Store::create(&root, StoreConfig::standard())?;
    Ok((root, store))
}

fn network() -> Result<(SimNetwork, ProviderSpec, ProviderSpec, SimChain), Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, 120)?;
    // The first update has no predecessor: its indexed "old" address is zero.
    sim.add_log(SimLog {
        block: BASE + 7,
        transaction_index: 1,
        log_index: 0,
        address: emitter()?,
        topics: vec![topic0(), [0; 32], address_word(0xa1)],
        data: vec![],
    });
    sim.add_log(SimLog {
        block: BASE + 90,
        transaction_index: 0,
        log_index: 2,
        address: emitter()?,
        topics: vec![topic0(), address_word(0xa1), address_word(0xa2)],
        data: vec![],
    });
    let chain = Arc::new(Mutex::new(sim.clone()));
    let mut network = SimNetwork::new();
    network.add(A, SimProvider::new(chain.clone(), Faults::default(), 25));
    network.add(B, SimProvider::new(chain, Faults::default(), 1_000));
    Ok((
        network,
        SimProvider::spec(A, "sim-a", 25, 4)?,
        SimProvider::spec(B, "sim-b", 1_000, 2)?,
        sim,
    ))
}

#[test]
fn zero_topic_log_is_scanned_certified_and_replayed() -> TestResult {
    let (network, a, b, sim) = network()?;
    let (root, store) = temp_store("scan")?;
    let acquisition = Acquisition::new(&store, &network, RetryPolicy::none());
    let profile = sim.profile()?;
    let filter = LogFilter::new(vec![emitter()?], vec![topic0()])?;
    let mut per_provider = Vec::new();
    for provider in [&a, &b] {
        let (facts, _) = acquisition.bootstrap(provider, &profile)?;
        let (origin, _) = acquisition.resolve_anchor(provider, &facts.chain, BASE)?;
        let scan = |store_acquisition: &Acquisition<'_>| {
            store_acquisition.scan(
                provider,
                &facts.chain,
                None,
                "test-zero-topic-scan",
                1,
                0x0f31,
                &filter,
                &origin,
                BASE + 119,
                40,
                |log| raw_log_semantics(&log.log.emitter(), "test-zero-topic-scan"),
            )
        };
        let outcome = scan(&acquisition)?;
        assert_eq!(
            (outcome.certified_first, outcome.certified_last),
            (BASE, BASE + 119)
        );
        let logs = outcome.logs()?;
        assert_eq!(logs.len(), 2);
        let topics = logs[0]
            .get("topics")
            .and_then(Json::as_array)
            .ok_or("topics")?;
        assert_eq!(topics[1].as_str(), Some(LogTopic::ZERO.to_hex().as_str()));

        // Resume with no network at all: every window replays from the store.
        let offline = nqc_census_chain::transport::ReplayTransport::new();
        let replayed = scan(&Acquisition::new(&store, &offline, RetryPolicy::none()))?;
        assert_eq!(replayed, outcome);
        per_provider.push((provider.label().to_owned(), logs));
    }
    let agreed = nqc_census_chain::consensus::agree_logs("zero-topic", &per_provider)?
        .map_err(|mismatch| mismatch.reason)?;
    assert_eq!(agreed.len(), 2);
    std::fs::remove_dir_all(root)?;
    Ok(())
}

/// Answers every `eth_getLogs` with one crafted log.
struct CraftedLogs {
    log: Json,
}

impl Transport for CraftedLogs {
    fn post(&self, _provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let request = Json::parse(body)?;
        if request.get("method").and_then(Json::as_str) != Some("eth_getLogs") {
            return Err(ChainError::Replay("unexpected method"));
        }
        let reply = Json::object([
            ("jsonrpc", Json::string("2.0")),
            (
                "id",
                request.get("id").cloned().ok_or(ChainError::Rpc("id"))?,
            ),
            ("result", Json::array([self.log.clone()])),
        ]);
        Ok(HttpReply {
            status: 200,
            body: reply.canonical()?,
        })
    }
}

fn crafted(transaction_hash: [u8; 32], block_hash: [u8; 32]) -> Result<Json, Box<dyn Error>> {
    Ok(Json::object([
        ("address", Json::string(emitter()?.to_hex())),
        (
            "topics",
            Json::array([
                Json::string(hex::encode(&topic0())),
                Json::string(hex::encode(&[0_u8; 32])),
                Json::string(hex::encode(&address_word(0xa1))),
            ]),
        ),
        ("data", Json::string("0x")),
        ("blockNumber", Json::string(hex::quantity(BASE + 7))),
        ("blockHash", Json::string(hex::encode(&block_hash))),
        (
            "transactionHash",
            Json::string(hex::encode(&transaction_hash)),
        ),
        ("transactionIndex", Json::string("0x1")),
        ("logIndex", Json::string("0x0")),
        ("removed", Json::Bool(false)),
    ]))
}

fn decode_through_provider(log: Json) -> Result<Vec<LogTopic>, ChainError> {
    let transport = CraftedLogs { log };
    let provider = SimProvider::spec(A, "crafted", 1_000, 1)?;
    let filter = LogFilter::new(
        vec![Address::new([0x2f; 20]).map_err(ChainError::from)?],
        vec![topic0()],
    )?;
    let spec = JobSpec::new("crafted-logs", 1, 0x0f32, Json::Null)?;
    let mut topics = Vec::new();
    run_job(
        &transport,
        &provider,
        RetryPolicy::none(),
        None,
        &spec,
        |ctx| {
            let logs = ctx.logs(&filter, BASE, BASE + 10)?;
            topics = logs[0].log.topics().to_vec();
            Ok(Json::Null)
        },
    )?;
    Ok(topics)
}

#[test]
fn provider_zero_hashes_stay_rejected_while_zero_topics_decode() -> TestResult {
    let topics = decode_through_provider(crafted([0x42; 32], [0x5b; 32])?)?;
    assert_eq!(topics.len(), 3);
    assert!(topics[1].is_zero());
    assert!(!topics[0].is_zero());

    for log in [crafted([0; 32], [0x5b; 32])?, crafted([0x42; 32], [0; 32])?] {
        assert!(matches!(
            decode_through_provider(log),
            Err(ChainError::Identity(IdentityError::ZeroValue("hash32")))
        ));
    }
    Ok(())
}
