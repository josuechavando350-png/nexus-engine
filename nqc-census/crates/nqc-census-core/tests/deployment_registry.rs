use nqc_census_core::{
    AdapterCapability, Address, AdmissionOutcome, BlockWindow, CapabilityAdmission,
    CapabilityScope, ChainDomain, DeclaredUniverse, DeploymentBinding, DeploymentKey,
    DeploymentLifeState, DeploymentRegistry, DeploymentRegistryError, DiscoveryRoot,
    DiscoveryRootKind, EvidenceRef, Hash32, ObservationSemantics, ProtocolFamily, ProxyKind,
    StateAnchor, SupportedSemanticsProfile, UniverseScope,
};

type TestResult<T = ()> = Result<T, Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Result<Hash32, nqc_census_core::IdentityError> {
    Hash32::new([byte; 32])
}

fn address(byte: u8) -> Result<Address, nqc_census_core::IdentityError> {
    Address::new([byte; 20])
}

fn chain(lineage: u8) -> TestResult<ChainDomain> {
    Ok(ChainDomain::new(1, hash(0x11)?, hash(lineage)?)?)
}

fn root() -> TestResult<DiscoveryRoot> {
    Ok(DiscoveryRoot::new(
        DiscoveryRootKind::AaveAddressesProvider,
        address(0x21)?,
    ))
}

fn universe() -> TestResult<DeclaredUniverse> {
    let scope = UniverseScope::new(
        chain(0x12)?,
        ProtocolFamily::AaveV3,
        vec![root()?],
        BlockWindow::new(100, 200)?,
        BlockWindow::new(100, 1_000)?,
    )?;
    Ok(DeclaredUniverse::new(vec![scope])?)
}

fn deployment() -> TestResult<DeploymentKey> {
    Ok(DeploymentKey::new(
        chain(0x12)?,
        ProtocolFamily::AaveV3,
        address(0x31)?,
        hash(0x32)?,
    ))
}

fn anchor(block: u64, byte: u8) -> TestResult<StateAnchor> {
    Ok(StateAnchor::new(
        chain(0x12)?,
        block,
        hash(byte)?,
        hash(byte.wrapping_sub(1))?,
        1_700_000_000 + block,
        hash(byte.wrapping_add(1))?,
    )?)
}

fn all_capabilities(value: bool) -> Result<CapabilityAdmission, DeploymentRegistryError> {
    CapabilityAdmission::new(vec![
        (AdapterCapability::MarketDiscovery, value),
        (AdapterCapability::StateReconstruction, value),
        (AdapterCapability::PositionDiscovery, value),
        (AdapterCapability::OracleObservation, value),
        (AdapterCapability::TokenAdmission, value),
        (AdapterCapability::CapitalCensus, value),
        (AdapterCapability::RouteQuotation, value),
        (AdapterCapability::ExecutionSimulation, value),
        (AdapterCapability::CompetitionObservation, value),
        (AdapterCapability::EconomicClassification, value),
    ])
}

fn profile(
    version: u32,
    proxy_kind: ProxyKind,
    code: u8,
    implementation: u8,
    config: u8,
    oracle: u8,
    capabilities: CapabilityAdmission,
) -> TestResult<SupportedSemanticsProfile> {
    Ok(SupportedSemanticsProfile::new(
        CapabilityScope::new(chain(0x12)?, ProtocolFamily::AaveV3, version)?,
        proxy_kind,
        hash(code)?,
        hash(implementation)?,
        hash(config)?,
        hash(oracle)?,
        capabilities,
    ))
}

#[allow(clippy::too_many_arguments)]
fn binding(
    version: u32,
    observed_block: u64,
    proxy_kind: ProxyKind,
    implementation_address: u8,
    code: u8,
    implementation: u8,
    config: u8,
    oracle: u8,
    life_state: DeploymentLifeState,
    capabilities: CapabilityAdmission,
) -> TestResult<DeploymentBinding> {
    Ok(DeploymentBinding::new(
        deployment()?,
        root()?,
        anchor(120, 0x41)?,
        anchor(observed_block, (observed_block % 200) as u8 + 20)?,
        proxy_kind,
        address(implementation_address)?,
        hash(implementation)?,
        ObservationSemantics::new(hash(code)?, hash(config)?),
        hash(oracle)?,
        version,
        life_state,
        capabilities,
        vec![EvidenceRef::Artifact(hash(0xa1)?)],
    )?)
}

