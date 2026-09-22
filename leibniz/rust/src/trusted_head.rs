//! Fail-closed anti-rollback gate for operator-supplied, independently retained
//! latest-head witnesses. The witness MUST be protected outside the checkpoint
//! and its ordinary byte pin. This module neither signs nor authenticates the
//! witness, prevents concurrent forks, nor defeats compromise of all stores.
use crate::sequential_ingest::{append_authorized_batch, StreamState};

const VERSION: &str = "LEIBNIZ_TRUSTED_HEAD_V1";
const MAX_HEAD_BYTES: usize = 256;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedHead {
    pub source_id: String,
    pub sequence: u64,
}

impl TrustedHead {
    pub fn from_checkpoint(checkpoint: &[u8], independent_pin: &[u8]) -> Result<Self, String> {
        if checkpoint.is_empty() || checkpoint != independent_pin {
            return Err("cannot propose a head from an unpinned checkpoint".into());
        }
        let state = StreamState::from_bytes(checkpoint)?;
        Ok(Self {
            source_id: state.source_id().to_owned(),
            sequence: state.sequence(),
        })
    }

    /// A canonical record. It becomes *trusted* only after the operator
    /// publishes it to an independently protected, monotonic external store.
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        StreamState::initial(&self.source_id)?;
        let bytes = format!("{VERSION}\t{}\t{}\n", self.source_id, self.sequence).into_bytes();
        if bytes.len() > MAX_HEAD_BYTES {
            return Err("trusted-head record exceeds byte limit".into());
        }
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_HEAD_BYTES {
            return Err("trusted-head record has invalid size".into());
        }
        let text = std::str::from_utf8(bytes).map_err(|_| "trusted-head record is not UTF-8")?;
        let fields = text.split('\t').collect::<Vec<_>>();
        let [version, source_id, sequence] = fields.as_slice() else {
            return Err("trusted-head record must have exactly three fields".into());
        };
        if *version != VERSION || !sequence.ends_with('\n') {
            return Err("trusted-head version or line ending is invalid".into());
        }
        let parsed = sequence
            .strip_suffix('\n')
            .ok_or("trusted-head record has no newline")?
            .parse::<u64>()
            .map_err(|_| "trusted-head sequence is invalid")?;
        let head = Self {
            source_id: (*source_id).to_owned(),
            sequence: parsed,
        };
        if head.to_bytes()?.as_slice() != bytes {
            return Err("trusted-head record must be canonical".into());
        }
        Ok(head)
    }
}

/// A previous state and its usual reference can BOTH be rolled back together;
/// the separate witness must therefore identify the independently known latest
/// source/sequence. An old witness also defeats this gate: caller must obtain
/// it from a trustworthy monotonic authority on every operation.
pub fn verify_latest_checkpoint(
    checkpoint: &[u8],
    independently_pinned_checkpoint: &[u8],
    trusted_head_bytes: &[u8],
) -> Result<StreamState, String> {
    if checkpoint.is_empty() || checkpoint != independently_pinned_checkpoint {
        return Err("checkpoint differs from independently pinned bytes".into());
    }
    let state = StreamState::from_bytes(checkpoint)?;
    let head = TrustedHead::from_bytes(trusted_head_bytes)?;
    if state.source_id() != head.source_id || state.sequence() != head.sequence {
        return Err("checkpoint is not the independently witnessed latest source head".into());
    }
    Ok(state)
}

pub fn append_with_trusted_head(
    previous_checkpoint: &[u8],
    independently_pinned_previous: &[u8],
    trusted_head_bytes: &[u8],
    supplied_batch: &[u8],
    independently_pinned_batch: &[u8],
    next_sequence: u64,
) -> Result<Vec<u8>, String> {
    let latest = verify_latest_checkpoint(
        previous_checkpoint,
        independently_pinned_previous,
        trusted_head_bytes,
    )?;
    if latest.sequence().checked_add(1) != Some(next_sequence) {
        return Err("next batch does not directly follow the independently witnessed head".into());
    }
    append_authorized_batch(
        previous_checkpoint,
        independently_pinned_previous,
        supplied_batch,
        independently_pinned_batch,
        next_sequence,
    )
}

