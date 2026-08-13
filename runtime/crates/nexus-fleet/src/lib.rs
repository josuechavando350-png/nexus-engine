//! Fleet lifecycle and staged rollout semantics for edge nodes.
#![forbid(unsafe_code)]
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Ring {
    Canary,
    Early,
    Stable,
    Critical,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceState {
    Enrolled,
    Healthy,
    Degraded,
    Quarantined,
    Draining,
    Retired,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Device {
    pub id: String,
    pub state: DeviceState,
    pub ring: Ring,
    pub hardware_class: String,
    pub software_version: String,
    pub attestation_epoch: u64,
    pub labels: BTreeMap<String, String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RolloutPlan {
    pub release_id: String,
    pub target_rings: Vec<Ring>,
    pub max_parallel: u32,
    pub min_healthy_percent: u8,
    pub halt_on_failure: bool,
    pub excluded: BTreeSet<String>,
}
impl RolloutPlan {
    pub fn validate(&self) -> Result<(), String> {
        if self.release_id.is_empty() {
            return Err("release id required".into());
        }
        if self.target_rings.is_empty() {
            return Err("at least one rollout ring is required".into());
        }
        let unique: std::collections::BTreeSet<_> = self.target_rings.iter().copied().collect();
        if unique.len() != self.target_rings.len() {
            return Err("duplicate rollout ring".into());
        }
        if self.max_parallel == 0 {
            return Err("max_parallel must be positive".into());
        }
        if self.min_healthy_percent == 0 || self.min_healthy_percent > 100 {
            return Err("min healthy percent out of range".into());
        }
        Ok(())
    }
}