fn registry_with_profile(
    version: u32,
    proxy_kind: ProxyKind,
    code: u8,
    implementation: u8,
    config: u8,
    oracle: u8,
    capabilities: CapabilityAdmission,
) -> TestResult<DeploymentRegistry> {
    let mut registry = DeploymentRegistry::new(universe()?);
    registry.declare_supported_semantics(profile(
        version,
        proxy_kind,
        code,
        implementation,
        config,
        oracle,
        capabilities,
    )?)?;
    Ok(registry)
}

#[test]
fn universe_is_finite_order_deterministic_and_rejects_duplicate_scope() -> TestResult {
    let left = universe()?;
    let scope_a = UniverseScope::new(
        chain(0x12)?,
        ProtocolFamily::AaveV3,
        vec![root()?],
        BlockWindow::new(100, 200)?,
        BlockWindow::new(100, 1_000)?,
    )?;
    let right = DeclaredUniverse::new(vec![scope_a.clone()])?;
    assert_eq!(left.id(), right.id());
    assert_eq!(
        DeclaredUniverse::new(vec![scope_a.clone(), scope_a]),
        Err(DeploymentRegistryError::DuplicateUniverseScope)
    );
    Ok(())
}

#[test]
fn universe_requires_explicit_compatible_discovery_roots_and_finite_windows() -> TestResult {
    assert_eq!(
        UniverseScope::new(
            chain(0x12)?,
            ProtocolFamily::AaveV3,
            vec![],
            BlockWindow::new(100, 200)?,
            BlockWindow::new(100, 1_000)?,
        ),
        Err(DeploymentRegistryError::EmptyDiscoveryRoots)
    );
    assert_eq!(
        UniverseScope::new(
            chain(0x12)?,
            ProtocolFamily::AaveV3,
            vec![DiscoveryRoot::new(
                DiscoveryRootKind::V2Factory,
                address(0x22)?
            )],
            BlockWindow::new(100, 200)?,
            BlockWindow::new(100, 1_000)?,
        ),
        Err(DeploymentRegistryError::DiscoveryRootProtocolMismatch)
    );
    assert_eq!(
        BlockWindow::new(200, 100),
        Err(DeploymentRegistryError::InvalidBlockWindow {
            first: 200,
            last: 100
        })
    );
    Ok(())
}

#[test]
fn exact_supported_binding_is_admitted_and_retry_is_idempotent() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let candidate = binding(
        1,
        300,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities,
    )?;
    let first = registry.admit(candidate.clone(), None)?;
    assert!(matches!(first, AdmissionOutcome::Created(_)));
    assert_eq!(
        registry.admit(candidate, None)?,
        AdmissionOutcome::AlreadyAdmitted(first.id())
    );
    assert_eq!(
        registry
            .active_record(&deployment()?)
            .map(|record| record.id()),
        Some(first.id())
    );
    Ok(())
}

#[test]
fn undeclared_chain_protocol_and_root_fail_closed() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let mut candidate = binding(
        1,
        300,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities,
    )?;
    candidate = DeploymentBinding::new(
        candidate.deployment().clone(),
        DiscoveryRoot::new(DiscoveryRootKind::AaveAddressesProvider, address(0x62)?),
        candidate.creation_anchor().clone(),
        candidate.observation_anchor().clone(),
        candidate.proxy_kind(),
        candidate.implementation_address(),
        candidate.implementation_code_hash(),
        candidate.semantics(),
        candidate.oracle_configuration_hash(),
        candidate.semantics_version(),
        candidate.life_state(),
        candidate.capabilities().clone(),
        candidate.evidence_refs().to_vec(),
    )?;
    assert_eq!(
        registry.admit(candidate, None),
        Err(DeploymentRegistryError::UndeclaredDiscoveryRoot)
    );
    Ok(())
}

#[test]
fn unknown_or_drifted_semantics_are_rejected() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let drifted = binding(
        1,
        300,
        ProxyKind::Transparent,
        0x61,
        0x99,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities.clone(),
    )?;
    assert_eq!(
        registry.admit(drifted, None),
        Err(DeploymentRegistryError::SemanticsFingerprintMismatch)
    );
    let unknown = binding(
        2,
        300,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities,
    )?;
    assert_eq!(
        registry.admit(unknown, None),
        Err(DeploymentRegistryError::UnsupportedDeploymentSemantics)
    );
    Ok(())
}

#[test]
fn capability_state_is_exhaustive_and_must_match_profile() -> TestResult {
    assert_eq!(
        CapabilityAdmission::new(vec![(AdapterCapability::MarketDiscovery, true)]),
        Err(DeploymentRegistryError::IncompleteCapabilityState)
    );
    let supported = all_capabilities(true)?;
    let mut registry =
        registry_with_profile(1, ProxyKind::Transparent, 0x51, 0x52, 0x53, 0x54, supported)?;
    let candidate = binding(
        1,
        300,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        all_capabilities(false)?,
    )?;
    assert_eq!(
        registry.admit(candidate, None),
        Err(DeploymentRegistryError::CapabilityStateMismatch)
    );
    Ok(())
}

