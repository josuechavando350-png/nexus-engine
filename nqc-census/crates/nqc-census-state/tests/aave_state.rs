//! RMC-008 Aave V3 state pipeline on a synthetic chain: selector-gated
//! acquisition on two providers, replay from the store, agreement and exact
//! verification. A scripted transport adds storage reads, dataless reverts
//! and EVM halts on top of the testkit. Testkit chains are synthetic, never
//! evidence.

use nqc_census_chain::abi;
use nqc_census_chain::acquire::Acquisition;
use nqc_census_chain::json::Json;
use nqc_census_chain::provider::ProviderSpec;
use nqc_census_chain::testkit::{Faults, SimChain, SimNetwork, SimProvider, SIM_PRAGUE_TIME};
use nqc_census_chain::transport::{HttpReply, RetryPolicy, Transport};
use nqc_census_chain::ChainError;
use nqc_census_core::{
    Address, CallOutcome, CanonicalMarketKey, CensusStage, DeploymentKey, Hash32, ProtocolFamily,
    RejectionReason,
};
use nqc_census_state::aave_math::{normalized_income, ray_mul_ceil, ray_mul_floor};
use nqc_census_state::aave_stage::{
    aave_state_stage, AavePlan, AaveReserveInput, EIP1967_IMPLEMENTATION_SLOT, EMODE_GETTERS,
    POOL_SCALARS, RESERVE_GETTERS,
};
use nqc_census_state::aave_verify::{verify_aave, AaveInputs, AaveOutcome, AdmittedReserve};
use nqc_census_state::extract::{extract_stages, stage_extract};
use nqc_census_state::replay::{replay_stage, StagePlans};
use nqc_census_state::stage::AnchorPlan;
use nqc_census_state::uint::U256;
use nqc_census_store::{Store, StoreConfig};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::sync::{Arc, Mutex};

type TestResult = Result<(), Box<dyn Error>>;

const BASE: u64 = 20_000_000;
const LENGTH: u64 = 30;
const A: u16 = 0x0a18;
const B: u16 = 0x0b18;

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!("nonzero"))
}

fn pool() -> Address {
    address(0x87)
}
fn implementation() -> Address {
    address(0x72)
}
fn oracle() -> Address {
    address(0x54)
}
fn provider_root() -> Address {
    address(0x2f)
}
/// Reserve `k`: underlying, aToken, stable, variable debt, strategy, source.
fn reserve(k: u8) -> [Address; 6] {
    let base = 0x10 * (k + 1);
    [
        address(base),
        address(base + 1),
        address(base + 2),
        address(base + 3),
        address(base + 4),
        address(base + 5),
    ]
}
fn historical() -> Address {
    address(0xe1)
}

fn word_u(value: U256) -> [u8; 32] {
    value.to_word()
}
fn word(value: u64) -> [u8; 32] {
    abi::uint_word(value)
}
fn word_a(address: Address) -> [u8; 32] {
    abi::address_word(address.as_bytes())
}
fn dec(text: &str) -> U256 {
    U256::parse_decimal(text).unwrap_or_else(|_| unreachable!("fixture decimal"))
}
fn call(signature: &str, words: &[[u8; 32]]) -> Vec<u8> {
    abi::encode_call(abi::selector(signature), words)
}
fn returned(words: &[[u8; 32]]) -> CallOutcome {
    CallOutcome::Returned(words.concat())
}

/// Runtime whose PUSH4 immediates announce `signatures` (dispatcher evidence).
fn dispatcher(signatures: &[&str]) -> Vec<u8> {
    let mut code = vec![0x60, 0x80, 0x60, 0x40, 0x52];
    for signature in signatures {
        code.push(0x63);
        code.extend_from_slice(&abi::selector(signature));
        code.push(0x14);
    }
    code.push(0x00);
    code
}

fn anchor_time() -> u64 {
    SIM_PRAGUE_TIME + 12 * (LENGTH - 1)
}

