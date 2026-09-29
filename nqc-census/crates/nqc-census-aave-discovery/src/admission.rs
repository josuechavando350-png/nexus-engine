use nqc_census_chain::{json::Json, ChainError};
use nqc_census_core::{
    AdapterCapability, Address, BlockWindow, CapabilityAdmission, CapabilityScope, ChainDomain,
    DeclaredUniverse, DeploymentBinding, DeploymentKey, DeploymentLifeState, DeploymentRegistry,
    DiscoveryRoot, DiscoveryRootKind, EvidenceRef, Hash32, ObservationSemantics, ProtocolFamily,
    ProxyKind, StateAnchor, SupportedSemanticsProfile, UniverseScope,
};
use nqc_census_store::{ArtifactId, Store, StoreConfig};
use std::{
    collections::BTreeSet,
    error::Error,
    fs,
    path::Path,
};

const ADDRESSES_PROVIDER: &str = "0x2f39d218133afab8f2b819b1066c7e434ad94e9e";
const POOL: &str = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
const SEMANTICS_VERSION: u32 = 1;

fn required<'a>(value: &'a Json, key: &str) -> Result<&'a Json, ChainError> {
    value
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("missing field {key}")))
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn hash_text(value: &str) -> Result<Hash32, ChainError> {
    let encoded = if value.starts_with("0x") {
        value.to_owned()
    } else {
        format!("0x{value}")
    };
    Ok(Hash32::parse_hex(&encoded)?)
}

fn chain_domain(report: &Json) -> Result<ChainDomain, ChainError> {
    let bootstrap = required(report, "bootstrap")?;
    let domain = required(bootstrap, "chain_domain")?;
    ChainDomain::new(
        number(domain, "chain_id")?,
        hash_text(domain.str_field("genesis_hash")?)?,
        hash_text(domain.str_field("fork_lineage")?)?,
    )
    .map_err(ChainError::from)
}

fn anchor(value: &Json, chain: &ChainDomain) -> Result<StateAnchor, ChainError> {
    StateAnchor::new(
        chain.clone(),
        number(value, "number")?,
        hash_text(value.str_field("hash")?)?,
        hash_text(value.str_field("parent_hash")?)?,
        number(value, "timestamp")?,
        hash_text(value.str_field("state_root")?)?,
    )
    .map_err(ChainError::from)
}

fn observation_anchor(report: &Json, chain: &ChainDomain) -> Result<StateAnchor, ChainError> {
    let bootstrap = required(report, "bootstrap")?;
    let anchor_result = required(bootstrap, "anchor")?;
    anchor(required(anchor_result, "anchor")?, chain)
}

fn creation_anchor(report: &Json, chain: &ChainDomain) -> Result<StateAnchor, ChainError> {
    let boundary_result = required(report, "pool_boundary")?;
    let boundary = required(boundary_result, "boundary")?;
    anchor(required(boundary, "anchor")?, chain)
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

fn add_manifest(
    store: &Store,
    manifests: &mut BTreeSet<ArtifactId>,
    value: &Json,
) -> Result<(), Box<dyn Error>> {
    let id = ArtifactId::parse_hex(
        value
            .as_str()
            .ok_or_else(|| ChainError::Evidence("manifest id is not a string".into()))?,
    )?;
    store.verify_artifact(&id)?;
    manifests.insert(id);
    Ok(())
}

fn evidence_refs(
    store: &Store,
    current: &Json,
    history: &Json,
) -> Result<Vec<EvidenceRef>, Box<dyn Error>> {
    let mut manifests = BTreeSet::new();

    for row in required(current, "provider_manifests")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("current provider manifests are not an array".into()))?
    {
        add_manifest(store, &mut manifests, required(row, "manifest")?)?;
    }

    let bootstrap = required(current, "bootstrap")?;
    for row in required(bootstrap, "providers")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("bootstrap providers are not an array".into()))?
    {
        add_manifest(store, &mut manifests, required(row, "bootstrap_manifest")?)?;
        add_manifest(store, &mut manifests, required(row, "anchor_manifest")?)?;
    }

    for key in [
        "pool_boundary_manifests",
        "pool_configurator_boundary_manifests",
    ] {
        for value in required(history, key)?
            .as_array()
            .ok_or_else(|| ChainError::Evidence(format!("{key} is not an array")))?
        {
            add_manifest(store, &mut manifests, value)?;
        }
    }

    for scan in required(history, "scan_evidence")?
        .as_array()
        .ok_or_else(|| ChainError::Evidence("scan evidence is not an array".into()))?
    {
        for window in required(scan, "windows")?
            .as_array()
            .ok_or_else(|| ChainError::Evidence("scan windows are not an array".into()))?
        {
            add_manifest(store, &mut manifests, required(window, "manifest")?)?;
        }
    }

    manifests
        .into_iter()
        .map(|id| id.evidence_ref().map_err(|error| error.into()))
        .collect()
}

