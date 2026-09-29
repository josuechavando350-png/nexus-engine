use nqc_census_chain::abi;
use nqc_census_core::{
    AdapterCapability, Address, BlockWindow, CapabilityAdmission, CapabilityScope, ChainDomain,
    DeclaredUniverse, DeploymentBinding, DeploymentKey, DeploymentLifeState, DeploymentRegistry,
    DiscoveryRoot, DiscoveryRootKind, EvidenceRef, Hash32, ObservationSemantics, ProtocolFamily,
    ProxyKind, StateAnchor, SupportedSemanticsProfile, UniverseScope,
};
use nqc_census_v2_discovery::{
    decode_pair_created, factory_interface, reconcile, CurrentPair, DeltaKind, DirectLookupProof,
    PairCreatedProof, RuntimeCodeProof,
};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    match Hash32::new([byte; 32]) {
        Ok(value) => value,
        Err(error) => unreachable!("test hash helper received zero byte: {error}"),
    }
}

fn address(byte: u8) -> Address {
    match Address::new([byte; 20]) {
        Ok(value) => value,
        Err(error) => unreachable!("test address helper received zero byte: {error}"),
    }
}

fn admission() -> Result<nqc_census_core::AdmissionRecord, Box<dyn std::error::Error>> {
    let chain = ChainDomain::new(1, hash(1), hash(2))?;
    let factory = address(0x90);
    let deployment = DeploymentKey::new(chain.clone(), ProtocolFamily::UniswapV2, factory, hash(3));
    let root = DiscoveryRoot::new(DiscoveryRootKind::V2Factory, factory);
    let scope = UniverseScope::new(
        chain.clone(),
        ProtocolFamily::UniswapV2,
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
    let semantics = ObservationSemantics::new(hash(4), hash(5));
    let capability_scope = CapabilityScope::new(chain.clone(), ProtocolFamily::UniswapV2, 1)?;
    registry.declare_supported_semantics(SupportedSemanticsProfile::new(
        capability_scope,
        ProxyKind::Direct,
        hash(4),
        hash(4),
        hash(5),
        hash(6),
        capabilities.clone(),
    ))?;
    let creation = StateAnchor::new(
        chain.clone(),
        100,
        hash(10),
        hash(9),
        1_700_000_000,
        hash(11),
    )?;
    let observation = StateAnchor::new(chain, 500, hash(12), hash(13), 1_700_010_000, hash(14))?;
    let binding = DeploymentBinding::new(
        deployment.clone(),
        root,
        creation,
        observation,
        ProxyKind::Direct,
        factory,
        hash(4),
        semantics,
        hash(6),
        1,
        DeploymentLifeState::Active,
        capabilities,
        vec![EvidenceRef::Artifact(hash(7))],
    )?;
    let id = registry.admit(binding, None)?.id();
    Ok(registry
        .record(id)
        .ok_or("admission record missing")?
        .clone())
}

fn pair(index: u64, pair: u8, token0: u8, token1: u8) -> CurrentPair {
    CurrentPair {
        index,
        pair: address(pair),
        token0: address(token0),
        token1: address(token1),
        evidence: vec![EvidenceRef::Artifact(hash(pair))],
    }
}

fn event(index: u64, pair: u8, token0: u8, token1: u8) -> PairCreatedProof {
    PairCreatedProof {
        block_number: 120 + index,
        block_hash: hash(0x20 + index as u8),
        transaction_hash: hash(0x30 + index as u8),
        transaction_index: index as u32,
        log_index: index as u32,
        pair: address(pair),
        token0: address(token0),
        token1: address(token1),
        ordinal: index + 1,
        evidence: vec![EvidenceRef::Artifact(hash(0x40 + index as u8))],
    }
}

fn lookup(pair: u8, token0: u8, token1: u8) -> DirectLookupProof {
    DirectLookupProof {
        token0: address(token0),
        token1: address(token1),
        returned_pair: address(pair),
        evidence: vec![EvidenceRef::Artifact(hash(0x50 + pair))],
    }
}

fn runtime(pair: u8) -> RuntimeCodeProof {
    RuntimeCodeProof {
        pair: address(pair),
        code_hash: hash(0x60 + pair),
        evidence: vec![EvidenceRef::Artifact(hash(0x70 + pair))],
    }
}

#[test]
fn identical_enumeration_and_history_certify() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2), pair(1, 11, 3, 4)],
        vec![event(0, 10, 1, 2), event(1, 11, 3, 4)],
        vec![lookup(10, 1, 2), lookup(11, 3, 4)],
        vec![runtime(10), runtime(11)],
    )?;
    assert!(report.certifiable());
    assert_eq!(report.summary.union_count, 2);
    assert_eq!(report.summary.intersection_count, 2);
    assert_eq!(report.summary.unexplained_delta_count, 0);
    Ok(())
}

