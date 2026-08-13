//! Human/service/workload identities; authentication mechanism stays behind adapters.
#![forbid(unsafe_code)]
use nexus_control_model::OrganizationId;
use std::collections::BTreeSet;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalKind {
    Human,
    Service,
    Workload,
    Agent,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub id: String,
    pub organization: OrganizationId,
    pub kind: PrincipalKind,
    pub groups: BTreeSet<String>,
    pub authn_strength: u8,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthenticationContext {
    pub principal: Principal,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub session_id: String,
}
impl AuthenticationContext {
    pub fn validate(&self) -> Result<(), String> {
        if self.principal.id.trim().is_empty() {
            return Err("principal id required".into());
        }
        if self.principal.organization.0.trim().is_empty() {
            return Err("principal organization required".into());
        }
        if self.principal.authn_strength == 0 {
            return Err("authentication strength must be nonzero".into());
        }
        if self.session_id.trim().is_empty() {
            return Err("session id required".into());
        }
        if self.expires_at_ms <= self.issued_at_ms {
            return Err("authentication expiry must follow issuance".into());
        }
        Ok(())
    }
    pub fn is_valid_at(&self, now: u64) -> bool {
        self.validate().is_ok() && self.issued_at_ms <= now && now < self.expires_at_ms
    }
}
pub trait IdentityVerifier: Send + Sync {
    fn verify(&self, token: &str, now_ms: u64) -> Result<AuthenticationContext, String>;
}
