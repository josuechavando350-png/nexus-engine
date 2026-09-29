//! RMC-008 Uniswap V2 state pipeline on a synthetic chain: factory stage,
//! partitioned pair-state stages on two providers, replay from the store,
//! agreement and verification. Testkit chains are synthetic, never evidence.

use nqc_census_chain::abi;
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSpec;
use nqc_census_chain::testkit::{Faults, SimChain, SimNetwork, SimProvider};
use nqc_census_chain::transport::RetryPolicy;
use nqc_census_core::{
    keccak256, Address, CallOutcome, CanonicalMarketKey, CensusStage, DeploymentKey, Hash32,
    ProtocolFamily, RejectionReason,
};
use nqc_census_state::extract::{extract_stages, stage_extract};
use nqc_census_state::replay::{replay_stage, StagePlans};
use nqc_census_state::stage::AnchorPlan;
use nqc_census_state::v2_math::{create2_address, pair_salt};
use nqc_census_state::v2_stage::{v2_factory_stage, v2_state_stage, PairInput, V2Plan};
use nqc_census_state::v2_verify::{verify_v2, V2Inputs};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::error::Error;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 40;
const PAIRS: usize = 7;
const A: u16 = 0x0a08;
const B: u16 = 0x0b08;
const RUNTIME: [u8; 5] = [0x60, 0x01, 0x60, 0x02, 0x01];

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!("nonzero"))
}

fn factory() -> Address {
    address(0x5c)
}

fn init_code() -> Vec<u8> {
    let mut init = vec![0x60, 0x80, 0x60, 0x40, 0x52, 0x34, 0x80, 0x15];
    init.extend_from_slice(&RUNTIME);
    init
}

fn factory_code() -> Vec<u8> {
    let mut code = vec![0x00, 0x5b];
    code.extend_from_slice(&init_code());
    code.extend_from_slice(&[0xfe, 0x00]);
    code
}

fn tokens(index: usize) -> (Address, Address) {
    let base = 2 * index as u8 + 1;
    (address(base), address(base + 1))
}

fn word(value: u64) -> [u8; 32] {
    abi::uint_word(value)
}

#[derive(Clone, Default)]
struct Variant {
    /// Pair index whose token0 balance is below its reserve.
    balance_below: Option<usize>,
    /// Pair index with zero reserves.
    empty: Option<usize>,
    /// Pair index whose address is not the CREATE2 derivation.
    foreign_pair: Option<usize>,
    /// Pair index whose token1 `decimals()` reverts.
    decimals_revert: Option<usize>,
    /// Pair index whose reserve0 differs (to split providers).
    reserve_offset: Option<usize>,
}

fn pair_address(index: usize, variant: &Variant) -> Address {
    if variant.foreign_pair == Some(index) {
        return address(0xe0 + index as u8);
    }
    let (token0, token1) = tokens(index);
    Address::new(create2_address(
        factory(),
        pair_salt(token0, token1),
        keccak256(&init_code()),
    ))
    .unwrap_or_else(|_| unreachable!("derived"))
}

