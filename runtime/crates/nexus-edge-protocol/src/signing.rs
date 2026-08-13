//! Signing, verification, signer trust and replay protection.

use nexus_event::hash::{constant_time_eq, sha256, to_hex, Sha256};
use nexus_event::{NexusError, Result, Timestamp};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Mutex;

/// A detached signature over canonical task bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureEnvelope {
    pub algorithm: String,
    pub signer_id: String,
    pub value_hex: String,
}

/// Produces signatures.
pub trait Signer: Send + Sync + std::fmt::Debug {
    fn signer_id(&self) -> &str;
    fn algorithm(&self) -> &'static str;
    fn sign(&self, message: &[u8]) -> Result<SignatureEnvelope>;

    /// Whether this signer is acceptable for commanding real hardware.
    fn is_production_grade(&self) -> bool;
}

/// Verifies signatures.
pub trait Verifier: Send + Sync + std::fmt::Debug {
    fn algorithm(&self) -> &'static str;
    fn verify(&self, message: &[u8], signature: &SignatureEnvelope) -> Result<()>;
    fn is_production_grade(&self) -> bool;
}

/// **Not cryptography.** A keyed SHA-256 construction used only so the
/// pipeline, the tests and the offline demo can exercise the full
/// sign/verify/anti-replay path without a crypto dependency.
///
/// It provides integrity against accidental corruption and against an
/// attacker who does not have the key, but it has had no cryptographic
/// review, uses no vetted implementation, and is length-extension-shaped
/// rather than a real HMAC construction reviewed as such.
///
/// `is_production_grade()` returns `false`, and
/// [`SignerRegistry::require_production_signer`] refuses it for any device in
/// `PHYSICAL_NON_WEAPONIZED` mode. Enable the `ed25519` feature for real
/// deployments.
#[derive(Debug, Clone)]
pub struct DevSigner {
    signer_id: String,
    key: Vec<u8>,
}

impl DevSigner {
    pub fn new(signer_id: impl Into<String>, key: &[u8]) -> Result<Self> {
        if key.len() < 16 {
            return Err(NexusError::invalid(
                "dev signer key must be at least 16 bytes",
            ));
        }

        Ok(DevSigner {
            signer_id: signer_id.into(),
            key: key.to_vec(),
        })
    }

    fn tag(&self, message: &[u8]) -> [u8; 32] {
        // Two-pass keyed construction, closer to HMAC than a bare
        // hash(key || message). Still not a reviewed primitive.
        let mut inner_key = [0x36u8; 64];
        let mut outer_key = [0x5cu8; 64];

        for (index, byte) in self.key.iter().take(64).enumerate() {
            inner_key[index] ^= *byte;
            outer_key[index] ^= *byte;
        }

        let mut inner = Sha256::new();
        inner.update(&inner_key);
        inner.update(message);
        let inner_digest = inner.finalize();

        let mut outer = Sha256::new();
        outer.update(&outer_key);
        outer.update(&inner_digest);
        outer.finalize()
    }
}

impl Signer for DevSigner {
    fn signer_id(&self) -> &str {
        &self.signer_id
    }

    fn algorithm(&self) -> &'static str {
        "dev-keyed-sha256-NOT-CRYPTOGRAPHY"
    }

    fn sign(&self, message: &[u8]) -> Result<SignatureEnvelope> {
        Ok(SignatureEnvelope {
            algorithm: Signer::algorithm(self).to_string(),
            signer_id: self.signer_id.clone(),
            value_hex: to_hex(&self.tag(message)),
        })
    }

    fn is_production_grade(&self) -> bool {
        false
    }
}

