//! Append-only audit trail with hash chaining.
//!
//! Every decision that can move a physical actuator is written here before it
//! is acted on: proposals, policy verdicts, human approvals, signed edge
//! tasks, execution results and gateway egress.
//!
//! ## What the chain does and does not prove
//!
//! Each record embeds the hash of its predecessor, so silently *editing* or
//! *removing* an interior record breaks verification. It does **not** protect
//! against an attacker who can rewrite the whole file and recompute the
//! chain: that requires an external anchor (a WORM store, a signed periodic
//! digest shipped off-box, or an append-only broker topic). `AuditSink`
//! exists so that anchoring is a deployment decision, not a rewrite.

use nexus_event::hash::{sha256, to_hex};
use nexus_event::json::Value;
use nexus_event::{Timestamp, TraceId};
use std::sync::Mutex;

/// The kinds of thing worth an audit record. Closed set: an unrecognised
/// action cannot be audited, which means it cannot be performed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuditAction {
    EventAccepted,
    EventRejected,
    EventDeadLettered,
    EntityResolved,
    EntityMerged,
    GraphMutation,
    TaskProposed,
    PolicyEvaluated,
    ApprovalRequested,
    ApprovalGranted,
    ApprovalDenied,
    SimulationRun,
    TaskSigned,
    TaskDispatched,
    TaskExecuted,
    TaskFailed,
    GatewayEgress,
    GatewayRejected,
}

impl AuditAction {
    pub fn as_str(self) -> &'static str {
        match self {
            AuditAction::EventAccepted => "event_accepted",
            AuditAction::EventRejected => "event_rejected",
            AuditAction::EventDeadLettered => "event_dead_lettered",
            AuditAction::EntityResolved => "entity_resolved",
            AuditAction::EntityMerged => "entity_merged",
            AuditAction::GraphMutation => "graph_mutation",
            AuditAction::TaskProposed => "task_proposed",
            AuditAction::PolicyEvaluated => "policy_evaluated",
            AuditAction::ApprovalRequested => "approval_requested",
            AuditAction::ApprovalGranted => "approval_granted",
            AuditAction::ApprovalDenied => "approval_denied",
            AuditAction::SimulationRun => "simulation_run",
            AuditAction::TaskSigned => "task_signed",
            AuditAction::TaskDispatched => "task_dispatched",
            AuditAction::TaskExecuted => "task_executed",
            AuditAction::TaskFailed => "task_failed",
            AuditAction::GatewayEgress => "gateway_egress",
            AuditAction::GatewayRejected => "gateway_rejected",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AuditRecord {
    pub sequence: u64,
    pub recorded_at: Timestamp,
    pub action: AuditAction,
    pub subject: String,
    pub actor: String,
    pub trace_id: Option<String>,
    pub detail: Value,
    pub previous_hash: String,
    pub record_hash: String,
}

impl AuditRecord {
    fn compute_hash(&self) -> String {
        let canonical = Value::object(vec![
            ("sequence", Value::number(self.sequence as f64)),
            (
                "recorded_at",
                Value::number(self.recorded_at.as_millis() as f64),
            ),
            ("action", Value::string(self.action.as_str())),
            ("subject", Value::string(&self.subject)),
            ("actor", Value::string(&self.actor)),
            (
                "trace_id",
                match &self.trace_id {
                    Some(id) => Value::string(id),
                    None => Value::Null,
                },
            ),
            ("detail", self.detail.clone()),
            ("previous_hash", Value::string(&self.previous_hash)),
        ]);
        to_hex(&sha256(&canonical.to_canonical_bytes()))
    }

    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("sequence", Value::number(self.sequence as f64)),
            (
                "recorded_at",
                Value::number(self.recorded_at.as_millis() as f64),
            ),
            ("action", Value::string(self.action.as_str())),
            ("subject", Value::string(&self.subject)),
            ("actor", Value::string(&self.actor)),
            (
                "trace_id",
                match &self.trace_id {
                    Some(id) => Value::string(id),
                    None => Value::Null,
                },
            ),
            ("detail", self.detail.clone()),
            ("previous_hash", Value::string(&self.previous_hash)),
            ("record_hash", Value::string(&self.record_hash)),
        ])
    }
}

/// Where audit records are durably written.
///
/// The in-memory implementation below is for tests and the offline demo. A
/// production deployment points this at an append-only broker topic or a WORM
/// volume; that is the anchor the hash chain needs.
pub trait AuditSink: Send + Sync + std::fmt::Debug {
    fn persist(&self, record: &AuditRecord);
}

#[derive(Debug, Default)]
pub struct NullAuditSink;

impl AuditSink for NullAuditSink {
    fn persist(&self, _record: &AuditRecord) {}
}

/// Writes each record as one JSON line to stderr.
#[derive(Debug, Default)]
pub struct JsonLinesAuditSink;

impl AuditSink for JsonLinesAuditSink {
    fn persist(&self, record: &AuditRecord) {
        use std::io::Write;
        let mut handle = std::io::stderr().lock();
        let _ = writeln!(handle, "{}", record.to_json().to_canonical_string());
    }
}

pub const GENESIS_HASH: &str =
    "0000000000000000000000000000000000000000000000000000000000000000";

#[derive(Debug)]
pub struct AuditTrail {
    inner: Mutex<TrailState>,
    sink: Box<dyn AuditSink>,
}

#[derive(Debug)]
struct TrailState {
    records: Vec<AuditRecord>,
    last_hash: String,
    next_sequence: u64,
    retained: usize,
}

