//! The ingest pipeline.
//!
//! ```text
//! poll -> decode -> schema validate -> integrity verify -> clock check
//!      -> dedup -> sequence tracking -> handler -> commit
//!                        |                  |
//!                        |                  +-- retryable failure -> backoff -> retry
//!                        |                  +-- permanent failure  -> dead letter
//!                        +-- duplicate -> commit without effect
//! ```
//!
//! Backpressure is structural: the bounded queue is filled from `poll`, and
//! when it is full the pipeline stops polling instead of buffering without
//! limit. Lag then shows up as consumer lag on the broker, which is where an
//! operator can see it, rather than as invisible heap growth.

use crate::bus::{BusMessage, MessageBus, OutboundMessage};
use crate::config::IngestConfig;
use crate::resilience::{Backoff, CircuitBreaker};
use nexus_event::json::Value;
use nexus_event::{
    DedupIndex, EventEnvelope, NexusError, Result, SequenceTracker, SequenceVerdict, Timestamp,
};
use nexus_observability::{names, AuditAction, AuditTrail, Logger, Metrics};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// What a handler did with an envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandlerOutcome {
    /// Processed successfully; safe to commit.
    Processed,
    /// Recognised but intentionally ignored; safe to commit.
    Skipped(String),
}

/// Business logic invoked for each accepted envelope.
///
/// Errors are classified by `NexusError::is_retryable`: transport problems
/// are retried with backoff, content problems go straight to the dead-letter
/// topic. A handler must be idempotent; the pipeline guarantees at-least-once
/// invocation, not exactly-once.
pub trait EventHandler: Send + Sync {
    fn handle(&self, envelope: &EventEnvelope) -> Result<HandlerOutcome>;

    fn name(&self) -> &'static str {
        "handler"
    }
}

/// Handler that records envelopes, for tests and the demo.
#[derive(Debug, Default)]
pub struct CollectingHandler {
    collected: std::sync::Mutex<Vec<EventEnvelope>>,
    fail_until_attempt: std::sync::atomic::AtomicU32,
    attempts: std::sync::atomic::AtomicU32,
    permanent_failure_stream: std::sync::Mutex<Option<String>>,
}

impl CollectingHandler {
    pub fn new() -> Self {
        CollectingHandler::default()
    }

    /// Fail with a retryable error until the given attempt number.
    pub fn failing_until(attempt: u32) -> Self {
        let handler = CollectingHandler::default();
        handler
            .fail_until_attempt
            .store(attempt, std::sync::atomic::Ordering::SeqCst);
        handler
    }

    /// Permanently reject envelopes on a given stream.
    pub fn rejecting_stream(stream: &str) -> Self {
        let handler = CollectingHandler::default();
        *handler.permanent_failure_stream.lock().unwrap() = Some(stream.to_string());
        handler
    }

    pub fn collected(&self) -> Vec<EventEnvelope> {
        self.collected
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }

    pub fn attempts(&self) -> u32 {
        self.attempts.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl EventHandler for CollectingHandler {
    fn handle(&self, envelope: &EventEnvelope) -> Result<HandlerOutcome> {
        let attempt = self
            .attempts
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;

        if let Some(stream) = self.permanent_failure_stream.lock().unwrap().as_ref() {
            if &envelope.stream == stream {
                return Err(NexusError::invalid("handler rejects this stream"));
            }
        }

        if attempt
            <= self
                .fail_until_attempt
                .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Err(NexusError::adapter("transient downstream failure"));
        }

        if let Ok(mut collected) = self.collected.lock() {
            collected.push(envelope.clone());
        }
        Ok(HandlerOutcome::Processed)
    }

    fn name(&self) -> &'static str {
        "collecting"
    }
}

/// Why an envelope was dead-lettered.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeadLetter {
    pub original_topic: String,
    pub original_key: String,
    pub reason_kind: String,
    pub reason: String,
    pub attempts: u32,
    pub payload: Vec<u8>,
}

impl DeadLetter {
    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("original_topic", Value::string(&self.original_topic)),
            ("original_key", Value::string(&self.original_key)),
            ("reason_kind", Value::string(&self.reason_kind)),
            ("reason", Value::string(&self.reason)),
            ("attempts", Value::number(self.attempts as f64)),
            (
                "payload_base_hex",
                Value::string(nexus_event::to_hex(&self.payload)),
            ),
        ])
    }
}

/// Outcome of one pipeline drain.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DrainReport {
    pub polled: usize,
    pub accepted: usize,
    pub duplicates: usize,
    pub dead_lettered: usize,
    pub retried: usize,
    pub gaps_detected: usize,
    pub backpressure_stalls: usize,
}

