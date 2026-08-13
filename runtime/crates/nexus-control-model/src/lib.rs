//! Vendor-neutral V5 control-plane domain model.
#![forbid(unsafe_code)]
use std::collections::BTreeMap;
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct OrganizationId(pub String);
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceId(pub String);
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResourceKind {
    User,
    Agent,
    Dataset,
    Graph,
    Model,
    Version,
    Workflow,
    Simulation,
    EdgeDevice,
    Policy,
    Alert,
    SecretRef,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lifecycle {
    Active,
    Suspended,
    Archived,
}
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ResourceRef {
    pub organization: OrganizationId,
    pub kind: ResourceKind,
    pub id: ResourceId,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResourceRecord {
    pub reference: ResourceRef,
    pub version: u64,
    pub lifecycle: Lifecycle,
    pub labels: BTreeMap<String, String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}
impl ResourceRef {
    pub fn validate(&self) -> Result<(), String> {
        if self.organization.0.trim().is_empty() {
            return Err("resource organization required".into());
        }
        if self.id.0.trim().is_empty() {
            return Err("resource id required".into());
        }
        Ok(())
    }
}
impl ResourceRecord {
    pub fn validate(&self) -> Result<(), String> {
        self.reference.validate()?;
        if self.version == 0 {
            return Err("resource version must be positive".into());
        }
        if self.updated_at_ms < self.created_at_ms {
            return Err("resource updated_at precedes created_at".into());
        }
        Ok(())
    }
    pub fn try_mutate_version(&mut self, now: u64) -> Result<(), String> {
        if now < self.updated_at_ms {
            return Err("resource update time moved backwards".into());
        }
        self.version = self
            .version
            .checked_add(1)
            .ok_or("resource version exhausted")?;
        self.updated_at_ms = now;
        Ok(())
    }
}
