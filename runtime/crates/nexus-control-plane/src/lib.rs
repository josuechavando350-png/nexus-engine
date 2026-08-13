//! V5 orchestration façade: authenticate -> authorize -> mutate -> audit.
#![forbid(unsafe_code)]
use nexus_api_contracts::{Command, RequestMeta};
use nexus_audit_v5::{AuditEvent, AuditSink};
use nexus_authz::{AuthorizationEngine, AuthorizationRequest};
use nexus_control_model::{Lifecycle, ResourceId, ResourceRecord, ResourceRef};
use nexus_identity::AuthenticationContext;
use nexus_registry::ResourceRegistry;
pub struct ControlPlane<'a> {
    pub registry: &'a dyn ResourceRegistry,
    pub authorizer: &'a dyn AuthorizationEngine,
    pub audit: &'a dyn AuditSink,
}
impl ControlPlane<'_> {
    pub fn execute(
        &self,
        auth: &AuthenticationContext,
        meta: &RequestMeta,
        command: Command,
        now: u64,
    ) -> Result<Option<ResourceRecord>, String> {
        meta.validate()?;
        auth.validate()?;
        if !auth.is_valid_at(now) {
            return Err("authentication expired".into());
        }
        let target = match &command {
            Command::Create {
                organization,
                kind,
                id,
            } => ResourceRef {
                organization: organization.clone(),
                kind: *kind,
                id: ResourceId(id.clone()),
            },
            Command::Update { record, .. } => record.reference.clone(),
            Command::Execute { resource }
            | Command::Approve { resource }
            | Command::Archive { resource, .. } => resource.clone(),
        };
        let action = command.required_action();
        let decision = self.authorizer.decide(&AuthorizationRequest {
            principal: auth.principal.clone(),
            action,
            resource: target.clone(),
            context: Default::default(),
        });
        if !decision.allowed {
            let audit_result = self.audit.record(AuditEvent {
                id: meta.request_id.clone(),
                organization: target.organization.clone(),
                actor_id: auth.principal.id.clone(),
                action: format!("{:?}", action),
                resource: Some(target),
                decision: "deny".into(),
                request_id: meta.request_id.clone(),
                timestamp_ms: now,
                evidence_refs: vec![decision.policy_version.clone()],
            });
            if let Err(error) = audit_result {
                return Err(format!("authorization denied; audit failure: {error}"));
            }
            return Err("authorization denied".into());
        }
        let out = match command {
            Command::Create {
                organization,
                kind,
                id,
            } => Some(self.registry.put(
                ResourceRecord {
                    reference: ResourceRef {
                        organization,
                        kind,
                        id: ResourceId(id),
                    },
                    version: 1,
                    lifecycle: Lifecycle::Active,
                    labels: Default::default(),
                    created_at_ms: now,
                    updated_at_ms: now,
                },
                None,
            )?),
            Command::Update {
                mut record,
                expected_version,
            } => {
                if record.version != expected_version {
                    return Err("update record version must match expected_version".into());
                }
                record.try_mutate_version(now)?;
                Some(self.registry.put(record, Some(expected_version))?)
            }
            Command::Archive {
                resource,
                expected_version,
            } => {
                let mut r = self.registry.get(&resource).ok_or("resource absent")?;
                if r.version != expected_version {
                    return Err("optimistic concurrency conflict".into());
                }
                r.lifecycle = Lifecycle::Archived;
                r.try_mutate_version(now)?;
                Some(self.registry.put(r, Some(expected_version))?)
            }
            Command::Execute { .. } | Command::Approve { .. } => None,
        };
        self.audit.record(AuditEvent {
            id: format!("audit:{}", meta.request_id),
            organization: target.organization.clone(),
            actor_id: auth.principal.id.clone(),
            action: format!("{:?}", action),
            resource: Some(target),
            decision: "allow".into(),
            request_id: meta.request_id.clone(),
            timestamp_ms: now,
            evidence_refs: vec![decision.policy_version],
        })?;
        Ok(out)
    }
}
