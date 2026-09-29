//! Resumable acquisition over the RMC-004 store.
//!
//! * `bootstrap` establishes the chain domain from keccak-verified genesis and
//!   lineage headers on each provider.
//! * `point` runs a job pinned to one anchor as a single-block checkpoint.
//! * `scan` runs a log scan as contiguous window checkpoints; RMC-004 enforces
//!   that every window's first header extends the previous window's last one.
//!
//! Already-committed work is never refetched: it is re-executed from its
//! recorded exchanges and must reproduce its manifest byte-for-byte.

use crate::catalog::{committed_checkpoints, manifest_of};
use crate::error::ChainError;
use crate::ethereum::ChainProfile;
use crate::hex;
use crate::job::{
    run_job, verify_job_replay, ClaimedLog, JobContext, JobOutput, JobSpec, LogFilter,
};
use crate::json::Json;
use crate::provider::ProviderSpec;
use crate::rpc::RpcCall;
use crate::transport::{RetryPolicy, Transport};
use nqc_census_core::{
    Address, ChainDomain, DeploymentKey, Hash32, ObservationSemantics, StateAnchor,
};
use nqc_census_store::Store;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const BOOTSTRAP_FAMILY: &str = "nqc-census-chain-bootstrap";

/// Stream namespace reserved for chain-level jobs.
pub const CHAIN_STREAM_NAMESPACE: u16 = 0x0100;

/// Result of bootstrapping one provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bootstrap {
    pub chain: ChainDomain,
    pub client_version: String,
    pub reported_chain_id: u64,
}

pub struct Acquisition<'a> {
    store: &'a Store,
    transport: &'a dyn Transport,
    retry: RetryPolicy,
}

impl<'a> Acquisition<'a> {
    pub fn new(store: &'a Store, transport: &'a dyn Transport, retry: RetryPolicy) -> Self {
        Self {
            store,
            transport,
            retry,
        }
    }

    pub const fn store(&self) -> &Store {
        self.store
    }

