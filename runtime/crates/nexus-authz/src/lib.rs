//! NEXUS authorization semantics. External FGA/policy engines are replaceable evaluators.
#![forbid(unsafe_code)]

use nexus_control_model::{OrganizationId, ResourceId, ResourceKind, ResourceRef};
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
    /// Runtime claims supplied by a trusted authentication/policy adapter. The built-in
    /// grant authorizer requires exact tenant/brand/environment bindings and never treats
    /// arbitrary presence as authorization.
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

/// Safe fallback used when no policy backend has been configured.
///
/// The former implementation treated same-organization membership as sufficient authority.
/// That is intentionally impossible now: an unavailable/unconfigured policy path fails closed.
pub struct BaselineAuthorizer;

impl AuthorizationEngine for BaselineAuthorizer {
    fn decide(&self, _request: &AuthorizationRequest) -> Decision {
        Decision {
            allowed: false,
            reason: "no explicit authorization policy configured".into(),
            policy_version: "builtin-deny-v2".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    pub principal_id: String,
    pub action: Action,
    pub organization: OrganizationId,
    pub resource_kind: ResourceKind,
    pub resource_id: ResourceId,
    pub tenant: String,
    pub brand: String,
    pub environment: String,
    pub required_context: BTreeSet<String>,
}

impl Grant {
    pub fn validate(&self) -> Result<(), String> {
        if self.principal_id.trim().is_empty() {
            return Err("grant principal required".into());
        }
        if self.organization.0.trim().is_empty() {
            return Err("grant organization required".into());
        }
        if self.resource_id.0.trim().is_empty() {
            return Err("grant resource id required".into());
        }
        if self.tenant.trim().is_empty()
            || self.brand.trim().is_empty()
            || self.environment.trim().is_empty()
        {
            return Err("grant tenant/brand/environment bindings required".into());
        }
        Ok(())
    }

    fn scope_claims(&self) -> [String; 3] {
        [
            format!("tenant={}", self.tenant),
            format!("brand={}", self.brand),
            format!("environment={}", self.environment),
        ]
    }

    fn matches(&self, request: &AuthorizationRequest) -> bool {
        self.principal_id == request.principal.id
            && self.action == request.action
            && self.organization == request.principal.organization
            && self.organization == request.resource.organization
            && self.resource_kind == request.resource.kind
            && self.resource_id == request.resource.id
            && self
                .scope_claims()
                .iter()
                .all(|claim| request.context.contains(claim))
            && self
                .required_context
                .iter()
                .all(|claim| request.context.contains(claim))
    }
}

/// Minimal deterministic policy evaluator for deployments that do not use an external FGA
/// adapter. It accepts only exact grants and fails closed if its policy snapshot is unavailable.
pub struct GrantAuthorizer {
    grants: Vec<Grant>,
    policy_version: String,
    policy_available: bool,
}

impl GrantAuthorizer {
    pub fn new(policy_version: impl Into<String>, grants: Vec<Grant>) -> Result<Self, String> {
        let policy_version = policy_version.into();
        if policy_version.trim().is_empty() {
            return Err("policy version required".into());
        }
        for grant in &grants {
            grant.validate()?;
        }
        Ok(Self {
            grants,
            policy_version,
            policy_available: true,
        })
    }

    pub fn unavailable(policy_version: impl Into<String>) -> Self {
        Self {
            grants: Vec::new(),
            policy_version: policy_version.into(),
            policy_available: false,
        }
    }
}

fn sensitive(action: Action) -> bool {
    matches!(
        action,
        Action::Approve
            | Action::Delegate
            | Action::ManageSecrets
            | Action::ManagePolicy
            | Action::Audit
    )
}

fn separation_of_duties_satisfied(request: &AuthorizationRequest) -> bool {
    if !sensitive(request.action) {
        return true;
    }
    request.context.iter().any(|claim| {
        claim
            .strip_prefix("sod-approved-by=")
            .is_some_and(|approver| !approver.trim().is_empty() && approver != request.principal.id)
    })
}

impl AuthorizationEngine for GrantAuthorizer {
    fn decide(&self, request: &AuthorizationRequest) -> Decision {
        let deny = |reason: &str| Decision {
            allowed: false,
            reason: reason.into(),
            policy_version: self.policy_version.clone(),
        };

        if !self.policy_available {
            return deny("policy backend unavailable");
        }
        if request.principal.id.trim().is_empty()
            || request.principal.organization.0.trim().is_empty()
        {
            return deny("invalid principal");
        }
        if request.resource.validate().is_err() {
            return deny("invalid resource");
        }
        if request.principal.organization != request.resource.organization {
            return deny("organization boundary mismatch");
        }
        if !separation_of_duties_satisfied(request) {
            return deny("separation of duties requirement not satisfied");
        }

        if self.grants.iter().any(|grant| grant.matches(request)) {
            Decision {
                allowed: true,
                reason: "explicit grant matched".into(),
                policy_version: self.policy_version.clone(),
            }
        } else {
            deny("no matching explicit grant")
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
    use nexus_identity::PrincipalKind;

    fn principal(org: &str) -> Principal {
        Principal {
            id: "reader-1".into(),
            organization: OrganizationId(org.into()),
            kind: PrincipalKind::Human,
            groups: BTreeSet::new(),
            authn_strength: 2,
        }
    }

    fn resource(org: &str, kind: ResourceKind, id: &str) -> ResourceRef {
        ResourceRef {
            organization: OrganizationId(org.into()),
            kind,
            id: ResourceId(id.into()),
        }
    }

    fn context() -> BTreeSet<String> {
        ["tenant=tenant-a", "brand=brand-a", "environment=prod"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    fn request(action: Action) -> AuthorizationRequest {
        AuthorizationRequest {
            principal: principal("org-a"),
            action,
            resource: resource("org-a", ResourceKind::Dataset, "dataset-1"),
            context: context(),
        }
    }

    fn read_grant() -> Grant {
        Grant {
            principal_id: "reader-1".into(),
            action: Action::Read,
            organization: OrganizationId("org-a".into()),
            resource_kind: ResourceKind::Dataset,
            resource_id: ResourceId("dataset-1".into()),
            tenant: "tenant-a".into(),
            brand: "brand-a".into(),
            environment: "prod".into(),
            required_context: BTreeSet::new(),
        }
    }

    #[test]
    fn baseline_denies_every_action_even_inside_same_organization() {
        let authz = BaselineAuthorizer;
        for action in [
            Action::Read,
            Action::Create,
            Action::Update,
            Action::Delete,
            Action::Execute,
            Action::Approve,
            Action::Delegate,
            Action::ManageSecrets,
            Action::ManagePolicy,
            Action::Audit,
        ] {
            assert!(
                !authz.decide(&request(action)).allowed,
                "{action:?} unexpectedly allowed"
            );
        }
    }

    #[test]
    fn read_only_grant_cannot_escalate_to_sensitive_or_mutating_actions() {
        let authz = GrantAuthorizer::new("policy-42", vec![read_grant()]).unwrap();
        assert!(authz.decide(&request(Action::Read)).allowed);
        for action in [
            Action::Update,
            Action::Delete,
            Action::Execute,
            Action::Approve,
            Action::Delegate,
            Action::ManageSecrets,
            Action::ManagePolicy,
            Action::Audit,
        ] {
            assert!(
                !authz.decide(&request(action)).allowed,
                "{action:?} unexpectedly allowed"
            );
        }
    }

    #[test]
    fn grant_is_bound_to_resource_kind_id_and_organization() {
        let authz = GrantAuthorizer::new("policy-42", vec![read_grant()]).unwrap();

        let mut wrong_kind = request(Action::Read);
        wrong_kind.resource = resource("org-a", ResourceKind::Model, "dataset-1");
        assert!(!authz.decide(&wrong_kind).allowed);

        let mut wrong_id = request(Action::Read);
        wrong_id.resource = resource("org-a", ResourceKind::Dataset, "dataset-2");
        assert!(!authz.decide(&wrong_id).allowed);

        let mut wrong_org = request(Action::Read);
        wrong_org.resource = resource("org-b", ResourceKind::Dataset, "dataset-1");
        assert!(!authz.decide(&wrong_org).allowed);
    }

    #[test]
    fn missing_or_wrong_scope_context_denies() {
        let authz = GrantAuthorizer::new("policy-42", vec![read_grant()]).unwrap();
        let mut missing = request(Action::Read);
        missing.context.remove("tenant=tenant-a");
        assert!(!authz.decide(&missing).allowed);

        let mut wrong = request(Action::Read);
        wrong.context.remove("brand=brand-a");
        wrong.context.insert("brand=brand-b".into());
        assert!(!authz.decide(&wrong).allowed);
    }

    #[test]
    fn unavailable_policy_backend_denies() {
        let authz = GrantAuthorizer::unavailable("policy-42");
        assert!(!authz.decide(&request(Action::Read)).allowed);
    }

    #[test]
    fn sensitive_actions_require_distinct_separation_of_duties_approver() {
        let mut grant = read_grant();
        grant.action = Action::Approve;
        let authz = GrantAuthorizer::new("policy-42", vec![grant]).unwrap();

        let mut no_approval = request(Action::Approve);
        assert!(!authz.decide(&no_approval).allowed);

        no_approval
            .context
            .insert("sod-approved-by=reader-1".into());
        assert!(!authz.decide(&no_approval).allowed);

        no_approval.context.remove("sod-approved-by=reader-1");
        no_approval
            .context
            .insert("sod-approved-by=approver-2".into());
        assert!(authz.decide(&no_approval).allowed);
    }
}
