use nqc_census_chain::abi;
use nqc_census_chain::acquire::{raw_log_semantics, Acquisition};
use nqc_census_chain::bootstrap::{run_bootstrap, verify_bootstrap};
use nqc_census_chain::boundary::earliest_code_body;
use nqc_census_chain::consensus::{agree, agree_logs, ProviderResult};
use nqc_census_chain::ethereum::{verify_mainnet_header, ChainProfile};
use nqc_census_chain::evm::{CodeScan, OP_SELFDESTRUCT};
use nqc_census_chain::hex;
use nqc_census_chain::job::{chain_read_semantics, JobSpec, LogFilter};
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::{ProviderSet, ProviderSpec};
use nqc_census_chain::rpc::{self, ErrorClass, Reply, RpcCall, RpcErrorObject};
use nqc_census_chain::testkit::{Faults, SimChain, SimLog, SimNetwork, SimProvider};
use nqc_census_chain::transport::{HttpReply, RetryPolicy, Transport};
use nqc_census_chain::ChainError;
use nqc_census_core::{Address, CallOutcome, ChainDomain, Hash32, ObservationError};
use nqc_census_store::{verify, Store, StoreConfig};
use std::error::Error;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const A: u16 = 0x0a01;
const B: u16 = 0x0b01;
const BASE: u64 = 20_000_000;

fn address(byte: u8) -> Result<Address, Box<dyn Error>> {
    Ok(Address::new([byte; 20])?)
}

fn fast_retry() -> RetryPolicy {
    RetryPolicy {
        delays_ms: vec![0; 6],
    }
}

fn temp_store(name: &str) -> Result<(std::path::PathBuf, Store), Box<dyn Error>> {
    let root = std::env::temp_dir().join(format!(
        "nqc-chain-test-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let store = Store::create(&root, StoreConfig::standard())?;
    Ok((root, store))
}

struct Fixture {
    chain: Arc<Mutex<SimChain>>,
    network: SimNetwork,
    a: ProviderSpec,
    b: ProviderSpec,
}

fn fixture(faults_b: Faults) -> Result<Fixture, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, 400)?;
    let emitter = address(0xe1)?;
    let topic = abi::event_topic("Thing(uint256)");
    for (block, log_index) in [
        (BASE + 5, 0),
        (BASE + 5, 3),
        (BASE + 120, 1),
        (BASE + 399, 0),
    ] {
        sim.add_log(SimLog {
            block,
            transaction_index: 2,
            log_index,
            address: emitter,
            topics: vec![topic, [log_index as u8 + 1; 32]],
            data: vec![0xab; 32],
        });
    }
    sim.set_code(
        address(0xc0)?,
        BASE + 77,
        None,
        vec![0x60, 0x00, 0x60, 0x00, 0xf3],
    );
    sim.set_call(
        address(0xc0)?,
        abi::encode_call(abi::selector("value()"), &[]),
        BASE + 77,
        None,
        CallOutcome::Returned(abi::uint_word(42).to_vec()),
    );
    sim.set_call(
        address(0xc0)?,
        abi::encode_call(abi::selector("boom()"), &[]),
        BASE + 77,
        None,
        CallOutcome::Reverted(vec![0x08, 0xc3, 0x79, 0xa0]),
    );
    let chain = Arc::new(Mutex::new(sim));
    let mut network = SimNetwork::new();
    network.add(A, SimProvider::new(chain.clone(), Faults::default(), 50));
    network.add(B, SimProvider::new(chain.clone(), faults_b, 1_000));
    Ok(Fixture {
        chain,
        network,
        a: SimProvider::spec(A, "sim-a", 50, 7)?,
        b: SimProvider::spec(B, "sim-b", 1_000, 3)?,
    })
}

fn domain(acquisition: &Acquisition<'_>, fixture: &Fixture) -> Result<ChainDomain, Box<dyn Error>> {
    let profile = fixture.chain.lock().map_err(|_| "poisoned")?.profile()?;
    let (left, _) = acquisition.bootstrap(&fixture.a, &profile)?;
    let (right, _) = acquisition.bootstrap(&fixture.b, &profile)?;
    assert_eq!(left.chain, right.chain);
    Ok(left.chain)
}

fn filter() -> Result<LogFilter, Box<dyn Error>> {
    Ok(LogFilter::new(
        vec![address(0xe1)?],
        vec![abi::event_topic("Thing(uint256)")],
    )?)
}

