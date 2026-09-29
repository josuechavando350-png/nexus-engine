//! D05 admission of the declared Uniswap V2 factory from observed evidence.
//!
//! The factory is not a proxy (`ProxyKind::Direct`): its own runtime code is
//! the implementation, and the admission binds its sha256 together with the
//! discovery interface the reconciliation relies on.

use crate::factory_interface;
use nqc_census_chain::{acquire::anchor_from_result, hex, json::Json, ChainError};
use nqc_census_core::{
    AdapterCapability, Address, AdmissionRecord, BlockWindow, CapabilityAdmission, CapabilityScope,
    ChainDomain, DeclaredUniverse, DeploymentBinding, DeploymentKey, DeploymentLifeState,
    DeploymentRegistry, DiscoveryRoot, DiscoveryRootKind, EvidenceRef, Hash32,
    ObservationSemantics, ProtocolFamily, ProxyKind, StateAnchor, SupportedSemanticsProfile,
    UniverseScope,
};
use sha2::{Digest, Sha256};

const SEMANTICS_VERSION: u32 = 1;

fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    value
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("missing field {key}")))
}

fn hash_plain(text: &str) -> Result<Hash32, ChainError> {
    Ok(Hash32::parse_hex(&format!(
        "0x{}",
        text.trim_start_matches("0x")
    ))?)
}

pub fn chain_domain(report: &Json) -> Result<ChainDomain, ChainError> {
    let domain = required(required(report, "bootstrap")?, "chain_domain")?;
    Ok(ChainDomain::new(
        domain
            .get("chain_id")
            .and_then(Json::as_i64)
            .and_then(|id| u64::try_from(id).ok())
            .ok_or_else(|| ChainError::Evidence("chain id missing".into()))?,
        Hash32::parse_hex(domain.str_field("genesis_hash")?)?,
        Hash32::parse_hex(domain.str_field("fork_lineage")?)?,
    )?)
}

pub fn observation_anchor(report: &Json, chain: &ChainDomain) -> Result<StateAnchor, ChainError> {
    anchor_from_result(
        chain,
        required(required(report, "bootstrap")?, "anchor")?,
        "anchor",
    )
}

pub fn creation_anchor(boundary: &Json, chain: &ChainDomain) -> Result<StateAnchor, ChainError> {
    anchor_from_result(
        chain,
        required(required(boundary, "proof")?, "boundary")?,
        "anchor",
    )
}

fn capabilities() -> Result<CapabilityAdmission, nqc_census_core::DeploymentRegistryError> {
    CapabilityAdmission::new(vec![
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
    ])
}

/// Deterministic instance identity: factory, creation block and its hash.
pub fn deployment_instance(factory: Address, creation: &StateAnchor) -> Result<Hash32, ChainError> {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC007-V2-DEPLOYMENT-INSTANCE-V1");
    hasher.update([0]);
    hasher.update(factory.as_bytes());
    hasher.update(creation.block_number().to_be_bytes());
    hasher.update(creation.block_hash().as_bytes());
    Ok(Hash32::new(hasher.finalize().into())?)
}

