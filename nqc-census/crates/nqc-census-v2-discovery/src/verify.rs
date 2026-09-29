//! Offline verification and reconciliation of RMC-007.
//!
//! Every stage record is replayed from the merged RMC-004 store through a
//! replay transport built only from the manifests the record names, and must
//! reproduce byte-for-byte. Only replayed data is reconciled:
//!
//! - surface A (`allPairs`) and surface C (pair `token0/token1`, factory
//!   `getPair`) must be byte-identical across both point providers for every
//!   index;
//! - surface B (`PairCreated`) must be identical across both log providers;
//! - A, B and C must then describe the same pairs, in the same order, with no
//!   duplicate pair or token tuple, and ordinals exactly `1..=allPairsLength`.

use crate::stage::{
    index_partition, pair_created_stage, pairs_stage, stage_data_sha256, V2Plan, STAGE_SCHEMA,
};
use crate::{
    admission, decode_pair_created, reconcile, CurrentPair, DirectLookupProof, PairCreatedProof,
    Reconciliation, RuntimeCallProof,
};
use nqc_census_chain::{
    acquire::Acquisition,
    consensus::agree_logs,
    job::add_manifest_exchanges,
    json::Json,
    provider::ProviderSpec,
    transport::{ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{Address, EvidenceRef, Hash32, LogTopic, RawLogEnvelope};
use nqc_census_store::{ArtifactId, Store};
use std::collections::{BTreeMap, BTreeSet};

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn manifests(record: &Json) -> Result<Vec<ArtifactId>, ChainError> {
    record
        .get("manifests")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("record lists no manifests".into()))?
        .iter()
        .map(|id| {
            Ok(ArtifactId::parse_hex(id.as_str().ok_or_else(|| {
                ChainError::Evidence("manifest id is not text".into())
            })?)?)
        })
        .collect()
}

fn owner<'a>(providers: &'a [ProviderSpec], record: &Json) -> Result<&'a ProviderSpec, ChainError> {
    let descriptor = record
        .get("provider")
        .ok_or_else(|| ChainError::Evidence("record names no provider".into()))?;
    for provider in providers {
        if provider.descriptor().same_as(descriptor)? {
            return Ok(provider);
        }
    }
    Err(ChainError::Evidence(
        "record provider is not a declared provider".into(),
    ))
}

/// Replays one stage record and returns its verified data.
pub fn replay_stage(
    store: &Store,
    providers: &[ProviderSpec],
    plan: &V2Plan,
    record: &Json,
) -> Result<Vec<Json>, ChainError> {
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-007 stage record".into()));
    }
    let provider = owner(providers, record)?;
    let mut replay = ReplayTransport::new();
    for id in manifests(record)? {
        add_manifest_exchanges(&mut replay, store, &store.get_artifact(&id)?, provider)?;
    }
    let acquisition = Acquisition::new(store, &replay, RetryPolicy::none());
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("record without parameters".into()))?;
    let (replayed, rows) = match record.str_field("stage")? {
        "PAIR_CREATED" => pair_created_stage(
            &acquisition,
            provider,
            plan,
            number(parameters, "first_block")?,
            number(parameters, "last_block")?,
        )?,
        "PAIRS" => pairs_stage(
            &acquisition,
            provider,
            plan,
            number(parameters, "pair_count")?,
            number(parameters, "partition")?,
            number(parameters, "partitions")?,
        )?,
        other => return Err(ChainError::Evidence(format!("unknown stage {other}"))),
    };
    if !replayed.same_as(record)? {
        return Err(ChainError::Evidence(format!(
            "stage record of {} does not reproduce from its evidence",
            provider.label()
        )));
    }
    if stage_data_sha256(&rows)? != record.str_field("data_sha256")? {
        return Err(ChainError::Evidence("stage data digest differs".into()));
    }
    Ok(rows)
}

fn optional_address(row: &Json, key: &str) -> Result<Option<Address>, ChainError> {
    match row.get(key) {
        Some(Json::Null) => Ok(None),
        Some(Json::String(text)) => Ok(Some(Address::parse_hex(text)?)),
        _ => Err(ChainError::Evidence(format!("{key} is not address/null"))),
    }
}