fn scan_logs(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    span: u64,
) -> Result<Vec<Json>, ChainError> {
    let (origin, _) = acquisition.resolve_anchor(provider, chain, BASE)?;
    let outcome = acquisition.scan(
        provider,
        chain,
        None,
        "test-thing-scan",
        1,
        0x0f01,
        &filter().map_err(|e| ChainError::Config(e.to_string()))?,
        &origin,
        BASE + 399,
        span,
        |log| raw_log_semantics(&log.log.emitter(), "test-thing-scan"),
    )?;
    assert_eq!(outcome.certified_first, BASE);
    assert_eq!(outcome.certified_last, BASE + 399);
    outcome.logs()
}

// ------------------------------------------------------------------ strict codecs

#[test]
fn json_is_strict_and_canonical() -> TestResult {
    for bad in [
        &b"{\"a\":1,\"a\":2}"[..],
        b"[1,]",
        b"01",
        b"{\"a\":1} x",
        b"\"\\ud800\"",
        b"\"\x01\"",
        b"1.",
        b"-",
    ] {
        assert!(
            Json::parse(bad).is_err(),
            "{:?}",
            String::from_utf8_lossy(bad)
        );
    }
    let deep = format!("{}{}", "[".repeat(80), "]".repeat(80));
    assert!(Json::parse(deep.as_bytes()).is_err());
    let value = Json::parse(br#" { "b" : [true, null, -1.5e3], "a" : "x\u00e9\ud83d\ude00\n" } "#)?;
    let canonical = value.canonical()?;
    assert_eq!(
        String::from_utf8(canonical.clone())?,
        "{\"a\":\"x\u{e9}\u{1f600}\\n\",\"b\":[true,null,-1.5e3]}"
    );
    assert_eq!(Json::parse(&canonical)?.canonical()?, canonical);
    assert!(Json::object([("k", Json::Null), ("k", Json::Null)])
        .canonical()
        .is_err());
    assert!(Json::Number("1,2".into()).canonical().is_err());
    Ok(())
}

#[test]
fn hex_quantities_and_data_are_strict() -> TestResult {
    assert_eq!(hex::decode_quantity_u64("0x0")?, 0);
    assert_eq!(hex::decode_quantity_u64("0x1a")?, 26);
    for bad in ["0x", "0x01", "1a", "0xg1", "0x10000000000000000"] {
        assert!(hex::decode_quantity_u64(bad).is_err(), "{bad}");
    }
    assert_eq!(hex::decode_data("0xAbCd")?, vec![0xab, 0xcd]);
    assert!(hex::decode_data("0xabc").is_err());
    assert!(hex::decode_fixed::<2>("0xabcdef").is_err());
    assert_eq!(hex::encode(&[0xab, 0x01]), "0xab01");
    Ok(())
}

#[test]
fn rpc_ids_are_positional_and_replies_strict() -> TestResult {
    let call = RpcCall::new("eth_blockNumber", Json::array([]));
    let same = RpcCall::new("eth_blockNumber", Json::array([]));
    let other = RpcCall::new("eth_chainId", Json::array([]));
    assert_eq!(call.request_bytes()?, same.request_bytes()?);
    assert_eq!(
        String::from_utf8(call.request_bytes()?)?,
        "{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\",\"params\":[]}"
    );
    assert_ne!(call.content_key()?, other.content_key()?);
    let batch_bytes = String::from_utf8(rpc::batch_request_bytes(&[other.clone(), call.clone()])?)?;
    assert!(batch_bytes.starts_with("[{\"id\":1,\"jsonrpc\":\"2.0\",\"method\":\"eth_chainId\""));
    assert!(batch_bytes.contains("{\"id\":2,\"jsonrpc\":\"2.0\",\"method\":\"eth_blockNumber\""));
    let id = rpc::SINGLE_ID;

    let good = format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":\"0x1\"}}");
    assert_eq!(
        rpc::parse_reply(good.as_bytes(), id)?,
        Reply::Result(Json::string("0x1"))
    );
    for bad in [
        format!(
            "{{\"jsonrpc\":\"2.0\",\"id\":{},\"result\":\"0x1\"}}",
            id + 1
        ),
        format!("{{\"jsonrpc\":\"2.0\",\"id\":\"{id}\",\"result\":\"0x1\"}}"),
        format!("{{\"jsonrpc\":\"1.0\",\"id\":{id},\"result\":\"0x1\"}}"),
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":1,\"error\":{{\"code\":1}}}}"),
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id}}}"),
        format!("{{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":1,\"extra\":1}}"),
    ] {
        assert!(rpc::parse_reply(bad.as_bytes(), id).is_err(), "{bad}");
    }

    let ids = rpc::batch_ids(2);
    let batch = "[{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x1\"},{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x2\"}]";
    assert_eq!(rpc::parse_batch_reply(batch.as_bytes(), &ids)?.len(), 2);
    let missing = "[{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}]";
    assert!(rpc::parse_batch_reply(missing.as_bytes(), &ids).is_err());
    let repeated = "[{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"},{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}]";
    assert!(rpc::parse_batch_reply(repeated.as_bytes(), &ids).is_err());
    assert!(rpc::batch_request_bytes(&[call.clone(), same]).is_err());
    Ok(())
}