#[test]
fn creation_and_observation_must_stay_inside_declared_windows() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let candidate = DeploymentBinding::new(
        deployment()?,
        root()?,
        anchor(250, 0x41)?,
        anchor(300, 0x42)?,
        ProxyKind::Transparent,
        address(0x61)?,
        hash(0x52)?,
        ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
        hash(0x54)?,
        1,
        DeploymentLifeState::Active,
        capabilities,
        vec![EvidenceRef::Artifact(hash(0xa1)?)],
    )?;
    assert_eq!(
        registry.admit(candidate, None),
        Err(DeploymentRegistryError::CreationOutsideDeclaredWindow)
    );
    Ok(())
}

#[test]
fn semantic_upgrade_requires_explicit_predecessor_and_version_increase() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = DeploymentRegistry::new(universe()?);
    registry.declare_supported_semantics(profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?)?;
    registry.declare_supported_semantics(profile(
        2,
        ProxyKind::Transparent,
        0x71,
        0x72,
        0x73,
        0x74,
        capabilities.clone(),
    )?)?;
    let first = registry.admit(
        binding(
            1,
            300,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Active,
            capabilities.clone(),
        )?,
        None,
    )?;
    let upgraded = binding(
        2,
        400,
        ProxyKind::Transparent,
        0x62,
        0x71,
        0x72,
        0x73,
        0x74,
        DeploymentLifeState::Active,
        capabilities,
    )?;
    assert!(matches!(
        registry.admit(upgraded.clone(), None),
        Err(DeploymentRegistryError::UpgradeEvidenceRequired { .. })
    ));
    let second = registry.admit(upgraded, Some(first.id()))?;
    assert!(matches!(second, AdmissionOutcome::Created(_)));
    assert_eq!(
        registry
            .active_record(&deployment()?)
            .map(|record| record.supersedes()),
        Some(Some(first.id()))
    );
    Ok(())
}

#[test]
fn lifecycle_transition_preserves_history_without_forcing_semantics_bump() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let first = registry.admit(
        binding(
            1,
            300,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Active,
            capabilities.clone(),
        )?,
        None,
    )?;
    let paused = registry.admit(
        binding(
            1,
            350,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Paused,
            capabilities,
        )?,
        Some(first.id()),
    )?;
    assert_ne!(first.id(), paused.id());
    assert!(registry.record(first.id()).is_some());
    assert!(registry.record(paused.id()).is_some());
    Ok(())
}

#[test]
fn removed_deployment_is_terminal_but_preserves_adapter_support_for_history() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let removed = registry.admit(
        binding(
            1,
            300,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Removed,
            capabilities.clone(),
        )?,
        None,
    )?;
    assert_eq!(
        registry.record(removed.id()).map(|record| record
            .binding()
            .capabilities()
            .supports(AdapterCapability::StateReconstruction)),
        Some(true)
    );
    let later = binding(
        1,
        350,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Removed,
        capabilities,
    )?;
    assert_eq!(
        registry.admit(later, Some(removed.id())),
        Err(DeploymentRegistryError::RemovedDeploymentIsTerminal)
    );
    Ok(())
}

#[test]
fn direct_and_proxy_bindings_are_explicit_not_guessed() -> TestResult {
    let capabilities = all_capabilities(true)?;
    assert!(binding(
        1,
        300,
        ProxyKind::Direct,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities.clone(),
    )
    .is_err());

    let direct = DeploymentBinding::new(
        deployment()?,
        root()?,
        anchor(120, 0x41)?,
        anchor(300, 0x42)?,
        ProxyKind::Direct,
        deployment()?.address(),
        hash(0x99)?,
        ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
        hash(0x54)?,
        1,
        DeploymentLifeState::Active,
        capabilities.clone(),
        vec![EvidenceRef::Artifact(hash(0xa1)?)],
    );
    assert_eq!(direct, Err(DeploymentRegistryError::DirectCodeHashMismatch));
    assert!(matches!(
        DeploymentBinding::new(
            deployment()?,
            root()?,
            anchor(120, 0x41)?,
            anchor(300, 0x42)?,
            ProxyKind::Transparent,
            deployment()?.address(),
            hash(0x52)?,
            ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
            hash(0x54)?,
            1,
            DeploymentLifeState::Active,
            capabilities,
            vec![EvidenceRef::Artifact(hash(0xa1)?)],
        ),
        Err(DeploymentRegistryError::ProxyImplementationMustDiffer)
    ));
    Ok(())
}

