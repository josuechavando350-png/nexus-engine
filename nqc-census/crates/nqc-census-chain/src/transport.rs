//! HTTP transports and the paced, retrying JSON-RPC client.
//!
//! The live transport runs the system `curl` so the Census workspace needs no
//! TLS or HTTP dependency. The replay transport answers only from recorded
//! exchanges and fails closed on anything unrecorded, which is how every
//! acquisition is re-executed offline.

use crate::error::ChainError;
use crate::provider::ProviderSpec;
use crate::rpc::{self, ErrorClass, Reply, RpcCall};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpReply {
    pub status: u16,
    pub body: Vec<u8>,
}

pub trait Transport: Send + Sync {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError>;
}

#[derive(Debug, Clone, Copy)]
pub struct CurlTransport {
    max_time_secs: u32,
    connect_timeout_secs: u32,
}

impl CurlTransport {
    pub const fn new(max_time_secs: u32, connect_timeout_secs: u32) -> Self {
        Self {
            max_time_secs,
            connect_timeout_secs,
        }
    }
}

impl Transport for CurlTransport {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let failure = |reason: String| ChainError::Transport {
            provider: provider.label().to_owned(),
            reason,
        };
        let mut child = Command::new("curl")
            .args([
                "--silent",
                "--show-error",
                "--proto",
                "=https",
                "--max-time",
                &self.max_time_secs.to_string(),
                "--connect-timeout",
                &self.connect_timeout_secs.to_string(),
                "--request",
                "POST",
                "--header",
                "content-type: application/json",
                "--header",
                "accept: application/json",
                "--user-agent",
                "nqc-census-chain/1",
                "--data-binary",
                "@-",
                "--output",
                "-",
                "--write-out",
                "\n%{http_code}",
                provider.url(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| failure(format!("spawn curl: {error}")))?;
        child
            .stdin
            .take()
            .ok_or_else(|| failure("curl stdin unavailable".into()))?
            .write_all(body)
            .map_err(|error| failure(format!("write request: {error}")))?;
        let output = child
            .wait_with_output()
            .map_err(|error| failure(format!("wait curl: {error}")))?;
        if !output.status.success() {
            return Err(failure(format!(
                "curl exit {:?}: {}",
                output.status.code(),
                String::from_utf8_lossy(&output.stderr).trim()
            )));
        }
        let stdout = output.stdout;
        let split = stdout
            .iter()
            .rposition(|byte| *byte == b'\n')
            .ok_or_else(|| failure("missing status footer".into()))?;
        let status = std::str::from_utf8(&stdout[split + 1..])
            .ok()
            .and_then(|text| text.trim().parse::<u16>().ok())
            .ok_or_else(|| failure("unparseable HTTP status".into()))?;
        Ok(HttpReply {
            status,
            body: stdout[..split].to_vec(),
        })
    }
}

/// Recorded `(provider namespace, sha256(request)) -> response` exchanges.
#[derive(Debug, Default, Clone)]
pub struct ReplayTransport {
    exchanges: BTreeMap<(u16, [u8; 32]), Vec<u8>>,
}

impl ReplayTransport {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, namespace: u16, request: &[u8], response: Vec<u8>) {
        self.exchanges
            .insert((namespace, Sha256::digest(request).into()), response);
    }

    pub fn len(&self) -> usize {
        self.exchanges.len()
    }

    pub fn is_empty(&self) -> bool {
        self.exchanges.is_empty()
    }
}

impl Transport for ReplayTransport {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        let key = (provider.namespace(), Sha256::digest(body).into());
        self.exchanges
            .get(&key)
            .map(|body| HttpReply {
                status: 200,
                body: body.clone(),
            })
            .ok_or(ChainError::Replay("request was never recorded"))
    }
}

/// Fault injection for resume verification: forwards the first `limit`
/// requests, then fails every request as a transport failure (a crash).
pub struct InterruptAfter<'a> {
    inner: &'a dyn Transport,
    remaining: std::sync::atomic::AtomicU64,
}

impl<'a> InterruptAfter<'a> {
    pub fn new(inner: &'a dyn Transport, limit: u64) -> Self {
        Self {
            inner,
            remaining: std::sync::atomic::AtomicU64::new(limit),
        }
    }
}

impl Transport for InterruptAfter<'_> {
    fn post(&self, provider: &ProviderSpec, body: &[u8]) -> Result<HttpReply, ChainError> {
        use std::sync::atomic::Ordering;
        if self
            .remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_err()
        {
            return Err(ChainError::Transport {
                provider: provider.label().to_owned(),
                reason: "injected interruption".into(),
            });
        }
        self.inner.post(provider, body)
    }
}

/// Deterministic retry schedule; timing never affects evidence content.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub delays_ms: Vec<u64>,
}

impl RetryPolicy {
    pub fn standard() -> Self {
        Self {
            delays_ms: vec![500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000],
        }
    }

    pub fn none() -> Self {
        Self {
            delays_ms: Vec::new(),
        }
    }
}

/// One successful request/response pair exactly as sent and received.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exchange {
    pub request: Vec<u8>,
    pub response: Vec<u8>,
}

