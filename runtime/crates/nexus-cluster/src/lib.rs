//! V6 cluster membership, epochs, health, and quorum-independent node facts.
#![forbid(unsafe_code)]
use std::collections::{BTreeMap, BTreeSet};
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ClusterId(pub String);
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NodeId(pub String);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum NodeRole {
    Control,
    Compute,
    Edge,
    Observer,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Health {
    Healthy,
    Suspect,
    Unreachable,
    Draining,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeDescriptor {
    pub id: NodeId,
    pub region: String,
    pub zone: String,
    pub role: NodeRole,
    pub capacity_cpu_millis: u64,
    pub capacity_memory_bytes: u64,
    pub labels: BTreeMap<String, String>,
}
impl NodeDescriptor {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.0.trim().is_empty() {
            return Err("node id required".into());
        }
        if self.region.trim().is_empty() || self.zone.trim().is_empty() {
            return Err("node region/zone required".into());
        }
        if self.capacity_cpu_millis == 0 || self.capacity_memory_bytes == 0 {
            return Err("node capacity must be positive".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberState {
    pub descriptor: NodeDescriptor,
    pub health: Health,
    pub epoch: u64,
    pub last_seen_ms: u64,
}
#[derive(Debug, Default)]
pub struct ClusterView {
    members: BTreeMap<NodeId, MemberState>,
    tombstones: BTreeSet<NodeId>,
    epoch: u64,
}
impl ClusterView {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }
    pub fn upsert(&mut self, state: MemberState) -> Result<(), String> {
        state.descriptor.validate()?;
        if self.tombstones.contains(&state.descriptor.id) {
            return Err("tombstoned node cannot rejoin without explicit re-enrollment".into());
        }
        if state.epoch < self.epoch {
            return Err("stale cluster epoch".into());
        }
        if let Some(prev) = self.members.get(&state.descriptor.id) {
            if state.epoch < prev.epoch {
                return Err("stale member epoch".into());
            }
        }
        self.epoch = self.epoch.max(state.epoch);
        self.members.insert(state.descriptor.id.clone(), state);
        Ok(())
    }
    pub fn tombstone(&mut self, id: &NodeId, epoch: u64) -> Result<(), String> {
        if epoch < self.epoch {
            return Err("stale tombstone epoch".into());
        }
        self.epoch = epoch;
        self.members.remove(id);
        self.tombstones.insert(id.clone());
        Ok(())
    }
    pub fn reenroll(&mut self, state: MemberState) -> Result<(), String> {
        state.descriptor.validate()?;
        if !self.tombstones.contains(&state.descriptor.id) {
            return Err("node is not tombstoned".into());
        }
        if state.epoch <= self.epoch {
            return Err("re-enrollment requires a newer epoch".into());
        }
        self.tombstones.remove(&state.descriptor.id);
        self.epoch = state.epoch;
        self.members.insert(state.descriptor.id.clone(), state);
        Ok(())
    }
    pub fn healthy_nodes(&self) -> Vec<&MemberState> {
        self.members
            .values()
            .filter(|m| m.health == Health::Healthy)
            .collect()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn n(id: &str, e: u64) -> MemberState {
        MemberState {
            descriptor: NodeDescriptor {
                id: NodeId(id.into()),
                region: "r".into(),
                zone: "z".into(),
                role: NodeRole::Compute,
                capacity_cpu_millis: 1,
                capacity_memory_bytes: 1,
                labels: Default::default(),
            },
            health: Health::Healthy,
            epoch: e,
            last_seen_ms: 0,
        }
    }
    #[test]
    fn stale_membership_is_rejected() {
        let mut c = ClusterView::default();
        c.upsert(n("n", 2)).unwrap();
        assert!(c.upsert(n("n", 1)).is_err())
    }
    #[test]
    fn tombstone_requires_reenrollment() {
        let mut c = ClusterView::default();
        c.upsert(n("n", 1)).unwrap();
        c.tombstone(&NodeId("n".into()), 2).unwrap();
        assert!(c.upsert(n("n", 3)).is_err());
        c.reenroll(n("n", 3)).unwrap();
        assert_eq!(c.healthy_nodes().len(), 1)
    }
}