#[test]
fn error_classes_never_turn_failures_into_observations() {
    let error = |code: i64, message: &str, data: Option<Json>| RpcErrorObject {
        code,
        message: message.into(),
        data,
    };
    assert_eq!(
        rpc::classify(&error(
            3,
            "execution reverted",
            Some(Json::string("0x08c379a0"))
        )),
        ErrorClass::Revert(vec![0x08, 0xc3, 0x79, 0xa0])
    );
    assert_eq!(
        rpc::classify(&error(-32000, "execution reverted", None)),
        ErrorClass::RevertWithoutData
    );
    assert_eq!(
        rpc::classify(&error(-32603, "service temporarily unavailable", None)),
        ErrorClass::RateLimited
    );
    assert_eq!(
        rpc::classify(&error(
            429,
            "Your app has exceeded its compute units per second capacity",
            None
        )),
        ErrorClass::RateLimited
    );
    assert_eq!(
        rpc::classify(&error(
            35,
            "ranges over 10000 blocks are not supported on free plan",
            None
        )),
        ErrorClass::RangeTooLarge
    );
    assert_eq!(
        rpc::classify(&error(
            -32600,
            "You can make eth_getLogs requests with up to a 10 block range",
            None
        )),
        ErrorClass::RangeTooLarge
    );
    assert_eq!(
        rpc::classify(&error(-32000, "missing trie node abc", None)),
        ErrorClass::ArchiveUnavailable
    );
    assert_eq!(
        rpc::classify(&error(4444, "pruned history unavailable", None)),
        ErrorClass::ArchiveUnavailable
    );
    assert_eq!(
        rpc::classify(&error(-32601, "method not found", None)),
        ErrorClass::Other
    );
}

#[test]
fn abi_decoding_is_canonical() -> TestResult {
    let mut word = abi::address_word(&[0x11; 20]);
    assert_eq!(abi::decode_address(&word)?, Some([0x11; 20]));
    assert_eq!(abi::decode_address(&[0; 32])?, None);
    word[0] = 1;
    assert!(abi::decode_address(&word).is_err());
    assert!(abi::decode_bool(&abi::uint_word(2)).is_err());

    let mut array = Vec::new();
    array.extend_from_slice(&abi::uint_word(32));
    array.extend_from_slice(&abi::uint_word(2));
    array.extend_from_slice(&abi::address_word(&[0x22; 20]));
    array.extend_from_slice(&[0; 32]);
    assert_eq!(
        abi::decode_address_array(&array)?,
        vec![Some([0x22; 20]), None]
    );
    let mut trailing = array.clone();
    trailing.extend_from_slice(&[0; 32]);
    assert!(abi::decode_address_array(&trailing).is_err());
    let mut offset = array.clone();
    offset[31] = 64;
    assert!(abi::decode_address_array(&offset).is_err());
    assert!(abi::decode_address_array(&array[..70]).is_err());
    assert_eq!(abi::selector("getReservesList()"), [0xd1, 0x94, 0x6d, 0xbc]);
    assert_eq!(
        hex::encode(&abi::event_topic(
            "ReserveInitialized(address,address,address,address,address)"
        )),
        "0x3a0ca721fc364424566385a1aa271ed508cc2c0949c2272575fb3013a163a45f"
    );
    Ok(())
}

