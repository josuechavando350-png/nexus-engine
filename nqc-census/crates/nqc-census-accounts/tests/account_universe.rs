//! RMC-009 account universe on a synthetic chain: token-log index on two
//! providers, candidate derivation, anchor state on two providers, replay
//! from the store and per-token conservation. Testkit chains are synthetic,
//! never evidence.

use nqc_census_accounts::candidates::{derive_candidates, Candidates};
use nqc_census_accounts::closeout::{
    reconcile_extracts, reconcile_offline, write_closeout, CloseoutContext, Reconciled,
};
use nqc_census_accounts::extract::{extract_stages, stage_extract};
use nqc_census_accounts::index::account_index_stage;
use nqc_census_accounts::plan::{balance_transfer_topic, mint_topic, AccountPlan, ReserveTokens};
use nqc_census_accounts::replay::replay_account_stage;
use nqc_census_accounts::state::account_state_stage;
use nqc_census_accounts::tokens::account_tokens_stage;
use nqc_census_accounts::verify::{verify_accounts, VerifyInputs};
use nqc_census_chain::abi;
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSpec;
use nqc_census_chain::testkit::{Faults, SimChain, SimLog, SimNetwork, SimProvider};
use nqc_census_chain::transport::{InterruptAfter, RetryPolicy, Transport};
use nqc_census_core::{Address, CallOutcome};
use nqc_census_state::stage::AnchorPlan;
use nqc_census_store::{Store, StoreConfig};
use std::error::Error;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 40;
const A: u16 = 0x0a19;
const B: u16 = 0x0b19;
const HEALTHY: u64 = 1_500_000_000_000_000_000;
const UNDERWATER: u64 = 900_000_000_000_000_000;

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!("nonzero"))
}
fn pool() -> Address {
    address(0x87)
}
/// Reserve `k`: underlying, aToken, stable debt token, variable debt token.
fn reserve(k: u8) -> [Address; 4] {
    let base = 0x10 * (k + 1);
    [
        address(base),
        address(base + 1),
        address(base + 2),
        address(base + 3),
    ]
}
fn user(n: u8) -> Address {
    address(0xa0 + n)
}
fn treasury() -> Address {
    address(0xee)
}
fn word(value: u64) -> [u8; 32] {
    abi::uint_word(value)
}
fn word_a(address: Address) -> [u8; 32] {
    abi::address_word(address.as_bytes())
}
fn call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    abi::encode_call(abi::selector(signature), words)
}
fn returned(words: &[[u8; 32]]) -> CallOutcome {
    CallOutcome::Returned(words.concat())
}

#[derive(Clone)]
struct World {
    /// (token, account, scaled, balance) at the anchor.
    balances: Vec<(Address, Address, u64, u64)>,
    totals: Vec<(Address, u64)>,
    stable_total: u64,
    /// (token, scaled balance of the zero address) where it is not zero.
    zero_holdings: Vec<(Address, u64)>,
    /// (token, raw reply) replacing a token's `scaledBalanceOf(0x0)` answer.
    zero_replies: Vec<(Address, CallOutcome)>,
    /// (account, configuration, health factor).
    accounts: Vec<(Address, u64, u64)>,
    logs: Vec<SimLog>,
}

fn mint(block: u64, log_index: u32, token: Address, to: Address) -> SimLog {
    SimLog {
        block,
        transaction_index: 0,
        log_index,
        address: token,
        topics: vec![mint_topic(), word_a(pool()), word_a(to)],
        data: [word(1), word(0), word(1)].concat(),
    }
}

fn transfer(block: u64, log_index: u32, token: Address, from: Address, to: Address) -> SimLog {
    SimLog {
        block,
        transaction_index: 0,
        log_index,
        address: token,
        topics: vec![balance_transfer_topic(), word_a(from), word_a(to)],
        data: [word(1), word(1)].concat(),
    }
}

/// u1 supplies reserve 0 and borrows reserve 1 (health factor below one),
/// u2 supplies reserve 1 and transfers part to u3, u4 supplied and fully
/// withdrew, the treasury accrued reserve 0.
fn world() -> World {
    let [_, a0, _, _] = reserve(0);
    let [_, a1, _, v1] = reserve(1);
    World {
        balances: vec![
            (a0, user(1), 1_000, 1_010),
            (v1, user(1), 500, 505),
            (a1, user(2), 300, 303),
            (a1, user(3), 200, 202),
            (a0, user(4), 0, 0),
            (a0, treasury(), 7, 7),
        ],
        totals: vec![(a0, 1_007), (a1, 500), (v1, 500), (reserve(0)[3], 0)],
        stable_total: 0,
        zero_holdings: Vec::new(),
        zero_replies: Vec::new(),
        accounts: vec![
            // collateral on reserve 0 (bit 1), borrowing reserve 1 (bit 2)
            (user(1), 0b110, UNDERWATER),
            // collateral on reserve 1 (bit 3)
            (user(2), 0b1000, HEALTHY),
            (user(3), 0, u64::MAX),
            (user(4), 0, u64::MAX),
            (treasury(), 0, u64::MAX),
        ],
        logs: vec![
            mint(BASE + 10, 0, a0, user(1)),
            mint(BASE + 12, 0, v1, user(1)),
            mint(BASE + 15, 0, a1, user(2)),
            transfer(BASE + 20, 1, a1, user(2), user(3)),
            mint(BASE + 25, 0, a0, user(4)),
            mint(BASE + 30, 2, a0, treasury()),
        ],
    }
}

