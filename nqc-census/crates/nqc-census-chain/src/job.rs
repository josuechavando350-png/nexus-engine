//! Deterministic acquisition jobs persisted through RMC-004.
//!
//! A job is a pure function of the replies it receives. Every well-formed
//! reply is recorded byte-for-byte before it is interpreted, every typed
//! RMC-003 observation derived from it is stored canonically, and a job
//! manifest binds them. The manifest and everything it names become the
//! evidence of one RMC-004 checkpoint, so:
//!
//! * resume = re-run the job against its recorded exchanges (no network);
//! * offline verification = re-run it from the store and require the manifest
//!   to reproduce byte-for-byte;
//! * a crash before the checkpoint leaves only content-addressed artifacts that
//!   a rerun reproduces identically.
//!
//! Transport failures and rate limits are never recorded as exchanges; they
//! are retried or fail the job.

use crate::error::ChainError;
use crate::ethereum::{verify_mainnet_header, VerifiedHeader};
use crate::hex;
use crate::json::Json;
use crate::provider::{PinningMode, ProviderSpec};
use crate::rpc::{self, ErrorClass, Reply, RpcCall};
use crate::transport::{Exchange, ReplayTransport, RetryPolicy, RpcClient, Transport};
use nqc_census_core::{
    Address, BlockHeaderEnvelope, CallContext, CallOutcome, CensusObservation, ChainDomain,
    ContractCallEnvelope, DeploymentKey, Hash32, LogTopic, ObservationPayload,
    ObservationProvenance, ObservationSemantics, ProvenanceAuthority, RawLogEnvelope,
    RuntimeCodeEnvelope, StateAnchor,
};
use nqc_census_store::{ArtifactId, Checkpoint, Store, StreamKind, StreamScope};
use sha2::{Digest, Sha256};

pub const JOB_MANIFEST_SCHEMA: &str = "nqc-census-job-manifest-v1";

/// Identity of a job: family, semantic version, stream namespace, parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec {
    family: String,
    version: u16,
    stream_namespace: u16,
    parameters: Json,
}

impl JobSpec {
    pub fn new(
        family: impl Into<String>,
        version: u16,
        stream_namespace: u16,
        parameters: Json,
    ) -> Result<Self, ChainError> {
        let spec = Self {
            family: family.into(),
            version,
            stream_namespace,
            parameters,
        };
        if spec.family.is_empty() || spec.version == 0 || spec.stream_namespace == 0 {
            return Err(ChainError::Config(
                "job family, version and namespace are required".into(),
            ));
        }
        spec.parameters.canonical()?;
        Ok(spec)
    }

    pub fn family(&self) -> &str {
        &self.family
    }

    pub const fn version(&self) -> u16 {
        self.version
    }

    pub const fn parameters(&self) -> &Json {
        &self.parameters
    }

    pub fn descriptor(&self, provider: &ProviderSpec) -> Json {
        Json::object([
            ("family", Json::string(self.family.clone())),
            ("version", Json::uint(u64::from(self.version))),
            ("provider", provider.descriptor()),
            ("parameters", self.parameters.clone()),
        ])
    }

    /// RMC-004 stream kind: its semantics hash binds family, version,
    /// provider and parameters, so no two jobs share a checkpoint chain.
    pub fn stream_kind(&self, provider: &ProviderSpec) -> Result<StreamKind, ChainError> {
        let digest: [u8; 32] = Sha256::digest(self.descriptor(provider).canonical()?).into();
        Ok(StreamKind::new(
            self.stream_namespace,
            self.version,
            Hash32::new(digest)?,
        )?)
    }

    pub fn scope(
        &self,
        provider: &ProviderSpec,
        chain: &ChainDomain,
        deployment: Option<DeploymentKey>,
        origin: &StateAnchor,
    ) -> Result<StreamScope, ChainError> {
        Ok(StreamScope::new(
            chain.clone(),
            deployment,
            self.stream_kind(provider)?,
            origin.block_number(),
            origin.parent_hash(),
        )?)
    }
}