fn raw_log(value: &Json) -> Result<RawLogEnvelope, ChainError> {
    let topics = value
        .get("topics")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("log topics missing".into()))?
        .iter()
        .map(|topic| {
            topic
                .as_str()
                .ok_or_else(|| ChainError::Evidence("topic is not text".into()))
                .and_then(|text| LogTopic::parse_hex(text).map_err(ChainError::from))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let small = |key: &str| {
        u32::try_from(number(value, key)?)
            .map_err(|_| ChainError::Evidence(format!("{key} exceeds u32")))
    };
    Ok(RawLogEnvelope::with_topics(
        Address::parse_hex(value.str_field("emitter")?)?,
        Hash32::parse_hex(value.str_field("transaction_hash")?)?,
        small("transaction_index")?,
        small("log_index")?,
        topics,
        nqc_census_chain::hex::decode_data(value.str_field("data")?)?,
        false,
    )?)
}

/// Evidence of one index: the `PAIRS` job manifest that read it, per
/// provider. Stage manifests are `[bootstrap, anchor, job...]`, and jobs
/// cover `job_size` indices from the partition's first index.
fn pair_job_evidence(record: &Json) -> Result<Vec<(u64, u64, EvidenceRef)>, ChainError> {
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("parameters".into()))?;
    let ids = manifests(record)?;
    let job_size = number(parameters, "job_size")?;
    let mut out = Vec::new();
    if let Some((first, last)) = index_partition(
        number(parameters, "pair_count")?,
        number(parameters, "partition")?,
        number(parameters, "partitions")?,
    )? {
        let mut start = first;
        let mut job = 2_usize;
        while start <= last {
            let end = start.saturating_add(job_size - 1).min(last);
            let id = ids
                .get(job)
                .ok_or_else(|| ChainError::Evidence("PAIRS record lacks a job manifest".into()))?;
            out.push((start, end, id.evidence_ref()?));
            start = end + 1;
            job += 1;
        }
        if job != ids.len() {
            return Err(ChainError::Evidence(
                "PAIRS record has unexpected manifests".into(),
            ));
        }
    }
    Ok(out)
}

/// Evidence of one block: the `PAIR_CREATED` window manifest covering it.
/// Stage manifests are `[bootstrap, anchor, origin, window...]`.
fn log_window_evidence(record: &Json) -> Result<Vec<(u64, u64, EvidenceRef)>, ChainError> {
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("parameters".into()))?;
    let ids = manifests(record)?;
    let span = number(parameters, "log_span")?;
    let last = number(parameters, "last_block")?;
    let mut start = number(parameters, "first_block")?;
    let mut window = 3_usize;
    let mut out = Vec::new();
    while start <= last {
        let end = start.saturating_add(span - 1).min(last);
        let id = ids.get(window).ok_or_else(|| {
            ChainError::Evidence("PAIR_CREATED record lacks a window manifest".into())
        })?;
        out.push((start, end, id.evidence_ref()?));
        start = end + 1;
        window += 1;
    }
    if window != ids.len() {
        return Err(ChainError::Evidence(
            "PAIR_CREATED record has unexpected manifests".into(),
        ));
    }
    Ok(out)
}

fn covering(
    ranges: &[Vec<(u64, u64, EvidenceRef)>],
    key: u64,
) -> Result<Vec<EvidenceRef>, ChainError> {
    let mut out = Vec::with_capacity(ranges.len());
    for provider in ranges {
        let position = provider.partition_point(|(_, end, _)| *end < key);
        match provider.get(position) {
            Some((start, end, reference)) if *start <= key && key <= *end => out.push(*reference),
            _ => return Err(ChainError::Evidence(format!("no evidence covers {key}"))),
        }
    }
    out.sort_unstable();
    out.dedup();
    Ok(out)
}

/// Reconciliation inputs derived from agreed, replayed data.
pub struct Surfaces {
    pub pair_count: u64,
    pub current: Vec<CurrentPair>,
    pub events: Vec<PairCreatedProof>,
    pub lookups: Vec<DirectLookupProof>,
    pub runtime: Vec<RuntimeCallProof>,
    pub findings: Vec<Json>,
    pub agreement: Json,
}

