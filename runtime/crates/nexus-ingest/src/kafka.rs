//! Kafka / Redpanda adapter.
//!
//! **Build status: behind the `kafka` feature, not part of the default
//! build.** See `docs/architecture/V3_DATA_PLANE.md` for verification status.
//!
//! Implements [`MessageBus`] with a consumer group, manual offset commits, a
//! producer with delivery confirmation, and graceful shutdown. The adapter
//! owns its tokio runtime so the pipeline stays synchronous.
//!
//! Manual commit is not optional here: auto-commit would acknowledge messages
//! the pipeline has not finished with, which converts at-least-once into
//! at-most-once on a crash.

use crate::bus::{BusMessage, MessageBus, OutboundMessage};
use crate::config::IngestConfig;
use nexus_event::{NexusError, Result};
use rdkafka::config::ClientConfig;
use rdkafka::consumer::{CommitMode, Consumer, StreamConsumer};
use rdkafka::message::Message;
use rdkafka::producer::{FutureProducer, FutureRecord};
use rdkafka::TopicPartitionList;
use std::time::Duration;

/// Builds a client config from `IngestConfig` plus optional SASL/TLS
/// environment variables. No credential has a default value.
fn client_config(config: &IngestConfig) -> ClientConfig {
    let mut client = ClientConfig::new();
    client.set("bootstrap.servers", &config.brokers);

    if let Ok(mechanism) = std::env::var("NEXUS_SASL_MECHANISM") {
        client.set("sasl.mechanism", mechanism);
        client.set(
            "security.protocol",
            std::env::var("NEXUS_SECURITY_PROTOCOL").unwrap_or_else(|_| "SASL_SSL".to_string()),
        );
        if let Ok(username) = std::env::var("NEXUS_SASL_USERNAME") {
            client.set("sasl.username", username);
        }
        if let Ok(password) = std::env::var("NEXUS_SASL_PASSWORD") {
            client.set("sasl.password", password);
        }
    }
    if let Ok(ca_location) = std::env::var("NEXUS_SSL_CA_LOCATION") {
        client.set("ssl.ca.location", ca_location);
    }
    client
}

/// Kafka/Redpanda-backed message bus.
pub struct KafkaBus {
    consumer: StreamConsumer,
    producer: FutureProducer,
    runtime: tokio::runtime::Runtime,
    poll_timeout: Duration,
}

impl std::fmt::Debug for KafkaBus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KafkaBus").finish_non_exhaustive()
    }
}

impl KafkaBus {
    pub fn connect(config: &IngestConfig) -> Result<Self> {
        config.validate()?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(2)
            .thread_name("nexus-ingest")
            .build()
            .map_err(|error| NexusError::adapter(format!("tokio runtime: {error}")))?;

        let consumer: StreamConsumer = client_config(config)
            .set("group.id", &config.consumer_group)
            // Manual commits only: see the module note.
            .set("enable.auto.commit", "false")
            .set("auto.offset.reset", "earliest")
            .set("enable.partition.eof", "false")
            .set("session.timeout.ms", "10000")
            .set("max.poll.interval.ms", "300000")
            .create()
            .map_err(|error| NexusError::adapter(format!("kafka consumer: {error}")))?;

        let topics: Vec<&str> = config.input_topics.iter().map(String::as_str).collect();
        consumer
            .subscribe(&topics)
            .map_err(|error| NexusError::adapter(format!("kafka subscribe: {error}")))?;

        let producer: FutureProducer = client_config(config)
            .set("message.timeout.ms", "30000")
            .set("enable.idempotence", "true")
            .set("acks", "all")
            .set("compression.type", "lz4")
            .create()
            .map_err(|error| NexusError::adapter(format!("kafka producer: {error}")))?;

        Ok(KafkaBus {
            consumer,
            producer,
            runtime,
            poll_timeout: Duration::from_millis(500),
        })
    }

    /// Unsubscribes and lets in-flight commits settle.
    pub fn shutdown(&self, grace: Duration) {
        self.consumer.unsubscribe();
        std::thread::sleep(grace.min(Duration::from_secs(30)));
    }
}

impl MessageBus for KafkaBus {
    fn produce(&self, messages: &[OutboundMessage]) -> Result<usize> {
        self.runtime.block_on(async {
            let mut delivered = 0usize;
            for message in messages {
                let record = FutureRecord::to(message.topic.as_str())
                    .key(message.key.as_str())
                    .payload(&message.payload);
                match self.producer.send(record, Duration::from_secs(30)).await {
                    Ok(_) => delivered += 1,
                    Err((error, _)) => {
                        return Err(NexusError::adapter(format!("kafka produce: {error}")))
                    }
                }
            }
            Ok(delivered)
        })
    }

    fn poll(&self, _group: &str, _topics: &[String], max: usize) -> Result<Vec<BusMessage>> {
        self.runtime.block_on(async {
            let mut fetched = Vec::new();
            while fetched.len() < max {
                let received = tokio::time::timeout(self.poll_timeout, self.consumer.recv()).await;
                let message = match received {
                    // Timeout: no more data right now, return what we have.
                    Err(_) => break,
                    Ok(Err(error)) => {
                        return Err(NexusError::adapter(format!("kafka recv: {error}")))
                    }
                    Ok(Ok(message)) => message,
                };

                fetched.push(BusMessage {
                    topic: message.topic().to_string(),
                    partition: message.partition().max(0) as u32,
                    offset: message.offset().max(0) as u64,
                    key: message
                        .key()
                        .map(|key| String::from_utf8_lossy(key).to_string())
                        .unwrap_or_default(),
                    payload: message.payload().unwrap_or_default().to_vec(),
                    delivery_attempt: 1,
                });
            }
            Ok(fetched)
        })
    }

    fn commit(&self, _group: &str, messages: &[BusMessage]) -> Result<()> {
        if messages.is_empty() {
            return Ok(());
        }
        let mut list = TopicPartitionList::new();
        for message in messages {
            list.add_partition_offset(
                &message.topic,
                message.partition as i32,
                rdkafka::Offset::Offset(message.offset as i64 + 1),
            )
            .map_err(|error| NexusError::adapter(format!("kafka offset: {error}")))?;
        }
        self.consumer
            .commit(&list, CommitMode::Sync)
            .map_err(|error| NexusError::adapter(format!("kafka commit: {error}")))
    }

    fn backend_name(&self) -> &'static str {
        "kafka"
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn no_credentials_are_hardcoded() {
        let source = include_str!("kafka.rs");
        assert!(!source.contains("sasl.password\", \""));
        assert!(!source.contains("localhost:9092"));
    }

    #[test]
    fn auto_commit_is_disabled() {
        let source = include_str!("kafka.rs");
        assert!(source.contains("\"enable.auto.commit\", \"false\""));
    }
}
