//! The human approval gate.
//!
//! When policy says `RequiresApproval`, execution stops here until a named
//! human with a permitted role decides. There is no timeout that silently
//! approves, no default-allow, and no way for the runtime to approve on a
//! human's behalf: an expired request is denied, not granted.

use nexus_event::json::Value;
use nexus_event::{NexusError, Result, TaskId, Timestamp};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq)]
pub struct ApprovalRequest {
    pub task_id: TaskId,
    pub requested_at: Timestamp,
    pub expires_at: Timestamp,
    pub approver_roles: Vec<String>,
    pub reason: String,
    /// What the human is being asked to authorise, in plain terms.
    pub summary: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalDecision {
    Granted,
    Denied,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub approval_id: String,
    pub task_id: TaskId,
    pub operator_id: String,
    pub operator_role: String,
    pub decision: ApprovalDecision,
    pub decided_at: Timestamp,
    pub note: String,
}

impl Approval {
    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("approval_id", Value::string(&self.approval_id)),
            ("task_id", Value::string(self.task_id.as_str())),
            ("operator_id", Value::string(&self.operator_id)),
            ("operator_role", Value::string(&self.operator_role)),
            (
                "decision",
                Value::string(match self.decision {
                    ApprovalDecision::Granted => "granted",
                    ApprovalDecision::Denied => "denied",
                }),
            ),
            (
                "decided_at",
                Value::number(self.decided_at.as_millis() as f64),
            ),
            ("note", Value::string(&self.note)),
        ])
    }
}

/// Holds pending requests and recorded decisions.
#[derive(Debug, Default)]
pub struct HumanApprovalGate {
    pending: Mutex<HashMap<String, ApprovalRequest>>,
    decided: Mutex<HashMap<String, Approval>>,
}

impl HumanApprovalGate {
    pub fn new() -> Self {
        HumanApprovalGate::default()
    }

    pub fn request(
        &self,
        task_id: &TaskId,
        approver_roles: Vec<String>,
        reason: impl Into<String>,
        summary: impl Into<String>,
        now: Timestamp,
        valid_for_millis: i64,
    ) -> Result<ApprovalRequest> {
        if approver_roles.is_empty() {
            return Err(NexusError::invalid(
                "an approval request must name at least one permitted role",
            ));
        }
        let request = ApprovalRequest {
            task_id: task_id.clone(),
            requested_at: now,
            expires_at: now.saturating_add_millis(valid_for_millis.max(1)),
            approver_roles,
            reason: reason.into(),
            summary: summary.into(),
        };
        self.pending
            .lock()
            .map_err(|_| NexusError::adapter("approval gate poisoned"))?
            .insert(task_id.as_str().to_string(), request.clone());
        Ok(request)
    }

    /// Records a human decision. Rejects an operator whose role is not on the
    /// request, and rejects a decision made after the request expired.
    pub fn decide(
        &self,
        task_id: &TaskId,
        operator_id: &str,
        operator_role: &str,
        decision: ApprovalDecision,
        note: impl Into<String>,
        now: Timestamp,
    ) -> Result<Approval> {
        let request = self
            .pending
            .lock()
            .map_err(|_| NexusError::adapter("approval gate poisoned"))?
            .get(task_id.as_str())
            .cloned()
            .ok_or_else(|| {
                NexusError::not_found(format!("no pending approval for task {task_id}"))
            })?;

        if !now.is_before(request.expires_at) {
            return Err(NexusError::denied(
                "approval request has expired; raise a new proposal",
            ));
        }
        if !request
            .approver_roles
            .iter()
            .any(|role| role == operator_role)
        {
            return Err(NexusError::denied(format!(
                "role '{operator_role}' may not approve this task"
            )));
        }
        if operator_id.trim().is_empty() {
            return Err(NexusError::invalid("operator_id is required"));
        }

        let approval = Approval {
            approval_id: format!("apr_{}", task_id.as_str()),
            task_id: task_id.clone(),
            operator_id: operator_id.to_string(),
            operator_role: operator_role.to_string(),
            decision,
            decided_at: now,
            note: note.into(),
        };

        self.decided
            .lock()
            .map_err(|_| NexusError::adapter("approval gate poisoned"))?
            .insert(task_id.as_str().to_string(), approval.clone());
        self.pending
            .lock()
            .map_err(|_| NexusError::adapter("approval gate poisoned"))?
            .remove(task_id.as_str());

        Ok(approval)
    }