fn chain(variant: &Variant) -> Result<SimChain, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, LENGTH)?;
    let from = BASE + 1;
    sim.set_code(factory(), from, None, factory_code());
    let call =
        |selector: &str, words: &[[u8; 32]]| abi::encode_call(abi::selector(selector), words);
    sim.set_call(
        factory(),
        call("feeTo()", &[]),
        from,
        None,
        CallOutcome::Returned([0; 32].to_vec()),
    );
    sim.set_call(
        factory(),
        call("feeToSetter()", &[]),
        from,
        None,
        CallOutcome::Returned(abi::address_word(address(0x77).as_bytes()).to_vec()),
    );
    sim.set_call(
        factory(),
        call("allPairsLength()", &[]),
        from,
        None,
        CallOutcome::Returned(word(PAIRS as u64).to_vec()),
    );
    for index in 0..PAIRS {
        let (token0, token1) = tokens(index);
        let pair = pair_address(index, variant);
        sim.set_code(pair, from, None, RUNTIME.to_vec());
        let empty = variant.empty == Some(index);
        let offset = u64::from(variant.reserve_offset == Some(index));
        let (reserve0, reserve1) = if empty {
            (0, 0)
        } else {
            (1_000 + index as u64 + offset, 5_000)
        };
        let mut reserves = word(reserve0).to_vec();
        reserves.extend_from_slice(&word(reserve1));
        reserves.extend_from_slice(&word(1_700_000_000));
        sim.set_call(
            pair,
            call("getReserves()", &[]),
            from,
            None,
            CallOutcome::Returned(reserves),
        );
        sim.set_call(
            pair,
            call("totalSupply()", &[]),
            from,
            None,
            CallOutcome::Returned(word(if empty { 0 } else { 2_236 }).to_vec()),
        );
        sim.set_call(
            pair,
            call("kLast()", &[]),
            from,
            None,
            CallOutcome::Returned(word(0).to_vec()),
        );
        sim.set_call(
            pair,
            call("factory()", &[]),
            from,
            None,
            CallOutcome::Returned(abi::address_word(factory().as_bytes()).to_vec()),
        );
        let holder = abi::address_word(pair.as_bytes());
        let below = u64::from(variant.balance_below == Some(index));
        sim.set_call(
            token0,
            call("balanceOf(address)", &[holder]),
            from,
            None,
            CallOutcome::Returned(word(reserve0.saturating_sub(below)).to_vec()),
        );
        sim.set_call(
            token1,
            call("balanceOf(address)", &[holder]),
            from,
            None,
            CallOutcome::Returned(word(reserve1 + 3).to_vec()),
        );
        sim.set_call(
            token0,
            call("decimals()", &[]),
            from,
            None,
            CallOutcome::Returned(word(18).to_vec()),
        );
        sim.set_call(
            token1,
            call("decimals()", &[]),
            from,
            None,
            if variant.decimals_revert == Some(index) {
                CallOutcome::Reverted(Vec::new())
            } else {
                CallOutcome::Returned(word(6).to_vec())
            },
        );
    }
    Ok(sim)
}