/// Semantics attached to chain-level reads (headers, raw code) that are not
/// governed by any protocol deployment.
pub fn chain_read_semantics() -> Result<ObservationSemantics, ChainError> {
    let code: [u8; 32] = Sha256::digest(b"NQC-CENSUS-CHAIN-READ-SEMANTICS-V1").into();
    let config: [u8; 32] = Sha256::digest(b"NQC-CENSUS-ETHEREUM-HEADER-PROFILE-V1").into();
    Ok(ObservationSemantics::new(
        Hash32::new(code)?,
        Hash32::new(config)?,
    ))
}

fn sha(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// `eth_getLogs` filter: emitters and optional topic-0 alternatives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFilter {
    addresses: Vec<Address>,
    topic0: Vec<[u8; 32]>,
}

impl LogFilter {
    pub fn new(mut addresses: Vec<Address>, mut topic0: Vec<[u8; 32]>) -> Result<Self, ChainError> {
        addresses.sort();
        addresses.dedup();
        topic0.sort();
        topic0.dedup();
        if addresses.is_empty() {
            return Err(ChainError::Config(
                "log filter needs at least one emitter".into(),
            ));
        }
        Ok(Self { addresses, topic0 })
    }

    pub fn addresses(&self) -> &[Address] {
        &self.addresses
    }

    pub fn topic0(&self) -> &[[u8; 32]] {
        &self.topic0
    }

    pub fn descriptor(&self) -> Json {
        Json::object([
            (
                "addresses",
                Json::array(self.addresses.iter().map(|a| Json::string(a.to_hex()))),
            ),
            (
                "topic0",
                Json::array(self.topic0.iter().map(|t| Json::string(hex::encode(t)))),
            ),
        ])
    }

    fn call(&self, from: u64, to: u64) -> RpcCall {
        let mut members = vec![
            ("fromBlock", Json::string(hex::quantity(from))),
            ("toBlock", Json::string(hex::quantity(to))),
            (
                "address",
                Json::array(self.addresses.iter().map(|a| Json::string(a.to_hex()))),
            ),
        ];
        if !self.topic0.is_empty() {
            members.push((
                "topics",
                Json::array([Json::array(
                    self.topic0
                        .iter()
                        .map(|topic| Json::string(hex::encode(topic))),
                )]),
            ));
        }
        RpcCall::new("eth_getLogs", Json::array([Json::object(members)]))
    }

    fn accepts(&self, log: &RawLogEnvelope) -> bool {
        self.addresses.contains(&log.emitter())
            && (self.topic0.is_empty()
                || log
                    .topics()
                    .first()
                    .is_some_and(|topic| self.topic0.contains(topic.as_bytes())))
    }
}

/// A decoded log with the block it claims, before binding to a header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedLog {
    pub block_number: u64,
    pub block_hash: Hash32,
    pub log: RawLogEnvelope,
    /// Index of the exchange that returned this log.
    pub exchange: usize,
}

/// Execution context of one job on one provider.
pub struct JobContext<'a> {
    client: &'a RpcClient<'a>,
    chain: Option<ChainDomain>,
    exchanges: Vec<Exchange>,
    observations: Vec<Vec<u8>>,
}

impl<'a> JobContext<'a> {
    pub fn new(client: &'a RpcClient<'a>, chain: Option<ChainDomain>) -> Self {
        Self {
            client,
            chain,
            exchanges: Vec::new(),
            observations: Vec::new(),
        }
    }

    pub const fn provider(&self) -> &ProviderSpec {
        self.client.provider()
    }

    pub fn chain(&self) -> Result<&ChainDomain, ChainError> {
        self.chain
            .as_ref()
            .ok_or_else(|| ChainError::Config("job requires an established chain domain".into()))
    }