impl Verifier for DevSigner {
    fn algorithm(&self) -> &'static str {
        "dev-keyed-sha256-NOT-CRYPTOGRAPHY"
    }

    fn verify(&self, message: &[u8], signature: &SignatureEnvelope) -> Result<()> {
        if signature.algorithm != Verifier::algorithm(self) {
            return Err(NexusError::integrity(format!(
                "unexpected signature algorithm '{}'",
                signature.algorithm
            )));
        }

        if signature.signer_id != self.signer_id {
            return Err(NexusError::integrity("signature signer_id mismatch"));
        }

        let expected = to_hex(&self.tag(message));

        if !constant_time_eq(expected.as_bytes(), signature.value_hex.as_bytes()) {
            return Err(NexusError::integrity("signature does not verify"));
        }

        Ok(())
    }

    fn is_production_grade(&self) -> bool {
        false
    }
}

/// Production Ed25519 signer.
///
/// **Build status: behind the `ed25519` feature, not part of the default
/// build.**
#[cfg(feature = "ed25519")]
pub mod ed25519 {
    use super::{NexusError, Result, SignatureEnvelope, Signer, Verifier};
    use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
    use nexus_event::hash::{from_hex, to_hex};

    #[derive(Debug)]
    pub struct Ed25519Signer {
        signer_id: String,
        key: SigningKey,
    }

    impl Ed25519Signer {
        /// Builds a signer from a 32-byte seed. The seed is supplied by the
        /// deployment (KMS, HSM export, sealed file); it is never generated
        /// or stored by this crate.
        pub fn from_seed(signer_id: impl Into<String>, seed: &[u8]) -> Result<Self> {
            let bytes: [u8; 32] = seed
                .try_into()
                .map_err(|_| NexusError::invalid("ed25519 seed must be exactly 32 bytes"))?;

            Ok(Ed25519Signer {
                signer_id: signer_id.into(),
                key: SigningKey::from_bytes(&bytes),
            })
        }

        pub fn verifying_key_hex(&self) -> String {
            to_hex(self.key.verifying_key().as_bytes())
        }
    }

    impl Signer for Ed25519Signer {
        fn signer_id(&self) -> &str {
            &self.signer_id
        }

        fn algorithm(&self) -> &'static str {
            "ed25519"
        }

        fn sign(&self, message: &[u8]) -> Result<SignatureEnvelope> {
            let signature = self.key.sign(message);

            Ok(SignatureEnvelope {
                algorithm: "ed25519".to_string(),
                signer_id: self.signer_id.clone(),
                value_hex: to_hex(&signature.to_bytes()),
            })
        }

        fn is_production_grade(&self) -> bool {
            true
        }
    }

    #[derive(Debug)]
    pub struct Ed25519Verifier {
        signer_id: String,
        key: VerifyingKey,
    }

    impl Ed25519Verifier {
        pub fn from_public_hex(signer_id: impl Into<String>, public_hex: &str) -> Result<Self> {
            let bytes = from_hex(public_hex)
                .ok_or_else(|| NexusError::invalid("public key must be hex"))?;

            let bytes: [u8; 32] = bytes
                .try_into()
                .map_err(|_| NexusError::invalid("ed25519 public key must be 32 bytes"))?;

            let key = VerifyingKey::from_bytes(&bytes)
                .map_err(|error| NexusError::invalid(format!("invalid public key: {error}")))?;

            Ok(Ed25519Verifier {
                signer_id: signer_id.into(),
                key,
            })
        }
    }

    impl Verifier for Ed25519Verifier {
        fn algorithm(&self) -> &'static str {
            "ed25519"
        }

        fn verify(&self, message: &[u8], signature: &SignatureEnvelope) -> Result<()> {
            if signature.algorithm != "ed25519" {
                return Err(NexusError::integrity("unexpected signature algorithm"));
            }

            if signature.signer_id != self.signer_id {
                return Err(NexusError::integrity("signature signer_id mismatch"));
            }

            let raw = from_hex(&signature.value_hex)
                .ok_or_else(|| NexusError::integrity("signature must be hex"))?;

            let bytes: [u8; 64] = raw
                .try_into()
                .map_err(|_| NexusError::integrity("ed25519 signature must be 64 bytes"))?;

            self.key
                .verify(message, &Signature::from_bytes(&bytes))
                .map_err(|_| NexusError::integrity("signature does not verify"))
        }

        fn is_production_grade(&self) -> bool {
            true
        }
    }
}

