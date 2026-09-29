//! Per-stage replay extracts.
//!
//! The stage stores of a mainnet run are not gathered on one runner. Each
//! stage is replayed offline from its own store (`stage_extract`) into an
//! extract: the record, its replayed rows and the store's RMC-004
//! verification summary. The reconciler holds only extracts
//! (`extract_stages`). It recomputes every digest and requires every record to
//! have been made for the reconciler's own plans. The chain domain and anchor
//! every record names are bound by `observation_anchor`, as for replayed
//! stages.

use crate::aave_stage::reserves_json;
use crate::replay::{manifests, owner, replay_stage, StagePlans};
use crate::stage::{data_digest, sha256_plain, AnchorPlan, STAGE_SCHEMA};
use crate::v2_stage::pairs_digest;
use crate::v2_verify::ReplayedStage;
use nqc_census_chain::{json::Json, provider::ProviderSpec, ChainError};
use nqc_census_store::Store;
use std::collections::{BTreeMap, BTreeSet};

pub const EXTRACT_SCHEMA: &str = "nqc-rmc-008-state-stage-extract-v1";

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

/// Replays `record` from `store` and returns its extract.
pub fn stage_extract(
    store: &Store,
    providers: &[ProviderSpec],
    plans: &StagePlans<'_>,
    record: &Json,
    store_summary: Json,
) -> Result<Json, ChainError> {
    let replayed = replay_stage(store, providers, plans, record)?;
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

fn hex64(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Checks one extract; returns its record and replayed stage. Every digest
/// is recomputed; the extract is trusted only to come from the exact-head
/// replay of its stage.
pub fn verify_extract(
    providers: &[ProviderSpec],
    extract: Json,
) -> Result<(Json, ReplayedStage), ChainError> {
    let Json::Object(members) = extract else {
        return Err(ChainError::Evidence("extract is not an object".into()));
    };
    let count = members.len();
    let mut fields: BTreeMap<String, Json> = members.into_iter().collect();
    if fields.len() != count {
        return Err(ChainError::Evidence("extract repeats a field".into()));
    }
    if fields.get("schema").and_then(Json::as_str) != Some(EXTRACT_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-008 stage extract".into()));
    }
    let record = fields
        .remove("record")
        .ok_or_else(|| ChainError::Evidence("extract without record".into()))?;
    let Some(Json::Array(rows)) = fields.remove("rows") else {
        return Err(ChainError::Evidence("extract without rows".into()));
    };
    let extract = Json::Object(fields.into_iter().collect());
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-008 stage record".into()));
    }
    let provider = owner(providers, &record)?;
    if sha256_plain(&record.canonical()?) != extract.str_field("record_sha256")? {
        return Err(ChainError::Evidence("extract record digest differs".into()));
    }
    if rows.len() as u64 != number(&record, "row_count")?
        || rows.len() as u64 != number(&extract, "row_count")?
    {
        return Err(ChainError::Evidence("extract row count differs".into()));
    }
    let digest = data_digest(&rows)?;
    if digest != record.str_field("data_sha256")? || digest != extract.str_field("data_sha256")? {
        return Err(ChainError::Evidence("extract data digest differs".into()));
    }
    let root = extract
        .get("store")
        .ok_or_else(|| ChainError::Evidence("extract without store".into()))?
        .str_field("evidence_root")?;
    if !hex64(root) {
        return Err(ChainError::Evidence(
            "extract store evidence root is not a digest".into(),
        ));
    }
    let stage = ReplayedStage {
        provider: provider.label().to_owned(),
        parameters: record
            .get("parameters")
            .cloned()
            .ok_or_else(|| ChainError::Evidence("record without parameters".into()))?,
        manifests: manifests(&record)?,
        rows,
    };
    Ok((record, stage))
}

/// Replay bound each record to the plans it was replayed under. Here the
/// plans are the reconciler's, so the binding is checked again: the record's
/// declared plan parameters must be exactly the reconciler's.
fn bound_to_plans(
    record: &Json,
    plans: &StagePlans<'_>,
    anchor: &AnchorPlan,
) -> Result<(), ChainError> {
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("record without parameters".into()))?;
    let text = |key: &str| parameters.str_field(key).map(str::to_owned);
    let missing = |what: &str| ChainError::Config(format!("{what} plan not supplied"));
    let bound = number(parameters, "anchor")? == anchor.number
        && match record.str_field("stage")? {
            "AAVE_STATE" => {
                let aave = plans.aave.ok_or_else(|| missing("Aave"))?;
                text("pool")? == aave.pool.to_hex()
                    && text("pool_implementation")? == aave.pool_implementation.to_hex()
                    && text("addresses_provider")? == aave.addresses_provider.to_hex()
                    && text("oracle")? == aave.oracle.to_hex()
                    && parameters
                        .get("reserves")
                        .ok_or_else(|| ChainError::Evidence("record without reserves".into()))?
                        .same_as(&reserves_json(aave))?
            }
            "V2_FACTORY" => {
                let v2 = plans.v2.ok_or_else(|| missing("V2"))?;
                let admitted: BTreeSet<String> =
                    plans.pairs.iter().map(|pair| pair.pair.to_hex()).collect();
                let samples = parameters
                    .get("samples")
                    .and_then(Json::as_array)
                    .ok_or_else(|| ChainError::Evidence("factory samples missing".into()))?;
                text("factory")? == v2.factory.to_hex()
                    && !samples.is_empty()
                    && samples
                        .iter()
                        .all(|sample| sample.as_str().is_some_and(|s| admitted.contains(s)))
            }
            "V2_STATE" => {
                let v2 = plans.v2.ok_or_else(|| missing("V2"))?;
                text("factory")? == v2.factory.to_hex()
                    && number(parameters, "pair_count")? == plans.pairs.len() as u64
                    && text("pair_input_sha256")? == pairs_digest(plans.pairs)
                    && number(parameters, "job_size")? == v2.job_size as u64
            }
            other => return Err(ChainError::Evidence(format!("unknown stage {other}"))),
        };
    if bound {
        Ok(())
    } else {
        Err(ChainError::Evidence(format!(
            "{} stage extract was made for another plan",
            record.str_field("stage")?
        )))
    }
}

/// Verifies every extract and requires each record to have been made for
/// `plans` at `anchor`.
pub fn extract_stages(
    providers: &[ProviderSpec],
    plans: &StagePlans<'_>,
    anchor: &AnchorPlan,
    extracts: Vec<Json>,
) -> Result<Vec<(Json, ReplayedStage)>, ChainError> {
    let mut out = Vec::with_capacity(extracts.len());
    for extract in extracts {
        let (record, stage) = verify_extract(providers, extract)?;
        bound_to_plans(&record, plans, anchor)?;
        out.push((record, stage));
    }
    Ok(out)
}
