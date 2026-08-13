//! Host functions.
//!
//! A module can only reach the outside world through these. The allowlist is
//! a compile-time constant; a name that is not in it cannot be imported, and
//! the manifest verifier rejects a manifest that asks for one.
//!
//! Notably absent, and absent on purpose: filesystem access, network access,
//! process spawning, clock setting, and anything that could actuate a device
//! beyond the typed command already authorised by the task.

use crate::manifest::CapabilityToken;
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, Timestamp};
use std::sync::Mutex;

/// The complete set of host functions a module may import.
pub const HOST_ALLOWLIST: &[&str] = &[
    "nexus_read_sensor",
    "nexus_read_pose",
    "nexus_emit_observation",
    "nexus_log",
    "nexus_now_millis",
    "nexus_report_progress",
];

/// Capability required by each host function.
pub fn required_capability(function: &str) -> Option<&'static str> {
    match function {
        "nexus_read_sensor" => Some("sensor.generic"),
        "nexus_read_pose" => Some("navigate.waypoint"),
        "nexus_emit_observation" | "nexus_log" | "nexus_now_millis" | "nexus_report_progress" => {
            None
        }
        _ => None,
    }
}

/// One host call, recorded for the audit trail.
#[derive(Debug, Clone, PartialEq)]
pub struct HostCall {
    pub function: String,
    pub argument: Value,
    pub result: Value,
}

/// What the runtime exposes to a module.
pub trait HostFunction: Send + Sync + std::fmt::Debug {
    fn name(&self) -> &'static str;
    fn call(&self, argument: &Value) -> Result<Value>;
}

/// Deterministic mock host used in `SIMULATION`.
#[derive(Debug)]
pub struct MockHost {
    readings: Mutex<Vec<(String, f64)>>,
    now: Mutex<Timestamp>,
}

impl Default for MockHost {
    fn default() -> Self {
        Self::new(Timestamp::from_millis(0))
    }
}

impl MockHost {
    pub fn new(now: Timestamp) -> Self {
        MockHost {
            readings: Mutex::new(Vec::new()),
            now: Mutex::new(now),
        }
    }

    pub fn with_reading(self, sensor: &str, value: f64) -> Self {
        if let Ok(mut readings) = self.readings.lock() {
            readings.push((sensor.to_string(), value));
        }
        self
    }

    pub fn reading_for(&self, sensor: &str) -> Option<f64> {
        self.readings
            .lock()
            .ok()?
            .iter()
            .find(|(name, _)| name == sensor)
            .map(|(_, value)| *value)
    }

    pub fn now(&self) -> Timestamp {
        self.now
            .lock()
            .map(|now| *now)
            .unwrap_or(Timestamp::from_millis(0))
    }
}

/// Registry of the host functions available to one module instance.
#[derive(Debug)]
pub struct HostRegistry {
    permitted: Vec<String>,
    tokens: Vec<CapabilityToken>,
    max_calls: u32,
    calls: Mutex<Vec<HostCall>>,
    host: MockHost,
}

impl HostRegistry {
    pub fn new(
        permitted: Vec<String>,
        tokens: Vec<CapabilityToken>,
        max_calls: u32,
        host: MockHost,
    ) -> Self {
        HostRegistry {
            permitted,
            tokens,
            max_calls,
            calls: Mutex::new(Vec::new()),
            host,
        }
    }

    pub fn calls(&self) -> Vec<HostCall> {
        self.calls
            .lock()
            .map(|calls| calls.clone())
            .unwrap_or_default()
    }

    pub fn call_count(&self) -> usize {
        self.calls.lock().map(|calls| calls.len()).unwrap_or(0)
    }

    fn has_capability(&self, capability: &str, now: Timestamp) -> bool {
        self.tokens
            .iter()
            .any(|token| token.capability == capability && token.is_valid_at(now))
    }