fn configuration(decimals: u64) -> U256 {
    // LTV 7500, LT 8000, bonus 10500, decimals, active, borrowing enabled,
    // flash loans, reserve factor 1000, virtual accounting.
    let mut bytes = [0u8; 32];
    let mut set = |offset: u32, value: u64, width: u32| {
        for bit in 0..width {
            if (value >> bit) & 1 == 1 {
                let position = offset + bit;
                bytes[31 - (position / 8) as usize] |= 1 << (position % 8);
            }
        }
    };
    set(0, 7_500, 16);
    set(16, 8_000, 16);
    set(32, 10_500, 16);
    set(48, decimals, 8);
    set(56, 1, 1);
    set(58, 1, 1);
    set(63, 1, 1);
    set(64, 1_000, 16);
    set(252, 1, 1);
    U256::from_word(&bytes)
}

#[derive(Clone, Default)]
struct Variant {
    /// aToken totalSupply of reserve 0 is one above the floor rule.
    atoken_supply_off: bool,
    /// Reserve 1 oracle price differs from its source's answer.
    price_off: bool,
    /// Reserve 0 underlying balance of the aToken is below virtual balance.
    balance_below_virtual: bool,
    /// Reserve 1 names reserve 0's stable debt token and interest rate
    /// strategy: probe run 36686929285 read one stable debt token and one
    /// strategy shared by all 67 mainnet reserves at the anchor.
    shared_contracts: bool,
    /// Providers batch 100 calls, as both declared state providers do, so
    /// both reserves' token reads share one JSON-RPC batch.
    live_batch: bool,
    /// Provider A reports halts in geth's words and provider B in revm's, as
    /// blastapi-public did in live run 36682467619 (`-32003 "EVM error:
    /// InvalidJump"`).
    revm_halts_on_b: bool,
}

