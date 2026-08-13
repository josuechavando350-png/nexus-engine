//! Hard invariants.
//!
//! These are evaluated before any configurable rule and can only deny. They
//! exist so that the prohibition on weapons and on human targeting is a
//! property of the binary, not of a config file that ships next to it.
//!
//! Adding, weakening or bypassing anything here is a reviewable source
//! change. The repository CI additionally greps for attempts to route around
//! this module (see `scripts/v3-architecture-gates.mjs`).

use crate::rules::{DenyReason, PolicyRequest};

/// Substrings that may never appear in a requested capability, an action
/// name, or an edge command, in any casing.
///
/// Matching on substrings is intentionally blunt. A false positive costs a
/// rename in review; a false negative would be a weapon capability reaching
/// a device.
pub const FORBIDDEN_CAPABILITY_SUBSTRINGS: &[&str] = &[
    "weapon",
    "munition",
    "ordnance",
    "warhead",
    "firearm",
    "fire_control",
    "firecontrol",
    "fire_mission",
    "weapon_release",
    "weapons_release",
    "launch_missile",
    "missile",
    "torpedo",
    "projectile",
    "ballistic",
    "targeting",
    "target_human",
    "human_target",
    "person_target",
    "track_person",
    "person_tracking",
    "pursue_person",
    "chase_person",
    "engage_target",
    "engagement_zone",
    "kill_chain",
    "lethal",
    "strike",
    "taser",
    "stun_gun",
    "gas_dispersal",
    "crowd_control",
    "facial_recognition",
    "face_recognition",
    "biometric_identify",
    "reidentify_person",
];

/// A named, non-configurable prohibition.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardInvariant {
    /// No capability, action or payload may reference weapons or munitions.
    NoWeaponCapability,
    /// No action may target, track, pursue or identify a human being.
    NoHumanTargeting,
    /// A command whose validity window has passed is dead.
    NoExpiredCommand,
    /// An unknown or unrecognised signer is never trusted.
    NoUnknownSigner,
    /// A nonce seen before is a replay.
    NoReplayedNonce,
    /// A device may not be asked for a capability it does not declare.
    NoUnsupportedCapability,
    /// High-impact physical action requires a recorded human approval.
    NoHighImpactWithoutApproval,
    /// A physical action must have passed simulation.
    NoPhysicalActionWithoutSimulation,
    /// Autonomy may not be delegated without a defined safety envelope.
    NoActionWithoutSafetyEnvelope,
}

impl HardInvariant {
    pub fn as_str(self) -> &'static str {
        match self {
            HardInvariant::NoWeaponCapability => "no_weapon_capability",
            HardInvariant::NoHumanTargeting => "no_human_targeting",
            HardInvariant::NoExpiredCommand => "no_expired_command",
            HardInvariant::NoUnknownSigner => "no_unknown_signer",
            HardInvariant::NoReplayedNonce => "no_replayed_nonce",
            HardInvariant::NoUnsupportedCapability => "no_unsupported_capability",
            HardInvariant::NoHighImpactWithoutApproval => "no_high_impact_without_approval",
            HardInvariant::NoPhysicalActionWithoutSimulation => {
                "no_physical_action_without_simulation"
            }
            HardInvariant::NoActionWithoutSafetyEnvelope => "no_action_without_safety_envelope",
        }
    }

    pub fn description(self) -> &'static str {
        match self {
            HardInvariant::NoWeaponCapability => {
                "Weapon, munition and fire-control capabilities are refused unconditionally."
            }
            HardInvariant::NoHumanTargeting => {
                "Targeting, tracking, pursuing or biometrically identifying a person is refused unconditionally."
            }
            HardInvariant::NoExpiredCommand => "A command past expires_at is refused.",
            HardInvariant::NoUnknownSigner => "A command from an unknown signer is refused.",
            HardInvariant::NoReplayedNonce => "A previously observed nonce is refused.",
            HardInvariant::NoUnsupportedCapability => {
                "A device may not be commanded beyond its declared capabilities."
            }
            HardInvariant::NoHighImpactWithoutApproval => {
                "High-impact physical actions require a recorded human approval."
            }
            HardInvariant::NoPhysicalActionWithoutSimulation => {
                "Physical actions must pass simulation before dispatch."
            }
            HardInvariant::NoActionWithoutSafetyEnvelope => {
                "An action without a defined safety envelope is refused."
            }
        }
    }
}

pub const HARD_INVARIANTS: &[HardInvariant] = &[
    HardInvariant::NoWeaponCapability,
    HardInvariant::NoHumanTargeting,
    HardInvariant::NoExpiredCommand,
    HardInvariant::NoUnknownSigner,
    HardInvariant::NoReplayedNonce,
    HardInvariant::NoUnsupportedCapability,
    HardInvariant::NoHighImpactWithoutApproval,
    HardInvariant::NoPhysicalActionWithoutSimulation,
    HardInvariant::NoActionWithoutSafetyEnvelope,
];