#[test]
fn wrong_chain_anchor_and_missing_evidence_fail_closed() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let wrong_anchor = StateAnchor::new(
        chain(0x99)?,
        300,
        hash(0x81)?,
        hash(0x80)?,
        1_700_000_300,
        hash(0x82)?,
    )?;
    assert_eq!(
        DeploymentBinding::new(
            deployment()?,
            root()?,
            anchor(120, 0x41)?,
            wrong_anchor,
            ProxyKind::Transparent,
            address(0x61)?,
            hash(0x52)?,
            ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
            hash(0x54)?,
            1,
            DeploymentLifeState::Active,
            capabilities.clone(),
            vec![EvidenceRef::Artifact(hash(0xa1)?)],
        ),
        Err(DeploymentRegistryError::AnchorChainMismatch)
    );
    assert_eq!(
        DeploymentBinding::new(
            deployment()?,
            root()?,
            anchor(120, 0x41)?,
            anchor(300, 0x42)?,
            ProxyKind::Transparent,
            address(0x61)?,
            hash(0x52)?,
            ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
            hash(0x54)?,
            1,
            DeploymentLifeState::Active,
            capabilities,
            vec![],
        ),
        Err(DeploymentRegistryError::MissingAdmissionEvidence)
    );
    Ok(())
}

#[test]
fn semantics_version_cannot_move_backward_even_when_fingerprint_is_unchanged() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = DeploymentRegistry::new(universe()?);
    registry.declare_supported_semantics(profile(
        2,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?)?;
    registry.declare_supported_semantics(profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?)?;
    let first = registry.admit(
        binding(
            2,
            300,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Active,
            capabilities.clone(),
        )?,
        None,
    )?;
    let rollback = binding(
        1,
        350,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Paused,
        capabilities,
    )?;
    assert_eq!(
        registry.admit(rollback, Some(first.id())),
        Err(DeploymentRegistryError::NonMonotonicSemanticsVersion)
    );
    Ok(())
}

#[test]
fn admission_identity_is_bound_to_the_exact_declared_universe() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let candidate = binding(
        1,
        300,
        ProxyKind::Transparent,
        0x61,
        0x51,
        0x52,
        0x53,
        0x54,
        DeploymentLifeState::Active,
        capabilities.clone(),
    )?;

    let mut first = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let first_id = first.admit(candidate.clone(), None)?.id();

    let alternate_scope = UniverseScope::new(
        chain(0x12)?,
        ProtocolFamily::AaveV3,
        vec![root()?],
        BlockWindow::new(110, 190)?,
        BlockWindow::new(110, 900)?,
    )?;
    let alternate_universe = DeclaredUniverse::new(vec![alternate_scope])?;
    let mut second = DeploymentRegistry::new(alternate_universe);
    second.declare_supported_semantics(profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities,
    )?)?;
    let second_id = second.admit(candidate, None)?.id();

    assert_ne!(first.universe().id(), second.universe().id());
    assert_ne!(first_id, second_id);
    assert_eq!(
        first.record(first_id).map(|record| record.universe_id()),
        Some(first.universe().id())
    );
    assert_eq!(
        second.record(second_id).map(|record| record.universe_id()),
        Some(second.universe().id())
    );
    Ok(())
}

#[test]
fn later_admission_cannot_rewrite_deployment_creation_history() -> TestResult {
    let capabilities = all_capabilities(true)?;
    let mut registry = registry_with_profile(
        1,
        ProxyKind::Transparent,
        0x51,
        0x52,
        0x53,
        0x54,
        capabilities.clone(),
    )?;
    let first = registry.admit(
        binding(
            1,
            300,
            ProxyKind::Transparent,
            0x61,
            0x51,
            0x52,
            0x53,
            0x54,
            DeploymentLifeState::Active,
            capabilities.clone(),
        )?,
        None,
    )?;

    let rewritten_origin = DeploymentBinding::new(
        deployment()?,
        root()?,
        anchor(121, 0x45)?,
        anchor(350, 0x46)?,
        ProxyKind::Transparent,
        address(0x61)?,
        hash(0x52)?,
        ObservationSemantics::new(hash(0x51)?, hash(0x53)?),
        hash(0x54)?,
        1,
        DeploymentLifeState::Paused,
        capabilities,
        vec![EvidenceRef::Artifact(hash(0xa2)?)],
    )?;

    assert_eq!(
        registry.admit(rewritten_origin, Some(first.id())),
        Err(DeploymentRegistryError::CreationAnchorChanged)
    );
    Ok(())
}
