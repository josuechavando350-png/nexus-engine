//! Secure-mesh policy contracts. WireGuard/SPIFFE/QUIC are interchangeable mechanisms.
#![forbid(unsafe_code)]
use std::collections::BTreeSet;
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkloadIdentity {
    pub trust_domain: String,
    pub workload: String,
    pub attested_node: String,
    pub not_after_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerPolicy {
    pub source: String,
    pub destination: String,
    pub allowed_protocols: BTreeSet<String>,
    pub allow_datagrams: bool,
    pub max_session_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPermit {
    pub session_id: String,
    pub source: String,
    pub destination: String,
    pub protocol: String,
    pub expires_at_ms: u64,
}
pub trait MeshAuthorizer: Send + Sync {
    fn authorize(
        &self,
        source: &WorkloadIdentity,
        destination: &WorkloadIdentity,
        protocol: &str,
        now_ms: u64,
    ) -> Result<SessionPermit, String>;
}
impl WorkloadIdentity {
    pub fn valid_at(&self, now: u64) -> bool {
        !self.trust_domain.is_empty()
            && !self.workload.is_empty()
            && !self.attested_node.is_empty()
            && now < self.not_after_ms
    }
}
