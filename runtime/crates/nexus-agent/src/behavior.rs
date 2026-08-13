//! The physical-behaviour abstraction.

use nexus_edge_protocol::{EdgeCommand, SafetyConstraint, Waypoint};
use nexus_event::json::Value;
use nexus_event::{NexusError, Result, Timestamp};

/// What the agent believes about the world when it plans.
#[derive(Debug, Clone, PartialEq)]
pub struct WorldState {
    pub facility_id: String,
    pub zone_id: String,
    /// Where the robot is, in site-local metres.
    pub robot_pose: Waypoint,
    /// Named points of interest the robot may be sent to.
    pub known_waypoints: Vec<(String, Waypoint)>,
    /// Obstacles the planner must respect, as (centre, radius).
    pub obstacles: Vec<(Waypoint, f64)>,
    /// Whether a person is currently believed to be in the zone.
    pub personnel_present: bool,
    pub observed_at: Timestamp,
}

impl WorldState {
    pub fn waypoint(&self, name: &str) -> Option<Waypoint> {
        self.known_waypoints
            .iter()
            .find(|(known, _)| known == name)
            .map(|(_, waypoint)| *waypoint)
    }
}

/// What the agent has been asked to achieve.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskGoal {
    /// Take an additional reading from an asset.
    ConfirmReading {
        asset_key: String,
        waypoint_name: String,
        probe: String,
    },
    /// Sweep a zone and report.
    InspectZone {
        zone_id: String,
        dwell_seconds: u32,
    },
    /// Run an on-device diagnostic.
    Diagnose { suite: String },
    /// Bring the robot to a safe state.
    Standdown,
}

impl TaskGoal {
    pub fn as_str(&self) -> &'static str {
        match self {
            TaskGoal::ConfirmReading { .. } => "confirm_reading",
            TaskGoal::InspectZone { .. } => "inspect_zone",
            TaskGoal::Diagnose { .. } => "diagnose",
            TaskGoal::Standdown => "standdown",
        }
    }
}

/// What the robot can do. Sourced from the device registry, never assumed.
#[derive(Debug, Clone, PartialEq)]
pub struct RobotCapabilities {
    pub device_id: String,
    pub capabilities: Vec<String>,
    pub max_speed_mps: f64,
    pub max_range_meters: f64,
    pub has_manipulator: bool,
}

impl RobotCapabilities {
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|owned| owned == capability)
    }
}

/// The limits a plan must respect. Always present; a plan without one is
/// rejected by the policy engine's hard invariants.
#[derive(Debug, Clone, PartialEq)]
pub struct SafetyEnvelope {
    pub envelope_id: String,
    pub max_speed_mps: f64,
    pub max_duration_seconds: f64,
    pub geofence_radius_meters: f64,
    pub min_human_clearance_meters: f64,
}

impl SafetyEnvelope {
    /// Conservative default for an occupied industrial facility.
    pub fn conservative(envelope_id: impl Into<String>) -> Self {
        SafetyEnvelope {
            envelope_id: envelope_id.into(),
            max_speed_mps: 0.6,
            max_duration_seconds: 180.0,
            geofence_radius_meters: 40.0,
            min_human_clearance_meters: 2.0,
        }
    }

    pub fn to_constraints(&self) -> Vec<SafetyConstraint> {
        vec![
            SafetyConstraint::MaxLinearSpeedMetersPerSecond(self.max_speed_mps),
            SafetyConstraint::MaxDurationSeconds(self.max_duration_seconds),
            SafetyConstraint::GeofenceRadiusMeters(self.geofence_radius_meters),
            SafetyConstraint::MinHumanClearanceMeters(self.min_human_clearance_meters),
        ]
    }

    pub fn validate(&self) -> Result<()> {
        if self.max_speed_mps <= 0.0 || self.max_speed_mps > 3.0 {
            return Err(NexusError::invalid(
                "max_speed_mps must be within 0..=3 for an indoor industrial robot",
            ));
        }
        if self.min_human_clearance_meters < 0.5 {
            return Err(NexusError::invalid(
                "min_human_clearance_meters must be at least 0.5",
            ));
        }
        Ok(())
    }
}

/// One step of a plan. Each maps to exactly one typed edge command.
#[derive(Debug, Clone, PartialEq)]
pub struct PlanStep {
    pub command: EdgeCommand,
    pub rationale: String,
    pub estimated_duration_seconds: f64,
}

