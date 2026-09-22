//! Offline, bounded, sequential ingestion into a durable semantic archive.
//! Previous checkpoint and incoming batch pins MUST come from independently
//! authorized channels. Matching bytes do not authenticate their issuer;
//! a fully compromised operator/checkpoint store can still forge a history.
//! No network polling, cryptographic signature, or automatic source trust.
use crate::authorized_ingest::ingest_operator_tsv;
use crate::schema::{Flow, Restriction};
use crate::semantic_archive::SemanticArchive;
use crate::semantics::SemanticSnapshot;
use crate::Graph;
use std::collections::BTreeSet;

const VERSION: &str = "LEIBNIZ_STREAM_V1";
const MAX_STATE_BYTES: usize = 82 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StreamState {
    source_id: String,
    sequence: u64,
    archive_bytes: Vec<u8>,
}

fn source_token(value: &str) -> Result<(), String> {
    if value.len() > 128
        || !value.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
        || !value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
    {
        return Err("invalid sequential source identity".into());
    }
    Ok(())
}

impl StreamState {
    /// The operator must store a trusted copy of this exact initial state.
    pub fn initial(approved_source_id: &str) -> Result<Self, String> {
        source_token(approved_source_id)?;
        Ok(Self {
            source_id: approved_source_id.to_owned(),
            sequence: 0,
            archive_bytes: Vec::new(),
        })
    }

    pub fn sequence(&self) -> u64 {
        self.sequence
    }

    pub fn source_id(&self) -> &str {
        &self.source_id
    }

    /// Returns a validated archive, not the entire checkpoint. There is no
    /// archive at sequence zero.
    pub fn archive_bytes(&self) -> Result<&[u8], String> {
        if self.sequence == 0 {
            return Err("initial checkpoint contains no semantic archive".into());
        }
        Ok(&self.archive_bytes)
    }

    /// Canonical versioned checkpoint. No unkeyed checksum is called a MAC.
    pub fn to_bytes(&self) -> Result<Vec<u8>, String> {
        source_token(&self.source_id)?;
        if (self.sequence == 0) != self.archive_bytes.is_empty() {
            return Err("checkpoint sequence and archive presence disagree".into());
        }
        if !self.archive_bytes.is_empty() {
            let archive = SemanticArchive::from_bytes(&self.archive_bytes)?;
            self.validate_source_ledger(&archive)?;
        }
        let mut bytes = format!(
            "{VERSION}\t{}\t{}\t{}\n",
            self.source_id,
            self.sequence,
            self.archive_bytes.len()
        ).into_bytes();
        if bytes.len().checked_add(self.archive_bytes.len()).is_none_or(|n| n > MAX_STATE_BYTES) {
            return Err("checkpoint exceeds maximum bytes".into());
        }
        bytes.extend_from_slice(&self.archive_bytes);
        Ok(bytes)
    }

    fn validate_source_ledger(&self, archive: &SemanticArchive) -> Result<(), String> {
        let prefix = format!("{}/", self.source_id);
        if archive.snapshot.flows.is_empty() && archive.snapshot.restrictions.is_empty() {
            return Err("noninitial stream checkpoint has no measurements".into());
        }
        let mut evidence = BTreeSet::new();
        for annotation in archive.snapshot.flows.iter().map(|f| &f.annotation)
            .chain(archive.snapshot.restrictions.iter().map(|r| &r.annotation))
        {
            if !annotation.evidence_id.starts_with(&prefix)
                || !evidence.insert(annotation.evidence_id.as_str())
            {
                return Err("checkpoint contains foreign or repeated evidence".into());
            }
        }
        Ok(())
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        if bytes.is_empty() || bytes.len() > MAX_STATE_BYTES {
            return Err("invalid bounded checkpoint length".into());
        }
        let newline = bytes.iter().position(|byte| *byte == b'\n')
            .ok_or("checkpoint has no version header")?;
        if newline > 256 {
            return Err("checkpoint header is oversized".into());
        }
        let header = std::str::from_utf8(&bytes[..newline])
            .map_err(|_| "checkpoint header is not UTF-8")?;
        let fields = header.split('\t').collect::<Vec<_>>();
        let [version, source_id, sequence, length] = fields.as_slice() else {
            return Err("invalid checkpoint header field count".into());
        };
        if *version != VERSION {
            return Err("unsupported checkpoint version".into());
        }
        source_token(source_id)?;
        let seq = sequence.parse::<u64>().map_err(|_| "invalid checkpoint sequence")?;
        let size = length.parse::<usize>().map_err(|_| "invalid checkpoint archive length")?;
        if seq.to_string() != *sequence || size.to_string() != *length
            || bytes.len() - newline - 1 != size
        {
            return Err("noncanonical checkpoint header or archive length".into());
        }
        let state = Self {
            source_id: (*source_id).to_owned(),
            sequence: seq,
            archive_bytes: bytes[newline + 1..].to_vec(),
        };
        if state.to_bytes()? != bytes {
            return Err("noncanonical checkpoint bytes".into());
        }
        Ok(state)
    }
}

