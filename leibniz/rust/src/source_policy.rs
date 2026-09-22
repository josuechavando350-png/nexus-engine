//! Local, fail-closed consent policy for an independently authenticated source.
//! Neither byte pins nor a caller-supplied minimum revision authenticate the
//! policy issuer. A real operator MUST obtain the policy and revision floor
//! from a separate trusted, monotonic authority on every request.
use crate::authorized_ingest::ingest_operator_tsv;
use crate::semantic_archive::SemanticArchive;
use crate::sequential_ingest::StreamState;
use crate::trusted_head::{append_with_trusted_head, verify_latest_checkpoint};

const VERSION: &str = "LEIBNIZ_SOURCE_POLICY_V1";
const MAX_POLICY_BYTES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourcePolicy {
    pub source_id: String,
    pub revision: u64,
    pub allowed: bool,
    pub min_sequence: u64,
    pub max_sequence: u64,
    pub valid_from_utc_ms: i64,
    pub valid_until_utc_ms: i64,
}

impl SourcePolicy {
    /// Canonical record, NOT a signed approval. Zero is never a policy revision.
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        StreamState::initial(&self.source_id)?;
        if self.revision == 0
            || self.min_sequence == 0
            || self.max_sequence < self.min_sequence
            || self.valid_until_utc_ms <= self.valid_from_utc_ms
        {
            return Err("invalid policy revision, batch window or UTC validity".into());
        }
        let status = if self.allowed { "ALLOW" } else { "REVOKED" };
        let bytes = format!(
            "{VERSION}\t{}\t{}\t{status}\t{}\t{}\t{}\t{}\n",
            self.source_id,
            self.revision,
            self.min_sequence,
            self.max_sequence,
            self.valid_from_utc_ms,
            self.valid_until_utc_ms
        )
        .into_bytes();
        if bytes.len() > MAX_POLICY_BYTES {
            return Err("source policy exceeds maximum bytes".into());
        }
        Ok(bytes)
    }

    pub fn from_bytes(raw: &[u8]) -> Result<Self, String> {
        if raw.is_empty() || raw.len() > MAX_POLICY_BYTES {
            return Err("missing or oversized source policy".into());
        }
        let text = std::str::from_utf8(raw).map_err(|_| "policy is not UTF-8")?;
        let line = text
            .strip_suffix('\n')
            .ok_or("policy needs canonical LF terminator")?;
        let fields = line.split('\t').collect::<Vec<_>>();
        let [version, source_id, revision, status, min, max, from, until] = fields.as_slice()
        else {
            return Err("source policy needs exactly eight fields".into());
        };
        if *version != VERSION {
            return Err("unsupported source policy version".into());
        }
        let policy = Self {
            source_id: (*source_id).into(),
            revision: revision.parse().map_err(|_| "invalid policy revision")?,
            allowed: match *status {
                "ALLOW" => true,
                "REVOKED" => false,
                _ => return Err("invalid source policy status".into()),
            },
            min_sequence: min.parse().map_err(|_| "invalid policy minimum sequence")?,
            max_sequence: max.parse().map_err(|_| "invalid policy maximum sequence")?,
            valid_from_utc_ms: from.parse().map_err(|_| "invalid policy start")?,
            valid_until_utc_ms: until.parse().map_err(|_| "invalid policy end")?,
        };
        if policy.to_bytes()?.as_slice() != raw {
            return Err("noncanonical source policy".into());
        }
        Ok(policy)
    }
}