fn chain(variant: &Variant) -> Result<SimChain, Box<dyn Error>> {
    let mut sim = SimChain::new(1, BASE, LENGTH)?;
    let from = BASE + 1;
    let set = |sim: &mut SimChain, target: Address, data: Vec<u8>, outcome: CallOutcome| {
        sim.set_call(target, data, from, None, outcome);
    };
    let mut getters: Vec<&str> = POOL_SCALARS.to_vec();
    getters.extend(RESERVE_GETTERS);
    getters.extend(EMODE_GETTERS);
    getters.push("getReservesList()");
    sim.set_code(pool(), from, None, vec![0x60, 0x80, 0x36]);
    sim.set_code(implementation(), from, None, dispatcher(&getters));
    sim.set_code(
        oracle(),
        from,
        None,
        dispatcher(&[
            "BASE_CURRENCY()",
            "BASE_CURRENCY_UNIT()",
            "getFallbackOracle()",
        ]),
    );
    set(
        &mut sim,
        pool(),
        call("FLASHLOAN_PREMIUM_TOTAL()", &[]),
        returned(&[word(5)]),
    );
    set(
        &mut sim,
        pool(),
        call("FLASHLOAN_PREMIUM_TO_PROTOCOL()", &[]),
        returned(&[word(10_000)]),
    );
    set(
        &mut sim,
        pool(),
        call("MAX_NUMBER_RESERVES()", &[]),
        returned(&[word(128)]),
    );
    set(
        &mut sim,
        pool(),
        call("POOL_REVISION()", &[]),
        returned(&[word(11)]),
    );
    set(
        &mut sim,
        pool(),
        call("getReservesCount()", &[]),
        returned(&[word(2)]),
    );
    set(
        &mut sim,
        pool(),
        call("BRIDGE_PROTOCOL_FEE()", &[]),
        returned(&[word(0)]),
    );
    let list = [
        word(32),
        word(2),
        word_a(reserve(0)[0]),
        word_a(reserve(1)[0]),
    ];
    set(
        &mut sim,
        pool(),
        call("getReservesList()", &[]),
        returned(&list),
    );
    set(
        &mut sim,
        oracle(),
        call("BASE_CURRENCY()", &[]),
        returned(&[[0; 32]]),
    );
    set(
        &mut sim,
        oracle(),
        call("BASE_CURRENCY_UNIT()", &[]),
        returned(&[word(100_000_000)]),
    );
    set(
        &mut sim,
        oracle(),
        call("getFallbackOracle()", &[]),
        returned(&[[0; 32]]),
    );
    for k in 0..2u8 {
        let [asset, a_token, mut stable, variable, mut strategy, source] = reserve(k);
        if variant.shared_contracts && k == 1 {
            stable = reserve(0)[2];
            strategy = reserve(0)[4];
        }
        let decimals = if k == 0 { 18 } else { 6 };
        let config = configuration(decimals);
        let liquidity_index = dec("1067536594946887619941860510");
        let liquidity_rate = dec("14350199782030829271363414");
        let variable_index = dec("1101986934639584622612000085");
        let last = anchor_time() - 12;
        let income = normalized_income(liquidity_index, liquidity_rate, last, anchor_time())?;
        let debt = dec("1101986943462721326859367870");
        let data = [
            word_u(config),
            word_u(liquidity_index),
            word_u(liquidity_rate),
            word_u(variable_index),
            word_u(dec("21041268673045279329909217")),
            word(0),
            word(last),
            word(u64::from(k)),
            word_a(a_token),
            word_a(stable),
            word_a(variable),
            word_a(strategy),
            word(7),
            word(0),
            word(0),
        ];
        let asset_word = [word_a(asset)];
        set(
            &mut sim,
            pool(),
            call("getReserveData(address)", &asset_word),
            returned(&data),
        );
        set(
            &mut sim,
            pool(),
            call("getConfiguration(address)", &asset_word),
            returned(&[word_u(config)]),
        );
        set(
            &mut sim,
            pool(),
            call("getReserveNormalizedIncome(address)", &asset_word),
            returned(&[word_u(income)]),
        );
        set(
            &mut sim,
            pool(),
            call("getReserveNormalizedVariableDebt(address)", &asset_word),
            returned(&[word_u(debt)]),
        );
        let virtual_balance = 900_000u64;
        set(
            &mut sim,
            pool(),
            call("getVirtualUnderlyingBalance(address)", &asset_word),
            returned(&[word(virtual_balance)]),
        );
        set(
            &mut sim,
            pool(),
            call("getLiquidationGracePeriod(address)", &asset_word),
            returned(&[word(0)]),
        );
        set(
            &mut sim,
            pool(),
            call("getReserveDeficit(address)", &asset_word),
            returned(&[word(0)]),
        );
        set(
            &mut sim,
            pool(),
            call("getReserveAToken(address)", &asset_word),
            returned(&[word_a(a_token)]),
        );
        set(
            &mut sim,
            pool(),
            call("getReserveVariableDebtToken(address)", &asset_word),
            returned(&[word_a(variable)]),
        );
        let a_scaled = dec("1000000000000");
        let v_scaled = dec("400000000000");
        let mut a_total = ray_mul_floor(a_scaled, income)?;
        if variant.atoken_supply_off && k == 0 {
            a_total = a_total.checked_add(U256::ONE)?;
        }
        let v_total = ray_mul_ceil(v_scaled, debt)?;
        for (token, signature, value) in [
            (a_token, "UNDERLYING_ASSET_ADDRESS()", word_a(asset)),
            (a_token, "POOL()", word_a(pool())),
            (a_token, "RESERVE_TREASURY_ADDRESS()", word_a(address(0x7e))),
            (a_token, "scaledTotalSupply()", word_u(a_scaled)),
            (a_token, "totalSupply()", word_u(a_total)),
            (a_token, "decimals()", word(decimals)),
            (variable, "UNDERLYING_ASSET_ADDRESS()", word_a(asset)),
            (variable, "POOL()", word_a(pool())),
            (variable, "scaledTotalSupply()", word_u(v_scaled)),
            (variable, "totalSupply()", word_u(v_total)),
            (variable, "decimals()", word(decimals)),
            (stable, "totalSupply()", word(0)),
            (asset, "decimals()", word(decimals)),
            (asset, "totalSupply()", word(10_000_000)),
        ] {
            set(&mut sim, token, call(signature, &[]), returned(&[value]));
        }
        let balance = if variant.balance_below_virtual && k == 0 {
            virtual_balance - 1
        } else {
            virtual_balance + 5
        };
        set(
            &mut sim,
            asset,
            call("balanceOf(address)", &[word_a(a_token)]),
            returned(&[word(balance)]),
        );
        for account in [asset, a_token, stable, variable, strategy] {
            sim.set_code(account, from, None, vec![0x60, k]);
        }
        // Source 0 is a Chainlink-style proxy; source 1 exposes latestAnswer only.
        let source_getters: &[&str] = if k == 0 {
            &["latestAnswer()", "latestRoundData()", "decimals()"]
        } else {
            &["latestAnswer()", "decimals()"]
        };
        sim.set_code(source, from, None, dispatcher(source_getters));
        let answer = 250_000_000_000u64 + u64::from(k);
        set(
            &mut sim,
            source,
            call("latestAnswer()", &[]),
            returned(&[word(answer)]),
        );
        set(
            &mut sim,
            source,
            call("decimals()", &[]),
            returned(&[word(8)]),
        );
        set(
            &mut sim,
            source,
            call("latestRoundData()", &[]),
            returned(&[
                word(9),
                word(answer),
                word(anchor_time() - 600),
                word(anchor_time() - 600),
                word(9),
            ]),
        );
        set(
            &mut sim,
            oracle(),
            call("getSourceOfAsset(address)", &asset_word),
            returned(&[word_a(source)]),
        );
        let price = if variant.price_off && k == 1 {
            answer + 1
        } else {
            answer
        };
        set(
            &mut sim,
            oracle(),
            call("getAssetPrice(address)", &asset_word),
            returned(&[word(price)]),
        );
    }
    // eMode category 1: collateral reserve 0, borrowable reserve 1.
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryCollateralConfig(uint8)", &[word(1)]),
        returned(&[word(9_300), word(9_500), word(10_100)]),
    );
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryCollateralBitmap(uint8)", &[word(1)]),
        returned(&[word(1)]),
    );
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryBorrowableBitmap(uint8)", &[word(1)]),
        returned(&[word(2)]),
    );
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryLtvzeroBitmap(uint8)", &[word(1)]),
        returned(&[word(0)]),
    );
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryLabel(uint8)", &[word(1)]),
        returned(&[word(32), word(0)]),
    );
    set(
        &mut sim,
        pool(),
        call("getEModeCategoryData(uint8)", &[word(1)]),
        returned(&[
            word(32),
            word(9_300),
            word(9_500),
            word(10_100),
            [0; 32],
            word(160),
            word(0),
            word(0),
        ]),
    );
    // Unconfigured categories answer zeros, as the deployed pool does.
    for id in 2..=255u64 {
        let id_word = [word(id)];
        for signature in [
            "getEModeCategoryCollateralBitmap(uint8)",
            "getEModeCategoryBorrowableBitmap(uint8)",
            "getEModeCategoryLtvzeroBitmap(uint8)",
        ] {
            set(
                &mut sim,
                pool(),
                call(signature, &id_word),
                returned(&[word(0)]),
            );
        }
        set(
            &mut sim,
            pool(),
            call("getEModeCategoryCollateralConfig(uint8)", &id_word),
            returned(&[word(0), word(0), word(0)]),
        );
        set(
            &mut sim,
            pool(),
            call("getEModeCategoryLabel(uint8)", &id_word),
            returned(&[word(32), word(0)]),
        );
        set(
            &mut sim,
            pool(),
            call("getEModeCategoryData(uint8)", &id_word),
            returned(&[
                word(32),
                word(0),
                word(0),
                word(0),
                [0; 32],
                word(160),
                word(0),
                word(0),
            ]),
        );
    }
    Ok(sim)
}

