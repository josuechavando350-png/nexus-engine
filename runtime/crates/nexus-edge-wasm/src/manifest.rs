//! Module manifests, resource limits and capability tokens.

use nexus_edge_protocol::{SignatureEnvelope, SignerRegistry};
use nexus_event::hash::{sha256, to_hex};
use nexus_event::{NexusError, Result, Timestamp};

/// Hard resource ceilings applied to every module instance.
///
/// The defaults are intentionally small. A task handler that needs more than
/// this is doing something the edge should not be doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceLimits {
    pub max_memory_bytes: usize,
    /// Instruction budget. Exhausting it traps rather than hanging.
    pub fuel: u64,
    pub timeout_millis: u64,
    pub max_host_calls: u32,
    pub max_output_bytes: usize,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        ResourceLimits {
            max_memory_bytes: 16 * 1024 * 1024,
            fuel: 50_000_000,
            timeout_millis: 5_000,
            max_host_calls: 64,
            max_output_bytes: 64 * 1024,
        }
    }
}

impl ResourceLimits {
    pub fn validate(&self) -> Result<()> {
        if self.max_memory_bytes == 0 || self.max_memory_bytes > 512 * 1024 * 1024 {
            return Err(NexusError::invalid(
                "max_memory_bytes must be within 1..=512MiB",
            ));
        }
        if self.fuel == 0 {
            return Err(NexusError::invalid("fuel must be greater than 0"));
        }
        if self.timeout_millis == 0 || self.timeout_millis > 120_000 {
            return Err(NexusError::invalid(
                "timeout_millis must be within 1..=120000",
            ));
        }
        Ok(())
    }
}

/// A capability token derived from a verified task.
///
/// The module never receives the task's signature or the signer's identity;
/// it receives tokens. A host function refuses to run unless a token for its
/// capability is present and has not expired.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapabilityToken {
    pub capability: String,
    pub task_id: String,
    pub expires_at: Timestamp,
}

impl CapabilityToken {
    pub fn new(
        capability: impl Into<String>,
        task_id: impl Into<String>,
        expires_at: Timestamp,
    ) -> Self {
        CapabilityToken {
            capability: capability.into(),
            task_id: task_id.into(),
            expires_at,
        }
    }

    pub fn is_valid_at(&self, now: Timestamp) -> bool {
        now.is_before(self.expires_at)
    }
}

/// A signed description of a module the device is willing to load.
#[derive(Debug, Clone, PartialEq)]
pub struct ModuleManifest {
    pub module_id: String,
    pub version: String,
    /// Lowercase hex SHA-256 of the module bytes.
    pub module_hash: String,
    /// Host functions this module is permitted to import.
    pub allowed_host_functions: Vec<String>,
    pub limits: ResourceLimits,
    pub signature: Option<SignatureEnvelope>,
}

impl ModuleManifest {
    pub fn new(
        module_id: impl Into<String>,
        version: impl Into<String>,
        module_bytes: &[u8],
        allowed_host_functions: Vec<String>,
    ) -> Self {
        ModuleManifest {
            module_id: module_id.into(),
            version: version.into(),
            module_hash: to_hex(&sha256(module_bytes)),
            allowed_host_functions,
            limits: ResourceLimits::default(),
            signature: None,
        }
    }

    pub fn signing_bytes(&self) -> Vec<u8> {
        use nexus_event::json::Value;
        let functions: Vec<Value> = self
            .allowed_host_functions
            .iter()
            .map(|name| Value::string(name))
            .collect();
        Value::object(vec![
            ("module_id", Value::string(&self.module_id)),
            ("version", Value::string(&self.version)),
            ("module_hash", Value::string(&self.module_hash)),
            ("allowed_host_functions", Value::Array(functions)),
            (
                "max_memory_bytes",
                Value::number(self.limits.max_memory_bytes as f64),
            ),
            ("fuel", Value::number(self.limits.fuel as f64)),
            (
                "timeout_millis",
                Value::number(self.limits.timeout_millis as f64),
            ),
        ])
        .to_canonical_bytes()
    }

