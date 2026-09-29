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
use std::collections::BTreeSet;

const LINEAGE_NAMESPACE: u16 = 0x0604;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Update {
    block: u64,
    transaction_index: u64,
    log_index: u64,
    block_hash: Hash32,
    transaction_hash: Hash32,
    old: Option<Address>,
    new: Address,
}

impl Update {
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
    pub updates: Vec<Json>,
    pub manifests: Vec<String>,
}

fn quantity(value: &Json, key: &str) -> Result<u64, ChainError> {
    hex::decode_quantity_u64(value.str_field(key)?)
}

fn indexed_address(text: &str) -> Result<Option<Address>, ChainError> {
    let word = hex::decode_fixed::<32>(text)?;
    if word[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(
            "indexed configurator address has non-canonical padding".into(),
        ));
    }
    if word[12..].iter().all(|byte| *byte == 0) {
        return Ok(None);
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&word[12..]);
    Ok(Some(Address::new(address)?))
}

fn parse_update(
    ctx: &mut JobContext<'_>,
    root: Address,
    expected_topic: &str,
    item: &Json,
    first: u64,
    last: u64,
) -> Result<Update, ChainError> {
    if Address::parse_hex(item.str_field("address")?)? != root {
        return Err(ChainError::Evidence(
            "PoolConfiguratorUpdated emitter differs from AddressesProvider".into(),
        ));
    }
    if item.get("removed").and_then(Json::as_bool) != Some(false) {
        return Err(ChainError::Evidence(
            "removed or malformed PoolConfiguratorUpdated log".into(),
        ));
    }
    if item.str_field("data")? != "0x" {
        return Err(ChainError::Evidence(
            "PoolConfiguratorUpdated has non-empty data".into(),
        ));
    }
    let topics = item
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("configurator update topics missing".into()))?;
    if topics.len() != 3 || topics[0].as_str() != Some(expected_topic) {
        return Err(ChainError::Evidence(
            "PoolConfiguratorUpdated topic layout differs".into(),
        ));
    }
    let old = indexed_address(
        topics[1]
            .as_str()
            .ok_or_else(|| ChainError::Evidence("old configurator topic is not hex".into()))?,
    )?;
    let new = indexed_address(
        topics[2]
            .as_str()
            .ok_or_else(|| ChainError::Evidence("new configurator topic is not hex".into()))?,
    )?
    .ok_or_else(|| ChainError::Evidence("new configurator is zero".into()))?;
    let block = quantity(item, "blockNumber")?;
    if block < first || block > last {
        return Err(ChainError::Evidence(
            "configurator update lies outside requested range".into(),
        ));
    }
    let block_hash = Hash32::parse_hex(item.str_field("blockHash")?)?;
    let header = ctx.header_by_number(block)?;
    if header.envelope().anchor().block_hash() != block_hash {
        return Err(ChainError::NonCanonical {
            what: "PoolConfiguratorUpdated",
            detail: format!("block {block} hash differs from canonical header"),
        });
    }
    Ok(Update {
        block,
        transaction_index: quantity(item, "transactionIndex")?,
        log_index: quantity(item, "logIndex")?,
        block_hash,
        transaction_hash: Hash32::parse_hex(item.str_field("transactionHash")?)?,
        old,
        new,
    })
}

fn lineage_body(
    ctx: &mut JobContext<'_>,
    provider: &ProviderSpec,
    root: Address,
    first: u64,
    last: u64,
) -> Result<Json, ChainError> {
    let topic = hex::encode(&aave_interface().pool_configurator_updated_topic);
    let mut updates = Vec::new();
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
                    Json::array([Json::string(topic.clone())]),
                ),
            ])]),
        ))?;
        for item in result
            .as_array()
            .ok_or(ChainError::Rpc("configurator lineage logs result is not an array"))?
        {
            updates.push(parse_update(ctx, root, &topic, item, start, end)?);
        }
        if end == last {
            break;
        }
        start = end + 1;
    }
    updates.sort_by_key(|update| (update.block, update.transaction_index, update.log_index));
    if updates.windows(2).any(|pair| {
        (pair[0].block, pair[0].log_index) == (pair[1].block, pair[1].log_index)
    }) {
        return Err(ChainError::Evidence(
            "duplicate configurator update coordinates".into(),
        ));
    }
    Ok(Json::object([
        (
            "range",
            Json::array([Json::uint(first), Json::uint(last)]),
        ),
        (
            "updates",
            Json::array(updates.iter().map(Update::json)),
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
        "rmc006-aave-configurator-lineage",
        1,
        LINEAGE_NAMESPACE,
        Json::object([
            ("addresses_provider", Json::string(root.to_hex())),
            ("first", Json::uint(origin.block_number())),
            ("last", Json::uint(last)),
            (
                "topic0",
                Json::string(hex::encode(
                    &aave_interface().pool_configurator_updated_topic,
                )),
            ),
        ]),
    )?;
    let output = acquisition.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
        lineage_body(
            ctx,
            provider,
            root,
            origin.block_number(),
            last,
        )
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
    let agreement = agree("rmc006-aave-configurator-lineage", &results)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;
    let updates = agreement
        .result
        .get("updates")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("agreed configurator updates missing".into()))?;
    if updates.is_empty() {
        return Err(ChainError::Evidence(
            "AddressesProvider emitted no PoolConfiguratorUpdated event".into(),
        ));
    }

    let mut configurators = BTreeSet::new();
    let mut active = None;
    for (index, update) in updates.iter().enumerate() {
        let old = match update
            .get("old")
            .ok_or_else(|| ChainError::Evidence("configurator lineage old field missing".into()))?
        {
            Json::Null => None,
            Json::String(value) => Some(Address::parse_hex(value)?),
            _ => {
                return Err(ChainError::Evidence(
                    "configurator lineage old field has wrong type".into(),
                ))
            }
        };
        let new = Address::parse_hex(update.str_field("new")?)?;
        if index == 0 {
            if old.is_some() {
                return Err(ChainError::Evidence(
                    "first configurator update does not start from zero".into(),
                ));
            }
        } else if old != active {
            return Err(ChainError::Evidence(
                "configurator update chain has a broken predecessor".into(),
            ));
        }
        if let Some(old) = old {
            configurators.insert(old);
        }
        configurators.insert(new);
        active = Some(new);
    }
    if active != Some(expected_current) {
        return Err(ChainError::Evidence(
            "configurator lineage tip differs from exact-anchor getter".into(),
        ));
    }

    Ok(ConfiguratorLineage {
        configurators: configurators.into_iter().collect(),
        updates: updates.to_vec(),
        manifests: agreement.manifests,
    })
}