/// A signer the runtime is willing to trust.
#[derive(Debug)]
pub struct TrustedSigner {
    pub signer_id: String,
    pub verifier: Box<dyn Verifier>,

    /// Capabilities this signer may authorise. Empty means all.
    pub permitted_capabilities: Vec<String>,
}

/// The set of trusted signers. An unknown signer is never trusted.
#[derive(Debug, Default)]
pub struct SignerRegistry {
    signers: HashMap<String, TrustedSigner>,
}

impl SignerRegistry {
    pub fn new() -> Self {
        SignerRegistry::default()
    }

    pub fn register(&mut self, signer: TrustedSigner) {
        self.signers.insert(signer.signer_id.clone(), signer);
    }

    pub fn is_known(&self, signer_id: &str) -> bool {
        self.signers.contains_key(signer_id)
    }

    pub fn get(&self, signer_id: &str) -> Option<&TrustedSigner> {
        self.signers.get(signer_id)
    }

    pub fn len(&self) -> usize {
        self.signers.len()
    }

    pub fn is_empty(&self) -> bool {
        self.signers.is_empty()
    }

    pub fn verify(
        &self,
        signer_id: &str,
        message: &[u8],
        signature: &SignatureEnvelope,
    ) -> Result<()> {
        let signer = self
            .signers
            .get(signer_id)
            .ok_or_else(|| NexusError::denied(format!("unknown signer '{signer_id}'")))?;

        signer.verifier.verify(message, signature)
    }

    /// Fails closed when a non-production signer is used to command hardware.
    pub fn require_production_signer(&self, signer_id: &str) -> Result<()> {
        let signer = self
            .signers
            .get(signer_id)
            .ok_or_else(|| NexusError::denied(format!("unknown signer '{signer_id}'")))?;

        if !signer.verifier.is_production_grade() {
            return Err(NexusError::denied(format!(
                "signer '{signer_id}' uses {} which is not permitted outside SIMULATION",
                signer.verifier.algorithm()
            )));
        }

        Ok(())
    }

    pub fn permits_capability(&self, signer_id: &str, capability: &str) -> bool {
        match self.signers.get(signer_id) {
            None => false,

            Some(signer) => {
                signer.permitted_capabilities.is_empty()
                    || signer
                        .permitted_capabilities
                        .iter()
                        .any(|permitted| permitted == capability)
            }
        }
    }
}

/// Bounded ledger of observed nonces.
///
/// A nonce is accepted once. The ledger is bounded, so it is paired with task
/// expiry: the window must outlive the maximum `expires_at` horizon, which
/// [`NonceLedger::prune_expired`] enforces by dropping only entries whose
/// task deadline has already passed.
#[derive(Debug)]
pub struct NonceLedger {
    capacity: usize,
    seen: Mutex<(HashSet<String>, VecDeque<(String, Timestamp)>)>,
}

impl NonceLedger {
    pub fn new(capacity: usize) -> Self {
        NonceLedger {
            capacity: capacity.max(1),
            seen: Mutex::new((HashSet::new(), VecDeque::new())),
        }
    }

    /// Returns `true` if the nonce is fresh, `false` if it is a replay.
    pub fn accept(&self, nonce: &str, expires_at: Timestamp) -> bool {
        let mut guard = self.seen.lock().expect("nonce ledger poisoned");

        let (set, order) = &mut *guard;

        if set.contains(nonce) {
            return false;
        }

        if order.len() >= self.capacity {
            if let Some((oldest, _)) = order.pop_front() {
                set.remove(&oldest);
            }
        }

        set.insert(nonce.to_string());

        order.push_back((nonce.to_string(), expires_at));

        true
    }

    pub fn has_seen(&self, nonce: &str) -> bool {
        self.seen
            .lock()
            .map(|guard| guard.0.contains(nonce))
            .unwrap_or(false)
    }

