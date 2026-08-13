//! Provider-neutral replicated decision log. OpenRaft/etcd are adapters, not domain semantics.
#![forbid(unsafe_code)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Consistency {
    Linearizable,
    LeaseRead,
    StaleAllowed,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogEntry {
    pub index: u64,
    pub term: u64,
    pub command_id: String,
    pub payload_hash: String,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitProof {
    pub index: u64,
    pub term: u64,
    pub quorum: u32,
    pub voters: u32,
}
impl CommitProof {
    pub fn valid(&self) -> bool {
        self.index > 0
            && self.term > 0
            && self.voters > 0
            && self.quorum <= self.voters
            && self.quorum > self.voters / 2
    }
}
pub trait ConsensusEngine: Send + Sync {
    fn propose(&self, command_id: &str, payload_hash: &str) -> Result<CommitProof, String>;
    fn committed_index(&self) -> u64;
    fn read_barrier(&self, consistency: Consistency) -> Result<u64, String>;
}
#[derive(Debug, Default)]
pub struct DeterministicConsensus {
    next: std::sync::Mutex<u64>,
}
impl ConsensusEngine for DeterministicConsensus {
    fn propose(&self, command_id: &str, _: &str) -> Result<CommitProof, String> {
        if command_id.is_empty() {
            return Err("command id required".into());
        }
        let mut n = self.next.lock().map_err(|_| "consensus lock poisoned")?;
        *n = n.checked_add(1).ok_or("consensus log index exhausted")?;
        Ok(CommitProof {
            index: *n,
            term: 1,
            quorum: 1,
            voters: 1,
        })
    }
    fn committed_index(&self) -> u64 {
        self.next.lock().map(|n| *n).unwrap_or(0)
    }
    fn read_barrier(&self, _: Consistency) -> Result<u64, String> {
        Ok(self.committed_index())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn majority_is_required() {
        assert!(CommitProof {
            index: 1,
            term: 1,
            quorum: 2,
            voters: 3
        }
        .valid());
        assert!(!CommitProof {
            index: 1,
            term: 1,
            quorum: 1,
            voters: 3
        }
        .valid())
    }
}