    fn provenance(
        &self,
        authority: ProvenanceAuthority,
        exchange: usize,
    ) -> Result<ObservationProvenance, ChainError> {
        let exchange = self
            .exchanges
            .get(exchange)
            .ok_or(ChainError::Rpc("unknown exchange"))?;
        Ok(ObservationProvenance::new(
            authority,
            self.provider().namespace(),
            self.provider().locator_hash()?,
            Hash32::new(sha(&exchange.request))?,
            Hash32::new(sha(&exchange.response))?,
        )?)
    }

    fn record<T: ObservationPayload>(
        &mut self,
        observation: &CensusObservation<T>,
    ) -> Result<(), ChainError> {
        self.observations.push(observation.canonical_bytes()?);
        Ok(())
    }

    fn single(&mut self, call: &RpcCall) -> Result<(Reply, usize), ChainError> {
        let (reply, exchange) = self.client.call(call)?;
        self.exchanges.push(exchange);
        Ok((reply, self.exchanges.len() - 1))
    }

    fn many(&mut self, calls: &[RpcCall]) -> Result<(Vec<Reply>, usize), ChainError> {
        if calls.len() == 1 {
            let (reply, index) = self.single(&calls[0])?;
            return Ok((vec![reply], index));
        }
        let (replies, exchange) = self.client.batch(calls)?;
        self.exchanges.push(exchange);
        Ok((replies, self.exchanges.len() - 1))
    }

    fn typed_error(&self, error: &rpc::RpcErrorObject) -> ChainError {
        let provider = self.provider().label().to_owned();
        let message = error.message.clone();
        match rpc::classify(error) {
            ErrorClass::RangeTooLarge => ChainError::RangeTooLarge { provider, message },
            ErrorClass::ArchiveUnavailable => {
                ChainError::ArchiveStateUnavailable { provider, message }
            }
            ErrorClass::RevertWithoutData => ChainError::AmbiguousRevert { provider },
            _ => ChainError::ProviderError {
                provider,
                code: error.code,
                message,
            },
        }
    }

    fn expect_result(&self, reply: Reply) -> Result<Json, ChainError> {
        match reply {
            Reply::Result(value) => Ok(value),
            Reply::Error(error) => Err(self.typed_error(&error)),
        }
    }

    /// A non-state call (e.g. `eth_chainId`, `web3_clientVersion`) whose
    /// exchange is recorded but which yields no chain observation.
    pub fn raw_result(&mut self, call: &RpcCall) -> Result<Json, ChainError> {
        let (reply, _) = self.single(call)?;
        self.expect_result(reply)
    }

    fn header_call_by_number(number: u64) -> RpcCall {
        RpcCall::new(
            "eth_getBlockByNumber",
            Json::array([Json::string(hex::quantity(number)), Json::Bool(false)]),
        )
    }

    fn verified_header(&self, reply: Reply, what: &str) -> Result<VerifiedHeader, ChainError> {
        let value = self.expect_result(reply)?;
        if value == Json::Null {
            return Err(ChainError::ArchiveStateUnavailable {
                provider: self.provider().label().to_owned(),
                message: format!("{what} returned null"),
            });
        }
        verify_mainnet_header(&value)
    }

    /// Verified header without an observation, for chain bootstrap (genesis
    /// and lineage blocks precede the chain domain they establish).
    pub fn bootstrap_header(&mut self, number: u64) -> Result<VerifiedHeader, ChainError> {
        let (reply, _) = self.single(&Self::header_call_by_number(number))?;
        let header = self.verified_header(reply, "bootstrap header")?;
        if header.number() != number {
            return Err(ChainError::Header(
                "provider returned a different block number",
            ));
        }
        Ok(header)
    }

