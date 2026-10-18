use crate::canonical::{self, Encoder, Kind, CHECKPOINT_DOMAIN, HEAD_SEAL_DOMAIN};
use crate::error::StoreError;
use crate::object::ArtifactId;
use crate::scope::{ScopeId, StreamScope};
use nqc_census_core::{Hash32, StateAnchor};

/// Bound on evidence references per checkpoint (2 MiB of ids). A range needing
/// more can reference an index artifact that lists further artifacts.
pub const MAX_EVIDENCE_PER_CHECKPOINT: usize = 65_536;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CheckpointId(pub(crate) [u8; 32]);

impl CheckpointId {
    pub fn parse_hex(text: &str) -> Result<Self, StoreError> {
        canonical::parse_hex32(text)
            .map(Self)
            .ok_or(StoreError::malformed(
                "checkpoint id",
                "expected 64 lowercase hex",
            ))
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        canonical::hex(&self.0)
    }
}

/// One append-only link of a range stream.
///
/// It binds its scope, a zero-based sequence, the predecessor's identity (absent
/// only at sequence 0), full RMC-003 state anchors for the first and last block
/// of its inclusive range, and the canonical (sorted, unique) set of evidence
/// artifacts. Its identity is the domain-separated digest of those bytes, so the
/// newest checkpoint commits to the whole chain and all evidence behind it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checkpoint {
    scope_id: ScopeId,
    sequence: u64,
    predecessor: Option<CheckpointId>,
    first: StateAnchor,
    last: StateAnchor,
    evidence: Vec<ArtifactId>,
}

impl Checkpoint {
    pub fn new(
        scope: &StreamScope,
        sequence: u64,
        predecessor: Option<CheckpointId>,
        first: StateAnchor,
        last: StateAnchor,
        mut evidence: Vec<ArtifactId>,
    ) -> Result<Self, StoreError> {
        if first.chain() != scope.chain() || last.chain() != scope.chain() {
            return Err(StoreError::ScopeMismatch);
        }
        if (sequence == 0) != predecessor.is_none() {
            return Err(StoreError::InvalidCheckpoint(
                "predecessor must be absent exactly at sequence 0",
            ));
        }
        if sequence == 0
            && (first.block_number() != scope.origin_block()
                || first.parent_hash() != scope.origin_parent_hash())
        {
            return Err(StoreError::InvalidCheckpoint(
                "sequence 0 must begin at the scope origin block and parent",
            ));
        }
        if first.block_number() < scope.origin_block() {
            return Err(StoreError::InvalidCheckpoint("range precedes scope origin"));
        }
        validate_range(&first, &last)?;
        evidence.sort_unstable();
        evidence.dedup();
        if evidence.is_empty() {
            return Err(StoreError::InvalidCheckpoint(
                "a checkpoint must reference evidence",
            ));
        }
        if evidence.len() > MAX_EVIDENCE_PER_CHECKPOINT {
            return Err(StoreError::InvalidCheckpoint(
                "too many evidence references",
            ));
        }
        Ok(Self {
            scope_id: scope.id()?,
            sequence,
            predecessor,
            first,
            last,
            evidence,
        })
    }

    /// Builds the checkpoint that extends `resume` exactly.
    pub fn next(
        scope: &StreamScope,
        resume: &ResumePoint,
        first: StateAnchor,
        last: StateAnchor,
        evidence: Vec<ArtifactId>,
    ) -> Result<Self, StoreError> {
        if resume.scope_id != scope.id()? {
            return Err(StoreError::ScopeMismatch);
        }
        Self::new(
            scope,
            resume.next_sequence,
            resume.predecessor,
            first,
            last,
            evidence,
        )
    }

    pub const fn scope_id(&self) -> ScopeId {
        self.scope_id
    }

    pub const fn sequence(&self) -> u64 {
        self.sequence
    }

    pub const fn predecessor(&self) -> Option<CheckpointId> {
        self.predecessor
    }

    pub const fn first(&self) -> &StateAnchor {
        &self.first
    }

    pub const fn last(&self) -> &StateAnchor {
        &self.last
    }

    pub fn evidence(&self) -> &[ArtifactId] {
        &self.evidence
    }

    pub const fn first_block(&self) -> u64 {
        self.first.block_number()
    }

    pub const fn last_block(&self) -> u64 {
        self.last.block_number()
    }

    pub fn canonical_bytes(&self) -> Result<Vec<u8>, StoreError> {
        let mut evidence = Vec::with_capacity(self.evidence.len() * 32);
        for id in &self.evidence {
            evidence.extend_from_slice(id.as_bytes());
        }
        let mut encoder = Encoder::new(Kind::Checkpoint)
            .bytes(1, self.scope_id.as_bytes())?
            .u64(2, self.sequence)?;
        if let Some(predecessor) = &self.predecessor {
            encoder = encoder.bytes(3, predecessor.as_bytes())?;
        }
        Ok(encoder
            .bytes(4, &encode_anchor(&self.first)?)?
            .bytes(5, &encode_anchor(&self.last)?)?
            .bytes(6, &evidence)?
            .finish())
    }