    /// Runs a job that cannot be a stream checkpoint because it establishes
    /// what a checkpoint needs (the chain domain, or an anchor's parent). Its
    /// exchanges, observations and manifest are persisted as artifacts; the
    /// caller must bind the manifest into its run manifest so offline
    /// verification replays it.
    pub fn unanchored<F>(
        &self,
        provider: &ProviderSpec,
        chain: Option<ChainDomain>,
        spec: &JobSpec,
        body: F,
    ) -> Result<JobOutput, ChainError>
    where
        F: FnOnce(&mut JobContext<'_>) -> Result<Json, ChainError>,
    {
        let output = run_job(
            self.transport,
            provider,
            self.retry.clone(),
            chain,
            spec,
            body,
        )?;
        for artifact in &output.artifacts {
            self.store.put_artifact(artifact)?;
        }
        self.store.put_artifact(&output.manifest)?;
        Ok(output)
    }

    /// Establishes the chain domain from one provider.
    pub fn bootstrap(
        &self,
        provider: &ProviderSpec,
        profile: &ChainProfile,
    ) -> Result<(Bootstrap, JobOutput), ChainError> {
        let spec = bootstrap_spec(profile)?;
        let mut facts = None;
        let output = self.unanchored(provider, None, &spec, |ctx| {
            let (bootstrap, result) = bootstrap_body(ctx, profile)?;
            facts = Some(bootstrap);
            Ok(result)
        })?;
        let bootstrap =
            facts.ok_or_else(|| ChainError::Config("bootstrap produced no facts".into()))?;
        Ok((bootstrap, output))
    }

    /// Resolves the verified anchor of block `number`.
    pub fn resolve_anchor(
        &self,
        provider: &ProviderSpec,
        chain: &ChainDomain,
        number: u64,
    ) -> Result<(StateAnchor, JobOutput), ChainError> {
        let spec = anchor_spec(number)?;
        let output = self.unanchored(provider, Some(chain.clone()), &spec, |ctx| {
            anchor_body(ctx, number)
        })?;
        let anchor = anchor_from_result(chain, &output.result_json()?, "anchor")?;
        Ok((anchor, output))
    }

    /// Runs or resumes a job pinned to `anchor`.
    #[allow(clippy::too_many_arguments)]
    pub fn point<F>(
        &self,
        provider: &ProviderSpec,
        chain: &ChainDomain,
        deployment: Option<DeploymentKey>,
        spec: &JobSpec,
        anchor: &StateAnchor,
        body: F,
    ) -> Result<JobOutput, ChainError>
    where
        F: FnOnce(&mut JobContext<'_>) -> Result<Json, ChainError>,
    {
        let scope = spec.scope(provider, chain, deployment, anchor)?;
        let checkpoints = committed_checkpoints(self.store, &scope)?;
        if let Some(existing) = checkpoints.first() {
            if checkpoints.len() != 1 || existing.first() != anchor || existing.last() != anchor {
                return Err(ChainError::Evidence(
                    "point job stream does not hold exactly its anchor".into(),
                ));
            }
            let manifest = manifest_of(self.store, existing, &spec.descriptor(provider))?;
            return verify_job_replay(
                self.store,
                &manifest,
                provider,
                Some(chain.clone()),
                spec,
                body,
            );
        }
        let output = run_job(
            self.transport,
            provider,
            self.retry.clone(),
            Some(chain.clone()),
            spec,
            body,
        )?;
        output.commit(self.store, &scope, anchor.clone(), anchor.clone())?;
        Ok(output)
    }

    /// Runs or resumes a window-checkpointed log scan over `[first, last]`.
    /// `origin` must be the verified anchor of block `first`.
    #[allow(clippy::too_many_arguments)]
    pub fn scan<S>(
        &self,
        provider: &ProviderSpec,
        chain: &ChainDomain,
        deployment: Option<DeploymentKey>,
        family: &str,
        version: u16,
        namespace: u16,
        filter: &LogFilter,
        origin: &StateAnchor,
        last: u64,
        span: u64,
        semantics: S,
    ) -> Result<ScanOutcome, ChainError>
    where
        S: Fn(&ClaimedLog) -> Result<ObservationSemantics, ChainError>,
    {
        let first = origin.block_number();
        if span == 0 || first > last {
            return Err(ChainError::Config("invalid scan plan".into()));
        }
        let spec = JobSpec::new(
            family,
            version,
            namespace,
            Json::object([
                ("filter", filter.descriptor()),
                ("first", Json::uint(first)),
                ("last", Json::uint(last)),
                ("span", Json::uint(span)),
            ]),
        )?;
        let scope = spec.scope(provider, chain, deployment, origin)?;
        let committed = committed_checkpoints(self.store, &scope)?;
        let descriptor = spec.descriptor(provider);
        let mut windows = Vec::new();
        let mut next = first;
        let mut index = 0_u64;
        while next <= last {
            let end = next.saturating_add(span - 1).min(last);
            let body =
                |ctx: &mut JobContext<'_>| scan_window_body(ctx, filter, next, end, &semantics);
            let output = if let Some(existing) = committed.get(index as usize) {
                if existing.first_block() != next || existing.last_block() != end {
                    return Err(ChainError::Evidence(
                        "scan catalog does not follow the plan".into(),
                    ));
                }
                let manifest = manifest_of(self.store, existing, &descriptor)?;
                verify_job_replay(
                    self.store,
                    &manifest,
                    provider,
                    Some(chain.clone()),
                    &spec,
                    body,
                )?
            } else {
                let output = run_job(
                    self.transport,
                    provider,
                    self.retry.clone(),
                    Some(chain.clone()),
                    &spec,
                    body,
                )?;
                let result = output.result_json()?;
                let first_anchor = anchor_from_result(chain, &result, "first")?;
                let last_anchor = anchor_from_result(chain, &result, "last")?;
                output.commit(self.store, &scope, first_anchor, last_anchor)?;
                output
            };
            windows.push(output);
            next = end + 1;
            index += 1;
        }
        if committed.len() > windows.len() {
            return Err(ChainError::Evidence(
                "scan catalog extends beyond the plan".into(),
            ));
        }
        let certificate = self.store.certify_range(&scope, first, last)?;
        Ok(ScanOutcome {
            windows,
            certified_first: certificate.first_block,
            certified_last: certificate.last_block,
            commitment: certificate.commitment.to_hex(),
        })
    }
}

/// A completed, RMC-004-certified scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanOutcome {
    pub windows: Vec<JobOutput>,
    pub certified_first: u64,
    pub certified_last: u64,
    pub commitment: String,
}

impl ScanOutcome {
    /// All log records of the scan, in canonical (block, log index) order.
    pub fn logs(&self) -> Result<Vec<Json>, ChainError> {
        let mut logs = Vec::new();
        for window in &self.windows {
            let result = window.result_json()?;
            logs.extend(
                result
                    .get("logs")
                    .and_then(Json::as_array)
                    .ok_or_else(|| ChainError::Evidence("window without logs".into()))?
                    .iter()
                    .cloned(),
            );
        }
        Ok(logs)
    }
}

fn anchor_json(anchor: &StateAnchor) -> Json {
    Json::object([
        ("number", Json::uint(anchor.block_number())),
        ("hash", Json::string(anchor.block_hash().to_hex())),
        ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
        ("timestamp", Json::uint(anchor.timestamp())),
        ("state_root", Json::string(anchor.state_root().to_hex())),
    ])
}

/// Canonical JSON of an anchor, used in every job result.
pub fn anchor_record(anchor: &StateAnchor) -> Json {
    anchor_json(anchor)
}

pub fn anchor_from_result(
    chain: &ChainDomain,
    result: &Json,
    key: &str,
) -> Result<StateAnchor, ChainError> {
    let value = result
        .get(key)
        .ok_or_else(|| ChainError::Evidence(format!("result without {key} anchor")))?;
    let number = value
        .get("number")
        .and_then(Json::as_i64)
        .and_then(|n| u64::try_from(n).ok())
        .ok_or_else(|| ChainError::Evidence("anchor number missing".into()))?;
    let timestamp = value
        .get("timestamp")
        .and_then(Json::as_i64)
        .and_then(|n| u64::try_from(n).ok())
        .ok_or_else(|| ChainError::Evidence("anchor timestamp missing".into()))?;
    Ok(StateAnchor::new(
        chain.clone(),
        number,
        Hash32::parse_hex(value.str_field("hash")?)?,
        Hash32::parse_hex(value.str_field("parent_hash")?)?,
        timestamp,
        Hash32::parse_hex(value.str_field("state_root")?)?,
    )?)
}

/// Semantics of a raw, not-yet-decoded log: bound to its emitter and to the
/// scan that acquired it. Decoding under implementation-specific semantics
/// is a separate, evidence-backed step.
pub fn raw_log_semantics(
    emitter: &Address,
    scan_family: &str,
) -> Result<ObservationSemantics, ChainError> {
    let mut code = Sha256::new();
    code.update(b"NQC-CENSUS-RAW-EMITTER-LOG-V1");
    code.update([0]);
    code.update(emitter.as_bytes());
    let mut config = Sha256::new();
    config.update(b"NQC-CENSUS-LOG-SCAN-V1");
    config.update([0]);
    config.update(scan_family.as_bytes());
    Ok(ObservationSemantics::new(
        Hash32::new(code.finalize().into())?,
        Hash32::new(config.finalize().into())?,
    ))
}

fn scan_window_body<S>(
    ctx: &mut JobContext<'_>,
    filter: &LogFilter,
    first: u64,
    last: u64,
    semantics: &S,
) -> Result<Json, ChainError>
where
    S: Fn(&ClaimedLog) -> Result<ObservationSemantics, ChainError>,
{
    let mut numbers = vec![first];
    if last != first {
        numbers.push(last);
    }
    let logs = ctx.logs(filter, first, last)?;
    for log in &logs {
        if !numbers.contains(&log.block_number) {
            numbers.push(log.block_number);
        }
    }
    let headers = ctx.headers_by_number(&numbers)?;
    let by_number: BTreeMap<u64, _> = headers
        .iter()
        .map(|header| (header.envelope().anchor().block_number(), header.clone()))
        .collect();
    let mut records = Vec::with_capacity(logs.len());
    for log in &logs {
        let header = by_number
            .get(&log.block_number)
            .ok_or_else(|| ChainError::Evidence("log block header missing".into()))?;
        let observation = ctx.observe_log(log, header, semantics(log)?)?;
        let payload = observation.payload();
        records.push(Json::object([
            ("block", Json::uint(log.block_number)),
            ("block_hash", Json::string(log.block_hash.to_hex())),
            (
                "transaction_hash",
                Json::string(payload.transaction_hash().to_hex()),
            ),
            (
                "transaction_index",
                Json::uint(u64::from(payload.transaction_index())),
            ),
            ("log_index", Json::uint(u64::from(payload.log_index()))),
            ("emitter", Json::string(payload.emitter().to_hex())),
            (
                "topics",
                Json::array(payload.topics().iter().map(|t| Json::string(t.to_hex()))),
            ),
            ("data", Json::string(hex::encode(payload.data()))),
            (
                "raw_payload_digest",
                Json::string(observation.envelope().raw_payload_digest().to_hex()),
            ),
        ]));
    }
    let first_anchor = by_number
        .get(&first)
        .ok_or_else(|| ChainError::Evidence("window first header missing".into()))?
        .envelope()
        .anchor()
        .clone();
    let last_anchor = by_number
        .get(&last)
        .ok_or_else(|| ChainError::Evidence("window last header missing".into()))?
        .envelope()
        .anchor()
        .clone();
    Ok(Json::object([
        ("window", Json::array([Json::uint(first), Json::uint(last)])),
        ("first", anchor_json(&first_anchor)),
        ("last", anchor_json(&last_anchor)),
        ("logs", Json::Array(records)),
    ]))
}

fn bootstrap_body(
    ctx: &mut JobContext<'_>,
    profile: &ChainProfile,
) -> Result<(Bootstrap, Json), ChainError> {
    let chain_id_call = RpcCall::new("eth_chainId", Json::array([]));
    let version_call = RpcCall::new("web3_clientVersion", Json::array([]));
    let reported = ctx.raw_result(&chain_id_call)?;
    let reported_chain_id = hex::decode_quantity_u64(
        reported
            .as_str()
            .ok_or(ChainError::Rpc("chain id is not a string"))?,
    )?;
    if reported_chain_id != profile.chain_id() {
        return Err(ChainError::Config(format!(
            "provider reports chain id {reported_chain_id}"
        )));
    }
    let version = ctx.raw_result(&version_call)?;
    let client_version = version.as_str().unwrap_or("UNREPORTED").to_owned();
    let genesis = ctx.bootstrap_header(0)?;
    let lineage = ctx.bootstrap_header(profile.lineage_block())?;
    let chain = profile.derive_domain(genesis.envelope(), lineage.envelope())?;
    let result = Json::object([
        ("chain_id", Json::uint(chain.chain_id())),
        ("genesis_hash", Json::string(chain.genesis_hash().to_hex())),
        ("fork_lineage", Json::string(chain.fork_lineage().to_hex())),
        ("lineage_block", Json::uint(profile.lineage_block())),
        ("lineage_hash", Json::string(lineage.hash().to_hex())),
    ]);
    Ok((
        Bootstrap {
            chain,
            client_version,
            reported_chain_id,
        },
        result,
    ))
}

/// Bootstrap body for offline replay.
pub fn replay_bootstrap(
    ctx: &mut JobContext<'_>,
    profile: &ChainProfile,
) -> Result<Json, ChainError> {
    Ok(bootstrap_body(ctx, profile)?.1)
}

pub fn bootstrap_spec(profile: &ChainProfile) -> Result<JobSpec, ChainError> {
    JobSpec::new(
        BOOTSTRAP_FAMILY,
        1,
        CHAIN_STREAM_NAMESPACE,
        Json::object([
            ("chain_id", Json::uint(profile.chain_id())),
            ("lineage_block", Json::uint(profile.lineage_block())),
        ]),
    )
}

pub fn anchor_spec(number: u64) -> Result<JobSpec, ChainError> {
    JobSpec::new(
        "nqc-census-chain-anchor",
        1,
        CHAIN_STREAM_NAMESPACE,
        Json::object([("number", Json::uint(number))]),
    )
}

/// Header-only job body: the verified anchor of `number`.
pub fn anchor_body(ctx: &mut JobContext<'_>, number: u64) -> Result<Json, ChainError> {
    let header = ctx.header_by_number(number)?;
    Ok(Json::object([(
        "anchor",
        anchor_json(header.envelope().anchor()),
    )]))
}