    /// Drops entries whose task deadline has passed; those can no longer be
    /// replayed because expiry rejects them first.
    pub fn prune_expired(&self, now: Timestamp) -> usize {
        let mut guard = self.seen.lock().expect("nonce ledger poisoned");

        let (set, order) = &mut *guard;
        let mut removed = 0;

        while let Some((nonce, expires_at)) = order.front().cloned() {
            if expires_at.is_before(now) {
                order.pop_front();
                set.remove(&nonce);
                removed += 1;
            } else {
                break;
            }
        }

        removed
    }

    pub fn len(&self) -> usize {
        self.seen.lock().map(|guard| guard.0.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Generates a nonce bound to a task and issue time.
pub fn generate_nonce(task_id: &str, issued_at: Timestamp, salt: &str) -> String {
    let material = format!("{task_id}|{}|{salt}", issued_at.as_millis());

    to_hex(&sha256(material.as_bytes()))[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signer() -> DevSigner {
        DevSigner::new("orchestratord-test", b"0123456789abcdef-test-key").unwrap()
    }

    #[test]
    fn dev_signer_round_trips() {
        let signer = signer();

        let signature = Signer::sign(&signer, b"payload").unwrap();

        assert!(Verifier::verify(&signer, b"payload", &signature,).is_ok());
    }

    #[test]
    fn dev_signer_rejects_a_modified_message() {
        let signer = signer();

        let signature = Signer::sign(&signer, b"payload").unwrap();

        assert!(Verifier::verify(&signer, b"payloab", &signature,).is_err());
    }

    #[test]
    fn dev_signer_declares_itself_non_production() {
        let signer = signer();

        assert!(!Signer::is_production_grade(&signer));

        assert!(Signer::algorithm(&signer).contains("NOT-CRYPTOGRAPHY"));
    }

    #[test]
    fn short_keys_are_refused() {
        assert!(DevSigner::new("s", b"short").is_err());
    }

    #[test]
    fn registry_rejects_unknown_signers() {
        let registry = SignerRegistry::new();

        let signature = SignatureEnvelope {
            algorithm: "dev-keyed-sha256-NOT-CRYPTOGRAPHY".into(),
            signer_id: "ghost".into(),
            value_hex: "00".into(),
        };

        let error = registry.verify("ghost", b"x", &signature).unwrap_err();

        assert_eq!(error.kind(), "denied");
    }

    #[test]
    fn registry_refuses_a_dev_signer_for_production_hardware() {
        let mut registry = SignerRegistry::new();

        registry.register(TrustedSigner {
            signer_id: "orchestratord-test".into(),
            verifier: Box::new(signer()),
            permitted_capabilities: vec![],
        });

        assert!(registry.is_known("orchestratord-test"));

        let error = registry
            .require_production_signer("orchestratord-test")
            .unwrap_err();

        assert_eq!(error.kind(), "denied");

        assert!(error.to_string().contains("SIMULATION"));
    }

    #[test]
    fn capability_scoping_is_enforced_per_signer() {
        let mut registry = SignerRegistry::new();

        registry.register(TrustedSigner {
            signer_id: "read-only".into(),

            verifier: Box::new(signer()),

            permitted_capabilities: vec!["sensor.temperature".into()],
        });

        assert!(registry.permits_capability("read-only", "sensor.temperature",));

        assert!(!registry.permits_capability("read-only", "manipulator.fixture",));

        assert!(!registry.permits_capability("nobody", "sensor.temperature",));
    }

    #[test]
    fn nonces_are_accepted_once() {
        let ledger = NonceLedger::new(16);

        let expiry = Timestamp::from_millis(10_000);

        assert!(ledger.accept("n1", expiry,));

        assert!(!ledger.accept("n1", expiry,));

        assert!(ledger.has_seen("n1"));
    }

    #[test]
    fn nonce_ledger_is_bounded() {
        let ledger = NonceLedger::new(4);

        for index in 0..10 {
            ledger.accept(&format!("n{index}"), Timestamp::from_millis(10_000));
        }

        assert_eq!(first.len(), 32);
    }
}
