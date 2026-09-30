//! Partitioned, single-provider acquisition stages of RMC-007.
//!
//! Each stage runs on one provider and one partition, so the full factory
//! can be acquired in parallel CI jobs. A stage returns a small record that
//! names every job manifest and digests its data, plus the data itself. The
//! offline reconciler re-runs every stage from the merged RMC-004 store and
//! requires the replayed record to be byte-identical before using the data.
//!
//! - `PAIR_CREATED`: the factory's `PairCreated` logs from its earliest-code
//!   block to the observation anchor, window-checkpointed.
//! - `PAIRS`: for an index partition, `allPairs(i)` (surface A), then the
//!   pair's own `token0()`/`token1()` (runtime presence and identity) and the
//!   factory's `getPair(token0, token1)` (surface C), at the anchor.

use crate::factory_interface;
use nqc_census_chain::{
    abi,
    acquire::{anchor_from_result, anchor_record, raw_log_semantics, Acquisition},
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec, LogFilter},
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_core::{Address, CallOutcome, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

pub const STAGE_SCHEMA: &str = "nqc-rmc-007-v2-stage-record-v1";
const PAIR_CREATED_NAMESPACE: u16 = 0x0703;
const PAIRS_NAMESPACE: u16 = 0x0706;
pub const PAIR_CREATED_FAMILY: &str = "rmc007-v2-pair-created";
const PAIRS_FAMILY: &str = "rmc007-v2-pair-surfaces";

/// Everything the acquisition is bound to.
#[derive(Debug, Clone)]
pub struct V2Plan {
    pub profile: ChainProfile,
    pub anchor_number: u64,
    pub anchor_hash: Hash32,
    pub factory: Address,
    /// Blocks per PairCreated checkpoint window.
    pub log_span: u64,
    /// Indices per `PAIRS` point job (the resume granularity).
    pub job_size: u64,
}

impl V2Plan {
    pub fn mainnet() -> Result<Self, ChainError> {
        Ok(Self {
            profile: ChainProfile::mainnet()?,
            anchor_number: 25_437_474,
            anchor_hash: Hash32::parse_hex(
                "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8",
            )?,
            factory: Address::parse_hex("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f")?,
            log_span: 250_000,
            job_size: 10_000,
        })
    }
}

/// Deterministic partition `k` of `0..count` into `partitions` contiguous
/// ranges; returns the inclusive index bounds, or `None` for an empty part.
pub fn index_partition(
    count: u64,
    partition: u64,
    partitions: u64,
) -> Result<Option<(u64, u64)>, ChainError> {
    if partitions == 0 || partition >= partitions {
        return Err(ChainError::Config("invalid index partition".into()));
    }
    let size = count.div_ceil(partitions);
    let first = partition.saturating_mul(size);
    if first >= count {
        return Ok(None);
    }
    Ok(Some((first, (first + size).min(count) - 1)))
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn data_digest(rows: &[Json]) -> Result<String, ChainError> {
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC007-STAGE-DATA-V1");
    for row in rows {
        let bytes = row.canonical()?;
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
    }
    Ok(hex::plain(&digest.finalize()))
}

/// Chain domain and verified anchor from one provider (unanchored jobs).
fn stage_anchor(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &V2Plan,
) -> Result<(ChainDomain, StateAnchor, Vec<String>), ChainError> {
    let (facts, bootstrap) = acquisition.bootstrap(provider, &plan.profile)?;
    let (anchor, anchor_output) =
        acquisition.resolve_anchor(provider, &facts.chain, plan.anchor_number)?;
    if anchor.block_hash() != plan.anchor_hash {
        return Err(ChainError::Evidence(
            "provider anchor differs from the declared observation anchor".into(),
        ));
    }
    Ok((
        facts.chain,
        anchor,
        vec![
            bootstrap.manifest_id().to_hex(),
            anchor_output.manifest_id().to_hex(),
        ],
    ))
}

fn record(
    stage: &str,
    provider: &ProviderSpec,
    parameters: Json,
    manifests: &[String],
    rows: &[Json],
) -> Result<Json, ChainError> {
    Ok(Json::object([
        ("schema", Json::string(STAGE_SCHEMA)),
        ("stage", Json::string(stage)),
        ("provider", provider.descriptor()),
        ("parameters", parameters),
        (
            "manifests",
            Json::array(
                manifests
                    .iter()
                    .map(|manifest| Json::string(manifest.clone())),
            ),
        ),
        ("row_count", Json::uint(rows.len() as u64)),
        ("data_sha256", Json::string(data_digest(rows)?)),
    ]))
}

/// All `PairCreated` logs of the factory over the block partition
/// `[first_block, last_block]`. The record binds both boundary anchors so
/// partitions can be proven to tile the history and link by parent hash.
pub fn pair_created_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &V2Plan,
    first_block: u64,
    last_block: u64,
) -> Result<(Json, Vec<Json>), ChainError> {
    if first_block == 0 || first_block > last_block || last_block > plan.anchor_number {
        return Err(ChainError::Config(
            "invalid PairCreated scan partition".into(),
        ));
    }
    let (chain, _, mut manifests) = stage_anchor(acquisition, provider, plan)?;
    let (origin, origin_output) = acquisition.resolve_anchor(provider, &chain, first_block)?;
    manifests.push(origin_output.manifest_id().to_hex());
    let filter = LogFilter::new(
        vec![plan.factory],
        vec![factory_interface().pair_created_topic],
    )?;
    let outcome = acquisition.scan(
        provider,
        &chain,
        None,
        PAIR_CREATED_FAMILY,
        1,
        PAIR_CREATED_NAMESPACE,
        &filter,
        &origin,
        last_block,
        plan.log_span,
        |claimed| raw_log_semantics(&claimed.log.emitter(), PAIR_CREATED_FAMILY),
    )?;
    manifests.extend(
        outcome
            .windows
            .iter()
            .map(|window| window.manifest_id().to_hex()),
    );
    let logs = outcome.logs()?;
    let last_window = outcome
        .windows
        .last()
        .ok_or_else(|| ChainError::Evidence("PairCreated scan has no windows".into()))?
        .result_json()?;
    let last_anchor = anchor_from_result(&chain, &last_window, "last")?;
    let parameters = Json::object([
        ("factory", Json::string(plan.factory.to_hex())),
        ("first_block", Json::uint(first_block)),
        ("last_block", Json::uint(last_block)),
        ("first_anchor", anchor_record(&origin)),
        ("last_anchor", anchor_record(&last_anchor)),
        ("log_span", Json::uint(plan.log_span)),
        ("certified_first", Json::uint(outcome.certified_first)),
        ("certified_last", Json::uint(outcome.certified_last)),
        ("commitment", Json::string(outcome.commitment.clone())),
    ]);
    Ok((
        record("PAIR_CREATED", provider, parameters, &manifests, &logs)?,
        logs,
    ))
}

fn returned_address(outcome: &CallOutcome) -> Result<Option<Address>, ChainError> {
    match outcome {
        // An address without code answers an eth_call with empty data.
        CallOutcome::Returned(bytes) if bytes.is_empty() => Ok(None),
        CallOutcome::Returned(bytes) => match abi::decode_address(&abi::single_word(bytes)?)? {
            Some(raw) => Ok(Some(Address::new(raw)?)),
            None => Ok(None),
        },
        CallOutcome::Reverted(_) => Ok(None),
    }
}

fn optional(address: Option<Address>) -> Json {
    address.map_or(Json::Null, |address| Json::string(address.to_hex()))
}

/// Surfaces A and C for the index partition `partition` of `partitions`.
pub fn pairs_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    plan: &V2Plan,
    pair_count: u64,
    partition: u64,
    partitions: u64,
) -> Result<(Json, Vec<Json>), ChainError> {
    let (chain, anchor, mut manifests) = stage_anchor(acquisition, provider, plan)?;
    let interface = factory_interface();
    let mut rows = Vec::new();
    if let Some((first, last)) = index_partition(pair_count, partition, partitions)? {
        let mut start = first;
        while start <= last {
            let end = start.saturating_add(plan.job_size - 1).min(last);
            let spec = JobSpec::new(
                PAIRS_FAMILY,
                1,
                PAIRS_NAMESPACE,
                Json::object([
                    ("factory", Json::string(plan.factory.to_hex())),
                    ("first_index", Json::uint(start)),
                    ("last_index", Json::uint(end)),
                    ("anchor", Json::uint(plan.anchor_number)),
                ]),
            )?;
            let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
                let semantics = chain_read_semantics()?;
                let indices: Vec<u64> = (start..=end).collect();
                let enumerated = ctx.calls(
                    &indices
                        .iter()
                        .map(|index| {
                            (
                                plan.factory,
                                abi::encode_call(interface.all_pairs, &[abi::uint_word(*index)]),
                            )
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let pairs = enumerated
                    .iter()
                    .map(|call| returned_address(call.payload().outcome()))
                    .collect::<Result<Vec<_>, _>>()?;
                let present: Vec<Address> = pairs.iter().flatten().copied().collect();
                let token_calls = ctx.calls(
                    &present
                        .iter()
                        .flat_map(|pair| {
                            [
                                (*pair, abi::encode_call(interface.token0, &[])),
                                (*pair, abi::encode_call(interface.token1, &[])),
                            ]
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let tokens = token_calls
                    .chunks(2)
                    .map(|pair| {
                        Ok((
                            returned_address(pair[0].payload().outcome())?,
                            returned_address(pair[1].payload().outcome())?,
                        ))
                    })
                    .collect::<Result<Vec<_>, ChainError>>()?;
                let lookups: Vec<(Address, Address)> = tokens
                    .iter()
                    .filter_map(|(token0, token1)| token0.zip(*token1))
                    .collect();
                let lookup_calls = ctx.calls(
                    &lookups
                        .iter()
                        .map(|(token0, token1)| {
                            (
                                plan.factory,
                                abi::encode_call(
                                    interface.get_pair,
                                    &[
                                        abi::address_word(token0.as_bytes()),
                                        abi::address_word(token1.as_bytes()),
                                    ],
                                ),
                            )
                        })
                        .collect::<Vec<_>>(),
                    &anchor,
                    semantics,
                )?;
                let mut token_rows = tokens.iter();
                let mut lookup_rows = lookup_calls.iter();
                let mut out = Vec::with_capacity(indices.len());
                for (index, pair) in indices.iter().zip(&pairs) {
                    let (token0, token1, get_pair) = match pair {
                        Some(_) => {
                            let (token0, token1) = *token_rows.next().ok_or_else(|| {
                                ChainError::Evidence("token rows exhausted".into())
                            })?;
                            let get_pair = match (token0, token1) {
                                (Some(_), Some(_)) => returned_address(
                                    lookup_rows
                                        .next()
                                        .ok_or_else(|| {
                                            ChainError::Evidence("lookup rows exhausted".into())
                                        })?
                                        .payload()
                                        .outcome(),
                                )?,
                                _ => None,
                            };
                            (token0, token1, get_pair)
                        }
                        None => (None, None, None),
                    };
                    out.push(Json::object([
                        ("index", Json::uint(*index)),
                        ("pair", optional(*pair)),
                        ("token0", optional(token0)),
                        ("token1", optional(token1)),
                        ("get_pair", optional(get_pair)),
                    ]));
                }
                Ok(Json::object([
                    ("first_index", Json::uint(start)),
                    ("last_index", Json::uint(end)),
                    ("rows", Json::Array(out)),
                ]))
            })?;
            manifests.push(output.manifest_id().to_hex());
            rows.extend(
                output
                    .result_json()?
                    .get("rows")
                    .and_then(Json::as_array)
                    .ok_or_else(|| ChainError::Evidence("pairs job without rows".into()))?
                    .iter()
                    .cloned(),
            );
            start = end + 1;
        }
    }
    let parameters = Json::object([
        ("factory", Json::string(plan.factory.to_hex())),
        ("pair_count", Json::uint(pair_count)),
        ("partition", Json::uint(partition)),
        ("partitions", Json::uint(partitions)),
        ("job_size", Json::uint(plan.job_size)),
        ("anchor", Json::uint(plan.anchor_number)),
    ]);
    Ok((
        record("PAIRS", provider, parameters, &manifests, &rows)?,
        rows,
    ))
}

/// The digest bound into a stage record, recomputed from data.
pub fn stage_data_sha256(rows: &[Json]) -> Result<String, ChainError> {
    data_digest(rows)
}

/// sha256 of canonical bytes, for artifact manifests.
pub fn canonical_sha256(value: &Json) -> Result<String, ChainError> {
    Ok(sha256_hex(&value.canonical()?))
}