    fn observe_header(
        &mut self,
        header: VerifiedHeader,
        exchange: usize,
    ) -> Result<CensusObservation<BlockHeaderEnvelope>, ChainError> {
        let envelope = header.into_envelope();
        let anchor = envelope.anchor(self.chain()?.clone())?;
        let observation = CensusObservation::observe(
            anchor,
            chain_read_semantics()?,
            self.provenance(ProvenanceAuthority::BlockHeader, exchange)?,
            envelope,
        )?;
        self.record(&observation)?;
        Ok(observation)
    }

    pub fn header_by_number(
        &mut self,
        number: u64,
    ) -> Result<CensusObservation<BlockHeaderEnvelope>, ChainError> {
        Ok(self.headers_by_number(&[number])?.remove(0))
    }

    /// Verified header observations for `numbers`, batched in input order.
    pub fn headers_by_number(
        &mut self,
        numbers: &[u64],
    ) -> Result<Vec<CensusObservation<BlockHeaderEnvelope>>, ChainError> {
        let mut out = Vec::with_capacity(numbers.len());
        for chunk in numbers.chunks(self.provider().max_batch()) {
            let calls: Vec<RpcCall> = chunk
                .iter()
                .map(|n| Self::header_call_by_number(*n))
                .collect();
            let (replies, exchange) = self.many(&calls)?;
            for (number, reply) in chunk.iter().zip(replies) {
                let header = self.verified_header(reply, "eth_getBlockByNumber")?;
                if header.number() != *number {
                    return Err(ChainError::Header(
                        "provider returned a different block number",
                    ));
                }
                out.push(self.observe_header(header, exchange)?);
            }
        }
        Ok(out)
    }

    pub fn header_by_hash(
        &mut self,
        hash: Hash32,
    ) -> Result<CensusObservation<BlockHeaderEnvelope>, ChainError> {
        let call = RpcCall::new(
            "eth_getBlockByHash",
            Json::array([Json::string(hash.to_hex()), Json::Bool(false)]),
        );
        let (reply, exchange) = self.single(&call)?;
        let header = self.verified_header(reply, "eth_getBlockByHash")?;
        if header.hash() != hash {
            return Err(ChainError::Header(
                "provider returned a different block hash",
            ));
        }
        self.observe_header(header, exchange)
    }

    fn block_parameter(&self, anchor: &StateAnchor) -> Json {
        match self.provider().pinning() {
            PinningMode::Eip1898 => Json::object([
                ("blockHash", Json::string(anchor.block_hash().to_hex())),
                ("requireCanonical", Json::Bool(true)),
            ]),
            PinningMode::NumberGuarded => Json::string(hex::quantity(anchor.block_number())),
        }
    }

    /// Number-pinned providers are bracketed by header-hash checks.
    fn guard(&mut self, anchor: &StateAnchor) -> Result<(), ChainError> {
        if self.provider().pinning() == PinningMode::NumberGuarded {
            let (reply, _) = self.single(&Self::header_call_by_number(anchor.block_number()))?;
            let header = self.verified_header(reply, "guard header")?;
            if header.hash() != anchor.block_hash() {
                return Err(ChainError::NonCanonical {
                    what: "state read",
                    detail: format!("block {} changed hash", anchor.block_number()),
                });
            }
        }
        Ok(())
    }

    /// Runtime code of `accounts` at `anchor`, batched in input order.
    pub fn codes(
        &mut self,
        accounts: &[Address],
        anchor: &StateAnchor,
        semantics: ObservationSemantics,
    ) -> Result<Vec<CensusObservation<RuntimeCodeEnvelope>>, ChainError> {
        let mut out = Vec::with_capacity(accounts.len());
        for chunk in accounts.chunks(self.provider().max_batch()) {
            self.guard(anchor)?;
            let calls: Vec<RpcCall> = chunk
                .iter()
                .map(|account| {
                    RpcCall::new(
                        "eth_getCode",
                        Json::array([Json::string(account.to_hex()), self.block_parameter(anchor)]),
                    )
                })
                .collect();
            let (replies, exchange) = self.many(&calls)?;
            self.guard(anchor)?;
            for (account, reply) in chunk.iter().zip(replies) {
                let value = self.expect_result(reply)?;
                let code = hex::decode_data(
                    value
                        .as_str()
                        .ok_or(ChainError::Rpc("code is not a string"))?,
                )?;
                let observation = CensusObservation::observe(
                    anchor.clone(),
                    semantics,
                    self.provenance(ProvenanceAuthority::CodeRead, exchange)?,
                    RuntimeCodeEnvelope::new(*account, code)?,
                )?;
                self.record(&observation)?;
                out.push(observation);
            }
        }
        Ok(out)
    }

