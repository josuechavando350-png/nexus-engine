//! Configurable policy rules and the evaluation engine.

use crate::invariants::check_hard_invariants;
use std::collections::HashSet;

/// What kind of effect an action has. Drives the physical-action invariants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ActionKind {
    /// Read-only: take a reading from a sensor already pointed where it is.
    SensorSample,
    /// Read-only: capture an image or thermal frame.
    Capture,
    /// Read-only: run an on-device self-test.
    Diagnostic,
    /// Moves the device through space.
    Navigate,
    /// Actuates an end effector inside a defined workspace.
    Manipulate,
    /// Commands the device to a safe stop. Always permitted to *stop*.
    SafeStop,
    /// Sends the device back to its dock.
    ReturnToBase,
}

impl ActionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ActionKind::SensorSample => "sensor_sample",
            ActionKind::Capture => "capture",
            ActionKind::Diagnostic => "diagnostic",
            ActionKind::Navigate => "navigate",
            ActionKind::Manipulate => "manipulate",
            ActionKind::SafeStop => "safe_stop",
            ActionKind::ReturnToBase => "return_to_base",
        }
    }

    /// Whether the action moves matter in the world.
    ///
    /// `SafeStop` is excluded on purpose: requiring a simulation pass before
    /// a robot is allowed to stop would be a safety defect, not a control.
    pub fn is_physical(self) -> bool {
        matches!(
            self,
            ActionKind::Navigate | ActionKind::Manipulate | ActionKind::ReturnToBase
        )
    }

    pub fn is_read_only(self) -> bool {
        matches!(
            self,
            ActionKind::SensorSample | ActionKind::Capture | ActionKind::Diagnostic
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RiskClass {
    Low,
    Moderate,
    High,
}

impl RiskClass {
    pub fn as_str(self) -> &'static str {
        match self {
            RiskClass::Low => "low",
            RiskClass::Moderate => "moderate",
            RiskClass::High => "high",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimulationOutcome {
    /// The action is read-only, so no simulation is required.
    NotRequired,
    /// Simulation was required and has not been performed.
    NotRun,
    Passed,
    Failed(String),
}

/// Inclusive-start, exclusive-end minute-of-day window in local site time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeWindow {
    pub start_minute: u32,
    pub end_minute: u32,
}

impl TimeWindow {
    pub fn new(start_minute: u32, end_minute: u32) -> Self {
        TimeWindow {
            start_minute: start_minute.min(1440),
            end_minute: end_minute.min(1440),
        }
    }

    /// Handles windows that wrap past midnight (e.g. 22:00–06:00).
    pub fn contains(&self, minute_of_day: u32) -> bool {
        if self.start_minute <= self.end_minute {
            minute_of_day >= self.start_minute && minute_of_day < self.end_minute
        } else {
            minute_of_day >= self.start_minute || minute_of_day < self.end_minute
        }
    }
}

/// Machine-readable denial.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DenyReason {
    pub code: String,
    pub detail: String,
}

impl DenyReason {
    pub fn new(code: impl Into<String>, detail: impl Into<String>) -> Self {
        DenyReason {
            code: code.into(),
            detail: detail.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Allowed {
        matched_rule: String,
    },
    RequiresApproval {
        matched_rule: String,
        /// Roles that may grant the approval.
        approver_roles: Vec<String>,
        reason: String,
    },
    Denied {
        reason: DenyReason,
    },
}

impl Decision {
    pub fn is_allowed(&self) -> bool {
        matches!(self, Decision::Allowed { .. })
    }

    pub fn is_denied(&self) -> bool {
        matches!(self, Decision::Denied { .. })
    }

    pub fn requires_approval(&self) -> bool {
        matches!(self, Decision::RequiresApproval { .. })
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Decision::Allowed { .. } => "allowed",
            Decision::RequiresApproval { .. } => "requires_approval",
            Decision::Denied { .. } => "denied",
        }
    }

    pub fn denial_code(&self) -> Option<&str> {
        match self {
            Decision::Denied { reason } => Some(reason.code.as_str()),
            _ => None,
        }
    }
}

/// Everything the engine is allowed to consider. A rule cannot reach outside
/// this struct, which keeps decisions reproducible and auditable.
#[derive(Debug, Clone)]
pub struct PolicyRequest {
    pub action_name: String,
    pub action_kind: ActionKind,
    pub device_id: String,
    pub zone_id: String,
    pub operator_id: Option<String>,
    pub operator_roles: Vec<String>,
    pub requested_capabilities: Vec<String>,
    pub device_capabilities: Vec<String>,
    pub risk_class: RiskClass,
    pub high_impact: bool,
    pub human_approval_present: bool,
    pub simulation: SimulationOutcome,
    pub safety_envelope_id: Option<String>,
    pub now_millis: i64,
    pub expires_at_millis: Option<i64>,
    pub signer_is_known: bool,
    pub nonce_already_seen: bool,
    /// Set by upstream correlation when the subject of the action is a person.
    pub targets_person: bool,
    /// Free-text intent from the proposal, scanned for prohibited terms.
    pub intent_annotations: Vec<String>,
}

impl PolicyRequest {
    pub fn simulation_passed(&self) -> bool {
        matches!(
            self.simulation,
            SimulationOutcome::Passed | SimulationOutcome::NotRequired
        )
    }

    pub fn minute_of_day(&self) -> u32 {
        let millis_in_day = self.now_millis.rem_euclid(86_400_000);
        (millis_in_day / 60_000) as u32
    }
}

/// What a rule says when it matches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleOutcome {
    Allow,
    RequireApproval {
        approver_roles: Vec<String>,
        reason: String,
    },
    Deny {
        code: String,
        detail: String,
    },
}

/// A configurable rule. All populated conditions must match.
#[derive(Debug, Clone)]
pub struct Rule {
    pub name: String,
    pub action_kinds: Vec<ActionKind>,
    pub zones: Vec<String>,
    pub devices: Vec<String>,
    pub required_operator_roles: Vec<String>,
    pub max_risk_class: Option<RiskClass>,
    pub time_window: Option<TimeWindow>,
    pub outcome: RuleOutcome,
}

impl Rule {
    pub fn new(name: impl Into<String>, outcome: RuleOutcome) -> Self {
        Rule {
            name: name.into(),
            action_kinds: Vec::new(),
            zones: Vec::new(),
            devices: Vec::new(),
            required_operator_roles: Vec::new(),
            max_risk_class: None,
            time_window: None,
            outcome,
        }
    }

    pub fn for_kinds(mut self, kinds: &[ActionKind]) -> Self {
        self.action_kinds = kinds.to_vec();
        self
    }

    pub fn in_zones(mut self, zones: &[&str]) -> Self {
        self.zones = zones.iter().map(|zone| zone.to_string()).collect();
        self
    }

    pub fn on_devices(mut self, devices: &[&str]) -> Self {
        self.devices = devices.iter().map(|device| device.to_string()).collect();
        self
    }

    pub fn requiring_roles(mut self, roles: &[&str]) -> Self {
        self.required_operator_roles = roles.iter().map(|role| role.to_string()).collect();
        self
    }

    pub fn up_to_risk(mut self, risk: RiskClass) -> Self {
        self.max_risk_class = Some(risk);
        self
    }

    pub fn during(mut self, window: TimeWindow) -> Self {
        self.time_window = Some(window);
        self
    }

    fn matches(&self, request: &PolicyRequest) -> bool {
        if !self.action_kinds.is_empty() && !self.action_kinds.contains(&request.action_kind) {
            return false;
        }
        if !self.zones.is_empty() && !self.zones.iter().any(|zone| zone == &request.zone_id) {
            return false;
        }
        if !self.devices.is_empty()
            && !self.devices.iter().any(|device| device == &request.device_id)
        {
            return false;
        }
        if !self.required_operator_roles.is_empty() {
            let held: HashSet<&str> = request
                .operator_roles
                .iter()
                .map(|role| role.as_str())
                .collect();
            if !self
                .required_operator_roles
                .iter()
                .any(|role| held.contains(role.as_str()))
            {
                return false;
            }
        }
        if let Some(max_risk) = self.max_risk_class {
            if request.risk_class > max_risk {
                return false;
            }
        }
        if let Some(window) = self.time_window {
            if !window.contains(request.minute_of_day()) {
                return false;
            }
        }
        true
    }
}

/// Evaluates hard invariants, then the configured rule set in order.
#[derive(Debug, Default)]
pub struct PolicyEngine {
    rules: Vec<Rule>,
}

impl PolicyEngine {
    pub fn new() -> Self {
        PolicyEngine { rules: Vec::new() }
    }

    pub fn with_rule(mut self, rule: Rule) -> Self {
        self.rules.push(rule);
        self
    }

    pub fn add_rule(&mut self, rule: Rule) {
        self.rules.push(rule);
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }

    /// A conservative default suitable for the reference deployments.
    ///
    /// Read-only actions are allowed to authorised inspection operators;
    /// navigation is allowed at low and moderate risk; manipulation always
    /// needs a human; anything else falls through to the default deny.
    pub fn industrial_baseline() -> Self {
        PolicyEngine::new()
            .with_rule(Rule::new("safe-stop-always-allowed", RuleOutcome::Allow).for_kinds(&[
                ActionKind::SafeStop,
            ]))
            .with_rule(
                Rule::new("read-only-inspection", RuleOutcome::Allow)
                    .for_kinds(&[
                        ActionKind::SensorSample,
                        ActionKind::Capture,
                        ActionKind::Diagnostic,
                    ])
                    .requiring_roles(&["inspection_operator", "site_supervisor", "automation"])
                    .up_to_risk(RiskClass::Moderate),
            )
            .with_rule(
                Rule::new("navigation-low-risk", RuleOutcome::Allow)
                    .for_kinds(&[ActionKind::Navigate, ActionKind::ReturnToBase])
                    .requiring_roles(&["inspection_operator", "site_supervisor", "automation"])
                    .up_to_risk(RiskClass::Low),
            )
            .with_rule(
                Rule::new(
                    "navigation-moderate-risk-needs-approval",
                    RuleOutcome::RequireApproval {
                        approver_roles: vec!["site_supervisor".into()],
                        reason: "navigation at moderate risk in an occupied facility".into(),
                    },
                )
                .for_kinds(&[ActionKind::Navigate])
                .up_to_risk(RiskClass::Moderate),
            )
            .with_rule(
                Rule::new(
                    "manipulation-always-needs-approval",
                    RuleOutcome::RequireApproval {
                        approver_roles: vec!["site_supervisor".into(), "safety_officer".into()],
                        reason: "end-effector actuation is high impact by default".into(),
                    },
                )
                .for_kinds(&[ActionKind::Manipulate]),
            )
            .with_rule(Rule::new(
                "high-risk-denied-by-default",
                RuleOutcome::Deny {
                    code: "risk_class_too_high".into(),
                    detail: "high risk class has no permitting rule".into(),
                },
            ))
    }

    pub fn evaluate(&self, request: &PolicyRequest) -> Decision {
        // Layer 1: non-configurable prohibitions.
        if let Some((_, reason)) = check_hard_invariants(request) {
            return Decision::Denied { reason };
        }

        // Layer 2: first matching rule wins.
        for rule in &self.rules {
            if !rule.matches(request) {
                continue;
            }
            return match &rule.outcome {
                RuleOutcome::Allow => Decision::Allowed {
                    matched_rule: rule.name.clone(),
                },
                RuleOutcome::RequireApproval {
                    approver_roles,
                    reason,
                } => {
                    // An approval already recorded upstream satisfies the rule.
                    if request.human_approval_present {
                        Decision::Allowed {
                            matched_rule: rule.name.clone(),
                        }
                    } else {
                        Decision::RequiresApproval {
                            matched_rule: rule.name.clone(),
                            approver_roles: approver_roles.clone(),
                            reason: reason.clone(),
                        }
                    }
                }
                RuleOutcome::Deny { code, detail } => Decision::Denied {
                    reason: DenyReason::new(code.clone(), detail.clone()),
                },
            };
        }

        // Fail closed.
        Decision::Denied {
            reason: DenyReason::new(
                "no_matching_rule",
                format!(
                    "no rule permits action '{}' of kind {} in zone '{}'",
                    request.action_name,
                    request.action_kind.as_str(),
                    request.zone_id
                ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(kind: ActionKind) -> PolicyRequest {
        PolicyRequest {
            action_name: "collect_temperature".into(),
            action_kind: kind,
            device_id: "robot-inspect-01".into(),
            zone_id: "zone-press-hall".into(),
            operator_id: Some("op-42".into()),
            operator_roles: vec!["inspection_operator".into()],
            requested_capabilities: vec![],
            device_capabilities: vec![],
            risk_class: RiskClass::Low,
            high_impact: false,
            human_approval_present: false,
            simulation: SimulationOutcome::NotRequired,
            safety_envelope_id: Some("envelope-default".into()),
            now_millis: 1_700_000_000_000,
            expires_at_millis: Some(1_700_000_060_000),
            signer_is_known: true,
            nonce_already_seen: false,
            targets_person: false,
            intent_annotations: vec![],
        }
    }

    #[test]
    fn engine_with_no_rules_denies_everything() {
        let engine = PolicyEngine::new();
        let decision = engine.evaluate(&request(ActionKind::SensorSample));
        assert_eq!(decision.denial_code(), Some("no_matching_rule"));
    }

    #[test]
    fn baseline_allows_read_only_inspection() {
        let engine = PolicyEngine::industrial_baseline();
        let decision = engine.evaluate(&request(ActionKind::SensorSample));
        assert!(decision.is_allowed(), "{decision:?}");
    }

    #[test]
    fn baseline_requires_approval_for_manipulation() {
        let engine = PolicyEngine::industrial_baseline();
        let mut req = request(ActionKind::Manipulate);
        req.simulation = SimulationOutcome::Passed;
        let decision = engine.evaluate(&req);
        assert!(decision.requires_approval(), "{decision:?}");
        match decision {
            Decision::RequiresApproval { approver_roles, .. } => {
                assert!(approver_roles.contains(&"safety_officer".to_string()));
            }
            other => panic!("unexpected decision {other:?}"),
        }
    }

    #[test]
    fn recorded_approval_upgrades_the_decision_to_allowed() {
        let engine = PolicyEngine::industrial_baseline();
        let mut req = request(ActionKind::Manipulate);
        req.simulation = SimulationOutcome::Passed;
        req.human_approval_present = true;
        req.high_impact = true;
        assert!(engine.evaluate(&req).is_allowed());
    }

    #[test]
    fn safe_stop_is_allowed_without_simulation_or_approval() {
        let engine = PolicyEngine::industrial_baseline();
        let mut req = request(ActionKind::SafeStop);
        req.simulation = SimulationOutcome::NotRun;
        req.risk_class = RiskClass::High;
        assert!(engine.evaluate(&req).is_allowed());
    }

    #[test]
    fn hard_invariants_beat_a_permissive_rule() {
        // A rule that would allow anything, and a request that is prohibited.
        let engine = PolicyEngine::new().with_rule(Rule::new("allow-all", RuleOutcome::Allow));
        let mut req = request(ActionKind::Navigate);
        req.action_name = "weapon_release".into();
        req.simulation = SimulationOutcome::Passed;
        let decision = engine.evaluate(&req);
        assert_eq!(decision.denial_code(), Some("no_weapon_capability"));
    }

    #[test]
    fn permissive_rule_cannot_bypass_the_approval_invariant() {
        let engine = PolicyEngine::new().with_rule(Rule::new("allow-all", RuleOutcome::Allow));
        let mut req = request(ActionKind::Manipulate);
        req.simulation = SimulationOutcome::Passed;
        req.high_impact = true;
        assert_eq!(
            engine.evaluate(&req).denial_code(),
            Some("no_high_impact_without_approval")
        );
    }

    #[test]
    fn rules_match_on_zone_device_and_role() {
        let engine = PolicyEngine::new().with_rule(
            Rule::new("scoped", RuleOutcome::Allow)
                .in_zones(&["zone-a"])
                .on_devices(&["robot-1"])
                .requiring_roles(&["supervisor"]),
        );

        let mut req = request(ActionKind::SensorSample);
        req.zone_id = "zone-a".into();
        req.device_id = "robot-1".into();
        req.operator_roles = vec!["supervisor".into()];
        assert!(engine.evaluate(&req).is_allowed());

        req.zone_id = "zone-b".into();
        assert!(engine.evaluate(&req).is_denied());
    }

    #[test]
    fn time_windows_wrap_past_midnight() {
        let night = TimeWindow::new(22 * 60, 6 * 60);
        assert!(night.contains(23 * 60));
        assert!(night.contains(2 * 60));
        assert!(!night.contains(12 * 60));

        let day = TimeWindow::new(8 * 60, 17 * 60);
        assert!(day.contains(9 * 60));
        assert!(!day.contains(20 * 60));
    }

    #[test]
    fn risk_ceiling_is_enforced_by_rule_matching() {
        let engine = PolicyEngine::industrial_baseline();
        let mut req = request(ActionKind::Navigate);
        req.simulation = SimulationOutcome::Passed;
        req.risk_class = RiskClass::High;
        // Falls past both navigation rules into the high-risk deny.
        assert_eq!(
            engine.evaluate(&req).denial_code(),
            Some("risk_class_too_high")
        );
    }

    #[test]
    fn decision_ordering_is_deny_then_approval_then_allow() {
        // The first matching rule wins, so ordering in the engine is
        // meaningful and is asserted here to prevent silent reordering.
        let engine = PolicyEngine::industrial_baseline();
        let mut req = request(ActionKind::Navigate);
        req.simulation = SimulationOutcome::Passed;
        req.risk_class = RiskClass::Moderate;
        assert!(engine.evaluate(&req).requires_approval());
    }
}
