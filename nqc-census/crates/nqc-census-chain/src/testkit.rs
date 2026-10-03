//! Synthetic JSON-RPC chain for adversarial tests.
//!
//! SYNTHETIC ONLY: nothing produced here is chain evidence. Headers are real
//! canonical RLP with keccak-verified hashes, so every verifier path runs
//! unchanged; the chain, code, calls and logs are whatever a test declares.
//! Providers are served from one chain with optional per-provider faults
//! (omitted logs, orphan logs, forked headers) to exercise fail-closed paths.

use crate::error::ChainError;
use crate::ethereum::{header_rlp, ChainProfile};
use crate::hex;
use crate::json::Json;
use crate::provider::{PinningMode, ProviderSpec};
use crate::transport::{HttpReply, Transport};
use nqc_census_core::{keccak256, Address, CallOutcome, Hash32};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const SIM_PRAGUE_TIME: u64 = 1_750_000_000;

#[derive(Debug, Clone)]
struct SimBlock {
    hash: [u8; 32],
    object: Json,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimLog {
    pub block: u64,
    pub transaction_index: u32,
    pub log_index: u32,
    pub address: Address,
    pub topics: Vec<[u8; 32]>,
    pub data: Vec<u8>,
}

#[derive(Debug, Clone)]
struct CodeSpan {
    account: Address,
    from: u64,
    until: Option<u64>,
    code: Vec<u8>,
}

#[derive(Debug, Clone)]
struct CallRule {
    target: Address,
    caller: Option<Address>,
    calldata: Vec<u8>,
    from: u64,
    until: Option<u64>,
    outcome: CallOutcome,
}

/// Faults a specific provider injects.
#[derive(Debug, Clone, Default)]
pub struct Faults {
    pub omit_logs: BTreeSet<(u64, u32)>,
    pub orphan_log_hash: BTreeSet<(u64, u32)>,
    pub forked_headers: BTreeSet<u64>,
    pub archive_before: Option<u64>,
    pub rate_limit_first: u64,
}

#[derive(Debug, Clone)]
pub struct SimChain {
    chain_id: u64,
    genesis: SimBlock,
    lineage: (u64, SimBlock),
    base: u64,
    blocks: Vec<SimBlock>,
    codes: Vec<CodeSpan>,
    calls: Vec<CallRule>,
    logs: Vec<SimLog>,
}

fn word(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn block_object(
    number: u64,
    parent: [u8; 32],
    timestamp: u64,
    salt: u8,
) -> Result<SimBlock, ChainError> {
    let mut members: Vec<(&str, Json)> = vec![
        ("parentHash", Json::string(hex::encode(&parent))),
        ("sha3Uncles", Json::string(hex::encode(&word(0x1d)))),
        ("miner", Json::string(hex::encode(&[0xbe; 20]))),
        (
            "stateRoot",
            Json::string(hex::encode(&keccak256(
                &[&number.to_be_bytes()[..], &[salt, 1]].concat(),
            ))),
        ),
        ("transactionsRoot", Json::string(hex::encode(&word(0x7a)))),
        ("receiptsRoot", Json::string(hex::encode(&word(0x8a)))),
        ("logsBloom", Json::string(hex::encode(&[0_u8; 256]))),
        ("difficulty", Json::string("0x0")),
        ("number", Json::string(hex::quantity(number))),
        ("gasLimit", Json::string(hex::quantity(30_000_000))),
        ("gasUsed", Json::string(hex::quantity(1_000_000))),
        ("timestamp", Json::string(hex::quantity(timestamp))),
        ("extraData", Json::string(hex::encode(&[salt]))),
        ("mixHash", Json::string(hex::encode(&word(0x3c)))),
        ("nonce", Json::string(hex::encode(&[0_u8; 8]))),
    ];
    let era = crate::ethereum::HeaderEra::mainnet(number, timestamp);
    if era == crate::ethereum::HeaderEra::Prague {
        members.extend([
            ("baseFeePerGas", Json::string(hex::quantity(7))),
            ("withdrawalsRoot", Json::string(hex::encode(&word(0x9a)))),
            ("blobGasUsed", Json::string("0x0")),
            ("excessBlobGas", Json::string("0x0")),
            (
                "parentBeaconBlockRoot",
                Json::string(hex::encode(&word(0x4b))),
            ),
            ("requestsHash", Json::string(hex::encode(&word(0x6c)))),
        ]);
    } else if era != crate::ethereum::HeaderEra::Frontier {
        return Err(ChainError::Config(
            "testkit builds Frontier or Prague headers only".into(),
        ));
    }
    let object = Json::object(members);
    let (rlp, _) = header_rlp(&object)?;
    let hash = keccak256(&rlp);
    let Json::Object(mut members) = object else {
        return Err(ChainError::Config("header is not an object".into()));
    };
    members.push(("hash".into(), Json::string(hex::encode(&hash))));
    members.push(("transactions".into(), Json::array([])));
    members.push(("uncles".into(), Json::array([])));
    Ok(SimBlock {
        hash,
        object: Json::Object(members),
    })
}

impl SimChain {
    /// A chain whose blocks `[base, base + length)` exist and link by parent
    /// hash; genesis and a lineage block exist for chain-domain bootstrap.
    pub fn new(chain_id: u64, base: u64, length: u64) -> Result<Self, ChainError> {
        if base < 20_000_000 || length == 0 {
            return Err(ChainError::Config(
                "testkit chain must start in the Prague era".into(),
            ));
        }
        let genesis = block_object(0, [0; 32], 0, 0)?;
        let lineage = block_object(1, genesis.hash, 15, 1)?;
        let mut chain = Self {
            chain_id,
            genesis,
            lineage: (1, lineage),
            base,
            blocks: Vec::new(),
            codes: Vec::new(),
            calls: Vec::new(),
            logs: Vec::new(),
        };
        chain.rebuild_from(base, length, 0)?;
        Ok(chain)
    }

    fn rebuild_from(&mut self, from: u64, length: u64, salt: u8) -> Result<(), ChainError> {
        let keep =
            usize::try_from(from - self.base).map_err(|_| ChainError::Config("range".into()))?;
        self.blocks.truncate(keep);
        let mut parent = self.blocks.last().map_or(word(0x55), |block| block.hash);
        for number in from..self.base + length {
            let block = block_object(
                number,
                parent,
                SIM_PRAGUE_TIME + 12 * (number - self.base),
                salt,
            )?;
            parent = block.hash;
            self.blocks.push(block);
        }
        Ok(())
    }

    /// Replaces blocks `from..` with a new branch (a reorg), keeping length.
    pub fn reorg_from(&mut self, from: u64, salt: u8) -> Result<(), ChainError> {
        let length = self.blocks.len() as u64;
        self.rebuild_from(from, length, salt)
    }

    /// Appends `count` blocks.
    pub fn extend(&mut self, count: u64) -> Result<(), ChainError> {
        let length = self.blocks.len() as u64 + count;
        let from = self.base + self.blocks.len() as u64;
        let salt = self
            .blocks
            .last()
            .and_then(|b| {
                b.object
                    .get("extraData")
                    .and_then(Json::as_str)
                    .map(str::to_owned)
            })
            .and_then(|text| hex::decode_data(&text).ok())
            .and_then(|bytes| bytes.first().copied())
            .unwrap_or(0);
        self.rebuild_tail(from, length, salt)
    }

    fn rebuild_tail(&mut self, from: u64, length: u64, salt: u8) -> Result<(), ChainError> {
        let mut parent = self.blocks.last().map_or(word(0x55), |block| block.hash);
        for number in from..self.base + length {
            let block = block_object(
                number,
                parent,
                SIM_PRAGUE_TIME + 12 * (number - self.base),
                salt,
            )?;
            parent = block.hash;
            self.blocks.push(block);
        }
        Ok(())
    }

    pub fn profile(&self) -> Result<ChainProfile, ChainError> {
        ChainProfile::new(
            self.chain_id,
            Hash32::new(self.genesis.hash)?,
            self.lineage.0,
            Hash32::new(self.lineage.1.hash)?,
        )
    }

    pub const fn base(&self) -> u64 {
        self.base
    }

    pub fn tip(&self) -> u64 {
        self.base + self.blocks.len() as u64 - 1
    }

    pub fn hash_of(&self, number: u64) -> Option<Hash32> {
        self.block(number).and_then(|b| Hash32::new(b.hash).ok())
    }

    fn block(&self, number: u64) -> Option<&SimBlock> {
        match number {
            0 => Some(&self.genesis),
            n if n == self.lineage.0 => Some(&self.lineage.1),
            n if n >= self.base => self.blocks.get(usize::try_from(n - self.base).ok()?),
            _ => None,
        }
    }

    fn number_of_hash(&self, hash: &[u8; 32]) -> Option<u64> {
        if *hash == self.genesis.hash {
            return Some(0);
        }
        if *hash == self.lineage.1.hash {
            return Some(self.lineage.0);
        }
        self.blocks
            .iter()
            .position(|block| block.hash == *hash)
            .map(|index| self.base + index as u64)
    }

    /// Declares `code` at `account` from block `from` until (excluding) `until`.
    pub fn set_code(&mut self, account: Address, from: u64, until: Option<u64>, code: Vec<u8>) {
        self.codes.push(CodeSpan {
            account,
            from,
            until,
            code,
        });
    }

    /// Declares the outcome of `calldata` on `target` over a block interval.
    pub fn set_call(
        &mut self,
        target: Address,
        calldata: Vec<u8>,
        from: u64,
        until: Option<u64>,
        outcome: CallOutcome,
    ) {
        self.calls.push(CallRule {
            target,
            caller: None,
            calldata,
            from,
            until,
            outcome,
        });
    }

    /// Like `set_call`, but the rule only answers calls made from `caller`
    /// (e.g. admin-only proxy getters).
    pub fn set_call_from(
        &mut self,
        target: Address,
        caller: Address,
        calldata: Vec<u8>,
        from: u64,
        until: Option<u64>,
        outcome: CallOutcome,
    ) {
        self.calls.push(CallRule {
            target,
            caller: Some(caller),
            calldata,
            from,
            until,
            outcome,
        });
    }

    pub fn add_log(&mut self, log: SimLog) {
        self.logs.push(log);
    }

    pub fn remove_logs_from(&mut self, block: u64) {
        self.logs.retain(|log| log.block < block);
    }

    fn code_at(&self, account: &Address, number: u64) -> Vec<u8> {
        self.codes
            .iter()
            .rev()
            .find(|span| {
                span.account == *account
                    && number >= span.from
                    && span.until.is_none_or(|until| number < until)
            })
            .map(|span| span.code.clone())
            .unwrap_or_default()
    }

    fn call_at(
        &self,
        target: &Address,
        caller: Option<&Address>,
        calldata: &[u8],
        number: u64,
    ) -> CallOutcome {
        self.calls
            .iter()
            .rev()
            .find(|rule| {
                rule.target == *target
                    && rule
                        .caller
                        .as_ref()
                        .is_none_or(|expected| Some(expected) == caller)
                    && rule.calldata == calldata
                    && number >= rule.from
                    && rule.until.is_none_or(|until| number < until)
            })
            .map_or(CallOutcome::Reverted(Vec::new()), |rule| {
                rule.outcome.clone()
            })
    }
}

/// One provider's view of a shared simulated chain.
pub struct SimProvider {
    chain: std::sync::Arc<Mutex<SimChain>>,
    faults: Faults,
    log_window: u64,
    served: AtomicU64,
}

impl SimProvider {
    pub fn new(chain: std::sync::Arc<Mutex<SimChain>>, faults: Faults, log_window: u64) -> Self {
        Self {
            chain,
            faults,
            log_window,
            served: AtomicU64::new(0),
        }
    }

    pub fn spec(
        namespace: u16,
        label: &str,
        log_window: u64,
        max_batch: usize,
    ) -> Result<ProviderSpec, ChainError> {
        ProviderSpec::new(
            namespace,
            label,
            format!("replay://sim/{label}"),
            format!("synthetic operator {label}"),
            0,
            max_batch,
            log_window,
            PinningMode::Eip1898,
        )
    }

    pub fn requests_served(&self) -> u64 {
        self.served.load(Ordering::SeqCst)
    }

    fn error(id: &Json, code: i64, message: &str, data: Option<Json>) -> Json {
        let mut error = vec![
            ("code", Json::int(code)),
            ("message", Json::string(message)),
        ];
        if let Some(data) = data {
            error.push(("data", data));
        }
        Json::object([
            ("jsonrpc", Json::string("2.0")),
            ("id", id.clone()),
            ("error", Json::object(error)),
        ])
    }

    fn ok(id: &Json, result: Json) -> Json {
        Json::object([
            ("jsonrpc", Json::string("2.0")),
            ("id", id.clone()),
            ("result", result),
        ])
    }

    fn resolve_block(chain: &SimChain, parameter: &Json) -> Option<u64> {
        if let Some(text) = parameter.as_str() {
            return hex::decode_quantity_u64(text).ok();
        }
        let hash = hex::decode_fixed::<32>(parameter.get("blockHash")?.as_str()?).ok()?;
        chain.number_of_hash(&hash)
    }

    fn header(&self, chain: &SimChain, number: u64) -> Result<Json, ChainError> {
        let Some(block) = chain.block(number) else {
            return Ok(Json::Null);
        };
        if self.faults.forked_headers.contains(&number) {
            let parent = chain.block(number - 1).map_or([0x42; 32], |b| b.hash);
            let fork = block_object(
                number,
                parent,
                SIM_PRAGUE_TIME + 12 * (number - chain.base),
                0xee,
            )?;
            return Ok(fork.object);
        }
        Ok(block.object.clone())
    }

    fn handle(&self, request: &Json) -> Result<Json, ChainError> {
        let id = request.get("id").cloned().unwrap_or(Json::Null);
        let method = request.str_field("method")?;
        let params = request
            .get("params")
            .and_then(Json::as_array)
            .unwrap_or_default();
        let chain = self
            .chain
            .lock()
            .map_err(|_| ChainError::Config("simulated chain poisoned".into()))?;
        let served = self.served.fetch_add(1, Ordering::SeqCst);
        if served < self.faults.rate_limit_first {
            return Ok(Self::error(&id, 429, "rate limit exceeded", None));
        }
        let archive_ok = |number: u64| {
            self.faults
                .archive_before
                .is_none_or(|limit| number >= limit)
        };
        Ok(match method {
            "eth_chainId" => Self::ok(&id, Json::string(hex::quantity(chain.chain_id))),
            "web3_clientVersion" => Self::ok(&id, Json::string("nqc-census-testkit/1")),
            "eth_getBlockByNumber" => {
                let number = params
                    .first()
                    .and_then(Json::as_str)
                    .map(hex::decode_quantity_u64)
                    .transpose()?
                    .ok_or(ChainError::Rpc("block number"))?;
                Self::ok(&id, self.header(&chain, number)?)
            }
            "eth_getBlockByHash" => {
                let hash =
                    hex::decode_fixed::<32>(params.first().and_then(Json::as_str).unwrap_or("0x"))?;
                match chain.number_of_hash(&hash) {
                    Some(number) => Self::ok(&id, self.header(&chain, number)?),
                    None => Self::ok(&id, Json::Null),
                }
            }
            "eth_getCode" => {
                let account = Address::new(hex::decode_fixed::<20>(
                    params.first().and_then(Json::as_str).unwrap_or("0x"),
                )?)?;
                match params.get(1).and_then(|p| Self::resolve_block(&chain, p)) {
                    Some(number) if archive_ok(number) => Self::ok(
                        &id,
                        Json::string(hex::encode(&chain.code_at(&account, number))),
                    ),
                    Some(_) => Self::error(&id, -32000, "missing trie node", None),
                    None => Self::error(&id, -32000, "header not found", None),
                }
            }
            "eth_call" => {
                let call = params.first().ok_or(ChainError::Rpc("call object"))?;
                let target = Address::new(hex::decode_fixed::<20>(call.str_field("to")?)?)?;
                let data = hex::decode_data(call.str_field("data")?)?;
                let caller = call
                    .get("from")
                    .and_then(Json::as_str)
                    .map(hex::decode_fixed::<20>)
                    .transpose()?
                    .map(Address::new)
                    .transpose()?;
                match params.get(1).and_then(|p| Self::resolve_block(&chain, p)) {
                    Some(number) if archive_ok(number) => {
                        match chain.call_at(&target, caller.as_ref(), &data, number) {
                            CallOutcome::Returned(bytes) => {
                                Self::ok(&id, Json::string(hex::encode(&bytes)))
                            }
                            CallOutcome::Reverted(bytes) => Self::error(
                                &id,
                                3,
                                "execution reverted",
                                Some(Json::string(hex::encode(&bytes))),
                            ),
                        }
                    }
                    Some(_) => Self::error(&id, -32000, "missing trie node", None),
                    None => Self::error(&id, -32000, "header not found", None),
                }
            }
            "eth_getLogs" => {
                let filter = params.first().ok_or(ChainError::Rpc("filter"))?;
                let from = hex::decode_quantity_u64(filter.str_field("fromBlock")?)?;
                let to = hex::decode_quantity_u64(filter.str_field("toBlock")?)?;
                if to < from || to - from + 1 > self.log_window {
                    return Ok(Self::error(&id, -32600, "block range too large", None));
                }
                let addresses: Vec<Address> = filter
                    .get("address")
                    .and_then(Json::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|a| a.as_str().and_then(|t| hex::decode_fixed::<20>(t).ok()))
                    .filter_map(|bytes| Address::new(bytes).ok())
                    .collect();
                let topics: Vec<[u8; 32]> = filter
                    .get("topics")
                    .and_then(Json::as_array)
                    .and_then(|t| t.first())
                    .and_then(Json::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|t| t.as_str().and_then(|x| hex::decode_fixed::<32>(x).ok()))
                    .collect();
                let mut items = Vec::new();
                for log in &chain.logs {
                    if log.block < from || log.block > to || !addresses.contains(&log.address) {
                        continue;
                    }
                    if !topics.is_empty() && !log.topics.first().is_some_and(|t| topics.contains(t))
                    {
                        continue;
                    }
                    if self.faults.omit_logs.contains(&(log.block, log.log_index)) {
                        continue;
                    }
                    let Some(block) = chain.block(log.block) else {
                        continue;
                    };
                    let block_hash = if self
                        .faults
                        .orphan_log_hash
                        .contains(&(log.block, log.log_index))
                    {
                        [0xdd; 32]
                    } else {
                        block.hash
                    };
                    let transaction_hash = keccak256(
                        &[
                            &log.block.to_be_bytes()[..],
                            &log.transaction_index.to_be_bytes(),
                        ]
                        .concat(),
                    );
                    items.push(Json::object([
                        ("address", Json::string(log.address.to_hex())),
                        (
                            "topics",
                            Json::array(log.topics.iter().map(|t| Json::string(hex::encode(t)))),
                        ),
                        ("data", Json::string(hex::encode(&log.data))),
                        ("blockNumber", Json::string(hex::quantity(log.block))),
                        ("blockHash", Json::string(hex::encode(&block_hash))),
                        (
                            "transactionHash",
                            Json::string(hex::encode(&transaction_hash)),
                        ),
                        (
                            "transactionIndex",
                            Json::string(hex::quantity(u64::from(log.transaction_index))),
                        ),
                        (
                            "logIndex",
                            Json::string(hex::quantity(u64::from(log.log_index))),
                        ),
                        ("removed", Json::Bool(false)),
                    ]));
                }
                Self::ok(&id, Json::Array(items))
            }
            _ => Self::error(&id, -32601, "method not found", None),
        })
    }
}

impl Transport for SimProvider {
    fn post(&self, _provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let request = Json::parse(body)?;
        let response = match &request {
            Json::Array(items) => {
                let mut out = Vec::with_capacity(items.len());
                for item in items {
                    out.push(self.handle(item)?);
                }
                // Reverse to prove order independence of batch matching.
                out.reverse();
                Json::Array(out)
            }
            single => self.handle(single)?,
        };
        Ok(HttpReply {
            status: 200,
            body: response.canonical()?,
        })
    }
}

/// Routes each provider to its own simulated view.
pub struct SimNetwork {
    providers: BTreeMap<u16, SimProvider>,
}

impl SimNetwork {
    pub fn new() -> Self {
        Self {
            providers: BTreeMap::new(),
        }
    }

    pub fn add(&mut self, namespace: u16, provider: SimProvider) {
        self.providers.insert(namespace, provider);
    }

    pub fn served(&self, namespace: u16) -> u64 {
        self.providers
            .get(&namespace)
            .map_or(0, SimProvider::requests_served)
    }
}

impl Default for SimNetwork {
    fn default() -> Self {
        Self::new()
    }
}

impl Transport for SimNetwork {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        self.providers
            .get(&provider.namespace())
            .ok_or(ChainError::Replay("no simulated provider"))?
            .post(provider, body)
    }
}
