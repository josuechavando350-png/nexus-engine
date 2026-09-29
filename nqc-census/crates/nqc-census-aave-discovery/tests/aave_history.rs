//! End-to-end RMC-006 history reconstruction on a synthetic chain: the same
//! code path the live run uses, with adversarial lineages and providers.
//! Testkit chains are synthetic and never evidence.

use nqc_census_aave_discovery::history::{history_with, HistoryPlan};
use nqc_census_aave_discovery::resume::resume_check;
use nqc_census_chain::abi;
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::job::add_manifest_exchanges;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::{ProviderSet, ProviderSpec};
use nqc_census_chain::testkit::{Faults, SimChain, SimLog, SimNetwork, SimProvider};
use nqc_census_chain::transport::{HttpReply, ReplayTransport, RetryPolicy, Transport};
use nqc_census_chain::ChainError;
use nqc_census_core::Address;
use nqc_census_store::{Store, StoreConfig};
use std::error::Error;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 300;
const A: u16 = 0x0a01;
const B: u16 = 0x0b01;

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!("nonzero"))
}

fn word(address: Address) -> [u8; 32] {
    abi::address_word(address.as_bytes())
}

fn id(name: &str) -> [u8; 32] {
    let mut out = [0_u8; 32];
    out[..name.len()].copy_from_slice(name.as_bytes());
    out
}

const ZERO: [u8; 32] = [0; 32];

fn provider_root() -> Address {
    address(0x2f)
}
fn pool() -> Address {
    address(0x87)
}
fn configurator() -> Address {
    address(0x64)
}

struct Deployment {
    sim: SimChain,
    reserves: Vec<(u64, Address, Address, Address)>,
    configurator: Address,
    configurator_implementation: Address,
    pool_implementation: Address,
}

fn log(
    block: u64,
    tx: u32,
    index: u32,
    emitter: Address,
    topics: Vec<[u8; 32]>,
    data: Vec<u8>,
) -> SimLog {
    SimLog {
        block,
        transaction_index: tx,
        log_index: index,
        address: emitter,
        topics,
        data,
    }
}

fn topic(signature: &str) -> [u8; 32] {
    abi::event_topic(signature)
}

fn reserve_initialized(block: u64, emitter: Address, asset: Address) -> SimLog {
    let a_token = address(asset.as_bytes()[0].wrapping_add(0x10));
    let variable = address(asset.as_bytes()[0].wrapping_add(0x20));
    let mut data = Vec::new();
    data.extend_from_slice(&word(address(asset.as_bytes()[0].wrapping_add(0x30))));
    data.extend_from_slice(&word(variable));
    data.extend_from_slice(&word(address(0x99)));
    log(
        block,
        0,
        0,
        emitter,
        vec![
            topic("ReserveInitialized(address,address,address,address,address)"),
            word(asset),
            word(a_token),
        ],
        data,
    )
}

fn reserve_dropped(block: u64, emitter: Address, asset: Address) -> SimLog {
    log(
        block,
        0,
        0,
        emitter,
        vec![topic("ReserveDropped(address)"), word(asset)],
        vec![],
    )
}