#[test]
fn getter_pair_missing_from_history_is_unexplained() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![],
        vec![lookup(10, 1, 2)],
        vec![runtime(10)],
    )?;
    assert!(!report.certifiable());
    assert_eq!(report.summary.enumeration_only_count, 1);
    assert_eq!(report.deltas[0].kind, DeltaKind::EnumerationOnly);
    Ok(())
}

#[test]
fn historical_event_missing_from_current_is_preserved_and_blocking() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![],
        vec![event(0, 10, 1, 2)],
        vec![lookup(10, 1, 2)],
        vec![runtime(10)],
    )?;
    assert_eq!(report.pairs.len(), 1);
    assert_eq!(report.summary.event_only_count, 1);
    assert_eq!(report.summary.historical_only_count, 1);
    assert!(!report.certifiable());
    Ok(())
}

#[test]
fn duplicate_provider_event_is_deduplicated() -> TestResult {
    let e = event(0, 10, 1, 2);
    let report = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![e.clone(), e],
        vec![lookup(10, 1, 2)],
        vec![runtime(10)],
    )?;
    assert_eq!(report.summary.duplicate_observations, 1);
    assert!(report.certifiable());
    Ok(())
}

#[test]
fn different_input_order_has_byte_identical_output() -> TestResult {
    let left = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2), pair(1, 11, 3, 4)],
        vec![event(0, 10, 1, 2), event(1, 11, 3, 4)],
        vec![lookup(10, 1, 2), lookup(11, 3, 4)],
        vec![runtime(10), runtime(11)],
    )?;
    let right = reconcile(
        &admission()?,
        vec![pair(1, 11, 3, 4), pair(0, 10, 1, 2)],
        vec![event(1, 11, 3, 4), event(0, 10, 1, 2)],
        vec![lookup(11, 3, 4), lookup(10, 1, 2)],
        vec![runtime(11), runtime(10)],
    )?;
    assert_eq!(left.canonical_json()?, right.canonical_json()?);
    Ok(())
}

#[test]
fn conflicting_identity_for_same_pair_fails_closed() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![event(0, 10, 1, 3)],
        vec![lookup(10, 1, 2)],
        vec![runtime(10)],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn direct_lookup_mismatch_is_hard_failure() -> TestResult {
    let result = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![event(0, 10, 1, 2)],
        vec![lookup(11, 1, 2)],
        vec![runtime(10)],
    );
    assert!(result.is_err());
    Ok(())
}

#[test]
fn missing_runtime_code_is_an_unexplained_delta() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![event(0, 10, 1, 2)],
        vec![lookup(10, 1, 2)],
        vec![],
    )?;
    assert!(!report.certifiable());
    assert!(report
        .deltas
        .iter()
        .any(|delta| delta.kind == DeltaKind::RuntimeCodeMissing));
    Ok(())
}

#[test]
fn reversed_lookup_tokens_normalize_to_same_pair() -> TestResult {
    let report = reconcile(
        &admission()?,
        vec![pair(0, 10, 1, 2)],
        vec![event(0, 10, 1, 2)],
        vec![lookup(10, 2, 1)],
        vec![runtime(10)],
    )?;
    assert!(report.certifiable());
    Ok(())
}

#[test]
fn paircreated_decoder_is_strict() -> TestResult {
    let factory = address(0x90);
    let iface = factory_interface();
    let token0 = address(1);
    let token1 = address(2);
    let pair_addr = address(10);
    let mut topic0 = [0_u8; 32];
    topic0.copy_from_slice(&iface.pair_created_topic);
    let mut indexed0 = [0_u8; 32];
    indexed0[12..].copy_from_slice(token0.as_bytes());
    let mut indexed1 = [0_u8; 32];
    indexed1[12..].copy_from_slice(token1.as_bytes());
    let log = nqc_census_core::RawLogEnvelope::new(
        factory,
        hash(0x33),
        1,
        2,
        vec![
            Hash32::new(topic0)?,
            Hash32::new(indexed0)?,
            Hash32::new(indexed1)?,
        ],
        [
            abi::address_word(pair_addr.as_bytes()).as_slice(),
            abi::uint_word(1).as_slice(),
        ]
        .concat(),
        false,
    )?;
    let decoded = decode_pair_created(factory, &log)?;
    assert_eq!(decoded.pair, pair_addr);
    assert_eq!(decoded.ordinal, 1);
    assert_eq!(decoded.token0, token0);
    assert_eq!(decoded.token1, token1);
    Ok(())
}