/// The ingest pipeline.
pub struct IngestPipeline {
    config: IngestConfig,
    bus: Arc<dyn MessageBus>,
    handler: Arc<dyn EventHandler>,
    metrics: Arc<Metrics>,
    logger: Logger,
    audit: Arc<AuditTrail>,
    dedup: std::sync::Mutex<DedupIndex>,
    sequences: std::sync::Mutex<SequenceTracker>,
    queue: std::sync::Mutex<VecDeque<BusMessage>>,
    breaker: CircuitBreaker,
    backoff: Backoff,
    shutdown: AtomicBool,
    /// Delays are recorded instead of slept during tests.
    recorded_delays: std::sync::Mutex<Vec<u64>>,
    sleep_enabled: bool,
}

impl std::fmt::Debug for IngestPipeline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IngestPipeline")
            .field("consumer_group", &self.config.consumer_group)
            .field("topics", &self.config.input_topics)
            .field("backend", &self.bus.backend_name())
            .finish()
    }
}

impl IngestPipeline {
    pub fn new(
        config: IngestConfig,
        bus: Arc<dyn MessageBus>,
        handler: Arc<dyn EventHandler>,
        metrics: Arc<Metrics>,
        logger: Logger,
        audit: Arc<AuditTrail>,
    ) -> Result<Self> {
        config.validate()?;
        let dedup = DedupIndex::new(config.dedup_window);
        let backoff = Backoff::new(config.initial_backoff_millis, config.max_backoff_millis);
        Ok(IngestPipeline {
            queue: std::sync::Mutex::new(VecDeque::with_capacity(config.queue_capacity.min(4096))),
            dedup: std::sync::Mutex::new(dedup),
            sequences: std::sync::Mutex::new(SequenceTracker::new()),
            breaker: CircuitBreaker::new(5, 5_000),
            backoff,
            shutdown: AtomicBool::new(false),
            recorded_delays: std::sync::Mutex::new(Vec::new()),
            sleep_enabled: true,
            config,
            bus,
            handler,
            metrics,
            logger,
            audit,
        })
    }

    /// Disables real sleeping so failure tests run instantly. Delays are still
    /// computed and recorded, so the backoff schedule is asserted, not skipped.
    pub fn without_sleeping(mut self) -> Self {
        self.sleep_enabled = false;
        self
    }

    pub fn recorded_delays(&self) -> Vec<u64> {
        self.recorded_delays
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default()
    }

    /// Signals graceful shutdown. In-flight work is finished; nothing new is polled.
    pub fn request_shutdown(&self) {
        self.shutdown.store(true, Ordering::SeqCst);
        self.logger.info("shutdown requested", vec![]);
    }

    pub fn is_shutting_down(&self) -> bool {
        self.shutdown.load(Ordering::SeqCst)
    }

    pub fn queue_depth(&self) -> usize {
        self.queue.lock().map(|queue| queue.len()).unwrap_or(0)
    }

    fn sleep(&self, millis: u64) {
        if let Ok(mut recorded) = self.recorded_delays.lock() {
            recorded.push(millis);
        }
        if self.sleep_enabled && millis > 0 {
            std::thread::sleep(std::time::Duration::from_millis(millis));
        }
    }

    /// Fills the bounded queue. Returns how many were taken and whether
    /// backpressure stopped the fetch.
    fn fill_queue(&self) -> Result<(usize, bool)> {
        let mut queue = self
            .queue
            .lock()
            .map_err(|_| NexusError::adapter("queue lock poisoned"))?;

        let headroom = self.config.queue_capacity.saturating_sub(queue.len());
        if headroom == 0 {
            self.metrics
                .gauge(names::QUEUE_DEPTH)
                .set(queue.len() as i64);
            return Ok((0, true));
        }

        let fetched = self.bus.poll(
            &self.config.consumer_group,
            &self.config.input_topics,
            headroom,
        )?;
        let count = fetched.len();
        for message in fetched {
            queue.push_back(message);
        }
        self.metrics
            .gauge(names::QUEUE_DEPTH)
            .set(queue.len() as i64);
        Ok((count, false))
    }

    /// Decodes and validates one message into an envelope.
    fn decode(&self, message: &BusMessage, now: Timestamp) -> Result<EventEnvelope> {
        let text = message.payload_str()?;
        let envelope = EventEnvelope::decode(text)?;

        let skew = envelope.clock_skew_millis(now).abs();
        if skew > self.config.max_clock_skew_millis {
            return Err(NexusError::invalid(format!(
                "clock skew {skew} ms exceeds the {} ms limit",
                self.config.max_clock_skew_millis
            )));
        }

        Ok(envelope)
    }

