use nqc_census_aave_discovery::{
    aave_interface, decode_reserve_dropped, decode_reserve_initialized, reconcile, CurrentReserve,
    DeltaKind, ReserveDropProof, ReserveInitProof,
};
use nqc_census_chain::abi;
use nqc_census_core::{
    AdapterCapability, Address, BlockWindow, CapabilityAdmission, CapabilityScope, ChainDomain,
    DeclaredUniverse, DeploymentBinding, DeploymentKey, DeploymentLifeState, DeploymentRegistry,
    DiscoveryRoot, DiscoveryRootKind, EvidenceRef, Hash32, ObservationSemantics, ProtocolFamily,
    ProxyKind, RawLogEnvelope, StateAnchor, SupportedSemanticsProfile, UniverseScope,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Result<Hash32, nqc_census_core::IdentityError> {
    Hash32::new([byte; 32])
}

fn address(byte: u8) -> Result<Address, nqc_census_core::IdentityError> {
    Address::new([byte; 20])
}

fn admission() -> Result<nqc_census_core::AdmissionRecord, Box<dyn std::error::Error>> {
    let chain = ChainDomain::new(1, hash(1)?, hash(2)?)?;
    let provider = address(0x21)?;
    let pool = address(0x31)?;
    let deployment = DeploymentKey::new(chain.clone(), ProtocolFamily::AaveV3, pool, hash(3)?);
    let root = DiscoveryRoot::new(DiscoveryRootKind::AaveAddressesProvider, provider);
    let scope = UniverseScope::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        vec![root],
        BlockWindow::new(100, 500)?,
        BlockWindow::new(100, 500)?,
    )?;
    let universe = DeclaredUniverse::new(vec![scope])?;
    let mut registry = DeploymentRegistry::new(universe);
    let capabilities = CapabilityAdmission::new(vec![
        (AdapterCapability::MarketDiscovery, true),
        (AdapterCapability::StateReconstruction, false),
        (AdapterCapability::PositionDiscovery, false),
        (AdapterCapability::OracleObservation, false),
        (AdapterCapability::TokenAdmission, false),
        (AdapterCapability::CapitalCensus, false),
        (AdapterCapability::RouteQuotation, false),
        (AdapterCapability::ExecutionSimulation, false),
        (AdapterCapability::CompetitionObservation, false),
        (AdapterCapability::EconomicClassification, false),
    ])?;
    let capability_scope = CapabilityScope::new(chain.clone(), ProtocolFamily::AaveV3, 1)?;
    registry.declare_supported_semantics(SupportedSemanticsProfile::new(
        capability_scope,
        ProxyKind::Transparent,
        hash(4)?,
        hash(5)?,
        hash(6)?,
        hash(7)?,
        capabilities.clone(),
    ))?;
    let creation = StateAnchor::new(
        chain.clone(),
        100,
        hash(10)?,
        hash(9)?,
        1_700_000_000,
        hash(11)?,
    )?;
    let observation = StateAnchor::new(chain, 500, hash(12)?, hash(13)?, 1_700_010_000, hash(14)?)?;
    let binding = DeploymentBinding::new(
        deployment,
        root,
        creation,
        observation,
        ProxyKind::Transparent,
        address(0x41)?,
        hash(5)?,
        ObservationSemantics::new(hash(4)?, hash(6)?),
        hash(7)?,
        1,
        DeploymentLifeState::Active,
        capabilities,
        vec![EvidenceRef::Artifact(hash(8)?)],
    )?;
    let id = registry.admit(binding, None)?.id();
    Ok(registry
        .record(id)
        .ok_or("admission record missing")?
        .clone())
}

fn current(id: u16, asset: u8) -> Result<CurrentReserve, nqc_census_core::IdentityError> {
    Ok(CurrentReserve {
        reserve_id: id,
        asset: address(asset)?,
        evidence: vec![EvidenceRef::Artifact(hash(asset)?)],
    })
}

fn init(block: u64, asset: u8) -> Result<ReserveInitProof, nqc_census_core::IdentityError> {
    Ok(ReserveInitProof {
        block_number: block,
        block_hash: hash(0x20 + asset)?,
        transaction_hash: hash(0x30 + asset)?,
        log_index: u32::from(asset),
        asset: address(asset)?,
        a_token: address(asset + 20)?,
        stable_debt_token: Some(address(asset + 40)?),
        variable_debt_token: address(asset + 60)?,
        interest_rate_strategy: Some(address(asset + 80)?),
        evidence: vec![EvidenceRef::Artifact(hash(0x40 + asset)?)],
    })
}

fn drop(block: u64, asset: u8) -> Result<ReserveDropProof, nqc_census_core::IdentityError> {
    Ok(ReserveDropProof {
        block_number: block,
        block_hash: hash(0x50 + asset)?,
        transaction_hash: hash(0x60 + asset)?,
        log_index: u32::from(asset) + 100,
        asset: address(asset)?,
        evidence: vec![EvidenceRef::Artifact(hash(0x70 + asset)?)],
    })
}

