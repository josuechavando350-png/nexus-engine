//! Fail-closed, byte-exact policy witness for the *guarded* ingestion route.
//! A proposal is not a signature. The caller must fetch the latest witness from
//! an independently authenticated, monotonic authority on every operation.
//! An attacker who can replace that witness can still roll back authorization.
use crate::source_policy::{append_with_policy, SourcePolicy};

const VERSION: &str = "LEIBNIZ_POLICY_HEAD_V1";
const MAX_WITNESS_BYTES: usize = 1024;
const MAX_HEADER_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PolicyWitness {
    source_id: String,
    revision: u64,
    policy_bytes: Vec<u8>,
}

impl PolicyWitness {
    /// Only proposes a witness; publishing it through a trusted authority is
    /// an external, independently verified operator action.
    pub fn from_policy(policy_bytes: &[u8], independent_pin: &[u8]) -> Result<Self, String> {
        if policy_bytes.is_empty() || policy_bytes != independent_pin {
            return Err("cannot propose policy witness from unpinned policy".into());
        }
        let policy = SourcePolicy::from_bytes(policy_bytes)?;
        Ok(Self {
            source_id: policy.source_id,
            revision: policy.revision,
            policy_bytes: policy_bytes.to_vec(),
        })
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        let policy = SourcePolicy::from_bytes(&self.policy_bytes)?;
        if policy.source_id != self.source_id || policy.revision != self.revision {
            return Err("policy witness metadata differs from bound policy".into());
        }
        let mut bytes = format!(
            "{VERSION}\t{}\t{}\t{}\n",
            self.source_id,
            self.revision,
            self.policy_bytes.len()
        )
        .into_bytes();
        if bytes
            .len()
            .checked_add(self.policy_bytes.len())
            .is_none_or(|size| size > MAX_WITNESS_BYTES)
        {
            return Err("policy witness exceeds size limit".into());
        }
        bytes.extend_from_slice(&self.policy_bytes);
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_WITNESS_BYTES {
            return Err("policy witness has invalid size".into());
        }
        let newline = bytes
            .iter()
            .take(MAX_HEADER_BYTES + 1)
            .position(|byte| *byte == b'\n')
            .ok_or("policy witness is missing a bounded header")?;
        let header = std::str::from_utf8(&bytes[..newline])
            .map_err(|_| "policy witness header is not UTF-8")?;
        let fields = header.split('\t').collect::<Vec<_>>();
        let [version, source_id, revision_text, length_text] = fields.as_slice() else {
            return Err("policy witness header needs exactly four fields".into());
        };
        if *version != VERSION {
            return Err("unsupported policy witness version".into());
        }
        let revision = revision_text
            .parse::<u64>()
            .map_err(|_| "invalid policy witness revision")?;
        let length = length_text
            .parse::<usize>()
            .map_err(|_| "invalid policy witness length")?;
        if revision.to_string() != *revision_text
            || length.to_string() != *length_text
            || bytes.len() - newline - 1 != length
        {
            return Err("policy witness has noncanonical header or length".into());
        }
        let proposal = Self::from_policy(&bytes[newline + 1..], &bytes[newline + 1..])?;
        if proposal.source_id != *source_id
            || proposal.revision != revision
            || proposal.to_bytes()? != bytes
        {
            return Err("policy witness is not bound to canonical policy bytes".into());
        }
        Ok(proposal)
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }
}

/// An independently retained CURRENT witness must match the whole policy,
/// including revocation status, validity window and batch limits. A matching
/// revision or a copy of the ordinary pin is insufficient by itself.
pub fn verify_latest_policy(
    policy_bytes: &[u8],
    independent_pin: &[u8],
    trusted_policy_head: &[u8],
) -> Result<PolicyWitness, String> {
    if policy_bytes.is_empty() || policy_bytes != independent_pin {
        return Err("policy differs from separately pinned bytes".into());
    }
    let witness = PolicyWitness::from_bytes(trusted_policy_head)?;
    if witness.policy_bytes != policy_bytes {
        return Err("policy bytes differ from independently witnessed latest policy".into());
    }
    Ok(witness)
}