/// A deployment whose Pool and PoolConfigurator are created through the
/// provider (initial updates carry a zero `old` topic), upgraded once each,
/// with three reserves, one drop and a reused slot.
fn deployment() -> Result<Deployment, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, LENGTH)?;
    let root = provider_root();
    for (account, from) in [
        (root, BASE + 10),
        (pool(), BASE + 20),
        (configurator(), BASE + 30),
    ] {
        sim.set_code(account, from, None, vec![0x60, 0x80, 0x60, 0x40]);
    }
    let (pool_v1, pool_v2) = (address(0xa1), address(0xa2));
    let (conf_v1, conf_v2) = (address(0xc1), address(0xc2));
    for entry in [
        log(
            BASE + 15,
            0,
            0,
            root,
            vec![
                topic("AddressSet(bytes32,address,address)"),
                id("PRICE_ORACLE"),
                ZERO,
                word(address(0x54)),
            ],
            vec![],
        ),
        log(
            BASE + 20,
            0,
            0,
            root,
            vec![
                topic("ProxyCreated(bytes32,address,address)"),
                id("POOL"),
                word(pool()),
                word(pool_v1),
            ],
            vec![],
        ),
        log(
            BASE + 20,
            0,
            1,
            root,
            vec![topic("PoolUpdated(address,address)"), ZERO, word(pool_v1)],
            vec![],
        ),
        log(
            BASE + 30,
            0,
            0,
            root,
            vec![
                topic("ProxyCreated(bytes32,address,address)"),
                id("POOL_CONFIGURATOR"),
                word(configurator()),
                word(conf_v1),
            ],
            vec![],
        ),
        log(
            BASE + 30,
            0,
            1,
            root,
            vec![
                topic("PoolConfiguratorUpdated(address,address)"),
                ZERO,
                word(conf_v1),
            ],
            vec![],
        ),
        log(
            BASE + 100,
            0,
            0,
            root,
            vec![
                topic("PoolConfiguratorUpdated(address,address)"),
                word(conf_v1),
                word(conf_v2),
            ],
            vec![],
        ),
        log(
            BASE + 110,
            0,
            0,
            root,
            vec![
                topic("PoolUpdated(address,address)"),
                word(pool_v1),
                word(pool_v2),
            ],
            vec![],
        ),
    ] {
        sim.add_log(entry);
    }
    let (a1, a2, a3, a4) = (address(0x01), address(0x02), address(0x03), address(0x04));
    for entry in [
        reserve_initialized(BASE + 40, configurator(), a1),
        reserve_initialized(BASE + 41, configurator(), a2),
        reserve_initialized(BASE + 50, configurator(), a3),
        reserve_dropped(BASE + 60, configurator(), a2),
        reserve_initialized(BASE + 70, configurator(), a4),
    ] {
        sim.add_log(entry);
    }
    let token = |asset: Address, offset: u8| address(asset.as_bytes()[0].wrapping_add(offset));
    Ok(Deployment {
        sim,
        // (reserve id, asset, aToken, variable debt token): a4 reuses slot 1.
        reserves: vec![
            (0, a1, token(a1, 0x10), token(a1, 0x20)),
            (1, a4, token(a4, 0x10), token(a4, 0x20)),
            (2, a3, token(a3, 0x10), token(a3, 0x20)),
        ],
        configurator: configurator(),
        configurator_implementation: conf_v2,
        pool_implementation: pool_v2,
    })
}

fn current_report(deployment: &Deployment, dropped: &[u64]) -> Json {
    let count = deployment.reserves.len() as u64 + dropped.len() as u64;
    let anchor = BASE + LENGTH - 1;
    Json::object([
        ("status", Json::string("CURRENT_SURFACE_PASS")),
        (
            "bootstrap",
            Json::object([(
                "anchor",
                Json::object([(
                    "anchor",
                    Json::object([
                        ("number", Json::uint(anchor)),
                        (
                            "hash",
                            Json::string(
                                deployment
                                    .sim
                                    .hash_of(anchor)
                                    .map(|hash| hash.to_hex())
                                    .unwrap_or_default(),
                            ),
                        ),
                    ]),
                )]),
            )]),
        ),
        (
            "facts",
            Json::object([
                ("pool", Json::string(pool().to_hex())),
                ("addresses_provider", Json::string(provider_root().to_hex())),
                (
                    "pool_configurator",
                    Json::string(deployment.configurator.to_hex()),
                ),
                (
                    "pool_configurator_implementation",
                    Json::string(deployment.configurator_implementation.to_hex()),
                ),
                (
                    "pool_implementation",
                    Json::string(deployment.pool_implementation.to_hex()),
                ),
                ("reserve_count", Json::uint(count)),
                (
                    "dropped_reserve_ids",
                    Json::array(dropped.iter().map(|id| Json::uint(*id))),
                ),
                (
                    "reserves",
                    Json::array(
                        deployment
                            .reserves
                            .iter()
                            .map(|(id, asset, a_token, debt)| {
                                Json::object([
                                    ("reserve_id", Json::uint(*id)),
                                    ("asset", Json::string(asset.to_hex())),
                                    ("a_token", Json::string(a_token.to_hex())),
                                    ("variable_debt_token", Json::string(debt.to_hex())),
                                ])
                            }),
                    ),
                ),
            ]),
        ),
    ])
}

