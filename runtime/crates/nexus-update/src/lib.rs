//! Signed-update policy. Verification precedes staging; rollback protection is explicit.
#![forbid(unsafe_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseManifest {
    pub release_id: String,
    pub version: u64,
    pub artifact_digest: String,
    pub sbom_digest: String,
    pub provenance_digest: String,
    pub min_boot_counter: u64,
    pub expires_at_ms: u64,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerificationEvidence {
    pub manifest_digest: String,
    pub signer_identity: String,
    pub transparency_reference: Option<String>,
    pub verified_at_ms: u64,
}
pub trait ArtifactVerifier: Send + Sync {
    fn verify(
        &self,
        manifest: &ReleaseManifest,
        artifact: &[u8],
        now_ms: u64,
    ) -> Result<VerificationEvidence, String>;
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateDecision {
    Stage,
    RejectExpired,
    RejectRollback,
    RejectUnverified,
}
pub fn evaluate(
    manifest: &ReleaseManifest,
    current_version: u64,
    current_boot_counter: u64,
    verified: bool,
    now: u64,
) -> UpdateDecision {
    if !verified {
        return UpdateDecision::RejectUnverified;
    }
    if now >= manifest.expires_at_ms {
        return UpdateDecision::RejectExpired;
    }
    if manifest.version <= current_version || manifest.min_boot_counter < current_boot_counter {
        return UpdateDecision::RejectRollback;
    }
    UpdateDecision::Stage
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rollback_is_rejected() {
        let m = ReleaseManifest {
            release_id: "r".into(),
            version: 2,
            artifact_digest: "a".into(),
            sbom_digest: "s".into(),
            provenance_digest: "p".into(),
            min_boot_counter: 3,
            expires_at_ms: 100,
        };
        assert_eq!(evaluate(&m, 2, 3, true, 1), UpdateDecision::RejectRollback)
    }
}
