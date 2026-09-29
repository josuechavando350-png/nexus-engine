use crate::aave_interface;
use nqc_census_chain::{
    acquire::{raw_log_semantics, Acquisition, ScanOutcome},
    consensus::agree_logs,
    hex,
    job::LogFilter,
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    ChainError,
};
use nqc_census_core::{Address, ChainDomain, Hash32, RawLogEnvelope, StateAnchor};

const LINEAGE_NAMESPACE: u16 = 0x0604;
const CHECKPOINT_SPAN: u64 = 1_000_000;
const FAMILY: &str = "rmc006-aave-configurator-lineage";
const POOL_CONFIGURATOR_ID: &str =
    "0x504f4f4c5f434f4e464947555241544f52000000000000000000000000000000";

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProxyCreation {
    block: u64,
    transaction_index: u64,
    log_index: u64,
    block_hash: Hash32,
    transaction_hash: Hash32,
    proxy: Address,
    implementation: Address,
}

impl ProxyCreation {
    fn coordinate(&self) -> (u64, u64, u64) {
        (self.block, self.transaction_index, self.log_index)
    }

    fn json(&self) -> Json {
        Json::object([
            ("block", Json::uint(self.block)),
            ("block_hash", Json::string(self.block_hash.to_hex())),
            (
                "transaction_hash",
                Json::string(self.transaction_hash.to_hex()),
            ),
            ("transaction_index", Json::uint(self.transaction_index)),
            ("log_index", Json::uint(self.log_index)),
            ("id", Json::string(POOL_CONFIGURATOR_ID)),
            ("proxy", Json::string(self.proxy.to_hex())),
            ("implementation", Json::string(self.implementation.to_hex())),
        ])
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ImplementationUpdate {
    block: u64,
    transaction_index: u64,
    log_index: u64,
    block_hash: Hash32,
    transaction_hash: Hash32,
    old: Option<Address>,
    new: Address,
}

impl ImplementationUpdate {
    fn coordinate(&self) -> (u64, u64, u64) {
        (self.block, self.transaction_index, self.log_index)
    }

    fn json(&self) -> Json {
        Json::object([
            ("block", Json::uint(self.block)),
            ("block_hash", Json::string(self.block_hash.to_hex())),
            (
                "transaction_hash",
                Json::string(self.transaction_hash.to_hex()),
            ),
            ("transaction_index", Json::uint(self.transaction_index)),
            ("log_index", Json::uint(self.log_index)),
            (
                "old",
                self.old
                    .map_or(Json::Null, |address| Json::string(address.to_hex())),
            ),
            ("new", Json::string(self.new.to_hex())),
        ])
    }
}

#[derive(Debug, Clone)]
pub struct ConfiguratorLineage {
    pub configurators: Vec<Address>,
    pub proxy_creation: Json,
    pub implementation_updates: Vec<Json>,
    pub current_implementation: Address,
    pub manifests: Vec<String>,
    pub scan_evidence: Vec<Json>,
    pub creation_block: u64,
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn raw_log(value: &Json) -> Result<RawLogEnvelope, ChainError> {
    let emitter = Address::parse_hex(value.str_field("emitter")?)?;
    let transaction_hash = Hash32::parse_hex(value.str_field("transaction_hash")?)?;
    let transaction_index = u32::try_from(number(value, "transaction_index")?)
        .map_err(|_| ChainError::Evidence("transaction index exceeds u32".into()))?;
    let log_index = u32::try_from(number(value, "log_index")?)
        .map_err(|_| ChainError::Evidence("log index exceeds u32".into()))?;
    let topics = value
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("lineage topics missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .ok_or_else(|| ChainError::Evidence("lineage topic is not text".into()))
                .and_then(|text| Hash32::parse_hex(text).map_err(ChainError::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RawLogEnvelope::new(
        emitter,
        transaction_hash,
        transaction_index,
        log_index,
        topics,
        hex::decode_data(value.str_field("data")?)?,
        false,
    )?)
}

fn indexed_optional_address(
    topic: &Hash32,
    label: &'static str,
) -> Result<Option<Address>, ChainError> {
    let word = topic.as_bytes();
    if word[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "{label} has non-canonical indexed-address padding"
        )));
    }
    if word[12..].iter().all(|byte| *byte == 0) {
        return Ok(None);
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&word[12..]);
    Ok(Some(Address::new(address)?))
}

fn indexed_address(topic: &Hash32, label: &'static str) -> Result<Address, ChainError> {
    indexed_optional_address(topic, label)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} is zero")))
}

fn parse_proxy_creation(root: Address, record: &Json) -> Result<Option<ProxyCreation>, ChainError> {
    let log = raw_log(record)?;
    if log.emitter() != root || !log.data().is_empty() {
        return Err(ChainError::Evidence(
            "ProxyCreated canonical payload differs from declared root/layout".into(),
        ));
    }
    let topics = log.topics();
    if topics.len() != 4 || topics[0].as_bytes() != &aave_interface().proxy_created_topic {
        return Err(ChainError::Evidence(
            "ProxyCreated topic layout differs".into(),
        ));
    }
    if topics[1].to_hex() != POOL_CONFIGURATOR_ID {
        return Ok(None);
    }
    Ok(Some(ProxyCreation {
        block: number(record, "block")?,
        transaction_index: u64::from(log.transaction_index()),
        log_index: u64::from(log.log_index()),
        block_hash: Hash32::parse_hex(record.str_field("block_hash")?)?,
        transaction_hash: log.transaction_hash(),
        proxy: indexed_address(&topics[2], "PoolConfigurator proxy")?,
        implementation: indexed_address(&topics[3], "PoolConfigurator initial implementation")?,
    }))
}

fn parse_implementation_update(
    root: Address,
    record: &Json,
) -> Result<ImplementationUpdate, ChainError> {
    let log = raw_log(record)?;
    if log.emitter() != root || !log.data().is_empty() {
        return Err(ChainError::Evidence(
            "PoolConfiguratorUpdated canonical payload differs from declared root/layout".into(),
        ));
    }
    let topics = log.topics();
    if topics.len() != 3
        || topics[0].as_bytes() != &aave_interface().pool_configurator_updated_topic
    {
        return Err(ChainError::Evidence(
            "PoolConfiguratorUpdated topic layout differs".into(),
        ));
    }
    Ok(ImplementationUpdate {
        block: number(record, "block")?,
        transaction_index: u64::from(log.transaction_index()),
        log_index: u64::from(log.log_index()),
        block_hash: Hash32::parse_hex(record.str_field("block_hash")?)?,
        transaction_hash: log.transaction_hash(),
        old: indexed_optional_address(&topics[1], "old PoolConfigurator implementation")?,
        new: indexed_address(&topics[2], "new PoolConfigurator implementation")?,
    })
}

fn scan_lineage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    root: Address,
    origin: &StateAnchor,
    last: u64,
) -> Result<ScanOutcome, ChainError> {
    let interface = aave_interface();
    let filter = LogFilter::new(
        vec![root],
        vec![
            interface.proxy_created_topic,
            interface.pool_configurator_updated_topic,
        ],
    )?;
    acquisition.scan(
        provider,
        chain,
        None,
        FAMILY,
        1,
        LINEAGE_NAMESPACE,
        &filter,
        origin,
        last,
        CHECKPOINT_SPAN,
        |claimed| raw_log_semantics(&claimed.log.emitter(), FAMILY),
    )
}