struct Harness {
    network: SimNetwork,
    providers: ProviderSet,
    plan: HistoryPlan,
    root: std::path::PathBuf,
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn harness(sim: SimChain, faults_b: Faults) -> Result<Harness, Box<dyn Error>> {
    let plan = HistoryPlan {
        profile: sim.profile()?,
        anchor_number: BASE + LENGTH - 1,
        anchor_hash: sim.hash_of(BASE + LENGTH - 1).ok_or("anchor")?,
        addresses_provider: provider_root(),
        pool: pool(),
        boundary_floor: BASE,
        checkpoint_span: 64,
    };
    let chain = Arc::new(Mutex::new(sim));
    let mut network = SimNetwork::new();
    network.add(A, SimProvider::new(chain.clone(), Faults::default(), 40));
    network.add(B, SimProvider::new(chain, faults_b, 1_000));
    let providers: Vec<ProviderSpec> = vec![
        SimProvider::spec(A, "sim-a", 40, 5)?,
        SimProvider::spec(B, "sim-b", 1_000, 2)?,
    ];
    let root = std::env::temp_dir().join(format!(
        "nqc-rmc006-history-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    std::fs::create_dir(&root)?;
    Ok(Harness {
        network,
        providers: ProviderSet::new(providers)?,
        plan,
        root,
    })
}

fn run(harness: &Harness, current: &Json) -> Result<(Json, Store), ChainError> {
    let store = Store::create(&harness.root.join("store"), StoreConfig::standard())?;
    let report = history_with(
        &Acquisition::new(&store, &harness.network, RetryPolicy::none()),
        &harness.providers,
        &harness.plan,
        current,
    )?;
    Ok((report, store))
}

fn summary(report: &Json, key: &str) -> i64 {
    report
        .get("summary")
        .and_then(|summary| summary.get(key))
        .and_then(Json::as_i64)
        .unwrap_or(-1)
}

fn expect_error(
    result: Result<(Json, Store), ChainError>,
    needle: &str,
) -> Result<(), Box<dyn Error>> {
    match result {
        Ok(_) => Err(format!("expected failure containing {needle:?}").into()),
        Err(error) if error.to_string().contains(needle) => Ok(()),
        Err(error) => Err(format!("error {error} does not contain {needle:?}").into()),
    }
}

#[test]
fn history_with_zero_topic_lineage_drop_and_slot_reuse_reconciles() -> TestResult {
    let deployment = deployment()?;
    let current = current_report(&deployment, &[]);
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let (report, _) = run(&harness, &current)?;
    assert_eq!(report.str_field("status")?, "HISTORY_RECONCILIATION_PASS");
    assert_eq!(summary(&report, "reserve_initialized_count"), 4);
    assert_eq!(summary(&report, "reserve_dropped_count"), 1);
    assert_eq!(summary(&report, "historical_market_count"), 4);
    assert_eq!(summary(&report, "active_event_count"), 3);
    assert_eq!(summary(&report, "configurator_count"), 1);
    assert_eq!(summary(&report, "pool_implementation_update_count"), 2);
    assert_eq!(
        summary(&report, "configurator_implementation_update_count"),
        2
    );
    // Both initial updates carry an indexed zero `old` address.
    assert_eq!(summary(&report, "lineage_zero_topic_log_count"), 3);
    assert_eq!(summary(&report, "unexplained_delta_count"), 0);
    let lineage = report.get("lineage").ok_or("lineage")?;
    assert_eq!(
        lineage.get("other_id_event_count").and_then(Json::as_i64),
        Some(1)
    );
    let slots = report
        .get("simulated_reserve_slots")
        .and_then(Json::as_array)
        .ok_or("slots")?;
    assert_eq!(slots[1].as_str(), Some(address(0x04).to_hex().as_str()));
    assert_eq!(
        report
            .get("historical_dropped")
            .and_then(Json::as_array)
            .map(<[Json]>::len),
        Some(1)
    );
    Ok(())
}

#[test]
fn history_is_deterministic_across_independent_stores() -> TestResult {
    let deployment = deployment()?;
    let current = current_report(&deployment, &[]);
    let first = run(
        &harness(deployment.sim.clone(), Faults::default())?,
        &current,
    )?
    .0;
    let second = run(
        &harness(deployment.sim.clone(), Faults::default())?,
        &current,
    )?
    .0;
    assert_eq!(first.canonical()?, second.canonical()?);
    Ok(())
}

#[test]
fn dropped_slot_in_current_surface_must_be_explained_by_history() -> TestResult {
    let mut deployment = deployment()?;
    // Without the re-initialization, slot 1 stays empty at the anchor.
    deployment.sim.remove_logs_from(BASE + 70);
    let (pool_v1, pool_v2) = (address(0xa1), address(0xa2));
    let root = provider_root();
    deployment.sim.add_log(log(
        BASE + 100,
        0,
        0,
        root,
        vec![
            topic("PoolConfiguratorUpdated(address,address)"),
            word(address(0xc1)),
            word(address(0xc2)),
        ],
        vec![],
    ));
    deployment.sim.add_log(log(
        BASE + 110,
        0,
        0,
        root,
        vec![
            topic("PoolUpdated(address,address)"),
            word(pool_v1),
            word(pool_v2),
        ],
        vec![],
    ));
    deployment.reserves.remove(1);
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let (report, _) = run(&harness, &current_report(&deployment, &[1]))?;
    assert_eq!(summary(&report, "reserve_id_slot_count"), 3);
    assert_eq!(summary(&report, "current_reserve_count"), 2);

    // The same empty slot with no drop in history is unexplained.
    let mut undropped = deployment.sim.clone();
    undropped.remove_logs_from(BASE + 60);
    undropped.add_log(log(
        BASE + 100,
        0,
        0,
        root,
        vec![
            topic("PoolConfiguratorUpdated(address,address)"),
            word(address(0xc1)),
            word(address(0xc2)),
        ],
        vec![],
    ));
    undropped.add_log(log(
        BASE + 110,
        0,
        0,
        root,
        vec![
            topic("PoolUpdated(address,address)"),
            word(pool_v1),
            word(pool_v2),
        ],
        vec![],
    ));
    let harness = self::harness(undropped, Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[1])),
        "EVENT_ACTIVE_ONLY",
    )?;
    Ok(())
}

#[test]
fn replaced_configurator_is_windowed_and_stale_emitter_rejected() -> TestResult {
    let mut deployment = deployment()?;
    let replacement = address(0x65);
    deployment
        .sim
        .set_code(replacement, BASE + 75, None, vec![0x60, 0x01]);
    deployment.sim.add_log(log(
        BASE + 80,
        0,
        0,
        provider_root(),
        vec![
            topic("AddressSet(bytes32,address,address)"),
            id("POOL_CONFIGURATOR"),
            word(configurator()),
            word(replacement),
        ],
        vec![],
    ));
    let a5 = address(0x05);
    deployment
        .sim
        .add_log(reserve_initialized(BASE + 90, replacement, a5));
    deployment
        .reserves
        .push((3, a5, address(0x15), address(0x25)));
    deployment.configurator = replacement;
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let (report, _) = run(&harness, &current_report(&deployment, &[]))?;
    assert_eq!(summary(&report, "configurator_count"), 2);
    assert_eq!(summary(&report, "configurator_replacement_count"), 1);
    assert_eq!(summary(&report, "reserve_initialized_count"), 5);

    // The replaced configurator can no longer change the Pool.
    let mut stale = deployment.sim.clone();
    stale.add_log(reserve_initialized(
        BASE + 95,
        configurator(),
        address(0x06),
    ));
    let harness = self::harness(stale, Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "while the Pool trusted",
    )?;
    Ok(())
}

#[test]
fn replaced_pool_address_fails_closed() -> TestResult {
    let mut deployment = deployment()?;
    deployment.sim.add_log(log(
        BASE + 120,
        0,
        0,
        provider_root(),
        vec![
            topic("AddressSet(bytes32,address,address)"),
            id("POOL"),
            word(pool()),
            word(address(0x88)),
        ],
        vec![],
    ));
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "replaced the POOL address",
    )?;
    Ok(())
}

