//! The edge runtime port and its default simulation backend.

use crate::host::{HostCall, HostRegistry, MockHost};
use crate::manifest::{CapabilityToken, ModuleManifest};
use nexus_edge_protocol::{
    EdgeCommand, EdgeTask, EdgeTaskResult, ExecutionMode, NonceLedger, SignerRegistry, TaskStatus,
};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, Timestamp};

/// Everything observable about one execution.
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionReport {
    pub result: EdgeTaskResult,
    pub host_calls: Vec<HostCall>,
    pub fuel_consumed: u64,
    pub peak_memory_bytes: usize,
    pub mode: ExecutionMode,
    pub module_id: String,
}

/// A sandbox that can execute a verified task.
pub trait EdgeRuntime: Send + Sync {
    fn backend_name(&self) -> &'static str;

    fn mode(&self) -> ExecutionMode;

    /// Verifies the task and the module, then executes.
    ///
    /// Implementations must verify **before** executing and must not execute
    /// anything on a verification failure.
    fn execute(
        &self,
        task: &EdgeTask,
        module_bytes: &[u8],
        manifest: &ModuleManifest,
        now: Timestamp,
    ) -> Result<ExecutionReport>;
}

/// Default backend: interprets the typed command set with the same limits,
/// manifest verification and host allowlist as the Wasmtime backend.
///
/// This is what CI and the offline demo run. It has no physical effect and
/// refuses to claim otherwise: `mode()` is always `Simulation`.
#[derive(Debug)]
pub struct SimulationExecutor {
    device_id: String,
    device_capabilities: Vec<String>,
    signers: SignerRegistry,
    nonces: NonceLedger,
    host: MockHostFactory,
}

/// Supplies a fresh deterministic host per execution.
#[derive(Debug, Clone)]
pub struct MockHostFactory {
    readings: Vec<(String, f64)>,
}

impl MockHostFactory {
    pub fn new() -> Self {
        MockHostFactory {
            readings: Vec::new(),
        }
    }

    pub fn with_reading(mut self, sensor: &str, value: f64) -> Self {
        self.readings.push((sensor.to_string(), value));
        self
    }

    fn build(&self, now: Timestamp) -> MockHost {
        let mut host = MockHost::new(now);
        for (sensor, value) in &self.readings {
            host = host.with_reading(sensor, *value);
        }
        host
    }
}

impl Default for MockHostFactory {
    fn default() -> Self {
        MockHostFactory::new()
    }
}

