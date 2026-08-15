//! NEXUS-owned checkpoint/replay semantics. Workflow engines are replaceable adapters.
#![forbid(unsafe_code)]
use nexus_event::{NexusError, Result, Timestamp};
use std::collections::BTreeMap;
use std::sync::RwLock;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplayMode {
    SimulationOnly,
    AuditOnly,
}
impl ReplayMode {
    pub const fn allows_physical_dispatch(self) -> bool {
        false
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    pub goal_id: String,
    pub sequence: u64,
    pub state_hash: String,
    pub payload: String,
    pub created_at: Timestamp,
    pub committed_effect_ids: Vec<String>,
}
pub trait DurableStore: Send + Sync {
    fn save(&self, c: Checkpoint) -> Result<()>;
    fn latest(&self, goal: &str) -> Result<Option<Checkpoint>>;
    fn effect_committed(&self, goal: &str, effect: &str) -> Result<bool>;
}
#[derive(Debug, Default)]
pub struct InMemoryDurableStore {
    items: RwLock<BTreeMap<(String, u64), Checkpoint>>,
}
impl DurableStore for InMemoryDurableStore {
    fn save(&self, c: Checkpoint) -> Result<()> {
        if c.goal_id.is_empty() || c.state_hash.is_empty() {
            return Err(NexusError::schema("checkpoint goal/hash required"));
        }
        let mut g = self
            .items
            .write()
            .map_err(|_| NexusError::adapter("durable lock poisoned"))?;
        if let Some((_, last)) = g.iter().rfind(|((id, _), _)| id == &c.goal_id) {
            if c.sequence <= last.sequence {
                return Err(NexusError::invalid("checkpoint sequence must increase"));
            }
        }
        g.insert((c.goal_id.clone(), c.sequence), c);
        Ok(())
    }
    fn latest(&self, goal: &str) -> Result<Option<Checkpoint>> {
        Ok(self
            .items
            .read()
            .map_err(|_| NexusError::adapter("durable lock poisoned"))?
            .iter()
            .filter(|((id, _), _)| id == goal)
            .map(|(_, v)| v.clone())
            .next_back())
    }
    fn effect_committed(&self, goal: &str, effect: &str) -> Result<bool> {
        Ok(self
            .items
            .read()
            .map_err(|_| NexusError::adapter("durable lock poisoned"))?
            .iter()
            .filter(|((id, _), _)| id == goal)
            .any(|(_, v)| v.committed_effect_ids.iter().any(|x| x == effect)))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replay_never_dispatches_physical() {
        assert!(!ReplayMode::SimulationOnly.allows_physical_dispatch());
        assert!(!ReplayMode::AuditOnly.allows_physical_dispatch());
    }
    #[test]
    fn monotonic_checkpoint() {
        let s = InMemoryDurableStore::default();
        let c = |n| Checkpoint {
            goal_id: "g".into(),
            sequence: n,
            state_hash: format!("h{n}"),
            payload: "x".into(),
            created_at: Timestamp::from_millis(n as i64),
            committed_effect_ids: vec![],
        };
        s.save(c(2)).unwrap();
        assert!(s.save(c(1)).is_err());
    }
}