/// Adds storage reads, dataless reverts and EVM halts to a testkit network.
struct Scripted {
    inner: SimNetwork,
    storage: BTreeMap<(String, String), [u8; 32]>,
    strip_revert_data: BTreeSet<u16>,
    halts: BTreeSet<(u16, Address, [u8; 4])>,
    /// Provider namespace -> (code, message) of its halt replies.
    halt_replies: BTreeMap<u16, (i64, &'static str)>,
}

impl Scripted {
    fn answer(&self, provider: &ProviderSpec, item: &Json) -> Result<Json, ChainError> {
        let id = item.get("id").cloned().unwrap_or(Json::Null);
        let method = item.str_field("method")?;
        let params = item
            .get("params")
            .and_then(Json::as_array)
            .unwrap_or_default();
        if method == "eth_getStorageAt" {
            let account = params
                .first()
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_owned();
            let slot = params
                .get(1)
                .and_then(Json::as_str)
                .unwrap_or("")
                .to_owned();
            let value = self
                .storage
                .get(&(account, slot))
                .copied()
                .unwrap_or([0; 32]);
            return Ok(Json::object([
                ("jsonrpc", Json::string("2.0")),
                ("id", id),
                (
                    "result",
                    Json::string(nqc_census_chain::hex::encode(&value)),
                ),
            ]));
        }
        if method == "eth_call" {
            let object = params.first().ok_or(ChainError::Rpc("call object"))?;
            let target = Address::parse_hex(object.str_field("to")?)?;
            let data = nqc_census_chain::hex::decode_data(object.str_field("data")?)?;
            let mut selector = [0u8; 4];
            selector.copy_from_slice(&data[..4]);
            if self
                .halts
                .contains(&(provider.namespace(), target, selector))
            {
                let (code, message) = self
                    .halt_replies
                    .get(&provider.namespace())
                    .copied()
                    .unwrap_or((-32000, "invalid opcode: INVALID"));
                return Ok(Json::object([
                    ("jsonrpc", Json::string("2.0")),
                    ("id", id),
                    (
                        "error",
                        Json::object([
                            ("code", Json::int(code)),
                            ("message", Json::string(message)),
                        ]),
                    ),
                ]));
            }
        }
        let reply = self.inner.post(provider, &item.canonical()?)?;
        let mut value = Json::parse(&reply.body)?;
        if self.strip_revert_data.contains(&provider.namespace()) {
            if let Json::Object(members) = &mut value {
                for (key, member) in members.iter_mut() {
                    if key == "error" {
                        if let Json::Object(fields) = member {
                            fields.retain(|(name, _)| name != "data");
                        }
                    }
                }
            }
        }
        Ok(value)
    }
}

impl Transport for Scripted {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let request = Json::parse(body)?;
        let response = match &request {
            Json::Array(items) => Json::Array(
                items
                    .iter()
                    .map(|item| self.answer(provider, item))
                    .collect::<Result<_, _>>()?,
            ),
            single => self.answer(provider, single)?,
        };
        Ok(HttpReply {
            status: 200,
            body: response.canonical()?,
        })
    }
}