/// Returns the first violated invariant, or `None` if all pass.
///
/// Order matters: the prohibition checks run before the operational ones so
/// that a weapons request is denied as a weapons request, not as an
/// "unsupported capability", and the audit record says so.
pub fn check_hard_invariants(request: &PolicyRequest) -> Option<(HardInvariant, DenyReason)> {
    // 1 & 2 — prohibited intent, checked across every string the caller controls.
    let mut haystacks: Vec<String> = Vec::with_capacity(request.requested_capabilities.len() + 3);
    haystacks.push(request.action_name.to_ascii_lowercase());
    haystacks.push(request.zone_id.to_ascii_lowercase());
    for capability in &request.requested_capabilities {
        haystacks.push(capability.to_ascii_lowercase());
    }
    for annotation in &request.intent_annotations {
        haystacks.push(annotation.to_ascii_lowercase());
    }

    for haystack in &haystacks {
        for forbidden in FORBIDDEN_CAPABILITY_SUBSTRINGS {
            if haystack.contains(forbidden) {
                let invariant = if is_targeting_term(forbidden) {
                    HardInvariant::NoHumanTargeting
                } else {
                    HardInvariant::NoWeaponCapability
                };
                return Some((
                    invariant,
                    DenyReason::new(
                        invariant.as_str(),
                        format!("prohibited term '{forbidden}' present in request"),
                    ),
                ));
            }
        }
    }

    if request.targets_person {
        return Some((
            HardInvariant::NoHumanTargeting,
            DenyReason::new(
                HardInvariant::NoHumanTargeting.as_str(),
                "request declares a human subject as its target",
            ),
        ));
    }

    // 3 — expiry.
    if let Some(expires_at) = request.expires_at_millis {
        if request.now_millis > expires_at {
            return Some((
                HardInvariant::NoExpiredCommand,
                DenyReason::new(
                    HardInvariant::NoExpiredCommand.as_str(),
                    format!("command expired {} ms ago", request.now_millis - expires_at),
                ),
            ));
        }
    }

    // 4 — signer.
    if !request.signer_is_known {
        return Some((
            HardInvariant::NoUnknownSigner,
            DenyReason::new(
                HardInvariant::NoUnknownSigner.as_str(),
                "signer is not in the trusted signer set",
            ),
        ));
    }

    // 5 — replay.
    if request.nonce_already_seen {
        return Some((
            HardInvariant::NoReplayedNonce,
            DenyReason::new(
                HardInvariant::NoReplayedNonce.as_str(),
                "nonce has already been observed",
            ),
        ));
    }

    // 6 — device capability envelope.
    for capability in &request.requested_capabilities {
        if !request
            .device_capabilities
            .iter()
            .any(|owned| owned == capability)
        {
            return Some((
                HardInvariant::NoUnsupportedCapability,
                DenyReason::new(
                    HardInvariant::NoUnsupportedCapability.as_str(),
                    format!("device does not declare capability '{capability}'"),
                ),
            ));
        }
    }

    // 7, 8, 9 — physical-action preconditions.
    if request.action_kind.is_physical() {
        if request.safety_envelope_id.is_none() {
            return Some((
                HardInvariant::NoActionWithoutSafetyEnvelope,
                DenyReason::new(
                    HardInvariant::NoActionWithoutSafetyEnvelope.as_str(),
                    "physical action carries no safety envelope",
                ),
            ));
        }
        if !request.simulation_passed() {
            return Some((
                HardInvariant::NoPhysicalActionWithoutSimulation,
                DenyReason::new(
                    HardInvariant::NoPhysicalActionWithoutSimulation.as_str(),
                    "physical action has not passed simulation",
                ),
            ));
        }
    }

    if request.high_impact && !request.human_approval_present {
        return Some((
            HardInvariant::NoHighImpactWithoutApproval,
            DenyReason::new(
                HardInvariant::NoHighImpactWithoutApproval.as_str(),
                "high-impact action lacks a recorded human approval",
            ),
        ));
    }

    None
}

