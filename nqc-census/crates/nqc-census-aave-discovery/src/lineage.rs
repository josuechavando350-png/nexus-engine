use crate::aave_interface;
use nqc_census_chain::{
    acquire::Acquisition,
    consensus::{agree, ProviderResult},
    hex,
    job::{JobContext, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    rpc::RpcCall,
    ChainError,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};

const LINEAGE_NAMESPACE: u16 = 0x0604;
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
            (
                "implementation",
                Json::string(self.implementation.to_hex()),
            ),
        ])
    }
}

#[derive(Debug, Clone)]
pub struct ConfiguratorLineage {
    pub configurators: Vec<Address>,
    pub updates: Vec<Json>,
    pub manifests: Vec<String>,
}

fn quantity(value: &Json, key: &str) -> Result<u64, ChainError> {
    hex::decode_quantity_u64(value.str_field(key)?)
}

fn indexed_address(text: &str, label: &'static str) -> Result<Address, ChainError> {
    let word = hex::decode_fixed::<32>(text)?;
    if word[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "{label} has non-canonical indexed-address padding"
        )));
    }
    if word[12..].iter().all(|byte| *byte == 0) {
        return Err(ChainError::Evidence(format!("{label} is zero")));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&word[12..]);
    Ok(Address::new(address)?)
}

fn parse_creation(
    ctx: &mut JobContext<'_>,
    root: Address,
    expected_topic: &str,
    item: &Json,
    first: u64,
    last: u64,
) -> Result<ProxyCreation, ChainError> {
    if Address::parse_hex(item.str_field("address")?)? != root {
        return Err(ChainError::Evidence(
            "ProxyCreated emitter differs from AddressesProvider".into(),
        ));
    }
    if item.get("removed").and_then(Json::as_bool) != Some(false) {
        return Err(ChainError::Evidence(
            "removed or malformed ProxyCreated log".into(),
        ));
    }
    if item.str_field("data")? != "0x" {
        return Err(ChainError::Evidence(
            "ProxyCreated has non-empty data".into(),
        ));
    }
    let topics = item
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("ProxyCreated topics missing".into()))?;
    if topics.len() != 4
        || topics[0].as_str() != Some(expected_topic)
        || topics[1].as_str() != Some(POOL_CONFIGURATOR_ID)
    {
        return Err(ChainError::Evidence(
            "PoolConfigurator ProxyCreated topic layout differs".into(),
        ));
    }
    let proxy = indexed_address(
        topics[2]
            .as_str()
            .ok_or_else(|| ChainError::Evidence("ProxyCreated proxy topic is not hex".into()))?,
        "PoolConfigurator proxy",
    )?;
    let implementation = indexed_address(
        topics[3].as_str().ok_or_else(|| {
            ChainError::Evidence("ProxyCreated implementation topic is not hex".into())
        })?,
        "PoolConfigurator initial implementation",
    )?;
    let block = quantity(item, "blockNumber")?;
    if block < first || block > last {
        return Err(ChainError::Evidence(
            "PoolConfigurator ProxyCreated lies outside requested range".into(),
        ));
    }
    let block_hash = Hash32::parse_hex(item.str_field("blockHash")?)?;
    let header = ctx.header_by_number(block)?;
    if header.envelope().anchor().block_hash() != block_hash {
        return Err(ChainError::NonCanonical {
            what: "PoolConfigurator ProxyCreated",
            detail: format!("block {block} hash differs from canonical header"),
        });
    }
    Ok(ProxyCreation {
        block,
        transaction_index: quantity(item, "transactionIndex")?,
        log_index: quantity(item, "logIndex")?,
        block_hash,
        transaction_hash: Hash32::parse_hex(item.str_field("transactionHash")?)?,
        proxy,
        implementation,
    })
}

