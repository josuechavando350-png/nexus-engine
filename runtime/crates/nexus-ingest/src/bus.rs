//! The data-highway port and its in-memory implementation.
//!
//! [`MessageBus`] is what `ingestd` talks to. Kafka and Redpanda are one
//! implementation behind the `kafka` feature; [`InMemoryBus`] is the default
//! and is what the demo, the examples and CI run against.
//!
//! The in-memory bus deliberately reproduces the properties that matter for
//! correctness testing: per-partition ordering, explicit offset commits,
//! redelivery of uncommitted messages, and consumer groups that each track
//! their own position. Code that is correct against it is not relying on
//! guarantees a real broker does not give.

use nexus_event::{NexusError, Result};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

/// A message as it sits on the highway.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusMessage {
    pub topic: String,
    pub partition: u32,
    pub offset: u64,
    /// Partition key. Ordering is guaranteed per key, not globally.
    pub key: String,
    pub payload: Vec<u8>,
    /// Delivery attempt, starting at 1.
    pub delivery_attempt: u32,
}

impl BusMessage {
    pub fn payload_str(&self) -> Result<&str> {
        std::str::from_utf8(&self.payload)
            .map_err(|_| NexusError::schema("message payload is not valid UTF-8"))
    }
}

/// A record being produced.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutboundMessage {
    pub topic: String,
    pub key: String,
    pub payload: Vec<u8>,
}

impl OutboundMessage {
    pub fn new(topic: impl Into<String>, key: impl Into<String>, payload: Vec<u8>) -> Self {
        OutboundMessage {
            topic: topic.into(),
            key: key.into(),
            payload,
        }
    }

    pub fn json(topic: impl Into<String>, key: impl Into<String>, body: &str) -> Self {
        OutboundMessage::new(topic, key, body.as_bytes().to_vec())
    }
}

/// The data-highway port.
pub trait MessageBus: Send + Sync {
    /// Publishes a batch. Returns the number accepted.
    fn produce(&self, messages: &[OutboundMessage]) -> Result<usize>;

    /// Fetches up to `max` messages for this consumer group without
    /// committing them.
    fn poll(&self, group: &str, topics: &[String], max: usize) -> Result<Vec<BusMessage>>;

    /// Commits progress. Anything polled and not committed is redelivered.
    fn commit(&self, group: &str, messages: &[BusMessage]) -> Result<()>;

    fn backend_name(&self) -> &'static str;
}

#[derive(Debug, Default)]
struct BusState {
    /// topic -> partition -> messages
    partitions: HashMap<String, Vec<Vec<BusMessage>>>,
    /// (group, topic, partition) -> next offset to deliver
    cursors: HashMap<(String, String, u32), u64>,
    /// (group, topic, partition) -> last committed offset + 1
    committed: HashMap<(String, String, u32), u64>,
}

/// In-memory broker with configurable partition count.
#[derive(Debug)]
pub struct InMemoryBus {
    state: Mutex<BusState>,
    partition_count: u32,
    /// Set by fault injection; every produce fails while true.
    produce_failing: AtomicBool,
}

impl Default for InMemoryBus {
    fn default() -> Self {
        InMemoryBus::new(3)
    }
}

impl InMemoryBus {
    pub fn new(partition_count: u32) -> Self {
        InMemoryBus {
            state: Mutex::new(BusState::default()),
            partition_count: partition_count.max(1),
            produce_failing: AtomicBool::new(false),
        }
    }

    /// Stable partition assignment, so messages with one key stay ordered.
    pub fn partition_for(&self, key: &str) -> u32 {
        let digest = nexus_event::hash::sha256(key.as_bytes());
        let value = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
        value % self.partition_count
    }

    /// Fault injection: make every subsequent produce fail.
    pub fn set_produce_failing(&self, failing: bool) {
        self.produce_failing.store(failing, Ordering::SeqCst);
    }

    pub fn message_count(&self, topic: &str) -> usize {
        self.state
            .lock()
            .map(|state| {
                state
                    .partitions
                    .get(topic)
                    .map(|partitions| partitions.iter().map(Vec::len).sum())
                    .unwrap_or(0)
            })
            .unwrap_or(0)
    }