fn is_targeting_term(term: &str) -> bool {
    matches!(
        term,
        "targeting"
            | "target_human"
            | "human_target"
            | "person_target"
            | "track_person"
            | "person_tracking"
            | "pursue_person"
            | "chase_person"
            | "engage_target"
            | "engagement_zone"
            | "kill_chain"
            | "facial_recognition"
            | "face_recognition"
            | "biometric_identify"
            | "reidentify_person"
            | "crowd_control"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rules::{ActionKind, RiskClass, SimulationOutcome};

    fn base() -> PolicyRequest {
        PolicyRequest {
            action_name: "collect_temperature".into(),
            action_kind: ActionKind::SensorSample,
            device_id: "robot-inspect-01".into(),
            zone_id: "zone-press-hall".into(),
            operator_id: Some("op-42".into()),
            operator_roles: vec!["inspection_operator".into()],
            requested_capabilities: vec!["sensor.temperature".into()],
            device_capabilities: vec![
                "sensor.temperature".into(),
                "navigate.waypoint".into(),
                "diagnostic.run".into(),
            ],
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
    fn a_clean_request_violates_nothing() {
        assert!(check_hard_invariants(&base()).is_none());
    }

    #[test]
    fn weapon_capabilities_are_refused_however_they_are_spelled() {
        for capability in [
            "weapon.release",
            "WEAPON_RELEASE",
            "turret.fire_control",
            "launch_missile",
            "Ordnance.Arm",
            "lethal_effector",
        ] {
            let mut request = base();
            request.requested_capabilities = vec![capability.into()];
            request.device_capabilities = vec![capability.into()];
            let (invariant, _) = check_hard_invariants(&request)
                .unwrap_or_else(|| panic!("must deny capability {capability}"));
            assert_eq!(invariant, HardInvariant::NoWeaponCapability);
        }
    }

    #[test]
    fn human_targeting_is_refused_however_it_is_framed() {
        for term in [
            "track_person",
            "pursue_person",
            "facial_recognition",
            "engage_target",
            "kill_chain",
        ] {
            let mut request = base();
            request.action_name = term.into();
            let (invariant, _) = check_hard_invariants(&request)
                .unwrap_or_else(|| panic!("must deny action {term}"));
            assert_eq!(invariant, HardInvariant::NoHumanTargeting);
        }
    }

    #[test]
    fn declaring_a_person_as_the_subject_is_refused_even_with_clean_wording() {
        let mut request = base();
        request.targets_person = true;
        let (invariant, _) = check_hard_invariants(&request).expect("must deny");
        assert_eq!(invariant, HardInvariant::NoHumanTargeting);
    }

    #[test]
    fn prohibited_terms_hidden_in_annotations_are_still_caught() {
        let mut request = base();
        request.intent_annotations = vec!["operator note: prepare weapon bay".into()];
        assert!(check_hard_invariants(&request).is_some());
    }

    #[test]
    fn expired_commands_are_refused() {
        let mut request = base();
        request.now_millis = 1_700_000_070_000;
        let (invariant, _) = check_hard_invariants(&request).expect("must deny");
        assert_eq!(invariant, HardInvariant::NoExpiredCommand);
    }

    #[test]
    fn unknown_signer_and_replayed_nonce_are_refused() {
        let mut unknown = base();
        unknown.signer_is_known = false;
        assert_eq!(
            check_hard_invariants(&unknown).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoUnknownSigner)
        );

        let mut replay = base();
        replay.nonce_already_seen = true;
        assert_eq!(
            check_hard_invariants(&replay).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoReplayedNonce)
        );
    }

    #[test]
    fn capabilities_beyond_the_device_envelope_are_refused() {
        let mut request = base();
        request.requested_capabilities = vec!["manipulator.grip".into()];
        assert_eq!(
            check_hard_invariants(&request).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoUnsupportedCapability)
        );
    }

    #[test]
    fn physical_actions_need_a_safety_envelope_and_a_passing_simulation() {
        let mut no_envelope = base();
        no_envelope.action_kind = ActionKind::Navigate;
        no_envelope.requested_capabilities = vec!["navigate.waypoint".into()];
        no_envelope.simulation = SimulationOutcome::Passed;
        no_envelope.safety_envelope_id = None;
        assert_eq!(
            check_hard_invariants(&no_envelope).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoActionWithoutSafetyEnvelope)
        );

        let mut unsimulated = base();
        unsimulated.action_kind = ActionKind::Navigate;
        unsimulated.requested_capabilities = vec!["navigate.waypoint".into()];
        unsimulated.simulation = SimulationOutcome::NotRun;
        assert_eq!(
            check_hard_invariants(&unsimulated).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoPhysicalActionWithoutSimulation)
        );

        let mut failed = base();
        failed.action_kind = ActionKind::Manipulate;
        failed.requested_capabilities = vec![];
        failed.simulation = SimulationOutcome::Failed("collision predicted".into());
        assert_eq!(
            check_hard_invariants(&failed).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoPhysicalActionWithoutSimulation)
        );
    }

    #[test]
    fn high_impact_without_approval_is_refused() {
        let mut request = base();
        request.high_impact = true;
        assert_eq!(
            check_hard_invariants(&request).map(|(invariant, _)| invariant),
            Some(HardInvariant::NoHighImpactWithoutApproval)
        );

        request.human_approval_present = true;
        assert!(check_hard_invariants(&request).is_none());
    }

    #[test]
    fn every_invariant_has_a_distinct_name_and_description() {
        let mut names = std::collections::HashSet::new();
        for invariant in HARD_INVARIANTS {
            assert!(names.insert(invariant.as_str()), "duplicate invariant name");
            assert!(!invariant.description().is_empty());
        }
        assert_eq!(names.len(), HARD_INVARIANTS.len());
    }
}
