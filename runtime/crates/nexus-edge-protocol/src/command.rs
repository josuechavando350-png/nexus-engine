//! The closed command set.
//!
//! Every variant here was checked against the guard rails in
//! `docs/security/V3_THREAT_MODEL.md`: inspection, measurement, movement
//! inside a defined workspace, diagnostics and stopping. Nothing that
//! targets, pursues, identifies or applies force to a person, and nothing
//! that operates a weapon.

use nexus_event::json::Value;
use nexus_event::{NexusError, Result};
use nexus_policy::ActionKind;

/// A navigation target inside a facility, in site-local metres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Waypoint {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Waypoint {
    pub fn new(x: f64, y: f64, z: f64) -> Result<Self> {
        let waypoint = Waypoint { x, y, z };
        waypoint.validate()?;
        Ok(waypoint)
    }

    pub fn validate(&self) -> Result<()> {
        for (name, value) in [("x", self.x), ("y", self.y), ("z", self.z)] {
            if !value.is_finite() {
                return Err(NexusError::schema(format!(
                    "waypoint.{name} must be finite"
                )));
            }
            if value.abs() > 10_000.0 {
                return Err(NexusError::invalid(format!(
                    "waypoint.{name} is outside any plausible facility extent"
                )));
            }
        }
        Ok(())
    }

    pub fn distance_to(&self, other: &Waypoint) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        let dz = self.z - other.z;
        (dx * dx + dy * dy + dz * dz).sqrt()
    }

    pub fn to_json(self) -> Value {
        Value::object(vec![
            ("x", Value::number(self.x)),
            ("y", Value::number(self.y)),
            ("z", Value::number(self.z)),
        ])
    }
}

/// A limit the device must enforce locally, independent of the orchestrator.
///
/// These are belt-and-braces: policy already checked them, simulation already
/// checked them, and the device checks them again because a compromised or
/// buggy upstream must not be able to talk a robot past its own limits.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SafetyConstraint {
    MaxLinearSpeedMetersPerSecond(f64),
    MaxDurationSeconds(f64),
    MaxDistanceMeters(f64),
    /// Radius around the current position the device may not leave.
    GeofenceRadiusMeters(f64),
    /// Stop if a human is detected within this distance.
    MinHumanClearanceMeters(f64),
    MaxForceNewtons(f64),
}

impl SafetyConstraint {
    pub fn as_str(self) -> &'static str {
        match self {
            SafetyConstraint::MaxLinearSpeedMetersPerSecond(_) => "max_linear_speed_mps",
            SafetyConstraint::MaxDurationSeconds(_) => "max_duration_s",
            SafetyConstraint::MaxDistanceMeters(_) => "max_distance_m",
            SafetyConstraint::GeofenceRadiusMeters(_) => "geofence_radius_m",
            SafetyConstraint::MinHumanClearanceMeters(_) => "min_human_clearance_m",
            SafetyConstraint::MaxForceNewtons(_) => "max_force_n",
        }
    }

    pub fn value(self) -> f64 {
        match self {
            SafetyConstraint::MaxLinearSpeedMetersPerSecond(value)
            | SafetyConstraint::MaxDurationSeconds(value)
            | SafetyConstraint::MaxDistanceMeters(value)
            | SafetyConstraint::GeofenceRadiusMeters(value)
            | SafetyConstraint::MinHumanClearanceMeters(value)
            | SafetyConstraint::MaxForceNewtons(value) => value,
        }
    }

    pub fn validate(self) -> Result<()> {
        let value = self.value();
        if !value.is_finite() || value <= 0.0 {
            return Err(NexusError::invalid(format!(
                "safety constraint {} must be a positive finite number",
                self.as_str()
            )));
        }
        Ok(())
    }

    pub fn to_json(self) -> Value {
        Value::object(vec![
            ("constraint", Value::string(self.as_str())),
            ("value", Value::number(self.value())),
        ])
    }
}