    /// Whether a recorded, still-valid grant exists. Absence means no.
    pub fn is_granted(&self, task_id: &TaskId) -> bool {
        self.decided
            .lock()
            .map(|decided| {
                decided
                    .get(task_id.as_str())
                    .map(|approval| approval.decision == ApprovalDecision::Granted)
                    .unwrap_or(false)
            })
            .unwrap_or(false)
    }

    pub fn approval_for(&self, task_id: &TaskId) -> Option<Approval> {
        self.decided
            .lock()
            .ok()
            .and_then(|decided| decided.get(task_id.as_str()).cloned())
    }

    pub fn pending_count(&self) -> usize {
        self.pending.lock().map(|pending| pending.len()).unwrap_or(0)
    }

    /// Drops expired requests. They are never auto-approved.
    pub fn expire(&self, now: Timestamp) -> usize {
        let mut pending = match self.pending.lock() {
            Ok(pending) => pending,
            Err(_) => return 0,
        };
        let before = pending.len();
        pending.retain(|_, request| now.is_before(request.expires_at));
        before - pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000_000;

    fn gate_with_request() -> (HumanApprovalGate, TaskId) {
        let gate = HumanApprovalGate::new();
        let task_id = TaskId::from_external("tsk_1");
        gate.request(
            &task_id,
            vec!["site_supervisor".into(), "safety_officer".into()],
            "manipulation is high impact",
            "Open valve-1 on press-4",
            Timestamp::from_millis(NOW),
            300_000,
        )
        .unwrap();
        (gate, task_id)
    }

    #[test]
    fn nothing_is_granted_until_a_human_decides() {
        let (gate, task_id) = gate_with_request();
        assert!(!gate.is_granted(&task_id));
        assert_eq!(gate.pending_count(), 1);
    }

    #[test]
    fn a_permitted_role_can_grant() {
        let (gate, task_id) = gate_with_request();
        gate.decide(
            &task_id,
            "op-42",
            "site_supervisor",
            ApprovalDecision::Granted,
            "verified by radio",
            Timestamp::from_millis(NOW + 1_000),
        )
        .unwrap();
        assert!(gate.is_granted(&task_id));
        assert_eq!(gate.pending_count(), 0);
    }

    #[test]
    fn an_unpermitted_role_cannot_grant() {
        let (gate, task_id) = gate_with_request();
        let error = gate
            .decide(
                &task_id,
                "op-9",
                "visitor",
                ApprovalDecision::Granted,
                "",
                Timestamp::from_millis(NOW + 1_000),
            )
            .unwrap_err();
        assert_eq!(error.kind(), "denied");
        assert!(!gate.is_granted(&task_id));
    }

    #[test]
    fn an_expired_request_cannot_be_granted() {
        let (gate, task_id) = gate_with_request();
        let error = gate
            .decide(
                &task_id,
                "op-42",
                "site_supervisor",
                ApprovalDecision::Granted,
                "",
                Timestamp::from_millis(NOW + 400_000),
            )
            .unwrap_err();
        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn expiry_removes_requests_without_approving_them() {
        let (gate, task_id) = gate_with_request();
        assert_eq!(gate.expire(Timestamp::from_millis(NOW + 400_000)), 1);
        assert!(!gate.is_granted(&task_id));
        assert_eq!(gate.pending_count(), 0);
    }

    #[test]
    fn a_denial_is_recorded_and_is_not_a_grant() {
        let (gate, task_id) = gate_with_request();
        gate.decide(
            &task_id,
            "op-42",
            "safety_officer",
            ApprovalDecision::Denied,
            "line still energised",
            Timestamp::from_millis(NOW + 1_000),
        )
        .unwrap();
        assert!(!gate.is_granted(&task_id));
        assert_eq!(
            gate.approval_for(&task_id).unwrap().decision,
            ApprovalDecision::Denied
        );
    }

    #[test]
    fn deciding_an_unknown_task_fails() {
        let gate = HumanApprovalGate::new();
        assert!(gate
            .decide(
                &TaskId::from_external("ghost"),
                "op",
                "site_supervisor",
                ApprovalDecision::Granted,
                "",
                Timestamp::from_millis(NOW)
            )
            .is_err());
    }

    #[test]
    fn a_request_without_approver_roles_is_invalid() {
        let gate = HumanApprovalGate::new();
        assert!(gate
            .request(
                &TaskId::from_external("t"),
                vec![],
                "r",
                "s",
                Timestamp::from_millis(NOW),
                1_000
            )
            .is_err());
    }
}