/// The output of a behaviour model.
///
/// A plan is a proposal, not an instruction. It is never executed directly:
/// it goes through schema validation, policy, the safety envelope,
/// simulation, the approval gate and signing first.
#[derive(Debug, Clone, PartialEq)]
pub struct BehaviorPlan {
    pub plan_id: String,
    pub goal: TaskGoal,
    pub steps: Vec<PlanStep>,
    pub envelope: SafetyEnvelope,
    pub model_id: String,
    pub is_learned: bool,
    /// The model's own confidence. Advisory only: it never relaxes a gate.
    pub confidence: f64,
}

impl BehaviorPlan {
    pub fn estimated_duration_seconds(&self) -> f64 {
        self.steps
            .iter()
            .map(|step| step.estimated_duration_seconds)
            .sum()
    }

    pub fn is_high_impact(&self) -> bool {
        self.steps.iter().any(|step| step.command.is_high_impact())
    }

    pub fn required_capabilities(&self) -> Vec<String> {
        let mut capabilities: Vec<String> = self
            .steps
            .iter()
            .flat_map(|step| step.command.required_capabilities())
            .collect();
        capabilities.sort();
        capabilities.dedup();
        capabilities
    }

    /// Structural checks the runtime applies before policy sees the plan.
    pub fn validate(&self, capabilities: &RobotCapabilities) -> Result<()> {
        if self.steps.is_empty() {
            return Err(NexusError::invalid("a plan must contain at least one step"));
        }
        if self.steps.len() > 32 {
            return Err(NexusError::invalid("a plan may not exceed 32 steps"));
        }
        self.envelope.validate()?;

        for step in &self.steps {
            step.command.validate()?;
            for capability in step.command.required_capabilities() {
                if !capabilities.supports(&capability) {
                    return Err(NexusError::denied(format!(
                        "device {} does not support '{capability}'",
                        capabilities.device_id
                    )));
                }
            }
        }

        if self.estimated_duration_seconds() > self.envelope.max_duration_seconds {
            return Err(NexusError::denied(format!(
                "plan duration {:.1}s exceeds the envelope limit of {:.1}s",
                self.estimated_duration_seconds(),
                self.envelope.max_duration_seconds
            )));
        }

        if !(0.0..=1.0).contains(&self.confidence) {
            return Err(NexusError::invalid("confidence must be within 0.0..=1.0"));
        }
        Ok(())
    }

    pub fn to_json(&self) -> Value {
        let steps: Vec<Value> = self
            .steps
            .iter()
            .map(|step| {
                Value::object(vec![
                    ("command", step.command.to_json()),
                    ("rationale", Value::string(&step.rationale)),
                ])
            })
            .collect();
        Value::object(vec![
            ("plan_id", Value::string(&self.plan_id)),
            ("goal", Value::string(self.goal.as_str())),
            ("model_id", Value::string(&self.model_id)),
            ("is_learned", Value::Bool(self.is_learned)),
            ("confidence", Value::number(self.confidence)),
            ("envelope_id", Value::string(&self.envelope.envelope_id)),
            ("steps", Value::Array(steps)),
        ])
    }
}

/// Abstraction over any physical behaviour model.
pub trait BehaviorModel: Send + Sync + std::fmt::Debug {
    fn model_id(&self) -> &str;

    /// Whether this model is a learned system. Recorded in the audit trail so
    /// nobody has to guess what produced a plan.
    fn is_learned(&self) -> bool;

    fn plan(
        &self,
        world: &WorldState,
        goal: &TaskGoal,
        capabilities: &RobotCapabilities,
        envelope: &SafetyEnvelope,
    ) -> Result<BehaviorPlan>;
}

/// Deterministic rule-based planner. Not a learned model, and it says so.
#[derive(Debug, Default)]
pub struct MockBehaviorModel;

impl MockBehaviorModel {
    pub fn new() -> Self {
        MockBehaviorModel
    }
}

impl BehaviorModel for MockBehaviorModel {
    fn model_id(&self) -> &str {
        "mock-rule-based-v1"
    }

    fn is_learned(&self) -> bool {
        false
    }

