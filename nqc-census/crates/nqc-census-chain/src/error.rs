use nqc_census_core::{IdentityError, ObservationError};
use nqc_census_store::StoreError;
use std::fmt::{Display, Formatter};

/// Deterministic, machine-readable failure reasons of the chain-evidence layer.
/// None of these is ever converted into a chain observation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ChainError {
    Hex(&'static str),
    Json(&'static str),
    Rpc(&'static str),
    /// The provider answered with a JSON-RPC error that is not a revert.
    ProviderError {
        provider: String,
        code: i64,
        message: String,
    },
    /// HTTP-level or process-level transport failure.
    Transport {
        provider: String,
        reason: String,
    },
    RetryBudgetExhausted {
        provider: String,
        attempts: u32,
        last: String,
    },
    /// The provider cannot serve historical state for the requested block.
    ArchiveStateUnavailable {
        provider: String,
        message: String,
    },
    /// A range query exceeded the provider's limit; the caller may bisect.
    RangeTooLarge {
        provider: String,
        message: String,
    },
    /// A revert was reported without revert bytes; its content is unknown.
    AmbiguousRevert {
        provider: String,
    },
    Header(&'static str),
    UnsupportedHeaderField(String),
    Abi(&'static str),
    Replay(&'static str),
    NonCanonical {
        what: &'static str,
        detail: String,
    },
    Consensus(&'static str),
    Evidence(String),
    Config(String),
    Observation(ObservationError),
    Identity(IdentityError),
    Store(StoreError),
}

impl ChainError {
    /// Stable machine-readable failure category.
    pub const fn code(&self) -> &'static str {
        match self {
            Self::Hex(_) | Self::Json(_) | Self::Rpc(_) | Self::Abi(_) => {
                "MALFORMED_PROVIDER_RESPONSE"
            }
            Self::ProviderError { .. } => "PROVIDER_ERROR",
            Self::Transport { .. } | Self::RetryBudgetExhausted { .. } => "TRANSPORT_FAILURE",
            Self::ArchiveStateUnavailable { .. } => "ARCHIVE_STATE_UNAVAILABLE",
            Self::RangeTooLarge { .. } => "RANGE_TOO_LARGE",
            Self::AmbiguousRevert { .. } => "AMBIGUOUS_REVERT",
            Self::Header(_) | Self::UnsupportedHeaderField(_) => "UNSUPPORTED_HEADER",
            Self::Replay(_) => "REPLAY_MISSING_EXCHANGE",
            Self::NonCanonical { .. } => "REORG_LINEAGE_INVALID",
            Self::Consensus(_) => "PROVIDER_MISMATCH",
            Self::Evidence(_) => "EVIDENCE_TAMPERED",
            Self::Config(_) => "UNSUPPORTED_CONFIGURATION",
            Self::Observation(_) | Self::Identity(_) => "INVALID_OBSERVATION",
            Self::Store(_) => "EVIDENCE_STORE_FAILURE",
        }
    }
}

impl Display for ChainError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Hex(reason) => write!(formatter, "hex: {reason}"),
            Self::Json(reason) => write!(formatter, "json: {reason}"),
            Self::Rpc(reason) => write!(formatter, "json-rpc: {reason}"),
            Self::ProviderError {
                provider,
                code,
                message,
            } => write!(formatter, "{provider} error {code}: {message}"),
            Self::Transport { provider, reason } => {
                write!(formatter, "{provider} transport: {reason}")
            }
            Self::RetryBudgetExhausted {
                provider,
                attempts,
                last,
            } => write!(
                formatter,
                "{provider} failed after {attempts} attempts: {last}"
            ),
            Self::ArchiveStateUnavailable { provider, message } => {
                write!(formatter, "{provider} lacks archive state: {message}")
            }
            Self::RangeTooLarge { provider, message } => {
                write!(formatter, "{provider} range too large: {message}")
            }
            Self::AmbiguousRevert { provider } => {
                write!(
                    formatter,
                    "{provider} reported a revert without revert data"
                )
            }
            Self::Header(reason) => write!(formatter, "header: {reason}"),
            Self::UnsupportedHeaderField(field) => {
                write!(formatter, "unsupported header field {field}")
            }
            Self::Abi(reason) => write!(formatter, "abi: {reason}"),
            Self::Replay(reason) => write!(formatter, "replay: {reason}"),
            Self::NonCanonical { what, detail } => {
                write!(formatter, "non-canonical {what}: {detail}")
            }
            Self::Consensus(reason) => write!(formatter, "consensus: {reason}"),
            Self::Evidence(reason) => write!(formatter, "evidence: {reason}"),
            Self::Config(reason) => write!(formatter, "config: {reason}"),
            Self::Observation(error) => write!(formatter, "observation: {error}"),
            Self::Identity(error) => write!(formatter, "identity: {error}"),
            Self::Store(error) => write!(formatter, "store: {error}"),
        }
    }
}

impl std::error::Error for ChainError {}

impl From<ObservationError> for ChainError {
    fn from(error: ObservationError) -> Self {
        Self::Observation(error)
    }
}

impl From<IdentityError> for ChainError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}

impl From<StoreError> for ChainError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