    fn dead_letter(&self, message: &BusMessage, error: &NexusError, attempts: u32) -> Result<()> {
        let record = DeadLetter {
            original_topic: message.topic.clone(),
            original_key: message.key.clone(),
            reason_kind: error.kind().to_string(),
            reason: error.to_string(),
            attempts,
            payload: message.payload.clone(),
        };

        self.bus.produce(&[OutboundMessage::json(
            self.config.deadletter_topic.clone(),
            message.key.clone(),
            &record.to_json().to_canonical_string(),
        )])?;

        self.metrics.counter(names::INGEST_DEADLETTERED).incr();
        self.metrics.gauge(names::DLQ_SIZE).add(1);
        self.audit.record(
            AuditAction::EventDeadLettered,
            message.key.clone(),
            "ingestd",
            None,
            record.to_json(),
        );
        self.logger.warn(
            "dead lettered",
            vec![
                ("key", Value::string(&message.key)),
                ("reason_kind", Value::string(error.kind())),
                ("attempts", Value::number(attempts as f64)),
            ],
        );
        Ok(())
    }

    /// Processes one message, applying retry and dead-letter policy.
    fn process(&self, message: &BusMessage, now: Timestamp, report: &mut DrainReport) {
        let envelope = match self.decode(message, now) {
            Ok(envelope) => envelope,
            Err(error) => {
                // A malformed or tampered message is never retried: replaying
                // it produces the same result and blocks the partition.
                self.metrics.counter(names::INGEST_REJECTED).incr();
                let _ = self.dead_letter(message, &error, message.delivery_attempt);
                report.dead_lettered += 1;
                return;
            }
        };

        let lag = now.delta_millis(envelope.occurred_at).max(0);
        self.metrics
            .histogram(names::INGEST_LAG_MS)
            .observe(lag as f64);

        // Deduplicate before doing any work.
        let is_new = self
            .dedup
            .lock()
            .map(|mut dedup| dedup.accepts(&envelope))
            .unwrap_or(true);
        if !is_new {
            self.metrics.counter(names::INGEST_DUPLICATE).incr();
            report.duplicates += 1;
            return;
        }

        if let Ok(mut sequences) = self.sequences.lock() {
            match sequences.observe(&envelope) {
                SequenceVerdict::Gap { missing } => {
                    report.gaps_detected += 1;
                    self.logger.warn(
                        "sequence gap",
                        vec![
                            ("source_id", Value::string(envelope.source_id.as_str())),
                            ("stream", Value::string(&envelope.stream)),
                            ("missing", Value::number(missing as f64)),
                        ],
                    );
                }
                SequenceVerdict::Replay { high } => {
                    self.logger.debug(
                        "out of order delivery",
                        vec![("high_water_mark", Value::number(high as f64))],
                    );
                }
                _ => {}
            }
        }

        let mut attempt = 0u32;
        loop {
            let now_millis = Timestamp::now().as_millis().max(0) as u64;
            if !self.breaker.allows(now_millis) {
                let _ = self.dead_letter(
                    message,
                    &NexusError::exhausted("circuit open for downstream handler"),
                    attempt,
                );
                report.dead_lettered += 1;
                self.metrics.gauge(names::CIRCUIT_OPEN).set(1);
                return;
            }

            match self.handler.handle(&envelope) {
                Ok(_) => {
                    self.breaker.record_success();
                    self.metrics.gauge(names::CIRCUIT_OPEN).set(0);
                    self.metrics.counter(names::INGEST_ACCEPTED).incr();
                    self.audit.record(
                        AuditAction::EventAccepted,
                        envelope.event_id.as_str(),
                        "ingestd",
                        Some(&envelope.trace_id),
                        Value::object(vec![
                            ("stream", Value::string(&envelope.stream)),
                            ("sequence", Value::number(envelope.sequence as f64)),
                        ]),
                    );
                    report.accepted += 1;
                    return;
                }
                Err(error) => {
                    self.breaker.record_failure(now_millis);
                    if !error.is_retryable() || attempt >= self.config.max_retries {
                        self.metrics.counter(names::INGEST_REJECTED).incr();
                        let _ = self.dead_letter(message, &error, attempt + 1);
                        report.dead_lettered += 1;
                        return;
                    }
                    let delay = self.backoff.delay_millis(attempt);
                    self.sleep(delay);
                    attempt += 1;
                    report.retried += 1;
                }
            }
        }
    }