/// Guarded route: no caller-supplied revision floor can replace the exact
/// latest-policy witness. Existing `append_with_policy` is a legacy operator
/// route without this second witness and MUST NOT be used to claim anti-rollback.
#[allow(clippy::too_many_arguments)]
pub fn append_with_policy_witness(
    checkpoint: &[u8],
    checkpoint_pin: &[u8],
    trusted_checkpoint_head: &[u8],
    batch: &[u8],
    batch_pin: &[u8],
    next_sequence: u64,
    policy_bytes: &[u8],
    policy_pin: &[u8],
    trusted_policy_head: &[u8],
    as_of_utc_ms: i64,
) -> Result<Vec<u8>, String> {
    let witness = verify_latest_policy(policy_bytes, policy_pin, trusted_policy_head)?;
    append_with_policy(
        checkpoint,
        checkpoint_pin,
        trusted_checkpoint_head,
        batch,
        batch_pin,
        next_sequence,
        policy_bytes,
        policy_pin,
        witness.revision(),
        as_of_utc_ms,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sequential_ingest::StreamState;
    use crate::trusted_head::TrustedHead;

    fn policy(revision: u64, allowed: bool) -> Vec<u8> {
        SourcePolicy {
            source_id: "approved".into(),
            revision,
            allowed,
            min_sequence: 1,
            max_sequence: 2,
            valid_from_utc_ms: 100,
            valid_until_utc_ms: 200,
        }
        .to_bytes()
        .unwrap()
    }

    fn append(policy_bytes: &[u8], policy_pin: &[u8], policy_head: &[u8]) -> Result<Vec<u8>, String> {
        let initial = StreamState::initial("approved")?.to_bytes()?;
        let checkpoint_head = TrustedHead::from_checkpoint(&initial, &initial)?.to_bytes()?;
        let batch = b"LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\tleft\tChannel\nFLOW\tsource\tleft\t3\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\tevidence-1\n";
        append_with_policy_witness(
            &initial,
            &initial,
            &checkpoint_head,
            batch,
            batch,
            1,
            policy_bytes,
            policy_pin,
            policy_head,
            150,
        )
    }

    #[test]
    fn current_policy_witness_allows_real_semantic_ingestion() {
        let permitted = policy(3, true);
        let head = PolicyWitness::from_policy(&permitted, &permitted)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert_eq!(PolicyWitness::from_bytes(&head).unwrap().revision(), 3);
        let next = append(&permitted, &permitted, &head).unwrap();
        assert_eq!(StreamState::from_bytes(&next).unwrap().sequence(), 1);
    }

    #[test]
    fn latest_revocation_rejects_old_permit_and_current_revoked_policy() {
        let permitted = policy(3, true);
        let revoked = policy(4, false);
        let latest = PolicyWitness::from_policy(&revoked, &revoked)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert!(append(&permitted, &permitted, &latest).is_err());
        assert!(append(&revoked, &revoked, &latest).is_err());
    }

    #[test]
    fn same_revision_alternate_permissions_cannot_replace_witnessed_policy() {
        let permitted = policy(3, true);
        let revoked = policy(3, false);
        let latest = PolicyWitness::from_policy(&revoked, &revoked)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert!(append(&permitted, &permitted, &latest).is_err());
    }

    #[test]
    fn corrupt_head_wrong_source_and_noncanonical_length_fail_closed() {
        let permitted = policy(3, true);
        let head = PolicyWitness::from_policy(&permitted, &permitted)
            .unwrap()
            .to_bytes()
            .unwrap();
        let mut corrupt = head.clone();
        *corrupt.last_mut().unwrap() ^= 1;
        assert!(append(&permitted, &permitted, &corrupt).is_err());
        let wrong = String::from_utf8(head.clone()).unwrap().replacen("\tapproved\t", "\tother\t", 1);
        assert!(PolicyWitness::from_bytes(wrong.as_bytes()).is_err());
        let length = permitted.len().to_string();
        let noncanonical = String::from_utf8(head).unwrap().replacen(
            &format!("\t{length}\n"),
            &format!("\t0{length}\n"),
            1,
        );
        assert!(PolicyWitness::from_bytes(noncanonical.as_bytes()).is_err());
    }

    #[test]
    fn modified_policy_pin_and_old_witness_reject_new_revision() {
        let old = policy(3, true);
        let new = policy(4, true);
        let old_head = PolicyWitness::from_policy(&old, &old)
            .unwrap()
            .to_bytes()
            .unwrap();
        assert!(append(&new, &new, &old_head).is_err());
        assert!(append(&new, &old, &old_head).is_err());
        assert!(PolicyWitness::from_policy(&new, &old).is_err());
    }
}
