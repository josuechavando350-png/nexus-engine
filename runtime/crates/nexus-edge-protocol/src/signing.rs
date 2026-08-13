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

    pub fn prune_expired(&self, now: Timestamp) -> usize {
        let mut guard = self.seen.lock().expect("nonce ledger poisoned");
        let (set, order) = &mut *guard;
        let mut removed = 0;

        while let Some((nonce, expires_at)) = order.front().cloned