struct Run {
    store: Store,
    specs: Vec<ProviderSpec>,
    plan: AavePlan,
    records: Vec<Json>,
    deployment: DeploymentKey,
    reserves: Vec<AdmittedReserve>,
    root: std::path::PathBuf,
}

impl Drop for Run {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn run(
    variant: &Variant,
    strip: &[u16],
    halts: &[(u16, Address, &str)],
) -> Result<Run, Box<dyn Error>> {
    let sim = chain(variant)?;
    let mut inner = SimNetwork::new();
    inner.add(
        A,
        SimProvider::new(Arc::new(Mutex::new(sim.clone())), Faults::default(), 100),
    );
    inner.add(
        B,
        SimProvider::new(Arc::new(Mutex::new(sim.clone())), Faults::default(), 100),
    );
    let mut storage = BTreeMap::new();
    let upgradeable = reserve(1)[0];
    let mut implementation_word = [0u8; 32];
    implementation_word[12..].copy_from_slice(address(0x99).as_bytes());
    storage.insert(
        (upgradeable.to_hex(), EIP1967_IMPLEMENTATION_SLOT.to_owned()),
        implementation_word,
    );
    let network = Scripted {
        inner,
        storage,
        strip_revert_data: strip.iter().copied().collect(),
        halts: halts
            .iter()
            .map(|(namespace, target, signature)| (*namespace, *target, abi::selector(signature)))
            .collect(),
        halt_replies: if variant.revm_halts_on_b {
            BTreeMap::from([
                (A, (-32000, "invalid jump destination")),
                (B, (-32003, "EVM error: InvalidJump")),
            ])
        } else {
            BTreeMap::new()
        },
    };
    let (batch_a, batch_b) = if variant.live_batch {
        (100, 100)
    } else {
        (9, 4)
    };
    let specs = vec![
        SimProvider::spec(A, "aave-a", 100, batch_a)?,
        SimProvider::spec(B, "aave-b", 100, batch_b)?,
    ];
    let plan = AavePlan {
        anchor: AnchorPlan {
            profile: sim.profile()?,
            number: BASE + LENGTH - 1,
            hash: sim.hash_of(BASE + LENGTH - 1).ok_or("anchor")?,
        },
        pool: pool(),
        pool_implementation: implementation(),
        addresses_provider: provider_root(),
        oracle: oracle(),
        reserves: (0..2u8)
            .map(|k| AaveReserveInput {
                asset: reserve(k)[0],
                reserve_id: u16::from(k),
            })
            .collect(),
    };
    let root = std::env::temp_dir().join(format!(
        "nqc-rmc008-aave-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos()
    ));
    let store = Store::create(&root, StoreConfig::standard())?;
    let acquisition = Acquisition::new(&store, &network, RetryPolicy::none());
    let (facts, _) = acquisition.bootstrap(&specs[0], &plan.anchor.profile)?;
    let deployment = DeploymentKey::new(
        facts.chain,
        ProtocolFamily::AaveV3,
        pool(),
        Hash32::new([4; 32])?,
    );
    let mut reserves = Vec::new();
    for (asset, reserve_id) in [
        (reserve(0)[0], Some(0)),
        (reserve(1)[0], Some(1)),
        (historical(), None),
    ] {
        reserves.push(AdmittedReserve {
            asset,
            market_id: CanonicalMarketKey::aave_reserve(deployment.clone(), asset)?
                .id()?
                .to_hex(),
            reserve_id,
        });
    }
    let mut records = Vec::new();
    for spec in &specs {
        records.push(aave_state_stage(&acquisition, spec, &plan)?.0);
    }
    Ok(Run {
        store,
        specs,
        plan,
        records,
        deployment,
        reserves,
        root,
    })
}

fn verify(run: &Run) -> Result<AaveOutcome, Box<dyn Error>> {
    let plans = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&run.plan),
    };
    let stages = run
        .records
        .iter()
        .map(|record| replay_stage(&run.store, &run.specs, &plans, record))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(verify_aave(&AaveInputs {
        deployment: run.deployment.clone(),
        pool: pool(),
        reserves: &run.reserves,
        anchor_timestamp: anchor_time(),
        stages,
    })?)
}