    pub fn code(
        &mut self,
        account: Address,
        anchor: &StateAnchor,
        semantics: ObservationSemantics,
    ) -> Result<CensusObservation<RuntimeCodeEnvelope>, ChainError> {
        Ok(self.codes(&[account], anchor, semantics)?.remove(0))
    }

    /// Calls at one anchor, batched deterministically in input order.
    /// Returned data and revert data become observations; any other error
    /// fails the job.
    pub fn calls(
        &mut self,
        requests: &[(Address, Vec<u8>)],
        anchor: &StateAnchor,
        semantics: ObservationSemantics,
    ) -> Result<Vec<CensusObservation<ContractCallEnvelope>>, ChainError> {
        self.calls_in_context(requests, CallContext::static_read(), anchor, semantics)
    }

    fn call_object(target: Address, data: &[u8], context: &CallContext) -> Json {
        let mut members = vec![
            ("to", Json::string(target.to_hex())),
            ("data", Json::string(hex::encode(data))),
        ];
        if let Some(caller) = context.caller() {
            members.push(("from", Json::string(caller.to_hex())));
        }
        let value = context.value();
        if value.iter().any(|byte| *byte != 0) {
            let first = value.iter().position(|byte| *byte != 0).unwrap_or(31);
            let digits = hex::plain(&value[first..]);
            let trimmed = digits.trim_start_matches('0');
            members.push(("value", Json::string(format!("0x{trimmed}"))));
        }
        if let Some(gas) = context.gas_limit() {
            members.push(("gas", Json::string(hex::quantity(gas))));
        }
        Json::object(members)
    }

    /// Calls at one anchor under an explicit call context (e.g. an admin-only
    /// proxy getter read with `from` = the proxy admin). The context is bound
    /// into every CONTRACT_CALL observation.
    pub fn calls_in_context(
        &mut self,
        requests: &[(Address, Vec<u8>)],
        context: CallContext,
        anchor: &StateAnchor,
        semantics: ObservationSemantics,
    ) -> Result<Vec<CensusObservation<ContractCallEnvelope>>, ChainError> {
        let mut out = Vec::with_capacity(requests.len());
        for chunk in requests.chunks(self.provider().max_batch()) {
            self.guard(anchor)?;
            let calls: Vec<RpcCall> = chunk
                .iter()
                .map(|(target, data)| {
                    RpcCall::new(
                        "eth_call",
                        Json::array([
                            Self::call_object(*target, data, &context),
                            self.block_parameter(anchor),
                        ]),
                    )
                })
                .collect();
            let (replies, exchange) = self.many(&calls)?;
            self.guard(anchor)?;
            for ((target, data), reply) in chunk.iter().zip(replies) {
                let outcome = match reply {
                    Reply::Result(value) => CallOutcome::Returned(hex::decode_data(
                        value
                            .as_str()
                            .ok_or(ChainError::Rpc("call result is not a string"))?,
                    )?),
                    Reply::Error(error) => match rpc::classify(&error) {
                        ErrorClass::Revert(bytes) => CallOutcome::Reverted(bytes),
                        _ => return Err(self.typed_error(&error)),
                    },
                };
                let observation = CensusObservation::observe(
                    anchor.clone(),
                    semantics,
                    self.provenance(ProvenanceAuthority::ContractCall, exchange)?,
                    ContractCallEnvelope::new(*target, context, data.clone(), outcome)?,
                )?;
                self.record(&observation)?;
                out.push(observation);
            }
        }
        Ok(out)
    }

