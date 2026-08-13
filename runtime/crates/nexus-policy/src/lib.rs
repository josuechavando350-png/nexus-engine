//! # nexus-policy
//!
//! The safety and authorization engine. Nothing physical happens in NEXUS V3
//! without a [`Decision`] from this crate.
//!
//! ## Design
//!
//! Two layers, evaluated in a fixed order:
//!
//! 1. **Hard invariants** ([`invariants`]). Non-configurable, evaluated
//!    first, and they can only ever produce [`Decision::Denied`]. No policy
//!    set, operator role, configuration file or feature flag can switch one
//!    off. This is where the weapon and human-targeting prohibitions live.
//! 2. **Configurable rules** ([`Rule`]). Ordinary operational policy: device
//!    capability, zone, action type, time window, operator authorization,
//!    risk class, simulation result, task expiration.
//!
//! The engine fails closed. An action that matches no rule is denied, not
//! allowed, and an evaluation that cannot be completed is denied.
//!
//! ## What this crate is not
//!
//! It is not a general policy language and does not embed one. Rules are
//! Rust values, reviewed in code, versioned with the runtime. That is a
//! deliberate trade: less flexibility, no interpreter to sandbox, and a
//! decision that can be read in a diff.

#![forbid(unsafe_code)]

pub mod invariants;
pub mod rules;

pub use invariants::{
    check_hard_invariants, HardInvariant, FORBIDDEN_CAPABILITY_SUBSTRINGS, HARD_INVARIANTS,
};
pub use rules::{
    ActionKind, Decision, DenyReason, PolicyEngine, PolicyRequest, Rule, RuleOutcome, RiskClass,
    SimulationOutcome, TimeWindow,
};