fn rejection(
    run: &Run,
    outcome: &AaveOutcome,
    asset: Address,
    stage: CensusStage,
) -> Option<String> {
    let unit = nqc_census_core::CensusUnitId::from_market(
        CanonicalMarketKey::aave_reserve(run.deployment.clone(), asset)
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
fn exact_state_reconciles_and_stages_are_decided() -> TestResult {
    let run = run(&Variant::default(), &[], &[])?;
    let outcome = verify(&run)?;
    assert_eq!(
        outcome.mismatches.unexplained(),
        0,
        "{:?}",
        outcome.mismatches.sorted()
    );
    let metrics = outcome
        .ledger
        .metrics(&outcome.domain, CensusStage::MarketsStateReconstructable);
    assert_eq!(
        (
            metrics.input_count,
            metrics.advanced_count,
            metrics.rejected_count
        ),
        (3, 2, 1)
    );
    assert_eq!(
        rejection(
            &run,
            &outcome,
            historical(),
            CensusStage::MarketsStateReconstructable
        )
        .as_deref(),
        Some(RejectionReason::NoActiveState.code())
    );
    // Economic classification is not D08's: liquidity and borrowability are
    // recorded facts and no later-stage record exists.
    for stage in [
        CensusStage::MarketsEconomicallyActive,
        CensusStage::MarketsBorrowable,
    ] {
        assert_eq!(
            outcome.ledger.metrics(&outcome.domain, stage).input_count,
            0
        );
    }
    let facts = outcome.state_rows[0]
        .get("protocol_facts")
        .ok_or("protocol facts")?;
    assert_eq!(facts.get("borrowing_enabled"), Some(&Json::Bool(true)));
    assert_eq!(facts.str_field("available_liquidity")?, "900000");
    assert_eq!(facts.get("borrow_cap_reached"), Some(&Json::Bool(false)));
    assert_eq!(outcome.oracle_rows.len(), 2);
    assert_eq!(
        outcome.oracle_rows[0]
            .get("age_seconds_at_anchor")
            .and_then(Json::as_i64),
        Some(600)
    );
    assert_eq!(
        outcome.oracle_rows[1].str_field("freshness")?,
        "UPDATE_TIME_NOT_EXPOSED_BY_SOURCE_NOT_ENFORCED_BY_PROTOCOL"
    );
    assert_eq!(outcome.emode_rows.len(), 1);
    assert_eq!(outcome.emode_rows[0].str_field("collateral_bitmap")?, "1");
    let upgradeable = outcome
        .tokens
        .iter()
        .find(|token| token.token == reserve(1)[0])
        .ok_or("token")?;
    assert_eq!(
        upgradeable.behavior.upgradeable,
        nqc_census_state::model::Tri::Present
    );
    assert!(outcome
        .tokens
        .iter()
        .all(|token| !token.execution_blockers().is_empty()));
    Ok(())
}

#[test]
fn integer_mismatches_block_the_reserve() -> TestResult {
    let variant = Variant {
        atoken_supply_off: true,
        price_off: true,
        ..Variant::default()
    };
    let run = run(&variant, &[], &[])?;
    let outcome = verify(&run)?;
    let dimensions: Vec<String> = outcome
        .mismatches
        .sorted()
        .into_iter()
        .map(|entry| entry.dimension)
        .collect();
    assert_eq!(
        dimensions,
        vec!["ATOKEN_TOTAL_SUPPLY_RAYMUL_FLOOR", "ORACLE_PRICE_PATH"]
    );
    for k in 0..2 {
        assert_eq!(
            rejection(
                &run,
                &outcome,
                reserve(k)[0],
                CensusStage::MarketsStateReconstructable
            )
            .as_deref(),
            Some(RejectionReason::StateUnreconstructable.code())
        );
    }
    Ok(())
}

#[test]
fn holder_balance_below_protocol_accounting_is_token_behavior() -> TestResult {
    let variant = Variant {
        balance_below_virtual: true,
        ..Variant::default()
    };
    let run = run(&variant, &[], &[])?;
    let outcome = verify(&run)?;
    assert_eq!(outcome.mismatches.unexplained(), 0);
    assert_eq!(
        rejection(
            &run,
            &outcome,
            reserve(0)[0],
            CensusStage::MarketsStateReconstructable
        )
        .as_deref(),
        Some(RejectionReason::UnsupportedTokenBehavior.code())
    );
    Ok(())
}

#[test]
fn dataless_reverts_and_halts_are_isolated_and_replayable() -> TestResult {
    // Provider B omits revert data (as observed live) and source 0 halts on
    // latestRoundData on both providers: the halted call is isolated by
    // bisection, recorded as an exchange, and replays identically.
    let source = reserve(0)[5];
    let run = run(
        &Variant::default(),
        &[B],
        &[
            (A, source, "latestRoundData()"),
            (B, source, "latestRoundData()"),
        ],
    )?;
    let first = verify(&run)?;
    let second = verify(&run)?;
    assert_eq!(first.oracle_rows, second.oracle_rows);
    assert_eq!(first.mismatches.unexplained(), 0);
    assert_eq!(
        first.oracle_rows[0].str_field("freshness")?,
        "UPDATE_TIME_NOT_EXPOSED_BY_SOURCE_NOT_ENFORCED_BY_PROTOCOL"
    );
    Ok(())
}

#[test]
fn a_halt_seen_by_one_provider_only_fails_closed() -> TestResult {
    let source = reserve(1)[5];
    let run = run(&Variant::default(), &[], &[(A, source, "decimals()")])?;
    let error = verify(&run).err().ok_or("disagreement must fail")?;
    assert!(error.to_string().contains("different"), "{error}");
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

#[test]
fn aave_extracts_bind_to_the_admitted_reserves_and_addresses() -> TestResult {
    let run = run(&Variant::default(), &[], &[])?;
    let plans = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&run.plan),
    };
    let summary = store_summary(&run.root)?;
    let extracts = run
        .records
        .iter()
        .map(|record| stage_extract(&run.store, &run.specs, &plans, record, summary.clone()))
        .collect::<Result<Vec<_>, _>>()?;
    let stages = extract_stages(&run.specs, &plans, &run.plan.anchor, extracts.clone())?;
    assert_eq!(stages.len(), 2);
    // Reserves other than the admitted ones, or another oracle.
    let mut fewer = run.plan.clone();
    fewer.reserves.pop();
    let wrong = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&fewer),
    };
    assert!(
        extract_stages(&run.specs, &wrong, &run.plan.anchor, extracts.clone())
            .err()
            .ok_or("foreign reserves accepted")?
            .to_string()
            .contains("another plan")
    );
    let mut moved = run.plan.clone();
    moved.oracle = pool();
    let wrong = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&moved),
    };
    assert!(extract_stages(&run.specs, &wrong, &run.plan.anchor, extracts).is_err());
    Ok(())
}

