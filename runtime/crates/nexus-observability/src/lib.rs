//! # nexus-observability
//!
//! Structured logs, metrics, health probes and the append-only audit trail
//! for the NEXUS Industrial Agentic Runtime.
//!
//! No performance number is asserted anywhere in this crate. Histograms
//! report bucket upper bounds, never interpolated percentiles, so a figure
//! that appears in a dashboard can always be traced to an observation.

#![forbid(unsafe_code)]

pub mod audit;
pub mod health;
pub mod log;
pub mod metrics;

pub use audit::{
    verify_chain_slice, AuditAction, AuditRecord, AuditSink, AuditTrail, JsonLinesAuditSink,
    NullAuditSink, GENESIS_HASH,
};
pub use health::{ComponentState, HealthRegistry};
pub use log::{BufferSink, Level, LogSink, Logger, StderrSink};
pub use metrics::{names, Counter, Gauge, Histogram, Metrics, DEFAULT_LATENCY_BUCKETS_MS};
