//! The signed edge task and its verification.

use crate::command::{EdgeCommand, SafetyConstraint};
use crate::signing::{NonceLedger, SignatureEnvelope, Signer, SignerRegistry};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, TaskId, Timestamp, TraceId};

/// Execution mode of an edge runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMode {
    /// No physical effect. Host functions are mocked. Used by CI and by the
    /// dry-run stage of the orchestrator.
    Simulation,
    /// Real hardware, non-weaponised by construction. Requires a
    /// production-grade signer and a passing simulation.
    PhysicalNonWeaponized,
}

impl ExecutionMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ExecutionMode::Simulation => "SIMULATION",
            ExecutionMode::PhysicalNonWeaponized => "PHYSICAL_NON_WEAPONIZED",
        }
    }

    pub fn is_physical(self) -> bool {
        matches!(self, ExecutionMode::PhysicalNonWeaponized)
    }
}

/// Why a task was refused at the device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VerificationError {
    Expired { expired_by_millis: i64 },
    NotYetValid,
    UnknownSigner(String),
    BadSignature(String),
    ReplayedNonce(String),
    WrongDevice { expected: String, actual: String },
    MissingCapability(String),
    CapabilityNotPermittedForSigner(String),
    NonProductionSignerOnHardware(String),
    InvalidCommand(String),
    InvalidConstraint(String),
}

impl VerificationError {
    pub fn code(&self) -> &'static str {
        match self {
            VerificationError::Expired { .. } => "expired",
            VerificationError::NotYetValid => "not_yet_valid",
            VerificationError::UnknownSigner(_) => "unknown_signer",
            VerificationError::BadSignature(_) => "bad_signature",
            VerificationError::ReplayedNonce(_) => "replayed_nonce",
            VerificationError::WrongDevice { .. } => "wrong_device",
            VerificationError::MissingCapability(_) => "missing_capability",
            VerificationError::CapabilityNotPermittedForSigner(_) => {
                "capability_not_permitted_for_signer"
            }
            VerificationError::NonProductionSignerOnHardware(_) => {
                "non_production_signer_on_hardware"
            }
            VerificationError::InvalidCommand(_) => "invalid_command",
            VerificationError::InvalidConstraint(_) => "invalid_constraint",
        }
    }
}

impl std::fmt::Display for VerificationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.code())
    }
}

impl From<VerificationError> for NexusError {
    fn from(error: VerificationError) -> Self {
        NexusError::denied(format!("edge task rejected: {}", error.code()))
    }
}

/// A task authorised for one device, one time window, one nonce.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeTask {
    pub task_id: TaskId,
    pub device_id: String,
    pub issued_at: Timestamp,
    pub expires_at: Timestamp,
    pub nonce: String,
    pub required_capabilities: Vec<String>,
    pub safety_constraints: Vec<SafetyConstraint>,
    pub command: EdgeCommand,
    pub mode: ExecutionMode,
    pub trace_id: TraceId,
    /// Reference to the approval record, when the action required one.
    pub approval_id: Option<String>,
    /// Reference to the simulation run that cleared this task.
    pub simulation_id: Option<String>,
    pub signature: Option<SignatureEnvelope>,
}

impl EdgeTask {
    pub fn new(
        device_id: impl Into<String>,
        command: EdgeCommand,
        issued_at: Timestamp,
        valid_for_millis: i64,
        trace_id: TraceId,
        mode: ExecutionMode,
    ) -> Result<Self> {
        command.validate()?;
        if valid_for_millis <= 0 {
            return Err(NexusError::invalid("valid_for_millis must be positive"));
        }

        let task_id = TaskId::new();
        let nonce = crate::signing::generate_nonce(task_id.as_str(), issued_at, "edge-task");

        Ok(EdgeTask {
            required_capabilities: command.required_capabilities(),
            device_id: device_id.into(),
            issued_at,
            expires_at: issued_at.saturating_add_millis(valid_for_millis),
            nonce,
            safety_constraints: Vec::new(),
            command,
            mode,
            trace_id,
            approval_id: None,
            simulation_id: None,
            signature: None,
            task_id,
        })
    }

    pub fn with_constraint(mut self, constraint: SafetyConstraint) -> Self {
        self.safety_constraints.push(constraint);
        self
    }

    pub fn with_approval(mut self, approval_id: impl Into<String>) -> Self {
        self.approval_id = Some(approval_id.into());
        self
    }