fn scan_record(provider: &str, scan: &ScanOutcome) -> Result<Json, ChainError> {
    let mut manifests = Vec::with_capacity(scan.windows.len());
    for window in &scan.windows {
        manifests.push(Json::string(window.manifest_id().to_hex()));
    }
    Ok(Json::object([
        ("provider", Json::string(provider)),
        ("certified_first", Json::uint(scan.certified_first)),
        ("certified_last", Json::uint(scan.certified_last)),
        ("commitment", Json::string(scan.commitment.clone())),
        ("window_manifests", Json::Array(manifests)),
    ]))
}

pub fn discover_configurator_lineage(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    chain: &ChainDomain,
    root: Address,
    origin: &StateAnchor,
    observation: &StateAnchor,
    expected: (Address, Address),
) -> Result<ConfiguratorLineage, ChainError> {
    let (expected_proxy, expected_current_implementation) = expected;
    let mut per_provider = Vec::new();
    let mut scans = Vec::new();
    let mut manifests = Vec::new();
    for provider in providers.iter() {
        let scan = scan_lineage(
            acquisition,
            provider,
            chain,
            root,
            origin,
            observation.block_number(),
        )?;
        let logs = scan.logs()?;
        per_provider.push((provider.label().to_owned(), logs));
        manifests.extend(
            scan.windows
                .iter()
                .map(|window| window.manifest_id().to_hex()),
        );
        scans.push((provider.label().to_owned(), scan));
    }

    let logs = agree_logs(FAMILY, &per_provider)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let interface = aave_interface();
    let mut creations = Vec::new();
    let mut updates = Vec::new();
    for record in &logs {
        let raw = raw_log(record)?;
        let topic0 = raw
            .topics()
            .first()
            .ok_or_else(|| ChainError::Evidence("lineage log has no topic0".into()))?;
        if topic0.as_bytes() == &interface.proxy_created_topic {
            if let Some(creation) = parse_proxy_creation(root, record)? {
                creations.push(creation);
            }
        } else if topic0.as_bytes() == &interface.pool_configurator_updated_topic {
            updates.push(parse_implementation_update(root, record)?);
        } else {
            return Err(ChainError::Evidence(
                "lineage scan returned undeclared topic".into(),
            ));
        }
    }

    creations.sort_by_key(ProxyCreation::coordinate);
    updates.sort_by_key(ImplementationUpdate::coordinate);
    if creations.len() != 1 {
        return Err(ChainError::Evidence(format!(
            "expected exactly one PoolConfigurator ProxyCreated event, got {}",
            creations.len()
        )));
    }
    let creation = &creations[0];
    if creation.proxy != expected_proxy {
        return Err(ChainError::Evidence(
            "PoolConfigurator proxy differs from exact-anchor getter".into(),
        ));
    }
    if updates.is_empty() {
        return Err(ChainError::Evidence(
            "PoolConfigurator implementation update history is empty".into(),
        ));
    }

    let mut current = creation.implementation;
    for (index, update) in updates.iter().enumerate() {
        if update.coordinate() <= creation.coordinate() {
            return Err(ChainError::Evidence(
                "PoolConfiguratorUpdated does not follow ProxyCreated".into(),
            ));
        }
        match update.old {
            None if index == 0 && update.new == creation.implementation => {}
            Some(old) if old == current => {
                if update.new == current {
                    return Err(ChainError::Evidence(
                        "PoolConfiguratorUpdated is a no-op".into(),
                    ));
                }
                current = update.new;
            }
            _ => {
                return Err(ChainError::Evidence(
                    "PoolConfigurator implementation lineage is discontinuous".into(),
                ))
            }
        }
    }
    if current != expected_current_implementation {
        return Err(ChainError::Evidence(
            "latest PoolConfigurator implementation differs from exact-anchor EIP-1967 state"
                .into(),
        ));
    }

    let scan_evidence = scans
        .iter()
        .map(|(provider, scan)| scan_record(provider, scan))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(ConfiguratorLineage {
        configurators: vec![creation.proxy],
        proxy_creation: creation.json(),
        implementation_updates: updates.iter().map(ImplementationUpdate::json).collect(),
        current_implementation: current,
        manifests,
        scan_evidence,
        creation_block: creation.block,
    })
}