#[test]
fn bytecode_scan_skips_push_data_and_metadata() {
    // PUSH3 0x0542975c? no: PUSH4 0x0542975c, PUSH1 0xff (data, not SELFDESTRUCT),
    // PUSH3 0x6b1d5f (selector 0x006b1d5f shortened), STOP, then metadata.
    let mut code = vec![
        0x63, 0x05, 0x42, 0x97, 0x5c, 0x60, 0xff, 0x62, 0x6b, 0x1d, 0x5f, 0x00,
    ];
    let metadata = [0xa2, 0x64, 0xff, 0xff];
    code.extend_from_slice(&metadata);
    code.extend_from_slice(&(metadata.len() as u16).to_be_bytes());
    let scan = CodeScan::new(&code);
    assert!(scan.has_selector([0x05, 0x42, 0x97, 0x5c]));
    assert!(scan.has_selector([0x00, 0x6b, 0x1d, 0x5f]));
    assert!(!scan.has_opcode(OP_SELFDESTRUCT));
    assert_eq!(scan.metadata_bytes(), 6);
    assert!(CodeScan::new(&[0xff]).has_opcode(OP_SELFDESTRUCT));
    assert!(CodeScan::new(&[0x61, 0x01]).truncated_push());
    let mut push20 = vec![0x73];
    push20.extend_from_slice(&[0x33; 20]);
    assert!(CodeScan::new(&push20)
        .push20_candidates()
        .contains(&[0x33; 20]));
}

#[test]
fn provider_sets_require_distinct_sources() -> TestResult {
    let spec = |ns: u16, label: &str, url: &str, operator: &str| {
        ProviderSpec::new(
            ns,
            label,
            url,
            operator,
            0,
            10,
            10,
            nqc_census_chain::provider::PinningMode::Eip1898,
        )
    };
    let a = spec(1, "a", "https://a.example", "Operator A")?;
    assert!(ProviderSet::new(vec![a.clone()]).is_err());
    assert!(ProviderSet::new(vec![
        a.clone(),
        spec(2, "b", "https://a.example", "Operator B")?
    ])
    .is_err());
    assert!(ProviderSet::new(vec![
        a.clone(),
        spec(2, "b", "https://b.example", "operator a")?
    ])
    .is_err());
    assert!(ProviderSet::new(vec![
        a.clone(),
        spec(1, "b", "https://b.example", "Operator B")?
    ])
    .is_err());
    assert!(spec(3, "c", "http://c.example", "Operator C").is_err());
    assert_eq!(
        ProviderSet::new(vec![a, spec(2, "b", "https://b.example", "Operator B")?])?.len(),
        2
    );
    Ok(())
}

// ------------------------------------------------------------------ headers

#[test]
fn real_mainnet_header_is_reconstructed_and_rehashed() -> TestResult {
    let fixture = Json::parse(include_bytes!("fixtures/mainnet-block-25437474.json"))?;
    let block = fixture.get("block").ok_or("fixture block")?.clone();
    let header = verify_mainnet_header(&block)?;
    assert_eq!(header.number(), 25_437_474);
    assert_eq!(
        header.hash().to_hex(),
        "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8"
    );
    assert_eq!(header.envelope().field_count(), 21);
    assert_eq!(
        Hash32::new(*header.envelope().parent_hash())?.to_hex(),
        "0x033656168ee1dba1934f77171fe572c866282e97738b79434cb8c01b6e6f88f2"
    );

    let Json::Object(members) = block else {
        return Err("block is not an object".into());
    };
    let replace = |key: &str, value: Json| -> Json {
        Json::Object(
            members
                .iter()
                .map(|(k, v)| (k.clone(), if k == key { value.clone() } else { v.clone() }))
                .collect(),
        )
    };
    let tampered = replace("gasUsed", Json::string("0x1ed048f"));
    assert!(matches!(
        verify_mainnet_header(&tampered),
        Err(ChainError::Observation(
            ObservationError::HeaderHashMismatch
        ))
    ));
    let unknown = {
        let mut extended = members.clone();
        extended.push(("blockAccessListHash".into(), Json::string("0x00")));
        Json::Object(extended)
    };
    assert!(matches!(
        verify_mainnet_header(&unknown),
        Err(ChainError::UnsupportedHeaderField(field)) if field == "blockAccessListHash"
    ));
    let missing: Vec<_> = members
        .iter()
        .filter(|(k, _)| k != "requestsHash")
        .cloned()
        .collect();
    assert!(matches!(
        verify_mainnet_header(&Json::Object(missing)),
        Err(ChainError::Header(_))
    ));
    let padded = replace("number", Json::string("0x018424a2"));
    assert!(verify_mainnet_header(&padded).is_err());
    Ok(())
}

// ------------------------------------------------------------------ acquisition

