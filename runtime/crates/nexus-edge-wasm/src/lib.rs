//! # nexus-edge-wasm
//!
//! The sandbox that executes task handlers on a device.
//!
//! ## Threat model in one line
//!
//! The orchestrator is not trusted to send safe code, and the module is not
//! trusted to behave. So: the module is content-addressed and its hash is
//! checked against a signed manifest before load; it runs with a memory cap,
//! a fuel budget and a wall-clock timeout; it has no filesystem and no
//! network; and it can only call host functions that appear in an explicit
//! allowlist, each gated by a capability token derived from the task.
//!
//! ## Two modes
//!
//! [`ExecutionMode::Simulation`] mocks every host function and has no
//! physical effect. [`ExecutionMode::PhysicalNonWeaponized`] reaches real
//! hardware and additionally requires a production-grade signature. CI and
//! the examples run in `SIMULATION`.
//!
//! ## Default backend
//!
//! The default build ships [`SimulationExecutor`], which interprets the typed
//! [`EdgeCommand`] set directly and enforces the same limits, manifest checks
//! and host-function allowlist. The Wasmtime backend is behind the `wasmtime`
//! feature. Both implement [`EdgeRuntime`], so the caller does not change.

#![forbid(unsafe_code)]

pub mod host;
pub mod manifest;
pub mod runtime;

#[cfg(feature = "wasmtime")]
pub mod wasmtime_host;

pub use host::{HostCall, HostFunction, HostRegistry, MockHost, HOST_ALLOWLIST};
pub use manifest::{CapabilityToken, ModuleManifest, ResourceLimits};
pub use runtime::{EdgeRuntime, ExecutionReport, MockHostFactory, SimulationExecutor};

pub use nexus_edge_protocol::ExecutionMode;