pub fn run_admission(
    current_path: &Path,
    history_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let current = Json::parse(&fs::read(current_path)?)?;
    let history = Json::parse(&fs::read(history_path)?)?;
    if current.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS") {
        return Err(ChainError::Evidence("current report is not PASS".into()).into());
    }
    if history.get("status").and_then(Json::as_str)
        != Some("HISTORY_RECONCILIATION_PASS_PROXY_LINEAGE_PENDING")
    {
        return Err(ChainError::Evidence("history report is not reconciled".into()).into());
    }
    if number(required(history, "summary")?, "unexplained_delta_count")? != 0 {
        return Err(ChainError::Evidence("history has unexplained deltas".into()).into());
    }

    let chain = chain_domain(&current)?;
    if chain_domain(&history)? != chain {
        return Err(ChainError::Evidence("current/history chain domains differ".into()).into());
    }
    let creation = creation_anchor(&history, &chain)?;
    let observation = observation_anchor(&current, &chain)?;
    let facts = required(&current, "facts")?;
    let pool = Address::parse_hex(facts.str_field("pool")?)?;
    let addresses_provider = Address::parse_hex(facts.str_field("addresses_provider")?)?;
    if pool != Address::parse_hex(POOL)?
        || addresses_provider != Address::parse_hex(ADDRESSES_PROVIDER)?
    {
        return Err(ChainError::Evidence("current deployment identity differs".into()).into());
    }

    let deployment_instance = hash_text(history.str_field("deployment_instance")?)?;
    let deployment =
        DeploymentKey::new(chain.clone(), ProtocolFamily::AaveV3, pool, deployment_instance);
    let root = DiscoveryRoot::new(
        DiscoveryRootKind::AaveAddressesProvider,
        addresses_provider,
    );

    let runtime_hashes = required(facts, "runtime_sha256")?;
    let deployment_code_hash = hash_text(runtime_hashes.str_field("pool_proxy")?)?;
    let implementation_address = Address::parse_hex(facts.str_field("pool_implementation")?)?;
    let implementation_code_hash =
        hash_text(runtime_hashes.str_field("pool_implementation")?)?;
    let fingerprint = required(&current, "admission_fingerprint")?;
    let configuration_hash = hash_text(fingerprint.str_field("configuration_sha256")?)?;
    let oracle_configuration_hash =
        hash_text(fingerprint.str_field("oracle_configuration_sha256")?)?;

    let universe = DeclaredUniverse::new(vec![UniverseScope::new(
        chain.clone(),
        ProtocolFamily::AaveV3,
        vec![root],
        BlockWindow::new(creation.block_number(), creation.block_number())?,
        BlockWindow::new(observation.block_number(), observation.block_number())?,
    )?])?;
    let universe_id = universe.id();
    let capability_state = capabilities()?;
    let scope = CapabilityScope::new(chain.clone(), ProtocolFamily::AaveV3, SEMANTICS_VERSION)?;
    let profile = SupportedSemanticsProfile::new(
        scope,
        ProxyKind::ExplicitOther,
        deployment_code_hash,
        implementation_code_hash,
        configuration_hash,
        oracle_configuration_hash,
        capability_state.clone(),
    );
    let store = Store::open(store_path, &StoreConfig::standard())?;
    let evidence = evidence_refs(&store, &current, &history)?;
    let evidence_count = evidence.len();

    let binding = DeploymentBinding::new(
        deployment.clone(),
        root,
        creation.clone(),
        observation.clone(),
        ProxyKind::ExplicitOther,
        implementation_address,
        implementation_code_hash,
        ObservationSemantics::new(deployment_code_hash, configuration_hash),
        oracle_configuration_hash,
        SEMANTICS_VERSION,
        DeploymentLifeState::Active,
        capability_state,
        evidence,
    )?;

    let mut registry = DeploymentRegistry::new(universe);
    registry.declare_supported_semantics(profile)?;
    let outcome = registry.admit(binding, None)?;
    let admission_id = outcome.id();
    let record = registry
        .record(admission_id)
        .ok_or_else(|| ChainError::Evidence("admission record disappeared".into()))?;
    if record.binding().deployment() != &deployment {
        return Err(ChainError::Evidence("admission deployment identity changed".into()).into());
    }

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-006-aave-deployment-admission-v1"),
        ),
        ("status", Json::string("D05_ADMISSION_MATERIALIZED")),
        ("admission_id", Json::string(admission_id.to_hex())),
        ("universe_id", Json::string(universe_id.to_hex())),
        ("chain_id", Json::uint(chain.chain_id())),
        ("pool", Json::string(pool.to_hex())),
        (
            "addresses_provider",
            Json::string(addresses_provider.to_hex()),
        ),
        (
            "deployment_instance",
            Json::string(deployment_instance.to_hex()),
        ),
        (
            "creation_block",
            Json::uint(creation.block_number()),
        ),
        (
            "observation_block",
            Json::uint(observation.block_number()),
        ),
        (
            "proxy_kind",
            Json::string("EXPLICIT_OTHER_EIP1967_EVIDENCED"),
        ),
        (
            "implementation",
            Json::string(implementation_address.to_hex()),
        ),
        (
            "deployment_code_hash",
            Json::string(deployment_code_hash.to_hex()),
        ),
        (
            "implementation_code_hash",
            Json::string(implementation_code_hash.to_hex()),
        ),
        (
            "configuration_hash",
            Json::string(configuration_hash.to_hex()),
        ),
        (
            "oracle_configuration_hash",
            Json::string(oracle_configuration_hash.to_hex()),
        ),
        ("semantics_version", Json::uint(u64::from(SEMANTICS_VERSION))),
        ("evidence_ref_count", Json::uint(evidence_count as u64)),
        (
            "capability_state",
            Json::object([
                ("market_discovery", Json::Bool(true)),
                ("all_downstream_capabilities", Json::Bool(false)),
            ]),
        ),
        (
            "remaining_blocker",
            Json::string("ADDRESSES_PROVIDER_PROXY_LINEAGE_NOT_YET_CERTIFIED"),
        ),
    ]))
}