fn lineage_body(
    ctx: &mut JobContext<'_>,
    provider: &ProviderSpec,
    root: Address,
    first: u64,
    last: u64,
) -> Result<Json, ChainError> {
    let topic = hex::encode(&aave_interface().proxy_created_topic);
    let mut creations = Vec::new();
    let mut start = first;
    loop {
        let end = start
            .saturating_add(provider.log_window().saturating_sub(1))
            .min(last);
        let result = ctx.raw_result(&RpcCall::new(
            "eth_getLogs",
            Json::array([Json::object([
                ("fromBlock", Json::string(hex::quantity(start))),
                ("toBlock", Json::string(hex::quantity(end))),
                ("address", Json::string(root.to_hex())),
                (
                    "topics",
                    Json::array([
                        Json::string(topic.clone()),
                        Json::string(POOL_CONFIGURATOR_ID),
                    ]),
                ),
            ])]),
        ))?;
        for item in result.as_array().ok_or(ChainError::Rpc(
            "PoolConfigurator ProxyCreated logs result is not an array",
        ))? {
            creations.push(parse_creation(ctx, root, &topic, item, start, end)?);
        }
        if end == last {
            break;
        }
        start = end + 1;
    }
    creations.sort_by_key(|event| (event.block, event.transaction_index, event.log_index));
    if creations.windows(2).any(|pair| {
        (pair[0].block, pair[0].log_index) == (pair[1].block, pair[1].log_index)
    }) {
        return Err(ChainError::Evidence(
            "duplicate PoolConfigurator ProxyCreated coordinates".into(),
        ));
    }
    Ok(Json::object([
        ("range", Json::array([Json::uint(first), Json::uint(last)])),
        (
            "proxy_creations",
            Json::array(creations.iter().map(ProxyCreation::json)),
        ),
    ]))
}

fn provider_lineage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    chain: &ChainDomain,
    root: Address,
    origin: &StateAnchor,
    last: u64,
) -> Result<ProviderResult, ChainError> {
    let spec = JobSpec::new(
        "rmc006-aave-configurator-proxy-lineage",
        1,
        LINEAGE_NAMESPACE,
        Json::object([
            ("addresses_provider", Json::string(root.to_hex())),
            ("first", Json::uint(origin.block_number())),
            ("last", Json::uint(last)),
            (
                "topic0",
                Json::string(hex::encode(&aave_interface().proxy_created_topic)),
            ),
            (
                "pool_configurator_id",
                Json::string(POOL_CONFIGURATOR_ID),
            ),
        ]),
    )?;
    let output = acquisition.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
        lineage_body(ctx, provider, root, origin.block_number(), last)
    })?;
    Ok(ProviderResult {
        provider: provider.label().to_owned(),
        manifest: output.manifest_id().to_hex(),
        result: output.result_json()?,
    })
}

pub fn discover_configurator_lineage(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    chain: &ChainDomain,
    root: Address,
    origin: &StateAnchor,
    observation: &StateAnchor,
    expected_current: Address,
) -> Result<ConfiguratorLineage, ChainError> {
    let mut results = Vec::new();
    for provider in providers.iter() {
        results.push(provider_lineage(
            acquisition,
            provider,
            chain,
            root,
            origin,
            observation.block_number(),
        )?);
    }
    let agreement = agree("rmc006-aave-configurator-proxy-lineage", &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let creations = agreement
        .result
        .get("proxy_creations")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("agreed ProxyCreated evidence missing".into()))?;
    if creations.len() != 1 {
        return Err(ChainError::Evidence(format!(
            "expected exactly one PoolConfigurator ProxyCreated event, got {}",
            creations.len()
        )));
    }
    let creation = &creations[0];
    let proxy = Address::parse_hex(creation.str_field("proxy")?)?;
    if proxy != expected_current {
        return Err(ChainError::Evidence(
            "PoolConfigurator ProxyCreated proxy differs from exact-anchor getter".into(),
        ));
    }

    Ok(ConfiguratorLineage {
        configurators: vec![proxy],
        updates: creations.to_vec(),
        manifests: agreement.manifests,
    })
}
