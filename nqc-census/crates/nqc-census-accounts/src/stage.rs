//! RMC-009 stage records: `{schema, stage, provider, parameters, manifests,
//! row_count, data_sha256}`, replayed byte-for-byte by the reconciler.

use nqc_census_chain::{hex, json::Json, provider::ProviderSpec, ChainError};
use sha2::{Digest, Sha256};

pub const STAGE_SCHEMA: &str = "nqc-rmc-009-account-stage-record-v1";

pub fn data_digest(rows: &[Json]) -> Result<String, ChainError> {
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC009-STAGE-DATA-V1");
    for row in rows {
        let bytes = row.canonical()?;
        digest.update((bytes.len() as u64).to_be_bytes());
        digest.update(&bytes);
    }
    Ok(hex::plain(&digest.finalize()))
}

pub fn record(
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
            Json::array(manifests.iter().map(|id| Json::string(id.clone()))),
        ),
        ("row_count", Json::uint(rows.len() as u64)),
        ("data_sha256", Json::string(data_digest(rows)?)),
    ]))
}

pub fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}