    fn plan(
        &self,
        world: &WorldState,
        goal: &TaskGoal,
        capabilities: &RobotCapabilities,
        envelope: &SafetyEnvelope,
    ) -> Result<BehaviorPlan> {
        envelope.validate()?;

        // A person in the zone means the only plan is to stop. This is a
        // planner-level guard; policy and the device enforce it again.
        if world.personnel_present && !matches!(goal, TaskGoal::Standdown) {
            return Ok(BehaviorPlan {
                plan_id: format!("plan-standdown-{}", world.observed_at.as_millis()),
                goal: TaskGoal::Standdown,
                steps: vec![PlanStep {
                    command: EdgeCommand::SafeStop,
                    rationale: "personnel present in the zone".into(),
                    estimated_duration_seconds: 1.0,
                }],
                envelope: envelope.clone(),
                model_id: self.model_id().to_string(),
                is_learned: false,
                confidence: 1.0,
            });
        }

        let steps = match goal {
            TaskGoal::Standdown => vec![PlanStep {
                command: EdgeCommand::SafeStop,
                rationale: "standdown requested".into(),
                estimated_duration_seconds: 1.0,
            }],

            TaskGoal::Diagnose { suite } => vec![PlanStep {
                command: EdgeCommand::RunDiagnostic {
                    suite: suite.clone(),
                },
                rationale: "diagnostic requested".into(),
                estimated_duration_seconds: 20.0,
            }],

            TaskGoal::InspectZone {
                zone_id,
                dwell_seconds,
            } => vec![PlanStep {
                command: EdgeCommand::InspectZone {
                    zone_id: zone_id.clone(),
                    dwell_seconds: *dwell_seconds,
                },
                rationale: "zone inspection requested".into(),
                estimated_duration_seconds: *dwell_seconds as f64 + 30.0,
            }],

            TaskGoal::ConfirmReading {
                waypoint_name,
                probe,
                asset_key,
            } => {
                let target = world.waypoint(waypoint_name).ok_or_else(|| {
                    NexusError::not_found(format!("unknown waypoint '{waypoint_name}'"))
                })?;

                let distance = world.robot_pose.distance_to(&target);
                if distance > envelope.geofence_radius_meters {
                    return Err(NexusError::denied(format!(
                        "target is {distance:.1} m away, outside the {:.1} m geofence",
                        envelope.geofence_radius_meters
                    )));
                }
                if distance > capabilities.max_range_meters {
                    return Err(NexusError::denied(format!(
                        "target is beyond the device range of {:.1} m",
                        capabilities.max_range_meters
                    )));
                }

                // Refuse to plan a straight line through a known obstacle.
                // Real path planning belongs in a real planner; this model
                // declines rather than pretending to route around it.
                for (centre, radius) in &world.obstacles {
                    if distance_point_to_segment(*centre, world.robot_pose, target) < *radius {
                        return Err(NexusError::denied(
                            "direct path intersects a known obstacle; \
                             this planner does not route around obstacles",
                        ));
                    }
                }

                let travel_speed = envelope.max_speed_mps.min(capabilities.max_speed_mps);
                let travel_seconds = if travel_speed > 0.0 {
                    distance / travel_speed
                } else {
                    f64::INFINITY
                };

                vec![
                    PlanStep {
                        command: EdgeCommand::NavigateToWaypoint { waypoint: target },
                        rationale: format!("move to inspection point for {asset_key}"),
                        estimated_duration_seconds: travel_seconds,
                    },
                    PlanStep {
                        command: EdgeCommand::CollectTemperature {
                            probe: probe.clone(),
                        },
                        rationale: "take the confirming reading".into(),
                        estimated_duration_seconds: 5.0,
                    },
                ]
            }
        };

        Ok(BehaviorPlan {
            plan_id: format!("plan-{}-{}", goal.as_str(), world.observed_at.as_millis()),
            goal: goal.clone(),
            steps,
            envelope: envelope.clone(),
            model_id: self.model_id().to_string(),
            is_learned: false,
            // A rule-based planner reports what it is: certain about its own
            // rules, not about the world.
            confidence: 1.0,
        })
    }
}

