//! Ingest configuration.
//!
//! Everything is read from the environment or an explicit constructor. There
//! are no broker addresses, credentials, topics or consumer group names
//! hardcoded anywhere in this crate, and `.env.example` documents the full
//! set without containing a single real value.

use nexus_event::{NexusError, Result};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestConfig {
    /// Comma-separated broker list. No default: a service that silently
    /// connects to localhost in production is a defect.
    pub brokers: String,
    pub consumer_group: String,
    pub input_topics: Vec<String>,
    pub deadletter_topic: String,
    /// Bounded in-flight queue. Backpressure starts here.
    pub queue_capacity: usize,
    pub max_retries: u32,
    pub initial_backoff_millis: u64,
    pub max_backoff_millis: u64,
    /// Dedup window size, in idempotency keys.
    pub dedup_window: usize,
    /// Reject events whose `occurred_at` is further than this from now.
    pub max_clock_skew_millis: i64,
    pub shutdown_grace_millis: u64,
}

impl IngestConfig {
    pub fn from_env() -> Result<Self> {
        fn required(key: &str) -> Result<String> {
            std::env::var(key)
                .ok()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| {
                    NexusError::invalid(format!("environment variable {key} is required"))
                })
        }
        fn number<T: std::str::FromStr>(key: &str, fallback: T) -> T {
            std::env::var(key)
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(fallback)
        }

        let topics = std::env::var("NEXUS_INPUT_TOPICS")
            .unwrap_or_else(|_| nexus_event::topics::TELEMETRY_RAW.to_string());

        Ok(IngestConfig {
            brokers: required("NEXUS_BROKERS")?,
            consumer_group: required("NEXUS_CONSUMER_GROUP")?,
            input_topics: topics
                .split(',')
                .map(|topic| topic.trim().to_string())
                .filter(|topic| !topic.is_empty())
                .collect(),
            deadletter_topic: std::env::var("NEXUS_DEADLETTER_TOPIC")
                .unwrap_or_else(|_| nexus_event::topics::DEADLETTER.to_string()),
            queue_capacity: number("NEXUS_QUEUE_CAPACITY", 10_000),
            max_retries: number("NEXUS_MAX_RETRIES", 5),
            initial_backoff_millis: number("NEXUS_INITIAL_BACKOFF_MS", 100),
            max_backoff_millis: number("NEXUS_MAX_BACKOFF_MS", 30_000),
            dedup_window: number("NEXUS_DEDUP_WINDOW", 100_000),
            max_clock_skew_millis: number("NEXUS_MAX_CLOCK_SKEW_MS", 300_000),
            shutdown_grace_millis: number("NEXUS_SHUTDOWN_GRACE_MS", 15_000),
        })
    }

    /// Deterministic configuration for tests, examples and the offline demo.
    pub fn for_testing() -> Self {
        IngestConfig {
            brokers: "in-memory".into(),
            consumer_group: "nexus-test".into(),
            input_topics: vec![nexus_event::topics::TELEMETRY_RAW.to_string()],
            deadletter_topic: nexus_event::topics::DEADLETTER.to_string(),
            queue_capacity: 128,
            max_retries: 3,
            initial_backoff_millis: 1,
            max_backoff_millis: 10,
            dedup_window: 1_024,
            max_clock_skew_millis: 300_000,
            shutdown_grace_millis: 50,
        }
    }

    pub fn validate(&self) -> Result<()> {
        if self.input_topics.is_empty() {
            return Err(NexusError::invalid("at least one input topic is required"));
        }
        for topic in &self.input_topics {
            if !nexus_event::topics::is_known(topic) {
                return Err(NexusError::invalid(format!(
                    "topic '{topic}' is not in the canonical topic set"
                )));
            }
        }
        if self.queue_capacity == 0 {
            return Err(NexusError::invalid("queue_capacity must be greater than 0"));
        }
        if self.initial_backoff_millis == 0 {
            return Err(NexusError::invalid("initial_backoff_millis must be > 0"));
        }
        if self.max_backoff_millis < self.initial_backoff_millis {
            return Err(NexusError::invalid(
                "max_backoff_millis must be >= initial_backoff_millis",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testing_config_is_valid() {
        IngestConfig::for_testing().validate().unwrap();
    }

    #[test]
    fn unknown_topics_are_rejected() {
        let mut config = IngestConfig::for_testing();
        config.input_topics = vec!["nexus.commands.fire".into()];
        assert!(config.validate().is_err());
    }

    #[test]
    fn empty_topic_list_is_rejected() {
        let mut config = IngestConfig::for_testing();
        config.input_topics.clear();
        assert!(config.validate().is_err());
    }

    #[test]
    fn backoff_bounds_must_be_coherent() {
        let mut config = IngestConfig::for_testing();
        config.max_backoff_millis = 0;
        assert!(config.validate().is_err());
    }
}