#[test]
fn discontinuous_or_wrong_final_implementation_fails_closed() -> TestResult {
    let mut deployment = deployment()?;
    deployment.sim.add_log(log(
        BASE + 130,
        0,
        0,
        provider_root(),
        vec![
            topic("PoolConfiguratorUpdated(address,address)"),
            word(address(0xee)),
            word(address(0xc3)),
        ],
        vec![],
    ));
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "discontinuous",
    )?;

    let mut deployment = self::deployment()?;
    deployment.pool_implementation = address(0xa3);
    let harness = self::harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "does not end at the exact-anchor",
    )?;
    Ok(())
}

#[test]
fn reserve_id_or_token_disagreement_is_unexplained() -> TestResult {
    let mut deployment = deployment()?;
    deployment.reserves.swap(0, 1);
    deployment.reserves[0].0 = 0;
    deployment.reserves[1].0 = 1;
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "RESERVE_ID_SLOT_MISMATCH",
    )?;

    let mut deployment = self::deployment()?;
    deployment.reserves[2].2 = address(0x7e);
    let harness = self::harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "TOKEN_IDENTITY_MISMATCH",
    )?;

    let mut deployment = self::deployment()?;
    deployment
        .reserves
        .push((3, address(0x09), address(0x19), address(0x29)));
    let harness = self::harness(deployment.sim.clone(), Faults::default())?;
    expect_error(
        run(&harness, &current_report(&deployment, &[])),
        "CURRENT_ONLY",
    )?;
    Ok(())
}