#[test]
fn bootstrap_derives_one_chain_domain_and_rejects_wrong_genesis() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("bootstrap")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    assert_eq!(chain.chain_id(), 1);
    let wrong = ChainProfile::new(1, Hash32::new([0x99; 32])?, 1, Hash32::new([0x98; 32])?)?;
    assert!(matches!(
        acquisition.bootstrap(&fixture.a, &wrong),
        Err(ChainError::Config(_))
    ));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn bootstrap_report_replays_offline_and_rejects_tampering() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let profile = fixture.chain.lock().map_err(|_| "poisoned")?.profile()?;
    let providers = ProviderSet::new(vec![fixture.a.clone(), fixture.b.clone()])?;
    let (root, store) = temp_store("bootstrap-report")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let (report, chain, anchor) = run_bootstrap(&acquisition, &providers, &profile, BASE + 300)?;
    assert_eq!(anchor.block_number(), BASE + 300);

    // Offline: no network at all, only the store.
    let (replayed_chain, replayed_anchor) =
        verify_bootstrap(&store, &providers, &profile, &report)?;
    assert_eq!((replayed_chain, replayed_anchor), (chain, anchor.clone()));
    let reparsed = Json::parse(&report.canonical()?)?;
    verify_bootstrap(&store, &providers, &profile, &reparsed)?;

    let forged = report.canonical_string()?.replace(
        &anchor.block_hash().to_hex(),
        &Hash32::new([0x5a; 32])?.to_hex(),
    );
    assert!(matches!(
        verify_bootstrap(
            &store,
            &providers,
            &profile,
            &Json::parse(forged.as_bytes())?
        ),
        Err(ChainError::Evidence(_))
    ));
    let substituted = ProviderSet::new(vec![
        fixture.a.clone(),
        SimProvider::spec(B, "sim-substitute", 1_000, 3)?,
    ])?;
    assert!(matches!(
        verify_bootstrap(&store, &substituted, &profile, &report),
        Err(ChainError::Evidence(_))
    ));
    let (empty_root, empty) = temp_store("bootstrap-empty")?;
    assert!(verify_bootstrap(&empty, &providers, &profile, &report).is_err());
    std::fs::remove_dir_all(empty_root)?;
    std::fs::remove_dir_all(root)?;

    let mut forked = Faults::default();
    forked.forked_headers.insert(BASE + 300);
    let forked_fixture = crate::fixture(forked)?;
    let (root, store) = temp_store("bootstrap-fork")?;
    let acquisition = Acquisition::new(&store, &forked_fixture.network, fast_retry());
    assert!(matches!(
        run_bootstrap(&acquisition, &providers, &profile, BASE + 300),
        Err(ChainError::Consensus(_))
    ));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn point_job_commits_and_resumes_by_replay_without_network() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("point")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let (anchor, _) = acquisition.resolve_anchor(&fixture.a, &chain, BASE + 200)?;
    let spec = JobSpec::new(
        "test-point",
        1,
        0x0f02,
        Json::object([("anchor", Json::uint(BASE + 200))]),
    )?;
    let target = address(0xc0)?;
    let body = |ctx: &mut nqc_census_chain::job::JobContext<'_>| -> Result<Json, ChainError> {
        let semantics = chain_read_semantics()?;
        let code = ctx.code(target, &anchor, semantics)?;
        let calls = ctx.calls(
            &[
                (target, abi::encode_call(abi::selector("value()"), &[])),
                (target, abi::encode_call(abi::selector("boom()"), &[])),
                (target, abi::encode_call(abi::selector("missing()"), &[])),
            ],
            &anchor,
            semantics,
        )?;
        assert_eq!(code.payload().code().len(), 5);
        assert_eq!(
            calls[0].payload().outcome(),
            &CallOutcome::Returned(abi::uint_word(42).to_vec())
        );
        assert_eq!(
            calls[1].payload().outcome(),
            &CallOutcome::Reverted(vec![0x08, 0xc3, 0x79, 0xa0])
        );
        assert_eq!(
            calls[2].payload().outcome(),
            &CallOutcome::Reverted(Vec::new())
        );
        Ok(Json::object([
            ("code_len", Json::uint(code.payload().code().len() as u64)),
            (
                "value",
                Json::string(hex::encode(calls[0].payload().outcome().output())),
            ),
        ]))
    };
    let first = acquisition.point(&fixture.a, &chain, None, &spec, &anchor, body)?;
    let served = fixture.network.served(A);
    let second = acquisition.point(&fixture.a, &chain, None, &spec, &anchor, body)?;
    assert_eq!(first, second);
    assert_eq!(
        fixture.network.served(A),
        served,
        "resume must not touch the network"
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn scans_are_window_checkpointed_certified_and_provider_independent_in_result() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("scan")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let left = scan_logs(&acquisition, &fixture.a, &chain, 100)?;
    let right = scan_logs(&acquisition, &fixture.b, &chain, 400)?;
    assert_eq!(left.len(), 4);
    let agreed = agree_logs("thing", &[("sim-a".into(), left), ("sim-b".into(), right)])?;
    assert_eq!(agreed.map_err(|m| format!("{:?}", m.reason))?.len(), 4);
    let report = verify::verify_store(
        &root,
        &verify::VerifyRequest {
            ranges: Vec::new(),
            tips: Vec::new(),
        },
    )
    .map_err(|failure| format!("{failure:?}"))?;
    assert!(report.streams.len() >= 2);
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn omitted_log_is_a_provider_mismatch_not_a_vote() -> TestResult {
    let mut faults = Faults::default();
    faults.omit_logs.insert((BASE + 120, 1));
    let fixture = fixture(faults)?;
    let (root, store) = temp_store("omit")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let left = scan_logs(&acquisition, &fixture.a, &chain, 100)?;
    let right = scan_logs(&acquisition, &fixture.b, &chain, 400)?;
    let mismatch = agree_logs("thing", &[("sim-a".into(), left), ("sim-b".into(), right)])?
        .err()
        .ok_or("disagreement must not be voted away")?;
    assert_eq!(mismatch.reason, "LOG_SETS_DIFFER");
    let record = mismatch.record();
    assert_eq!(
        record.get("status").and_then(Json::as_str),
        Some("UNEXPLAINED")
    );
    assert!(record
        .canonical_string()?
        .contains(&format!("\"block\":{}", BASE + 120)));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn orphan_log_fails_closed() -> TestResult {
    let mut faults = Faults::default();
    faults.orphan_log_hash.insert((BASE + 5, 3));
    let fixture = fixture(faults)?;
    let (root, store) = temp_store("orphan")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let result = scan_logs(&acquisition, &fixture.b, &chain, 400);
    assert!(matches!(
        result,
        Err(ChainError::NonCanonical { what: "log", .. })
    ));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

struct FailAfter<'a> {
    inner: &'a dyn Transport,
    remaining: AtomicU64,
}

impl Transport for FailAfter<'_> {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        if self
            .remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_err()
        {
            return Err(ChainError::Transport {
                provider: provider.label().into(),
                reason: "injected crash".into(),
            });
        }
        self.inner.post(provider, body)
    }
}