    pub fn call(
        &mut self,
        target: Address,
        calldata: Vec<u8>,
        anchor: &StateAnchor,
        semantics: ObservationSemantics,
    ) -> Result<CensusObservation<ContractCallEnvelope>, ChainError> {
        Ok(self
            .calls(&[(target, calldata)], anchor, semantics)?
            .remove(0))
    }

    /// Logs over `[first, last]`, split into `log_window`-sized sub-ranges and
    /// batched. Output is canonically ordered by (block, log index) and every
    /// log must match the filter and range.
    pub fn logs(
        &mut self,
        filter: &LogFilter,
        first: u64,
        last: u64,
    ) -> Result<Vec<ClaimedLog>, ChainError> {
        if first > last {
            return Err(ChainError::Config("empty log range".into()));
        }
        let window = self.provider().log_window();
        let mut ranges = Vec::new();
        let mut start = first;
        loop {
            let end = start.saturating_add(window - 1).min(last);
            ranges.push((start, end));
            if end == last {
                break;
            }
            start = end + 1;
        }
        let mut logs = Vec::new();
        for chunk in ranges.chunks(self.provider().max_batch()) {
            let calls: Vec<RpcCall> = chunk.iter().map(|(a, b)| filter.call(*a, *b)).collect();
            let (replies, exchange) = self.many(&calls)?;
            for ((from, to), reply) in chunk.iter().zip(replies) {
                let value = self.expect_result(reply)?;
                for item in value
                    .as_array()
                    .ok_or(ChainError::Rpc("logs result is not an array"))?
                {
                    let log = decode_log(item, exchange)?;
                    if log.block_number < *from || log.block_number > *to {
                        return Err(ChainError::Rpc("log outside the requested range"));
                    }
                    if !filter.accepts(&log.log) {
                        return Err(ChainError::Rpc("log outside the requested filter"));
                    }
                    logs.push(log);
                }
            }
        }
        logs.sort_by_key(|log| (log.block_number, log.log.log_index()));
        if logs.windows(2).any(|pair| {
            (pair[0].block_number, pair[0].log.log_index())
                == (pair[1].block_number, pair[1].log.log_index())
        }) {
            return Err(ChainError::Rpc("duplicate log coordinates"));
        }
        Ok(logs)
    }

    /// Binds a claimed log to the verified header of its block. A log whose
    /// block hash is not the canonical header hash at that height is an orphan
    /// and fails closed.
    pub fn observe_log(
        &mut self,
        claimed: &ClaimedLog,
        header: &CensusObservation<BlockHeaderEnvelope>,
        semantics: ObservationSemantics,
    ) -> Result<CensusObservation<RawLogEnvelope>, ChainError> {
        let anchor = header.envelope().anchor().clone();
        if anchor.block_number() != claimed.block_number
            || anchor.block_hash() != claimed.block_hash
        {
            return Err(ChainError::NonCanonical {
                what: "log",
                detail: format!(
                    "log claims block {} {} but the canonical header is {}",
                    claimed.block_number,
                    claimed.block_hash.to_hex(),
                    anchor.block_hash().to_hex()
                ),
            });
        }
        let observation = CensusObservation::observe(
            anchor,
            semantics,
            self.provenance(ProvenanceAuthority::ReceiptLog, claimed.exchange)?,
            claimed.log.clone(),
        )?;
        self.record(&observation)?;
        Ok(observation)
    }

