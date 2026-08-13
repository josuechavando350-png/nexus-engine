//! # nexus-event
//!
//! The canonical event model of the NEXUS Industrial Agentic Runtime.
//!
//! Everything else in the runtime depends on this crate and this crate
//! depends on nothing but the standard library. It owns:
//!
//! - [`EventEnvelope`] — the versioned, self-verifying wire format
//! - [`Detection`] — the contract for externally produced computer-vision output
//! - [`DedupIndex`] / [`SequenceTracker`] — at-least-once survival machinery
//! - [`json`] — a strict JSON codec with a canonical form
//! - [`hash`] — SHA-256, used for integrity, ids and audit chaining
//!
//! ## Delivery guarantees
//!
//! Stated once, honestly, and not overstated anywhere else:
//!
//! | Property | Guarantee |
//! |---|---|
//! | Broker delivery | at-least-once |
//! | Graph mutation effect | effectively-once via idempotency key + dedup window |
//! | Ordering | per `(source_id, stream)` via `sequence`; no global order |
//! | Exactly-once end to end | **not provided** — the broker and the graph are not in one transaction |
//! | Replay | supported; identifiers are content-derivable |
//! | Dedup window | bounded and lossy by construction; evictions are reported |

#![forbid(unsafe_code)]
#![deny(missing_debug_implementations)]

pub mod classification;
pub mod dedup;
pub mod detection;
pub mod envelope;
pub mod error;
pub mod hash;
pub mod ids;
pub mod json;
pub mod time;

pub use classification::Classification;
pub use dedup::{DedupIndex, SequenceTracker, SequenceVerdict};
pub use detection::{BoundingBox, Detection, DetectionClass};
pub use envelope::{
    EnvelopeBuilder, EventEnvelope, Signature, SourceType, CURRENT_SCHEMA_VERSION,
    MIN_SUPPORTED_SCHEMA_VERSION,
};
pub use error::{NexusError, Result};
pub use hash::{constant_time_eq, sha256, sha256_hex, to_hex, Sha256};
pub use ids::{EntityId, EventId, SourceId, TaskId, TraceId};
pub use json::Value;
pub use time::{Clock, FixedClock, SystemClock, Timestamp};

/// Canonical topic names for the data highway.
///
/// Centralised so no service can invent a topic by typo, and so the one-way
/// gateway can enforce an allowlist by identity rather than by prefix match.
pub mod topics {
    pub const TELEMETRY_RAW: &str = "nexus.telemetry.raw";
    pub const TELEMETRY_NORMALIZED: &str = "nexus.telemetry.normalized";
    pub const DETECTIONS: &str = "nexus.detections";
    pub const GRAPH_MUTATIONS: &str = "nexus.graph.mutations";
    pub const TASK_PROPOSALS: &str = "nexus.task.proposals";
    pub const AUDIT: &str = "nexus.audit";
    pub const DEADLETTER: &str = "nexus.deadletter";

    /// Every topic the runtime knows about.
    pub const ALL: &[&str] = &[
        TELEMETRY_RAW,
        TELEMETRY_NORMALIZED,
        DETECTIONS,
        GRAPH_MUTATIONS,
        TASK_PROPOSALS,
        AUDIT,
        DEADLETTER,
    ];

    /// Topics the protected OT zone is allowed to *produce* to.
    ///
    /// Deliberately excludes anything carrying commands or approvals: the
    /// observation diode has no command path by construction.
    pub const OT_EGRESS_ALLOWLIST: &[&str] = &[TELEMETRY_RAW, DETECTIONS, AUDIT];

    pub fn is_known(topic: &str) -> bool {
        ALL.contains(&topic)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn topic_allowlist_excludes_command_and_mutation_paths() {
        assert!(!topics::OT_EGRESS_ALLOWLIST.contains(&topics::TASK_PROPOSALS));
        assert!(!topics::OT_EGRESS_ALLOWLIST.contains(&topics::GRAPH_MUTATIONS));
        for topic in topics::OT_EGRESS_ALLOWLIST {
            assert!(topics::is_known(topic));
        }
    }

    #[test]
    fn topic_names_are_unique() {
        let mut seen = std::collections::HashSet::new();
        for topic in topics::ALL {
            assert!(seen.insert(*topic), "duplicate topic {topic}");
        }
    }
}
