//! # nexus-sim
//!
//! A minimal deterministic digital twin, sized for CI rather than for
//! photorealism.
//!
//! Its one job: let the whole chain — proposal, policy, plan, dispatch,
//! execution, audit — be exercised and validated without hardware, and let a
//! plan be dry-run before anything moves.
//!
//! ## Scope, stated plainly
//!
//! This is a kinematic constraint checker, not a physics engine. It models
//! positions, distances, speeds, durations, occupancy and simple circular
//! obstacles. It does **not** model dynamics, friction, contact forces,
//! sensor noise models, or anything else that would justify calling its
//! output a prediction of real-world behaviour. A plan that passes simulation
//! has been shown not to violate the declared constraints *under this model*.
//! That is a necessary condition for dispatch, never a sufficient one, which
//! is why the safety envelope is enforced again on the device.
//!
//! ## Determinism
//!
//! No wall clock, no RNG. Given the same world and the same command sequence,
//! the result is identical, which is what makes replay and failure injection
//! useful in a test.
//!
//! This crate does not depend on `nexus-agent`: it consumes the typed command
//! set directly, so the planner and the simulator stay independent.

#![forbid(unsafe_code)]

pub mod world;

pub use world::{
    DryRunReport, FailureInjection, SimulatedRobot, SimulationError, SimulationOutcomeDetail,
    StateTransition, WorldModel, WorldObject,
};