/// The closed command set. There is no `Raw`, `Script` or `Custom` variant,
/// and CI asserts that none is added without also updating the threat model.
#[derive(Debug, Clone, PartialEq)]
pub enum EdgeCommand {
    /// Read a named sensor already fitted to the device.
    CollectSensorSample { sensor: String, samples: u32 },
    /// Read the device's temperature probe.
    CollectTemperature { probe: String },
    /// Read a thermal frame.
    CollectThermalReading { probe: String },
    /// Capture a still image with a fitted camera.
    CollectImage { camera: String },
    /// Sweep a zone and report readings; movement is bounded by constraints.
    InspectZone { zone_id: String, dwell_seconds: u32 },
    /// Move to an inspection waypoint.
    NavigateToWaypoint { waypoint: Waypoint },
    /// Actuate an end effector on a named fixture inside its workspace.
    ManipulateFixture {
        fixture_id: String,
        operation: FixtureOperation,
    },
    /// Run an on-device self-test.
    RunDiagnostic { suite: String },
    /// Stop safely and hold position.
    SafeStop,
    /// Return to the charging dock.
    ReturnToBase,
}

/// The operations permitted on an industrial fixture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FixtureOperation {
    Open,
    Close,
    Latch,
    Unlatch,
    /// Reset a tripped protective device after the cause is cleared.
    ResetInterlock,
}

impl FixtureOperation {
    pub fn as_str(self) -> &'static str {
        match self {
            FixtureOperation::Open => "open",
            FixtureOperation::Close => "close",
            FixtureOperation::Latch => "latch",
            FixtureOperation::Unlatch => "unlatch",
            FixtureOperation::ResetInterlock => "reset_interlock",
        }
    }
}

