//! Task proposals.
//!
//! A proposal is what the runtime *wants* to happen. It carries the evidence
//! that produced it, so that a decision can be reconstructed later from the
//! graph rather than from a log line.

use crate::behavior::{BehaviorPlan, TaskGoal};
use nexus_event::json::Value;
use nexus_event::{EntityId, TaskId, Timestamp, TraceId};
use nexus_policy::RiskClass;

/// What caused a proposal to be raised.
#[derive(Debug, Clone, PartialEq)]
pub enum ProposalTrigger {
    /// A telemetry value crossed a threshold.
    TelemetryThreshold {
        stream: String,
        value: f64,
        threshold: f64,
    },

    /// An external detector reported a hazard.
    Detection {
        class: String,
        confidence: f64,
        model_id: String,
    },

    /// Two independent signals were correlated onto one asset.
    CorrelatedEvidence {
        signals: Vec<String>,
        asset_key: String,
    },

    /// Compatibility trigger used by V3 demos and services when a correlated
    /// detector result is already represented as a hazard class.
    CorrelatedHazard {
        detection_class: String,
        asset_key: String,
    },

    /// A human asked for it.
    OperatorRequest { operator_id: String },

    /// A schedule fired.
    Scheduled { schedule_id: String },
}

impl ProposalTrigger {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProposalTrigger::TelemetryThreshold { .. } => "telemetry_threshold",
            ProposalTrigger::Detection { .. } => "detection",
            ProposalTrigger::CorrelatedEvidence { .. } => "correlated_evidence",
            ProposalTrigger::CorrelatedHazard { .. } => "correlated_hazard",
            ProposalTrigger::OperatorRequest { .. } => "operator_request",
            ProposalTrigger::Scheduled { .. } => "scheduled",
        }
    }

    pub fn to_json(&self) -> Value {
        let detail = match self {
            ProposalTrigger::TelemetryThreshold {
                stream,
                value,
                threshold,
            } => Value::object(vec![
                ("stream", Value::string(stream)),
                ("value", Value::number(*value)),
                ("threshold", Value::number(*threshold)),
            ]),

            ProposalTrigger::Detection {
                class,
                confidence,
                model_id,
            } => Value::object(vec![
                ("class", Value::string(class)),
                ("confidence", Value::number(*confidence)),
                ("model_id", Value::string(model_id)),
            ]),

            ProposalTrigger::CorrelatedEvidence { signals, asset_key } => Value::object(vec![
                (
                    "signals",
                    Value::Array(signals.iter().map(Value::string).collect()),
                ),
                ("asset_key", Value::string(asset_key)),
            ]),

            ProposalTrigger::CorrelatedHazard {
                detection_class,
                asset_key,
            } => Value::object(vec![
                ("detection_class", Value::string(detection_class)),
                ("asset_key", Value::string(asset_key)),
            ]),

            ProposalTrigger::OperatorRequest { operator_id } => {
                Value::object(vec![("operator_id", Value::string(operator_id))])
            }

            ProposalTrigger::Scheduled { schedule_id } => {
                Value::object(vec![("schedule_id", Value::string(schedule_id))])
            }
        };

        Value::object(vec![
            ("trigger", Value::string(self.as_str())),
            ("detail", detail),
        ])
    }
}

/// A proposed task, before any gate has run.
#[derive(Debug, Clone, PartialEq)]
pub struct TaskProposal {
    pub task_id: TaskId,
    pub goal: TaskGoal,
    pub trigger: ProposalTrigger,

    /// Graph entities that justify the proposal.
    pub evidence: Vec<EntityId>,

    pub subject_asset_key: String,
    pub zone_id: String,
    pub device_id: String,
    pub risk_class: RiskClass,
    pub proposed_at: Timestamp,
    pub trace_id: TraceId,

    /// Free text from the trigger, scanned by the policy hard invariants.
    pub intent_annotations: Vec<String>,

    pub plan: Option<BehaviorPlan>,
}

impl TaskProposal {
    pub fn new(
        goal: TaskGoal,
        trigger: ProposalTrigger,
        subject_asset_key: impl Into<String>,
        zone_id: impl Into<String>,
        device_id: impl Into<String>,
        proposed_at: Timestamp,
        trace_id: TraceId,
    ) -> Self {
        TaskProposal {
            task_id: TaskId::new(),
            goal,
            trigger,
            evidence: Vec::new(),
            subject_asset_key: subject_asset_key.into(),
            zone_id: zone_id.into(),
            device_id: device_id.into(),
            risk_class: RiskClass::Low,
            proposed_at,
            trace_id,
            intent_annotations: Vec::new(),
            plan: None,
        }
    }

    pub fn with_evidence(mut self, evidence: Vec<EntityId>) -> Self {
        self.evidence = evidence;
        self
    }

    pub fn with_risk(mut self, risk_class: RiskClass) -> Self {
        self.risk_class = risk_class;
        self
    }

    pub fn with_annotation(mut self, annotation: impl Into<String>) -> Self {
        self.intent_annotations.push(annotation.into());
        self
    }

    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("task_id", Value::string(self.task_id.as_str())),
            ("goal", Value::string(self.goal.as_str())),
            ("trigger", self.trigger.to_json()),
            (
                "evidence",
                Value::Array(
                    self.evidence
                        .iter()
                        .map(|id| Value::string(id.as_str()))
                        .collect(),
                ),
            ),
            ("asset", Value::string(&self.subject_asset_key)),
            ("zone", Value::string(&self.zone_id)),
            ("device", Value::string(&self.device_id)),
            ("risk_class", Value::string(self.risk_class.as_str())),
            ("trace_id", Value::string(self.trace_id.as_str())),
            (
                "plan",
                match &self.plan {
                    Some(plan) => plan.to_json(),
                    None => Value::Null,
                },
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_proposal_records_the_evidence_that_produced_it() {
        let proposal = TaskProposal::new(
            TaskGoal::Standdown,
            ProposalTrigger::CorrelatedEvidence {
                signals: vec!["telemetry.temperature".into(), "detection.smoke".into()],
                asset_key: "press-4".into(),
            },
            "press-4",
            "press-hall",
            "robot-inspect-01",
            Timestamp::from_millis(1),
            TraceId::from_external("trc_1"),
        )
        .with_evidence(vec![
            EntityId::from_external("ent_obs"),
            EntityId::from_external("ent_det"),
        ]);

        let json = proposal.to_json();

        assert_eq!(
            json.get("evidence")
                .and_then(Value::as_array)
                .map(|array| array.len()),
            Some(2)
        );

        assert_eq!(proposal.trigger.as_str(), "correlated_evidence");
    }

    #[test]
    fn correlated_hazard_serializes_its_detection_class() {
        let trigger = ProposalTrigger::CorrelatedHazard {
            detection_class: "smoke".into(),
            asset_key: "press-4".into(),
        };

        let json = trigger.to_json();

        assert_eq!(trigger.as_str(), "correlated_hazard");

        assert_eq!(
            json.get("detail")
                .and_then(|detail| detail.get("detection_class"))
                .and_then(Value::as_str),
            Some("smoke")
        );
    }

    #[test]
    fn proposals_get_distinct_task_ids() {
        let make = || {
            TaskProposal::new(
                TaskGoal::Standdown,
                ProposalTrigger::Scheduled {
                    schedule_id: "s1".into(),
                },
                "a",
                "z",
                "d",
                Timestamp::from_millis(1),
                TraceId::from_external("t"),
            )
        };

        assert_ne!(make().task_id, make().task_id);
    }
}
