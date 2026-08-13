//! Versioned transport-neutral API contracts. HTTP/gRPC are adapters.
#![forbid(unsafe_code)]
use nexus_authz::Action; use nexus_control_model::{OrganizationId,ResourceKind,ResourceRecord,ResourceRef};
pub const API_VERSION:&str="v1";
#[derive(Debug,Clone,PartialEq,Eq)] pub struct RequestMeta{pub request_id:String,pub idempotency_key:Option<String>,pub api_version:String}
impl RequestMeta{pub fn validate(&self)->Result<(),String>{if self.request_id.trim().is_empty(){return Err("request id required".into())}if self.api_version!=API_VERSION{return Err("unsupported API version".into())}if self.idempotency_key.as_ref().is_some_and(|k|k.trim().is_empty()){return Err("idempotency key cannot be empty".into())}Ok(())}}
#[derive(Debug,Clone,PartialEq,Eq)] pub enum Command { Create{organization:OrganizationId,kind:ResourceKind,id:String}, Update{record:ResourceRecord,expected_version:u64}, Execute{resource:ResourceRef}, Approve{resource:ResourceRef}, Archive{resource:ResourceRef,expected_version:u64} }
impl Command{pub fn required_action(&self)->Action{match self{Self::Create{..}=>Action::Create,Self::Update{..}=>Action::Update,Self::Execute{..}=>Action::Execute,Self::Approve{..}=>Action::Approve,Self::Archive{..}=>Action::Delete}}}
#[derive(Debug,Clone,PartialEq,Eq)] pub enum Query { Get(ResourceRef), List{organization:OrganizationId,kind:ResourceKind} }
#[derive(Debug,Clone,PartialEq,Eq)] pub enum ApiErrorCode{Unauthenticated,Forbidden,NotFound,Conflict,Invalid,Unavailable,Internal}
#[derive(Debug,Clone,PartialEq,Eq)] pub struct ApiError{pub code:ApiErrorCode,pub message:String,pub request_id:String}
