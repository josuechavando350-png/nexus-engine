//! Per-stage offline extracts for RMC-010 base canonicality.
//!
//! A live BASE_CANONICALITY stage is first replayed from its own RMC-004
//! store.  The resulting extract carries the exact record, replayed rows and
//! verified store summary.  The final reconciler therefore does not need to
//! gather stage stores onto one runner.

use crate::base::BaseCensus;
use crate::canonical::replay_canonicality;
use crate::stage::{data_digest, STAGE_SCHEMA};
use nqc_census_chain::{
    json::Json,
    provider::ProviderSpec,
    ChainError,
};
use nqc_census_state::{
    replay::owner,
    stage::{sha256_plain, AnchorPlan},
    v2_verify::ReplayedStage,
};
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

/// Replay one canonicality stage from its own store and materialize the
/// small, self-checking extract consumed by the final reconciler.
pub fn canonicality_extract(
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

/// Verify a canonicality extract without trusting any unverified field.
pub fn verify_canonicality_extract(
    providers: &[ProviderSpec],
    target: &AnchorPlan,
    base: &BaseCensus,
    extract: Json,
) -> Result<(Json, ReplayedStage, Json), ChainError> {
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
    let reduced = Json::Object(fields.into_iter().collect());
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA)
        || record.str_field("stage")? != "BASE_CANONICALITY"
    {
        return Err(ChainError::Evidence(
            "canonicality extract names another stage".into(),
        ));
    }
    let provider = owner(providers, &record)?;
    if sha256_plain(&record.canonical()?) != reduced.str_field("record_sha256")? {
        return Err(ChainError::Evidence(
            "canonicality extract record digest differs".into(),
        ));
    }
    if rows.len() as u64 != number(&record, "row_count")?
        || rows.len() as u64 != number(&reduced, "row_count")?
    {
        return Err(ChainError::Evidence(
            "canonicality extract row count differs".into(),
        ));
    }
    let digest = data_digest(&rows)?;
    if digest != record.str_field("data_sha256")?
        || digest != reduced.str_field("data_sha256")?
    {
        return Err(ChainError::Evidence(
            "canonicality extract data digest differs".into(),
        ));
    }
    let store = reduced
        .get("store")
        .cloned()
        .ok_or_else(|| ChainError::Evidence("canonicality extract without store".into()))?;
    if !hex64(store.str_field("evidence_root")?) {
        return Err(ChainError::Evidence(
            "canonicality extract store evidence root is not a digest".into(),
        ));
    }
    let parameters = record
        .get("parameters")
        .cloned()
        .ok_or_else(|| ChainError::Evidence("canonicality record without parameters".into()))?;
    if number(&parameters, "base_number")? != base.anchor_number
        || parameters.str_field("base_hash")? != base.anchor_hash.to_hex()
        || number(&parameters, "target")? != target.number
        || parameters.str_field("target_hash")? != target.hash.to_hex()
    {
        return Err(ChainError::Evidence(
            "canonicality extract was made for another base or target".into(),
        ));
    }
    Ok((
        record,
        ReplayedStage {
            provider: provider.label().to_owned(),
            parameters,
            manifests: crate::canonical::manifests_for_record_for_extract(&record)?,
            rows,
        },
        store,
    ))
}