    /// Runs one poll-process-commit cycle.
    pub fn drain_once(&self) -> Result<DrainReport> {
        let mut report = DrainReport::default();

        if !self.is_shutting_down() {
            let (fetched, stalled) = self.fill_queue()?;
            report.polled = fetched;
            if stalled {
                report.backpressure_stalls += 1;
            }
        }

        let batch: Vec<BusMessage> = {
            let mut queue = self
                .queue
                .lock()
                .map_err(|_| NexusError::adapter("queue lock poisoned"))?;
            queue.drain(..).collect()
        };

        let now = Timestamp::now();
        for message in &batch {
            self.process(message, now, &mut report);
        }

        // Commit only after every message in the batch has reached a terminal
        // state: processed, deduplicated or dead-lettered.
        if !batch.is_empty() {
            self.bus.commit(&self.config.consumer_group, &batch)?;
        }

        self.metrics
            .gauge(names::QUEUE_DEPTH)
            .set(self.queue_depth() as i64);

        Ok(report)
    }

    /// Drains until no work remains or shutdown is requested.
    pub fn run_until_idle(&self, max_cycles: usize) -> Result<DrainReport> {
        let mut total = DrainReport::default();
        for _ in 0..max_cycles {
            let report = self.drain_once()?;
            total.polled += report.polled;
            total.accepted += report.accepted;
            total.duplicates += report.duplicates;
            total.dead_lettered += report.dead_lettered;
            total.retried += report.retried;
            total.gaps_detected += report.gaps_detected;
            total.backpressure_stalls += report.backpressure_stalls;

            if report.polled == 0 && self.queue_depth() == 0 {
                break;
            }
            if self.is_shutting_down() && self.queue_depth() == 0 {
                break;
            }
        }
        Ok(total)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bus::InMemoryBus;
    use nexus_event::envelope::SourceType;
    use nexus_event::SourceId;
    use nexus_observability::{BufferSink, Level};

    fn envelope(sequence: u64, celsius: f64) -> EventEnvelope {
        EventEnvelope::builder(
            SourceId::from_external("temp-17"),
            SourceType::Sensor,
            "telemetry.temperature",
            Value::object(vec![
                ("asset", Value::string("press-04")),
                ("celsius", Value::number(celsius)),
            ]),
        )
        .occurred_at(Timestamp::now())
        .sequence(sequence)
        .build()
    }

    struct Harness {
        pipeline: IngestPipeline,
        bus: Arc<InMemoryBus>,
        handler: Arc<CollectingHandler>,
        audit: Arc<AuditTrail>,
    }

    fn harness(handler: CollectingHandler) -> Harness {
        let bus = Arc::new(InMemoryBus::new(2));
        let handler = Arc::new(handler);
        let audit = Arc::new(AuditTrail::in_memory());
        let pipeline = IngestPipeline::new(
            IngestConfig::for_testing(),
            bus.clone(),
            handler.clone(),
            Arc::new(Metrics::new()),
            Logger::new("test", Level::Warn, Arc::new(BufferSink::new())),
            audit.clone(),
        )
        .unwrap()
        .without_sleeping();

        Harness {
            pipeline,
            bus,
            handler,
            audit,
        }
    }

    fn publish(bus: &InMemoryBus, envelope: &EventEnvelope) {
        bus.produce(&[OutboundMessage::json(
            nexus_event::topics::TELEMETRY_RAW,
            envelope.source_id.as_str(),
            &envelope.to_canonical_string(),
        )])
        .unwrap();
    }

    #[test]
    fn valid_events_are_processed_and_committed() {
        let h = harness(CollectingHandler::new());
        publish(&h.bus, &envelope(1, 90.0));
        publish(&h.bus, &envelope(2, 91.0));

        let report = h.pipeline.run_until_idle(10).unwrap();
        assert_eq!(report.accepted, 2);
        assert_eq!(report.dead_lettered, 0);
        assert_eq!(h.handler.collected().len(), 2);

        // Committed, so a restart does not reprocess them.
        h.bus.reset_to_committed("nexus-test");
        assert_eq!(h.pipeline.run_until_idle(3).unwrap().accepted, 0);
    }

    #[test]
    fn duplicate_delivery_has_no_second_effect() {
        let h = harness(CollectingHandler::new());
        let event = envelope(1, 90.0);
        publish(&h.bus, &event);
        publish(&h.bus, &event);

        let report = h.pipeline.run_until_idle(10).unwrap();
        assert_eq!(report.accepted, 1);
        assert_eq!(report.duplicates, 1);
        assert_eq!(h.handler.collected().len(), 1);
    }

    #[test]
    fn malformed_payloads_go_straight_to_the_dead_letter_topic() {
        let h = harness(CollectingHandler::new());
        h.bus
            .produce(&[OutboundMessage::json(
                nexus_event::topics::TELEMETRY_RAW,
                "bad",
                "{not json",
            )])
            .unwrap();

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.dead_lettered, 1);
        assert_eq!(report.retried, 0, "content errors must not be retried");
        assert_eq!(h.bus.message_count(nexus_event::topics::DEADLETTER), 1);
    }