    pub fn with_simulation(mut self, simulation_id: impl Into<String>) -> Self {
        self.simulation_id = Some(simulation_id.into());
        self
    }

    /// The exact bytes covered by the signature.
    pub fn signing_bytes(&self) -> Vec<u8> {
        let constraints: Vec<Value> = self
            .safety_constraints
            .iter()
            .map(|constraint| constraint.to_json())
            .collect();
        let capabilities: Vec<Value> = self
            .required_capabilities
            .iter()
            .map(|capability| Value::string(capability))
            .collect();

        Value::object(vec![
            ("task_id", Value::string(self.task_id.as_str())),
            ("device_id", Value::string(&self.device_id)),
            (
                "issued_at",
                Value::number(self.issued_at.as_millis() as f64),
            ),
            (
                "expires_at",
                Value::number(self.expires_at.as_millis() as f64),
            ),
            ("nonce", Value::string(&self.nonce)),
            ("required_capabilities", Value::Array(capabilities)),
            ("safety_constraints", Value::Array(constraints)),
            ("command", self.command.to_json()),
            ("mode", Value::string(self.mode.as_str())),
            ("trace_id", Value::string(self.trace_id.as_str())),
            (
                "approval_id",
                match &self.approval_id {
                    Some(id) => Value::string(id),
                    None => Value::Null,
                },
            ),
            (
                "simulation_id",
                match &self.simulation_id {
                    Some(id) => Value::string(id),
                    None => Value::Null,
                },
            ),
        ])
        .to_canonical_bytes()
    }

    pub fn sign_with(&mut self, signer: &dyn Signer) -> Result<()> {
        let signature = signer.sign(&self.signing_bytes())?;
        self.signature = Some(signature);
        Ok(())
    }

    pub fn signer_id(&self) -> Option<&str> {
        self.signature
            .as_ref()
            .map(|signature| signature.signer_id.as_str())
    }

    /// Full device-side verification. Every check is mandatory and the order
    /// is fixed so the failure reported is the most specific one.
    pub fn verify(
        &self,
        device_id: &str,
        device_capabilities: &[String],
        registry: &SignerRegistry,
        nonces: &NonceLedger,
        now: Timestamp,
    ) -> std::result::Result<(), VerificationError> {
        // 1. Structural validity.
        self.command
            .validate()
            .map_err(|error| VerificationError::InvalidCommand(error.to_string()))?;
        for constraint in &self.safety_constraints {
            constraint
                .validate()
                .map_err(|error| VerificationError::InvalidConstraint(error.to_string()))?;
        }

        // 2. Addressed to this device.
        if self.device_id != device_id {
            return Err(VerificationError::WrongDevice {
                expected: self.device_id.clone(),
                actual: device_id.to_string(),
            });
        }

        // 3. Time window.
        if now.is_before(self.issued_at) {
            return Err(VerificationError::NotYetValid);
        }
        if !now.is_before(self.expires_at) {
            return Err(VerificationError::Expired {
                expired_by_millis: now.delta_millis(self.expires_at),
            });
        }

        // 4. Signature present and from a known signer.
        let signature = self
            .signature
            .as_ref()
            .ok_or_else(|| VerificationError::BadSignature("task is unsigned".into()))?;
        if !registry.is_known(&signature.signer_id) {
            return Err(VerificationError::UnknownSigner(
                signature.signer_id.clone(),
            ));
        }
        registry
            .verify(&signature.signer_id, &self.signing_bytes(), signature)
            .map_err(|error| VerificationError::BadSignature(error.to_string()))?;

        // 5. A dev signer may never command hardware.
        if self.mode.is_physical()
            && registry
                .require_production_signer(&signature.signer_id)
                .is_err()
        {
            return Err(VerificationError::NonProductionSignerOnHardware(
                signature.signer_id.clone(),
            ));
        }

        // 6. Capability envelope, on both the device and the signer.
        for capability in &self.required_capabilities {
            if !device_capabilities.contains(capability) {
                return Err(VerificationError::MissingCapability(capability.clone()));
            }
            if !registry.permits_capability(&signature.signer_id, capability) {
                return Err(VerificationError::CapabilityNotPermittedForSigner(
                    capability.clone(),
                ));
            }
        }

        // 7. Anti-replay, last so a rejected task does not burn its nonce.
        if !nonces.accept(&self.nonce, self.expires_at) {
            return Err(VerificationError::ReplayedNonce(self.nonce.clone()));
        }

        Ok(())
    }

