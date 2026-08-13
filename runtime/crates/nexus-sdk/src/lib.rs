//! Thin SDK over NEXUS contracts; transport is injected.
#![forbid(unsafe_code)]
use nexus_api_contracts::{Command, Query, RequestMeta};
pub trait Transport: Send + Sync {
    fn command(&self, meta: &RequestMeta, command: &Command) -> Result<Vec<u8>, String>;
    fn query(&self, meta: &RequestMeta, query: &Query) -> Result<Vec<u8>, String>;
}
pub struct NexusClient<T: Transport> {
    transport: T,
}
impl<T: Transport> NexusClient<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }
    pub fn command(&self, meta: &RequestMeta, c: &Command) -> Result<Vec<u8>, String> {
        self.transport.command(meta, c)
    }
    pub fn query(&self, meta: &RequestMeta, q: &Query) -> Result<Vec<u8>, String> {
        self.transport.query(meta, q)
    }
}