#[test]
fn identical_getter_and_history_certify() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![current(0, 1)?, current(1, 2)?],
        vec![init(120, 1)?, init(130, 2)?],
        vec![],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.union_count, 2);
    assert_eq!(report.summary.intersection_count, 2);
    Ok(())
}

#[test]
fn getter_only_is_unexplained() -> TestResult {
    let report = reconcile(&admission()?, vec![current(0, 1)?], vec![], vec![])?;
    assert!(!report.certifiable());
    assert_eq!(report.summary.getter_only_count, 1);
    Ok(())
}

#[test]
fn historical_without_drop_is_preserved_and_blocking() -> TestResult {
    let report = reconcile(&admission()?, vec![], vec![init(120, 1)?], vec![])?;
    assert_eq!(report.reserves.len(), 1);
    assert_eq!(report.deltas[0].kind, DeltaKind::HistoricalOnlyUnexplained);
    assert!(!report.certifiable());
    Ok(())
}

#[test]
fn historical_with_later_drop_is_explained() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![],
        vec![init(120, 1)?],
        vec![drop(140, 1)?],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.explained_delta_count, 1);
    assert_eq!(report.summary.deprecated_or_removed_count, 1);
    Ok(())
}

#[test]
fn duplicate_provider_init_is_deduplicated() -> TestResult {
    let event = init(120, 1)?;
    let report = reconcile(
        &admission()?,
        vec![current(0, 1)?],
        vec![event.clone(), event],
        vec![],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.duplicate_observations, 1);
    Ok(())
}

#[test]
fn duplicate_reserve_id_with_different_assets_fails() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![current(0, 1)?, current(0, 2)?],
        vec![init(120, 1)?, init(130, 2)?],
        vec![],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn dropped_current_reserve_fails_closed() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![current(0, 1)?],
        vec![init(120, 1)?],
        vec![drop(140, 1)?],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn input_order_is_byte_identical() -> TestResult {
    let left = reconcile(
        &admission()?,
        vec![current(0, 1)?, current(1, 2)?],
        vec![init(120, 1)?, init(130, 2)?],
        vec![],
    )?;
    let right = reconcile(
        &admission()?,
        vec![current(1, 2)?, current(0, 1)?],
        vec![init(130, 2)?, init(120, 1)?],
        vec![],
    )?;
    assert_eq!(left.canonical_json()?, right.canonical_json()?);
    Ok(())
}

#[test]
fn reserve_initialized_decoder_is_strict() -> TestResult {
    let configurator = address(0x90)?;
    let interface = aave_interface();
    let asset = address(1)?;
    let a_token = address(2)?;
    let stable = address(3)?;
    let variable = address(4)?;
    let strategy = address(5)?;
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&interface.reserve_initialized_topic);
    let mut topic1 = [0_u8; 32];
    topic1[12..].copy_from_slice(asset.as_bytes());
    let mut topic2 = [0_u8; 32];
    topic2[12..].copy_from_slice(a_token.as_bytes());
    let log = RawLogEnvelope::new(
        configurator,
        hash(0x33)?,
        1,
        2,
        vec![
            Hash32::new(topic0)?,
            Hash32::new(topic1)?,
            Hash32::new(topic2)?,
        ],
        [
            abi::address_word(stable.as_bytes()).as_slice(),
            abi::address_word(variable.as_bytes()).as_slice(),
            abi::address_word(strategy.as_bytes()).as_slice(),
        ]
        .concat(),
        false,
    )?;
    let decoded = decode_reserve_initialized(configurator, &log)?;
    assert_eq!(decoded.asset, asset);
    assert_eq!(decoded.a_token, a_token);
    assert_eq!(decoded.stable_debt_token, Some(stable));
    assert_eq!(decoded.variable_debt_token, variable);
    assert_eq!(decoded.interest_rate_strategy, Some(strategy));
    Ok(())
}

#[test]
fn reserve_dropped_decoder_is_strict() -> TestResult {
    let configurator = address(0x90)?;
    let interface = aave_interface();
    let asset = address(1)?;
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&interface.reserve_dropped_topic);
    let mut topic1 = [0_u8; 32];
    topic1[12..].copy_from_slice(asset.as_bytes());
    let log = RawLogEnvelope::new(
        configurator,
        hash(0x34)?,
        1,
        3,
        vec![Hash32::new(topic0)?, Hash32::new(topic1)?],
        vec![],
        false,
    )?;
    assert_eq!(decode_reserve_dropped(configurator, &log)?.asset, asset);
    Ok(())
}

#[test]
fn same_asset_with_two_current_ids_fails_closed() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![current(0, 1)?, current(1, 1)?],
        vec![init(120, 1)?],
        vec![],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn exact_duplicate_current_rows_do_not_create_two_markets() -> TestResult {
    let row = current(0, 1)?;
    let report = reconcile(
        &admission()?,
        vec![row.clone(), row],
        vec![init(120, 1)?],
        vec![],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.source_a_count, 1);
    assert_eq!(report.summary.union_count, 1);
    assert_eq!(report.reserves.len(), 1);
    Ok(())
}