    /// Seals the job: manifest binding every exchange, observation and the
    /// canonical result.
    pub fn finish(self, spec: &JobSpec, result: &Json) -> Result<JobOutput, ChainError> {
        let result_bytes = result.canonical()?;
        let mut artifacts: Vec<Vec<u8>> = Vec::new();
        let mut exchange_refs = Vec::with_capacity(self.exchanges.len());
        for exchange in &self.exchanges {
            exchange_refs.push(Json::object([
                ("request", Json::string(hex::plain(&sha(&exchange.request)))),
                (
                    "response",
                    Json::string(hex::plain(&sha(&exchange.response))),
                ),
            ]));
            artifacts.push(exchange.request.clone());
            artifacts.push(exchange.response.clone());
        }
        let observation_refs: Vec<Json> = self
            .observations
            .iter()
            .map(|bytes| Json::string(hex::plain(&sha(bytes))))
            .collect();
        artifacts.extend(self.observations.iter().cloned());
        artifacts.push(result_bytes.clone());
        let manifest = Json::object([
            ("schema", Json::string(JOB_MANIFEST_SCHEMA)),
            ("job", spec.descriptor(self.client.provider())),
            ("exchanges", Json::Array(exchange_refs)),
            ("observations", Json::Array(observation_refs)),
            ("result", Json::string(hex::plain(&sha(&result_bytes)))),
        ])
        .canonical()?;
        Ok(JobOutput {
            manifest,
            artifacts,
            result: result_bytes,
            observations: self.observations,
        })
    }
}

fn decode_log(item: &Json, exchange: usize) -> Result<ClaimedLog, ChainError> {
    const ALLOWED: [&str; 10] = [
        "address",
        "topics",
        "data",
        "blockNumber",
        "blockHash",
        "transactionHash",
        "transactionIndex",
        "logIndex",
        "removed",
        "blockTimestamp",
    ];
    let members = item
        .as_object()
        .ok_or(ChainError::Rpc("log is not an object"))?;
    if let Some((key, _)) = members
        .iter()
        .find(|(key, _)| !ALLOWED.contains(&key.as_str()))
    {
        return Err(ChainError::NonCanonical {
            what: "log member",
            detail: key.clone(),
        });
    }
    if item.get("removed").and_then(Json::as_bool) != Some(false) {
        return Err(ChainError::NonCanonical {
            what: "log",
            detail: "provider returned a removed or unflagged log".into(),
        });
    }
    let topics = item
        .get("topics")
        .and_then(Json::as_array)
        .ok_or(ChainError::Rpc("log topics missing"))?
        .iter()
        .map(|topic| {
            let text = topic
                .as_str()
                .ok_or(ChainError::Rpc("topic not a string"))?;
            // A topic is an ABI word and may be all zero (e.g. an indexed
            // zero address); transaction and block hashes stay nonzero.
            Ok(LogTopic::new(hex::decode_fixed::<32>(text)?))
        })
        .collect::<Result<Vec<_>, ChainError>>()?;
    let quantity_u32 = |key: &str| -> Result<u32, ChainError> {
        u32::try_from(hex::decode_quantity_u64(item.str_field(key)?)?)
            .map_err(|_| ChainError::Rpc("log index exceeds u32"))
    };
    let log = RawLogEnvelope::with_topics(
        Address::new(hex::decode_fixed::<20>(item.str_field("address")?)?)?,
        Hash32::new(hex::decode_fixed::<32>(item.str_field("transactionHash")?)?)?,
        quantity_u32("transactionIndex")?,
        quantity_u32("logIndex")?,
        topics,
        hex::decode_data(item.str_field("data")?)?,
        false,
    )?;
    Ok(ClaimedLog {
        block_number: hex::decode_quantity_u64(item.str_field("blockNumber")?)?,
        block_hash: Hash32::new(hex::decode_fixed::<32>(item.str_field("blockHash")?)?)?,
        log,
        exchange,
    })
}

/// Everything a finished job produced, ready to persist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutput {
    pub manifest: Vec<u8>,
    pub artifacts: Vec<Vec<u8>>,
    pub result: Vec<u8>,
    pub observations: Vec<Vec<u8>>,
}

