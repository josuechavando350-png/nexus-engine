//! # nexus-ingest
//!
//! The data highway boundary.
//!
//! - [`bus`] — the `MessageBus` port and the default in-memory broker
//! - [`pipeline`] — validation, dedup, backpressure, retry, dead-letter, commit
//! - [`resilience`] — backoff, circuit breaker, bulkhead
//! - [`config`] — environment-driven configuration with no baked-in endpoints
//! - `kafka` (feature) — rdkafka consumer/producer for Kafka and Redpanda
//!
//! ## Guarantees
//!
//! At-least-once delivery in, effectively-once effect out, per-key ordering,
//! bounded memory. Stated in full in `nexus-event`'s crate documentation and
//! in `docs/architecture/V3_DATA_PLANE.md`. Nothing here claims exactly-once.

#![forbid(unsafe_code)]

pub mod bus;
pub mod config;
pub mod pipeline;
pub mod resilience;

#[cfg(feature = "kafka")]
pub mod kafka;

pub use bus::{BusMessage, InMemoryBus, MessageBus, OutboundMessage};
pub use config::IngestConfig;
pub use pipeline::{
    CollectingHandler, DeadLetter, DrainReport, EventHandler, HandlerOutcome, IngestPipeline,
};
pub use resilience::{Backoff, Bulkhead, BulkheadPermit, CircuitBreaker, CircuitState};