impl SimulationExecutor {
    pub fn new(
        device_id: impl Into<String>,
        device_capabilities: Vec<String>,
        signers: SignerRegistry,
        host: MockHostFactory,
    ) -> Self {
        SimulationExecutor {
            device_id: device_id.into(),
            device_capabilities,
            signers,
            nonces: NonceLedger::new(4_096),
            host,
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    /// Capability tokens derived from a verified task. Shared with the
    /// Wasmtime backend so both sandboxes grant identical authority.
    pub fn capability_tokens(task: &EdgeTask) -> Vec<CapabilityToken> {
        let mut tokens: Vec<CapabilityToken> = task
            .required_capabilities
            .iter()
            .map(|capability| {
                CapabilityToken::new(capability, task.task_id.as_str(), task.expires_at)
            })
            .collect();
        // Commands that read a device sensor also get the generic token the
        // host function checks for.
        if task
            .required_capabilities
            .iter()
            .any(|capability| capability.starts_with("sensor."))
        {
            tokens.push(CapabilityToken::new(
                "sensor.generic",
                task.task_id.as_str(),
                task.expires_at,
            ));
        }
        tokens
    }

    /// Deterministic cost model, so fuel exhaustion is testable.
    fn fuel_cost(command: &EdgeCommand) -> u64 {
        match command {
            EdgeCommand::SafeStop => 1_000,
            EdgeCommand::RunDiagnostic { .. } => 250_000,
            EdgeCommand::CollectTemperature { .. }
            | EdgeCommand::CollectThermalReading { .. } => 50_000,
            EdgeCommand::CollectSensorSample { samples, .. } => 20_000 * (*samples as u64),
            EdgeCommand::CollectImage { .. } => 500_000,
            EdgeCommand::InspectZone { dwell_seconds, .. } => {
                100_000 + 10_000 * (*dwell_seconds as u64)
            }
            EdgeCommand::NavigateToWaypoint { .. } => 300_000,
            EdgeCommand::ReturnToBase => 300_000,
            EdgeCommand::ManipulateFixture { .. } => 400_000,
        }
    }

    fn run_command(
        command: &EdgeCommand,
        registry: &HostRegistry,
        now: Timestamp,
    ) -> Result<Vec<Value>> {
        match command {
            EdgeCommand::CollectTemperature { probe }
            | EdgeCommand::CollectThermalReading { probe } => {
                let reading = registry.invoke("nexus_read_sensor", &Value::string(probe))?;
                let observation = Value::object(vec![
                    ("kind", Value::string("temperature")),
                    ("probe", Value::string(probe)),
                    ("celsius", reading),
                    ("observed_at", Value::number(now.as_millis() as f64)),
                ]);
                registry.invoke("nexus_emit_observation", &observation)?;
                Ok(vec![observation])
            }
            EdgeCommand::CollectSensorSample { sensor, samples } => {
                let mut observations = Vec::new();
                for index in 0..*samples {
                    let reading = registry.invoke("nexus_read_sensor", &Value::string(sensor))?;
                    observations.push(Value::object(vec![
                        ("kind", Value::string("sensor_sample")),
                        ("sensor", Value::string(sensor)),
                        ("index", Value::number(index as f64)),
                        ("value", reading),
                    ]));
                }
                Ok(observations)
            }
            EdgeCommand::RunDiagnostic { suite } => {
                registry.invoke("nexus_log", &Value::string(suite))?;
                Ok(vec![Value::object(vec![
                    ("kind", Value::string("diagnostic")),
                    ("suite", Value::string(suite)),
                    ("passed", Value::Bool(true)),
                ])])
            }
            EdgeCommand::SafeStop => Ok(vec![Value::object(vec![
                ("kind", Value::string("state")),
                ("state", Value::string("stopped")),
            ])]),
            other => {
                registry.invoke("nexus_report_progress", &Value::string(other.name()))?;
                Ok(vec![Value::object(vec![
                    ("kind", Value::string("acknowledged")),
                    ("command", Value::string(other.name())),
                ])])
            }
        }
    }
}

impl EdgeRuntime for SimulationExecutor {
    fn backend_name(&self) -> &'static str {
        "simulation-interpreter"
    }

    fn mode(&self) -> ExecutionMode {
        ExecutionMode::Simulation
    }

    fn execute(
        &self,
        task: &EdgeTask,
        module_bytes: &[u8],
        manifest: &ModuleManifest,
        now: Timestamp,
    ) -> Result<ExecutionReport> {
        // 1. The task must verify before anything else happens.
        task.verify(
            &self.device_id,
            &self.device_capabilities,
            &self.signers,
            &self.nonces,
            now,
        )
        .map_err(NexusError::from)?;

        // 2. This backend never claims physical capability.
        if task.mode.is_physical() {
            return Err(NexusError::denied(
                "SimulationExecutor refuses a PHYSICAL_NON_WEAPONIZED task",
            ));
        }

        // 3. The module must match its signed manifest.
        manifest.verify(module_bytes, &self.signers)?;

        // 4. Budgets.
        let fuel_required = SimulationExecutor::fuel_cost(&task.command);
        if fuel_required > manifest.limits.fuel {
            return Err(NexusError::exhausted(format!(
                "command '{}' needs {fuel_required} fuel, module budget is {}",
                task.command.name(),
                manifest.limits.fuel
            )));
        }

        let registry = HostRegistry::new(
            manifest.allowed_host_functions.clone(),
            SimulationExecutor::capability_tokens(task),
            manifest.limits.max_host_calls,
            self.host.build(now),
        );

        let started = std::time::Instant::now();
        let outcome = SimulationExecutor::run_command(&task.command, &registry, now);
        let elapsed = started.elapsed().as_millis() as u64;

        if elapsed > manifest.limits.timeout_millis {
            return Ok(ExecutionReport {
                result: EdgeTaskResult {
                    task_id: task.task_id.clone(),
                    device_id: self.device_id.clone(),
                    status: TaskStatus::Aborted,
                    completed_at: now,
                    duration_millis: elapsed,
                    observations: Vec::new(),
                    detail: format!("exceeded {} ms timeout", manifest.limits.timeout_millis),
                    trace_id: task.trace_id.clone(),
                },
                host_calls: registry.calls(),
                fuel_consumed: fuel_required,
                peak_memory_bytes: 0,
                mode: ExecutionMode::Simulation,
                module_id: manifest.module_id.clone(),
            });
        }

        let (status, observations, detail) = match outcome {
            Ok(observations) => (TaskStatus::Completed, observations, String::new()),
            Err(error) => (TaskStatus::Failed, Vec::new(), error.to_string()),
        };

        let serialized: usize = observations
            .iter()
            .map(|observation| observation.to_canonical_string().len())
            .sum();
        if serialized > manifest.limits.max_output_bytes {
            return Err(NexusError::exhausted(format!(
                "output of {serialized} bytes exceeds the {} byte limit",
                manifest.limits.max_output_bytes
            )));
        }

        Ok(ExecutionReport {
            result: EdgeTaskResult {
                task_id: task.task_id.clone(),
                device_id: self.device_id.clone(),
                status,
                completed_at: now,
                duration_millis: elapsed,
                observations,
                detail,
                trace_id: task.trace_id.clone(),
            },
            host_calls: registry.calls(),
            fuel_consumed: fuel_required,
            peak_memory_bytes: serialized,
            mode: ExecutionMode::Simulation,
            module_id: manifest.module_id.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_edge_protocol::{DevSigner, Signer, TrustedSigner};
    use nexus_event::TraceId;

    const NOW: i64 = 1_700_000_000_000;
    const MODULE: &[u8] = b"\0asm-collect-temperature-module";

    fn signer() -> DevSigner {
        DevSigner::new("orchestratord", b"0123456789abcdef-test-key").unwrap()
    }

    fn signers() -> SignerRegistry {
        let mut registry = SignerRegistry::new();
        registry.register(TrustedSigner {
            signer_id: "orchestratord".into(),
            verifier: Box::new(signer()),
            permitted_capabilities: vec![],
        });
        registry
    }

    fn manifest() -> ModuleManifest {
        let mut manifest = ModuleManifest::new(
            "collect-temperature",
            "1.0.0",
            MODULE,
            vec![
                "nexus_read_sensor".into(),
                "nexus_emit_observation".into(),
                "nexus_log".into(),
                "nexus_report_progress".into(),
            ],
        );
        manifest.signature = Some(signer().sign(&manifest.signing_bytes()).unwrap());
        manifest
    }

    fn executor() -> SimulationExecutor {
        SimulationExecutor::new(
            "robot-inspect-01",
            vec![
                "sensor.temperature".to_string(),
                "sensor.generic".to_string(),
                "navigate.waypoint".to_string(),
                "diagnostic.run".to_string(),
            ],
            signers(),
            MockHostFactory::new().with_reading("probe-a", 94.2),
        )
    }

    fn task(command: EdgeCommand, mode: ExecutionMode) -> EdgeTask {
        let mut task = EdgeTask::new(
            "robot-inspect-01",
            command,
            Timestamp::from_millis(NOW),
            60_000,
            TraceId::from_external("trc_1"),
            mode,
        )
        .unwrap();
        task.sign_with(&signer()).unwrap();
        task
    }

    #[test]
    fn collect_temperature_runs_end_to_end() {
        let executor = executor();
        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        let report = executor
            .execute(&task, MODULE, &manifest(), Timestamp::from_millis(NOW + 100))
            .unwrap();

        assert_eq!(report.result.status, TaskStatus::Completed);
        assert_eq!(report.result.observations.len(), 1);
        assert_eq!(
            report.result.observations[0]
                .get("celsius")
                .and_then(Value::as_f64),
            Some(94.2)
        );
        assert_eq!(report.mode, ExecutionMode::Simulation);
        assert_eq!(report.host_calls.len(), 2);
    }

    #[test]
    fn an_unverified_task_never_reaches_the_module() {
        let executor = executor();
        let mut task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        task.signature = None;
        let error = executor
            .execute(&task, MODULE, &manifest(), Timestamp::from_millis(NOW + 100))
            .unwrap_err();
        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn a_swapped_module_is_refused_even_with_a_valid_task() {
        let executor = executor();
        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        let error = executor
            .execute(
                &task,
                b"\0asm-malicious-replacement",
                &manifest(),
                Timestamp::from_millis(NOW + 100),
            )
            .unwrap_err();
        assert_eq!(error.kind(), "integrity");
    }

    #[test]
    fn the_simulation_backend_refuses_a_physical_task() {
        let executor = executor();
        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::PhysicalNonWeaponized,
        );
        let error = executor
            .execute(&task, MODULE, &manifest(), Timestamp::from_millis(NOW + 100))
            .unwrap_err();
        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn replay_of_the_same_task_is_refused() {
        let executor = executor();
        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        let now = Timestamp::from_millis(NOW + 100);
        assert!(executor.execute(&task, MODULE, &manifest(), now).is_ok());
        assert!(executor.execute(&task, MODULE, &manifest(), now).is_err());
    }

    #[test]
    fn a_command_over_its_fuel_budget_is_refused_before_running() {
        let executor = executor();
        let mut manifest = manifest();
        manifest.limits.fuel = 10;
        manifest.signature = Some(signer().sign(&manifest.signing_bytes()).unwrap());

        let task = task(
            EdgeCommand::CollectImage {
                camera: "cam-1".into(),
            },
            ExecutionMode::Simulation,
        );
        let error = executor
            .execute(&task, MODULE, &manifest, Timestamp::from_millis(NOW + 100))
            .unwrap_err();
        assert_eq!(error.kind(), "exhausted");
    }

    #[test]
    fn a_module_without_the_host_function_fails_the_task_not_the_sandbox() {
        let executor = executor();
        let mut manifest = ModuleManifest::new(
            "restricted",
            "1.0.0",
            MODULE,
            vec!["nexus_log".into()],
        );
        manifest.signature = Some(signer().sign(&manifest.signing_bytes()).unwrap());

        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        let report = executor
            .execute(&task, MODULE, &manifest, Timestamp::from_millis(NOW + 100))
            .unwrap();
        assert_eq!(report.result.status, TaskStatus::Failed);
        assert!(report.result.detail.contains("nexus_read_sensor"));
    }

    #[test]
    fn a_missing_sensor_fixture_fails_loudly_instead_of_inventing_a_reading() {
        let executor = SimulationExecutor::new(
            "robot-inspect-01",
            vec!["sensor.temperature".to_string()],
            signers(),
            MockHostFactory::new(),
        );
        let task = task(
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
            ExecutionMode::Simulation,
        );
        let report = executor
            .execute(&task, MODULE, &manifest(), Timestamp::from_millis(NOW + 100))
            .unwrap();
        assert_eq!(report.result.status, TaskStatus::Failed);
        assert!(report.result.detail.contains("no simulated reading"));
    }

    #[test]
    fn safe_stop_always_executes() {
        let executor = executor();
        let task = task(EdgeCommand::SafeStop, ExecutionMode::Simulation);
        let report = executor
            .execute(&task, MODULE, &manifest(), Timestamp::from_millis(NOW + 100))
            .unwrap();
        assert_eq!(report.result.status, TaskStatus::Completed);
    }
}