/// Adds ONE complete, pinned source batch; all writes are returned as bytes.
/// The operator must persist the new state separately and independently pin it
/// before the next call. A missing step, duplicate sequence, changed old state,
/// conflicting entity or reused evidence fails without mutating input bytes.
pub fn append_authorized_batch(
    previous_checkpoint: &[u8],
    independently_pinned_previous: &[u8],
    supplied_batch: &[u8],
    independently_pinned_batch: &[u8],
    next_sequence: u64,
) -> Result<Vec<u8>, String> {
    if previous_checkpoint.is_empty() || previous_checkpoint != independently_pinned_previous {
        return Err("previous state differs from independently trusted checkpoint".into());
    }
    let previous = StreamState::from_bytes(previous_checkpoint)?;
    if previous.sequence.checked_add(1) != Some(next_sequence) {
        return Err("replayed, skipped, or overflowing source sequence".into());
    }
    let batch_bytes = ingest_operator_tsv(
        supplied_batch,
        independently_pinned_batch,
        &previous.source_id,
    )?;
    let batch = SemanticArchive::from_bytes(&batch_bytes)?;
    let (mut graph, mut flow_annotations, mut restriction_annotations) =
        if previous.sequence == 0 {
            (Graph::new(), Vec::new(), Vec::new())
        } else {
            let old = SemanticArchive::from_bytes(&previous.archive_bytes)?;
            (
                old.graph,
                old.snapshot.flows.iter().map(|f| f.annotation.clone()).collect(),
                old.snapshot.restrictions.iter().map(|r| r.annotation.clone()).collect(),
            )
        };
    let existing = graph.snapshot().entities.into_iter()
        .map(|entity| (entity.id.clone(), entity))
        .collect::<std::collections::BTreeMap<_, _>>();
    for entity in batch.snapshot.problem.entities {
        match existing.get(&entity.id) {
            Some(previous_entity) if *previous_entity == entity => (),
            Some(_) => return Err("source batch attempts to redefine an existing entity".into()),
            None => graph.add_entity(entity)?,
        }
    }
    let mut evidence = flow_annotations.iter().map(|a: &crate::semantics::Annotation| a.evidence_id.clone())
        .chain(restriction_annotations.iter().map(|a: &crate::semantics::Annotation| a.evidence_id.clone()))
        .collect::<BTreeSet<_>>();
    for flow in batch.snapshot.flows {
        if !evidence.insert(flow.annotation.evidence_id.clone()) {
            return Err("source batch reuses historical evidence".into());
        }
        graph.add_flow(Flow {
            from_entity: flow.from_entity,
            to_entity: flow.to_entity,
            rate_of_transfer: flow.rate,
        })?;
        flow_annotations.push(flow.annotation);
    }
    for restriction in batch.snapshot.restrictions {
        if !evidence.insert(restriction.annotation.evidence_id.clone()) {
            return Err("source batch reuses historical evidence".into());
        }
        graph.add_restriction(Restriction {
            source_id: restriction.source_id,
            target_id: restriction.target_id,
            constraint_type: restriction.constraint_type,
            boundary_value: restriction.boundary,
        })?;
        restriction_annotations.push(restriction.annotation);
    }
    let snapshot = SemanticSnapshot::from_graph(&graph, flow_annotations, restriction_annotations)?;
    StreamState {
        source_id: previous.source_id,
        sequence: next_sequence,
        archive_bytes: SemanticArchive::new(graph, snapshot)?.to_bytes()?,
    }.to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source(rate: &str, id: &str, name: &str) -> Vec<u8> {
        format!("LEIBNIZ_SOURCE_V1\tapproved\nENTITY\tsource\tOrganization\nENTITY\t{name}\tChannel\nFLOW\tsource\t{name}\t{rate}\tcontacts/s\tcontacts:1,time:-1\t1\t100\t200\t{id}\n").into_bytes()
    }
    fn begin() -> Vec<u8> {
        StreamState::initial("approved").unwrap().to_bytes().unwrap()
    }
    fn advance(previous: &[u8], input: &[u8], sequence: u64) -> Result<Vec<u8>, String> {
        append_authorized_batch(previous, previous, input, input, sequence)
    }

    #[test]
    fn two_separate_authorized_batches_preserve_records_and_source_ids() {
        let first = advance(&begin(), &source("2.5", "left-1", "left"), 1).unwrap();
        let second = advance(&first, &source("7.25", "right-2", "right"), 2).unwrap();
        let state = StreamState::from_bytes(&second).unwrap();
        let archive = SemanticArchive::from_bytes(state.archive_bytes().unwrap()).unwrap();
        assert_eq!(state.sequence(), 2);
        assert_eq!(archive.snapshot.flows.len(), 2);
        assert_eq!(archive.snapshot.flows[0].rate, 2.5);
        assert_eq!(archive.snapshot.flows[1].rate, 7.25);
        assert_eq!(archive.snapshot.flows[0].annotation.evidence_id, "approved/left-1");
        assert_eq!(archive.snapshot.flows[1].annotation.evidence_id, "approved/right-2");
        assert_eq!(state.to_bytes().unwrap(), second);
    }

    #[test]
    fn replay_skip_and_overflow_are_refused() {
        let first = advance(&begin(), &source("2.5", "left-1", "left"), 1).unwrap();
        let incoming = source("7.25", "right-2", "right");
        assert!(advance(&first, &incoming, 1).is_err());
        assert!(advance(&first, &incoming, 3).is_err());
        assert!(advance(&first, &incoming, 0).is_err());
    }

    #[test]
    fn changed_prior_state_or_batch_cannot_reuse_independent_pins() {
        let initial = begin();
        let first = advance(&initial, &source("2.5", "left-1", "left"), 1).unwrap();
        let changed = source("99", "right-2", "right");
        let pinned = source("7.25", "right-2", "right");
        assert!(append_authorized_batch(&first, &initial, &pinned, &pinned, 2).is_err());
        assert!(append_authorized_batch(&first, &first, &changed, &pinned, 2).is_err());
    }

    #[test]
    fn reused_historical_evidence_and_redefined_entity_fail_closed() {
        let first = advance(&begin(), &source("2.5", "left-1", "left"), 1).unwrap();
        assert!(advance(&first, &source("7.25", "left-1", "right"), 2).is_err());
        let malformed = String::from_utf8(source("7.25", "right-2", "right"))
            .unwrap().replace("ENTITY\tsource\tOrganization", "ENTITY\tsource\tImpostor");
        assert!(advance(&first, malformed.as_bytes(), 2).is_err());
    }

    #[test]
    fn corrupted_noncanonical_and_cross_source_checkpoint_fail_closed() {
        let first = advance(&begin(), &source("2.5", "left-1", "left"), 1).unwrap();
        let mut corrupted = first.clone();
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(StreamState::from_bytes(&corrupted).is_err());
        let foreign = String::from_utf8(first).unwrap_err();
        let bytes = foreign.into_bytes();
        let header_end = bytes.iter().position(|b| *b == b'\n').unwrap();
        let mut forged = b"LEIBNIZ_STREAM_V1\tforeign\t1\t".to_vec();
        forged.extend_from_slice(bytes[..header_end].split(|b| *b == b'\t').last().unwrap());
        forged.push(b'\n');
        forged.extend_from_slice(&bytes[header_end + 1..]);
        assert!(StreamState::from_bytes(&forged).is_err());
        assert!(StreamState::from_bytes(b"LEIBNIZ_STREAM_V1\tapproved\t01\t0\n").is_err());
    }
}
