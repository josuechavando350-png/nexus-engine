//! Minimal deterministic world model.
//!
//! See the crate docs for the honest scope statement: this is a kinematic
//! constraint checker, not a physics engine.

use nexus_edge_protocol::{EdgeCommand, SafetyConstraint, Waypoint};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, Timestamp};
use std::collections::BTreeMap;

/// A static object occupying a circle on the floor plan.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldObject {
    pub id: String,
    pub position: Waypoint,
    pub radius_meters: f64,
    /// `true` for objects a robot must never approach within clearance,
    /// e.g. a marked personnel walkway.
    pub is_keep_out: bool,
}

impl WorldObject {
    pub fn obstacle(id: impl Into<String>, position: Waypoint, radius_meters: f64) -> Self {
        WorldObject {
            id: id.into(),
            position,
            radius_meters,
            is_keep_out: false,
        }
    }

    pub fn keep_out(id: impl Into<String>, position: Waypoint, radius_meters: f64) -> Self {
        WorldObject {
            id: id.into(),
            position,
            radius_meters,
            is_keep_out: true,
        }
    }
}

/// The simulated device.
#[derive(Debug, Clone, PartialEq)]
pub struct SimulatedRobot {
    pub device_id: String,
    pub position: Waypoint,
    pub home: Waypoint,
    pub radius_meters: f64,
    pub max_speed_mps: f64,
    pub battery_fraction: f64,
    pub capabilities: Vec<String>,
    pub is_stopped: bool,
}

impl SimulatedRobot {
    pub fn new(device_id: impl Into<String>, home: Waypoint, capabilities: &[&str]) -> Self {
        SimulatedRobot {
            device_id: device_id.into(),
            position: home,
            home,
            radius_meters: 0.4,
            max_speed_mps: 1.0,
            battery_fraction: 1.0,
            capabilities: capabilities
                .iter()
                .map(|capability| capability.to_string())
                .collect(),
            is_stopped: false,
        }
    }

    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|owned| owned == capability)
    }
}

/// Deterministic faults a test can inject.
///
/// Failure injection is a first-class part of the model rather than a test
/// helper, because the resilience behaviour it exercises (degradation,
/// abort, safe stop) is behaviour the runtime is supposed to have.
#[derive(Debug, Clone, PartialEq)]
pub enum FailureInjection {
    /// The named sensor returns an error instead of a reading.
    SensorFailure { sensor: String },
    /// Movement stalls after the given fraction of the leg.
    LocomotionStall { after_fraction: f64 },
    /// Battery is at the given fraction when the plan starts.
    LowBattery { fraction: f64 },
    /// A person enters the zone before the step at this index.
    PersonnelEntersZone { before_step: usize },
    /// The device stops responding from this step onwards.
    DeviceUnreachable { from_step: usize },
}

/// Why a dry run rejected a plan.
#[derive(Debug, Clone, PartialEq)]
pub enum SimulationError {
    Collision { with: String, at_step: usize },
    KeepOutViolation { zone: String, at_step: usize },
    GeofenceExceeded { distance_meters: f64, at_step: usize },
    SpeedExceeded { requested_mps: f64, limit_mps: f64 },
    DurationExceeded { estimated_s: f64, limit_s: f64 },
    HumanClearanceViolated { clearance_meters: f64, at_step: usize },
    MissingCapability { capability: String, at_step: usize },
    BatteryInsufficient { required: f64, available: f64 },
    InjectedFailure { detail: String, at_step: usize },
}

