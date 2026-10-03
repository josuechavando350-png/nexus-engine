//! Per-stage replay extract for RMC-010 BASE_CANONICALITY.
//!
//! Live CI keeps each stage store isolated. The replay job verifies the store,
//! replays the canonicality record with no network, and emits this compact
//! content-addressed extract. The reconciler verifies every digest and binds
//! the record to the declared base and target before using its rows.

use crate::base::BaseCensus;
use crate::canonical::replay_canonicality;
use crate::stage::{data_digest, STAGE_SCHEMA};
use nqc_census_chain::{json::Json, provider::ProviderSpec, ChainError};
use nqc_census_state::replay::owner;
use nqc_census_state::stage::{sha256_plain, AnchorPlan};
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::Store;
use std::collections::BTreeMap;

pub const EXTRACT_SCHEMA: &str = "nqc-rmc-010-canonicality-extract-v1";

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub fn stage_extract(
    store: &Store,
    providers: &[ProviderSpec],
    target: &AnchorPlan,
    base: &BaseCensus,
    record: &Json,
    store_summary: Json,
) -> Result<Json, ChainError> {
    let replayed = replay_canonicality(store, providers, target, base, record)?;
    Ok(Json::object([
        ("schema", Json::string(EXTRACT_SCHEMA)),
        (
            "record_sha256",
            Json::string(sha256_plain(&record.canonical()?)),
        ),
        ("record", record.clone()),
        ("store", store_summary),
        ("row_count", Json::uint(replayed.rows.len() as u64)),
        ("data_sha256", Json::string(data_digest(&replayed.rows)?)),
        ("rows", Json::Array(replayed.rows)),
    ]))
}

pub fn verify_extract(
    providers: &[ProviderSpec],
    target: &AnchorPlan,
    base: &BaseCensus,
    extract: Json,
) -> Result<(Json, ReplayedStage), ChainError> {
    let Json::Object(members) = extract else {
        return Err(ChainError::Evidence(
            "canonicality extract is not an object".into(),
        ));
    };
    let count = members.len();
    let mut fields: BTreeMap<String, Json> = members.into_iter().collect();
    if fields.len() != count {
        return Err(ChainError::Evidence(
            "canonicality extract repeats a field".into(),
        ));
    }
    if fields.get("schema").and_then(Json::as_str) != Some(EXTRACT_SCHEMA) {
        return Err(ChainError::Evidence(
            "not an RMC-010 canonicality extract".into(),
        ));
    }
    let record = fields
        .remove("record")
        .ok_or_else(|| ChainError::Evidence("canonicality extract without record".into()))?;
    let Some(Json::Array(rows)) = fields.remove("rows") else {
        return Err(ChainError::Evidence(
            "canonicality extract without rows".into(),
        ));
    };
    let remainder = Json::Object(fields.into_iter().collect());
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA)
        || record.str_field("stage")? != "BASE_CANONICALITY"
    {
        return Err(ChainError::Evidence(
            "canonicality extract record has the wrong schema or stage".into(),
        ));
    }
    let provider = owner(providers, &record)?;
    if sha256_plain(&record.canonical()?) != remainder.str_field("record_sha256")? {
        return Err(ChainError::Evidence(
            "canonicality extract record digest differs".into(),
        ));
    }
    if rows.len() != 1
        || number(&record, "row_count")? != 1
        || number(&remainder, "row_count")? != 1
    {
        return Err(ChainError::Evidence(
            "canonicality extract must contain exactly one row".into(),
        ));
    }
    let digest = data_digest(&rows)?;
    if digest != record.str_field("data_sha256")? || digest != remainder.str_field("data_sha256")? {
        return Err(ChainError::Evidence(
            "canonicality extract data digest differs".into(),
        ));
    }
    let root = remainder
        .get("store")
        .ok_or_else(|| ChainError::Evidence("canonicality extract without store".into()))?
        .str_field("evidence_root")?;
    if !hex64(root) {
        return Err(ChainError::Evidence(
            "canonicality store evidence root is not a digest".into(),
        ));
    }
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("canonicality record without parameters".into()))?;
    if number(parameters, "base_number")? != base.anchor_number
        || parameters.str_field("base_hash")? != base.anchor_hash.to_hex()
        || number(parameters, "target")? != target.number
        || parameters.str_field("target_hash")? != target.hash.to_hex()
    {
        return Err(ChainError::Evidence(
            "canonicality extract is bound to another base or target".into(),
        ));
    }
    Ok((
        record.clone(),
        ReplayedStage {
            provider: provider.label().to_owned(),
            parameters: parameters.clone(),
            manifests: record
                .get("manifests")
                .and_then(Json::as_array)
                .ok_or_else(|| ChainError::Evidence("record lists no manifests".into()))?
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| ChainError::Evidence("manifest id is not text".into()))
                })
                .collect::<Result<_, _>>()?,
            rows,
        },
    ))
}
