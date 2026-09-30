//! RMC-010 on a synthetic chain: a certified base at A0, then the census at
//! A1 reached twice — a full census and an incremental refresh from the base
//! — whose census artifacts must be byte-identical; and every way a refresh
//! can be wrong failing closed. Testkit chains are synthetic, never evidence.

use nqc_census_accounts::candidates::{derive_candidates, Candidates};
use nqc_census_accounts::closeout::{
    full_census_mode, reconcile_offline, write_closeout, CloseoutContext, Reconciled,
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
use nqc_census_refresh::base::{read_base, BaseCensus};
use nqc_census_refresh::canonical::base_canonicality_stage;
use nqc_census_refresh::parity::census_parity;
use nqc_census_refresh::refresh::{
    delta_plan, reconcile_incremental, refreshed_candidates, Providers,
};
use nqc_census_state::stage::AnchorPlan;
use nqc_census_store::{Store, StoreConfig};
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 60;
const A0: u64 = BASE + 39;
const A1: u64 = BASE + 59;
const A: u16 = 0x0a1a;
const B: u16 = 0x0b1a;

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
fn initialized(k: u8) -> u64 {
    [BASE + 2, BASE + 5, BASE + 42][usize::from(k)]
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

/// State of every candidate at one epoch.
#[derive(Clone)]
struct Epoch {
    /// (token, account, scaled, balance).
    balances: Vec<(Address, Address, u64, u64)>,
    totals: Vec<(Address, u64)>,
    stable_total: u64,
    /// (account, configuration, health factor).
    accounts: Vec<(Address, u64, u64)>,
}

#[derive(Clone)]
struct Scenario {
    logs: Vec<SimLog>,
    base: Epoch,
    target: Epoch,
}

/// A0: u1 supplies reserve 0 and borrows reserve 1, u2 supplies reserve 1
/// and transfers part to u3, u4 withdrew everything, the treasury accrued.
/// (A0, A1]: reserve 2 is initialized and u2 supplies it; u6 supplies
/// reserve 0; u3 transfers to u7; the treasury accrues again; u1 repays its
/// debt; u2 enables reserve 2 as collateral.
fn scenario() -> Scenario {
    let [_, a0, _, v0] = reserve(0);
    let [_, a1, _, v1] = reserve(1);
    let [_, a2, _, v2] = reserve(2);
    let max = u64::MAX;
    Scenario {
        logs: vec![
            mint(BASE + 10, 0, a0, user(1)),
            mint(BASE + 12, 0, v1, user(1)),
            mint(BASE + 15, 0, a1, user(2)),
            transfer(BASE + 20, 1, a1, user(2), user(3)),
            mint(BASE + 25, 0, a0, user(4)),
            mint(BASE + 30, 2, a0, treasury()),
            mint(BASE + 45, 0, a0, user(6)),
            mint(BASE + 47, 0, a2, user(2)),
            transfer(BASE + 50, 3, a1, user(3), user(7)),
            mint(BASE + 52, 1, a0, treasury()),
        ],
        base: Epoch {
            balances: vec![
                (a0, user(1), 1_000, 1_010),
                (v1, user(1), 500, 505),
                (a1, user(2), 300, 303),
                (a1, user(3), 200, 202),
                (a0, user(4), 0, 0),
                (a0, treasury(), 7, 7),
            ],
            totals: vec![(a0, 1_007), (a1, 500), (v1, 500), (v0, 0)],
            stable_total: 0,
            accounts: vec![
                (user(1), 0b110, 900_000_000_000_000_000),
                (user(2), 0b1000, 1_500_000_000_000_000_000),
                (user(3), 0, max),
                (user(4), 0, max),
                (treasury(), 0, max),
            ],
        },
        target: Epoch {
            balances: vec![
                (a0, user(1), 1_000, 1_020),
                (v1, user(1), 0, 0),
                (a1, user(2), 300, 305),
                (a2, user(2), 70, 70),
                (a1, user(3), 150, 152),
                (a1, user(7), 50, 51),
                (a0, user(4), 0, 0),
                (a0, treasury(), 9, 9),
                (a0, user(6), 40, 40),
            ],
            totals: vec![(a0, 1_049), (a1, 500), (v1, 0), (v0, 0), (a2, 70), (v2, 0)],
            stable_total: 0,
            accounts: vec![
                (user(1), 0b10, max),
                (user(2), 0b10_1000, 1_400_000_000_000_000_000),
                (user(3), 0, max),
                (user(4), 0, max),
                (treasury(), 0, max),
                (user(6), 0b10, max),
                (user(7), 0, max),
            ],
        },
    }
}

fn set_epoch(sim: &mut SimChain, epoch: &Epoch, from: u64) {
    for k in 0..3_u8 {
        let [_, a_token, stable, v_token] = reserve(k);
        sim.set_call(
            stable,
            call("totalSupply()", &[]),
            from,
            None,
            returned(&[word(epoch.stable_total)]),
        );
        for token in [a_token, v_token] {
            let total = epoch
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
    for (token, account, scaled, balance) in &epoch.balances {
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
    for (account, configuration, health) in &epoch.accounts {
        let data = [
            ("getUserConfiguration(address)", vec![word(*configuration)]),
            ("getUserEMode(address)", vec![word(0)]),
            (
                "getUserAccountData(address)",
                vec![
                    word(10),
                    word(5),
                    word(1),
                    word(8_000),
                    word(7_500),
                    word(*health),
                ],
            ),
        ];
        for (signature, words) in data {
            sim.set_call(
                pool(),
                call(signature, &[word_a(*account)]),
                from,
                None,
                returned(&words),
            );
        }
    }
}

fn chain(scenario: &Scenario, length: u64) -> Result<SimChain, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, length)?;
    for log in &scenario.logs {
        sim.add_log(log.clone());
    }
    for k in 0..3_u8 {
        let [asset, a_token, stable, v_token] = reserve(k);
        let mut words = vec![word(0); 15];
        words[7] = word(u64::from(k));
        words[8] = word_a(a_token);
        words[9] = word_a(stable);
        words[10] = word_a(v_token);
        sim.set_call(
            pool(),
            call("getReserveData(address)", &[word_a(asset)]),
            BASE + 1,
            None,
            returned(&words),
        );
    }
    set_epoch(&mut sim, &scenario.base, BASE + 1);
    set_epoch(&mut sim, &scenario.target, A0 + 1);
    Ok(sim)
}

fn plan(sim: &SimChain, anchor: u64, reserves: u8) -> Result<AccountPlan, Box<dyn Error>> {
    let reserves = (0..reserves)
        .map(|k| {
            let [asset, a_token, stable, v_token] = reserve(k);
            ReserveTokens {
                asset,
                market_id: format!("market-{k}"),
                reserve_id: Some(u16::from(k)),
                a_token,
                variable_debt_token: v_token,
                stable_debt_token: Some(stable),
                initialized_block: initialized(k),
            }
        })
        .collect();
    Ok(AccountPlan::new(
        AnchorPlan {
            profile: sim.profile()?,
            number: anchor,
            hash: sim.hash_of(anchor).ok_or("anchor")?,
        },
        pool(),
        reserves,
        7,
        2,
    )?)
}

struct Run {
    network: SimNetwork,
    sim: SimChain,
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
        "nqc-rmc010-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    )))
}

#[derive(Clone, Default)]
struct Options {
    faults_a: Faults,
    faults_b: Faults,
    /// Provider B only knows blocks up to this height (a stale provider).
    b_length: Option<u64>,
    /// Extra logs only provider A returns.
    extra_a: Vec<SimLog>,
    retry_delays: Option<usize>,
    /// Both providers serve a chain reorged from this block (with a salt).
    reorg_from: Option<(u64, u8)>,
}

fn prepare(scenario: &Scenario, options: &Options, tag: &str) -> Result<Run, Box<dyn Error>> {
    let mut sim_a = chain(scenario, LENGTH)?;
    for log in &options.extra_a {
        sim_a.add_log(log.clone());
    }
    let mut sim_b = chain(scenario, options.b_length.unwrap_or(LENGTH))?;
    if let Some((from, salt)) = options.reorg_from {
        sim_a.reorg_from(from, salt)?;
        sim_b.reorg_from(from, salt)?;
    }
    let mut network = SimNetwork::new();
    network.add(
        A,
        SimProvider::new(
            Arc::new(Mutex::new(sim_a.clone())),
            options.faults_a.clone(),
            5,
        ),
    );
    network.add(
        B,
        SimProvider::new(Arc::new(Mutex::new(sim_b)), options.faults_b.clone(), 3),
    );
    let root = temp_root(tag)?;
    Ok(Run {
        network,
        index_specs: vec![
            SimProvider::spec(A, "index-a", 5, 4)?,
            SimProvider::spec(B, "index-b", 3, 1)?,
        ],
        state_specs: vec![
            SimProvider::spec(A, "state-a", 5, 3)?,
            SimProvider::spec(B, "state-b", 3, 2)?,
        ],
        store: Store::create(&root, StoreConfig::standard())?,
        sim: sim_a,
        root,
        retry: options
            .retry_delays
            .map_or_else(RetryPolicy::none, |n| RetryPolicy {
                delays_ms: vec![0; n],
            }),
    })
}

impl Run {
    fn acquisition<'a>(&'a self, transport: &'a dyn Transport) -> Acquisition<'a> {
        Acquisition::new(&self.store, transport, self.retry.clone())
    }

    fn index(&self, plan: &AccountPlan) -> Result<(Vec<Json>, Candidates), Box<dyn Error>> {
        let acquisition = self.acquisition(&self.network);
        let mut records = Vec::new();
        for (spec, partitions) in self.index_specs.iter().zip([2_u64, 3]) {
            for partition in 0..partitions {
                records
                    .push(account_index_stage(&acquisition, spec, plan, partition, partitions)?.0);
            }
        }
        let stages = records
            .iter()
            .map(|record| replay_account_stage(&self.store, &self.index_specs, plan, None, record))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((records, derive_candidates(&stages, plan)?.0))
    }

    fn state(
        &self,
        plan: &AccountPlan,
        candidates: &Candidates,
    ) -> Result<Vec<Json>, Box<dyn Error>> {
        let acquisition = self.acquisition(&self.network);
        let mut records = Vec::new();
        for spec in &self.state_specs {
            records.push(account_tokens_stage(&acquisition, spec, plan)?.0);
        }
        for (spec, partitions) in self.state_specs.iter().zip([2_u64, 3]) {
            for partition in 0..partitions {
                records.push(
                    account_state_stage(
                        &acquisition,
                        spec,
                        plan,
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

    /// A full census of `plan`, closed out into `dir`.
    fn full(&self, plan: &AccountPlan, dir: &Path) -> Result<Reconciled, Box<dyn Error>> {
        let (mut records, candidates) = self.index(plan)?;
        records.extend(self.state(plan, &candidates)?);
        let reconciled = reconcile_offline(
            &self.store,
            &self.index_specs,
            &self.state_specs,
            plan,
            &candidates,
            &records,
        )?;
        close(&reconciled, full_census_mode(&reconciled.index), dir)?;
        Ok(reconciled)
    }

    /// Acquisition of an incremental refresh of `target` from `base`.
    fn refresh_records(
        &self,
        target: &AccountPlan,
        base: &BaseCensus,
    ) -> Result<(Vec<Json>, Candidates), Box<dyn Error>> {
        let acquisition = self.acquisition(&self.network);
        let mut records = Vec::new();
        for spec in &self.state_specs {
            records.push(base_canonicality_stage(&acquisition, spec, &target.anchor, base)?.0);
        }
        let delta = delta_plan(target, base)?;
        let (index, delta_candidates) = self.index(&delta)?;
        records.extend(index);
        let candidates = refreshed_candidates(&base.candidates, &delta_candidates);
        records.extend(self.state(target, &candidates)?);
        Ok((records, candidates))
    }

    fn reconcile_refresh(
        &self,
        target: &AccountPlan,
        base: &BaseCensus,
        candidates: &Candidates,
        records: &[Json],
    ) -> Result<(Reconciled, Json), Box<dyn Error>> {
        Ok(reconcile_incremental(
            &self.store,
            &Providers {
                canonicality: &self.state_specs,
                index: &self.index_specs,
                state: &self.state_specs,
            },
            target,
            base,
            candidates,
            records,
        )?)
    }

    fn refresh(
        &self,
        target: &AccountPlan,
        base: &BaseCensus,
        dir: &Path,
    ) -> Result<Reconciled, Box<dyn Error>> {
        let (records, candidates) = self.refresh_records(target, base)?;
        let (reconciled, mode) = self.reconcile_refresh(target, base, &candidates, &records)?;
        close(&reconciled, mode, dir)?;
        Ok(reconciled)
    }
}

fn close(reconciled: &Reconciled, mode: Json, dir: &Path) -> Result<Json, Box<dyn Error>> {
    write_closeout(
        dir,
        &CloseoutContext {
            code_commit: &"a".repeat(40),
            code_tree: &"b".repeat(40),
            pins: &[],
            store_evidence_root: "root",
            stage_stores: Vec::new(),
            record_manifests: Vec::new(),
            mode,
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

struct Dirs(Vec<PathBuf>);

impl Dirs {
    fn new(run: &Run, names: &[&str]) -> Self {
        Self(
            names
                .iter()
                .map(|name| run.root.join(format!("out-{name}")))
                .collect(),
        )
    }
}

/// A certified base at A0.
fn base(run: &Run, dir: &Path) -> Result<BaseCensus, Box<dyn Error>> {
    run.full(&plan(&run.sim, A0, 2)?, dir)?;
    Ok(read_base(dir)?)
}

#[test]
fn incremental_refresh_equals_a_full_census_byte_for_byte() -> TestResult {
    let run = prepare(&scenario(), &Options::default(), "parity")?;
    let dirs = Dirs::new(&run, &["base", "full", "incremental"]);
    let base = base(&run, &dirs.0[0])?;
    assert_eq!(base.candidates.accounts.len(), 5);
    let target = plan(&run.sim, A1, 3)?;
    let full = run.full(&target, &dirs.0[1])?;
    let incremental = run.refresh(&target, &base, &dirs.0[2])?;
    let report = census_parity(&dirs.0[1], &dirs.0[2])?;
    assert_eq!(report.str_field("status")?, "FULL_INCREMENTAL_PARITY_PASS");
    // Producer code identity is provenance, not census state. It remains in
    // the evidence manifest and must not leak into the byte-compared summary.
    let summary = Json::parse(&std::fs::read(dirs.0[1].join("account-summary.json"))?)?;
    assert!(summary.get("code_commit").is_none());
    assert!(summary.get("code_tree").is_none());
    let evidence = Json::parse(&std::fs::read(dirs.0[1].join("evidence-manifest.json"))?)?;
    assert_eq!(
        evidence.str_field("code_commit")?,
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(
        evidence.str_field("code_tree")?,
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    );
    // The target state is what both saw: the new reserve, new accounts, the
    // repaid debt and the new flags.
    for reconciled in [&full, &incremental] {
        assert!(reconciled.outcome.conserved);
        assert_eq!(metric(reconciled, "indexed_accounts"), 7);
        assert_eq!(metric(reconciled, "indexed_pairs"), 9);
        assert_eq!(metric(reconciled, "actionable_accounts"), 0);
        assert_eq!(metric(reconciled, "conserved_tokens"), 6);
    }
    // The refresh indexed only the delta.
    assert!(incremental.index.logs < full.index.logs);
    // The base itself differs (another anchor, another state).
    assert!(census_parity(&dirs.0[0], &dirs.0[2]).is_err());
    Ok(())
}

#[test]
fn a_refresh_to_the_base_anchor_is_the_identity_and_reruns_are_idempotent() -> TestResult {
    let run = prepare(&scenario(), &Options::default(), "identity")?;
    let dirs = Dirs::new(&run, &["base", "same", "again"]);
    let base = base(&run, &dirs.0[0])?;
    let same = plan(&run.sim, A0, 2)?;
    run.refresh(&same, &base, &dirs.0[1])?;
    run.refresh(&same, &base, &dirs.0[2])?;
    // The base was a full census, so parity holds against it too.
    census_parity(&dirs.0[0], &dirs.0[1])?;
    for name in [
        "account-manifest.jsonl",
        "acquisition-provenance.json",
        "evidence-manifest.json",
    ] {
        assert_eq!(
            std::fs::read(dirs.0[1].join(name))?,
            std::fs::read(dirs.0[2].join(name))?,
            "{name}"
        );
    }
    Ok(())
}

#[test]
fn a_reorged_base_refuses_the_refresh_while_a_full_census_succeeds() -> TestResult {
    let scenario = scenario();
    let clean = prepare(&scenario, &Options::default(), "reorg-base")?;
    let dirs = Dirs::new(&clean, &["base", "full"]);
    let base = base(&clean, &dirs.0[0])?;
    // Both providers now serve a chain reorged from below the base anchor.
    let run = prepare(
        &scenario,
        &Options {
            reorg_from: Some((BASE + 30, 7)),
            ..Options::default()
        },
        "reorg-after",
    )?;
    assert_ne!(run.sim.hash_of(A0), Some(base.anchor_hash));
    let target = plan(&run.sim, A1, 3)?;
    let error = run
        .refresh(&target, &base, &run.root.join("incremental"))
        .err()
        .ok_or("reorged base accepted")?;
    assert!(error.to_string().contains("BASE_REORGED"), "{error}");
    run.full(&target, &dirs.0[1])?;
    Ok(())
}

#[test]
fn a_stale_provider_fails_the_refresh_and_is_never_read_as_empty() -> TestResult {
    let scenario = scenario();
    let clean = prepare(&scenario, &Options::default(), "stale-base")?;
    let dirs = Dirs::new(&clean, &["base"]);
    let base = base(&clean, &dirs.0[0])?;
    let stale = prepare(
        &scenario,
        &Options {
            b_length: Some(LENGTH - 10),
            ..Options::default()
        },
        "stale",
    )?;
    let target = plan(&stale.sim, A1, 3)?;
    assert!(stale.refresh_records(&target, &base).is_err());
    Ok(())
}

#[test]
fn delta_disagreement_duplicates_and_missing_ranges_fail_closed() -> TestResult {
    let scenario = scenario();
    let clean = prepare(&scenario, &Options::default(), "delta-base")?;
    let dirs = Dirs::new(&clean, &["base"]);
    let base = base(&clean, &dirs.0[0])?;

    // Provider B omits one delta log.
    let mut omit = Options::default();
    omit.faults_b.omit_logs.insert((BASE + 50, 3));
    let run = prepare(&scenario, &omit, "delta-omit")?;
    let target = plan(&run.sim, A1, 3)?;
    let error = run
        .refresh_records(&target, &base)
        .err()
        .ok_or("omission accepted")?;
    assert!(error.to_string().contains("disagree"), "{error}");

    // Provider A returns one delta log twice.
    let duplicate = Options {
        extra_a: vec![mint(BASE + 45, 0, reserve(0)[1], user(6))],
        ..Options::default()
    };
    let run = prepare(&scenario, &duplicate, "delta-duplicate")?;
    let target = plan(&run.sim, A1, 3)?;
    assert!(run.refresh_records(&target, &base).is_err());

    // A delta partition is missing from the records.
    let run = prepare(&scenario, &Options::default(), "delta-missing")?;
    let target = plan(&run.sim, A1, 3)?;
    let (mut records, candidates) = run.refresh_records(&target, &base)?;
    let position = records
        .iter()
        .position(|record| record.str_field("stage").ok() == Some("ACCOUNT_INDEX"))
        .ok_or("no index record")?;
    records.remove(position);
    assert!(run
        .reconcile_refresh(&target, &base, &candidates, &records)
        .is_err());
    Ok(())
}

#[test]
fn an_incomplete_or_tampered_base_is_refused() -> TestResult {
    let run = prepare(&scenario(), &Options::default(), "bad-base")?;
    let dirs = Dirs::new(&run, &["base"]);
    let base = base(&run, &dirs.0[0])?;
    let target = plan(&run.sim, A1, 3)?;

    // A token initialized before the base anchor that the base never indexed.
    let mut incomplete = base.clone();
    incomplete.tokens.remove(&reserve(1)[1]);
    assert!(delta_plan(&target, &incomplete).is_err());
    // A base token dropped from the target plan.
    let shorter = plan(&run.sim, A1, 1)?;
    assert!(delta_plan(&shorter, &base).is_err());

    // Candidates that are not the certified ones.
    let (records, candidates) = run.refresh_records(&target, &base)?;
    // u3 holds aTokens at A1 but receives nothing in the delta: a base that
    // forgot u3 is refused against the certified candidates, and a refresh
    // run consistently from it leaves a conservation deficit.
    let mut forged = base.clone();
    forged
        .candidates
        .accounts
        .retain(|(account, _)| *account != user(3));
    assert!(run
        .reconcile_refresh(&target, &forged, &candidates, &records)
        .is_err());
    let (forged_records, forged_candidates) = run.refresh_records(&target, &forged)?;
    let (reconciled, _) =
        run.reconcile_refresh(&target, &forged, &forged_candidates, &forged_records)?;
    assert!(!reconciled.outcome.conserved);
    assert_eq!(metric(&reconciled, "missing_holder_tokens"), 1);

    // A tampered base closeout no longer reads.
    let path = dirs.0[0].join("candidate-accounts.jsonl");
    let mut bytes = std::fs::read(&path)?;
    bytes.truncate(bytes.len() / 2);
    std::fs::write(&path, bytes)?;
    assert!(read_base(&dirs.0[0]).is_err());
    Ok(())
}

#[test]
fn an_interrupted_delta_resumes_and_rate_limits_are_retried() -> TestResult {
    let scenario = scenario();
    let clean = prepare(&scenario, &Options::default(), "resume-clean")?;
    let dirs = Dirs::new(&clean, &["base"]);
    let base = base(&clean, &dirs.0[0])?;
    let target = plan(&clean.sim, A1, 3)?;
    let delta = delta_plan(&target, &base)?;
    let spec = &clean.index_specs[0];
    let expected = account_index_stage(&clean.acquisition(&clean.network), spec, &delta, 0, 1)?.0;

    let crashed = prepare(&scenario, &Options::default(), "resume-crash")?;
    let interrupted = InterruptAfter::new(&crashed.network, 3);
    assert!(account_index_stage(&crashed.acquisition(&interrupted), spec, &delta, 0, 1).is_err());
    let resumed =
        account_index_stage(&crashed.acquisition(&crashed.network), spec, &delta, 0, 1)?.0;
    assert!(resumed.same_as(&expected)?);

    let mut limited = Options {
        retry_delays: Some(4),
        ..Options::default()
    };
    limited.faults_a.rate_limit_first = 3;
    let run = prepare(&scenario, &limited, "rate")?;
    let (records, candidates) = run.refresh_records(&target, &base)?;
    assert_eq!(candidates.accounts.len(), 7);
    assert!(
        run.reconcile_refresh(&target, &base, &candidates, &records)?
            .0
            .outcome
            .conserved
    );
    Ok(())
}
