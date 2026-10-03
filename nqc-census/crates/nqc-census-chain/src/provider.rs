//! Declared JSON-RPC providers.
//!
//! A provider is a transport for canonical chain data, never an authority.
//! Two URLs are not automatically two independent sources: the registry
//! records each provider's declared operator and, after bootstrap, its reported
//! client version, and only ever claims what those facts support.

use crate::error::ChainError;
use crate::json::Json;
use nqc_census_core::Hash32;
use sha2::{Digest, Sha256};

/// How block-pinned state reads are issued to a provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PinningMode {
    /// EIP-1898 `{blockHash, requireCanonical: true}`.
    Eip1898,
    /// Block number, bracketed by header-hash checks before and after.
    NumberGuarded,
}

impl PinningMode {
    pub const fn code(self) -> &'static str {
        match self {
            Self::Eip1898 => "EIP1898_BLOCK_HASH",
            Self::NumberGuarded => "NUMBER_WITH_HASH_GUARDS",
        }
    }

    fn parse(text: &str) -> Result<Self, ChainError> {
        match text {
            "EIP1898_BLOCK_HASH" => Ok(Self::Eip1898),
            "NUMBER_WITH_HASH_GUARDS" => Ok(Self::NumberGuarded),
            other => Err(ChainError::Config(format!("unknown pinning mode {other}"))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSpec {
    namespace: u16,
    label: String,
    url: String,
    operator: String,
    min_interval_ms: u64,
    max_batch: usize,
    log_window: u64,
    pinning: PinningMode,
}

impl ProviderSpec {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        namespace: u16,
        label: impl Into<String>,
        url: impl Into<String>,
        operator: impl Into<String>,
        min_interval_ms: u64,
        max_batch: usize,
        log_window: u64,
        pinning: PinningMode,
    ) -> Result<Self, ChainError> {
        let spec = Self {
            namespace,
            label: label.into(),
            url: url.into(),
            operator: operator.into(),
            min_interval_ms,
            max_batch,
            log_window,
            pinning,
        };
        if spec.namespace == 0 {
            return Err(ChainError::Config(
                "provider namespace must be non-zero".into(),
            ));
        }
        if spec.label.is_empty() || spec.operator.is_empty() {
            return Err(ChainError::Config(
                "provider label and operator are required".into(),
            ));
        }
        if !spec.url.starts_with("https://") && !spec.url.starts_with("replay://") {
            return Err(ChainError::Config(format!(
                "provider {} must use https",
                spec.label
            )));
        }
        if spec.max_batch == 0 || spec.log_window == 0 {
            return Err(ChainError::Config(
                "batch size and log window must be positive".into(),
            ));
        }
        Ok(spec)
    }

    pub const fn namespace(&self) -> u16 {
        self.namespace
    }

    pub fn label(&self) -> &str {
        &self.label
    }

    pub fn url(&self) -> &str {
        &self.url
    }

    pub fn operator(&self) -> &str {
        &self.operator
    }

    pub const fn min_interval_ms(&self) -> u64 {
        self.min_interval_ms
    }

    pub const fn max_batch(&self) -> usize {
        self.max_batch
    }

    pub const fn log_window(&self) -> u64 {
        self.log_window
    }

    pub const fn pinning(&self) -> PinningMode {
        self.pinning
    }

    /// Provenance locator: binds namespace, label, URL and declared operator.
    pub fn locator_hash(&self) -> Result<Hash32, ChainError> {
        let mut hasher = Sha256::new();
        hasher.update(b"NQC-CENSUS-RPC-PROVIDER-V1");
        hasher.update([0]);
        hasher.update(self.namespace.to_be_bytes());
        for part in [&self.label, &self.url, &self.operator] {
            hasher.update(u32::try_from(part.len()).unwrap_or(u32::MAX).to_be_bytes());
            hasher.update(part.as_bytes());
        }
        let digest: [u8; 32] = hasher.finalize().into();
        Ok(Hash32::new(digest)?)
    }

    pub fn descriptor(&self) -> Json {
        Json::object([
            ("namespace", Json::uint(u64::from(self.namespace))),
            ("label", Json::string(self.label.clone())),
            ("url", Json::string(self.url.clone())),
            ("operator", Json::string(self.operator.clone())),
            ("pinning", Json::string(self.pinning.code())),
            ("min_interval_ms", Json::uint(self.min_interval_ms)),
            ("max_batch", Json::uint(self.max_batch as u64)),
            ("log_window", Json::uint(self.log_window)),
        ])
    }
}

/// A validated set of at least two providers with distinct namespaces,
/// labels, URLs and declared operators.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderSet {
    providers: Vec<ProviderSpec>,
}

impl ProviderSet {
    pub fn new(mut providers: Vec<ProviderSpec>) -> Result<Self, ChainError> {
        providers.sort_by_key(ProviderSpec::namespace);
        if providers.len() < 2 {
            return Err(ChainError::Config(
                "at least two providers are required".into(),
            ));
        }
        for (index, left) in providers.iter().enumerate() {
            for right in &providers[index + 1..] {
                if left.namespace == right.namespace
                    || left.label == right.label
                    || left.url == right.url
                    || left.operator.eq_ignore_ascii_case(&right.operator)
                {
                    return Err(ChainError::Config(format!(
                        "providers {} and {} are not distinct sources",
                        left.label, right.label
                    )));
                }
            }
        }
        Ok(Self { providers })
    }

    /// Parses `{"providers": [{namespace,label,url,operator,min_interval_ms,
    /// max_batch,log_window,pinning}, ...]}`.
    pub fn parse(bytes: &[u8]) -> Result<Self, ChainError> {
        let document = Json::parse(bytes)?;
        let items = document
            .get("providers")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Config("providers array missing".into()))?;
        let mut providers = Vec::with_capacity(items.len());
        for item in items {
            let number = |key: &str| -> Result<u64, ChainError> {
                item.get(key)
                    .and_then(Json::as_i64)
                    .and_then(|value| u64::try_from(value).ok())
                    .ok_or_else(|| ChainError::Config(format!("provider field {key} missing")))
            };
            let text = |key: &str| -> Result<String, ChainError> {
                item.get(key)
                    .and_then(Json::as_str)
                    .map(str::to_owned)
                    .ok_or_else(|| ChainError::Config(format!("provider field {key} missing")))
            };
            providers.push(ProviderSpec::new(
                u16::try_from(number("namespace")?)
                    .map_err(|_| ChainError::Config("namespace exceeds u16".into()))?,
                text("label")?,
                text("url")?,
                text("operator")?,
                number("min_interval_ms")?,
                usize::try_from(number("max_batch")?)
                    .map_err(|_| ChainError::Config("max_batch overflow".into()))?,
                number("log_window")?,
                PinningMode::parse(&text("pinning")?)?,
            )?);
        }
        Self::new(providers)
    }

    pub fn iter(&self) -> impl Iterator<Item = &ProviderSpec> {
        self.providers.iter()
    }

    pub fn len(&self) -> usize {
        self.providers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.providers.is_empty()
    }
}
