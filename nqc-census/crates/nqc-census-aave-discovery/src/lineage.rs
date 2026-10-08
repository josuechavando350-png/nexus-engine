//! AddressesProvider lineage of the Pool and the PoolConfigurator.
//!
//! Every AddressesProvider event that can move either lineage is scanned on
//! every provider and agreed exactly: `ProxyCreated`, `AddressSet`,
//! `AddressSetAsProxy`, `PoolUpdated` and `PoolConfiguratorUpdated`. The
//! PoolConfigurator address valid at each point of history is reconstructed as
//! a sequence of windows, so reserve events are accepted only from the
//! configurator the Pool trusted at that block. A replaced Pool address would
//! be a different deployment and fails closed.

use crate::aave_interface;
use nqc_census_chain::{
    abi,
    acquire::{raw_log_semantics, Acquisition, ScanOutcome},
    consensus::agree_logs,
    hex,
    job::LogFilter,
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    ChainError,
};
use nqc_census_core::{Address, ChainDomain, Hash32, LogTopic, RawLogEnvelope, StateAnchor};

const LINEAGE_NAMESPACE: u16 = 0x0604;
pub const LINEAGE_FAMILY: &str = "rmc006-aave-addresses-provider-lineage";

/// `bytes32` identifier the AddressesProvider uses for `name`.
pub fn provider_id(name: &str) -> LogTopic {
    let mut word = [0_u8; 32];
    word[..name.len()].copy_from_slice(name.as_bytes());
    LogTopic::new(word)
}

/// Position of a log in the canonical chain.
pub type Coordinate = (u64, u32, u32);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    ProxyCreated {
        id: LogTopic,
        proxy: Address,
        implementation: Address,
    },
    AddressSet {
        id: LogTopic,
        old: Option<Address>,
        new: Option<Address>,
    },
    AddressSetAsProxy {
        id: LogTopic,
        proxy: Option<Address>,
        old_implementation: Option<Address>,
        new_implementation: Address,
    },
    PoolUpdated {
        old: Option<Address>,
        new: Address,
    },
    PoolConfiguratorUpdated {
        old: Option<Address>,
        new: Address,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Event {
    coordinate: Coordinate,
    block_hash: Hash32,
    transaction_hash: Hash32,
    kind: Kind,
}

impl Event {
    fn json(&self) -> Json {
        let address = |value: &Option<Address>| {
            value.map_or(Json::Null, |address| Json::string(address.to_hex()))
        };
        let (name, fields): (&str, Vec<(&str, Json)>) = match &self.kind {
            Kind::ProxyCreated {
                id,
                proxy,
                implementation,
            } => (
                "PROXY_CREATED",
                vec![
                    ("id", Json::string(id.to_hex())),
                    ("proxy", Json::string(proxy.to_hex())),
                    ("implementation", Json::string(implementation.to_hex())),
                ],
            ),
            Kind::AddressSet { id, old, new } => (
                "ADDRESS_SET",
                vec![
                    ("id", Json::string(id.to_hex())),
                    ("old", address(old)),
                    ("new", address(new)),
                ],
            ),
            Kind::AddressSetAsProxy {
                id,
                proxy,
                old_implementation,
                new_implementation,
            } => (
                "ADDRESS_SET_AS_PROXY",
                vec![
                    ("id", Json::string(id.to_hex())),
                    ("proxy", address(proxy)),
                    ("old_implementation", address(old_implementation)),
                    (
                        "new_implementation",
                        Json::string(new_implementation.to_hex()),
                    ),
                ],
            ),
            Kind::PoolUpdated { old, new } => (
                "POOL_UPDATED",
                vec![("old", address(old)), ("new", Json::string(new.to_hex()))],
            ),
            Kind::PoolConfiguratorUpdated { old, new } => (
                "POOL_CONFIGURATOR_UPDATED",
                vec![("old", address(old)), ("new", Json::string(new.to_hex()))],
            ),
        };
        let mut members = vec![
            ("kind", Json::string(name)),
            ("block", Json::uint(self.coordinate.0)),
            (
                "transaction_index",
                Json::uint(u64::from(self.coordinate.1)),
            ),
            ("log_index", Json::uint(u64::from(self.coordinate.2))),
            ("block_hash", Json::string(self.block_hash.to_hex())),
            (
                "transaction_hash",
                Json::string(self.transaction_hash.to_hex()),
            ),
        ];
        members.extend(fields);
        Json::object(members)
    }
}

/// A PoolConfigurator address together with the half-open range of chain
/// coordinates during which the Pool accepted it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfiguratorWindow {
    pub address: Address,
    pub from: Coordinate,
    /// Exclusive; `None` means still valid at the observation anchor.
    pub until: Option<Coordinate>,
}