    pub fn to_json(&self) -> Value {
        let mut value = match nexus_event::json::parse(
            std::str::from_utf8(&self.signing_bytes()).unwrap_or("{}"),
        ) {
            Ok(Value::Object(map)) => Value::Object(map),
            _ => Value::object(vec![]),
        };
        if let (Value::Object(map), Some(signature)) = (&mut value, &self.signature) {
            map.insert(
                "signature".to_string(),
                Value::object(vec![
                    ("algorithm", Value::string(&signature.algorithm)),
                    ("signer_id", Value::string(&signature.signer_id)),
                    ("value", Value::string(&signature.value_hex)),
                ]),
            );
        }
        value
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Completed,
    Rejected,
    Failed,
    /// Stopped early by a local safety condition.
    Aborted,
}

impl TaskStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Completed => "completed",
            TaskStatus::Rejected => "rejected",
            TaskStatus::Failed => "failed",
            TaskStatus::Aborted => "aborted",
        }
    }
}

/// What came back from the device.
#[derive(Debug, Clone, PartialEq)]
pub struct EdgeTaskResult {
    pub task_id: TaskId,
    pub device_id: String,
    pub status: TaskStatus,
    pub completed_at: Timestamp,
    pub duration_millis: u64,
    /// Observations produced, as ontology-ready payloads.
    pub observations: Vec<Value>,
    pub detail: String,
    pub trace_id: TraceId,
}

impl EdgeTaskResult {
    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("task_id", Value::string(self.task_id.as_str())),
            ("device_id", Value::string(&self.device_id)),
            ("status", Value::string(self.status.as_str())),
            (
                "completed_at",
                Value::number(self.completed_at.as_millis() as f64),
            ),
            (
                "duration_millis",
                Value::number(self.duration_millis as f64),
            ),
            ("observations", Value::Array(self.observations.clone())),
            ("detail", Value::string(&self.detail)),
            ("trace_id", Value::string(self.trace_id.as_str())),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command::{FixtureOperation, Waypoint};
    use crate::signing::{DevSigner, TrustedSigner};

    const NOW: i64 = 1_700_000_000_000;

    fn signer() -> DevSigner {
        DevSigner::new("orchestratord", b"0123456789abcdef-test-key").unwrap()
    }

    fn registry() -> SignerRegistry {
        let mut registry = SignerRegistry::new();
        registry.register(TrustedSigner {
            signer_id: "orchestratord".into(),
            verifier: Box::new(signer()),
            permitted_capabilities: vec![],
        });
        registry
    }

    fn task() -> EdgeTask {
        let mut task = EdgeTask::new(
            "robot-inspect-01",
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            Timestamp::from_millis(NOW),
            60_000,
            TraceId::from_external("trc_1"),
            ExecutionMode::Simulation,
        )
        .unwrap()
        .with_constraint(SafetyConstraint::MaxDurationSeconds(30.0));
        task.sign_with(&signer()).unwrap();
        task
    }

    fn capabilities() -> Vec<String> {
        vec![
            "sensor.temperature".to_string(),
            "navigate.waypoint".to_string(),
        ]
    }