/// Shortest distance from a point to a line segment.
fn distance_point_to_segment(point: Waypoint, start: Waypoint, end: Waypoint) -> f64 {
    let dx = end.x - start.x;
    let dy = end.y - start.y;
    let dz = end.z - start.z;
    let length_squared = dx * dx + dy * dy + dz * dz;
    if length_squared <= f64::EPSILON {
        return point.distance_to(&start);
    }
    let t = (((point.x - start.x) * dx) + ((point.y - start.y) * dy) + ((point.z - start.z) * dz))
        / length_squared;
    let clamped = t.clamp(0.0, 1.0);
    let closest = Waypoint {
        x: start.x + clamped * dx,
        y: start.y + clamped * dy,
        z: start.z + clamped * dz,
    };
    point.distance_to(&closest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn world(personnel_present: bool) -> WorldState {
        WorldState {
            facility_id: "plant-1".into(),
            zone_id: "press-hall".into(),
            robot_pose: Waypoint::new(0.0, 0.0, 0.0).unwrap(),
            known_waypoints: vec![(
                "press-04-inspect".into(),
                Waypoint::new(6.0, 8.0, 0.0).unwrap(),
            )],
            obstacles: vec![],
            personnel_present,
            observed_at: Timestamp::from_millis(1_700_000_000_000),
        }
    }

    fn capabilities() -> RobotCapabilities {
        RobotCapabilities {
            device_id: "robot-inspect-01".into(),
            capabilities: vec![
                "navigate.waypoint".into(),
                "sensor.temperature".into(),
                "sensor.generic".into(),
                "diagnostic.run".into(),
            ],
            max_speed_mps: 1.0,
            max_range_meters: 50.0,
            has_manipulator: false,
        }
    }

    fn goal() -> TaskGoal {
        TaskGoal::ConfirmReading {
            asset_key: "press-4".into(),
            waypoint_name: "press-04-inspect".into(),
            probe: "probe-a".into(),
        }
    }

    #[test]
    fn the_mock_model_declares_that_it_is_not_learned() {
        let model = MockBehaviorModel::new();
        assert!(!model.is_learned());
        assert_eq!(model.model_id(), "mock-rule-based-v1");
    }

    #[test]
    fn confirm_reading_produces_navigate_then_measure() {
        let plan = MockBehaviorModel::new()
            .plan(
                &world(false),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();

        assert_eq!(plan.steps.len(), 2);
        assert_eq!(plan.steps[0].command.name(), "navigate_to_waypoint");
        assert_eq!(plan.steps[1].command.name(), "collect_temperature");
        plan.validate(&capabilities()).unwrap();
        assert!(!plan.is_learned);
    }

    #[test]
    fn personnel_in_the_zone_overrides_every_goal_with_a_safe_stop() {
        let plan = MockBehaviorModel::new()
            .plan(
                &world(true),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();
        assert_eq!(plan.goal, TaskGoal::Standdown);
        assert_eq!(plan.steps.len(), 1);
        assert_eq!(plan.steps[0].command.name(), "safe_stop");
    }

    #[test]
    fn a_target_outside_the_geofence_is_refused() {
        let mut state = world(false);
        state.known_waypoints = vec![(
            "press-04-inspect".into(),
            Waypoint::new(500.0, 0.0, 0.0).unwrap(),
        )];
        let error = MockBehaviorModel::new()
            .plan(
                &state,
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap_err();
        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn the_planner_refuses_rather_than_pretending_to_avoid_an_obstacle() {
        let mut state = world(false);
        state.obstacles = vec![(Waypoint::new(3.0, 4.0, 0.0).unwrap(), 2.0)];
        let error = MockBehaviorModel::new()
            .plan(
                &state,
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap_err();
        assert!(error.to_string().contains("obstacle"));
    }

    #[test]
    fn an_unknown_waypoint_is_an_error_not_a_guess() {
        let bad_goal = TaskGoal::ConfirmReading {
            asset_key: "press-4".into(),
            waypoint_name: "nowhere".into(),
            probe: "probe-a".into(),
        };
        assert!(MockBehaviorModel::new()
            .plan(
                &world(false),
                &bad_goal,
                &capabilities(),
                &SafetyEnvelope::conservative("env-1")
            )
            .is_err());
    }

    #[test]
    fn plans_are_rejected_when_the_device_lacks_a_capability() {
        let plan = MockBehaviorModel::new()
            .plan(
                &world(false),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();

        let limited = RobotCapabilities {
            device_id: "robot-2".into(),
            capabilities: vec!["diagnostic.run".into()],
            max_speed_mps: 1.0,
            max_range_meters: 50.0,
            has_manipulator: false,
        };
        assert!(plan.validate(&limited).is_err());
    }

    #[test]
    fn plans_longer_than_the_envelope_are_rejected() {
        let mut plan = MockBehaviorModel::new()
            .plan(
                &world(false),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();
        plan.steps[0].estimated_duration_seconds = 10_000.0;
        assert!(plan.validate(&capabilities()).is_err());
    }

    #[test]
    fn an_unsafe_envelope_is_rejected() {
        let mut envelope = SafetyEnvelope::conservative("env-1");
        envelope.min_human_clearance_meters = 0.1;
        assert!(envelope.validate().is_err());
        envelope = SafetyEnvelope::conservative("env-1");
        envelope.max_speed_mps = 12.0;
        assert!(envelope.validate().is_err());
    }

    #[test]
    fn the_mock_plan_is_deterministic() {
        let model = MockBehaviorModel::new();
        let first = model
            .plan(
                &world(false),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();
        let second = model
            .plan(
                &world(false),
                &goal(),
                &capabilities(),
                &SafetyEnvelope::conservative("env-1"),
            )
            .unwrap();
        assert_eq!(first, second);
    }
}
