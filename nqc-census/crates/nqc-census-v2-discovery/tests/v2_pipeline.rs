//! End-to-end RMC-007 pipeline on a synthetic chain: partitioned stages on
//! two point and two log providers, replay from the store, agreement,
//! admission and reconciliation. Testkit chains are synthetic, never evidence.

use nqc_census_chain::abi;
use nqc_census_chain::acquire::{anchor_record, Acquisition};
use nqc_census_chain::hex;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSpec;
use nqc_census_chain::testkit::{Faults, SimChain, SimLog, SimNetwork, SimProvider};
use nqc_census_chain::transport::RetryPolicy;
use nqc_census_chain::ChainError;
use nqc_census_core::{Address, CallOutcome, ChainDomain, StateAnchor};
use nqc_census_store::{Store, StoreConfig};
use nqc_census_v2_discovery::stage::{pair_created_stage, pairs_stage, V2Plan};
use nqc_census_v2_discovery::verify::{admit, reconcile_surfaces, replay_stage, surfaces};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 200;
const PAIRS: u64 = 12;
const CREATION: u64 = BASE + 5;
const POINT_A: u16 = 0x0a01;
const POINT_B: u16 = 0x0b01;
const LOG_C: u16 = 0x0c01;
const LOG_D: u16 = 0x0d01;

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!("nonzero"))
}

fn factory() -> Address {
    address(0x5c)
}

fn word(address: Address) -> [u8; 32] {
    abi::address_word(address.as_bytes())
}

fn tokens(index: u64) -> (Address, Address) {
    let base = 2 * u8::try_from(index).unwrap_or(0) + 1;
    (address(base), address(base + 1))
}

fn pair_address(index: u64) -> Address {
    address(0x80 + u8::try_from(index).unwrap_or(0))
}

#[derive(Clone, Default)]
struct Variant {
    /// PairCreated logs to leave out entirely (by index).
    missing_log: Option<u64>,
    /// getPair answer override (index, answer).
    get_pair: Option<(u64, Address)>,
    /// Pair without runtime code (token calls answer empty data).
    codeless: Option<u64>,
    /// An extra enumerated pair with no creation log.
    extra_enumerated: bool,
}

fn chain(variant: &Variant) -> Result<SimChain, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, LENGTH)?;
    sim.set_code(factory(), CREATION, None, vec![0x60, 0x80]);
    let count = PAIRS + u64::from(variant.extra_enumerated);
    let call = |selector: [u8; 4], words: &[[u8; 32]]| abi::encode_call(selector, words);
    let interface = nqc_census_v2_discovery::factory_interface();
    sim.set_call(
        factory(),
        call(interface.all_pairs_length, &[]),
        CREATION,
        None,
        CallOutcome::Returned(abi::uint_word(count).to_vec()),
    );
    for index in 0..count {
        let (token0, token1) = tokens(index);
        let pair = pair_address(index);
        let block = BASE + 10 + 7 * index;
        sim.set_code(pair, block, None, vec![0x60, 0x01]);
        sim.set_call(
            factory(),
            call(interface.all_pairs, &[abi::uint_word(index)]),
            block,
            None,
            CallOutcome::Returned(word(pair).to_vec()),
        );
        let codeless = variant.codeless == Some(index);
        for (selector, token) in [(interface.token0, token0), (interface.token1, token1)] {
            sim.set_call(
                pair,
                call(selector, &[]),
                block,
                None,
                CallOutcome::Returned(if codeless {
                    Vec::new()
                } else {
                    word(token).to_vec()
                }),
            );
        }
        let answer = match variant.get_pair {
            Some((target, answer)) if target == index => answer,
            _ => pair,
        };
        sim.set_call(
            factory(),
            call(interface.get_pair, &[word(token0), word(token1)]),
            block,
            None,
            CallOutcome::Returned(word(answer).to_vec()),
        );
        if index < PAIRS && variant.missing_log != Some(index) {
            let mut data = word(pair).to_vec();
            data.extend_from_slice(&abi::uint_word(index + 1));
            sim.add_log(SimLog {
                block,
                transaction_index: 0,
                log_index: 0,
                address: factory(),
                topics: vec![interface.pair_created_topic, word(token0), word(token1)],
                data,
            });
        }
    }
    Ok(sim)
}