struct Run {
    store: Store,
    specs: Vec<ProviderSpec>,
    plan: V2Plan,
    pairs: Vec<PairInput>,
    records: Vec<Json>,
    deployment: DeploymentKey,
    root: std::path::PathBuf,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn run(variant: &Variant, other: &Variant) -> Result<Run, Box<dyn Error>> {
    let sim = chain(variant)?;
    let mut network = SimNetwork::new();
    network.add(
        A,
        SimProvider::new(Arc::new(Mutex::new(sim.clone())), Faults::default(), 100),
    );
    network.add(
        B,
        SimProvider::new(Arc::new(Mutex::new(chain(other)?)), Faults::default(), 100),
    );
    let specs = vec![
        SimProvider::spec(A, "state-a", 100, 7)?,
        SimProvider::spec(B, "state-b", 100, 4)?,
    ];
    let plan = V2Plan {
        anchor: AnchorPlan {
            profile: sim.profile()?,
            number: BASE + LENGTH - 1,
            hash: sim.hash_of(BASE + LENGTH - 1).ok_or("anchor")?,
        },
        factory: factory(),
        job_size: 2,
    };
    let root = std::env::temp_dir().join(format!(
        "nqc-rmc008-v2-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let store = Store::create(&root, StoreConfig::standard())?;
    let acquisition = Acquisition::new(&store, &network, RetryPolicy::none());
    let (facts, _) = acquisition.bootstrap(&specs[0], &plan.anchor.profile)?;
    let deployment = DeploymentKey::new(
        facts.chain.clone(),
        ProtocolFamily::UniswapV2,
        factory(),
        Hash32::new([9; 32])?,
    );
    let pairs: Vec<PairInput> = (0..PAIRS)
        .map(|index| {
            let (token0, token1) = tokens(index);
            let pair = pair_address(index, variant);
            let market_id = CanonicalMarketKey::v2_pair(deployment.clone(), pair, token0, token1)?
                .id()?
                .to_hex();
            Ok(PairInput {
                index: index as u64,
                market_id,
                pair,
                token0,
                token1,
            })
        })
        .collect::<Result<_, Box<dyn Error>>>()?;
    let mut records = Vec::new();
    for spec in &specs {
        records.push(v2_factory_stage(&acquisition, spec, &plan, &[pairs[0].pair])?.0);
        for partition in 0..2 {
            records.push(v2_state_stage(&acquisition, spec, &plan, &pairs, partition, 2)?.0);
        }
    }
    Ok(Run {
        store,
        specs,
        plan,
        pairs,
        records,
        deployment,
        root,
    })
}

fn verify(run: &Run) -> Result<nqc_census_state::v2_verify::V2Outcome, Box<dyn Error>> {
    let plans = StagePlans {
        v2: Some(&run.plan),
        pairs: &run.pairs,
        aave: None,
    };
    let mut factory_stages = Vec::new();
    let mut state_stages = Vec::new();
    for record in &run.records {
        let replayed = replay_stage(&run.store, &run.specs, &plans, record)?;
        match record.str_field("stage")? {
            "V2_FACTORY" => factory_stages.push(replayed),
            _ => state_stages.push(replayed),
        }
    }
    Ok(verify_v2(&V2Inputs {
        deployment: run.deployment.clone(),
        admitted_factory_sha256: nqc_census_chain::hex::plain(&Sha256::digest(factory_code())),
        declared_init_code_hash: keccak256(&init_code()),
        pairs: &run.pairs,
        factory: factory_stages,
        state: state_stages,
    })?)
}

fn decision(
    run: &Run,
    outcome: &nqc_census_state::v2_verify::V2Outcome,
    index: usize,
    stage: CensusStage,
) -> Option<String> {
    let input = &run.pairs[index];
    let unit = nqc_census_core::CensusUnitId::from_market(
        CanonicalMarketKey::v2_pair(
            run.deployment.clone(),
            input.pair,
            input.token0,
            input.token1,
        )
        .ok()?
        .id()
        .ok()?,
    );
    outcome
        .ledger
        .rejection_records()
        .iter()
        .find(|record| record.stage() == stage && record.unit_id() == unit)
        .map(|record| record.reason().code().to_owned())
}

#[test]
fn clean_pairs_are_reconstructable_and_active() -> TestResult {
    let run = run(&Variant::default(), &Variant::default())?;
    let outcome = verify(&run)?;
    assert_eq!(outcome.mismatches.unexplained(), 0);
    assert_eq!(outcome.state_rows.len(), PAIRS);
    let reconstructable = outcome
        .ledger
        .metrics(&outcome.domain, CensusStage::MarketsStateReconstructable);
    let active = outcome
        .ledger
        .metrics(&outcome.domain, CensusStage::MarketsEconomicallyActive);
    assert_eq!(
        (reconstructable.input_count, reconstructable.advanced_count),
        (PAIRS, PAIRS)
    );
    // No economic classification is recorded by D08.
    assert_eq!(active.input_count, 0);
    assert!(reconstructable.is_conserved());
    assert_eq!(outcome.tokens.len(), 2 * PAIRS);
    assert!(outcome
        .tokens
        .iter()
        .all(|token| !token.execution_blockers().is_empty()));
    assert_eq!(
        outcome
            .factory_facts
            .get("pair_runtime_sha256")
            .and_then(Json::as_str),
        Some(nqc_census_chain::hex::plain(&Sha256::digest(RUNTIME)).as_str())
    );
    for row in &outcome.state_rows {
        assert_eq!(
            row.get("liquidity_state").and_then(Json::as_str),
            Some("LIQUID")
        );
        assert_eq!(row.str_field("balance1_minus_reserve1")?, "3");
    }
    Ok(())
}

#[test]
fn token_and_liquidity_anomalies_reject_with_explicit_reasons() -> TestResult {
    let variant = Variant {
        balance_below: Some(1),
        empty: Some(2),
        decimals_revert: Some(3),
        ..Variant::default()
    };
    let run = run(&variant, &variant)?;
    let outcome = verify(&run)?;
    assert_eq!(outcome.mismatches.unexplained(), 0);
    assert_eq!(
        decision(&run, &outcome, 1, CensusStage::MarketsStateReconstructable).as_deref(),
        Some(RejectionReason::UnsupportedTokenBehavior.code())
    );
    // An empty pair stays a canonical, reconstructable market; its zero
    // liquidity is a recorded fact, not a rejection.
    assert_eq!(
        decision(&run, &outcome, 2, CensusStage::MarketsStateReconstructable),
        None
    );
    assert_eq!(
        outcome.state_rows[2]
            .get("liquidity_state")
            .and_then(Json::as_str),
        Some("ZERO_LIQUIDITY_NOT_ROUTABLE")
    );
    let (below_token, _) = tokens(1);
    let token = outcome
        .tokens
        .iter()
        .find(|token| token.token == below_token)
        .ok_or("token")?;
    assert_eq!(
        token.behavior.rebasing,
        nqc_census_state::model::Tri::Present
    );
    assert!(matches!(
        token.state,
        nqc_census_state::model::StateAdmission::Rejected(_)
    ));
    let (_, reverting) = tokens(3);
    let token = outcome
        .tokens
        .iter()
        .find(|token| token.token == reverting)
        .ok_or("token")?;
    assert_eq!(token.decimals, nqc_census_state::model::Decimals::Reverted);
    let rejections = outcome.ledger.rejection_records();
    assert!(rejections
        .iter()
        .all(|record| record.reason() != RejectionReason::Unknown));
    Ok(())
}

#[test]
fn a_pair_outside_the_create2_derivation_is_an_unexplained_mismatch() -> TestResult {
    let variant = Variant {
        foreign_pair: Some(4),
        ..Variant::default()
    };
    let run = run(&variant, &variant)?;
    let outcome = verify(&run)?;
    assert_eq!(outcome.mismatches.unexplained(), 1);
    assert_eq!(
        outcome.mismatches.sorted()[0].dimension,
        "PAIR_CREATE2_DERIVATION"
    );
    assert_eq!(
        decision(&run, &outcome, 4, CensusStage::MarketsStateReconstructable).as_deref(),
        Some(RejectionReason::StateUnreconstructable.code())
    );
    Ok(())
}

#[test]
fn provider_disagreement_fails_closed() -> TestResult {
    let other = Variant {
        reserve_offset: Some(5),
        ..Variant::default()
    };
    let run = run(&Variant::default(), &other)?;
    let error = verify(&run).err().ok_or("disagreement must fail")?;
    assert!(error.to_string().contains("different"), "{error}");
    Ok(())
}

#[test]
fn replay_rejects_a_tampered_record_and_is_deterministic() -> TestResult {
    let run = run(&Variant::default(), &Variant::default())?;
    let first = verify(&run)?;
    let second = verify(&run)?;
    assert_eq!(first.state_rows, second.state_rows);
    let plans = StagePlans {
        v2: Some(&run.plan),
        pairs: &run.pairs,
        aave: None,
    };
    let record = run
        .records
        .iter()
        .find(|record| record.str_field("stage").ok() == Some("V2_STATE"))
        .ok_or("state record")?;
    let tampered = match record {
        Json::Object(members) => Json::Object(
            members
                .iter()
                .map(|(key, value)| {
                    if key == "data_sha256" {
                        (key.clone(), Json::string("00".repeat(32)))
                    } else {
                        (key.clone(), value.clone())
                    }
                })
                .collect(),
        ),
        _ => return Err("record is not an object".into()),
    };
    assert!(replay_stage(&run.store, &run.specs, &plans, &tampered).is_err());
    // A pair list other than the one the record was acquired for does not
    // reproduce it.
    let mut shifted = run.pairs.clone();
    shifted.swap(0, 1);
    let wrong = StagePlans {
        v2: Some(&run.plan),
        pairs: &shifted,
        aave: None,
    };
    assert!(replay_stage(&run.store, &run.specs, &wrong, record).is_err());
    Ok(())
}

fn store_summary(run_root: &std::path::Path) -> Result<Json, Box<dyn Error>> {
    let report = nqc_census_store::verify::verify_store(
        run_root,
        &nqc_census_store::verify::VerifyRequest::default(),
    )
    .map_err(|failure| failure.to_string())?;
    Ok(Json::object([
        ("stage_artifact", Json::string("synthetic")),
        ("evidence_root", Json::string(report.evidence_root)),
    ]))
}

fn with_field(value: &Json, key: &str, replacement: Json) -> Result<Json, Box<dyn Error>> {
    let members = value.as_object().ok_or("not an object")?;
    Ok(Json::Object(
        members
            .iter()
            .map(|(name, field)| {
                let field = if name == key {
                    replacement.clone()
                } else {
                    field.clone()
                };
                (name.clone(), field)
            })
            .collect(),
    ))
}

#[test]
fn per_store_extracts_verify_like_replay_and_bind_to_the_pair_list() -> TestResult {
    let run = run(&Variant::default(), &Variant::default())?;
    let plans = StagePlans {
        v2: Some(&run.plan),
        pairs: &run.pairs,
        aave: None,
    };
    let summary = store_summary(&run.root)?;
    let extracts = run
        .records
        .iter()
        .map(|record| stage_extract(&run.store, &run.specs, &plans, record, summary.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    let stages = extract_stages(&run.specs, &plans, &run.plan.anchor, extracts.clone())?;
    let (mut factory_stages, mut state_stages) = (Vec::new(), Vec::new());
    for (record, stage) in stages {
        match record.str_field("stage")? {
            "V2_FACTORY" => factory_stages.push(stage),
            _ => state_stages.push(stage),
        }
    }
    let from_extracts = verify_v2(&V2Inputs {
        deployment: run.deployment.clone(),
        admitted_factory_sha256: nqc_census_chain::hex::plain(&Sha256::digest(factory_code())),
        declared_init_code_hash: keccak256(&init_code()),
        pairs: &run.pairs,
        factory: factory_stages,
        state: state_stages,
    })?;
    assert_eq!(from_extracts.state_rows, verify(&run)?.state_rows);

    // A changed row, even with the extract's own digest rewritten.
    let position = run
        .records
        .iter()
        .position(|record| record.str_field("stage").ok() == Some("V2_STATE"))
        .ok_or("state record")?;
    let rows = extracts[position]
        .get("rows")
        .and_then(Json::as_array)
        .ok_or("rows")?;
    let mut changed = rows.to_vec();
    changed.pop();
    let mut tampered = extracts.clone();
    tampered[position] = with_field(&extracts[position], "rows", Json::Array(changed))?;
    assert!(
        extract_stages(&run.specs, &plans, &run.plan.anchor, tampered)
            .err()
            .ok_or("tampered extract accepted")?
            .to_string()
            .contains("row count")
    );
    // A pair list other than the one the stages were acquired for.
    let mut shifted = run.pairs.clone();
    shifted.swap(0, 1);
    let wrong = StagePlans {
        v2: Some(&run.plan),
        pairs: &shifted,
        aave: None,
    };
    assert!(
        extract_stages(&run.specs, &wrong, &run.plan.anchor, extracts.clone())
            .err()
            .ok_or("foreign pair list accepted")?
            .to_string()
            .contains("another plan")
    );
    // Another anchor.
    let mut other = run.plan.anchor.clone();
    other.number -= 1;
    assert!(extract_stages(&run.specs, &plans, &other, extracts).is_err());
    Ok(())
}