impl ConfiguratorWindow {
    pub fn contains(&self, coordinate: Coordinate) -> bool {
        coordinate >= self.from && self.until.is_none_or(|until| coordinate < until)
    }

    fn json(&self) -> Json {
        let coordinate = |value: Coordinate| {
            Json::array([
                Json::uint(value.0),
                Json::uint(u64::from(value.1)),
                Json::uint(u64::from(value.2)),
            ])
        };
        Json::object([
            ("address", Json::string(self.address.to_hex())),
            ("from", coordinate(self.from)),
            ("until", self.until.map_or(Json::Null, coordinate)),
        ])
    }
}

/// Exact-anchor facts the lineage must end at, plus the earliest-code
/// boundaries of both proxies.
#[derive(Debug, Clone, Copy)]
pub struct LineageExpectation {
    pub root: Address,
    pub pool: Address,
    pub pool_implementation: Address,
    pub pool_creation_block: u64,
    pub configurator: Address,
    pub configurator_implementation: Address,
    pub configurator_creation_block: u64,
}

#[derive(Debug, Clone)]
pub struct Lineage {
    pub configurators: Vec<ConfiguratorWindow>,
    pub pool_proxy_creation: Json,
    pub configurator_proxy_creation: Json,
    pub pool_implementation_updates: Vec<Json>,
    pub configurator_implementation_updates: Vec<Json>,
    pub configurator_replacements: Vec<Json>,
    pub other_id_event_count: u64,
    pub zero_topic_log_count: u64,
    pub log_count: u64,
    pub manifests: Vec<String>,
    pub scan_evidence: Vec<Json>,
}

impl Lineage {
    pub fn configurator_addresses(&self) -> Vec<Address> {
        let mut addresses: Vec<Address> = self
            .configurators
            .iter()
            .map(|window| window.address)
            .collect();
        addresses.sort();
        addresses.dedup();
        addresses
    }

    /// The configurator the Pool trusted at `coordinate`, if any.
    pub fn configurator_at(&self, coordinate: Coordinate) -> Option<Address> {
        self.configurators
            .iter()
            .find(|window| window.contains(coordinate))
            .map(|window| window.address)
    }

