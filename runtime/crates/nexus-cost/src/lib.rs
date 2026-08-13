//! Append-only usage/cost accounting independent from any billing vendor.
#![forbid(unsafe_code)]
use nexus_control_model::OrganizationId;
#[derive(Debug,Clone,PartialEq)] pub struct UsageEvent { pub organization:OrganizationId,pub meter:String,pub quantity:f64,pub unit:String,pub estimated_cost_microunits:Option<u64>,pub timestamp_ms:u64,pub provenance:String }
pub trait UsageLedger: Send+Sync { fn append(&self,event:UsageEvent)->Result<(),String>; fn query(&self,organization:&OrganizationId,from_ms:u64,to_ms:u64)->Result<Vec<UsageEvent>,String>; }