fn finding(class: &str, detail: Vec<(&str, Json)>) -> Json {
    let mut members = vec![
        ("class", Json::string(class)),
        ("status", Json::string("UNEXPLAINED")),
    ];
    members.extend(detail);
    Json::object(members)
}

/// Agrees and decodes the replayed stages of both provider classes.
#[allow(clippy::too_many_lines)]
pub fn surfaces(
    plan: &V2Plan,
    pair_count: u64,
    first_block: u64,
    stages: &[(Json, Vec<Json>)],
) -> Result<Surfaces, ChainError> {
    let label = |record: &Json| -> Result<String, ChainError> {
        Ok(record
            .get("provider")
            .ok_or_else(|| ChainError::Evidence("record without provider".into()))?
            .str_field("label")?
            .to_owned())
    };
    // Surface B: per log provider, block partitions that tile
    // [factory boundary, anchor] and link by parent hash; then the two
    // providers' complete log sets are agreed exactly.
    let mut partitions_b: BTreeMap<String, Vec<(&Json, &Vec<Json>)>> = BTreeMap::new();
    let mut log_ranges = Vec::new();
    for (record, rows) in stages {
        if record.str_field("stage")? == "PAIR_CREATED" {
            partitions_b
                .entry(label(record)?)
                .or_default()
                .push((record, rows));
        }
    }
    let mut logs = Vec::new();
    for (provider, mut parts) in partitions_b {
        parts.sort_by_key(|(record, _)| {
            record
                .get("parameters")
                .and_then(|parameters| parameters.get("first_block"))
                .and_then(Json::as_i64)
                .unwrap_or(i64::MAX)
        });
        let mut expected_first = first_block;
        let mut previous_hash: Option<String> = None;
        let mut provider_logs = Vec::new();
        let mut provider_ranges = Vec::new();
        for (record, rows) in parts {
            let parameters = record
                .get("parameters")
                .ok_or_else(|| ChainError::Evidence("parameters".into()))?;
            if number(parameters, "first_block")? != expected_first {
                return Err(ChainError::Evidence(format!(
                    "{provider} PairCreated partitions leave a gap or overlap at {expected_first}"
                )));
            }
            let first_anchor = parameters
                .get("first_anchor")
                .ok_or_else(|| ChainError::Evidence("first anchor".into()))?;
            if let Some(previous) = &previous_hash {
                if first_anchor.str_field("parent_hash")? != previous {
                    return Err(ChainError::Evidence(format!(
                        "{provider} PairCreated partition at {expected_first} does not extend its predecessor"
                    )));
                }
            }
            previous_hash = Some(
                parameters
                    .get("last_anchor")
                    .ok_or_else(|| ChainError::Evidence("last anchor".into()))?
                    .str_field("hash")?
                    .to_owned(),
            );
            expected_first = number(parameters, "last_block")? + 1;
            provider_logs.extend(rows.iter().cloned());
            provider_ranges.extend(log_window_evidence(record)?);
        }
        if expected_first != plan.anchor_number + 1 {
            return Err(ChainError::Evidence(format!(
                "{provider} PairCreated partitions do not reach the observation anchor"
            )));
        }
        log_ranges.push(provider_ranges);
        logs.push((provider, provider_logs));
    }
    let providers_b: BTreeSet<&String> = logs.iter().map(|(label, _)| label).collect();
    if logs.len() < 2 {
        return Err(ChainError::Evidence(
            "surface B needs complete scans from two providers".into(),
        ));
    }
    let agreed_logs = agree_logs("rmc007-v2-pair-created", &logs)?
        .map_err(|mismatch| ChainError::Consensus(mismatch.reason))?;

    // Surfaces A and C: complete, identical index coverage per point provider.
    let mut by_provider: BTreeMap<String, BTreeMap<u64, Json>> = BTreeMap::new();
    let mut job_ranges: BTreeMap<String, Vec<(u64, u64, EvidenceRef)>> = BTreeMap::new();
    let mut partitions_seen: BTreeMap<String, (u64, BTreeSet<u64>)> = BTreeMap::new();
    for (record, rows) in stages {
        if record.str_field("stage")? != "PAIRS" {
            continue;
        }
        let parameters = record
            .get("parameters")
            .ok_or_else(|| ChainError::Evidence("parameters".into()))?;
        if number(parameters, "pair_count")? != pair_count {
            return Err(ChainError::Evidence(
                "PAIRS stage used another pair count".into(),
            ));
        }
        let provider = label(record)?;
        job_ranges
            .entry(provider.clone())
            .or_default()
            .extend(pair_job_evidence(record)?);
        let partitions = number(parameters, "partitions")?;
        let entry = partitions_seen
            .entry(provider.clone())
            .or_insert((partitions, BTreeSet::new()));
        if entry.0 != partitions || !entry.1.insert(number(parameters, "partition")?) {
            return Err(ChainError::Evidence(
                "inconsistent or duplicate PAIRS partition".into(),
            ));
        }
        let table = by_provider.entry(provider).or_default();
        for row in rows {
            if table.insert(number(row, "index")?, row.clone()).is_some() {
                return Err(ChainError::Evidence("duplicate enumeration index".into()));
            }
        }
    }
    if by_provider.len() < 2 {
        return Err(ChainError::Evidence(
            "surfaces A and C need two point providers".into(),
        ));
    }
    for (provider, (partitions, seen)) in &partitions_seen {
        if seen.len() as u64 != *partitions {
            return Err(ChainError::Evidence(format!(
                "{provider} is missing PAIRS partitions"
            )));
        }
    }
    let tables: Vec<&BTreeMap<u64, Json>> = by_provider.values().collect();
    for table in &tables {
        if table.len() as u64 != pair_count || table.keys().copied().ne(0..pair_count) {
            return Err(ChainError::Evidence(
                "PAIRS rows do not cover 0..allPairsLength".into(),
            ));
        }
    }
    let mut provider_mismatches = 0_u64;
    for index in 0..pair_count {
        let first = &tables[0][&index];
        for table in &tables[1..] {
            if !table[&index].same_as(first)? {
                provider_mismatches += 1;
            }
        }
    }
    if provider_mismatches != 0 {
        return Err(ChainError::Consensus(
            "point providers disagree on PAIRS rows",
        ));
    }

    let mut findings = Vec::new();
    let rows = tables[0];
    let job_ranges: Vec<Vec<(u64, u64, EvidenceRef)>> = job_ranges
        .into_values()
        .map(|mut ranges| {
            ranges.sort_unstable_by_key(|(start, _, _)| *start);
            ranges
        })
        .collect();
    for ranges in &mut log_ranges {
        ranges.sort_unstable_by_key(|(start, _, _)| *start);
    }
    let mut current = Vec::new();
    let mut lookups = Vec::new();
    let mut runtime = Vec::new();
    for (index, row) in rows {
        let pair = optional_address(row, "pair")?;
        let token0 = optional_address(row, "token0")?;
        let token1 = optional_address(row, "token1")?;
        let get_pair = optional_address(row, "get_pair")?;
        let pair_evidence = covering(&job_ranges, *index)?;
        let Some(pair) = pair else {
            findings.push(finding(
                "ENUMERATION_ZERO_PAIR",
                vec![("index", Json::uint(*index))],
            ));
            continue;
        };
        let (Some(token0), Some(token1)) = (token0, token1) else {
            findings.push(finding(
                "RUNTIME_MISSING",
                vec![
                    ("index", Json::uint(*index)),
                    ("pair", Json::string(pair.to_hex())),
                ],
            ));
            continue;
        };
        current.push(CurrentPair {
            index: *index,
            pair,
            token0,
            token1,
            evidence: pair_evidence.clone(),
        });
        runtime.push(RuntimeCallProof {
            pair,
            token0,
            token1,
            evidence: pair_evidence.clone(),
        });
        match get_pair {
            Some(returned_pair) => lookups.push(DirectLookupProof {
                token0,
                token1,
                returned_pair,
                evidence: pair_evidence.clone(),
            }),
            None => findings.push(finding(
                "DIRECT_LOOKUP_ZERO",
                vec![
                    ("index", Json::uint(*index)),
                    ("pair", Json::string(pair.to_hex())),
                ],
            )),
        }
    }

    let mut events = Vec::with_capacity(agreed_logs.len());
    let mut ordinals = BTreeSet::new();
    let mut event_pairs = BTreeSet::new();
    let mut event_tokens = BTreeSet::new();
    for log in &agreed_logs {
        let raw = raw_log(log)?;
        let decoded = decode_pair_created(plan.factory, &raw)
            .map_err(|error| ChainError::Evidence(error.to_string()))?;
        if !ordinals.insert(decoded.ordinal) {
            findings.push(finding(
                "DUPLICATE_ORDINAL",
                vec![("ordinal", Json::uint(decoded.ordinal))],
            ));
        }
        if !event_pairs.insert(decoded.pair) {
            findings.push(finding(
                "DUPLICATE_PAIR",
                vec![("pair", Json::string(decoded.pair.to_hex()))],
            ));
        }
        if !event_tokens.insert((decoded.token0, decoded.token1)) {
            findings.push(finding(
                "DUPLICATE_TOKEN_TUPLE",
                vec![("pair", Json::string(decoded.pair.to_hex()))],
            ));
        }
        events.push(PairCreatedProof {
            block_number: number(log, "block")?,
            block_hash: Hash32::parse_hex(log.str_field("block_hash")?)?,
            transaction_hash: raw.transaction_hash(),
            transaction_index: raw.transaction_index(),
            log_index: raw.log_index(),
            pair: decoded.pair,
            token0: decoded.token0,
            token1: decoded.token1,
            ordinal: decoded.ordinal,
            evidence: covering(&log_ranges, number(log, "block")?)?,
        });
    }
    if ordinals.iter().copied().ne(1..=pair_count) {
        findings.push(finding(
            "ORDINALS_NOT_CONTIGUOUS",
            vec![
                ("event_count", Json::uint(events.len() as u64)),
                ("pair_count", Json::uint(pair_count)),
            ],
        ));
    }
    // Ordinals must also follow canonical log order.
    let mut previous = 0_u64;
    for event in &events {
        if event.ordinal <= previous {
            findings.push(finding(
                "ORDINAL_ORDER",
                vec![("ordinal", Json::uint(event.ordinal))],
            ));
        }
        previous = event.ordinal;
    }
    let agreement = Json::object([
        (
            "surface_b_providers",
            Json::array(
                providers_b
                    .iter()
                    .map(|label| Json::string((*label).clone())),
            ),
        ),
        ("surface_b_log_count", Json::uint(agreed_logs.len() as u64)),
        (
            "surface_ac_providers",
            Json::array(by_provider.keys().map(|label| Json::string(label.clone()))),
        ),
        ("surface_ac_index_count", Json::uint(pair_count)),
        ("provider_mismatch_count", Json::uint(provider_mismatches)),
    ]);
    Ok(Surfaces {
        pair_count,
        current,
        events,
        lookups,
        runtime,
        findings,
        agreement,
    })
}

/// Reconciles agreed surfaces under the D05 admission record.
pub fn reconcile_surfaces(
    record: &nqc_census_core::AdmissionRecord,
    surfaces: Surfaces,
) -> Result<(Reconciliation, Vec<Json>), ChainError> {
    let reconciliation = reconcile(
        record,
        surfaces.current,
        surfaces.events,
        surfaces.lookups,
        surfaces.runtime,
    )
    .map_err(|error| ChainError::Evidence(error.to_string()))?;
    Ok((reconciliation, surfaces.findings))
}

/// Evidence references of every replayed manifest, grouped by stage.
pub fn stage_evidence(records: &[Json]) -> Result<BTreeMap<String, Vec<EvidenceRef>>, ChainError> {
    let mut out: BTreeMap<String, Vec<EvidenceRef>> = BTreeMap::new();
    for record in records {
        let entry = out
            .entry(record.str_field("stage")?.to_owned())
            .or_default();
        for id in manifests(record)? {
            entry.push(id.evidence_ref()?);
        }
    }
    for refs in out.values_mut() {
        refs.sort_unstable();
        refs.dedup();
    }
    Ok(out)
}

pub use admission::admit;