    pub fn id(&self) -> Result<CheckpointId, StoreError> {
        Ok(CheckpointId(canonical::domain_digest(
            CHECKPOINT_DOMAIN,
            &self.canonical_bytes()?,
        )))
    }

    /// Strict decode against the scope the catalog directory belongs to. Every
    /// construction invariant is re-checked and the bytes must be canonical.
    pub fn decode(bytes: &[u8], scope: &StreamScope) -> Result<Self, StoreError> {
        let object = Kind::Checkpoint.name();
        let fields = canonical::parse(
            bytes,
            Kind::Checkpoint,
            &[&[1, 2, 4, 5, 6], &[1, 2, 3, 4, 5, 6]],
        )?;
        if ScopeId(fields.fixed::<32>(1)?) != scope.id()? {
            return Err(StoreError::ScopeMismatch);
        }
        let predecessor = if fields.has(3) {
            Some(CheckpointId(fields.fixed::<32>(3)?))
        } else {
            None
        };
        let raw_evidence = fields.bytes(6)?;
        if raw_evidence.len() % 32 != 0 {
            return Err(StoreError::malformed(object, "evidence table length"));
        }
        if raw_evidence.len() / 32 > MAX_EVIDENCE_PER_CHECKPOINT {
            return Err(StoreError::InvalidCheckpoint(
                "too many evidence references",
            ));
        }
        let mut evidence = Vec::with_capacity(raw_evidence.len() / 32);
        let (rows, _) = raw_evidence.as_chunks::<32>();
        for row in rows {
            evidence.push(ArtifactId::from_bytes(*row));
        }
        let checkpoint = Self::new(
            scope,
            fields.u64(2)?,
            predecessor,
            decode_anchor(fields.bytes(4)?, scope)?,
            decode_anchor(fields.bytes(5)?, scope)?,
            evidence,
        )?;
        if checkpoint.canonical_bytes()? != bytes {
            return Err(StoreError::NonCanonical { object });
        }
        Ok(checkpoint)
    }

    /// Proves that `next` extends `self` exactly: sequence + 1, named
    /// predecessor, first block = last block + 1, first parent hash = last block
    /// hash, and non-decreasing timestamp.
    pub fn check_successor(&self, next: &Self) -> Result<(), StoreError> {
        let sequence = next.sequence;
        if next.scope_id != self.scope_id {
            return Err(StoreError::ScopeMismatch);
        }
        if self.sequence.checked_add(1) != Some(sequence) {
            return Err(StoreError::Discontinuity {
                sequence,
                reason: "sequence does not follow predecessor",
            });
        }
        if next.predecessor != Some(self.id()?) {
            return Err(StoreError::PredecessorMismatch { sequence });
        }
        match self.last_block().checked_add(1) {
            Some(expected) if next.first_block() == expected => {}
            Some(expected) if next.first_block() < expected => {
                return Err(StoreError::Discontinuity {
                    sequence,
                    reason: "range overlaps predecessor",
                })
            }
            _ => {
                return Err(StoreError::Discontinuity {
                    sequence,
                    reason: "range leaves a gap after predecessor",
                })
            }
        }
        if next.first.parent_hash() != self.last.block_hash() {
            return Err(StoreError::Discontinuity {
                sequence,
                reason: "first parent hash does not extend predecessor last block",
            });
        }
        if next.first.timestamp() < self.last.timestamp() {
            return Err(StoreError::Discontinuity {
                sequence,
                reason: "timestamp regresses across checkpoints",
            });
        }
        Ok(())
    }
}

fn validate_range(first: &StateAnchor, last: &StateAnchor) -> Result<(), StoreError> {
    if first.block_number() > last.block_number() {
        return Err(StoreError::InvalidCheckpoint("inverted block range"));
    }
    if last.block_number() == u64::MAX {
        return Err(StoreError::InvalidCheckpoint(
            "range end leaves no successor",
        ));
    }
    if first.block_number() == last.block_number() && first != last {
        return Err(StoreError::InvalidCheckpoint(
            "single-block range with contradictory anchors",
        ));
    }
    if last.block_number() == first.block_number().saturating_add(1)
        && last.parent_hash() != first.block_hash()
    {
        return Err(StoreError::InvalidCheckpoint(
            "adjacent anchors do not link parent to child",
        ));
    }
    if first.timestamp() > last.timestamp() {
        return Err(StoreError::InvalidCheckpoint(
            "timestamp regresses within range",
        ));
    }
    Ok(())
}

