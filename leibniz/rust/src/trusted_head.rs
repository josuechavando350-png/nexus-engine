//! Fail-closed anti-rollback gate for operator-supplied, independently retained
//! latest-head witnesses. The witness MUST be protected outside the checkpoint
//! and its ordinary byte pin. This module neither signs nor authenticates the
//! witness, prevents concurrent forks, nor defeats compromise of all stores.
use crate::sequential_ingest::{append_authorized_batch, StreamState};

const VERSION: &str = "LEIBNIZ_TRUSTED_HEAD_V2";
const MAX_HEAD_BYTES: usize = 83 * 1024 * 1024;
const MAX_HEADER_BYTES: usize = 256;

/// Full, byte-exact latest checkpoint retained in a separate trust domain.
/// A sequence-only witness cannot detect different histories at the same
/// sequence. Keeping the actual bytes avoids pretending a weak checksum is
/// a cryptographic commitment, at the cost of duplicate storage.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedHead {
    source_id: String,
    sequence: u64,
    checkpoint_bytes: Vec<u8>,
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
            checkpoint_bytes: checkpoint.to_vec(),
        })
    }

    /// A canonical, byte-exact proposal. It becomes *trusted* only when an
    /// independent, authenticated monotonic store accepts it atomically.
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        let state = StreamState::from_bytes(&self.checkpoint_bytes)?;
        if state.source_id() != self.source_id || state.sequence() != self.sequence {
            return Err("trusted-head proposal does not match its checkpoint".into());
        }
        let mut bytes = format!(
            "{VERSION}\t{}\t{}\t{}\n",
            self.source_id,
            self.sequence,
            self.checkpoint_bytes.len()
        )
        .into_bytes();
        if bytes
            .len()
            .checked_add(self.checkpoint_bytes.len())
            .is_none_or(|size| size > MAX_HEAD_BYTES)
        {
            return Err("trusted-head record exceeds byte limit".into());
        }
        bytes.extend_from_slice(&self.checkpoint_bytes);
        Ok(bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_HEAD_BYTES {
            return Err("trusted-head record has invalid size".into());
        }
        let newline = bytes
            .iter()
            .take(MAX_HEADER_BYTES + 1)
            .position(|byte| *byte == b'\n')
            .ok_or("trusted-head record has no bounded header")?;
        let header = std::str::from_utf8(&bytes[..newline])
            .map_err(|_| "trusted-head header is not UTF-8")?;
        let fields = header.split('\t').collect::<Vec<_>>();
        let [version, source_id, sequence_text, length_text] = fields.as_slice() else {
            return Err("trusted-head header requires four fields".into());
        };
        if *version != VERSION {
            return Err("unsupported trusted-head version".into());
        }
        let sequence = sequence_text
            .parse::<u64>()
            .map_err(|_| "trusted-head sequence is invalid")?;
        let length = length_text
            .parse::<usize>()
            .map_err(|_| "trusted-head length is invalid")?;
        if sequence.to_string() != *sequence_text
            || length.to_string() != *length_text
            || bytes.len() - newline - 1 != length
        {
            return Err("trusted-head header or payload length is noncanonical".into());
        }
        let checkpoint = &bytes[newline + 1..];
        let state = StreamState::from_bytes(checkpoint)?;
        if state.source_id() != *source_id || state.sequence() != sequence {
            return Err("trusted-head source or sequence differs from bound checkpoint".into());
        }
        Ok(Self {
            source_id: (*source_id).to_owned(),
            sequence,
            checkpoint_bytes: checkpoint.to_vec(),
        })
    }
}

/// Both the previous state and ordinary pin may be replaced with an old or
/// alternate valid checkpoint; the separately protected witness must match
/// the exact latest bytes. The caller must fetch an authentic, current witness
/// for EVERY operation. Compromising the witness also defeats this gate.
pub fn verify_latest_checkpoint(
    checkpoint: &[u8],
    independently_pinned_checkpoint: &[u8],
    trusted_head_bytes: &[u8],
) -> Result<StreamState, String> {
    if checkpoint.is_empty() || checkpoint != independently_pinned_checkpoint {
        return Err("checkpoint differs from independently pinned bytes".into());
    }
    let witness = TrustedHead::from_bytes(trusted_head_bytes)?;
    if witness.checkpoint_bytes != checkpoint {
        return Err(
            "checkpoint bytes differ from independently witnessed latest source head".into(),
        );
    }
    StreamState::from_bytes(checkpoint)
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
        let initial = begin();
        let first = append(&initial, &witness(&initial), &batch("3", "left", "e1"), 1).unwrap();
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
        assert!(append(&first, &latest_head, &batch("9", "other", "e3"), 2).is_err());
        assert!(extract_with_trusted_head(&first, &first, &latest_head).is_err());
    }

    #[test]
    fn altered_history_at_the_same_sequence_cannot_replace_the_pinned_head() {
        let initial = begin();
        let first = append(&initial, &witness(&initial), &batch("3", "left", "e1"), 1).unwrap();
        let alternate =
            append(&initial, &witness(&initial), &batch("99", "left", "e1"), 1).unwrap();
        assert_eq!(
            StreamState::from_bytes(&first).unwrap().sequence(),
            StreamState::from_bytes(&alternate).unwrap().sequence()
        );
        assert_ne!(first, alternate);
        assert!(verify_latest_checkpoint(&alternate, &alternate, &witness(&first)).is_err());
        assert!(extract_with_trusted_head(&alternate, &alternate, &witness(&first)).is_err());
    }

    #[test]
    fn cross_source_and_forged_future_sequence_are_refused() {
        let initial = begin();
        for (source, sequence) in [("other", 0), ("approved", 5)] {
            let mut forged =
                format!("{VERSION}\t{source}\t{sequence}\t{}\n", initial.len()).into_bytes();
            forged.extend_from_slice(&initial);
            assert!(verify_latest_checkpoint(&initial, &initial, &forged).is_err());
        }
    }

    #[test]
    fn tampered_pin_and_noncanonical_witness_fail_closed() {
        let initial = begin();
        let head = witness(&initial);
        assert!(verify_latest_checkpoint(&initial, b"changed", &head).is_err());
        for forged in [
            b"LEIBNIZ_TRUSTED_HEAD_V1\tapproved\t0\n".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V2\tapproved\t00\t0\n".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V2\tapproved\t0\t0\r\n".as_slice(),
            b"LEIBNIZ_TRUSTED_HEAD_V2\tapproved\t0\t0\nextra".as_slice(),
        ] {
            assert!(verify_latest_checkpoint(&initial, &initial, forged).is_err());
        }
        let mut tampered = head.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert!(verify_latest_checkpoint(&initial, &initial, &tampered).is_err());
    }

    #[test]
    fn old_witness_also_rolled_back_is_outside_this_trust_boundary() {
        let initial = begin();
        let first = append(&initial, &witness(&initial), &batch("3", "left", "e1"), 1).unwrap();
        let second = append(&first, &witness(&first), &batch("8", "right", "e2"), 2).unwrap();
        // This is deliberately accepted to make the trust limitation explicit:
        // no computation can infer a higher head if its external witness was
        // also replaced with an old but internally valid witness.
        assert!(verify_latest_checkpoint(&first, &first, &witness(&first)).is_ok());
        assert!(verify_latest_checkpoint(&first, &first, &witness(&second)).is_err());
    }
}