    pub fn json(&self) -> Json {
        Json::object([
            (
                "configurator_windows",
                Json::array(self.configurators.iter().map(ConfiguratorWindow::json)),
            ),
            ("pool_proxy_creation", self.pool_proxy_creation.clone()),
            (
                "pool_configurator_proxy_creation",
                self.configurator_proxy_creation.clone(),
            ),
            (
                "pool_implementation_updates",
                Json::Array(self.pool_implementation_updates.clone()),
            ),
            (
                "pool_configurator_implementation_updates",
                Json::Array(self.configurator_implementation_updates.clone()),
            ),
            (
                "pool_configurator_replacements",
                Json::Array(self.configurator_replacements.clone()),
            ),
            (
                "other_id_event_count",
                Json::uint(self.other_id_event_count),
            ),
            (
                "zero_topic_log_count",
                Json::uint(self.zero_topic_log_count),
            ),
            ("log_count", Json::uint(self.log_count)),
        ])
    }
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

/// Rebuilds the raw log of a canonical scan record. Topics are ABI words
/// and may be zero; the transaction hash may not.
pub fn raw_log(value: &Json) -> Result<RawLogEnvelope, ChainError> {
    let emitter = Address::parse_hex(value.str_field("emitter")?)?;
    let transaction_hash = Hash32::parse_hex(value.str_field("transaction_hash")?)?;
    let transaction_index = u32::try_from(number(value, "transaction_index")?)
        .map_err(|_| ChainError::Evidence("transaction index exceeds u32".into()))?;
    let log_index = u32::try_from(number(value, "log_index")?)
        .map_err(|_| ChainError::Evidence("log index exceeds u32".into()))?;
    let topics = value
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("log topics missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .ok_or_else(|| ChainError::Evidence("log topic is not text".into()))
                .and_then(|text| LogTopic::parse_hex(text).map_err(ChainError::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RawLogEnvelope::with_topics(
        emitter,
        transaction_hash,
        transaction_index,
        log_index,
        topics,
        hex::decode_data(value.str_field("data")?)?,
        false,
    )?)
}

pub fn coordinate(value: &Json) -> Result<Coordinate, ChainError> {
    let small = |key: &str| {
        u32::try_from(number(value, key)?)
            .map_err(|_| ChainError::Evidence(format!("{key} exceeds u32")))
    };
    Ok((
        number(value, "block")?,
        small("transaction_index")?,
        small("log_index")?,
    ))
}

fn indexed_optional_address(
    word: &[u8; 32],
    label: &'static str,
) -> Result<Option<Address>, ChainError> {
    match abi::decode_address(word).map_err(|_| {
        ChainError::Evidence(format!("{label} has non-canonical indexed-address padding"))
    })? {
        Some(raw) => Ok(Some(Address::new(raw)?)),
        None => Ok(None),
    }
}

fn indexed_address(word: &[u8; 32], label: &'static str) -> Result<Address, ChainError> {
    indexed_optional_address(word, label)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} is zero")))
}

fn decode(root: Address, record: &Json) -> Result<Event, ChainError> {
    let log = raw_log(record)?;
    if log.emitter() != root {
        return Err(ChainError::Evidence(
            "lineage log emitted by another contract".into(),
        ));
    }
    let interface = aave_interface();
    let topics: Vec<[u8; 32]> = log.topics().iter().map(|topic| *topic.as_bytes()).collect();
    let words = abi::words(log.data())?;
    let layout = |topic_count: usize, word_count: usize, name: &str| {
        if topics.len() != topic_count || words.len() != word_count {
            return Err(ChainError::Evidence(format!("{name} layout differs")));
        }
        Ok(())
    };
    let topic0 = topics
        .first()
        .ok_or_else(|| ChainError::Evidence("lineage log has no topic0".into()))?;
    let kind = if *topic0 == interface.proxy_created_topic {
        layout(4, 0, "ProxyCreated")?;
        Kind::ProxyCreated {
            id: LogTopic::new(topics[1]),
            proxy: indexed_address(&topics[2], "ProxyCreated proxy")?,
            implementation: indexed_address(&topics[3], "ProxyCreated implementation")?,
        }
    } else if *topic0 == interface.address_set_topic {
        layout(4, 0, "AddressSet")?;
        Kind::AddressSet {
            id: LogTopic::new(topics[1]),
            old: indexed_optional_address(&topics[2], "AddressSet old")?,
            new: indexed_optional_address(&topics[3], "AddressSet new")?,
        }
    } else if *topic0 == interface.address_set_as_proxy_topic {
        layout(4, 1, "AddressSetAsProxy")?;
        Kind::AddressSetAsProxy {
            id: LogTopic::new(topics[1]),
            proxy: indexed_optional_address(&topics[2], "AddressSetAsProxy proxy")?,
            old_implementation: indexed_optional_address(
                &words[0],
                "AddressSetAsProxy old implementation",
            )?,
            new_implementation: indexed_address(
                &topics[3],
                "AddressSetAsProxy new implementation",
            )?,
        }
    } else if *topic0 == interface.pool_updated_topic {
        layout(3, 0, "PoolUpdated")?;
        Kind::PoolUpdated {
            old: indexed_optional_address(&topics[1], "PoolUpdated old")?,
            new: indexed_address(&topics[2], "PoolUpdated new")?,
        }
    } else if *topic0 == interface.pool_configurator_updated_topic {
        layout(3, 0, "PoolConfiguratorUpdated")?;
        Kind::PoolConfiguratorUpdated {
            old: indexed_optional_address(&topics[1], "PoolConfiguratorUpdated old")?,
            new: indexed_address(&topics[2], "PoolConfiguratorUpdated new")?,
        }
    } else {
        return Err(ChainError::Evidence(
            "lineage scan returned an undeclared topic".into(),
        ));
    };
    Ok(Event {
        coordinate: coordinate(record)?,
        block_hash: Hash32::parse_hex(record.str_field("block_hash")?)?,
        transaction_hash: log.transaction_hash(),
        kind,
    })
}

fn scan(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    root: Address,
    origin: &StateAnchor,
    last: u64,
    span: u64,
) -> Result<ScanOutcome, ChainError> {
    let interface = aave_interface();
    let filter = LogFilter::new(
        vec![root],
        vec![
            interface.proxy_created_topic,
            interface.address_set_topic,
            interface.address_set_as_proxy_topic,
            interface.pool_updated_topic,
            interface.pool_configurator_updated_topic,
        ],
    )?;
    acquisition.scan(
        provider,
        chain,
        None,
        LINEAGE_FAMILY,
        1,
        LINEAGE_NAMESPACE,
        &filter,
        origin,
        last,
        span,
        |claimed| raw_log_semantics(&claimed.log.emitter(), LINEAGE_FAMILY),
    )
}

fn scan_record(provider: &str, scan: &ScanOutcome) -> Json {
    Json::object([
        ("provider", Json::string(provider)),
        ("certified_first", Json::uint(scan.certified_first)),
        ("certified_last", Json::uint(scan.certified_last)),
        ("commitment", Json::string(scan.commitment.clone())),
        (
            "window_manifests",
            Json::array(
                scan.windows
                    .iter()
                    .map(|window| Json::string(window.manifest_id().to_hex())),
            ),
        ),
    ])
}

/// One proxy's implementation history: its creation and every later update,
/// which must form one continuous chain ending at `expected_final`.
fn implementation_chain(
    label: &'static str,
    creation: &Event,
    created_implementation: Address,
    updates: &[(&Event, Option<Address>, Address)],
    expected_final: Address,
) -> Result<Vec<Json>, ChainError> {
    let mut current = created_implementation;
    let mut records = Vec::with_capacity(updates.len());
    for (index, (event, old, new)) in updates.iter().enumerate() {
        if event.coordinate < creation.coordinate {
            return Err(ChainError::Evidence(format!(
                "{label} implementation update precedes its proxy creation"
            )));
        }
        match old {
            // The call that creates the proxy reports no predecessor.
            None if index == 0
                && event.transaction_hash == creation.transaction_hash
                && *new == created_implementation => {}
            Some(old) if *old == current && *new != current => current = *new,
            _ => {
                return Err(ChainError::Evidence(format!(
                    "{label} implementation lineage is discontinuous"
                )))
            }
        }
        records.push(event.json());
    }
    if current != expected_final {
        return Err(ChainError::Evidence(format!(
            "{label} implementation lineage does not end at the exact-anchor implementation"
        )));
    }
    Ok(records)
}

/// Scans, agrees and reconstructs both lineages.
pub fn discover_lineage(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    chain: &ChainDomain,
    expected: LineageExpectation,
    origin: &StateAnchor,
    observation: &StateAnchor,
    span: u64,
) -> Result<Lineage, ChainError> {
    let mut per_provider = Vec::new();
    let mut scans = Vec::new();
    let mut manifests = Vec::new();
    for provider in providers.iter() {
        let outcome = scan(
            acquisition,
            provider,
            chain,
            expected.root,
            origin,
            observation.block_number(),
            span,
        )?;
        per_provider.push((provider.label().to_owned(), outcome.logs()?));
        manifests.extend(
            outcome
                .windows
                .iter()
                .map(|window| window.manifest_id().to_hex()),
        );
        scans.push(scan_record(provider.label(), &outcome));
    }
    let logs = agree_logs(LINEAGE_FAMILY, &per_provider)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let mut zero_topic_log_count = 0_u64;
    let mut events = Vec::with_capacity(logs.len());
    for record in &logs {
        if raw_log(record)?.topics().iter().any(LogTopic::is_zero) {
            zero_topic_log_count += 1;
        }
        events.push(decode(expected.root, record)?);
    }
    events.sort_by_key(|event| event.coordinate);
    let lineage = reconstruct(&events, expected)?;
    Ok(Lineage {
        zero_topic_log_count,
        log_count: events.len() as u64,
        manifests,
        scan_evidence: scans,
        ..lineage
    })
}

fn reconstruct(events: &[Event], expected: LineageExpectation) -> Result<Lineage, ChainError> {
    let pool_id = provider_id("POOL");
    let configurator_id = provider_id("POOL_CONFIGURATOR");
    let mut other_id_event_count = 0_u64;
    let mut pool_creations = Vec::new();
    let mut configurator_creations = Vec::new();
    let mut pool_updates = Vec::new();
    let mut configurator_updates = Vec::new();
    let mut replacements = Vec::new();
    for event in events {
        match &event.kind {
            Kind::ProxyCreated {
                id,
                proxy,
                implementation,
            } if *id == pool_id => pool_creations.push((event, *proxy, *implementation)),
            Kind::ProxyCreated {
                id,
                proxy,
                implementation,
            } if *id == configurator_id => {
                configurator_creations.push((event, *proxy, *implementation));
            }
            Kind::AddressSet { id, .. } if *id == pool_id => {
                return Err(ChainError::Evidence(
                    "AddressSet replaced the POOL address; the declared deployment covers one \
                     Pool lineage"
                        .into(),
                ))
            }
            Kind::AddressSet { id, old, new } if *id == configurator_id => {
                replacements.push((event, *old, *new));
            }
            Kind::AddressSetAsProxy {
                id,
                proxy,
                old_implementation,
                new_implementation,
            } if *id == pool_id => {
                if proxy.is_some_and(|proxy| proxy != expected.pool) {
                    return Err(ChainError::Evidence(
                        "AddressSetAsProxy(POOL) names another proxy".into(),
                    ));
                }
                pool_updates.push((event, *old_implementation, *new_implementation));
            }
            Kind::AddressSetAsProxy {
                id,
                proxy,
                old_implementation,
                new_implementation,
            } if *id == configurator_id => {
                configurator_updates.push((
                    event,
                    *proxy,
                    *old_implementation,
                    *new_implementation,
                ));
            }
            Kind::PoolUpdated { old, new } => pool_updates.push((event, *old, *new)),
            Kind::PoolConfiguratorUpdated { old, new } => {
                configurator_updates.push((event, None, *old, *new));
            }
            Kind::ProxyCreated { .. }
            | Kind::AddressSet { .. }
            | Kind::AddressSetAsProxy { .. } => {
                other_id_event_count += 1;
            }
        }
    }

    // Pool: exactly one proxy, created at its earliest-code block, whose
    // implementation chain ends at the exact-anchor EIP-1967 implementation.
    let [(pool_creation, pool_proxy, pool_initial)] = pool_creations.as_slice() else {
        return Err(ChainError::Evidence(format!(
            "expected exactly one ProxyCreated(POOL), got {}",
            pool_creations.len()
        )));
    };
    if *pool_proxy != expected.pool || pool_creation.coordinate.0 != expected.pool_creation_block {
        return Err(ChainError::Evidence(
            "ProxyCreated(POOL) differs from the Pool or its earliest-code block".into(),
        ));
    }
    let pool_implementation_updates = implementation_chain(
        "Pool",
        pool_creation,
        *pool_initial,
        &pool_updates,
        expected.pool_implementation,
    )?;

    // PoolConfigurator: the proxy created by the provider, then any explicit
    // AddressSet replacement, each valid until the next.
    let [(configurator_creation, configurator_proxy, configurator_initial)] =
        configurator_creations.as_slice()
    else {
        return Err(ChainError::Evidence(format!(
            "expected exactly one ProxyCreated(POOL_CONFIGURATOR), got {}",
            configurator_creations.len()
        )));
    };
    let mut windows = vec![ConfiguratorWindow {
        address: *configurator_proxy,
        from: configurator_creation.coordinate,
        until: None,
    }];
    for (event, old, new) in &replacements {
        if event.coordinate < configurator_creation.coordinate {
            return Err(ChainError::Evidence(
                "AddressSet(POOL_CONFIGURATOR) precedes the configurator proxy".into(),
            ));
        }
        let current = windows
            .last_mut()
            .ok_or_else(|| ChainError::Evidence("configurator windows are empty".into()))?;
        if *old != Some(current.address) {
            return Err(ChainError::Evidence(
                "AddressSet(POOL_CONFIGURATOR) does not replace the current configurator".into(),
            ));
        }
        current.until = Some(event.coordinate);
        let new = new.ok_or_else(|| {
            ChainError::Evidence("AddressSet(POOL_CONFIGURATOR) cleared the configurator".into())
        })?;
        windows.push(ConfiguratorWindow {
            address: new,
            from: event.coordinate,
            until: None,
        });
    }
    let current_window = windows
        .last()
        .ok_or_else(|| ChainError::Evidence("configurator windows are empty".into()))?;
    if current_window.address != expected.configurator {
        return Err(ChainError::Evidence(
            "the configurator lineage does not end at the exact-anchor PoolConfigurator".into(),
        ));
    }
    if expected.configurator == *configurator_proxy
        && configurator_creation.coordinate.0 != expected.configurator_creation_block
    {
        return Err(ChainError::Evidence(
            "ProxyCreated(POOL_CONFIGURATOR) differs from its earliest-code block".into(),
        ));
    }
    let proxy_updates: Vec<(&Event, Option<Address>, Address)> = configurator_updates
        .iter()
        .map(|(event, proxy, old, new)| {
            if proxy.is_some_and(|proxy| proxy != *configurator_proxy) {
                return Err(ChainError::Evidence(
                    "AddressSetAsProxy(POOL_CONFIGURATOR) names another proxy".into(),
                ));
            }
            Ok((*event, *old, *new))
        })
        .collect::<Result<_, ChainError>>()?;
    let final_configurator_implementation = if expected.configurator == *configurator_proxy {
        expected.configurator_implementation
    } else {
        // The proxy was replaced; its own chain must still be continuous.
        proxy_updates
            .last()
            .map_or(*configurator_initial, |(_, _, new)| *new)
    };
    let configurator_implementation_updates = implementation_chain(
        "PoolConfigurator",
        configurator_creation,
        *configurator_initial,
        &proxy_updates,
        final_configurator_implementation,
    )?;

    Ok(Lineage {
        configurators: windows,
        pool_proxy_creation: pool_creation.json(),
        configurator_proxy_creation: configurator_creation.json(),
        pool_implementation_updates,
        configurator_implementation_updates,
        configurator_replacements: replacements
            .iter()
            .map(|(event, _, _)| event.json())
            .collect(),
        other_id_event_count,
        zero_topic_log_count: 0,
        log_count: 0,
        manifests: Vec::new(),
        scan_evidence: Vec::new(),
    })
}