/// Mainnet reserves share contracts. The frozen chain layer refuses a batch
/// holding one call twice (live run 36682467619 failed every AAVE_STATE
/// attempt on both providers with `duplicate call in batch`); each distinct
/// call is made once and its outcome kept for every reserve that names it.
#[test]
fn reserves_sharing_contracts_are_read_once_and_reconcile_exactly() -> TestResult {
    let variant = Variant {
        shared_contracts: true,
        live_batch: true,
        ..Variant::default()
    };
    let run = run(&variant, &[], &[])?;
    let outcome = verify(&run)?;
    assert_eq!(
        outcome.mismatches.unexplained(),
        0,
        "{:?}",
        outcome.mismatches.sorted()
    );
    let plans = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&run.plan),
    };
    for record in &run.records {
        let stage = replay_stage(&run.store, &run.specs, &plans, record)?;
        let reserves: Vec<&Json> = stage
            .rows
            .iter()
            .filter(|row| row.get("kind").and_then(Json::as_str) == Some("RESERVE"))
            .collect();
        assert_eq!(reserves.len(), 2);
        for row in &reserves {
            assert_eq!(
                row.str_field("stable_debt_token")?,
                reserve(0)[2].to_hex(),
                "shared stable debt token"
            );
            assert_eq!(
                row.str_field("interest_rate_strategy")?,
                reserve(0)[4].to_hex(),
                "shared strategy"
            );
            assert_eq!(
                row.get("stable_debt_total_supply"),
                Some(&Json::string("0"))
            );
        }
    }
    Ok(())
}