#[test]
fn a_provider_omitting_one_lineage_or_reserve_log_fails_consensus() -> TestResult {
    for omitted in [(BASE + 30, 1), (BASE + 50, 0)] {
        let deployment = deployment()?;
        let mut faults = Faults::default();
        faults.omit_logs.insert(omitted);
        let harness = harness(deployment.sim.clone(), faults)?;
        if !matches!(
            run(&harness, &current_report(&deployment, &[])),
            Err(ChainError::Consensus(_))
        ) {
            return Err(
                format!("omitted log {omitted:?} not caught as a consensus failure").into(),
            );
        }
    }
    Ok(())
}

#[test]
fn crash_resume_replay_is_byte_identical_and_tamper_is_detected() -> TestResult {
    let deployment = deployment()?;
    let current = current_report(&deployment, &[]);
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let (report, store) = run(&harness, &current)?;
    let check = resume_check(
        &store,
        &harness.providers,
        &harness.plan,
        &current,
        &report,
        &harness.root.join("resume"),
    )?;
    assert_eq!(check.str_field("status")?, "RESUME_EQUIVALENCE_PASS");
    let interruptions = check
        .get("interruptions")
        .and_then(Json::as_array)
        .ok_or("cuts")?;
    assert!(interruptions.len() >= 4);

    // A report that differs from what the evidence reproduces is rejected.
    let tampered_text = report
        .canonical_string()?
        .replace("\"reserve_dropped_count\":1", "\"reserve_dropped_count\":0");
    let tampered = Json::parse(tampered_text.as_bytes())?;
    assert!(resume_check(
        &store,
        &harness.providers,
        &harness.plan,
        &current,
        &tampered,
        &harness.root.join("resume-tampered"),
    )
    .is_err());

    // Evidence the report does not name cannot be used: dropping one manifest
    // leaves a request unanswerable.
    let manifests = report
        .get("replay_manifests")
        .and_then(Json::as_array)
        .ok_or("manifests")?;
    let first = manifests[0].as_str().ok_or("manifest")?.to_owned();
    let starved = Json::parse(
        report
            .canonical_string()?
            .replacen(&format!("\"{first}\","), "", 1)
            .as_bytes(),
    )?;
    assert!(resume_check(
        &store,
        &harness.providers,
        &harness.plan,
        &current,
        &starved,
        &harness.root.join("resume-starved"),
    )
    .is_err());
    Ok(())
}

