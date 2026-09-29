//! JSON-RPC 2.0 requests and strict reply parsing.
//!
//! Request ids are derived from the request content, never from a counter, so
//! an interrupted and resumed acquisition produces byte-identical request
//! artifacts. Replies must carry `jsonrpc: "2.0"`, the expected id, and exactly
//! one of `result` or `error`.

use crate::error::ChainError;
use crate::hex;
use crate::json::Json;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcCall {
    method: String,
    params: Json,
}

impl RpcCall {
    pub fn new(method: impl Into<String>, params: Json) -> Self {
        Self {
            method: method.into(),
            params,
        }
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    pub const fn params(&self) -> &Json {
        &self.params
    }

    /// Content-derived id below 2^53 so every JSON implementation keeps it exact.
    pub fn id(&self) -> Result<u64, ChainError> {
        let mut hasher = Sha256::new();
        hasher.update(b"NQC-CENSUS-RPC-ID-V1");
        hasher.update([0]);
        hasher.update(self.method.as_bytes());
        hasher.update([0]);
        hasher.update(self.params.canonical()?);
        let digest = hasher.finalize();
        let mut bytes = [0_u8; 8];
        bytes[1..].copy_from_slice(&digest[..7]);
        Ok(u64::from_be_bytes(bytes) & ((1 << 53) - 1))
    }

    fn envelope(&self) -> Result<Json, ChainError> {
        Ok(Json::object([
            ("id", Json::uint(self.id()?)),
            ("jsonrpc", Json::string("2.0")),
            ("method", Json::string(self.method.clone())),
            ("params", self.params.clone()),
        ]))
    }

    pub fn request_bytes(&self) -> Result<Vec<u8>, ChainError> {
        self.envelope()?.canonical()
    }
}

/// Canonical batch request; calls must have distinct ids.
pub fn batch_request_bytes(calls: &[RpcCall]) -> Result<Vec<u8>, ChainError> {
    let mut ids = std::collections::BTreeSet::new();
    let mut items = Vec::with_capacity(calls.len());
    for call in calls {
        if !ids.insert(call.id()?) {
            return Err(ChainError::Rpc("duplicate call in batch"));
        }
        items.push(call.envelope()?);
    }
    Json::Array(items).canonical()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcErrorObject {
    pub code: i64,
    pub message: String,
    pub data: Option<Json>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reply {
    Result(Json),
    Error(RpcErrorObject),
}

fn parse_envelope(value: &Json, expected_id: u64) -> Result<Reply, ChainError> {
    let members = value
        .as_object()
        .ok_or(ChainError::Rpc("reply is not an object"))?;
    if value.get("jsonrpc").and_then(Json::as_str) != Some("2.0") {
        return Err(ChainError::Rpc("missing jsonrpc 2.0 marker"));
    }
    let id = value
        .get("id")
        .and_then(Json::as_i64)
        .ok_or(ChainError::Rpc("missing numeric id"))?;
    if u64::try_from(id).ok() != Some(expected_id) {
        return Err(ChainError::Rpc("reply id does not match request"));
    }
    for (key, _) in members {
        if !matches!(key.as_str(), "jsonrpc" | "id" | "result" | "error") {
            return Err(ChainError::Rpc("unexpected reply member"));
        }
    }
    match (value.get("result"), value.get("error")) {
        (Some(result), None) => Ok(Reply::Result(result.clone())),
        (None, Some(error)) => {
            let code = error
                .get("code")
                .and_then(Json::as_i64)
                .ok_or(ChainError::Rpc("error without integer code"))?;
            let message = error
                .get("message")
                .and_then(Json::as_str)
                .unwrap_or_default()
                .to_owned();
            Ok(Reply::Error(RpcErrorObject {
                code,
                message,
                data: error.get("data").cloned(),
            }))
        }
        _ => Err(ChainError::Rpc(
            "reply must have exactly one of result or error",
        )),
    }
}

pub fn parse_reply(bytes: &[u8], expected_id: u64) -> Result<Reply, ChainError> {
    parse_envelope(&Json::parse(bytes)?, expected_id)
}

/// Parses a batch reply; every requested id must appear exactly once and no
/// other id may appear. Order is irrelevant.
pub fn parse_batch_reply(bytes: &[u8], ids: &[u64]) -> Result<BTreeMap<u64, Reply>, ChainError> {
    let value = Json::parse(bytes)?;
    let items = value
        .as_array()
        .ok_or(ChainError::Rpc("batch reply is not an array"))?;
    if items.len() != ids.len() {
        return Err(ChainError::Rpc("batch reply cardinality mismatch"));
    }
    let mut replies = BTreeMap::new();
    for item in items {
        let id = item
            .get("id")
            .and_then(Json::as_i64)
            .and_then(|id| u64::try_from(id).ok())
            .ok_or(ChainError::Rpc("batch item without id"))?;
        if !ids.contains(&id) {
            return Err(ChainError::Rpc("batch reply contains an unrequested id"));
        }
        if replies.insert(id, parse_envelope(item, id)?).is_some() {
            return Err(ChainError::Rpc("batch reply repeats an id"));
        }
    }
    Ok(replies)
}

/// Retry/bisection policy class of a JSON-RPC error. Only `Revert` with
/// bytes may ever become a chain observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ErrorClass {
    Revert(Vec<u8>),
    RevertWithoutData,
    RateLimited,
    RangeTooLarge,
    ArchiveUnavailable,
    Other,
}

pub fn classify(error: &RpcErrorObject) -> ErrorClass {
    let message = error.message.to_ascii_lowercase();
    if error.code == 3 || message.contains("execution reverted") || message.starts_with("revert") {
        return match error.data.as_ref() {
            Some(Json::String(data)) => {
                hex::decode_data(data).map_or(ErrorClass::RevertWithoutData, ErrorClass::Revert)
            }
            _ => ErrorClass::RevertWithoutData,
        };
    }
    const RATE: [&str; 8] = [
        "rate limit",
        "too many requests",
        "request limit",
        "throttl",
        "capacity",
        "try again",
        "temporarily unavailable",
        "timeout",
    ];
    const RANGE: [&str; 11] = [
        "ranges over",
        "range too large",
        "block range",
        "range is too large",
        "too many results",
        "more than",
        "response size",
        "query returned",
        "exceed maximum",
        "range limit",
        "max block range",
    ];
    const ARCHIVE: [&str; 7] = [
        "missing trie node",
        "header not found",
        "historical state",
        "state is not available",
        "state not available",
        "pruned",
        "archive",
    ];
    if matches!(error.code, 429 | -32005 | -32097 | -32029)
        || RATE.iter().any(|needle| message.contains(needle))
    {
        ErrorClass::RateLimited
    } else if RANGE.iter().any(|needle| message.contains(needle)) {
        ErrorClass::RangeTooLarge
    } else if ARCHIVE.iter().any(|needle| message.contains(needle)) {
        ErrorClass::ArchiveUnavailable
    } else {
        ErrorClass::Other
    }
}
