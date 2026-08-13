//! Identifier types.
//!
//! Ids are opaque, lowercase-hex strings. There is no dependency on a UUID
//! crate; ids are derived from a monotonic counter mixed with the process
//! start time and a per-process seed, then hashed. That is enough for
//! collision resistance inside a deployment, and every id that must be
//! reproducible across a replay is instead derived deterministically from
//! content via `derive_from`.

use crate::hash::{sha256, to_hex};
use crate::time::Timestamp;
use std::sync::atomic::{AtomicU64, Ordering};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn process_seed() -> u64 {
    // Address of a static plus the start timestamp: distinct per process
    // without pulling in a random number generator.
    static ANCHOR: AtomicU64 = AtomicU64::new(0);
    let anchor_addr = &ANCHOR as *const AtomicU64 as u64;
    anchor_addr ^ (Timestamp::now().as_millis() as u64).rotate_left(17)
}

fn fresh(prefix: &str) -> String {
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let seed = process_seed();
    let mut material = Vec::with_capacity(prefix.len() + 16);
    material.extend_from_slice(prefix.as_bytes());
    material.extend_from_slice(&count.to_be_bytes());
    material.extend_from_slice(&seed.to_be_bytes());
    let digest = sha256(&material);
    format!("{prefix}_{}", &to_hex(&digest)[..24])
}

macro_rules! id_type {
    ($name:ident, $prefix:literal, $doc:literal) => {
        #[doc = $doc]
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub struct $name(String);

        impl $name {
            pub fn new() -> Self {
                $name(fresh($prefix))
            }

            /// Wrap an externally supplied identifier (device serial,
            /// upstream event id, operator directory id).
            pub fn from_external(value: impl Into<String>) -> Self {
                $name(value.into())
            }

            /// Deterministic identifier derived from content, so that a
            /// replay of the same input produces the same id.
            pub fn derive_from(parts: &[&str]) -> Self {
                let mut material = Vec::new();
                for part in parts {
                    material.extend_from_slice(part.as_bytes());
                    material.push(0x1f);
                }
                let digest = sha256(&material);
                $name(format!("{}_{}", $prefix, &to_hex(&digest)[..24]))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }

            pub fn into_string(self) -> String {
                self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                $name(value.to_string())
            }
        }
    };
}

id_type!(
    EventId,
    "evt",
    "Unique identifier of a single event envelope."
);
id_type!(
    TraceId,
    "trc",
    "Correlates every record produced by one causal chain."
);
id_type!(
    SourceId,
    "src",
    "Identifies the emitting sensor, camera, robot or service."
);
id_type!(EntityId, "ent", "Identifies a resolved ontology entity.");
id_type!(
    TaskId,
    "tsk",
    "Identifies an orchestration task or edge task."
);

impl Default for EventId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for TraceId {
    fn default() -> Self {
        Self::new()
    }
}

impl Default for TaskId {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_are_unique_and_prefixed() {
        let mut seen = std::collections::HashSet::new();
        for _ in 0..10_000 {
            let id = EventId::new();
            assert!(id.as_str().starts_with("evt_"));
            assert!(seen.insert(id.into_string()), "id collision");
        }
    }

    #[test]
    fn derived_ids_are_stable_across_calls() {
        let left = EntityId::derive_from(&["Asset", "press-04"]);
        let right = EntityId::derive_from(&["Asset", "press-04"]);
        let other = EntityId::derive_from(&["Asset", "press-05"]);
        assert_eq!(left, right);
        assert_ne!(left, other);
    }

    #[test]
    fn derived_ids_resist_separator_confusion() {
        let left = EntityId::derive_from(&["ab", "c"]);
        let right = EntityId::derive_from(&["a", "bc"]);
        assert_ne!(left, right);
    }

    #[test]
    fn external_ids_are_preserved_verbatim() {
        let id = SourceId::from_external("plc-line-3");
        assert_eq!(id.as_str(), "plc-line-3");
    }
}