    #[test]
    fn a_well_formed_task_verifies() {
        let ledger = NonceLedger::new(64);
        task()
            .verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000),
            )
            .expect("verifies");
    }

    #[test]
    fn an_expired_task_is_refused() {
        let ledger = NonceLedger::new(64);
        let error = task()
            .verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 61_000),
            )
            .unwrap_err();
        assert_eq!(error.code(), "expired");
    }

    #[test]
    fn a_replayed_task_is_refused_the_second_time() {
        let ledger = NonceLedger::new(64);
        let task = task();
        let now = Timestamp::from_millis(NOW + 1_000);
        assert!(task
            .verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                now
            )
            .is_ok());
        let error = task
            .verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                now,
            )
            .unwrap_err();
        assert_eq!(error.code(), "replayed_nonce");
    }

    #[test]
    fn a_rejected_task_does_not_consume_its_nonce() {
        let ledger = NonceLedger::new(64);
        let task = task();
        // Rejected for the wrong device.
        assert!(task
            .verify(
                "some-other-robot",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .is_err());
        assert!(!ledger.has_seen(&task.nonce));
        // The correct device can still run it.
        assert!(task
            .verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .is_ok());
    }

    #[test]
    fn tampering_with_the_command_breaks_the_signature() {
        let mut task = task();
        task.command = EdgeCommand::ManipulateFixture {
            fixture_id: "valve-1".into(),
            operation: FixtureOperation::Open,
        };
        let ledger = NonceLedger::new(64);
        let error = task
            .verify(
                "robot-inspect-01",
                &["manipulator.fixture".to_string()],
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000),
            )
            .unwrap_err();
        assert_eq!(error.code(), "bad_signature");
    }

    #[test]
    fn tampering_with_a_safety_constraint_breaks_the_signature() {
        let mut task = task();
        task.safety_constraints = vec![SafetyConstraint::MaxDurationSeconds(99_999.0)];
        let ledger = NonceLedger::new(64);
        assert_eq!(
            task.verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .unwrap_err()
            .code(),
            "bad_signature"
        );
    }

    #[test]
    fn an_unsigned_task_is_refused() {
        let mut task = task();
        task.signature = None;
        let ledger = NonceLedger::new(64);
        assert_eq!(
            task.verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .unwrap_err()
            .code(),
            "bad_signature"
        );
    }

    #[test]
    fn an_unknown_signer_is_refused() {
        let ledger = NonceLedger::new(64);
        let empty = SignerRegistry::new();
        assert_eq!(
            task()
                .verify(
                    "robot-inspect-01",
                    &capabilities(),
                    &empty,
                    &ledger,
                    Timestamp::from_millis(NOW + 1_000)
                )
                .unwrap_err()
                .code(),
            "unknown_signer"
        );
    }

    #[test]
    fn a_dev_signer_cannot_command_hardware() {
        let mut task = EdgeTask::new(
            "robot-inspect-01",
            EdgeCommand::NavigateToWaypoint {
                waypoint: Waypoint::new(1.0, 2.0, 0.0).unwrap(),
            },
            Timestamp::from_millis(NOW),
            60_000,
            TraceId::from_external("trc_2"),
            ExecutionMode::PhysicalNonWeaponized,
        )
        .unwrap();
        task.sign_with(&signer()).unwrap();

        let ledger = NonceLedger::new(64);
        assert_eq!(
            task.verify(
                "robot-inspect-01",
                &capabilities(),
                &registry(),
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .unwrap_err()
            .code(),
            "non_production_signer_on_hardware"
        );
    }

    #[test]
    fn a_device_without_the_capability_refuses() {
        let ledger = NonceLedger::new(64);
        assert_eq!(
            task()
                .verify(
                    "robot-inspect-01",
                    &["navigate.waypoint".to_string()],
                    &registry(),
                    &ledger,
                    Timestamp::from_millis(NOW + 1_000)
                )
                .unwrap_err()
                .code(),
            "missing_capability"
        );
    }

    #[test]
    fn a_signer_scoped_to_read_only_cannot_authorise_manipulation() {
        let mut task = EdgeTask::new(
            "robot-inspect-01",
            EdgeCommand::ManipulateFixture {
                fixture_id: "valve-1".into(),
                operation: FixtureOperation::Close,
            },
            Timestamp::from_millis(NOW),
            60_000,
            TraceId::from_external("trc_3"),
            ExecutionMode::Simulation,
        )
        .unwrap();
        task.sign_with(&signer()).unwrap();

        let mut scoped = SignerRegistry::new();
        scoped.register(TrustedSigner {
            signer_id: "orchestratord".into(),
            verifier: Box::new(signer()),
            permitted_capabilities: vec!["sensor.temperature".into()],
        });

        let ledger = NonceLedger::new(64);
        assert_eq!(
            task.verify(
                "robot-inspect-01",
                &["manipulator.fixture".to_string()],
                &scoped,
                &ledger,
                Timestamp::from_millis(NOW + 1_000)
            )
            .unwrap_err()
            .code(),
            "capability_not_permitted_for_signer"
        );
    }

    #[test]
    fn nonces_differ_between_tasks() {
        let first = task();
        let second = task();
        assert_ne!(first.nonce, second.nonce);
        assert_ne!(first.task_id, second.task_id);
    }

    #[test]
    fn json_form_includes_the_signature_and_round_trips_the_body() {
        let task = task();
        let json = task.to_json();
        assert_eq!(
            json.get("device_id").and_then(Value::as_str),
            Some("robot-inspect-01")
        );
        assert!(json.get("signature").is_some());
    }
}
