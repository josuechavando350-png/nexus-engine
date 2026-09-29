//! RMC-009 account universe on a synthetic chain: token-log index on two
//! providers, candidate derivation, anchor state on two providers, replay
//! from the store and per-token conservation. Testkit chains are synthetic,
//! never evidence.

use nqc_census_accounts::candidates::{derive_candidates, Candidates};
use nqc_census_accounts::closeout::{
    reconcile_offline, write_closeout, CloseoutContext, Reconciled,
};
use nqc_census_accounts::index::account_index_stage;
use nqc_census_accounts::plan::{balance_transfer_topic, mint_topic, AccountPlan, ReserveTokens};
use nqc_census_accounts::replay::replay_account_stage;
use nqc_census_accounts::state::account_state_stage;
use nqc_census_accounts::tokens::account_tokens_stage;
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
            store_evidence_root: "root",
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