/// A provider that answers every repeat of an identical request with the same
/// JSON value in other bytes (a trailing newline on every second answer), as
/// public endpoints were measured to do (D06 run 36616344742).
struct Reformatting<'a> {
    inner: &'a SimNetwork,
    seen: Mutex<std::collections::BTreeMap<(u16, Vec<u8>), u64>>,
}

impl Transport for Reformatting<'_> {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let mut reply = self.inner.post(provider, body)?;
        let mut seen = self
            .seen
            .lock()
            .map_err(|_| ChainError::Replay("poisoned"))?;
        let count = seen
            .entry((provider.namespace(), body.to_vec()))
            .or_insert(0);
        if *count % 2 == 1 {
            reply.body.push(b'\n');
        }
        *count += 1;
        Ok(reply)
    }
}

#[test]
fn repeated_requests_answered_in_other_bytes_replay_in_recorded_order() -> TestResult {
    let deployment = deployment()?;
    let current = current_report(&deployment, &[]);
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let store = Store::create(&harness.root.join("store"), StoreConfig::standard())?;
    let provider = Reformatting {
        inner: &harness.network,
        seen: Mutex::new(std::collections::BTreeMap::new()),
    };
    let report = history_with(
        &Acquisition::new(&store, &provider, RetryPolicy::none()),
        &harness.providers,
        &harness.plan,
        &current,
    )?;

    // A replay keyed by request alone answers every repeat with one of the
    // recorded byte forms, so some job cannot reproduce: the live failure.
    let mut keyed = ReplayTransport::new();
    for id in report
        .get("replay_manifests")
        .and_then(Json::as_array)
        .ok_or("manifests")?
    {
        let id = nqc_census_store::ArtifactId::parse_hex(id.as_str().ok_or("id")?)?;
        let bytes = store.get_artifact(&id)?;
        let manifest = Json::parse(&bytes)?;
        let descriptor = manifest
            .get("job")
            .and_then(|job| job.get("provider"))
            .ok_or("provider")?;
        let owner = harness
            .providers
            .iter()
            .find(|provider| provider.descriptor().same_as(descriptor).unwrap_or(false))
            .ok_or("owner")?;
        add_manifest_exchanges(&mut keyed, &store, &bytes, owner)?;
    }
    let fresh = Store::create(&harness.root.join("keyed"), StoreConfig::standard())?;
    let keyed_report = history_with(
        &Acquisition::new(&fresh, &keyed, RetryPolicy::none()),
        &harness.providers,
        &harness.plan,
        &current,
    )?;
    assert!(!keyed_report.same_as(&report)?);

    // Replaying each request's recorded occurrences in order reproduces the
    // report, clean and after every interruption.
    let check = resume_check(
        &store,
        &harness.providers,
        &harness.plan,
        &current,
        &report,
        &harness.root.join("resume"),
    )?;
    assert_eq!(check.str_field("status")?, "RESUME_EQUIVALENCE_PASS");
    assert!(
        check
            .get("requests_recorded_with_differing_responses")
            .and_then(Json::as_i64)
            .ok_or("conflicts")?
            > 0
    );
    let interruptions = check
        .get("interruptions")
        .and_then(Json::as_array)
        .ok_or("cuts")?;
    assert!(interruptions.iter().any(|cut| {
        cut.get("committed_jobs_at_interruption")
            .and_then(Json::as_i64)
            .unwrap_or(0)
            > 0
    }));
    Ok(())
}

#[test]
fn a_current_surface_from_another_anchor_is_refused() -> TestResult {
    let deployment = deployment()?;
    let harness = harness(deployment.sim.clone(), Faults::default())?;
    let current = current_report(&deployment, &[]);
    let earlier = deployment
        .sim
        .hash_of(BASE + LENGTH - 2)
        .ok_or("earlier block")?
        .to_hex();
    let hash = deployment
        .sim
        .hash_of(BASE + LENGTH - 1)
        .ok_or("anchor")?
        .to_hex();
    let moved = Json::parse(
        current
            .canonical_string()?
            .replace(&hash, &earlier)
            .as_bytes(),
    )?;
    expect_error(
        run(&harness, &moved),
        "another anchor than the history plan",
    )?;
    Ok(())
}
