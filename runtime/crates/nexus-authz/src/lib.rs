//! NEXUS authorization semantics. External FGA/policy engines are replaceable evaluators.
#![forbid(unsafe_code)]
use nexus_control_model::{OrganizationId, ResourceRef};
use nexus_identity::Principal;
use std::collections::BTreeSet;
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Action {
    Read,
    Create,
    Update,
    Delete,
    Execute,
    Approve,
    Delegate,
    ManageSecrets,
    ManagePolicy,
    Audit,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationRequest {
    pub principal: Principal,
    pub action: Action,
    pub resource: ResourceRef,
    pub context: BTreeSet<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub allowed: bool,
    pub reason: String,
    pub policy_version: String,
}
pub trait AuthorizationEngine: Send + Sync {
    fn decide(&self, request: &AuthorizationRequest) -> Decision;
}
pub struct BaselineAuthorizer;
impl AuthorizationEngine for BaselineAuthorizer {
    fn decide(&self, r: &AuthorizationRequest) -> Decision {
        let same = r.principal.organization == r.resource.organization;
        Decision {
            allowed: same,
            reason: if same {
                "same-organization baseline".into()
            } else {
                "cross-organization denied".into()
            },
            policy_version: "builtin-v1".into(),
        }
    }
}
pub fn assert_tenant_boundary(p: &Principal, o: &OrganizationId) -> Result<(), String> {
    if &p.organization == o {
        Ok(())
    } else {
        Err("cross-organization boundary".into())
    }
}