/// This gate permits a SINGLE batch only when its independently presented
/// source policy is active and meets a separately obtained revision floor.
/// Time is caller-supplied: this function does not provide a trusted clock.
/// The ordinary source ingest/semantic checks and byte-exact latest checkpoint
/// witness remain mandatory; policy is additional, never a replacement.
#[allow(clippy::too_many_arguments)]
pub fn append_with_policy(
    checkpoint: &[u8],
    checkpoint_pin: &[u8],
    trusted_head: &[u8],
    batch: &[u8],
    batch_pin: &[u8],
    next_sequence: u64,
    policy_bytes: &[u8],
    policy_pin: &[u8],
    minimum_policy_revision: u64,
    as_of_utc_ms: i64,
) -> Result<Vec<u8>, String> {
    let state = verify_latest_checkpoint(checkpoint, checkpoint_pin, trusted_head)?;
    if policy_bytes.is_empty() || policy_bytes != policy_pin {
        return Err("policy differs from separately supplied reference".into());
    }
    let policy = SourcePolicy::from_bytes(policy_bytes)?;
    if !policy.allowed
        || policy.revision < minimum_policy_revision
        || minimum_policy_revision == 0
        || policy.source_id != state.source_id()
        || next_sequence < policy.min_sequence
        || next_sequence > policy.max_sequence
        || as_of_utc_ms < policy.valid_from_utc_ms
        || as_of_utc_ms >= policy.valid_until_utc_ms
    {
        return Err("source is revoked, policy stale, or batch outside authorized window".into());
    }
    let archive =
        SemanticArchive::from_bytes(&ingest_operator_tsv(batch, batch_pin, state.source_id())?)?;
    for annotation in archive
        .snapshot
        .flows
        .iter()
        .map(|row| &row.annotation)
        .chain(
            archive
                .snapshot
                .restrictions
                .iter()
                .map(|row| &row.annotation),
        )
    {
        if !annotation.validity.contains(as_of_utc_ms) {
            return Err("incoming measurement is not valid at policy evaluation time".into());
        }
    }
    append_with_trusted_head(
        checkpoint,
        checkpoint_pin,
        trusted_head,
        batch,
        batch_pin,
        next_sequence,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trusted_head::TrustedHead;

    fn initial() -> Vec<u8> {
        StreamState::initial("approved")
            .unwrap()
            .to_bytes()
            .unwrap()
    }
    fn witness(state: &[u8]) -> Vec<u8> {
        TrustedHead::from_checkpoint(state, state)
            .unwrap()
            .to_bytes()
            .unwrap()
    }
    fn batch() -> Vec<u8> {
        b"LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nFLOW\tsource\tleft\t3\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-1\n".to_vec()
    }
    fn policy() -> SourcePolicy {
        SourcePolicy {
            source_id: "approved".into(),
            revision: 3,
            allowed: true,
            min_sequence: 1,
            max_sequence: 2,
            valid_from_utc_ms: 100,
            valid_until_utc_ms: 200,
        }
    }
    fn try_append(
        policy_bytes: &[u8],
        policy_pin: &[u8],
        floor: u64,
        at: i64,
    ) -> Result<Vec<u8>, String> {
        let previous = initial();
        let input = batch();
        append_with_policy(
            &previous,
            &previous,
            &witness(&previous),
            &input,
            &input,
            1,
            policy_bytes,
            policy_pin,
            floor,
            at,
        )
    }
    #[test]
    fn active_policy_allows_real_semantic_append() {
        let raw = policy().to_bytes().unwrap();
        let next = try_append(&raw, &raw, 3, 150).unwrap();
        assert_eq!(StreamState::from_bytes(&next).unwrap().sequence(), 1);
    }
    #[test]
    fn revoked_source_and_policy_revision_rollback_are_rejected() {
        let mut p = policy();
        p.allowed = false;
        let revoked = p.to_bytes().unwrap();
        assert!(try_append(&revoked, &revoked, 3, 150).is_err());
        let old = policy().to_bytes().unwrap();
        assert!(try_append(&old, &old, 4, 150).is_err());
        assert!(try_append(&old, &old, 0, 150).is_err());
    }
    #[test]
    fn wrong_source_or_changed_policy_pin_are_rejected() {
        let raw = policy().to_bytes().unwrap();
        let mut wrong = policy();
        wrong.source_id = "other".into();
        let alien = wrong.to_bytes().unwrap();
        assert!(try_append(&alien, &alien, 3, 150).is_err());
        assert!(try_append(&raw, &alien, 3, 150).is_err());
    }
    #[test]
    fn stale_policy_time_and_expired_observation_are_rejected() {
        let raw = policy().to_bytes().unwrap();
        for at in [99, 200] {
            assert!(try_append(&raw, &raw, 3, at).is_err());
        }
        let mut p = policy();
        p.valid_until_utc_ms = 300;
        let extended = p.to_bytes().unwrap();
        assert!(try_append(&extended, &extended, 3, 200).is_err());
    }
    #[test]
    fn sequence_limits_and_noncanonical_policy_are_rejected() {
        let mut p = policy();
        p.min_sequence = 2;
        let raw = p.to_bytes().unwrap();
        assert!(try_append(&raw, &raw, 3, 150).is_err());
        let mut p = policy();
        p.max_sequence = 0;
        assert!(p.to_bytes().is_err());
        let raw = policy().to_bytes().unwrap();
        let noncanonical = String::from_utf8(raw).unwrap().replace("\t3\t", "\t03\t");
        assert!(try_append(noncanonical.as_bytes(), noncanonical.as_bytes(), 3, 150).is_err());
    }
    #[test]
    fn checkpoint_witness_is_not_bypassed_by_valid_policy() {
        let raw = policy().to_bytes().unwrap();
        let initial = initial();
        let input = batch();
        assert!(append_with_policy(
            &initial,
            &initial,
            &witness(&initial),
            &input,
            &input,
            2,
            &raw,
            &raw,
            3,
            150
        )
        .is_err());
        assert!(append_with_policy(
            &initial,
            b"changed",
            &witness(&initial),
            &input,
            &input,
            1,
            &raw,
            &raw,
            3,
            150
        )
        .is_err());
    }
}