    pub fn invoke(&self, function: &str, argument: &Value) -> Result<Value> {
        if !HOST_ALLOWLIST.contains(&function) {
            return Err(NexusError::denied(format!(
                "host function '{function}' is not in the allowlist"
            )));
        }

        if !self.permitted.iter().any(|name| name == function) {
            return Err(NexusError::denied(format!(
                "module manifest does not permit host function '{function}'"
            )));
        }

        let now = self.host.now();

        if let Some(capability) = required_capability(function) {
            if !self.has_capability(capability, now) {
                return Err(NexusError::denied(format!(
                    "no valid capability token for '{capability}'"
                )));
            }
        }

        {
            let calls = self
                .calls
                .lock()
                .map_err(|_| NexusError::adapter("host registry poisoned"))?;

            if calls.len() as u32 >= self.max_calls {
                return Err(NexusError::exhausted(format!(
                    "host call budget of {} exhausted",
                    self.max_calls
                )));
            }
        }

        let result = match function {
            "nexus_read_sensor" => {
                let sensor = argument
                    .as_str()
                    .ok_or_else(|| NexusError::schema("nexus_read_sensor expects a string"))?;

                match self.host.reading_for(sensor) {
                    Some(value) => Value::number(value),
                    None => {
                        return Err(NexusError::not_found(format!(
                            "no simulated reading configured for sensor '{sensor}'"
                        )))
                    }
                }
            }

            "nexus_read_pose" => Value::object(vec![
                ("x", Value::number(0.0)),
                ("y", Value::number(0.0)),
                ("z", Value::number(0.0)),
            ]),

            "nexus_emit_observation" => Value::Bool(true),
            "nexus_log" => Value::Bool(true),
            "nexus_now_millis" => Value::number(now.as_millis() as f64),
            "nexus_report_progress" => Value::Bool(true),

            _ => {
                return Err(NexusError::unsupported(function.to_string()));
            }
        };

        if let Ok(mut calls) = self.calls.lock() {
            calls.push(HostCall {
                function: function.to_string(),
                argument: argument.clone(),
                result: result.clone(),
            });
        }

        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(max_calls: u32) -> HostRegistry {
        HostRegistry::new(
            vec!["nexus_read_sensor".into(), "nexus_log".into()],
            vec![CapabilityToken::new(
                "sensor.generic",
                "tsk_1",
                Timestamp::from_millis(10_000),
            )],
            max_calls,
            MockHost::new(Timestamp::from_millis(1_000)).with_reading("probe-a", 91.5),
        )
    }

    #[test]
    fn allowlisted_and_permitted_functions_work() {
        let registry = registry(10);

        let value = registry
            .invoke("nexus_read_sensor", &Value::string("probe-a"))
            .unwrap();

        assert_eq!(value, Value::number(91.5));
        assert_eq!(registry.call_count(), 1);
    }

    #[test]
    fn functions_outside_the_allowlist_are_refused() {
        let registry = registry(10);

        for hostile in [
            "nexus_open_socket",
            "fs_read",
            "spawn_process",
            "nexus_fire_actuator",
        ] {
            let error = registry.invoke(hostile, &Value::Null).unwrap_err();

            assert_eq!(error.kind(), "denied", "must refuse {hostile}");
        }
    }

    #[test]
    fn allowlisted_but_not_manifested_functions_are_refused() {
        let registry = registry(10);

        let error = registry
            .invoke("nexus_read_pose", &Value::Null)
            .unwrap_err();

        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn a_missing_capability_token_blocks_the_call() {
        let registry = HostRegistry::new(
            vec!["nexus_read_sensor".into()],
            vec![],
            10,
            MockHost::new(Timestamp::from_millis(1_000)).with_reading("probe-a", 1.0),
        );

        let error = registry
            .invoke("nexus_read_sensor", &Value::string("probe-a"))
            .unwrap_err();

        assert!(error.to_string().contains("capability token"));
    }

    #[test]
    fn an_expired_capability_token_blocks_the_call() {
        let registry = HostRegistry::new(
            vec!["nexus_read_sensor".into()],
            vec![CapabilityToken::new(
                "sensor.generic",
                "tsk_1",
                Timestamp::from_millis(500),
            )],
            10,
            MockHost::new(Timestamp::from_millis(1_000)).with_reading("probe-a", 1.0),
        );

        assert!(registry
            .invoke("nexus_read_sensor", &Value::string("probe-a"),)
            .is_err());
    }

    #[test]
    fn the_call_budget_is_enforced() {
        let registry = registry(2);

        assert!(registry.invoke("nexus_log", &Value::string("a")).is_ok());

        assert!(registry.invoke("nexus_log", &Value::string("b")).is_ok());

        let error = registry
            .invoke("nexus_log", &Value::string("c"))
            .unwrap_err();

        assert_eq!(error.kind(), "exhausted");
    }

    #[test]
    fn the_allowlist_contains_no_io_or_actuation_primitive() {
        for name in HOST_ALLOWLIST {
            let lowered = name.to_ascii_lowercase();

            for forbidden in [
                "socket",
                "http",
                "file",
                "fs_",
                "open",
                "exec",
                "spawn",
                "write_disk",
                "actuate",
                "fire",
                "weapon",
                "target",
            ] {
                assert!(
                    !lowered.contains(forbidden),
                    "host function {name} contains {forbidden}"
                );
            }
        }
    }

    #[test]
    fn every_host_call_is_recorded_for_the_audit_trail() {
        let registry = registry(10);

        registry
            .invoke("nexus_read_sensor", &Value::string("probe-a"))
            .unwrap();

        registry
            .invoke("nexus_log", &Value::string("hello"))
            .unwrap();

        let calls = registry.calls();

        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].function, "nexus_read_sensor");
        assert_eq!(calls[1].argument, Value::string("hello"));
    }
}
