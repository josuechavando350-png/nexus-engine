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

impl Action {
    fn grant_name(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Create => "create",
            Self::Update => "update",
            Self::Delete => "delete",
            Self::Execute => "execute",
            Self::Approve => "approve",
            Self::Delegate => "delegate",
            Self::ManageSecrets => "manage-secrets",
            Self::ManagePolicy => "manage-policy",
            Self::Audit => "audit",
        }
    }
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

/// Conservative built-in policy used when no external FGA/policy engine is installed.
///
/// Organization membership is a boundary, never an authorization grant. Access is
/// deny-by-default and requires an explicit action grant in the authenticated
/// principal's groups. Supported grants are:
///
/// - `nexus:<action>` for any resource in the principal's organization;
/// - `nexus:<action>:<kind>` for a resource kind;
/// - `nexus:<action>:<kind>:<resource-id>` for one resource.
///
/// External engines remain the production extension point for richer tenant/brand,
/// relationship, attribute, separation-of-duties and contextual policies.
pub struct BaselineAuthorizer;

impl AuthorizationEngine for BaselineAuthorizer {
    fn decide(&self, r: &AuthorizationRequest) -> Decision {
        if r.principal.organization != r.resource.organization {
            return Decision {
                allowed: false,
                reason: "cross-organization denied".into(),
                policy_version: "builtin-v2".into(),
            };
        }

        let action = r.action.grant_name();
        let kind = format!("{:?}", r.resource.kind).to_ascii_lowercase();
        let resource_id = &r.resource.id.0;
        let grants = [
            format!("nexus:{action}"),
            format!("nexus:{action}:{kind}"),
            format!("nexus:{action}:{kind}:{resource_id}"),
        ];
        let matched = grants.iter().find(|grant| r.principal.groups.contains(*grant));

        Decision {
            allowed: matched.is_some(),
            reason: matched
                .map(|grant| format!("explicit grant {grant}"))
                .unwrap_or_else(|| "no explicit action grant; deny by default".into()),
            policy_version: "builtin-v2".into(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_control_model::{ResourceId, ResourceKind};
    use nexus_identity::PrincipalKind;

    fn request(action: Action, groups: &[&str]) -> AuthorizationRequest {
        AuthorizationRequest {
            principal: Principal {
                id: "user-1".into(),
                organization: OrganizationId("org-a".into()),
                kind: PrincipalKind::Human,
                groups: groups.iter().map(|value| (*value).to_owned()).collect(),
                authn_strength: 2,
            },
            action,
            resource: ResourceRef {
                organization: OrganizationId("org-a".into()),
                kind: ResourceKind::Service,
                id: ResourceId("svc-1".into()),
            },
            context: BTreeSet::new(),
        }
    }

    #[test]
    fn same_organization_without_grant_is_denied() {
        let decision = BaselineAuthorizer.decide(&request(Action::Read, &[]));
        assert!(!decision.allowed);
    }

    #[test]
    fn grant_is_action_specific() {
        let decision = BaselineAuthorizer.decide(&request(Action::Delete, &["nexus:read"]));
        assert!(!decision.allowed);
    }

    #[test]
    fn exact_action_grant_allows_matching_action() {
        let decision = BaselineAuthorizer.decide(&request(Action::Read, &["nexus:read"]));
        assert!(decision.allowed);
    }

    #[test]
    fn resource_grant_does_not_authorize_another_resource() {
        let decision = BaselineAuthorizer.decide(&request(
            Action::Read,
            &["nexus:read:service:svc-2"],
        ));
        assert!(!decision.allowed);
    }

    #[test]
    fn cross_organization_is_denied_even_with_grant() {
        let mut req = request(Action::ManageSecrets, &["nexus:manage-secrets"]);
        req.resource.organization = OrganizationId("org-b".into());
        let decision = BaselineAuthorizer.decide(&req);
        assert!(!decision.allowed);
    }

    #[test]
    fn sensitive_actions_require_their_own_grants() {
        for action in [
            Action::Delete,
            Action::Execute,
            Action::Approve,
            Action::Delegate,
            Action::ManageSecrets,
            Action::ManagePolicy,
            Action::Audit,
        ] {
            assert!(!BaselineAuthorizer.decide(&request(action, &["nexus:read"])).allowed);
        }
    }
}