fn chain(world: &World) -> Result<SimChain, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, LENGTH)?;
    let from = BASE + 1;
    for log in &world.logs {
        sim.add_log(log.clone());
    }
    for k in 0..2_u8 {
        let [asset, a_token, stable, v_token] = reserve(k);
        let mut words = vec![word(0); 15];
        words[7] = word(u64::from(k));
        words[8] = word_a(a_token);
        words[9] = word_a(stable);
        words[10] = word_a(v_token);
        sim.set_call(
            pool(),
            call("getReserveData(address)", &[word_a(asset)]),
            from,
            None,
            returned(&words),
        );
        sim.set_call(
            stable,
            call("totalSupply()", &[]),
            from,
            None,
            returned(&[word(world.stable_total)]),
        );
        for token in [a_token, v_token] {
            let total = world
                .totals
                .iter()
                .find(|(t, _)| *t == token)
                .map_or(0, |(_, total)| *total);
            sim.set_call(
                token,
                call("scaledTotalSupply()", &[]),
                from,
                None,
                returned(&[word(total)]),
            );
            let zero = world
                .zero_holdings
                .iter()
                .find(|(t, _)| *t == token)
                .map_or(0, |(_, scaled)| *scaled);
            let reply = world
                .zero_replies
                .iter()
                .find(|(t, _)| *t == token)
                .map_or_else(|| returned(&[word(zero)]), |(_, reply)| reply.clone());
            sim.set_call(
                token,
                call("scaledBalanceOf(address)", &[word(0)]),
                from,
                None,
                reply,
            );
        }
    }
    for (token, account, scaled, balance) in &world.balances {
        sim.set_call(
            *token,
            call("scaledBalanceOf(address)", &[word_a(*account)]),
            from,
            None,
            returned(&[word(*scaled)]),
        );
        sim.set_call(
            *token,
            call("balanceOf(address)", &[word_a(*account)]),
            from,
            None,
            returned(&[word(*balance)]),
        );
    }
    for (account, configuration, health) in &world.accounts {
        sim.set_call(
            pool(),
            call("getUserConfiguration(address)", &[word_a(*account)]),
            from,
            None,
            returned(&[word(*configuration)]),
        );
        sim.set_call(
            pool(),
            call("getUserEMode(address)", &[word_a(*account)]),
            from,
            None,
            returned(&[word(0)]),
        );
        sim.set_call(
            pool(),
            call("getUserAccountData(address)", &[word_a(*account)]),
            from,
            None,
            returned(&[
                word(10),
                word(5),
                word(1),
                word(8_000),
                word(7_500),
                word(*health),
            ]),
        );
    }
    Ok(sim)
}

fn plan(sim: &SimChain) -> Result<AccountPlan, Box<dyn Error>> {
    let reserves = (0..2_u8)
        .map(|k| {
            let [asset, a_token, stable, v_token] = reserve(k);
            ReserveTokens {
                asset,
                market_id: format!("market-{k}"),
                reserve_id: Some(u16::from(k)),
                a_token,
                variable_debt_token: v_token,
                stable_debt_token: Some(stable),
                initialized_block: BASE + 2 + 3 * u64::from(k),
            }
        })
        .collect();
    Ok(AccountPlan::new(
        AnchorPlan {
            profile: sim.profile()?,
            number: BASE + LENGTH - 1,
            hash: sim.hash_of(BASE + LENGTH - 1).ok_or("anchor")?,
        },
        pool(),
        reserves,
        7,
        2,
    )?)
}

#[derive(Clone)]
struct Setup {
    world_a: World,
    world_b: World,
    faults_a: Faults,
    faults_b: Faults,
    retry: RetryPolicy,
}

impl Setup {
    fn clean() -> Self {
        Self {
            world_a: world(),
            world_b: world(),
            faults_a: Faults::default(),
            faults_b: Faults::default(),
            retry: RetryPolicy::none(),
        }
    }
}

