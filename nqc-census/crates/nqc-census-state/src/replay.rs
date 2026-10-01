//! Offline replay of RMC-008 stage records.
//!
//! A record is re-run through a replay transport built only from the
//! manifests it names; the replayed record must be byte-identical and its
//! data digest must match. Only replayed rows reach the verifiers.

use crate::aave_stage::{aave_state_stage, AavePlan};
use crate::stage::{data_digest, STAGE_SCHEMA};
use crate::v2_stage::{v2_factory_stage, v2_state_stage, PairInput, V2Plan};
use crate::v2_verify::ReplayedStage;
use nqc_census_chain::{
    acquire::Acquisition,
    job::add_manifest_exchanges,
    json::Json,
    provider::ProviderSpec,
    transport::{ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::Address;
use nqc_census_store::{ArtifactId, Store};

/// Everything a stage function was called with, besides the provider.
pub struct StagePlans<'a> {
    pub v2: Option<&'a V2Plan>,
    pub pairs: &'a [PairInput],
    pub aave: Option<&'a AavePlan>,
}

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

pub fn manifests(record: &Json) -> Result<Vec<String>, ChainError> {
    record
        .get("manifests")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("record lists no manifests".into()))?
        .iter()
        .map(|id| {
            id.as_str()
                .map(str::to_owned)
                .ok_or_else(|| ChainError::Evidence("manifest id is not text".into()))
        })
        .collect()
}

pub fn owner<'a>(
    providers: &'a [ProviderSpec],
    record: &Json,
) -> Result<&'a ProviderSpec, ChainError> {
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

pub fn replay_stage(
    store: &Store,
    providers: &[ProviderSpec],
    plans: &StagePlans<'_>,
    record: &Json,
) -> Result<ReplayedStage, ChainError> {
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA) {
        return Err(ChainError::Evidence("not an RMC-008 stage record".into()));
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
    let missing = |what: &str| ChainError::Config(format!("{what} plan not supplied"));
    let (replayed, rows) = match record.str_field("stage")? {
        "V2_FACTORY" => {
            let samples = parameters
                .get("samples")
                .and_then(Json::as_array)
                .ok_or_else(|| ChainError::Evidence("factory samples missing".into()))?
                .iter()
                .map(|sample| {
                    Address::parse_hex(
                        sample
                            .as_str()
                            .ok_or_else(|| ChainError::Evidence("sample is not text".into()))?,
                    )
                    .map_err(ChainError::from)
                })
                .collect::<Result<Vec<_>, _>>()?;
            v2_factory_stage(
                &acquisition,
                provider,
                plans.v2.ok_or_else(|| missing("V2"))?,
                &samples,
            )?
        }
        "V2_STATE" => v2_state_stage(
            &acquisition,
            provider,
            plans.v2.ok_or_else(|| missing("V2"))?,
            plans.pairs,
            number(parameters, "partition")?,
            number(parameters, "partitions")?,
        )?,
        "AAVE_STATE" => aave_state_stage(
            &acquisition,
            provider,
            plans.aave.ok_or_else(|| missing("Aave"))?,
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