#[test]
fn interrupted_scan_resumes_to_the_identical_evidence_root() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let request = verify::VerifyRequest {
        ranges: Vec::new(),
        tips: Vec::new(),
    };

    let (clean_root, clean) = temp_store("clean")?;
    {
        let acquisition = Acquisition::new(&clean, &fixture.network, fast_retry());
        let chain = domain(&acquisition, &fixture)?;
        scan_logs(&acquisition, &fixture.a, &chain, 100)?;
    }
    let clean_report = verify::verify_store(&clean_root, &request).map_err(|f| format!("{f:?}"))?;

    let (crash_root, crashed) = temp_store("crash")?;
    let chain = {
        let acquisition = Acquisition::new(&crashed, &fixture.network, fast_retry());
        domain(&acquisition, &fixture)?
    };
    let failing = FailAfter {
        inner: &fixture.network,
        remaining: AtomicU64::new(6),
    };
    {
        let acquisition = Acquisition::new(&crashed, &failing, RetryPolicy::none());
        assert!(scan_logs(&acquisition, &fixture.a, &chain, 100).is_err());
    }
    {
        let acquisition = Acquisition::new(&crashed, &fixture.network, fast_retry());
        scan_logs(&acquisition, &fixture.a, &chain, 100)?;
    }
    let crash_report = verify::verify_store(&crash_root, &request).map_err(|f| format!("{f:?}"))?;
    assert_eq!(clean_report.evidence_root, crash_report.evidence_root);
    std::fs::remove_dir_all(clean_root)?;
    std::fs::remove_dir_all(crash_root)?;
    Ok(())
}