impl JobOutput {
    pub fn manifest_id(&self) -> ArtifactId {
        ArtifactId::of(&self.manifest)
    }

    pub fn result_json(&self) -> Result<Json, ChainError> {
        Json::parse(&self.result)
    }

    /// Persists every artifact, then commits one checkpoint over
    /// `[first, last]` whose evidence is the manifest plus all artifacts.
    pub fn commit(
        &self,
        store: &Store,
        scope: &StreamScope,
        first: StateAnchor,
        last: StateAnchor,
    ) -> Result<ArtifactId, ChainError> {
        let mut evidence = Vec::with_capacity(self.artifacts.len() + 1);
        for artifact in &self.artifacts {
            evidence.push(store.put_artifact(artifact)?.id);
        }
        let manifest = store.put_artifact(&self.manifest)?.id;
        evidence.push(manifest);
        store.register_stream(scope)?;
        let resume = store.resume(scope)?;
        let checkpoint = Checkpoint::next(scope, &resume, first, last, evidence)?;
        store.commit(scope, &checkpoint)?;
        Ok(manifest)
    }
}

/// Rebuilds the replay transport of a manifest from the store.
pub fn replay_from_manifest(
    store: &Store,
    manifest: &[u8],
    provider: &ProviderSpec,
) -> Result<ReplayTransport, ChainError> {
    let mut replay = ReplayTransport::new();
    add_manifest_exchanges(&mut replay, store, manifest, provider)?;
    Ok(replay)
}

/// Adds every exchange a manifest names to `replay` (for whole-run replays
/// across many jobs of one provider).
pub fn add_manifest_exchanges(
    replay: &mut ReplayTransport,
    store: &Store,
    manifest: &[u8],
    provider: &ProviderSpec,
) -> Result<(), ChainError> {
    let document = Json::parse(manifest)?;
    if document.get("schema").and_then(Json::as_str) != Some(JOB_MANIFEST_SCHEMA) {
        return Err(ChainError::Evidence("not a job manifest".into()));
    }
    for exchange in document
        .get("exchanges")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("manifest without exchanges".into()))?
    {
        let fetch = |key: &str| -> Result<Vec<u8>, ChainError> {
            let id = ArtifactId::parse_hex(exchange.str_field(key)?)?;
            Ok(store.get_artifact(&id)?)
        };
        replay.record(provider.namespace(), &fetch("request")?, fetch("response")?);
    }
    Ok(())
}

/// Runs a job function against a transport and returns its output.
pub fn run_job<F>(
    transport: &dyn Transport,
    provider: &ProviderSpec,
    retry: RetryPolicy,
    chain: Option<ChainDomain>,
    spec: &JobSpec,
    body: F,
) -> Result<JobOutput, ChainError>
where
    F: FnOnce(&mut JobContext<'_>) -> Result<Json, ChainError>,
{
    let client = RpcClient::new(transport, provider.clone(), retry);
    let mut context = JobContext::new(&client, chain);
    let result = body(&mut context)?;
    context.finish(spec, &result)
}

/// Offline verification: re-executes the job from its recorded exchanges and
/// requires the manifest to reproduce byte-for-byte.
pub fn verify_job_replay<F>(
    store: &Store,
    manifest_id: &ArtifactId,
    provider: &ProviderSpec,
    chain: Option<ChainDomain>,
    spec: &JobSpec,
    body: F,
) -> Result<JobOutput, ChainError>
where
    F: FnOnce(&mut JobContext<'_>) -> Result<Json, ChainError>,
{
    let manifest = store.get_artifact(manifest_id)?;
    let replay = replay_from_manifest(store, &manifest, provider)?;
    let output = run_job(&replay, provider, RetryPolicy::none(), chain, spec, body)?;
    if output.manifest != manifest {
        return Err(ChainError::Evidence(format!(
            "job {} does not reproduce from its recorded exchanges",
            spec.family()
        )));
    }
    Ok(output)
}