    pub fn messages(&self, topic: &str) -> Vec<BusMessage> {
        self.state
            .lock()
            .map(|state| {
                let mut all: Vec<BusMessage> = state
                    .partitions
                    .get(topic)
                    .map(|partitions| partitions.iter().flatten().cloned().collect())
                    .unwrap_or_default();
                all.sort_by_key(|message| (message.partition, message.offset));
                all
            })
            .unwrap_or_default()
    }

    /// Rewinds a consumer group to its last committed position, simulating a
    /// process restart or a rebalance.
    pub fn reset_to_committed(&self, group: &str) {
        if let Ok(mut state) = self.state.lock() {
            let keys: Vec<(String, String, u32)> = state
                .cursors
                .keys()
                .filter(|(cursor_group, _, _)| cursor_group == group)
                .cloned()
                .collect();
            for key in keys {
                let committed = state.committed.get(&key).copied().unwrap_or(0);
                state.cursors.insert(key, committed);
            }
        }
    }

    pub fn topics(&self) -> Vec<String> {
        self.state
            .lock()
            .map(|state| {
                let mut topics: Vec<String> = state.partitions.keys().cloned().collect();
                topics.sort();
                topics
            })
            .unwrap_or_default()
    }
}

impl MessageBus for InMemoryBus {
    fn produce(&self, messages: &[OutboundMessage]) -> Result<usize> {
        if self.produce_failing.load(Ordering::SeqCst) {
            return Err(NexusError::adapter(
                "in-memory bus: injected produce failure",
            ));
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| NexusError::adapter("bus lock poisoned"))?;

        for message in messages {
            let partition_index = self.partition_for(&message.key);
            let partitions = state
                .partitions
                .entry(message.topic.clone())
                .or_insert_with(|| vec![Vec::new(); self.partition_count as usize]);
            let partition = &mut partitions[partition_index as usize];
            let offset = partition.len() as u64;
            partition.push(BusMessage {
                topic: message.topic.clone(),
                partition: partition_index,
                offset,
                key: message.key.clone(),
                payload: message.payload.clone(),
                delivery_attempt: 1,
            });
        }

        Ok(messages.len())
    }