#[test]
fn reorg_between_windows_breaks_the_checkpoint_chain() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("reorg")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let failing = FailAfter {
        inner: &fixture.network,
        remaining: AtomicU64::new(3),
    };
    {
        let partial = Acquisition::new(&store, &failing, RetryPolicy::none());
        assert!(scan_logs(&partial, &fixture.a, &chain, 100).is_err());
    }
    fixture
        .chain
        .lock()
        .map_err(|_| "poisoned")?
        .reorg_from(BASE + 50, 0x77)?;
    let result = scan_logs(&acquisition, &fixture.a, &chain, 100);
    assert!(
        matches!(
            result,
            Err(ChainError::Store(
                nqc_census_store::StoreError::Discontinuity { .. }
            ))
        ),
        "a window extending an orphaned predecessor must not commit: {result:?}"
    );
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn range_hole_is_never_certified() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("hole")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let failing = FailAfter {
        inner: &fixture.network,
        remaining: AtomicU64::new(4),
    };
    let partial = Acquisition::new(&store, &failing, RetryPolicy::none());
    assert!(scan_logs(&partial, &fixture.a, &chain, 100).is_err());
    let (origin, _) = acquisition.resolve_anchor(&fixture.a, &chain, BASE)?;
    let spec = JobSpec::new(
        "test-thing-scan",
        1,
        0x0f01,
        Json::object([
            ("filter", filter()?.descriptor()),
            ("first", Json::uint(BASE)),
            ("last", Json::uint(BASE + 399)),
            ("span", Json::uint(100)),
        ]),
    )?;
    let scope = spec.scope(&fixture.a, &chain, None, &origin)?;
    assert!(store.certify_range(&scope, BASE, BASE + 399).is_err());
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn earliest_code_boundary_has_predecessor_proof() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let (root, store) = temp_store("boundary")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let (anchor, _) = acquisition.resolve_anchor(&fixture.b, &chain, BASE + 399)?;
    let spec = JobSpec::new(
        "test-boundary",
        1,
        0x0f03,
        Json::object([("account", Json::uint(0xc0))]),
    )?;
    let account = address(0xc0)?;
    let output = acquisition.point(&fixture.b, &chain, None, &spec, &anchor, |ctx| {
        earliest_code_body(ctx, account, BASE, BASE + 399)
    })?;
    let result = output.result_json()?;
    assert_eq!(
        result.get("first_code_block").and_then(Json::as_i64),
        Some((BASE + 77) as i64)
    );
    let predecessor = result.get("predecessor").ok_or("predecessor")?;
    assert_eq!(predecessor.get("code_len").and_then(Json::as_i64), Some(0));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn archive_gaps_and_rate_limits_are_typed_not_observed() -> TestResult {
    let faults = Faults {
        archive_before: Some(BASE + 300),
        rate_limit_first: 3,
        ..Faults::default()
    };
    let fixture = fixture(faults)?;
    let (root, store) = temp_store("archive")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let (anchor, _) = acquisition.resolve_anchor(&fixture.b, &chain, BASE + 200)?;
    let spec = JobSpec::new(
        "test-archive",
        1,
        0x0f04,
        Json::object([("n", Json::uint(1))]),
    )?;
    let result = acquisition.point(&fixture.b, &chain, None, &spec, &anchor, |ctx| {
        ctx.code(
            address(0xc0).map_err(|e| ChainError::Config(e.to_string()))?,
            &anchor,
            chain_read_semantics()?,
        )?;
        Ok(Json::Null)
    });
    assert!(matches!(
        result,
        Err(ChainError::ArchiveStateUnavailable { .. })
    ));
    std::fs::remove_dir_all(root)?;
    Ok(())
}

#[test]
fn consensus_requires_two_distinct_providers_and_identical_results() -> TestResult {
    let result = |provider: &str, value: u64| ProviderResult {
        provider: provider.into(),
        manifest: "m".into(),
        result: Json::object([("x", Json::uint(value))]),
    };
    assert!(agree("s", &[result("a", 1)]).is_err());
    assert!(agree("s", &[result("a", 1), result("a", 1)]).is_err());
    assert!(agree("s", &[result("a", 1), result("b", 1)])?.is_ok());
    let mismatch = agree("s", &[result("a", 1), result("b", 2)])?
        .err()
        .ok_or("must mismatch")?;
    assert_eq!(mismatch.reason, "RESULTS_DIFFER");
    Ok(())
}

