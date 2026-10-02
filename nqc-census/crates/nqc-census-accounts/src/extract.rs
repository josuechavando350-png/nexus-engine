//! Per-stage replay extracts.
//!
//! The stage stores of a mainnet run do not fit on one runner together, so
//! each stage is replayed offline from its own store (`stage_extract`) into an
//! extract: the record, its replayed rows, the chain domain and anchor
//! replayed from the record's own bootstrap and anchor manifests, and the
//! store's RMC-004 verification summary. The reconciler holds only extracts
//! (`extract_stages`), recomputes every digest, and requires every extract to
//! name the same chain domain and the plan's anchor.

use crate::candidates::Candidates;
use crate::plan::AccountPlan;
use crate::replay::replay_account_stage;
use crate::stage::{data_digest, number, STAGE_SCHEMA};
use nqc_census_chain::{
    acquire::Acquisition,
    job::add_manifest_exchanges,
    json::Json,
    provider::ProviderSpec,
    transport::{ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_state::replay::{manifests, owner};
use nqc_census_state::stage::sha256_plain;
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::{ArtifactId, Store};
use std::collections::BTreeMap;

pub const EXTRACT_SCHEMA: &str = "nqc-rmc-009-account-stage-extract-v1";

/// Replays `record` from `store` and returns its extract.
pub fn stage_extract(
    store: &Store,
    providers: &[ProviderSpec],
    plan: &AccountPlan,
    candidates: Option<&Candidates>,
    record: &Json,
    store_summary: Json,
) -> Result<Json, ChainError> {
    let replayed = replay_account_stage(store, providers, plan, candidates, record)?;
    let provider = owner(providers, record)?;
    let [bootstrap_id, anchor_id, ..] = replayed.manifests.as_slice() else {
        return Err(ChainError::Evidence(
            "record lacks bootstrap and anchor manifests".into(),
        ));
    };
    let mut replay = ReplayTransport::new();
    for id in [bootstrap_id, anchor_id] {
        let artifact = store.get_artifact(&ArtifactId::parse_hex(id)?)?;
        add_manifest_exchanges(&mut replay, store, &artifact, provider)?;
    }
    let acquisition = Acquisition::new(store, &replay, RetryPolicy::none());
    let (facts, bootstrap) = acquisition.bootstrap(provider, &plan.anchor.profile)?;
    let (anchor, anchor_output) =
        acquisition.resolve_anchor(provider, &facts.chain, plan.anchor.number)?;
    if bootstrap.manifest_id().to_hex() != *bootstrap_id
        || anchor_output.manifest_id().to_hex() != *anchor_id
    {
        return Err(ChainError::Evidence(
            "replayed bootstrap or anchor is not the record's".into(),
        ));
    }
    if anchor.block_hash() != plan.anchor.hash {
        return Err(ChainError::Evidence(
            "stage anchor differs from the declared observation anchor".into(),
        ));
    }
    Ok(Json::object([
        ("schema", Json::string(EXTRACT_SCHEMA)),
        (
            "record_sha256",
            Json::string(sha256_plain(&record.canonical()?)),
        ),
        ("record", record.clone()),
        ("chain_domain", bootstrap.result_json()?),
        ("anchor", anchor_output.result_json()?),
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
        return Err(ChainError::Evidence("not an RMC-009 stage extract".into()));
    }
    let record = fields
        .remove("record")
        .ok_or_else(|| ChainError::Evidence("extract without record".into()))?;
    let Some(Json::Array(rows)) = fields.remove("rows") else {
        return Err(ChainError::Evidence("extract without rows".into()));
    };
    let extract = Json::Object(fields.into_iter().collect());
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-009 stage record".into()));
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

/// Verifies every extract (index records against `index_providers`, the
/// others against `state_providers`) and binds all of them to one chain
/// domain and to the plan's anchor.
pub fn extract_stages(
    index_providers: &[ProviderSpec],
    state_providers: &[ProviderSpec],
    plan: &AccountPlan,
    extracts: Vec<Json>,
) -> Result<Vec<(Json, ReplayedStage)>, ChainError> {
    let mut domain: Option<Json> = None;
    let mut out = Vec::with_capacity(extracts.len());
    for extract in extracts {
        let staged = extract
            .get("chain_domain")
            .ok_or_else(|| ChainError::Evidence("extract without chain domain".into()))?;
        match &domain {
            Some(first) if !first.same_as(staged)? => {
                return Err(ChainError::Evidence(
                    "stage extracts name different chain domains".into(),
                ))
            }
            Some(_) => {}
            None => domain = Some(staged.clone()),
        }
        let anchor = extract
            .get("anchor")
            .and_then(|value| value.get("anchor"))
            .ok_or_else(|| ChainError::Evidence("extract without anchor".into()))?;
        if number(anchor, "number")? != plan.anchor.number
            || anchor.str_field("hash")? != plan.anchor.hash.to_hex()
        {
            return Err(ChainError::Evidence(
                "stage anchor differs from the plan anchor".into(),
            ));
        }
        // Replay bound each record to the plan it was replayed under; here
        // the plan is the reconciler's, so the binding is checked again.
        let parameters = extract
            .get("record")
            .and_then(|record| record.get("parameters"))
            .ok_or_else(|| ChainError::Evidence("extract record without parameters".into()))?;
        if parameters.str_field("tokens_sha256")? != plan.tokens_digest()
            || parameters.str_field("pool")? != plan.pool.to_hex()
            || number(parameters, "anchor")? != plan.anchor.number
        {
            return Err(ChainError::Evidence(
                "stage extract was made for another plan".into(),
            ));
        }
        let providers = match extract
            .get("record")
            .and_then(|record| record.get("stage"))
            .and_then(Json::as_str)
        {
            Some("ACCOUNT_INDEX") => index_providers,
            Some(_) => state_providers,
            None => return Err(ChainError::Evidence("extract names no stage".into())),
        };
        out.push(verify_extract(providers, extract)?);
    }
    Ok(out)
}
