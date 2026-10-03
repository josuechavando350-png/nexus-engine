//! Multi-provider chain bootstrap: every provider must prove the same chain
//! domain and the same verified anchor; the report names every recorded job
//! so offline verification can replay it.

use crate::acquire::{
    anchor_body, anchor_from_result, anchor_record, anchor_spec, bootstrap_spec, replay_bootstrap,
    Acquisition,
};
use crate::consensus::{agree, ProviderResult};
use crate::error::ChainError;
use crate::ethereum::ChainProfile;
use crate::job::verify_job_replay;
use crate::json::Json;
use crate::provider::ProviderSet;
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
use nqc_census_store::{ArtifactId, Store};

pub const BOOTSTRAP_REPORT_SCHEMA: &str = "nqc-census-chain-bootstrap-report-v1";

/// Bootstraps every provider and returns the canonical report. Fails closed
/// unless all providers agree on the chain domain and the anchor.
pub fn run_bootstrap(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    profile: &ChainProfile,
    anchor_number: u64,
) -> Result<(Json, ChainDomain, StateAnchor), ChainError> {
    let mut domains = Vec::new();
    let mut anchors = Vec::new();
    let mut records = Vec::new();
    let mut last = None;
    for provider in providers.iter() {
        let (facts, bootstrap_output) = acquisition.bootstrap(provider, profile)?;
        let (anchor, anchor_output) =
            acquisition.resolve_anchor(provider, &facts.chain, anchor_number)?;
        domains.push(ProviderResult {
            provider: provider.label().to_owned(),
            manifest: bootstrap_output.manifest_id().to_hex(),
            result: bootstrap_output.result_json()?,
        });
        anchors.push(ProviderResult {
            provider: provider.label().to_owned(),
            manifest: anchor_output.manifest_id().to_hex(),
            result: anchor_output.result_json()?,
        });
        records.push(Json::object([
            ("provider", provider.descriptor()),
            ("client_version", Json::string(facts.client_version)),
            (
                "bootstrap_manifest",
                Json::string(bootstrap_output.manifest_id().to_hex()),
            ),
            (
                "anchor_manifest",
                Json::string(anchor_output.manifest_id().to_hex()),
            ),
        ]));
        last = Some((facts.chain, anchor));
    }
    let domain = agree("chain_domain", &domains)?
        .map_err(|_| ChainError::Consensus("providers disagree on the chain domain"))?;
    let anchor = agree("anchor", &anchors)?
        .map_err(|_| ChainError::Consensus("providers disagree on the anchor"))?;
    let (chain, anchor_value) = last.ok_or(ChainError::Consensus("no providers"))?;
    let report = Json::object([
        ("schema", Json::string(BOOTSTRAP_REPORT_SCHEMA)),
        ("chain_domain", domain.result),
        ("anchor", anchor.result),
        ("providers", Json::Array(records)),
        ("provider_count", Json::uint(providers.len() as u64)),
        (
            "infrastructure_independence",
            Json::string("NOT_PROVEN_DISTINCT_DECLARED_OPERATORS"),
        ),
    ]);
    Ok((report, chain, anchor_value))
}

/// Offline: replays every bootstrap and anchor job named by `report` and
/// requires each to reproduce the agreed chain domain and anchor.
pub fn verify_bootstrap(
    store: &Store,
    providers: &ProviderSet,
    profile: &ChainProfile,
    report: &Json,
) -> Result<(ChainDomain, StateAnchor), ChainError> {
    if report.get("schema").and_then(Json::as_str) != Some(BOOTSTRAP_REPORT_SCHEMA) {
        return Err(ChainError::Evidence("not a bootstrap report".into()));
    }
    let domain_json = report
        .get("chain_domain")
        .ok_or_else(|| ChainError::Evidence("report without chain domain".into()))?;
    let chain = ChainDomain::new(
        profile.chain_id(),
        Hash32::parse_hex(domain_json.str_field("genesis_hash")?)?,
        Hash32::parse_hex(domain_json.str_field("fork_lineage")?)?,
    )?;
    let recorded_anchor = report
        .get("anchor")
        .ok_or_else(|| ChainError::Evidence("report without anchor".into()))?;
    let anchor = anchor_from_result(&chain, recorded_anchor, "anchor")?;
    let records = report
        .get("providers")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("report without providers".into()))?;
    if records.len() != providers.len() {
        return Err(ChainError::Evidence(
            "report and provider set differ".into(),
        ));
    }
    for (provider, record) in providers.iter().zip(records) {
        if !record
            .get("provider")
            .ok_or_else(|| ChainError::Evidence("record without provider".into()))?
            .same_as(&provider.descriptor())?
        {
            return Err(ChainError::Evidence(
                "report provider differs from the declared set".into(),
            ));
        }
        let bootstrap_manifest = ArtifactId::parse_hex(record.str_field("bootstrap_manifest")?)?;
        let output = verify_job_replay(
            store,
            &bootstrap_manifest,
            provider,
            None,
            &bootstrap_spec(profile)?,
            |ctx| replay_bootstrap(ctx, profile),
        )?;
        if !output.result_json()?.same_as(domain_json)? {
            return Err(ChainError::Evidence("replayed chain domain differs".into()));
        }
        let anchor_manifest = ArtifactId::parse_hex(record.str_field("anchor_manifest")?)?;
        let number = anchor.block_number();
        let output = verify_job_replay(
            store,
            &anchor_manifest,
            provider,
            Some(chain.clone()),
            &anchor_spec(number)?,
            |ctx| anchor_body(ctx, number),
        )?;
        let replayed = anchor_from_result(&chain, &output.result_json()?, "anchor")?;
        if !Json::object([("anchor", anchor_record(&replayed))]).same_as(recorded_anchor)? {
            return Err(ChainError::Evidence("replayed anchor differs".into()));
        }
    }
    Ok((chain, anchor))
}