    #[test]
    fn tampered_envelopes_are_rejected_by_the_integrity_check() {
        let h = harness(CollectingHandler::new());
        let mut event = envelope(1, 90.0);
        event.payload = Value::object(vec![
            ("asset", Value::string("press-04")),
            ("celsius", Value::number(20.0)),
        ]);
        // integrity_hash intentionally not recomputed.
        publish(&h.bus, &event);

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.dead_lettered, 1);
        assert!(h.handler.collected().is_empty());
    }

    #[test]
    fn transient_failures_are_retried_with_growing_backoff() {
        let h = harness(CollectingHandler::failing_until(2));
        publish(&h.bus, &envelope(1, 90.0));

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.accepted, 1);
        assert_eq!(report.retried, 2);

        let delays = h.pipeline.recorded_delays();
        assert_eq!(delays.len(), 2);
        assert!(delays.iter().all(|delay| *delay <= 10));
    }

    #[test]
    fn retries_stop_at_the_configured_limit() {
        let h = harness(CollectingHandler::failing_until(1_000));
        publish(&h.bus, &envelope(1, 90.0));

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.dead_lettered, 1);
        assert_eq!(report.retried, 3, "max_retries in the test config is 3");
        assert_eq!(h.handler.attempts(), 4);
    }

    #[test]
    fn permanent_handler_errors_are_not_retried() {
        let h = harness(CollectingHandler::rejecting_stream("telemetry.temperature"));
        publish(&h.bus, &envelope(1, 90.0));

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.dead_lettered, 1);
        assert_eq!(report.retried, 0);
    }

    #[test]
    fn implausible_clock_skew_is_rejected() {
        let h = harness(CollectingHandler::new());
        let stale = EventEnvelope::builder(
            SourceId::from_external("temp-17"),
            SourceType::Sensor,
            "telemetry.temperature",
            Value::object(vec![("asset", Value::string("press-04"))]),
        )
        .occurred_at(Timestamp::from_millis(1_000))
        .sequence(1)
        .build();
        publish(&h.bus, &stale);

        assert_eq!(h.pipeline.run_until_idle(5).unwrap().dead_lettered, 1);
    }

    #[test]
    fn backpressure_stops_polling_instead_of_growing_the_heap() {
        let bus = Arc::new(InMemoryBus::new(1));
        let mut config = IngestConfig::for_testing();
        config.queue_capacity = 4;
        let pipeline = IngestPipeline::new(
            config,
            bus.clone(),
            Arc::new(CollectingHandler::new()),
            Arc::new(Metrics::new()),
            Logger::new("test", Level::Warn, Arc::new(BufferSink::new())),
            Arc::new(AuditTrail::in_memory()),
        )
        .unwrap()
        .without_sleeping();

        for sequence in 1..=20 {
            publish(&bus, &envelope(sequence, 90.0));
        }

        let report = pipeline.drain_once().unwrap();
        assert_eq!(report.polled, 4, "queue capacity bounds one fetch");
        assert_eq!(pipeline.queue_depth(), 0, "the batch was drained");
    }

    #[test]
    fn sequence_gaps_are_detected_and_reported() {
        let h = harness(CollectingHandler::new());
        publish(&h.bus, &envelope(1, 90.0));
        publish(&h.bus, &envelope(5, 91.0));

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.gaps_detected, 1);
        assert_eq!(report.accepted, 2, "a gap is reported, not a rejection");
    }

    #[test]
    fn shutdown_stops_polling_but_finishes_the_queue() {
        let h = harness(CollectingHandler::new());
        publish(&h.bus, &envelope(1, 90.0));
        h.pipeline.request_shutdown();

        let report = h.pipeline.run_until_idle(5).unwrap();
        assert_eq!(report.polled, 0);
        assert_eq!(report.accepted, 0);
        assert!(h.pipeline.is_shutting_down());
    }

    #[test]
    fn every_accepted_event_leaves_an_audit_record() {
        let h = harness(CollectingHandler::new());
        publish(&h.bus, &envelope(1, 90.0));
        h.pipeline.run_until_idle(5).unwrap();

        let records = h.audit.snapshot();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].action, AuditAction::EventAccepted);
        h.audit.verify_chain().unwrap();
    }
}