    /// Verifies that the bytes about to be loaded are the bytes that were
    /// signed. Hash first, then signature: a mismatched hash is reported as
    /// a hash mismatch rather than as a signature failure.
    pub fn verify(&self, module_bytes: &[u8], registry: &SignerRegistry) -> Result<()> {
        self.limits.validate()?;

        let actual = to_hex(&sha256(module_bytes));
        if actual != self.module_hash {
            return Err(NexusError::integrity(format!(
                "module hash mismatch for '{}': manifest {}, actual {}",
                self.module_id, self.module_hash, actual
            )));
        }

        for function in &self.allowed_host_functions {
            if !crate::host::HOST_ALLOWLIST.contains(&function.as_str()) {
                return Err(NexusError::denied(format!(
                    "host function '{function}' is not in the runtime allowlist"
                )));
            }
        }

        let signature = self
            .signature
            .as_ref()
            .ok_or_else(|| NexusError::denied("module manifest is unsigned"))?;
        registry.verify(&signature.signer_id, &self.signing_bytes(), signature)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_edge_protocol::{DevSigner, Signer, TrustedSigner};

    fn registry(signer: &DevSigner) -> SignerRegistry {
        let mut registry = SignerRegistry::new();
        registry.register(TrustedSigner {
            signer_id: signer.signer_id().to_string(),
            verifier: Box::new(signer.clone()),
            permitted_capabilities: vec![],
        });
        registry
    }

    fn signed_manifest(bytes: &[u8]) -> (ModuleManifest, DevSigner) {
        let signer = DevSigner::new("build-server", b"0123456789abcdef-module-key").unwrap();
        let mut manifest = ModuleManifest::new(
            "collect-temperature",
            "1.0.0",
            bytes,
            vec!["nexus_read_sensor".into(), "nexus_emit_observation".into()],
        );
        manifest.signature = Some(signer.sign(&manifest.signing_bytes()).unwrap());
        (manifest, signer)
    }

    #[test]
    fn a_matching_signed_module_verifies() {
        let bytes = b"\0asm-fake-module-bytes";
        let (manifest, signer) = signed_manifest(bytes);
        manifest.verify(bytes, &registry(&signer)).unwrap();
    }

    #[test]
    fn a_swapped_module_is_rejected_on_hash() {
        let bytes = b"\0asm-fake-module-bytes";
        let (manifest, signer) = signed_manifest(bytes);
        let error = manifest
            .verify(b"\0asm-different-bytes", &registry(&signer))
            .unwrap_err();
        assert_eq!(error.kind(), "integrity");
    }

    #[test]
    fn an_unsigned_manifest_is_rejected() {
        let bytes = b"module";
        let mut manifest = ModuleManifest::new("m", "1", bytes, vec![]);
        manifest.signature = None;
        let signer = DevSigner::new("build-server", b"0123456789abcdef-module-key").unwrap();
        assert_eq!(
            manifest
                .verify(bytes, &registry(&signer))
                .unwrap_err()
                .kind(),
            "denied"
        );
    }

    #[test]
    fn a_manifest_cannot_grant_a_host_function_outside_the_allowlist() {
        let bytes = b"module";
        let signer = DevSigner::new("build-server", b"0123456789abcdef-module-key").unwrap();
        let mut manifest = ModuleManifest::new("m", "1", bytes, vec!["nexus_open_socket".into()]);
        manifest.signature = Some(signer.sign(&manifest.signing_bytes()).unwrap());
        let error = manifest.verify(bytes, &registry(&signer)).unwrap_err();
        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn tampering_with_the_limits_breaks_the_manifest_signature() {
        let bytes = b"module";
        let (mut manifest, signer) = signed_manifest(bytes);
        manifest.limits.fuel = u64::MAX;
        assert!(manifest.verify(bytes, &registry(&signer)).is_err());
    }

    #[test]
    fn absurd_limits_are_rejected() {
        let mut limits = ResourceLimits::default();
        limits.max_memory_bytes = 2 * 1024 * 1024 * 1024;
        assert!(limits.validate().is_err());
        limits = ResourceLimits::default();
        limits.timeout_millis = 0;
        assert!(limits.validate().is_err());
        assert!(ResourceLimits::default().validate().is_ok());
    }

    #[test]
    fn capability_tokens_expire() {
        let token =
            CapabilityToken::new("sensor.temperature", "tsk_1", Timestamp::from_millis(1_000));
        assert!(token.is_valid_at(Timestamp::from_millis(999)));
        assert!(!token.is_valid_at(Timestamp::from_millis(1_000)));
    }
}