struct Run {
    records: Vec<(Json, Vec<Json>)>,
    store: Store,
    plan: V2Plan,
    specs: Vec<ProviderSpec>,
    chain: ChainDomain,
    anchors: (StateAnchor, StateAnchor),
    root: std::path::PathBuf,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Runs every stage; `point_b` and `log_d` may see a different chain state.
fn run(point_b: &Variant, log_d_faults: Faults, both: &Variant) -> Result<Run, Box<dyn Error>> {
    let sim = chain(both)?;
    let _ = &sim;
    let other = chain(point_b)?;
    let shared = Arc::new(Mutex::new(sim.clone()));
    let mut network = SimNetwork::new();
    network.add(
        POINT_A,
        SimProvider::new(shared.clone(), Faults::default(), 1_000),
    );
    network.add(
        POINT_B,
        SimProvider::new(Arc::new(Mutex::new(other)), Faults::default(), 1_000),
    );
    network.add(
        LOG_C,
        SimProvider::new(shared.clone(), Faults::default(), 20),
    );
    network.add(LOG_D, SimProvider::new(shared, log_d_faults, 50));
    let specs = vec![
        SimProvider::spec(POINT_A, "point-a", 1_000, 5)?,
        SimProvider::spec(POINT_B, "point-b", 1_000, 3)?,
        SimProvider::spec(LOG_C, "log-c", 20, 4)?,
        SimProvider::spec(LOG_D, "log-d", 50, 2)?,
    ];
    let plan = V2Plan {
        profile: sim.profile()?,
        anchor_number: BASE + LENGTH - 1,
        anchor_hash: sim.hash_of(BASE + LENGTH - 1).ok_or("anchor")?,
        factory: factory(),
        log_span: 64,
        job_size: 5,
    };
    let root = std::env::temp_dir().join(format!(
        "nqc-rmc007-pipeline-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let store = Store::create(&root, StoreConfig::standard())?;
    let acquisition = Acquisition::new(&store, &network, RetryPolicy::none());
    let count = PAIRS + u64::from(both.extra_enumerated);
    let (facts, _) = acquisition.bootstrap(&specs[0], &plan.profile)?;
    let (observation, _) =
        acquisition.resolve_anchor(&specs[0], &facts.chain, plan.anchor_number)?;
    let (creation, _) = acquisition.resolve_anchor(&specs[0], &facts.chain, CREATION)?;
    let mut records = Vec::new();
    let block_parts = nqc_census_chain::acquire::partition_plan(CREATION, plan.anchor_number, 3)?;
    for spec in &specs[2..] {
        for (first, last) in &block_parts {
            records.push(pair_created_stage(
                &acquisition,
                spec,
                &plan,
                *first,
                *last,
            )?);
        }
    }
    for spec in &specs[..2] {
        for partition in 0..2 {
            records.push(pairs_stage(&acquisition, spec, &plan, count, partition, 2)?);
        }
    }
    Ok(Run {
        records,
        store,
        plan,
        specs,
        chain: facts.chain,
        anchors: (creation, observation),
        root,
    })
}

fn reports(run: &Run) -> Result<(Json, Json), Box<dyn Error>> {
    let domain = Json::object([
        ("chain_id", Json::uint(run.chain.chain_id())),
        (
            "genesis_hash",
            Json::string(run.chain.genesis_hash().to_hex()),
        ),
        (
            "fork_lineage",
            Json::string(run.chain.fork_lineage().to_hex()),
        ),
    ]);
    let (creation, observation) = &run.anchors;
    let current = Json::object([
        (
            "bootstrap",
            Json::object([
                ("chain_domain", domain.clone()),
                (
                    "anchor",
                    Json::object([("anchor", anchor_record(observation))]),
                ),
            ]),
        ),
        (
            "facts",
            Json::object([
                ("factory", Json::string(factory().to_hex())),
                (
                    "factory_runtime_sha256",
                    Json::string(hex::plain(&Sha256::digest([0x60, 0x80]))),
                ),
                ("pair_count", Json::uint(PAIRS)),
            ]),
        ),
    ]);
    let boundary = Json::object([
        ("bootstrap", Json::object([("chain_domain", domain)])),
        (
            "proof",
            Json::object([(
                "boundary",
                Json::object([("anchor", anchor_record(creation))]),
            )]),
        ),
        ("first_code_block", Json::uint(CREATION)),
    ]);
    Ok((current, boundary))
}

/// Replays every record and reconciles; returns the replayed data.
fn verify(
    run: &Run,
    pair_count: u64,
) -> Result<nqc_census_v2_discovery::Reconciliation, Box<dyn Error>> {
    let mut stages = Vec::new();
    for (record, _) in &run.records {
        stages.push((
            record.clone(),
            replay_stage(&run.store, &run.specs, &run.plan, record)?,
        ));
    }
    let agreed = surfaces(&run.plan, pair_count, CREATION, &stages)?;
    let (current, boundary) = reports(run)?;
    let (record, _) = admit(
        factory(),
        &current,
        &boundary,
        vec![nqc_census_core::EvidenceRef::Artifact(
            nqc_census_core::Hash32::new([7; 32])?,
        )],
    )?;
    let (reconciliation, findings) = reconcile_surfaces(&record, agreed)?;
    if !findings.is_empty() {
        return Err(format!("findings {}", Json::Array(findings).canonical_string()?).into());
    }
    Ok(reconciliation)
}

#[test]
fn partitioned_two_provider_pipeline_reconciles_every_pair() -> TestResult {
    let run = run(&Variant::default(), Faults::default(), &Variant::default())?;
    let reconciliation = verify(&run, PAIRS)?;
    assert!(reconciliation.certifiable());
    let summary = &reconciliation.summary;
    assert_eq!(
        (
            summary.source_a_count,
            summary.source_b_count,
            summary.source_c_count,
            summary.union_count
        ),
        (12, 12, 12, 12)
    );
    assert_eq!(summary.intersection_count, 12);
    assert!(reconciliation
        .pairs
        .iter()
        .all(|pair| pair.runtime_verified && pair.direct_lookup_verified));
    // Every pair cites its own job and window manifests, per provider.
    assert!(reconciliation
        .pairs
        .iter()
        .all(|pair| pair.evidence.len() == 4));
    Ok(())
}

#[test]
fn stage_records_are_deterministic_and_tamper_evident() -> TestResult {
    let first = run(&Variant::default(), Faults::default(), &Variant::default())?;
    let second = run(&Variant::default(), Faults::default(), &Variant::default())?;
    for ((left, _), (right, _)) in first.records.iter().zip(&second.records) {
        assert_eq!(left.canonical()?, right.canonical()?);
    }
    let pairs_record = first
        .records
        .iter()
        .map(|(record, _)| record)
        .find(|record| record.str_field("stage").ok() == Some("PAIRS"))
        .ok_or("no PAIRS record")?;
    let text = pairs_record.canonical_string()?;
    assert!(text.contains("\"partition\":0"));
    let tampered = Json::parse(
        text.replace("\"partition\":0", "\"partition\":1")
            .as_bytes(),
    )?;
    assert!(replay_stage(&first.store, &first.specs, &first.plan, &tampered).is_err());
    let forged_digest = Json::parse(
        first.records[0]
            .0
            .canonical_string()?
            .replacen("\"data_sha256\":\"", "\"data_sha256\":\"00", 1)
            .as_bytes(),
    )?;
    assert!(replay_stage(&first.store, &first.specs, &first.plan, &forged_digest).is_err());
    Ok(())
}

#[test]
fn log_provider_omission_fails_consensus() -> TestResult {
    let mut faults = Faults::default();
    faults.omit_logs.insert((BASE + 10 + 7 * 4, 0));
    let run = run(&Variant::default(), faults, &Variant::default())?;
    match verify(&run, PAIRS) {
        Err(error)
            if error.to_string().contains("consensus")
                || error.to_string().contains("RESULTS")
                || error.to_string().contains("LOG")
                || error.to_string().contains("disagree") =>
        {
            Ok(())
        }
        Err(error) => match error.downcast_ref::<ChainError>() {
            Some(ChainError::Consensus(_)) => Ok(()),
            _ => Err(format!("unexpected error {error}").into()),
        },
        Ok(_) => Err("omitted log was not caught".into()),
    }
}

#[test]
fn point_provider_disagreement_fails_consensus() -> TestResult {
    let lying = Variant {
        get_pair: Some((3, address(0xee))),
        ..Variant::default()
    };
    let run = run(&lying, Faults::default(), &Variant::default())?;
    match verify(&run, PAIRS) {
        Err(error) => match error.downcast_ref::<ChainError>() {
            Some(ChainError::Consensus(_)) => Ok(()),
            _ => Err(format!("unexpected error {error}").into()),
        },
        Ok(_) => Err("disagreeing point provider was not caught".into()),
    }
}

#[test]
fn wrong_get_pair_on_both_providers_fails_closed() -> TestResult {
    let wrong = Variant {
        get_pair: Some((5, address(0xee))),
        ..Variant::default()
    };
    let run = run(&wrong, Faults::default(), &wrong)?;
    assert!(verify(&run, PAIRS).is_err());
    Ok(())
}

#[test]
fn codeless_pair_missing_log_and_extra_enumeration_are_unexplained() -> TestResult {
    let codeless = Variant {
        codeless: Some(2),
        ..Variant::default()
    };
    let run = self::run(&codeless, Faults::default(), &codeless)?;
    let error = verify(&run, PAIRS).err().ok_or("codeless pair accepted")?;
    assert!(error.to_string().contains("RUNTIME_MISSING"), "{error}");

    let missing = Variant {
        missing_log: Some(7),
        ..Variant::default()
    };
    let run = self::run(&missing, Faults::default(), &missing)?;
    let error = verify(&run, PAIRS)
        .err()
        .ok_or("missing creation log accepted")?;
    assert!(
        error.to_string().contains("ORDINALS_NOT_CONTIGUOUS"),
        "{error}"
    );

    let extra = Variant {
        extra_enumerated: true,
        ..Variant::default()
    };
    let run = self::run(&extra, Faults::default(), &extra)?;
    let reconciliation = verify(&run, PAIRS + 1);
    let error = reconciliation
        .err()
        .ok_or("extra enumerated pair accepted")?;
    assert!(
        error.to_string().contains("ORDINALS_NOT_CONTIGUOUS"),
        "{error}"
    );
    Ok(())
}

#[test]
fn a_missing_partition_is_rejected() -> TestResult {
    let mut run = run(&Variant::default(), Faults::default(), &Variant::default())?;
    run.records.remove(3);
    let error = verify(&run, PAIRS)
        .err()
        .ok_or("missing partition accepted")?;
    assert!(error.to_string().contains("partition"), "{error}");
    Ok(())
}

#[test]
fn a_gap_between_pair_created_partitions_is_rejected() -> TestResult {
    let mut run = run(&Variant::default(), Faults::default(), &Variant::default())?;
    // Records are [log-c p0, p1, p2, log-d p0, p1, p2, pairs...]: drop log-d p1.
    let removed = run.records.remove(4);
    assert_eq!(removed.0.str_field("stage")?, "PAIR_CREATED");
    let error = verify(&run, PAIRS).err().ok_or("gap accepted")?;
    assert!(error.to_string().contains("gap or overlap"), "{error}");
    Ok(())
}
