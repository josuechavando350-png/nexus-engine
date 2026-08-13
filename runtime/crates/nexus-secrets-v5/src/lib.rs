//! Secret metadata only. Generic control APIs expose references and leases only.
#![forbid(unsafe_code)]
use nexus_control_model::OrganizationId;
#[derive(Debug,Clone,PartialEq,Eq)] pub struct SecretRef { pub organization:OrganizationId,pub name:String,pub version:Option<String>,pub provider:String }
#[derive(Debug,Clone,PartialEq,Eq)] pub struct SecretLease { pub reference:SecretRef,pub lease_id:String,pub expires_at_ms:u64 }
pub trait SecretBroker: Send+Sync { fn lease(&self,reference:&SecretRef,purpose:&str,ttl_ms:u64)->Result<SecretLease,String>; fn revoke(&self,lease_id:&str)->Result<(),String>; }
