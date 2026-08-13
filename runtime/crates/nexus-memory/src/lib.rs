//! NEXUS V4 memory semantics. A vector database is an adapter, not memory itself.
#![forbid(unsafe_code)]

use nexus_event::{NexusError, Result, Timestamp};
use std::collections::BTreeMap;
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MemoryKind {
    Working,
    Episodic,
    Semantic,
    Procedural,
    Goal,
}

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryRecord {
    pub id: String,
    pub kind: MemoryKind,
    pub created_at: Timestamp,
    pub valid_from: Timestamp,
    pub valid_until: Option<Timestamp>,
    pub source_refs: Vec<String>,
    pub ontology_refs: Vec<String>,
    pub causal_refs: Vec<String>,
    pub scope: String,
    pub confidence: f64,
    pub payload: String,
    pub embedding_ref: Option<String>,
}
impl MemoryRecord {
    pub fn validate(&self) -> Result<()> {
        if self.id.trim().is_empty() {
            return Err(NexusError::schema("memory id is empty"));
        }
        if !(0.0..=1.0).contains(&self.confidence) || !self.confidence.is_finite() {
            return Err(NexusError::invalid(
                "memory confidence must be finite in [0,1]",
            ));
        }
        if let Some(until) = self.valid_until {
            if until.is_before(self.valid_from) {
                return Err(NexusError::invalid("memory validity interval is inverted"));
            }
        }
        if self.source_refs.is_empty() {
            return Err(NexusError::invalid(
                "memory requires provenance source_refs",
            ));
        }
        Ok(())
    }
    pub fn is_valid_at(&self, at: Timestamp) -> bool {
        !at.is_before(self.valid_from) && self.valid_until.map(|u| at.is_before(u)).unwrap_or(true)
    }
}

#[derive(Debug, Clone, Default)]
pub struct MemoryQuery {
    pub kind: Option<MemoryKind>,
    pub scope: Option<String>,
    pub at: Option<Timestamp>,
    pub limit: usize,
}

pub trait MemoryStore: Send + Sync {
    fn put(&self, record: MemoryRecord) -> Result<()>;
    fn get(&self, id: &str) -> Result<Option<MemoryRecord>>;
    fn query(&self, query: &MemoryQuery) -> Result<Vec<MemoryRecord>>;
    fn delete(&self, id: &str) -> Result<bool>;
}

#[derive(Debug, Default)]
pub struct InMemoryMemoryStore {
    records: RwLock<BTreeMap<String, MemoryRecord>>,
}
impl MemoryStore for InMemoryMemoryStore {
    fn put(&self, record: MemoryRecord) -> Result<()> {
        record.validate()?;
        let mut guard = self
            .records
            .write()
            .map_err(|_| NexusError::adapter("memory lock poisoned"))?;
        if let Some(existing) = guard.get(&record.id) {
            if existing == &record {
                return Ok(());
            }
            return Err(NexusError::invalid(
                "memory id collision with different content",
            ));
        }
        guard.insert(record.id.clone(), record);
        Ok(())
    }
    fn get(&self, id: &str) -> Result<Option<MemoryRecord>> {
        Ok(self
            .records
            .read()
            .map_err(|_| NexusError::adapter("memory lock poisoned"))?
            .get(id)
            .cloned())
    }
    fn query(&self, q: &MemoryQuery) -> Result<Vec<MemoryRecord>> {
        let limit = if q.limit == 0 {
            100
        } else {
            q.limit.min(10_000)
        };
        let guard = self
            .records
            .read()
            .map_err(|_| NexusError::adapter("memory lock poisoned"))?;
        let mut out: Vec<MemoryRecord> = guard
            .values()
            .filter(|r| {
                !q.kind.map(|k| k != r.kind).unwrap_or(false)
                    && !q.scope.as_ref().map(|s| s != &r.scope).unwrap_or(false)
                    && !q.at.map(|at| !r.is_valid_at(at)).unwrap_or(false)
            })
            .cloned()
            .collect();
        out.sort_by(|a, b| {
            b.created_at
                .cmp(&a.created_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        out.truncate(limit);
        Ok(out)
    }
    fn delete(&self, id: &str) -> Result<bool> {
        Ok(self
            .records
            .write()
            .map_err(|_| NexusError::adapter("memory lock poisoned"))?
            .remove(id)
            .is_some())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rec(id: &str) -> MemoryRecord {
        MemoryRecord {
            id: id.into(),
            kind: MemoryKind::Episodic,
            created_at: Timestamp::from_millis(10),
            valid_from: Timestamp::from_millis(10),
            valid_until: None,
            source_refs: vec!["evt_1".into()],
            ontology_refs: vec![],
            causal_refs: vec![],
            scope: "plant-a".into(),
            confidence: 0.9,
            payload: "ok".into(),
            embedding_ref: None,
        }
    }
    #[test]
    fn rejects_memory_without_provenance() {
        let mut r = rec("m1");
        r.source_refs.clear();
        assert!(r.validate().is_err());
    }
    #[test]
    fn deterministic_store_roundtrip() {
        let s = InMemoryMemoryStore::default();
        s.put(rec("m1")).unwrap();
        assert_eq!(s.get("m1").unwrap().unwrap().payload, "ok");
    }
    #[test]
    fn id_collision_cannot_rewrite_history() {
        let s = InMemoryMemoryStore::default();
        let a = rec("m1");
        s.put(a.clone()).unwrap();
        assert!(s.put(a).is_ok());
        let mut changed = rec("m1");
        changed.payload = "changed".into();
        assert!(s.put(changed).is_err());
    }
    #[test]
    fn query_prefers_newest_by_timestamp() {
        let s = InMemoryMemoryStore::default();
        let mut old = rec("z-old");
        old.created_at = Timestamp::from_millis(1);
        let mut new = rec("a-new");
        new.created_at = Timestamp::from_millis(2);
        s.put(old).unwrap();
        s.put(new).unwrap();
        let q = MemoryQuery {
            limit: 1,
            ..Default::default()
        };
        assert_eq!(s.query(&q).unwrap()[0].id, "a-new");
    }
    #[test]
    fn temporal_query_rejects_expired() {
        let s = InMemoryMemoryStore::default();
        let mut r = rec("m1");
        r.valid_until = Some(Timestamp::from_millis(20));
        s.put(r).unwrap();
        let q = MemoryQuery {
            at: Some(Timestamp::from_millis(25)),
            ..Default::default()
        };
        assert!(s.query(&q).unwrap().is_empty());
    }
}