impl AuditTrail {
    /// `retained` bounds how many records are kept in memory for querying.
    /// Durability is the sink's job; this buffer is not the record of truth.
    pub fn new(sink: Box<dyn AuditSink>, retained: usize) -> Self {
        AuditTrail {
            inner: Mutex::new(TrailState {
                records: Vec::new(),
                last_hash: GENESIS_HASH.to_string(),
                next_sequence: 0,
                retained: retained.max(1),
            }),
            sink,
        }
    }

    pub fn in_memory() -> Self {
        AuditTrail::new(Box::new(NullAuditSink), 10_000)
    }

    pub fn record(
        &self,
        action: AuditAction,
        subject: impl Into<String>,
        actor: impl Into<String>,
        trace_id: Option<&TraceId>,
        detail: Value,
    ) -> AuditRecord {
        let mut state = self.inner.lock().expect("audit mutex poisoned");
        let mut record = AuditRecord {
            sequence: state.next_sequence,
            recorded_at: Timestamp::now(),
            action,
            subject: subject.into(),
            actor: actor.into(),
            trace_id: trace_id.map(|id| id.as_str().to_string()),
            detail,
            previous_hash: state.last_hash.clone(),
            record_hash: String::new(),
        };
        record.record_hash = record.compute_hash();

        state.last_hash = record.record_hash.clone();
        state.next_sequence += 1;
        state.records.push(record.clone());
        let retained = state.retained;
        if state.records.len() > retained {
            let excess = state.records.len() - retained;
            state.records.drain(0..excess);
        }
        drop(state);

        self.sink.persist(&record);
        record
    }

    pub fn len(&self) -> usize {
        self.inner
            .lock()
            .map(|state| state.next_sequence as usize)
            .unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn snapshot(&self) -> Vec<AuditRecord> {
        self.inner
            .lock()
            .map(|state| state.records.clone())
            .unwrap_or_default()
    }

    pub fn records_for_trace(&self, trace_id: &TraceId) -> Vec<AuditRecord> {
        self.snapshot()
            .into_iter()
            .filter(|record| record.trace_id.as_deref() == Some(trace_id.as_str()))
            .collect()
    }

    /// Verifies hash linkage across the retained window.
    pub fn verify_chain(&self) -> Result<(), String> {
        let records = self.snapshot();
        verify_chain_slice(&records)
    }
}

/// Verifies a slice of records, tolerating a window that does not start at
/// the genesis record.
pub fn verify_chain_slice(records: &[AuditRecord]) -> Result<(), String> {
    let mut expected_previous: Option<String> = None;
    for record in records {
        if let Some(previous) = &expected_previous {
            if &record.previous_hash != previous {
                return Err(format!(
                    "audit chain broken at sequence {}: previous_hash mismatch",
                    record.sequence
                ));
            }
        }
        let recomputed = record.compute_hash();
        if recomputed != record.record_hash {
            return Err(format!(
                "audit record {} has been modified: hash mismatch",
                record.sequence
            ));
        }
        expected_previous = Some(record.record_hash.clone());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn detail() -> Value {
        Value::object(vec![("k", Value::string("v"))])
    }

    #[test]
    fn records_are_sequenced_and_chained() {
        let trail = AuditTrail::in_memory();
        trail.record(AuditAction::TaskProposed, "tsk_1", "orchestratord", None, detail());
        trail.record(AuditAction::PolicyEvaluated, "tsk_1", "policy", None, detail());
        let records = trail.snapshot();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].sequence, 0);
        assert_eq!(records[0].previous_hash, GENESIS_HASH);
        assert_eq!(records[1].previous_hash, records[0].record_hash);
        trail.verify_chain().expect("chain intact");
    }

    #[test]
    fn editing_an_interior_record_breaks_verification() {
        let trail = AuditTrail::in_memory();
        for index in 0..5 {
            trail.record(
                AuditAction::GraphMutation,
                format!("node-{index}"),
                "graphd",
                None,
                detail(),
            );
        }
        let mut records = trail.snapshot();
        records[2].subject = "tampered".into();
        let error = verify_chain_slice(&records).unwrap_err();
        assert!(error.contains("modified"));
    }

    #[test]
    fn removing_a_record_breaks_verification() {
        let trail = AuditTrail::in_memory();
        for index in 0..4 {
            trail.record(
                AuditAction::TaskExecuted,
                format!("tsk-{index}"),
                "edge",
                None,
                detail(),
            );
        }
        let mut records = trail.snapshot();
        records.remove(1);
        assert!(verify_chain_slice(&records).is_err());
    }

    #[test]
    fn trace_filtering_returns_only_the_causal_chain() {
        let trail = AuditTrail::in_memory();
        let trace = TraceId::from_external("trc_x");
        let other = TraceId::from_external("trc_y");
        trail.record(AuditAction::TaskProposed, "a", "o", Some(&trace), detail());
        trail.record(AuditAction::TaskProposed, "b", "o", Some(&other), detail());
        trail.record(AuditAction::TaskSigned, "a", "o", Some(&trace), detail());
        assert_eq!(trail.records_for_trace(&trace).len(), 2);
    }

    #[test]
    fn retention_bounds_memory_without_losing_the_sequence_counter() {
        let trail = AuditTrail::new(Box::new(NullAuditSink), 3);
        for index in 0..10 {
            trail.record(
                AuditAction::EventAccepted,
                format!("e{index}"),
                "ingestd",
                None,
                detail(),
            );
        }
        assert_eq!(trail.snapshot().len(), 3);
        assert_eq!(trail.len(), 10);
        // The retained window is still internally consistent.
        trail.verify_chain().expect("window verifies");
    }
}