/// Encodes an RMC-003 `StateAnchor` without its chain domain; the chain is bound
/// once through the scope and re-imposed when decoding.
fn encode_anchor(anchor: &StateAnchor) -> Result<Vec<u8>, StoreError> {
    Ok(Encoder::new(Kind::Anchor)
        .u64(1, anchor.block_number())?
        .bytes(2, anchor.block_hash().as_bytes())?
        .bytes(3, anchor.parent_hash().as_bytes())?
        .u64(4, anchor.timestamp())?
        .bytes(5, anchor.state_root().as_bytes())?
        .finish())
}

fn decode_anchor(bytes: &[u8], scope: &StreamScope) -> Result<StateAnchor, StoreError> {
    let fields = canonical::parse(bytes, Kind::Anchor, &[&[1, 2, 3, 4, 5]])?;
    Ok(StateAnchor::new(
        scope.chain().clone(),
        fields.u64(1)?,
        Hash32::new(fields.fixed::<32>(2)?)?,
        Hash32::new(fields.fixed::<32>(3)?)?,
        fields.u64(4)?,
        Hash32::new(fields.fixed::<32>(5)?)?,
    )?)
}

/// Where the next checkpoint of a stream must begin, derived from the
/// authoritative catalog (never from the HEAD cache alone).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumePoint {
    pub scope_id: ScopeId,
    pub next_sequence: u64,
    pub predecessor: Option<CheckpointId>,
    pub next_first_block: u64,
    pub expected_parent_hash: Hash32,
    pub min_timestamp: u64,
    /// Last durable block, `None` when the stream has no checkpoint yet.
    pub durable_through: Option<u64>,
}

impl ResumePoint {
    pub(crate) fn genesis(scope: &StreamScope) -> Result<Self, StoreError> {
        Ok(Self {
            scope_id: scope.id()?,
            next_sequence: 0,
            predecessor: None,
            next_first_block: scope.origin_block(),
            expected_parent_hash: scope.origin_parent_hash(),
            min_timestamp: 0,
            durable_through: None,
        })
    }

    pub(crate) fn after(tip: &Checkpoint) -> Result<Self, StoreError> {
        let next_sequence = tip
            .sequence
            .checked_add(1)
            .ok_or(StoreError::InvalidCheckpoint("sequence space exhausted"))?;
        let next_first_block = tip
            .last_block()
            .checked_add(1)
            .ok_or(StoreError::InvalidCheckpoint("block space exhausted"))?;
        Ok(Self {
            scope_id: tip.scope_id,
            next_sequence,
            predecessor: Some(tip.id()?),
            next_first_block,
            expected_parent_hash: tip.last.block_hash(),
            min_timestamp: tip.last.timestamp(),
            durable_through: Some(tip.last_block()),
        })
    }
}

/// The non-authoritative acceleration pointer to a stream tip.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct HeadRecord {
    pub(crate) scope_id: ScopeId,
    pub(crate) sequence: u64,
    pub(crate) checkpoint_id: CheckpointId,
}

impl HeadRecord {
    pub(crate) fn encode(&self) -> Result<Vec<u8>, StoreError> {
        let seal = canonical::domain_digest(HEAD_SEAL_DOMAIN, &self.unsealed()?);
        Ok(Encoder::new(Kind::Head)
            .bytes(1, self.scope_id.as_bytes())?
            .u64(2, self.sequence)?
            .bytes(3, self.checkpoint_id.as_bytes())?
            .bytes(4, &seal)?
            .finish())
    }

    fn unsealed(&self) -> Result<Vec<u8>, StoreError> {
        Ok(Encoder::new(Kind::Head)
            .bytes(1, self.scope_id.as_bytes())?
            .u64(2, self.sequence)?
            .bytes(3, self.checkpoint_id.as_bytes())?
            .finish())
    }

    /// Any structural or seal failure is reported as `HeadCorrupt`, which callers
    /// may repair; a well-sealed record is returned for comparison against the
    /// authoritative catalog.
    pub(crate) fn decode(bytes: &[u8]) -> Result<Self, StoreError> {
        let parsed = (|| {
            let fields = canonical::parse(bytes, Kind::Head, &[&[1, 2, 3, 4]])?;
            let record = Self {
                scope_id: ScopeId(fields.fixed::<32>(1)?),
                sequence: fields.u64(2)?,
                checkpoint_id: CheckpointId(fields.fixed::<32>(3)?),
            };
            let seal = fields.fixed::<32>(4)?;
            Ok::<_, StoreError>((record, seal))
        })();
        let (record, seal) = parsed.map_err(|_| StoreError::HeadCorrupt)?;
        if canonical::domain_digest(HEAD_SEAL_DOMAIN, &record.unsealed()?) != seal
            || record.encode()? != bytes
        {
            return Err(StoreError::HeadCorrupt);
        }
        Ok(record)
    }
}
