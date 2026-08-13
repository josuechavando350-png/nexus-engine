//! Error type shared by the whole runtime.
//!
//! One concrete error enum instead of a trait object keeps the crate
//! dependency-free and keeps matching exhaustive at every call site.

use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NexusError {
    /// Input did not satisfy the declared schema.
    Schema(String),
    /// Well-formed input that violates a domain invariant.
    Invalid(String),
    /// Integrity hash or signature did not verify.
    Integrity(String),
    /// A required entity, node or key was not found.
    NotFound(String),
    /// A bounded resource (queue, budget, deadline) was exhausted.
    Exhausted(String),
    /// A policy or safety rule refused the operation.
    Denied(String),
    /// An adapter (broker, graph, sandbox) failed.
    Adapter(String),
    /// The operation is not supported in the current build or mode.
    Unsupported(String),
}

impl NexusError {
    pub fn schema(msg: impl Into<String>) -> Self {
        NexusError::Schema(msg.into())
    }
    pub fn invalid(msg: impl Into<String>) -> Self {
        NexusError::Invalid(msg.into())
    }
    pub fn integrity(msg: impl Into<String>) -> Self {
        NexusError::Integrity(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        NexusError::NotFound(msg.into())
    }
    pub fn exhausted(msg: impl Into<String>) -> Self {
        NexusError::Exhausted(msg.into())
    }
    pub fn denied(msg: impl Into<String>) -> Self {
        NexusError::Denied(msg.into())
    }
    pub fn adapter(msg: impl Into<String>) -> Self {
        NexusError::Adapter(msg.into())
    }
    pub fn unsupported(msg: impl Into<String>) -> Self {
        NexusError::Unsupported(msg.into())
    }

    /// Stable machine-readable kind, used by metrics and audit records.
    pub fn kind(&self) -> &'static str {
        match self {
            NexusError::Schema(_) => "schema",
            NexusError::Invalid(_) => "invalid",
            NexusError::Integrity(_) => "integrity",
            NexusError::NotFound(_) => "not_found",
            NexusError::Exhausted(_) => "exhausted",
            NexusError::Denied(_) => "denied",
            NexusError::Adapter(_) => "adapter",
            NexusError::Unsupported(_) => "unsupported",
        }
    }

    /// Whether retrying the same operation could plausibly succeed.
    ///
    /// Deliberately conservative: anything the runtime rejected on content
    /// grounds is permanent, so it goes to the dead-letter topic instead of
    /// spinning in a retry loop.
    pub fn is_retryable(&self) -> bool {
        matches!(self, NexusError::Adapter(_) | NexusError::Exhausted(_))
    }
}

impl fmt::Display for NexusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let detail = match self {
            NexusError::Schema(m)
            | NexusError::Invalid(m)
            | NexusError::Integrity(m)
            | NexusError::NotFound(m)
            | NexusError::Exhausted(m)
            | NexusError::Denied(m)
            | NexusError::Adapter(m)
            | NexusError::Unsupported(m) => m,
        };
        write!(f, "{}: {}", self.kind(), detail)
    }
}

impl std::error::Error for NexusError {}

pub type Result<T> = std::result::Result<T, NexusError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_errors_are_not_retryable() {
        assert!(!NexusError::schema("x").is_retryable());
        assert!(!NexusError::invalid("x").is_retryable());
        assert!(!NexusError::integrity("x").is_retryable());
        assert!(!NexusError::denied("x").is_retryable());
    }

    #[test]
    fn transport_errors_are_retryable() {
        assert!(NexusError::adapter("broker down").is_retryable());
        assert!(NexusError::exhausted("queue full").is_retryable());
    }

    #[test]
    fn display_includes_kind() {
        assert_eq!(NexusError::schema("bad").to_string(), "schema: bad");
    }
}