impl SimulationError {
    pub fn code(&self) -> &'static str {
        match self {
            SimulationError::Collision { .. } => "collision",
            SimulationError::KeepOutViolation { .. } => "keep_out_violation",
            SimulationError::GeofenceExceeded { .. } => "geofence_exceeded",
            SimulationError::SpeedExceeded { .. } => "speed_exceeded",
            SimulationError::DurationExceeded { .. } => "duration_exceeded",
            SimulationError::HumanClearanceViolated { .. } => "human_clearance_violated",
            SimulationError::MissingCapability { .. } => "missing_capability",
            SimulationError::BatteryInsufficient { .. } => "battery_insufficient",
            SimulationError::InjectedFailure { .. } => "injected_failure",
        }
    }

    pub fn describe(&self) -> String {
        match self {
            SimulationError::Collision { with, at_step } => {
                format!("step {at_step} collides with {with}")
            }
            SimulationError::KeepOutViolation { zone, at_step } => {
                format!("step {at_step} enters keep-out area {zone}")
            }
            SimulationError::GeofenceExceeded {
                distance_meters,
                at_step,
            } => format!("step {at_step} leaves the geofence by {distance_meters:.2} m"),
            SimulationError::SpeedExceeded {
                requested_mps,
                limit_mps,
            } => format!("requested {requested_mps:.2} m/s exceeds limit {limit_mps:.2} m/s"),
            SimulationError::DurationExceeded {
                estimated_s,
                limit_s,
            } => format!("estimated {estimated_s:.1} s exceeds limit {limit_s:.1} s"),
            SimulationError::HumanClearanceViolated {
                clearance_meters,
                at_step,
            } => format!("step {at_step} comes within {clearance_meters:.2} m of a person"),
            SimulationError::MissingCapability {
                capability,
                at_step,
            } => format!("step {at_step} needs capability '{capability}'"),
            SimulationError::BatteryInsufficient {
                required,
                available,
            } => format!("plan needs {required:.2} battery, {available:.2} available"),
            SimulationError::InjectedFailure { detail, at_step } => {
                format!("injected failure at step {at_step}: {detail}")
            }
        }
    }
}

/// One expected state change produced by one command.
#[derive(Debug, Clone, PartialEq)]
pub struct StateTransition {
    pub step_index: usize,
    pub command: String,
    pub from: Waypoint,
    pub to: Waypoint,
    pub distance_meters: f64,
    pub duration_seconds: f64,
    pub battery_consumed: f64,
    /// Readings the command is expected to produce.
    pub expected_observations: Vec<(String, f64)>,
}

/// Aggregate detail of a dry run.
#[derive(Debug, Clone, PartialEq)]
pub struct SimulationOutcomeDetail {
    pub total_distance_meters: f64,
    pub total_duration_seconds: f64,
    pub total_battery_consumed: f64,
    pub final_position: Waypoint,
    pub min_obstacle_clearance_meters: f64,
}

/// The result of dry-running a command sequence.
#[derive(Debug, Clone, PartialEq)]
pub struct DryRunReport {
    /// Deterministic identifier: the same world and plan give the same id.
    pub simulation_id: String,
    pub passed: bool,
    pub transitions: Vec<StateTransition>,
    pub errors: Vec<SimulationError>,
    pub detail: SimulationOutcomeDetail,
}