    fn poll(&self, group: &str, topics: &[String], max: usize) -> Result<Vec<BusMessage>> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NexusError::adapter("bus lock poisoned"))?;

        let mut fetched = Vec::new();
        // Deterministic topic/partition order so replay is reproducible.
        let mut sorted_topics = topics.to_vec();
        sorted_topics.sort();

        for topic in &sorted_topics {
            let partition_count = match state.partitions.get(topic) {
                Some(partitions) => partitions.len(),
                None => continue,
            };
            for partition_index in 0..partition_count {
                let key = (group.to_string(), topic.clone(), partition_index as u32);
                let cursor = state.cursors.get(&key).copied().unwrap_or(0);
                let available: Vec<BusMessage> = state
                    .partitions
                    .get(topic)
                    .and_then(|partitions| partitions.get(partition_index))
                    .map(|partition| {
                        partition
                            .iter()
                            .skip(cursor as usize)
                            .take(max.saturating_sub(fetched.len()))
                            .cloned()
                            .collect()
                    })
                    .unwrap_or_default();

                if available.is_empty() {
                    continue;
                }
                let advance = cursor + available.len() as u64;
                state.cursors.insert(key, advance);
                for mut message in available {
                    let committed_key =
                        (group.to_string(), message.topic.clone(), message.partition);
                    let committed = state.committed.get(&committed_key).copied().unwrap_or(0);
                    // A message below the commit point being delivered again
                    // means this is a redelivery after a restart.
                    if message.offset < committed {
                        message.delivery_attempt += 1;
                    }
                    fetched.push(message);
                }
                if fetched.len() >= max {
                    return Ok(fetched);
                }
            }
        }

        Ok(fetched)
    }

    fn commit(&self, group: &str, messages: &[BusMessage]) -> Result<()> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| NexusError::adapter("bus lock poisoned"))?;
        for message in messages {
            let key = (group.to_string(), message.topic.clone(), message.partition);
            let next = message.offset + 1;
            let current = state.committed.get(&key).copied().unwrap_or(0);
            if next > current {
                state.committed.insert(key, next);
            }
        }
        Ok(())
    }

    fn backend_name(&self) -> &'static str {
        "in-memory"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(key: &str, body: &str) -> OutboundMessage {
        OutboundMessage::json(nexus_event::topics::TELEMETRY_RAW, key, body)
    }

    #[test]
    fn produced_messages_are_readable() {
        let bus = InMemoryBus::new(3);
        bus.produce(&[message("a", "1"), message("b", "2")])
            .unwrap();
        assert_eq!(bus.message_count(nexus_event::topics::TELEMETRY_RAW), 2);
    }

    #[test]
    fn ordering_is_preserved_per_key() {
        let bus = InMemoryBus::new(4);
        for index in 0..20 {
            bus.produce(&[message("sensor-1", &index.to_string())])
                .unwrap();
        }
        let polled = bus
            .poll("g1", &[nexus_event::topics::TELEMETRY_RAW.to_string()], 100)
            .unwrap();
        let bodies: Vec<String> = polled
            .iter()
            .filter(|message| message.key == "sensor-1")
            .map(|message| message.payload_str().unwrap().to_string())
            .collect();
        let expected: Vec<String> = (0..20).map(|index| index.to_string()).collect();
        assert_eq!(bodies, expected);
    }

    #[test]
    fn partition_assignment_is_stable() {
        let bus = InMemoryBus::new(8);
        let first = bus.partition_for("robot-7");
        for _ in 0..100 {
            assert_eq!(bus.partition_for("robot-7"), first);
        }
    }

    #[test]
    fn polling_does_not_commit() {
        let bus = InMemoryBus::new(1);
        let topics = vec![nexus_event::topics::TELEMETRY_RAW.to_string()];
        bus.produce(&[message("a", "1"), message("a", "2")])
            .unwrap();

        let first = bus.poll("g1", &topics, 10).unwrap();
        assert_eq!(first.len(), 2);

        // Simulated crash before commit: everything comes back.
        bus.reset_to_committed("g1");
        let redelivered = bus.poll("g1", &topics, 10).unwrap();
        assert_eq!(redelivered.len(), 2);
        assert!(redelivered
            .iter()
            .all(|message| message.delivery_attempt >= 1));
    }

    #[test]
    fn committed_messages_are_not_redelivered() {
        let bus = InMemoryBus::new(1);
        let topics = vec![nexus_event::topics::TELEMETRY_RAW.to_string()];
        bus.produce(&[message("a", "1"), message("a", "2")])
            .unwrap();

        let batch = bus.poll("g1", &topics, 10).unwrap();
        bus.commit("g1", &batch).unwrap();
        bus.reset_to_committed("g1");
        assert!(bus.poll("g1", &topics, 10).unwrap().is_empty());
    }

    #[test]
    fn consumer_groups_are_independent() {
        let bus = InMemoryBus::new(2);
        let topics = vec![nexus_event::topics::TELEMETRY_RAW.to_string()];
        bus.produce(&[message("a", "1")]).unwrap();

        assert_eq!(bus.poll("g1", &topics, 10).unwrap().len(), 1);
        assert_eq!(bus.poll("g2", &topics, 10).unwrap().len(), 1);
    }

    #[test]
    fn poll_respects_the_batch_limit() {
        let bus = InMemoryBus::new(1);
        let topics = vec![nexus_event::topics::TELEMETRY_RAW.to_string()];
        for index in 0..10 {
            bus.produce(&[message("a", &index.to_string())]).unwrap();
        }
        assert_eq!(bus.poll("g1", &topics, 4).unwrap().len(), 4);
        assert_eq!(bus.poll("g1", &topics, 4).unwrap().len(), 4);
        assert_eq!(bus.poll("g1", &topics, 4).unwrap().len(), 2);
    }

    #[test]
    fn injected_produce_failure_is_reported_not_swallowed() {
        let bus = InMemoryBus::new(1);
        bus.set_produce_failing(true);
        let error = bus.produce(&[message("a", "1")]).unwrap_err();
        assert!(error.is_retryable());
        bus.set_produce_failing(false);
        assert!(bus.produce(&[message("a", "1")]).is_ok());
    }
}
