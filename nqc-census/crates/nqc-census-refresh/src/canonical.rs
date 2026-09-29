//! `BASE_CANONICALITY`: is the certified base anchor still canonical at the
//! target anchor?
//!
//! One provider, pinned to the target anchor: the verified header at the base
//! height. Its hash must be the certified base hash on every provider. A
//! different hash is a reorg of the base; a refresh from it is refused and a
//! full census is required. Providers that differ fail closed.

use crate::base::BaseCensus;
use crate::stage::{data_digest, record, STAGE_SCHEMA};
use nqc_census_chain::{
    acquire::Acquisition,
    job::{add_manifest_exchanges, JobSpec},
    json::Json,
    provider::ProviderSpec,
    transport::{ReplayTransport, RetryPolicy},
    ChainError,
};
use nqc_census_state::replay::{manifests, owner};
use nqc_census_state::stage::{stage_anchor, AnchorPlan};
use nqc_census_state::v2_verify::ReplayedStage;
use nqc_census_store::{ArtifactId, Store};
use std::collections::BTreeMap;

const CANONICAL_NAMESPACE: u16 = 0x0a01;
const CANONICAL_FAMILY: &str = "rmc010-base-canonicality";

pub fn base_canonicality_stage(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    target: &AnchorPlan,
    base: &BaseCensus,
) -> Result<(Json, Vec<Json>), ChainError> {
    if base.anchor_number > target.number {
        return Err(ChainError::Config(
            "the base anchor is after the target anchor".into(),
        ));
    }
    let (chain, anchor, mut ids) = stage_anchor(acquisition, provider, target)?;
    let declared = base.anchor_hash;
    let height = base.anchor_number;
    let spec = JobSpec::new(
        CANONICAL_FAMILY,
        1,
        CANONICAL_NAMESPACE,
        Json::object([
            ("base_number", Json::uint(height)),
            ("base_hash", Json::string(declared.to_hex())),
            ("target", Json::uint(target.number)),
        ]),
    )?;
    let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
        let header = ctx.header_by_number(height)?;
        let observed = header.envelope().anchor().block_hash();
        Ok(Json::object([
            ("base_number", Json::uint(height)),
            ("declared_hash", Json::string(declared.to_hex())),
            ("observed_hash", Json::string(observed.to_hex())),
            ("canonical", Json::Bool(observed == declared)),
        ]))
    })?;
    ids.push(output.manifest_id().to_hex());
    let rows = vec![output.result_json()?];
    let parameters = Json::object([
        ("base_number", Json::uint(height)),
        ("base_hash", Json::string(declared.to_hex())),
        ("target", Json::uint(target.number)),
        ("target_hash", Json::string(target.hash.to_hex())),
    ]);
    Ok((
        record("BASE_CANONICALITY", provider, parameters, &ids, &rows)?,
        rows,
    ))
}

/// Re-runs a canonicality record from the evidence it names; the result must
/// be byte-identical.
pub fn replay_canonicality(
    store: &Store,
    providers: &[ProviderSpec],
    target: &AnchorPlan,
    base: &BaseCensus,
    record: &Json,
) -> Result<ReplayedStage, ChainError> {
    if record.get("schema").and_then(Json::as_str) != Some(STAGE_SCHEMA)
        || record.str_field("stage")? != "BASE_CANONICALITY"
    {
        return Err(ChainError::Evidence(
            "not an RMC-010 canonicality record".into(),
        ));
    }
    let provider = owner(providers, record)?;
    let ids = manifests(record)?;
    let mut replay = ReplayTransport::new();
    for id in &ids {
        let artifact = store.get_artifact(&ArtifactId::parse_hex(id)?)?;
        add_manifest_exchanges(&mut replay, store, &artifact, provider)?;
    }
    let acquisition = Acquisition::new(store, &replay, RetryPolicy::none());
    let (replayed, rows) = base_canonicality_stage(&acquisition, provider, target, base)?;
    if !replayed.same_as(record)? || data_digest(&rows)? != record.str_field("data_sha256")? {
        return Err(ChainError::Evidence(format!(
            "canonicality record of {} does not reproduce from its evidence",
            provider.label()
        )));
    }
    Ok(ReplayedStage {
        provider: provider.label().to_owned(),
        parameters: record
            .get("parameters")
            .cloned()
            .ok_or_else(|| ChainError::Evidence("record without parameters".into()))?,
        manifests: ids,
        rows,
    })
}

/// Requires at least two providers, each observing the certified base hash
/// at the base height.
pub fn verify_canonicality(
    stages: &[ReplayedStage],
    base: &BaseCensus,
) -> Result<Json, ChainError> {
    let mut observed: BTreeMap<&str, &Json> = BTreeMap::new();
    for stage in stages {
        let [row] = stage.rows.as_slice() else {
            return Err(ChainError::Evidence(
                "canonicality stage without exactly one row".into(),
            ));
        };
        if observed.insert(stage.provider.as_str(), row).is_some() {
            return Err(ChainError::Evidence(format!(
                "canonicality repeated for provider {}",
                stage.provider
            )));
        }
    }
    if observed.len() < 2 {
        return Err(ChainError::Evidence(
            "base canonicality needs two providers".into(),
        ));
    }
    let declared = base.anchor_hash.to_hex();
    for (provider, row) in &observed {
        let hash = row.str_field("observed_hash")?;
        if row.str_field("declared_hash")? != declared
            || row.get("base_number").and_then(Json::as_i64)
                != i64::try_from(base.anchor_number).ok()
        {
            return Err(ChainError::Evidence(
                "canonicality was checked for another base".into(),
            ));
        }
        if hash != declared {
            return Err(ChainError::Evidence(format!(
                "BASE_REORGED: block {} is {hash} on {provider}, the certified base is {declared}; the incremental refresh is refused and a full census is required",
                base.anchor_number
            )));
        }
    }
    Ok(Json::object([
        ("status", Json::string("BASE_CANONICAL")),
        ("base_number", Json::uint(base.anchor_number)),
        ("base_hash", Json::string(declared)),
        (
            "providers",
            Json::array(observed.keys().map(|provider| Json::string(*provider))),
        ),
    ]))
}