/// Counters of work performed; runtime metadata, not evidence.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ClientMetrics {
    pub requests: u64,
    pub retries: u64,
    pub request_bytes: u64,
    pub response_bytes: u64,
}

pub struct RpcClient<'a> {
    transport: &'a dyn Transport,
    provider: ProviderSpec,
    retry: RetryPolicy,
    last_request: Mutex<Option<Instant>>,
    metrics: Mutex<ClientMetrics>,
}

enum Attempt<T> {
    Done(T),
    Retry(String),
}

impl<'a> RpcClient<'a> {
    pub fn new(transport: &'a dyn Transport, provider: ProviderSpec, retry: RetryPolicy) -> Self {
        Self {
            transport,
            provider,
            retry,
            last_request: Mutex::new(None),
            metrics: Mutex::new(ClientMetrics::default()),
        }
    }

    pub const fn provider(&self) -> &ProviderSpec {
        &self.provider
    }

    pub fn metrics(&self) -> ClientMetrics {
        self.metrics.lock().map(|guard| *guard).unwrap_or_default()
    }

    fn pace(&self) {
        let interval = Duration::from_millis(self.provider.min_interval_ms());
        if let Ok(mut last) = self.last_request.lock() {
            if let Some(previous) = *last {
                let elapsed = previous.elapsed();
                if elapsed < interval {
                    std::thread::sleep(interval - elapsed);
                }
            }
            *last = Some(Instant::now());
        }
    }

    fn post_with_retry<T>(
        &self,
        body: &[u8],
        mut interpret: impl FnMut(&HttpReply) -> Result<Attempt<T>, ChainError>,
    ) -> Result<T, ChainError> {
        let mut last = String::from("no attempt");
        for attempt in 0..=self.retry.delays_ms.len() {
            if attempt > 0 {
                if let Ok(mut metrics) = self.metrics.lock() {
                    metrics.retries += 1;
                }
                std::thread::sleep(Duration::from_millis(self.retry.delays_ms[attempt - 1]));
            }
            self.pace();
            if let Ok(mut metrics) = self.metrics.lock() {
                metrics.requests += 1;
                metrics.request_bytes += body.len() as u64;
            }
            let reply = match self.transport.post(&self.provider, body) {
                Ok(reply) => reply,
                Err(error @ ChainError::Replay(_)) => return Err(error),
                Err(error) => {
                    last = error.to_string();
                    continue;
                }
            };
            if let Ok(mut metrics) = self.metrics.lock() {
                metrics.response_bytes += reply.body.len() as u64;
            }
            if reply.status == 429 || (500..=599).contains(&reply.status) {
                last = format!("http {}", reply.status);
                continue;
            }
            if reply.status != 200 && !(400..500).contains(&reply.status) {
                return Err(ChainError::Transport {
                    provider: self.provider.label().to_owned(),
                    reason: format!(
                        "http {}: {}",
                        reply.status,
                        String::from_utf8_lossy(&reply.body[..reply.body.len().min(300)])
                    ),
                });
            }
            match interpret(&reply)? {
                Attempt::Done(value) => return Ok(value),
                Attempt::Retry(reason) => last = reason,
            }
        }
        Err(ChainError::RetryBudgetExhausted {
            provider: self.provider.label().to_owned(),
            attempts: u32::try_from(self.retry.delays_ms.len() + 1).unwrap_or(u32::MAX),
            last,
        })
    }

    /// Executes one call. Every well-formed JSON-RPC reply is returned with its
    /// exchange so a job can record it; only rate limiting is retried here.
    pub fn call(&self, call: &RpcCall) -> Result<(Reply, Exchange), ChainError> {
        let request = call.request_bytes()?;
        self.post_with_retry(&request, |reply| {
            let parsed = rpc::parse_reply(&reply.body, rpc::SINGLE_ID)?;
            if let Reply::Error(error) = &parsed {
                if rpc::classify(error) == ErrorClass::RateLimited {
                    return Ok(Attempt::Retry(error.message.clone()));
                }
            }
            Ok(Attempt::Done((
                parsed,
                Exchange {
                    request: request.clone(),
                    response: reply.body.clone(),
                },
            )))
        })
    }

    /// Executes a batch; any rate-limited member retries the whole batch.
    /// Replies are returned in call order.
    pub fn batch(&self, calls: &[RpcCall]) -> Result<(Vec<Reply>, Exchange), ChainError> {
        let request = rpc::batch_request_bytes(calls)?;
        let ids = rpc::batch_ids(calls.len());
        self.post_with_retry(&request, |reply| {
            let parsed = rpc::parse_batch_reply(&reply.body, &ids)?;
            let mut ordered = Vec::with_capacity(ids.len());
            for id in &ids {
                let item = parsed
                    .get(id)
                    .cloned()
                    .ok_or(ChainError::Rpc("batch member missing"))?;
                if let Reply::Error(error) = &item {
                    if rpc::classify(error) == ErrorClass::RateLimited {
                        return Ok(Attempt::Retry(error.message.clone()));
                    }
                }
                ordered.push(item);
            }
            Ok(Attempt::Done((
                ordered,
                Exchange {
                    request: request.clone(),
                    response: reply.body.clone(),
                },
            )))
        })
    }
}