#[test]
fn admin_context_calls_are_bound_into_observations() -> TestResult {
    let fixture = fixture(Faults::default())?;
    let admin = address(0xad)?;
    let selector = abi::encode_call(abi::selector("implementation()"), &[]);
    fixture.chain.lock().map_err(|_| "poisoned")?.set_call_from(
        address(0xc0)?,
        admin,
        selector.clone(),
        BASE,
        None,
        CallOutcome::Returned(abi::address_word(&[0x11; 20]).to_vec()),
    );
    let (root, store) = temp_store("context")?;
    let acquisition = Acquisition::new(&store, &fixture.network, fast_retry());
    let chain = domain(&acquisition, &fixture)?;
    let (anchor, _) = acquisition.resolve_anchor(&fixture.a, &chain, BASE + 300)?;
    let spec = JobSpec::new(
        "test-context",
        1,
        0x0f05,
        Json::object([("n", Json::uint(1))]),
    )?;
    let target = address(0xc0)?;
    acquisition.point(&fixture.a, &chain, None, &spec, &anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let anonymous = ctx.call(target, selector.clone(), &anchor, semantics)?;
        assert_eq!(
            anonymous.payload().outcome(),
            &CallOutcome::Reverted(Vec::new())
        );
        let context = nqc_census_core::CallContext::new(Some(admin), [0; 32], None);
        let admin_call = ctx
            .calls_in_context(&[(target, selector.clone())], context, &anchor, semantics)?
            .remove(0);
        assert_eq!(admin_call.payload().context().caller(), Some(admin));
        assert_eq!(
            abi::decode_address(&abi::single_word(admin_call.payload().outcome().output())?)?,
            Some([0x11; 20])
        );
        assert_ne!(
            anonymous.envelope().digest(),
            admin_call.envelope().digest()
        );
        Ok(Json::Null)
    })?;
    std::fs::remove_dir_all(root)?;
    Ok(())
}

fn partition_scan(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    first: u64,
    last: u64,
) -> Result<
    (
        nqc_census_chain::acquire::ScanOutcome,
        nqc_census_core::StateAnchor,
        nqc_census_core::StateAnchor,
    ),
    Box<dyn Error>,
> {
    let (origin, _) = acquisition.resolve_anchor(provider, chain, first)?;
    let (end, _) = acquisition.resolve_anchor(provider, chain, last)?;
    let outcome = acquisition.scan(
        provider,
        chain,
        None,
        "test-thing-scan",
        1,
        0x0f01,
        &filter()?,
        &origin,
        last,
        50,
        |log| raw_log_semantics(&log.log.emitter(), "test-thing-scan"),
    )?;
    Ok((outcome, origin, end))
}

#[test]
fn partitioned_scans_merge_and_link_by_parent_hash() -> TestResult {
    use nqc_census_chain::acquire::{partition_plan, verify_partition_linkage};
    use nqc_census_chain::merge::merge_store;
    let fixture = fixture(Faults::default())?;
    let plan = partition_plan(BASE, BASE + 399, 2)?;
    assert_eq!(plan, vec![(BASE, BASE + 199), (BASE + 200, BASE + 399)]);
    let (root_one, one) = temp_store("part-one")?;
    let (root_two, two) = temp_store("part-two")?;
    let (root_merged, merged) = temp_store("merged")?;
    let chain = domain(
        &Acquisition::new(&one, &fixture.network, fast_retry()),
        &fixture,
    )?;
    let first = partition_scan(
        &Acquisition::new(&one, &fixture.network, fast_retry()),
        &fixture.a,
        &chain,
        plan[0].0,
        plan[0].1,
    )?;
    let second = partition_scan(
        &Acquisition::new(&two, &fixture.network, fast_retry()),
        &fixture.a,
        &chain,
        plan[1].0,
        plan[1].1,
    )?;
    let report_one = merge_store(&one, &merged, &[])?;
    let report_two = merge_store(&two, &merged, &[])?;
    assert_eq!(report_one.streams + report_two.streams, 2);
    assert!(
        merge_store(&one, &merged, &[])?.checkpoints > 0,
        "re-merge is idempotent"
    );
    let mut logs = first.0.logs()?;
    logs.extend(second.0.logs()?);
    assert_eq!(logs.len(), 4);
    verify_partition_linkage(BASE, BASE + 399, &[first.clone(), second.clone()])?;
    assert!(verify_partition_linkage(BASE, BASE + 399, std::slice::from_ref(&first)).is_err());
    assert!(verify_partition_linkage(BASE, BASE + 399, &[second.clone(), first.clone()]).is_err());

    // A reorg between the two partitions breaks the boundary linkage.
    fixture
        .chain
        .lock()
        .map_err(|_| "poisoned")?
        .reorg_from(BASE + 150, 0x61)?;
    let (root_three, three) = temp_store("part-three")?;
    let reorged = partition_scan(
        &Acquisition::new(&three, &fixture.network, fast_retry()),
        &fixture.a,
        &chain,
        plan[1].0,
        plan[1].1,
    )?;
    assert!(matches!(
        verify_partition_linkage(BASE, BASE + 399, &[first, reorged]),
        Err(ChainError::NonCanonical {
            what: "partition boundary",
            ..
        })
    ));
    for root in [root_one, root_two, root_merged, root_three] {
        std::fs::remove_dir_all(root)?;
    }
    Ok(())
}
