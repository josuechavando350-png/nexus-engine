//! Control-plane audit events reference V3 audit provenance without weakening it.
#![forbid(unsafe_code)]
use nexus_control_model::{OrganizationId, ResourceRef};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditEvent {
    pub id: String,
    pub organization: OrganizationId,
    pub actor_id: String,
    pub action: String,
    pub resource: Option<ResourceRef>,
    pub decision: String,
    pub request_id: String,
    pub timestamp_ms: u64,
    pub evidence_refs: Vec<String>,
}
pub trait AuditSink: Send + Sync {
    fn record(&self, event: AuditEvent) -> Result<(), String>;
}