impl EdgeCommand {
    pub fn name(&self) -> &'static str {
        match self {
            EdgeCommand::CollectSensorSample { .. } => "collect_sensor_sample",
            EdgeCommand::CollectTemperature { .. } => "collect_temperature",
            EdgeCommand::CollectThermalReading { .. } => "collect_thermal_reading",
            EdgeCommand::CollectImage { .. } => "collect_image",
            EdgeCommand::InspectZone { .. } => "inspect_zone",
            EdgeCommand::NavigateToWaypoint { .. } => "navigate_to_waypoint",
            EdgeCommand::ManipulateFixture { .. } => "manipulate_fixture",
            EdgeCommand::RunDiagnostic { .. } => "run_diagnostic",
            EdgeCommand::SafeStop => "safe_stop",
            EdgeCommand::ReturnToBase => "return_to_base",
        }
    }

    /// Maps to the policy engine's action taxonomy.
    pub fn action_kind(&self) -> ActionKind {
        match self {
            EdgeCommand::CollectSensorSample { .. }
            | EdgeCommand::CollectTemperature { .. }
            | EdgeCommand::CollectThermalReading { .. } => ActionKind::SensorSample,
            EdgeCommand::CollectImage { .. } => ActionKind::Capture,
            EdgeCommand::RunDiagnostic { .. } => ActionKind::Diagnostic,
            EdgeCommand::InspectZone { .. } | EdgeCommand::NavigateToWaypoint { .. } => {
                ActionKind::Navigate
            }
            EdgeCommand::ManipulateFixture { .. } => ActionKind::Manipulate,
            EdgeCommand::SafeStop => ActionKind::SafeStop,
            EdgeCommand::ReturnToBase => ActionKind::ReturnToBase,
        }
    }

    /// Capabilities a device must declare to accept this command.
    pub fn required_capabilities(&self) -> Vec<String> {
        let capabilities: Vec<&str> = match self {
            EdgeCommand::CollectSensorSample { .. } => vec!["sensor.generic"],
            EdgeCommand::CollectTemperature { .. } => vec!["sensor.temperature"],
            EdgeCommand::CollectThermalReading { .. } => vec!["sensor.thermal"],
            EdgeCommand::CollectImage { .. } => vec!["sensor.camera"],
            EdgeCommand::InspectZone { .. } => vec!["navigate.waypoint", "sensor.generic"],
            EdgeCommand::NavigateToWaypoint { .. } => vec!["navigate.waypoint"],
            EdgeCommand::ManipulateFixture { .. } => vec!["manipulator.fixture"],
            EdgeCommand::RunDiagnostic { .. } => vec!["diagnostic.run"],
            // Stopping is always available: never gated behind a capability.
            EdgeCommand::SafeStop => vec![],
            EdgeCommand::ReturnToBase => vec!["navigate.waypoint"],
        };
        capabilities
            .into_iter()
            .map(|capability| capability.to_string())
            .collect()
    }

    /// Whether the command is high impact and therefore needs a human.
    pub fn is_high_impact(&self) -> bool {
        matches!(self, EdgeCommand::ManipulateFixture { .. })
    }

    pub fn validate(&self) -> Result<()> {
        fn check_identifier(name: &str, value: &str) -> Result<()> {
            if value.is_empty() || value.len() > 128 {
                return Err(NexusError::schema(format!(
                    "{name} must be 1..=128 characters"
                )));
            }
            if !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
            {
                return Err(NexusError::schema(format!(
                    "{name} may only contain [A-Za-z0-9._-]"
                )));
            }
            Ok(())
        }

        match self {
            EdgeCommand::CollectSensorSample { sensor, samples } => {
                check_identifier("sensor", sensor)?;
                if *samples == 0 || *samples > 1_000 {
                    return Err(NexusError::invalid("samples must be within 1..=1000"));
                }
            }
            EdgeCommand::CollectTemperature { probe }
            | EdgeCommand::CollectThermalReading { probe } => check_identifier("probe", probe)?,
            EdgeCommand::CollectImage { camera } => check_identifier("camera", camera)?,
            EdgeCommand::InspectZone {
                zone_id,
                dwell_seconds,
            } => {
                check_identifier("zone_id", zone_id)?;
                if *dwell_seconds > 3_600 {
                    return Err(NexusError::invalid("dwell_seconds must be <= 3600"));
                }
            }
            EdgeCommand::NavigateToWaypoint { waypoint } => waypoint.validate()?,
            EdgeCommand::ManipulateFixture { fixture_id, .. } => {
                check_identifier("fixture_id", fixture_id)?
            }
            EdgeCommand::RunDiagnostic { suite } => check_identifier("suite", suite)?,
            EdgeCommand::SafeStop | EdgeCommand::ReturnToBase => {}
        }
        Ok(())
    }

    pub fn to_json(&self) -> Value {
        let parameters = match self {
            EdgeCommand::CollectSensorSample { sensor, samples } => Value::object(vec![
                ("sensor", Value::string(sensor)),
                ("samples", Value::number(*samples as f64)),
            ]),
            EdgeCommand::CollectTemperature { probe }
            | EdgeCommand::CollectThermalReading { probe } => {
                Value::object(vec![("probe", Value::string(probe))])
            }
            EdgeCommand::CollectImage { camera } => {
                Value::object(vec![("camera", Value::string(camera))])
            }
            EdgeCommand::InspectZone {
                zone_id,
                dwell_seconds,
            } => Value::object(vec![
                ("zone_id", Value::string(zone_id)),
                ("dwell_seconds", Value::number(*dwell_seconds as f64)),
            ]),
            EdgeCommand::NavigateToWaypoint { waypoint } => {
                Value::object(vec![("waypoint", waypoint.to_json())])
            }
            EdgeCommand::ManipulateFixture {
                fixture_id,
                operation,
            } => Value::object(vec![
                ("fixture_id", Value::string(fixture_id)),
                ("operation", Value::string(operation.as_str())),
            ]),
            EdgeCommand::RunDiagnostic { suite } => {
                Value::object(vec![("suite", Value::string(suite))])
            }
            EdgeCommand::SafeStop | EdgeCommand::ReturnToBase => Value::object(vec![]),
        };

        Value::object(vec![
            ("command", Value::string(self.name())),
            ("parameters", parameters),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_stop_requires_no_capability() {
        assert!(EdgeCommand::SafeStop.required_capabilities().is_empty());
        assert_eq!(EdgeCommand::SafeStop.action_kind(), ActionKind::SafeStop);
    }

    #[test]
    fn only_manipulation_is_high_impact_by_default() {
        assert!(EdgeCommand::ManipulateFixture {
            fixture_id: "fix-1".into(),
            operation: FixtureOperation::Open,
        }
        .is_high_impact());
        assert!(!EdgeCommand::CollectTemperature {
            probe: "probe-a".into()
        }
        .is_high_impact());
    }

    #[test]
    fn identifiers_are_validated_against_injection() {
        for hostile in ["../etc", "a b", "drop table", "", &"x".repeat(200)] {
            let command = EdgeCommand::CollectTemperature {
                probe: hostile.to_string(),
            };
            assert!(command.validate().is_err(), "must reject {hostile:?}");
        }
        assert!(EdgeCommand::CollectTemperature {
            probe: "probe-a.1".into()
        }
        .validate()
        .is_ok());
    }

    #[test]
    fn waypoints_outside_a_plausible_facility_are_rejected() {
        assert!(Waypoint::new(1.0, 2.0, 0.5).is_ok());
        assert!(Waypoint::new(1e9, 0.0, 0.0).is_err());
        assert!(Waypoint::new(f64::NAN, 0.0, 0.0).is_err());
    }

    #[test]
    fn sample_counts_are_bounded() {
        assert!(EdgeCommand::CollectSensorSample {
            sensor: "s".into(),
            samples: 0
        }
        .validate()
        .is_err());
        assert!(EdgeCommand::CollectSensorSample {
            sensor: "s".into(),
            samples: 10_000
        }
        .validate()
        .is_err());
    }

    #[test]
    fn safety_constraints_must_be_positive() {
        assert!(SafetyConstraint::MaxLinearSpeedMetersPerSecond(0.5)
            .validate()
            .is_ok());
        assert!(SafetyConstraint::MaxLinearSpeedMetersPerSecond(0.0)
            .validate()
            .is_err());
        assert!(SafetyConstraint::MaxForceNewtons(f64::INFINITY)
            .validate()
            .is_err());
    }

    #[test]
    fn command_names_are_unique_and_free_of_prohibited_terms() {
        let commands = vec![
            EdgeCommand::CollectSensorSample {
                sensor: "s".into(),
                samples: 1,
            },
            EdgeCommand::CollectTemperature { probe: "p".into() },
            EdgeCommand::CollectThermalReading { probe: "p".into() },
            EdgeCommand::CollectImage { camera: "c".into() },
            EdgeCommand::InspectZone {
                zone_id: "z".into(),
                dwell_seconds: 5,
            },
            EdgeCommand::NavigateToWaypoint {
                waypoint: Waypoint::new(0.0, 0.0, 0.0).unwrap(),
            },
            EdgeCommand::ManipulateFixture {
                fixture_id: "f".into(),
                operation: FixtureOperation::Latch,
            },
            EdgeCommand::RunDiagnostic { suite: "d".into() },
            EdgeCommand::SafeStop,
            EdgeCommand::ReturnToBase,
        ];

        let mut names = std::collections::HashSet::new();
        for command in &commands {
            assert!(names.insert(command.name()), "duplicate command name");
            command.validate().expect("valid command");
            for forbidden in nexus_policy::FORBIDDEN_CAPABILITY_SUBSTRINGS {
                assert!(
                    !command.name().contains(forbidden),
                    "command {} contains prohibited term {forbidden}",
                    command.name()
                );
                for capability in command.required_capabilities() {
                    assert!(!capability.contains(forbidden));
                }
            }
        }
        assert_eq!(names.len(), 10);
    }
}
