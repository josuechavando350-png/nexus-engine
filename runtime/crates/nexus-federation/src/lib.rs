//! Explicit cross-cluster federation. No implicit trust propagation.
#![forbid(unsafe_code)]
use std::collections::BTreeSet;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TrustDomain(pub String);
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederationGrant {
    pub local: TrustDomain,
    pub remote: TrustDomain,
    pub allowed_resources: BTreeSet<String>,
    pub allowed_actions: BTreeSet<String>,
    pub expires_at_ms: u64,
    pub grant_id: String,
}
impl FederationGrant {
    pub fn validate(&self) -> Result<(), String> {
        if self.local.0.trim().is_empty()
            || self.remote.0.trim().is_empty()
            || self.grant_id.trim().is_empty()
        {
            return Err("federation trust domains/grant id required".into());
        }
        if self.local == self.remote {
            return Err("federation grant requires distinct trust domains".into());
        }
        if self.allowed_resources.is_empty() || self.allowed_actions.is_empty() {
            return Err("federation grant requires explicit resource/action scope".into());
        }
        if self.expires_at_ms == 0 {
            return Err("federation grant expiry required".into());
        }
        Ok(())
    }
    pub fn allows(&self, resource: &str, action: &str, now: u64) -> bool {
        self.validate().is_ok()
            && now < self.expires_at_ms
            && self.allowed_resources.contains(resource)
            && self.allowed_actions.contains(action)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FederationMode {
    MetadataOnly,
    ReadOnly,
    ControlledCommand,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederatedEnvelope {
    pub source: TrustDomain,
    pub destination: TrustDomain,
    pub grant_id: String,
    pub nonce: String,
    pub payload_hash: String,
    pub mode: FederationMode,
}
pub trait FederationVerifier: Send + Sync {
    fn verify(&self, envelope: &FederatedEnvelope, now_ms: u64) -> Result<(), String>;
}
