//! Deduplication and per-source sequence tracking.
//!
//! The broker gives at-least-once delivery. This is where a duplicate stops
//! having an effect. Both structures are bounded: an unbounded dedup index is
//! a memory-exhaustion vector on a long-running gateway.

use crate::envelope::EventEnvelope;
use std::collections::{HashMap, HashSet, VecDeque};

/// Bounded FIFO set of idempotency keys.
///
/// Once `capacity` keys are held, the oldest is evicted. The window must be
/// larger than the broker's maximum redelivery span; `DedupIndex` therefore
/// reports evictions so the operator can size it from real data instead of
/// guessing.
#[derive(Debug)]
pub struct DedupIndex {
    capacity: usize,
    order: VecDeque<String>,
    keys: HashSet<String>,
    evictions: u64,
    hits: u64,
}

impl DedupIndex {
    pub fn new(capacity: usize) -> Self {
        DedupIndex {
            capacity: capacity.max(1),
            order: VecDeque::with_capacity(capacity.min(4096)),
            keys: HashSet::new(),
            evictions: 0,
            hits: 0,
        }
    }

    /// Returns `true` if this key is new (caller should process the event),
    /// `false` if it is a duplicate inside the window.
    pub fn check_and_insert(&mut self, key: &str) -> bool {
        if self.keys.contains(key) {
            self.hits += 1;
            return false;
        }
        if self.order.len() >= self.capacity {
            if let Some(oldest) = self.order.pop_front() {
                self.keys.remove(&oldest);
                self.evictions += 1;
            }
        }
        self.order.push_back(key.to_string());
        self.keys.insert(key.to_string());
        true
    }

    pub fn accepts(&mut self, envelope: &EventEnvelope) -> bool {
        self.check_and_insert(&envelope.idempotency_key())
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Number of keys pushed out of the window. Non-zero means the window is
    /// too small for the broker's redelivery behaviour.
    pub fn evictions(&self) -> u64 {
        self.evictions
    }

    pub fn duplicate_hits(&self) -> u64 {
        self.hits
    }
}

/// What a sequence number told us about a stream's continuity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SequenceVerdict {
    /// Exactly the expected next value.
    InOrder,
    /// Ahead of expectation: `missing` events were lost or are in flight.
    Gap { missing: u64 },
    /// At or behind the high-water mark: duplicate or out-of-order delivery.
    Replay { high: u64 },
    /// First event seen for this stream.
    First,
}

/// Per-`(source, stream)` high-water marks.
#[derive(Debug, Default)]
pub struct SequenceTracker {
    marks: HashMap<(String, String), u64>,
}

impl SequenceTracker {
    pub fn new() -> Self {
        SequenceTracker::default()
    }

    pub fn observe(&mut self, envelope: &EventEnvelope) -> SequenceVerdict {
        let key = (
            envelope.source_id.as_str().to_string(),
            envelope.stream.clone(),
        );
        let sequence = envelope.sequence;
        match self.marks.get(&key).copied() {
            None => {
                self.marks.insert(key, sequence);
                SequenceVerdict::First
            }
            Some(high) if sequence == high + 1 => {
                self.marks.insert(key, sequence);
                SequenceVerdict::InOrder
            }
            Some(high) if sequence > high + 1 => {
                let missing = sequence - high - 1;
                self.marks.insert(key, sequence);
                SequenceVerdict::Gap { missing }
            }
            Some(high) => SequenceVerdict::Replay { high },
        }
    }

    pub fn high_water_mark(&self, source_id: &str, stream: &str) -> Option<u64> {
        self.marks
            .get(&(source_id.to_string(), stream.to_string()))
            .copied()
    }

    pub fn tracked_streams(&self) -> usize {
        self.marks.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::envelope::SourceType;
    use crate::ids::SourceId;
    use crate::json::Value;
    use crate::time::Timestamp;

    fn envelope(source: &str, stream: &str, sequence: u64) -> EventEnvelope {
        EventEnvelope::builder(
            SourceId::from_external(source),
            SourceType::Sensor,
            stream,
            Value::object(vec![("v", Value::number(1.0))]),
        )
        .occurred_at(Timestamp::from_millis(1_700_000_000_000))
        .sequence(sequence)
        .build()
    }

    #[test]
    fn duplicates_are_rejected_within_the_window() {
        let mut index = DedupIndex::new(16);
        let event = envelope("s1", "telemetry.temperature", 1);
        assert!(index.accepts(&event));
        assert!(!index.accepts(&event));
        assert_eq!(index.duplicate_hits(), 1);
    }

    #[test]
    fn window_is_bounded_and_reports_evictions() {
        let mut index = DedupIndex::new(4);
        for i in 0..10 {
            assert!(index.check_and_insert(&format!("key-{i}")));
        }
        assert_eq!(index.len(), 4);
        assert_eq!(index.evictions(), 6);
        // Evicted key is no longer recognised: documented limitation, not a bug.
        assert!(index.check_and_insert("key-0"));
    }

    #[test]
    fn sequence_tracker_detects_gaps_and_replays() {
        let mut tracker = SequenceTracker::new();
        assert_eq!(
            tracker.observe(&envelope("s1", "t", 1)),
            SequenceVerdict::First
        );
        assert_eq!(
            tracker.observe(&envelope("s1", "t", 2)),
            SequenceVerdict::InOrder
        );
        assert_eq!(
            tracker.observe(&envelope("s1", "t", 6)),
            SequenceVerdict::Gap { missing: 3 }
        );
        assert_eq!(
            tracker.observe(&envelope("s1", "t", 4)),
            SequenceVerdict::Replay { high: 6 }
        );
    }

    #[test]
    fn streams_are_tracked_independently() {
        let mut tracker = SequenceTracker::new();
        tracker.observe(&envelope("s1", "a", 10));
        tracker.observe(&envelope("s1", "b", 99));
        tracker.observe(&envelope("s2", "a", 3));
        assert_eq!(tracker.tracked_streams(), 3);
        assert_eq!(tracker.high_water_mark("s1", "b"), Some(99));
        assert_eq!(tracker.high_water_mark("s9", "a"), None);
    }
}