#[test]
fn duplicate_drop_provider_observation_is_deduplicated() -> TestResult {
    let dropped = drop(140, 1)?;
    let report = reconcile(
        &admission()?,
        vec![],
        vec![init(120, 1)?],
        vec![dropped.clone(), dropped],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.duplicate_observations, 1);
    assert_eq!(report.summary.deprecated_or_removed_count, 1);
    Ok(())
}

#[test]
fn drop_at_or_before_initialization_fails_closed() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![],
        vec![init(120, 1)?],
        vec![drop(120, 1)?],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn drop_without_initialization_fails_closed() -> TestResult {
    let result = reconcile(&admission()?, vec![], vec![], vec![drop(140, 1)?]);
    assert!(result.is_err());
    Ok(())
}

#[test]
fn conflicting_second_initialization_for_same_asset_fails_closed() -> TestResult {
    let first = init(120, 1)?;
    let mut second = init(130, 1)?;
    second.a_token = address(0x7a)?;
    let result = reconcile(
        &admission()?,
        vec![current(0, 1)?],
        vec![first, second],
        vec![],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn distinct_asset_addresses_produce_distinct_market_ids() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![current(0, 1)?, current(1, 2)?],
        vec![init(120, 1)?, init(130, 2)?],
        vec![],
    )?;
    assert_eq!(report.reserves.len(), 2);
    assert_ne!(report.reserves[0].market_id, report.reserves[1].market_id);
    Ok(())
}

#[test]
fn evidence_from_getter_and_history_is_merged_without_duplicates() -> TestResult {
    let shared = EvidenceRef::Artifact(hash(0x44)?);
    let mut getter = current(0, 1)?;
    getter.evidence = vec![shared];
    let mut initialized = init(120, 1)?;
    initialized.evidence = vec![shared, EvidenceRef::Artifact(hash(0x45)?)];
    let report = reconcile(&admission()?, vec![getter], vec![initialized], vec![])?;
    assert_eq!(report.reserves[0].evidence.len(), 2);
    Ok(())
}

#[test]
fn reserve_initialized_allows_zero_optional_v3_addresses() -> TestResult {
    let configurator = address(0x90)?;
    let interface = aave_interface();
    let asset = address(1)?;
    let a_token = address(2)?;
    let variable = address(4)?;
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&interface.reserve_initialized_topic);
    let mut topic1 = [0_u8; 32];
    topic1[12..].copy_from_slice(asset.as_bytes());
    let mut topic2 = [0_u8; 32];
    topic2[12..].copy_from_slice(a_token.as_bytes());
    let log = RawLogEnvelope::new(
        configurator,
        hash(0x35)?,
        1,
        4,
        vec![
            Hash32::new(topic0)?,
            Hash32::new(topic1)?,
            Hash32::new(topic2)?,
        ],
        [
            [0_u8; 32].as_slice(),
            abi::address_word(variable.as_bytes()).as_slice(),
            [0_u8; 32].as_slice(),
        ]
        .concat(),
        false,
    )?;
    let decoded = decode_reserve_initialized(configurator, &log)?;
    assert_eq!(decoded.stable_debt_token, None);
    assert_eq!(decoded.interest_rate_strategy, None);
    assert_eq!(decoded.variable_debt_token, variable);
    Ok(())
}

#[test]
fn reserve_event_wrong_emitter_is_rejected() -> TestResult {
    let configurator = address(0x90)?;
    let wrong = address(0x91)?;
    let interface = aave_interface();
    let asset = address(1)?;
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&interface.reserve_dropped_topic);
    let mut topic1 = [0_u8; 32];
    topic1[12..].copy_from_slice(asset.as_bytes());
    let log = RawLogEnvelope::new(
        wrong,
        hash(0x36)?,
        1,
        5,
        vec![Hash32::new(topic0)?, Hash32::new(topic1)?],
        vec![],
        false,
    )?;
    assert!(decode_reserve_dropped(configurator, &log).is_err());
    Ok(())
}

#[test]
fn reserve_event_noncanonical_indexed_address_is_rejected() -> TestResult {
    let configurator = address(0x90)?;
    let interface = aave_interface();
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&interface.reserve_dropped_topic);
    let mut malformed = [0_u8; 32];
    malformed[0] = 1;
    malformed[12..].copy_from_slice(address(1)?.as_bytes());
    let log = RawLogEnvelope::new(
        configurator,
        hash(0x37)?,
        1,
        6,
        vec![Hash32::new(topic0)?, Hash32::new(malformed)?],
        vec![],
        false,
    )?;
    assert!(decode_reserve_dropped(configurator, &log).is_err());
    Ok(())
}