pub fn extract_with_trusted_head(
    checkpoint: &[u8],
    independently_pinned_checkpoint: &[u8],
    trusted_head_bytes: &[u8],
) -> Result<Vec<u8>, String> {
    let state = verify_latest_checkpoint(
        checkpoint,
        independently_pinned_checkpoint,
        trusted_head_bytes,
    )?;
    Ok(state.archive_bytes()?.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn batch(rate: &str, to: &str, evidence: &str) -> Vec<u8> {
        format!("LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\t{to}\tChannel\nFLOW\tsource\t{to}\t{rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t{evidence}\n").into_bytes()
    }
    fn begin() -> Vec<u8> {
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
    fn append(state: &[u8], head: &[u8], input: &[u8], seq: u64) -> Result<Vec<u8>, String> {
        append_with_trusted_head(state, state, head, input, input, seq)
    }

    #[test]
    fn independently_current_witness_accepts_two_real_semantic_batches() {
        let first = append(&begin(), &witness(&begin()), &batch("3", "left", "e1"), 1).unwrap();
        let second = append(&first, &witness(&first), &batch("8", "right", "e2"), 2).unwrap();
        let archived = extract_with_trusted_head(&second, &second, &witness(&second)).unwrap();
        let archive = crate::semantic_archive::SemanticArchive::from_bytes(&archived).unwrap();
        assert_eq!(archive.snapshot.flows.len(), 2);
        assert_eq!(
            archive.snapshot.flows[0].annotation.evidence_id,
            "approved/e1"
        );
        assert_eq!(
            archive.snapshot.flows[1].annotation.evidence_id,
            "approved/e2"
        );
    }

    #[test]
    fn simultaneous_checkpoint_and_ordinary_pin_rollback_is_refused() {
        let initial = begin();
        let first = append(&initial, &witness(&initial), &batch("3", "left", "e1"), 1).unwrap();
        let second = append(&first, &witness(&first), &batch("8", "right", "e2"), 2).unwrap();
        let latest_head = witness(&second);
        // Both ordinary files match the obsolete first checkpoint byte-for-byte.
        assert!(append(&first, &latest_head, &batch("9", "other", "e3"), 2).is_err());
        assert!(extract_with_trusted_head(&first, &first, &latest_head).is_err());
    }

    #[test]
    fn cross_source_and_forged_future_sequence_are_refused() {
        let initial = begin();
        let head = TrustedHead {
            source_id: "other".into(),
            sequence: 0,
        }
        .to_bytes()
        .unwrap();
        assert!(verify_latest_checkpoint(&initial, &initial, &head).is_err());
        let head = TrustedHead {
            source_id: "approved".into(),
            sequence: 5,
        }
        .to_bytes()
        .unwrap();
        assert!(append(&initial, &head, &batch("3", "left", "e1"), 1).is_err());
    }

    #[test]
    fn tampered_pin_and_noncanonical_witness_fail_closed() {
        let initial = begin();
        let head = witness(&initial);
        assert!(verify_latest_checkpoint(&initial, b"changed", &head).is_err());
        for forged in [
            b"LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t00\n".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t0\r\n".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t0\nextra".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V2\tapproved\t0\n".as_slice(),
        ] {
            assert!(verify_latest_checkpoint(&initial, &initial, forged).is_err());
        }
    }

    #[test]
    fn old_witness_also_rolled_back_is_outside_this_trust_boundary() {
        let initial = begin();
        let first = append(&initial, &witness(&initial), &batch("3", "left", "e1"), 1).unwrap();
        let second = append(&first, &witness(&first), &batch("8", "right", "e2"), 2).unwrap();
        // This is deliberately accepted to make the trust limitation explicit:
        // the function cannot infer the existence of a higher head when ALL
        // its externally supplied evidence has itself been rolled back.
        assert!(verify_latest_checkpoint(&first, &first, &witness(&first)).is_ok());
        assert!(verify_latest_checkpoint(&first, &first, &witness(&second)).is_err());
    }
}