/// The same deterministic halt in two providers' vocabularies: geth says
/// "invalid jump destination", revm-based blastapi-public says `-32003 "EVM
/// error: InvalidJump"` (live run 36682467619, stage v2-state-8, every
/// attempt). Both are one `HALTED` fact, never an unknown provider failure.
#[test]
fn a_halt_in_revm_words_is_the_same_halt() -> TestResult {
    let source = reserve(0)[5];
    let variant = Variant {
        revm_halts_on_b: true,
        ..Variant::default()
    };
    let run = run(
        &variant,
        &[],
        &[
            (A, source, "latestRoundData()"),
            (B, source, "latestRoundData()"),
        ],
    )?;
    let outcome = verify(&run)?;
    assert_eq!(outcome.mismatches.unexplained(), 0);
    let plans = StagePlans {
        v2: None,
        pairs: &[],
        aave: Some(&run.plan),
    };
    for record in &run.records {
        let stage = replay_stage(&run.store, &run.specs, &plans, record)?;
        let oracle = stage
            .rows
            .iter()
            .find(|row| row.get("kind").and_then(Json::as_str) == Some("ORACLE"))
            .ok_or("oracle row")?;
        let halted = oracle
            .get("sources")
            .and_then(Json::as_array)
            .ok_or("sources")?
            .iter()
            .find(|row| row.str_field("source").ok() == Some(source.to_hex().as_str()))
            .and_then(|row| row.get("getters"))
            .and_then(|getters| getters.get("latestRoundData()"))
            .ok_or("halted getter")?;
        assert_eq!(halted.str_field("status")?, "HALTED");
    }
    Ok(())
}
