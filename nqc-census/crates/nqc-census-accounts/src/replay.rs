//! Offline replay of RMC-009 stage records: each record is re-run through a
//! replay transport built only from the manifests it names and must be
//! byte-identical, with the same data digest. Only replayed rows reach the
//! verifier.

use crate::candidates::Candidates;
use crate::index::account_index_stage;
use crate::plan::AccountPlan;
use crate::stage::{data_digest, number, STAGE_SCHEMA};
use crate::state::account_state_stage;
use crate::tokens::account_tokens_stage;
use nqc_census_chain::{
    acquire::Acquisition,
    job::add_manifest_exchanges,
    json::Json,
    provider::ProviderSpec,
    transport::{ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_state::replay::{manifests, owner};
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::{ArtifactId, Store};

pub fn replay_account_stage(
    store: &Store,
    providers: &[ProviderSpec],
    plan: &AccountPlan,
    candidates: Option<&Candidates>,
    record: &Json,
) -> Result<ReplayedStage, ChainError> {
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-009 stage record".into()));
    }
    let provider = owner(providers, record)?;
    let ids = manifests(record)?;
    let mut replay = ReplayTransport::new();
    for id in &ids {
        let artifact = store.get_artifact(&ArtifactId::parse_hex(id)?)?;
        add_manifest_exchanges(&mut replay, store, &artifact, provider)?;
    }
    let acquisition = Acquisition::new(store, &replay, RetryPolicy::none());
    let parameters = record
        .get("parameters")
        .ok_or_else(|| ChainError::Evidence("record without parameters".into()))?;
    let (replayed, rows) = match record.str_field("stage")? {
        "ACCOUNT_INDEX" => account_index_stage(
            &acquisition,
            provider,
            plan,
            number(parameters, "partition")?,
            number(parameters, "partitions")?,
        )?,
        "ACCOUNT_TOKENS" => account_tokens_stage(&acquisition, provider, plan)?,
        "ACCOUNT_STATE" => account_state_stage(
            &acquisition,
            provider,
            plan,
            candidates.ok_or_else(|| ChainError::Config("candidates not supplied".into()))?,
            number(parameters, "partition")?,
            number(parameters, "partitions")?,
        )?,
        other => return Err(ChainError::Evidence(format!("unknown stage {other}"))),
    };
    if !replayed.same_as(record)? {
        return Err(ChainError::Evidence(format!(
            "{} stage record of {} does not reproduce from its evidence",
            record.str_field("stage")?,
            provider.label()
        )));
    }
    if data_digest(&rows)? != record.str_field("data_sha256")? {
        return Err(ChainError::Evidence("stage data digest differs".into()));
    }
    Ok(ReplayedStage {
        provider: provider.label().to_owned(),
        parameters: parameters.clone(),
        manifests: ids,
        rows,
    })
}