impl DryRunReport {
    pub fn first_error_code(&self) -> Option<&'static str> {
        self.errors.first().map(SimulationError::code)
    }

    pub fn to_json(&self) -> Value {
        Value::object(vec![
            ("simulation_id", Value::string(&self.simulation_id)),
            ("passed", Value::Bool(self.passed)),
            ("steps", Value::number(self.transitions.len() as f64)),
            (
                "total_distance_meters",
                Value::number(self.detail.total_distance_meters),
            ),
            (
                "total_duration_seconds",
                Value::number(self.detail.total_duration_seconds),
            ),
            (
                "min_obstacle_clearance_meters",
                Value::number(self.detail.min_obstacle_clearance_meters),
            ),
            (
                "errors",
                Value::Array(
                    self.errors
                        .iter()
                        .map(|error| {
                            Value::object(vec![
                                ("code", Value::string(error.code())),
                                ("detail", Value::string(error.describe())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
}

/// The world: a facility, its zones, its objects and one robot.
#[derive(Debug, Clone)]
pub struct WorldModel {
    pub facility_id: String,
    pub zone_id: String,
    pub robot: SimulatedRobot,
    pub objects: Vec<WorldObject>,
    /// Named inspection waypoints.
    pub waypoints: BTreeMap<String, Waypoint>,
    /// Ambient readings a sensor command will return, keyed by probe name.
    pub sensor_readings: BTreeMap<String, f64>,
    /// Position of any person currently in the zone.
    pub personnel: Vec<Waypoint>,
    pub injections: Vec<FailureInjection>,
    /// Simulated start time; the model never reads the wall clock.
    pub epoch: Timestamp,
}

impl WorldModel {
    pub fn new(facility_id: impl Into<String>, zone_id: impl Into<String>, robot: SimulatedRobot) -> Self {
        WorldModel {
            facility_id: facility_id.into(),
            zone_id: zone_id.into(),
            robot,
            objects: Vec::new(),
            waypoints: BTreeMap::new(),
            sensor_readings: BTreeMap::new(),
            personnel: Vec::new(),
            injections: Vec::new(),
            epoch: Timestamp::from_millis(1_700_000_000_000),
        }
    }

    pub fn with_object(mut self, object: WorldObject) -> Self {
        self.objects.push(object);
        self
    }

    pub fn with_waypoint(mut self, name: &str, waypoint: Waypoint) -> Self {
        self.waypoints.insert(name.to_string(), waypoint);
        self
    }

    pub fn with_reading(mut self, probe: &str, value: f64) -> Self {
        self.sensor_readings.insert(probe.to_string(), value);
        self
    }

    pub fn with_person_at(mut self, position: Waypoint) -> Self {
        self.personnel.push(position);
        self
    }

    pub fn with_injection(mut self, injection: FailureInjection) -> Self {
        self.injections.push(injection);
        self
    }

    fn constraint(&self, constraints: &[SafetyConstraint], wanted: &str) -> Option<f64> {
        constraints
            .iter()
            .find(|constraint| constraint.as_str() == wanted)
            .map(|constraint| constraint.value())
    }

    fn injection_for_step(&self, index: usize) -> Option<&FailureInjection> {
        self.injections.iter().find(|injection| match injection {
            FailureInjection::PersonnelEntersZone { before_step } => *before_step == index,
            FailureInjection::DeviceUnreachable { from_step } => *from_step <= index,
            _ => false,
        })
    }

    /// Dry-runs a command sequence against the declared constraints.
    ///
    /// Collects **all** violations rather than stopping at the first, so an
    /// operator sees everything wrong with a plan in one pass.
    pub fn dry_run(
        &self,
        commands: &[EdgeCommand],
        constraints: &[SafetyConstraint],
    ) -> DryRunReport {
        let mut position = self.robot.position;
        let mut battery = self.robot.battery_fraction;
        let mut personnel = self.personnel.clone();

        let mut transitions: Vec<StateTransition> = Vec::new();
        let mut errors: Vec<SimulationError> = Vec::new();
        let mut total_distance = 0.0f64;
        let mut total_duration = 0.0f64;
        let mut min_clearance = f64::INFINITY;

        let speed_limit = self
            .constraint(constraints, "max_linear_speed_mps")
            .unwrap_or(self.robot.max_speed_mps)
            .min(self.robot.max_speed_mps);
        let duration_limit = self.constraint(constraints, "max_duration_s");
        let geofence = self.constraint(constraints, "geofence_radius_m");
        let human_clearance = self
            .constraint(constraints, "min_human_clearance_m")
            .unwrap_or(2.0);

        if let Some(FailureInjection::LowBattery { fraction }) = self
            .injections
            .iter()
            .find(|injection| matches!(injection, FailureInjection::LowBattery { .. }))
        {
            battery = *fraction;
        }

        for (index, command) in commands.iter().enumerate() {
            // Injected environmental changes take effect before the step.
            match self.injection_for_step(index) {
                Some(FailureInjection::PersonnelEntersZone { .. }) => {
                    personnel.push(position);
                }
                Some(FailureInjection::DeviceUnreachable { .. }) => {
                    errors.push(SimulationError::InjectedFailure {
                        detail: "device unreachable".into(),
                        at_step: index,
                    });
                    break;
                }
                _ => {}
            }

            for capability in command.required_capabilities() {
                if !self.robot.supports(&capability) {
                    errors.push(SimulationError::MissingCapability {
                        capability,
                        at_step: index,
                    });
                }
            }

            let target = match command {
                EdgeCommand::NavigateToWaypoint { waypoint } => *waypoint,
                EdgeCommand::ReturnToBase => self.robot.home,
                EdgeCommand::InspectZone { .. } => position,
                _ => position,
            };

            let distance = position.distance_to(&target);
            let move_duration = if speed_limit > 0.0 {
                distance / speed_limit
            } else {
                0.0
            };
            let dwell = match command {
                EdgeCommand::InspectZone { dwell_seconds, .. } => *dwell_seconds as f64,
                EdgeCommand::CollectSensorSample { samples, .. } => *samples as f64 * 0.5,
                EdgeCommand::CollectTemperature { .. }
                | EdgeCommand::CollectThermalReading { .. } => 2.0,
                EdgeCommand::CollectImage { .. } => 1.0,
                EdgeCommand::RunDiagnostic { .. } => 10.0,
                EdgeCommand::ManipulateFixture { .. } => 8.0,
                EdgeCommand::SafeStop => 1.0,
                _ => 0.0,
            };
            let duration = move_duration + dwell;

            // Obstacle and keep-out checks along the straight-line leg.
            for object in &self.objects {
                let clearance = segment_distance(position, target, object.position)
                    - object.radius_meters
                    - self.robot.radius_meters;
                if clearance < min_clearance {
                    min_clearance = clearance;
                }
                if clearance < 0.0 {
                    if object.is_keep_out {
                        errors.push(SimulationError::KeepOutViolation {
                            zone: object.id.clone(),
                            at_step: index,
                        });
                    } else {
                        errors.push(SimulationError::Collision {
                            with: object.id.clone(),
                            at_step: index,
                        });
                    }
                }
            }

            for person in &personnel {
                let clearance = segment_distance(position, target, *person);
                if clearance < human_clearance {
                    errors.push(SimulationError::HumanClearanceViolated {
                        clearance_meters: clearance,
                        at_step: index,
                    });
                }
            }

            if let Some(radius) = geofence {
                let from_home = target.distance_to(&self.robot.home);
                if from_home > radius {
                    errors.push(SimulationError::GeofenceExceeded {
                        distance_meters: from_home - radius,
                        at_step: index,
                    });
                }
            }

            if let Some(FailureInjection::LocomotionStall { after_fraction }) = self
                .injections
                .iter()
                .find(|injection| matches!(injection, FailureInjection::LocomotionStall { .. }))
            {
                if distance > 0.0 {
                    errors.push(SimulationError::InjectedFailure {
                        detail: format!("locomotion stalled at {:.0}% of the leg", after_fraction * 100.0),
                        at_step: index,
                    });
                }
            }

            let mut observations = Vec::new();
            match command {
                EdgeCommand::CollectTemperature { probe }
                | EdgeCommand::CollectThermalReading { probe } => {
                    let failed = self.injections.iter().any(|injection| {
                        matches!(injection, FailureInjection::SensorFailure { sensor } if sensor == probe)
                    });
                    if failed {
                        errors.push(SimulationError::InjectedFailure {
                            detail: format!("sensor '{probe}' failed"),
                            at_step: index,
                        });
                    } else if let Some(reading) = self.sensor_readings.get(probe) {
                        observations.push((probe.clone(), *reading));
                    }
                }
                EdgeCommand::CollectSensorSample { sensor, samples } => {
                    if let Some(reading) = self.sensor_readings.get(sensor) {
                        for _ in 0..*samples {
                            observations.push((sensor.clone(), *reading));
                        }
                    }
                }
                _ => {}
            }

            // 1% per metre plus 0.05% per second: a crude but deterministic
            // budget, documented as crude.
            let battery_consumed = distance * 0.01 + duration * 0.0005;
            battery -= battery_consumed;

            transitions.push(StateTransition {
                step_index: index,
                command: command.name().to_string(),
                from: position,
                to: target,
                distance_meters: distance,
                duration_seconds: duration,
                battery_consumed,
                expected_observations: observations,
            });

            total_distance += distance;
            total_duration += duration;
            position = target;

            if matches!(command, EdgeCommand::SafeStop) {
                break;
            }
        }

        if battery < 0.0 {
            errors.push(SimulationError::BatteryInsufficient {
                required: self.robot.battery_fraction - battery,
                available: self.robot.battery_fraction,
            });
        }

        if let Some(limit) = duration_limit {
            if total_duration > limit {
                errors.push(SimulationError::DurationExceeded {
                    estimated_s: total_duration,
                    limit_s: limit,
                });
            }
        }

        if speed_limit > self.robot.max_speed_mps {
            errors.push(SimulationError::SpeedExceeded {
                requested_mps: speed_limit,
                limit_mps: self.robot.max_speed_mps,
            });
        }

        if min_clearance == f64::INFINITY {
            min_clearance = 0.0;
        }

        let simulation_id = self.simulation_id(commands);

        DryRunReport {
            simulation_id,
            passed: errors.is_empty(),
            transitions,
            errors,
            detail: SimulationOutcomeDetail {
                total_distance_meters: total_distance,
                total_duration_seconds: total_duration,
                total_battery_consumed: self.robot.battery_fraction - battery,
                final_position: position,
                min_obstacle_clearance_meters: min_clearance,
            },
        }
    }

    /// Deterministic id derived from the world and the plan, so an identical
    /// dry run is recognisably the same run in the audit trail.
    fn simulation_id(&self, commands: &[EdgeCommand]) -> String {
        let mut material = format!(
            "{}|{}|{}|{:.3},{:.3},{:.3}|",
            self.facility_id,
            self.zone_id,
            self.robot.device_id,
            self.robot.position.x,
            self.robot.position.y,
            self.robot.position.z
        );
        for object in &self.objects {
            material.push_str(&format!(
                "{}:{:.2},{:.2},{:.2};",
                object.id, object.position.x, object.position.y, object.radius_meters
            ));
        }
        for command in commands {
            material.push_str(command.name());
            material.push('|');
        }
        format!(
            "sim_{}",
            &nexus_event::hash::sha256_hex(material.as_bytes())[..24]
        )
    }

    /// Applies a command sequence and returns the resulting world.
    ///
    /// Only used by the examples to show state advancing; the orchestrator
    /// never mutates a world model.
    pub fn apply(&self, commands: &[EdgeCommand], constraints: &[SafetyConstraint]) -> Result<WorldModel> {
        let report = self.dry_run(commands, constraints);
        if !report.passed {
            return Err(NexusError::denied(format!(
                "cannot apply a plan that failed simulation: {}",
                report
                    .errors
                    .first()
                    .map(SimulationError::describe)
                    .unwrap_or_default()
            )));
        }
        let mut next = self.clone();
        next.robot.position = report.detail.final_position;
        next.robot.battery_fraction -= report.detail.total_battery_consumed;
        next.robot.is_stopped = commands.iter().any(|c| matches!(c, EdgeCommand::SafeStop));
        Ok(next)
    }
}

/// Shortest distance from `point` to the segment `from`–`to`.
fn segment_distance(from: Waypoint, to: Waypoint, point: Waypoint) -> f64 {
    let dx = to.x - from.x;
    let dy = to.y - from.y;
    let dz = to.z - from.z;
    let length_squared = dx * dx + dy * dy + dz * dz;
    if length_squared <= f64::EPSILON {
        return from.distance_to(&point);
    }
    let t = (((point.x - from.x) * dx) + ((point.y - from.y) * dy) + ((point.z - from.z) * dz))
        / length_squared;
    let clamped = t.clamp(0.0, 1.0);
    let projection = Waypoint {
        x: from.x + clamped * dx,
        y: from.y + clamped * dy,
        z: from.z + clamped * dz,
    };
    projection.distance_to(&point)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(x: f64, y: f64) -> Waypoint {
        Waypoint { x, y, z: 0.0 }
    }

    fn world() -> WorldModel {
        WorldModel::new(
            "plant-1",
            "press-hall",
            SimulatedRobot::new(
                "robot-inspect-01",
                point(0.0, 0.0),
                &["navigate.waypoint", "sensor.temperature", "sensor.generic"],
            ),
        )
        .with_waypoint("press-04-front", point(10.0, 0.0))
        .with_reading("probe-a", 91.5)
    }

    fn constraints() -> Vec<SafetyConstraint> {
        vec![
            SafetyConstraint::MaxLinearSpeedMetersPerSecond(1.0),
            SafetyConstraint::MaxDurationSeconds(300.0),
            SafetyConstraint::GeofenceRadiusMeters(50.0),
            SafetyConstraint::MinHumanClearanceMeters(2.0),
        ]
    }

    #[test]
    fn a_clean_inspection_plan_passes() {
        let plan = vec![
            EdgeCommand::NavigateToWaypoint {
                waypoint: point(10.0, 0.0),
            },
            EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            },
        ];
        let report = world().dry_run(&plan, &constraints());
        assert!(report.passed, "{:?}", report.errors);
        assert_eq!(report.transitions.len(), 2);
        assert!((report.detail.total_distance_meters - 10.0).abs() < 1e-9);
        assert_eq!(
            report.transitions[1].expected_observations,
            vec![("probe-a".to_string(), 91.5)]
        );
    }

    #[test]
    fn dry_run_is_deterministic_and_repeatable() {
        let plan = vec![EdgeCommand::NavigateToWaypoint {
            waypoint: point(5.0, 5.0),
        }];
        let first = world().dry_run(&plan, &constraints());
        let second = world().dry_run(&plan, &constraints());
        assert_eq!(first, second);
        assert_eq!(first.simulation_id, second.simulation_id);
    }

    #[test]
    fn simulation_id_changes_with_the_plan() {
        let a = world().dry_run(
            &[EdgeCommand::SafeStop],
            &constraints(),
        );
        let b = world().dry_run(
            &[EdgeCommand::RunDiagnostic {
                suite: "self".into(),
            }],
            &constraints(),
        );
        assert_ne!(a.simulation_id, b.simulation_id);
    }

    #[test]
    fn a_plan_through_an_obstacle_is_rejected() {
        let blocked = world().with_object(WorldObject::obstacle("pallet-stack", point(5.0, 0.0), 1.0));
        let plan = vec![EdgeCommand::NavigateToWaypoint {
            waypoint: point(10.0, 0.0),
        }];
        let report = blocked.dry_run(&plan, &constraints());
        assert!(!report.passed);
        assert_eq!(report.first_error_code(), Some("collision"));
    }

    #[test]
    fn a_plan_that_passes_beside_an_obstacle_is_allowed() {
        let beside = world().with_object(WorldObject::obstacle("pallet-stack", point(5.0, 4.0), 1.0));
        let plan = vec![EdgeCommand::NavigateToWaypoint {
            waypoint: point(10.0, 0.0),
        }];
        assert!(beside.dry_run(&plan, &constraints()).passed);
    }

    #[test]
    fn keep_out_areas_are_reported_separately_from_collisions() {
        let restricted =
            world().with_object(WorldObject::keep_out("walkway", point(5.0, 0.0), 1.5));
        let report = restricted.dry_run(
            &[EdgeCommand::NavigateToWaypoint {
                waypoint: point(10.0, 0.0),
            }],
            &constraints(),
        );
        assert_eq!(report.first_error_code(), Some("keep_out_violation"));
    }

    #[test]
    fn a_person_on_the_path_violates_clearance() {
        let occupied = world().with_person_at(point(6.0, 0.5));
        let report = occupied.dry_run(
            &[EdgeCommand::NavigateToWaypoint {
                waypoint: point(10.0, 0.0),
            }],
            &constraints(),
        );
        assert!(!report.passed);
        assert!(report
            .errors
            .iter()
            .any(|error| error.code() == "human_clearance_violated"));
    }

    #[test]
    fn the_geofence_is_enforced() {
        let report = world().dry_run(
            &[EdgeCommand::NavigateToWaypoint {
                waypoint: point(400.0, 0.0),
            }],
            &constraints(),
        );
        assert!(report
            .errors
            .iter()
            .any(|error| error.code() == "geofence_exceeded"));
    }

    #[test]
    fn missing_capabilities_are_caught_before_dispatch() {
        let report = world().dry_run(
            &[EdgeCommand::ManipulateFixture {
                fixture_id: "valve-2".into(),
                operation: nexus_edge_protocol::FixtureOperation::Close,
            }],
            &constraints(),
        );
        assert_eq!(report.first_error_code(), Some("missing_capability"));
    }

    #[test]
    fn injected_sensor_failure_fails_the_plan() {
        let failing = world().with_injection(FailureInjection::SensorFailure {
            sensor: "probe-a".into(),
        });
        let report = failing.dry_run(
            &[EdgeCommand::CollectTemperature {
                probe: "probe-a".into(),
            }],
            &constraints(),
        );
        assert!(!report.passed);
        assert_eq!(report.first_error_code(), Some("injected_failure"));
    }

    #[test]
    fn injected_personnel_entry_stops_a_previously_valid_plan() {
        let plan = vec![
            EdgeCommand::NavigateToWaypoint {
                waypoint: point(4.0, 0.0),
            },
            EdgeCommand::NavigateToWaypoint {
                waypoint: point(10.0, 0.0),
            },
        ];
        assert!(world().dry_run(&plan, &constraints()).passed);

        let interrupted = world().with_injection(FailureInjection::PersonnelEntersZone {
            before_step: 1,
        });
        assert!(!interrupted.dry_run(&plan, &constraints()).passed);
    }

    #[test]
    fn all_violations_are_reported_not_just_the_first() {
        let hostile = world()
            .with_object(WorldObject::obstacle("crate", point(5.0, 0.0), 1.0))
            .with_person_at(point(7.0, 0.2));
        let report = hostile.dry_run(
            &[EdgeCommand::NavigateToWaypoint {
                waypoint: point(400.0, 0.0),
            }],
            &constraints(),
        );
        assert!(report.errors.len() >= 3, "{:?}", report.errors);
    }

    #[test]
    fn a_failed_plan_cannot_be_applied() {
        let blocked = world().with_object(WorldObject::obstacle("crate", point(5.0, 0.0), 1.0));
        let plan = vec![EdgeCommand::NavigateToWaypoint {
            waypoint: point(10.0, 0.0),
        }];
        assert!(blocked.apply(&plan, &constraints()).is_err());
    }

    #[test]
    fn applying_a_valid_plan_advances_the_world() {
        let plan = vec![EdgeCommand::NavigateToWaypoint {
            waypoint: point(10.0, 0.0),
        }];
        let next = world().apply(&plan, &constraints()).unwrap();
        assert_eq!(next.robot.position, point(10.0, 0.0));
        assert!(next.robot.battery_fraction < 1.0);
    }

    #[test]
    fn safe_stop_terminates_the_sequence() {
        let plan = vec![
            EdgeCommand::SafeStop,
            EdgeCommand::NavigateToWaypoint {
                waypoint: point(400.0, 0.0),
            },
        ];
        let report = world().dry_run(&plan, &constraints());
        assert_eq!(report.transitions.len(), 1);
        assert!(report.passed);
    }

    #[test]
    fn segment_distance_handles_degenerate_segments() {
        let p = point(3.0, 4.0);
        assert!((segment_distance(point(0.0, 0.0), point(0.0, 0.0), p) - 5.0).abs() < 1e-9);
        assert!((segment_distance(point(0.0, 0.0), point(10.0, 0.0), p) - 4.0).abs() < 1e-9);
        // Projection clamps to the endpoints.
        assert!((segment_distance(point(0.0, 0.0), point(1.0, 0.0), point(5.0, 0.0)) - 4.0).abs() < 1e-9);
    }
}
