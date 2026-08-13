//! Alert lifecycle with deduplication key and acknowledgement evidence.
#![forbid(unsafe_code)]
use nexus_control_model::{OrganizationId,ResourceRef};
#[derive(Debug,Clone,Copy,PartialEq,Eq)] pub enum Severity{Info,Warning,Critical}
#[derive(Debug,Clone,Copy,PartialEq,Eq)] pub enum AlertState{Open,Acknowledged,Resolved}
#[derive(Debug,Clone,PartialEq,Eq)] pub struct Alert{pub id:String,pub organization:OrganizationId,pub severity:Severity,pub state:AlertState,pub dedup_key:String,pub subject:ResourceRef,pub message:String,pub evidence_refs:Vec<String>,pub created_at_ms:u64}
impl Alert{pub fn acknowledge(&mut self){if self.state==AlertState::Open{self.state=AlertState::Acknowledged}} pub fn resolve(&mut self){self.state=AlertState::Resolved}}