/// Admits the factory. `evidence` names every job manifest the census used.
pub fn admit(
    factory: Address,
    current: &Json,
    boundary: &Json,
    evidence: Vec<EvidenceRef>,
) -> Result<(AdmissionRecord, Json), ChainError> {
    let chain = chain_domain(current)?;
    if chain_domain(boundary)? != chain {
        return Err(ChainError::Evidence(
            "current and boundary chain domains differ".into(),
        ));
    }
    let observation = observation_anchor(current, &chain)?;
    let creation = creation_anchor(boundary, &chain)?;
    let facts = required(current, "facts")?;
    if Address::parse_hex(facts.str_field("factory")?)? != factory {
        return Err(ChainError::Evidence(
            "current report names another factory".into(),
        ));
    }
    let code_hash = hash_plain(facts.str_field("factory_runtime_sha256")?)?;
    let interface = factory_interface();
    let configuration = Json::object([
        ("factory", Json::string(factory.to_hex())),
        (
            "all_pairs_length",
            Json::string(hex::encode(&interface.all_pairs_length)),
        ),
        ("all_pairs", Json::string(hex::encode(&interface.all_pairs))),
        ("get_pair", Json::string(hex::encode(&interface.get_pair))),
        ("token0", Json::string(hex::encode(&interface.token0))),
        ("token1", Json::string(hex::encode(&interface.token1))),
        (
            "pair_created",
            Json::string(hex::encode(&interface.pair_created_topic)),
        ),
    ]);
    let configuration_hash = Hash32::new(Sha256::digest(configuration.canonical()?).into())?;
    // A V2 factory has no oracle; bind the absence explicitly.
    let oracle_configuration_hash =
        Hash32::new(Sha256::digest(b"NQC-RMC007-V2-NO-ORACLE-V1").into())?;
    let deployment = DeploymentKey::new(
        chain.clone(),
        ProtocolFamily::UniswapV2,
        factory,
        deployment_instance(factory, &creation)?,
    );
    let root = DiscoveryRoot::new(DiscoveryRootKind::V2Factory, factory);
    let registry_error =
        |error: nqc_census_core::DeploymentRegistryError| ChainError::Evidence(error.to_string());
    let universe = DeclaredUniverse::new(vec![UniverseScope::new(
        chain.clone(),
        ProtocolFamily::UniswapV2,
        vec![root],
        BlockWindow::new(creation.block_number(), creation.block_number())
            .map_err(registry_error)?,
        BlockWindow::new(observation.block_number(), observation.block_number())
            .map_err(registry_error)?,
    )
    .map_err(registry_error)?])
    .map_err(registry_error)?;
    let capability_state =
        capabilities().map_err(|error| ChainError::Evidence(error.to_string()))?;
    let profile = SupportedSemanticsProfile::new(
        CapabilityScope::new(chain.clone(), ProtocolFamily::UniswapV2, SEMANTICS_VERSION)
            .map_err(|error| ChainError::Evidence(format!("{error:?}")))?,
        ProxyKind::Direct,
        code_hash,
        code_hash,
        configuration_hash,
        oracle_configuration_hash,
        capability_state.clone(),
    );
    let evidence_count = evidence.len();
    let binding = DeploymentBinding::new(
        deployment.clone(),
        root,
        creation.clone(),
        observation.clone(),
        ProxyKind::Direct,
        factory,
        code_hash,
        ObservationSemantics::new(code_hash, configuration_hash),
        oracle_configuration_hash,
        SEMANTICS_VERSION,
        DeploymentLifeState::Active,
        capability_state,
        evidence,
    )
    .map_err(|error| ChainError::Evidence(error.to_string()))?;
    let mut registry = DeploymentRegistry::new(universe.clone());
    registry
        .declare_supported_semantics(profile)
        .map_err(|error| ChainError::Evidence(error.to_string()))?;
    let id = registry
        .admit(binding, None)
        .map_err(|error| ChainError::Evidence(error.to_string()))?
        .id();
    let record = registry
        .record(id)
        .ok_or_else(|| ChainError::Evidence("admission record disappeared".into()))?
        .clone();
    let report = Json::object([
        (
            "schema",
            Json::string("nqc-rmc-007-v2-deployment-admission-v1"),
        ),
        ("status", Json::string("D05_ADMISSION_MATERIALIZED")),
        ("admission_id", Json::string(id.to_hex())),
        ("universe_id", Json::string(universe.id().to_hex())),
        ("factory", Json::string(factory.to_hex())),
        (
            "deployment_instance",
            Json::string(deployment.deployment_instance().to_hex()),
        ),
        ("creation_block", Json::uint(creation.block_number())),
        ("observation_block", Json::uint(observation.block_number())),
        ("proxy_kind", Json::string("DIRECT")),
        ("factory_code_hash", Json::string(code_hash.to_hex())),
        (
            "configuration_hash",
            Json::string(configuration_hash.to_hex()),
        ),
        (
            "semantics_version",
            Json::uint(u64::from(SEMANTICS_VERSION)),
        ),
        ("evidence_ref_count", Json::uint(evidence_count as u64)),
        (
            "capability_state",
            Json::object([
                ("market_discovery", Json::Bool(true)),
                ("all_downstream_capabilities", Json::Bool(false)),
            ]),
        ),
    ]);
    Ok((record, report))
}