struct Run {
    network: SimNetwork,
    plan: AccountPlan,
    index_specs: Vec<ProviderSpec>,
    state_specs: Vec<ProviderSpec>,
    root: PathBuf,
    store: Store,
    retry: RetryPolicy,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn temp_root(tag: &str) -> Result<PathBuf, Box<dyn Error>> {
    Ok(std::env::temp_dir().join(format!(
        "nqc-rmc009-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    )))
}

fn prepare(setup: &Setup, tag: &str) -> Result<Run, Box<dyn Error>> {
    let sim_a = chain(&setup.world_a)?;
    let sim_b = chain(&setup.world_b)?;
    let mut network = SimNetwork::new();
    network.add(
        A,
        SimProvider::new(
            Arc::new(Mutex::new(sim_a.clone())),
            setup.faults_a.clone(),
            5,
        ),
    );
    network.add(
        B,
        SimProvider::new(Arc::new(Mutex::new(sim_b)), setup.faults_b.clone(), 3),
    );
    let root = temp_root(tag)?;
    Ok(Run {
        network,
        plan: plan(&sim_a)?,
        index_specs: vec![
            SimProvider::spec(A, "index-a", 5, 4)?,
            SimProvider::spec(B, "index-b", 3, 1)?,
        ],
        state_specs: vec![
            SimProvider::spec(A, "state-a", 5, 3)?,
            SimProvider::spec(B, "state-b", 3, 2)?,
        ],
        store: Store::create(&root, StoreConfig::standard())?,
        root,
        retry: setup.retry.clone(),
    })
}

impl Run {
    fn acquisition<'a>(&'a self, transport: &'a dyn Transport) -> Acquisition<'a> {
        Acquisition::new(&self.store, transport, self.retry.clone())
    }

    fn index(&self) -> Result<(Vec<Json>, Candidates), Box<dyn Error>> {
        let acquisition = self.acquisition(&self.network);
        let mut records = Vec::new();
        // Different partition counts per provider: the job grid is global.
        for (spec, partitions) in self.index_specs.iter().zip([2_u64, 3]) {
            for partition in 0..partitions {
                records.push(
                    account_index_stage(&acquisition, spec, &self.plan, partition, partitions)?.0,
                );
            }
        }
        let stages = records
            .iter()
            .map(|record| {
                replay_account_stage(&self.store, &self.index_specs, &self.plan, None, record)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let (candidates, _) = derive_candidates(&stages, &self.plan)?;
        Ok((records, candidates))
    }

    fn state(&self, candidates: &Candidates) -> Result<Vec<Json>, Box<dyn Error>> {
        let acquisition = self.acquisition(&self.network);
        let mut records = Vec::new();
        for spec in &self.state_specs {
            records.push(account_tokens_stage(&acquisition, spec, &self.plan)?.0);
        }
        for (spec, partitions) in self.state_specs.iter().zip([2_u64, 3]) {
            for partition in 0..partitions {
                records.push(
                    account_state_stage(
                        &acquisition,
                        spec,
                        &self.plan,
                        candidates,
                        partition,
                        partitions,
                    )?
                    .0,
                );
            }
        }
        Ok(records)
    }

    fn full(&self) -> Result<(Vec<Json>, Candidates), Box<dyn Error>> {
        let (mut records, candidates) = self.index()?;
        records.extend(self.state(&candidates)?);
        Ok((records, candidates))
    }

    fn reconcile(
        &self,
        records: &[Json],
        candidates: &Candidates,
    ) -> Result<Reconciled, Box<dyn Error>> {
        Ok(reconcile_offline(
            &self.store,
            &self.index_specs,
            &self.state_specs,
            &self.plan,
            candidates,
            records,
        )?)
    }
}

fn closeout(reconciled: &Reconciled, dir: &std::path::Path) -> Result<Json, Box<dyn Error>> {
    write_closeout(
        dir,
        &CloseoutContext {
            code_commit: &"a".repeat(40),
            code_tree: &"b".repeat(40),
            pins: &[],
            upstream_sources: Json::Array(Vec::new()),
            store_evidence_root: "root",
            stage_stores: Vec::new(),
            record_manifests: Vec::new(),
            mode: nqc_census_accounts::closeout::full_census_mode(&reconciled.index),
        },
        reconciled,
    )
}

fn metric(reconciled: &Reconciled, name: &str) -> i64 {
    reconciled
        .outcome
        .metrics
        .get(name)
        .and_then(Json::as_i64)
        .unwrap_or(-1)
}

#[test]
fn exact_universe_is_conserved_replayable_and_deterministic() -> TestResult {
    let run = prepare(&Setup::clean(), "exact")?;
    let (records, candidates) = run.full()?;
    assert_eq!(candidates.accounts.len(), 5);
    assert_eq!(candidates.pair_count(), 6);
    let reconciled = run.reconcile(&records, &candidates)?;
    let outcome = &reconciled.outcome;
    assert!(outcome.conserved, "{:?}", outcome.mismatches.sorted());
    assert_eq!(outcome.mismatches.unexplained(), 0);
    assert!(outcome.findings.is_empty());
    assert_eq!(metric(&reconciled, "indexed_accounts"), 5);
    assert_eq!(metric(&reconciled, "state_verified_accounts"), 5);
    assert_eq!(metric(&reconciled, "stale_accounts"), 0);
    assert_eq!(metric(&reconciled, "missing_holder_tokens"), 0);
    assert_eq!(metric(&reconciled, "extra_accounts"), 1);
    assert_eq!(metric(&reconciled, "mismatched_accounts"), 0);
    assert_eq!(metric(&reconciled, "actionable_accounts"), 1);
    assert_eq!(metric(&reconciled, "position_holders"), 4);
    assert_eq!(metric(&reconciled, "health_factor_below_one"), 1);
    assert_eq!(metric(&reconciled, "conserved_tokens"), 4);
    // u3 holds aTokens it received by transfer without a collateral flag:
    // recorded, not hidden, and not a reconstruction mismatch.
    assert_eq!(metric(&reconciled, "configuration_divergences"), 0);
    let first = temp_root("closeout-a")?;
    let second = temp_root("closeout-b")?;
    let summary = closeout(&reconciled, &first)?;
    assert_eq!(summary.str_field("status")?, "RMC_009_PASS_CANDIDATE");
    closeout(&run.reconcile(&records, &candidates)?, &second)?;
    // The independent recount (Python, no shared code) accepts the closeout.
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ci/nqc-census/recount_account_universe.py");
    let recount = std::process::Command::new("python3")
        .arg(script)
        .arg(&first)
        .output()?;
    let stdout = String::from_utf8_lossy(&recount.stdout);
    assert!(
        recount.status.success() && stdout.contains("RMC009_INDEPENDENT_RECOUNT_PASS accounts=5"),
        "{stdout}{}",
        String::from_utf8_lossy(&recount.stderr)
    );
    for entry in std::fs::read_dir(&first)? {
        let name = entry?.file_name();
        assert_eq!(
            std::fs::read(first.join(&name))?,
            std::fs::read(second.join(&name))?,
            "{name:?} is not deterministic"
        );
    }
    std::fs::remove_dir_all(first)?;
    std::fs::remove_dir_all(second)?;
    Ok(())
}

#[test]
fn a_holder_without_logs_breaks_conservation_and_blocks() -> TestResult {
    let mut setup = Setup::clean();
    for world in [&mut setup.world_a, &mut setup.world_b] {
        let a1 = reserve(1)[1];
        world.balances.push((a1, user(5), 50, 50));
        world.totals.retain(|(token, _)| *token != a1);
        world.totals.push((a1, 550));
    }
    let run = prepare(&setup, "missing")?;
    let (records, candidates) = run.full()?;
    let reconciled = run.reconcile(&records, &candidates)?;
    assert!(!reconciled.outcome.conserved);
    assert_eq!(metric(&reconciled, "missing_holder_tokens"), 1);
    assert!(reconciled
        .outcome
        .mismatches
        .sorted()
        .iter()
        .any(
            |m| m.dimension == "SCALED_SUPPLY_CONSERVATION_MISSING_HOLDERS"
                && m.expected == "550"
                && m.observed == "500"
        ));
    let dir = temp_root("closeout-missing")?;
    assert!(closeout(&reconciled, &dir).is_err());
    let summary = Json::parse(&std::fs::read(dir.join("account-summary.json"))?)?;
    assert_eq!(summary.str_field("status")?, "RMC_009_BLOCKED");
    std::fs::remove_dir_all(dir)?;
    Ok(())
}

#[test]
fn a_provider_omitting_a_log_fails_closed() -> TestResult {
    let mut setup = Setup::clean();
    setup.faults_b.omit_logs.insert((BASE + 20, 1));
    let run = prepare(&setup, "omit")?;
    let error = run.index().err().ok_or("disagreement accepted")?;
    assert!(error.to_string().contains("disagree"), "{error}");
    Ok(())
}

#[test]
fn state_disagreement_between_providers_fails_closed() -> TestResult {
    let mut setup = Setup::clean();
    setup.world_b.balances[2].3 = 304;
    let run = prepare(&setup, "state-disagree")?;
    let (records, candidates) = run.full()?;
    let error = run
        .reconcile(&records, &candidates)
        .err()
        .ok_or("disagreement accepted")?;
    assert!(error.to_string().contains("disagree"), "{error}");
    Ok(())
}

#[test]
fn stable_debt_and_tampered_records_are_refused() -> TestResult {
    let mut setup = Setup::clean();
    setup.world_a.stable_total = 9;
    setup.world_b.stable_total = 9;
    let run = prepare(&setup, "stable")?;
    let (records, candidates) = run.full()?;
    let reconciled = run.reconcile(&records, &candidates)?;
    assert!(reconciled
        .outcome
        .findings
        .iter()
        .any(|finding| finding.starts_with("STABLE_DEBT_POSITIONS_PRESENT")));
    let dir = temp_root("closeout-stable")?;
    assert!(closeout(&reconciled, &dir).is_err());
    std::fs::remove_dir_all(dir)?;

    // A record whose declared data no longer matches its evidence.
    let mut tampered = records.clone();
    let last = tampered.len() - 1;
    let text = tampered[last].canonical_string()?;
    let data = tampered[last].str_field("data_sha256")?.to_owned();
    tampered[last] = Json::parse(text.replace(&data, &"0".repeat(64)).as_bytes())?;
    assert!(run.reconcile(&tampered, &candidates).is_err());
    // Candidates that are not the replayed index are refused.
    let mut other = candidates.clone();
    other.accounts.pop();
    assert!(run.reconcile(&records, &other).is_err());
    Ok(())
}

#[test]
fn an_interrupted_stage_resumes_to_the_identical_record() -> TestResult {
    let clean = prepare(&Setup::clean(), "resume-clean")?;
    let (_, candidates) = clean.index()?;
    let spec = &clean.state_specs[0];
    let expected = account_state_stage(
        &clean.acquisition(&clean.network),
        spec,
        &clean.plan,
        &candidates,
        0,
        1,
    )?
    .0;
    let crashed = prepare(&Setup::clean(), "resume-crash")?;
    let interrupted = InterruptAfter::new(&crashed.network, 4);
    assert!(account_state_stage(
        &crashed.acquisition(&interrupted),
        spec,
        &crashed.plan,
        &candidates,
        0,
        1
    )
    .is_err());
    let resumed = account_state_stage(
        &crashed.acquisition(&crashed.network),
        spec,
        &crashed.plan,
        &candidates,
        0,
        1,
    )?
    .0;
    assert!(resumed.same_as(&expected)?);
    Ok(())
}

#[test]
fn rate_limited_logs_are_retried_never_read_as_empty() -> TestResult {
    let mut setup = Setup::clean();
    setup.faults_a.rate_limit_first = 3;
    setup.retry = RetryPolicy {
        delays_ms: vec![0; 4],
    };
    let run = prepare(&setup, "rate")?;
    let (records, candidates) = run.full()?;
    assert_eq!(candidates.pair_count(), 6);
    assert!(run.reconcile(&records, &candidates)?.outcome.conserved);
    Ok(())
}

#[test]
fn candidates_round_trip_and_reject_unsorted_input() -> TestResult {
    let mut pairs = std::collections::BTreeSet::new();
    pairs.insert((address(2), address(9)));
    pairs.insert((address(1), address(9)));
    pairs.insert((address(1), address(3)));
    let candidates = Candidates::from_pairs(&pairs);
    let bytes = candidates.to_jsonl()?;
    assert_eq!(Candidates::from_jsonl(&bytes)?, candidates);
    let text = String::from_utf8(bytes)?;
    let reversed: Vec<&str> = text.lines().rev().collect();
    assert!(Candidates::from_jsonl(reversed.join("\n").as_bytes()).is_err());
    Ok(())
}

#[test]
fn configuration_flag_divergence_is_recorded_not_hidden() -> TestResult {
    let mut setup = Setup::clean();
    for world in [&mut setup.world_a, &mut setup.world_b] {
        // u4 has no balance but a borrowing flag on reserve 0 (bit 0).
        world.accounts[3].1 = 0b1;
    }
    let run = prepare(&setup, "divergence")?;
    let (records, candidates) = run.full()?;
    let reconciled = run.reconcile(&records, &candidates)?;
    assert_eq!(metric(&reconciled, "configuration_divergences"), 1);
    assert_eq!(metric(&reconciled, "extra_accounts"), 0);
    let divergence = &reconciled.outcome.divergences[0];
    assert_eq!(divergence.str_field("code")?, "BORROWING_FLAG_WITHOUT_DEBT");
    assert_eq!(divergence.str_field("account")?, user(4).to_hex());
    // An exact protocol fact, recorded in its own ledger; the universe is
    // still exact and conserved.
    assert!(reconciled.outcome.conserved);
    assert_eq!(reconciled.outcome.mismatches.unexplained(), 0);
    Ok(())
}

#[test]
fn an_undeclared_log_shape_fails_closed() -> TestResult {
    let mut setup = Setup::clean();
    let v1 = reserve(1)[3];
    for world in [&mut setup.world_a, &mut setup.world_b] {
        // Variable debt tokens are not transferable: a BalanceTransfer from
        // one is outside the declared semantics.
        world
            .logs
            .push(transfer(BASE + 33, 0, v1, user(1), user(2)));
    }
    let run = prepare(&setup, "shape")?;
    let error = run.index().err().ok_or("undeclared shape accepted")?;
    assert!(
        error.to_string().contains("undeclared account log shape"),
        "{error}"
    );
    Ok(())
}

#[test]
fn declared_provider_files_parse_as_two_distinct_providers() -> TestResult {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ci/nqc-census");
    for (file, labels) in [
        (
            "account-index-providers.json",
            ["mevblocker-rpc", "tenderly-public"],
        ),
        (
            "state-providers.json",
            ["blastapi-public", "mevblocker-rpc"],
        ),
    ] {
        let set = nqc_census_chain::provider::ProviderSet::parse(&std::fs::read(root.join(file))?)?;
        let found: Vec<&str> = set.iter().map(ProviderSpec::label).collect();
        assert_eq!(found, labels, "{file}");
    }
    Ok(())
}

#[test]
fn the_committed_pins_bind_certified_d06_with_complete_identity() -> TestResult {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../ci/nqc-census");
    let pins = Json::parse(&std::fs::read(root.join("account-inputs.json"))?)?;
    assert_eq!(pins.str_field("status")?, "PINNED");
    let [source] = pins
        .get("sources")
        .and_then(Json::as_array)
        .ok_or("sources")?
    else {
        return Err("exactly one upstream source".into());
    };
    assert_eq!(source.str_field("node")?, "D06");
    assert_eq!(
        source.str_field("code_commit")?,
        "a33a012591cd6625ddb921d995bb1bd95b4a5406"
    );
    assert_eq!(
        source.str_field("code_tree")?,
        "eda36fdc07e82ccdcc9666799fa8fe21aacc7f1d"
    );
    assert_eq!(
        source.str_field("evidence_manifest_sha256")?,
        "81e53c6f76ff71c47df6186afddef05756dbb4ed1261fa3b694183ecefdce44b"
    );
    let mut roles: Vec<&str> = pins
        .get("files")
        .and_then(Json::as_array)
        .ok_or("files")?
        .iter()
        .map(|file| file.str_field("role"))
        .collect::<Result<_, _>>()?;
    roles.sort_unstable();
    assert_eq!(
        roles,
        [
            "d06_current_surface",
            "d06_deployment_manifest",
            "d06_evidence_manifest",
            "d06_history",
            "d06_reserve_manifest",
        ]
    );
    Ok(())
}

/// Extracts of every record, each replayed from the run's store.
fn extracts(
    run: &Run,
    records: &[Json],
    candidates: &Candidates,
) -> Result<Vec<Json>, Box<dyn Error>> {
    let report = nqc_census_store::verify::verify_store(
        &run.root,
        &nqc_census_store::verify::VerifyRequest::default(),
    )
    .map_err(|failure| failure.to_string())?;
    let summary = Json::object([
        ("stage_artifact", Json::string("synthetic")),
        ("evidence_root", Json::string(report.evidence_root)),
    ]);
    let mut out = Vec::new();
    for record in records {
        let (specs, with) = match record.str_field("stage")? {
            "ACCOUNT_INDEX" => (&run.index_specs, None),
            "ACCOUNT_STATE" => (&run.state_specs, Some(candidates)),
            _ => (&run.state_specs, None),
        };
        out.push(stage_extract(
            &run.store,
            specs,
            &run.plan,
            with,
            record,
            summary.clone(),
        )?);
    }
    Ok(out)
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
fn per_store_extracts_reconcile_to_the_same_census() -> TestResult {
    let run = prepare(&Setup::clean(), "extracts")?;
    let (records, candidates) = run.full()?;
    let merged = run.reconcile(&records, &candidates)?;
    let (from_extracts, extract_records) = reconcile_extracts(
        &run.index_specs,
        &run.state_specs,
        &run.plan,
        &candidates,
        extracts(&run, &records, &candidates)?,
    )?;
    assert_eq!(extract_records.len(), records.len());
    for (left, right) in extract_records.iter().zip(&records) {
        assert!(left.same_as(right)?);
    }
    let first = temp_root("extracts-merged")?;
    let second = temp_root("extracts-split")?;
    closeout(&merged, &first)?;
    closeout(&from_extracts, &second)?;
    let mut names: Vec<_> = std::fs::read_dir(&first)?
        .map(|entry| entry.map(|entry| entry.file_name()))
        .collect::<Result<_, _>>()?;
    names.sort();
    assert!(names.len() >= 9);
    for name in names {
        assert_eq!(
            std::fs::read(first.join(&name))?,
            std::fs::read(second.join(&name))?,
            "{name:?}"
        );
    }
    let _ = std::fs::remove_dir_all(first);
    let _ = std::fs::remove_dir_all(second);
    Ok(())
}

#[test]
fn a_foreign_or_tampered_account_extract_is_refused() -> TestResult {
    let run = prepare(&Setup::clean(), "extract-tamper")?;
    let (records, candidates) = run.full()?;
    let original = extracts(&run, &records, &candidates)?;
    let reject = |extracts: Vec<Json>, plan: &AccountPlan, needle: &str| match extract_stages(
        &run.index_specs,
        &run.state_specs,
        plan,
        extracts,
    ) {
        Err(error) if error.to_string().contains(needle) => Ok(()),
        Err(error) => Err(format!("expected {needle}, got {error}")),
        Ok(_) => Err(format!("accepted, expected {needle}")),
    };
    // A changed row, even with the extract's own digest rewritten.
    let rows = original[0]
        .get("rows")
        .and_then(Json::as_array)
        .ok_or("rows")?;
    let mut changed = rows.to_vec();
    changed[0] = with_field(&rows[0], "log_count", Json::uint(999))?;
    let digest = nqc_census_accounts::stage::data_digest(&changed)?;
    let mut tampered = original.clone();
    tampered[0] = with_field(
        &with_field(&original[0], "rows", Json::Array(changed))?,
        "data_sha256",
        Json::string(digest),
    )?;
    reject(tampered, &run.plan, "data digest")?;
    // A record swapped under the extract.
    let mut tampered = original.clone();
    tampered[0] = with_field(
        &original[0],
        "record",
        original[1].get("record").ok_or("record")?.clone(),
    )?;
    reject(tampered, &run.plan, "record digest")?;
    // Extracts of two chains, or of another anchor, or for another plan.
    let domain = original[1].get("chain_domain").ok_or("domain")?;
    let foreign = with_field(
        domain,
        "genesis_hash",
        Json::string("0x".to_owned() + &"9".repeat(64)),
    )?;
    let mut tampered = original.clone();
    tampered[1] = with_field(&original[1], "chain_domain", foreign)?;
    reject(tampered, &run.plan, "different chain domains")?;
    let mut other_anchor = run.plan.clone();
    other_anchor.anchor = AnchorPlan {
        number: run.plan.anchor.number - 1,
        ..run.plan.anchor.clone()
    };
    reject(
        original.clone(),
        &other_anchor,
        "differs from the plan anchor",
    )?;
    let other_plan = run
        .plan
        .clone()
        .with_index_start(run.plan.index_start + 1)?;
    let record = original[0].get("record").ok_or("record")?;
    let parameters = record.get("parameters").ok_or("parameters")?;
    let moved = with_field(
        record,
        "parameters",
        with_field(parameters, "tokens_sha256", Json::string("0".repeat(64)))?,
    )?;
    let mut tampered = original.clone();
    tampered[0] = with_field(
        &with_field(&original[0], "record", moved.clone())?,
        "record_sha256",
        Json::string(nqc_census_state::stage::sha256_plain(&moved.canonical()?)),
    )?;
    reject(tampered, &run.plan, "another plan")?;
    // A plan the index stages were not run for is refused downstream.
    assert!(reconcile_extracts(
        &run.index_specs,
        &run.state_specs,
        &other_plan,
        &candidates,
        original,
    )
    .is_err());
    Ok(())
}

/// Refuses any log range that returns more than `cap` logs, in the shape the
/// declared providers use: MEV Blocker (`mev`) answers `-32005` with the
/// count in the message; Tenderly (every other namespace) answers `-32602
/// invalid params` with the count only in `data`.
struct ResultCap<'a> {
    inner: &'a dyn Transport,
    cap: usize,
    mev: u16,
    refused: std::sync::atomic::AtomicU64,
}

impl<'a> ResultCap<'a> {
    fn new(inner: &'a dyn Transport, cap: usize) -> Self {
        Self {
            inner,
            cap,
            mev: A,
            refused: std::sync::atomic::AtomicU64::new(0),
        }
    }

    fn refused(&self) -> u64 {
        self.refused.load(std::sync::atomic::Ordering::SeqCst)
    }

    fn cap_reply(&self, namespace: u16, reply: &Json) -> Json {
        let Some(logs) = reply.get("result").and_then(Json::as_array) else {
            return reply.clone();
        };
        if logs.len() <= self.cap || !logs.iter().all(|log| log.get("logIndex").is_some()) {
            return reply.clone();
        }
        self.refused
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let text = format!("query returned more than {} results", self.cap);
        let error = if namespace == self.mev {
            Json::object([("code", Json::int(-32005)), ("message", Json::string(text))])
        } else {
            Json::object([
                ("code", Json::int(-32602)),
                ("message", Json::string("invalid params")),
                ("data", Json::string(text)),
            ])
        };
        Json::object([
            ("jsonrpc", Json::string("2.0")),
            ("id", reply.get("id").cloned().unwrap_or(Json::Null)),
            ("error", error),
        ])
    }
}

impl Transport for ResultCap<'_> {
    fn post(
        &self,
        provider: &ProviderSpec,
        body: &[u8],
    ) -> Result<nqc_census_chain::transport::HttpReply, nqc_census_chain::ChainError> {
        let reply = self.inner.post(provider, body)?;
        let namespace = provider.namespace();
        let capped = match Json::parse(&reply.body)? {
            Json::Array(items) => Json::Array(
                items
                    .iter()
                    .map(|item| self.cap_reply(namespace, item))
                    .collect(),
            ),
            single => self.cap_reply(namespace, &single),
        };
        Ok(nqc_census_chain::transport::HttpReply {
            status: reply.status,
            body: capped.canonical()?,
        })
    }
}

/// Two extra mint pairs per block at BASE+16 and BASE+17 for an existing
/// (token, account) pair: denser logs, the same candidates and balances.
fn dense() -> Setup {
    let mut setup = Setup::clean();
    let a1 = reserve(1)[1];
    for world in [&mut setup.world_a, &mut setup.world_b] {
        for block in [BASE + 16, BASE + 17] {
            for index in 0..2 {
                world.logs.push(mint(block, index, a1, user(2)));
            }
        }
    }
    setup
}

fn index_records(run: &Run, transport: &dyn Transport) -> Result<Vec<Json>, Box<dyn Error>> {
    let acquisition = run.acquisition(transport);
    let mut records = Vec::new();
    for (spec, partitions) in run.index_specs.iter().zip([2_u64, 3]) {
        for partition in 0..partitions {
            records
                .push(account_index_stage(&acquisition, spec, &run.plan, partition, partitions)?.0);
        }
    }
    Ok(records)
}

#[test]
fn result_capped_ranges_descend_the_window_ladder_and_reconcile_exactly() -> TestResult {
    let reference = prepare(&dense(), "cap-reference")?;
    let expected = index_records(&reference, &reference.network)?;

    let run = prepare(&dense(), "cap-ladder")?;
    let capped = ResultCap::new(&run.network, 2);
    let records = index_records(&run, &capped)?;
    // Both refusal shapes happened and neither was read as empty or retried
    // into a pass: each provider descended to a window its cap answers.
    assert!(capped.refused() >= 2, "{}", capped.refused());
    assert_eq!(records.len(), expected.len());
    let mut descended = 0;
    for (record, reference) in records.iter().zip(&expected) {
        // Economic content is identical; only provenance (the committed
        // rung's manifests) differs.
        assert_eq!(
            record.str_field("data_sha256")?,
            reference.str_field("data_sha256")?
        );
        if !record.same_as(reference)? {
            descended += 1;
        }
    }
    assert!(descended >= 2, "{descended}");

    // Resume and offline replay find each job's committed rung read-only.
    let resumed = index_records(&run, &capped)?;
    for (left, right) in resumed.iter().zip(&records) {
        assert!(left.same_as(right)?);
    }
    let stages = records
        .iter()
        .map(|record| replay_account_stage(&run.store, &run.index_specs, &run.plan, None, record))
        .collect::<Result<Vec<_>, _>>()?;
    let (candidates, _) = derive_candidates(&stages, &run.plan)?;
    assert_eq!(candidates.pair_count(), 6);
    let mut all = records.clone();
    all.extend(run.state(&candidates)?);
    let reconciled = run.reconcile(&all, &candidates)?;
    assert!(reconciled.outcome.conserved);
    assert_eq!(reconciled.outcome.mismatches.unexplained(), 0);
    // The store, with the refused rungs' empty streams, verifies and every
    // record extracts from it.
    assert_eq!(extracts(&run, &all, &candidates)?.len(), all.len());
    Ok(())
}

#[test]
fn a_result_cap_below_the_ladder_floor_fails_closed_and_commits_nothing() -> TestResult {
    let run = prepare(&dense(), "cap-floor")?;
    // BASE+16 alone holds two logs: no window answers under a cap of one.
    let capped = ResultCap::new(&run.network, 1);
    for spec in &run.index_specs {
        let error = account_index_stage(&run.acquisition(&capped), spec, &run.plan, 0, 1)
            .err()
            .ok_or("a capped range was accepted")?;
        let text = error.to_string();
        assert!(
            text.contains("RMC009_RESULT_CAP_FLOOR") && text.contains("window=1"),
            "{text}"
        );
    }
    // Only fully answered jobs committed. Under a cap of one, the job
    // BASE+9..=BASE+15 committed on the two-block rung; the job holding
    // BASE+16 committed on no rung. Without the cap, the same store resumes to
    // the economic content of an unrefused run. The refused job then runs
    // live on the declared window, exactly as in the unrefused run.
    let reference = prepare(&dense(), "cap-floor-reference")?;
    for spec in 0..run.index_specs.len() {
        let expected = account_index_stage(
            &reference.acquisition(&reference.network),
            &reference.index_specs[spec],
            &reference.plan,
            0,
            1,
        )?
        .0;
        let recovered = account_index_stage(
            &run.acquisition(&run.network),
            &run.index_specs[spec],
            &run.plan,
            0,
            1,
        )?
        .0;
        assert_eq!(
            recovered.str_field("data_sha256")?,
            expected.str_field("data_sha256")?
        );
        let manifests = |record: &Json| -> Result<Vec<Json>, Box<dyn Error>> {
            Ok(record
                .get("manifests")
                .and_then(Json::as_array)
                .ok_or("record without manifests")?
                .to_vec())
        };
        // Bootstrap, anchor, then one manifest per job: index 4 is the job
        // holding BASE+16.
        assert!(manifests(&recovered)?[4].same_as(&manifests(&expected)?[4])?);
        replay_account_stage(&run.store, &run.index_specs, &run.plan, None, &recovered)?;
    }
    Ok(())
}

/// Aave V3 credits the zero address when aTokens are transferred to it or
/// supplied on its behalf. Mainnet run 36674256094 indexed 13 such logs.
fn zero_transfer(block: u64, log_index: u32, token: Address, from: Address) -> SimLog {
    SimLog {
        block,
        transaction_index: 0,
        log_index,
        address: token,
        topics: vec![balance_transfer_topic(), word_a(from), [0_u8; 32]],
        data: [word(20), word(1)].concat(),
    }
}

#[test]
fn a_zero_address_holding_is_conserved_and_never_an_account() -> TestResult {
    let a1 = reserve(1)[1];
    let a0 = reserve(0)[1];
    let mut setup = Setup::clean();
    for world in [&mut setup.world_a, &mut setup.world_b] {
        // u2 sends 20 scaled aTokens of reserve 1 to the zero address.
        world.logs.push(zero_transfer(BASE + 22, 0, a1, user(2)));
        world.zero_holdings.push((a1, 20));
        for total in &mut world.totals {
            if total.0 == a1 {
                total.1 += 20;
            }
        }
        // The zero address also holds reserve 0 without any indexed log:
        // the holding is read at the anchor, never inferred from logs.
        world.zero_holdings.push((a0, 3));
        for total in &mut world.totals {
            if total.0 == a0 {
                total.1 += 3;
            }
        }
    }
    let run = prepare(&setup, "zero-holder")?;
    let (records, candidates) = run.full()?;
    // The zero address is not an account and not a candidate.
    assert_eq!(candidates.accounts.len(), 5);
    let reconciled = run.reconcile(&records, &candidates)?;
    let outcome = &reconciled.outcome;
    assert!(outcome.conserved, "{:?}", outcome.mismatches.sorted());
    assert_eq!(outcome.mismatches.unexplained(), 0);
    assert!(outcome.findings.is_empty(), "{:?}", outcome.findings);
    // The log is evidence (provenance, by coordinate); the holding is state.
    assert_eq!(reconciled.index.zero_account_logs, 1);
    let [zero_log] = reconciled.index.zero_account_log_refs.as_slice() else {
        return Err("one zero-address log ref".into());
    };
    assert_eq!(zero_log.get("block"), Some(&Json::uint(BASE + 22)));
    assert_eq!(zero_log.str_field("token")?, a1.to_hex());
    assert_eq!(zero_log.str_field("event")?, "BALANCE_TRANSFER");
    assert_eq!(metric(&reconciled, "zero_address_holding_tokens"), 2);
    assert_eq!(metric(&reconciled, "indexed_accounts"), 5);
    let row = outcome
        .conservation
        .iter()
        .find(|row| row.str_field("token").ok() == Some(a1.to_hex().as_str()))
        .ok_or("a1 conservation row")?;
    assert_eq!(row.str_field("zero_address_scaled_balance")?, "20");
    assert_eq!(row.str_field("status")?, "CONSERVED");
    // The independent recount accepts the zero term.
    let dir = temp_root("zero-closeout")?;
    closeout(&reconciled, &dir)?;
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ci/nqc-census/recount_account_universe.py");
    let recount = std::process::Command::new("python3")
        .arg(script)
        .arg(&dir)
        .output()?;
    let stdout = String::from_utf8_lossy(&recount.stdout);
    assert!(
        recount.status.success()
            && stdout.contains("RMC009_INDEPENDENT_RECOUNT_PASS accounts=5")
            && stdout.contains("zero_address_logs=1 zero_address_holding_tokens=2"),
        "{stdout}{}",
        String::from_utf8_lossy(&recount.stderr)
    );
    tampered_zero_terms_fail_the_recount(&dir, &a1)?;
    std::fs::remove_dir_all(dir)?;

    // A zero-address holding the supply does not include is excess, never
    // absorbed: conservation stays exact.
    let mut excess = setup.clone();
    for world in [&mut excess.world_a, &mut excess.world_b] {
        world.zero_holdings.retain(|(token, _)| *token != a0);
        world.zero_holdings.push((a0, 4));
    }
    let run = prepare(&excess, "zero-excess")?;
    let (records, candidates) = run.full()?;
    let reconciled = run.reconcile(&records, &candidates)?;
    assert!(!reconciled.outcome.conserved);
    assert_eq!(metric(&reconciled, "excess_supply_tokens"), 1);
    Ok(())
}

fn recount(dir: &std::path::Path) -> Result<std::process::Output, Box<dyn Error>> {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ci/nqc-census/recount_account_universe.py");
    Ok(std::process::Command::new("python3")
        .arg(script)
        .arg(dir)
        .output()?)
}

/// Rewrites one closeout file and, when `rehash`, its evidence-manifest digest
/// too, so the recount's own identity checks are what must refuse it.
fn tamper(
    dir: &std::path::Path,
    name: &str,
    from: &str,
    to: &str,
    rehash: bool,
) -> Result<std::path::PathBuf, Box<dyn Error>> {
    let copy = temp_root("zero-tamper")?;
    std::fs::create_dir_all(&copy)?;
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        std::fs::copy(entry.path(), copy.join(entry.file_name()))?;
    }
    let before = std::fs::read(copy.join(name))?;
    let text = String::from_utf8(before.clone())?;
    if !text.contains(from) {
        return Err(format!("{name} does not contain {from}").into());
    }
    let after = text.replacen(from, to, 1).into_bytes();
    std::fs::write(copy.join(name), &after)?;
    if rehash {
        let manifest = std::fs::read_to_string(copy.join("evidence-manifest.json"))?;
        let (old, new) = (
            nqc_census_state::stage::sha256_plain(&before),
            nqc_census_state::stage::sha256_plain(&after),
        );
        std::fs::write(
            copy.join("evidence-manifest.json"),
            manifest.replace(&old, &new),
        )?;
    }
    Ok(copy)
}

fn tampered_zero_terms_fail_the_recount(
    dir: &std::path::Path,
    a1: &Address,
) -> Result<(), Box<dyn Error>> {
    let zero_term = r#""zero_address_scaled_balance":"20""#;
    for (name, from, to, rehash, needle) in [
        // Any byte change is caught by the evidence manifest.
        (
            "token-conservation.jsonl",
            zero_term,
            r#""zero_address_scaled_balance":"19""#,
            false,
            "token-conservation.jsonl",
        ),
        // With a consistent manifest, the identity itself refuses it.
        (
            "token-conservation.jsonl",
            zero_term,
            r#""zero_address_scaled_balance":"19""#,
            true,
            "zero_address_scaled_balance",
        ),
        // A dropped zero term reads as missing.
        (
            "token-conservation.jsonl",
            zero_term,
            r#""zero_address_scaled_balance":null"#,
            true,
            "int()",
        ),
        // A zero-address log ref that names no census token.
        (
            "acquisition-provenance.json",
            &format!(r#""token":"{}""#, a1.to_hex()),
            r#""token":"0x00000000000000000000000000000000000000aa""#,
            true,
            "non-census token",
        ),
    ] {
        let copy = tamper(dir, name, from, to, rehash)?;
        let output = recount(&copy)?;
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        std::fs::remove_dir_all(&copy)?;
        if output.status.success() || !stderr.contains(needle) {
            return Err(
                format!("tampered {name} ({to}) not refused for {needle}: {stderr}").into(),
            );
        }
    }
    Ok(())
}

/// The zero-address conservation term is a read fact: unread, disputed,
/// malformed, missing or duplicated evidence of it fails closed.
#[test]
fn a_zero_address_term_that_is_unaccounted_disputed_malformed_missing_or_duplicated_fails_closed(
) -> TestResult {
    let a1 = reserve(1)[1];
    let holding = |setup: &mut Setup| {
        for world in [&mut setup.world_a, &mut setup.world_b] {
            world.logs.push(zero_transfer(BASE + 22, 0, a1, user(2)));
            world.zero_holdings.push((a1, 20));
            for total in &mut world.totals {
                if total.0 == a1 {
                    total.1 += 20;
                }
            }
        }
    };

    // Unaccounted: the supply includes a zero-address holding that reads 0.
    let mut setup = Setup::clean();
    holding(&mut setup);
    for world in [&mut setup.world_a, &mut setup.world_b] {
        world.zero_holdings.clear();
    }
    let run = prepare(&setup, "zero-unaccounted")?;
    let (records, candidates) = run.full()?;
    let reconciled = run.reconcile(&records, &candidates)?;
    assert!(!reconciled.outcome.conserved);
    assert_eq!(metric(&reconciled, "missing_holder_tokens"), 1);
    assert!(reconciled.outcome.mismatches.sorted().iter().any(|m| {
        m.dimension == "SCALED_SUPPLY_CONSERVATION_MISSING_HOLDERS"
            && m.expected == "520"
            && m.observed == "500"
    }));
    let dir = temp_root("zero-unaccounted-closeout")?;
    assert!(closeout(&reconciled, &dir).is_err());
    std::fs::remove_dir_all(dir)?;

    // Disputed: the two providers read different zero-address balances.
    let mut setup = Setup::clean();
    holding(&mut setup);
    setup.world_b.zero_holdings = vec![(a1, 21)];
    let run = prepare(&setup, "zero-disputed")?;
    let (records, candidates) = run.full()?;
    let error = run
        .reconcile(&records, &candidates)
        .err()
        .ok_or("disputed zero term accepted")?;
    assert!(error.to_string().contains("disagree"), "{error}");

    // Malformed or reverted: not a uint256, never read as zero.
    for (tag, reply) in [
        ("zero-short", CallOutcome::Returned(vec![0_u8; 31])),
        ("zero-reverted", CallOutcome::Reverted(Vec::new())),
    ] {
        let mut setup = Setup::clean();
        holding(&mut setup);
        for world in [&mut setup.world_a, &mut setup.world_b] {
            world.zero_replies.push((a1, reply.clone()));
        }
        let run = prepare(&setup, tag)?;
        let (records, candidates) = run.full()?;
        let reconciled = run.reconcile(&records, &candidates)?;
        assert!(!reconciled.outcome.conserved, "{tag}");
        assert!(reconciled.outcome.conservation.iter().any(|row| {
            row.str_field("status").ok() == Some("ZERO_ADDRESS_BALANCE_UNREADABLE")
        }));
        assert!(reconciled
            .outcome
            .mismatches
            .sorted()
            .iter()
            .any(|m| m.dimension == "ZERO_ADDRESS_SCALED_BALANCE"));
        let dir = temp_root("zero-malformed-closeout")?;
        assert!(closeout(&reconciled, &dir).is_err(), "{tag}");
        std::fs::remove_dir_all(dir)?;
    }

    // Missing: a token record without the zero term is refused, not zeroed.
    let mut setup = Setup::clean();
    holding(&mut setup);
    let run = prepare(&setup, "zero-missing")?;
    let (records, candidates) = run.full()?;
    let (mut index, mut tokens, mut state) = (Vec::new(), Vec::new(), Vec::new());
    for record in &records {
        match record.str_field("stage")? {
            "ACCOUNT_INDEX" => index.push(replay_account_stage(
                &run.store,
                &run.index_specs,
                &run.plan,
                None,
                record,
            )?),
            "ACCOUNT_STATE" => state.push(replay_account_stage(
                &run.store,
                &run.state_specs,
                &run.plan,
                Some(&candidates),
                record,
            )?),
            _ => tokens.push(replay_account_stage(
                &run.store,
                &run.state_specs,
                &run.plan,
                None,
                record,
            )?),
        }
    }
    let (_, facts) = derive_candidates(&index, &run.plan)?;
    for stage in &mut tokens {
        for row in &mut stage.rows {
            let members = row.as_object().ok_or("token row")?;
            *row = Json::Object(
                members
                    .iter()
                    .filter(|(name, _)| name != "a_token_zero_address_scaled_balance")
                    .cloned()
                    .collect(),
            );
        }
    }
    let error = verify_accounts(VerifyInputs {
        plan: &run.plan,
        candidates: &candidates,
        index: &facts,
        tokens,
        state,
    })
    .err()
    .ok_or("missing zero term accepted")?;
    assert!(
        error
            .to_string()
            .contains("a_token_zero_address_scaled_balance missing"),
        "{error}"
    );

    // Duplicated: one provider returning the same zero-address log twice.
    let mut setup = Setup::clean();
    holding(&mut setup);
    setup
        .world_a
        .logs
        .push(zero_transfer(BASE + 22, 0, a1, user(2)));
    let run = prepare(&setup, "zero-duplicate")?;
    let error = run.index().err().ok_or("duplicate zero log accepted")?;
    assert!(
        error.to_string().contains("duplicate log coordinates"),
        "{error}"
    );
    Ok(())
}
