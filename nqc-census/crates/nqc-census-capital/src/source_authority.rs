//! Authority for capital sources discovered natively by RMC-011.
//!
//! Upstream RMC-008 consumption receipts bind only the exact source set derived
//! from authenticated RMC-008 bytes. Permissionless/external families acquired
//! by RMC-011 require a separate authority so they cannot be smuggled into that
//! receipt or admitted merely because they reference some already-admitted
//! upstream artifact.

use crate::{
    validate_settlement_requirements, CapitalCensusCommitment, CapitalCensusLedger,
    CapitalCensusSummary, CapitalCertificationContext, CapitalError, CapitalEvidenceRef,
    CapitalFeasibility, CapitalLedgerMode, CapitalSource, UpstreamCensusStage,
    UpstreamConsumptionReceipt,
};
use nqc_census_core::{Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

const SOURCE_SET_DOMAIN: &[u8] = b"NQC-RMC011-NATIVE-SOURCE-SET-V1";
const AUTHORITY_DOMAIN: &[u8] = b"NQC-RMC011-NATIVE-SOURCE-AUTHORITY-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct D11ExpandedCapitalCensusCertificate {
    pub capital_commitment: CapitalCensusCommitment,
    pub upstream_authority_commitment: Hash32,
    pub d11_source_authority_commitment: Hash32,
    pub d08_source_count: usize,
    pub d11_native_source_count: usize,
    pub summary: CapitalCensusSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct D11SourceAuthority {
    observation_anchor: StateAnchor,
    reconciliation_artifact_sha256: Hash32,
    evidence: BTreeSet<CapitalEvidenceRef>,
    source_count: u64,
    source_set_commitment: Hash32,
    commitment: Hash32,
}

impl D11SourceAuthority {
    /// Build authority directly from the exact reconciled artifact bytes and
    /// the canonical source records decoded/derived from those bytes.
    pub fn from_reconciliation_artifact(
        observation_anchor: StateAnchor,
        artifact_bytes: &[u8],
        sources: &[CapitalSource],
    ) -> Result<Self, CapitalError> {
        if artifact_bytes.is_empty() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "D11 native source reconciliation artifact is empty",
            ));
        }
        if sources.is_empty() {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "D11 native source authority cannot bind an empty source set",
            ));
        }
        if sources
            .iter()
            .any(|source| source.anchor() != &observation_anchor)
        {
            return Err(CapitalError::AnchorMismatch);
        }

        let reconciliation_artifact_sha256 = nonzero_sha256(artifact_bytes)?;
        let evidence = sources
            .iter()
            .flat_map(|source| source.evidence().iter().copied())
            .collect::<BTreeSet<_>>();
        if evidence.is_empty() {
            return Err(CapitalError::MissingEvidence);
        }
        if sources.iter().any(|source| {
            source.evidence().is_empty()
                || source
                    .evidence()
                    .iter()
                    .any(|reference| !evidence.contains(reference))
        }) {
            return Err(CapitalError::UnresolvedEvidenceRef);
        }

        let (source_count, source_set_commitment) = source_set_commitment(sources)?;
        let commitment = authority_commitment(
            &observation_anchor,
            reconciliation_artifact_sha256,
            &evidence,
            source_count,
            source_set_commitment,
        )?;

        Ok(Self {
            observation_anchor,
            reconciliation_artifact_sha256,
            evidence,
            source_count,
            source_set_commitment,
            commitment,
        })
    }

    pub fn verify(
        &self,
        artifact_bytes: &[u8],
        sources: &[CapitalSource],
    ) -> Result<(), CapitalError> {
        if nonzero_sha256(artifact_bytes)? != self.reconciliation_artifact_sha256 {
            return Err(CapitalError::CanonicalDigestMismatch);
        }
        let rebuilt = Self::from_reconciliation_artifact(
            self.observation_anchor.clone(),
            artifact_bytes,
            sources,
        )?;
        if rebuilt != *self {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "D11 native source authority differs from reconstructed authority",
            ));
        }
        Ok(())
    }

    pub const fn observation_anchor(&self) -> &StateAnchor {
        &self.observation_anchor
    }

    pub const fn reconciliation_artifact_sha256(&self) -> Hash32 {
        self.reconciliation_artifact_sha256
    }

    pub fn evidence(&self) -> impl Iterator<Item = &CapitalEvidenceRef> {
        self.evidence.iter()
    }

    pub fn admits_evidence(&self, reference: &CapitalEvidenceRef) -> bool {
        self.evidence.contains(reference)
    }

    pub const fn source_count(&self) -> u64 {
        self.source_count
    }

    pub const fn source_set_commitment(&self) -> Hash32 {
        self.source_set_commitment
    }

    pub const fn commitment(&self) -> Hash32 {
        self.commitment
    }

    pub fn verify_source_set<'a>(
        &self,
        sources: impl IntoIterator<Item = &'a CapitalSource>,
    ) -> Result<(), CapitalError> {
        let sources = sources.into_iter().collect::<Vec<_>>();
        if sources
            .iter()
            .any(|source| source.anchor() != &self.observation_anchor)
        {
            return Err(CapitalError::AnchorMismatch);
        }
        if sources.iter().any(|source| {
            source.evidence().is_empty()
                || source
                    .evidence()
                    .iter()
                    .any(|reference| !self.evidence.contains(reference))
        }) {
            return Err(CapitalError::UnresolvedEvidenceRef);
        }
        let (count, commitment) = source_set_commitment_refs(&sources)?;
        if count != self.source_count || commitment != self.source_set_commitment {
            return Err(CapitalError::InvalidUpstreamAuthority(
                "D11 native source set differs from admitted source authority",
            ));
        }
        Ok(())
    }
}

fn source_set_commitment(sources: &[CapitalSource]) -> Result<(u64, Hash32), CapitalError> {
    source_set_commitment_refs(&sources.iter().collect::<Vec<_>>())
}

fn source_set_commitment_refs(
    sources: &[&CapitalSource],
) -> Result<(u64, Hash32), CapitalError> {
    let mut ids = sources
        .iter()
        .map(|source| *source.id().as_bytes())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    if ids.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "D11 native source set contains duplicate source identifiers",
        ));
    }
    let count = u64::try_from(ids.len()).map_err(|_| {
        CapitalError::InvalidUpstreamAuthority("D11 native source count exceeds u64")
    })?;
    let mut hasher = Sha256::new();
    hasher.update(SOURCE_SET_DOMAIN);
    hasher.update([0]);
    hasher.update(count.to_be_bytes());
    for id in ids {
        hasher.update(id);
    }
    let digest: [u8; 32] = hasher.finalize().into();
    Ok((
        count,
        Hash32::new(digest).map_err(|_| {
            CapitalError::InvalidUpstreamAuthority("zero D11 native source set commitment")
        })?,
    ))
}

fn authority_commitment(
    anchor: &StateAnchor,
    artifact_sha256: Hash32,
    evidence: &BTreeSet<CapitalEvidenceRef>,
    source_count: u64,
    source_set_commitment: Hash32,
) -> Result<Hash32, CapitalError> {
    let mut hasher = Sha256::new();
    hasher.update(AUTHORITY_DOMAIN);
    hasher.update([0]);
    encode_anchor(anchor, &mut hasher);
    hasher.update(artifact_sha256.as_bytes());
    hasher.update(
        u64::try_from(evidence.len())
            .map_err(|_| {
                CapitalError::InvalidUpstreamAuthority(
                    "D11 native source evidence count exceeds u64",
                )
            })?
            .to_be_bytes(),
    );
    for reference in evidence {
        encode_evidence(*reference, &mut hasher)?;
    }
    hasher.update(source_count.to_be_bytes());
    hasher.update(source_set_commitment.as_bytes());
    let digest: [u8; 32] = hasher.finalize().into();
    Hash32::new(digest).map_err(|_| {
        CapitalError::InvalidUpstreamAuthority("zero D11 native source authority commitment")
    })
}

fn encode_anchor(anchor: &StateAnchor, hasher: &mut Sha256) {
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
}

fn encode_evidence(
    reference: CapitalEvidenceRef,
    hasher: &mut Sha256,
) -> Result<(), CapitalError> {
    match reference {
        CapitalEvidenceRef::Observation(digest) => {
            if digest == [0; 32] {
                return Err(CapitalError::InvalidCanonical(
                    "zero observation evidence digest",
                ));
            }
            hasher.update([1]);
            hasher.update(digest);
        }
        CapitalEvidenceRef::Artifact(hash) => {
            hasher.update([2]);
            hasher.update(hash.as_bytes());
        }
    }
    Ok(())
}

fn nonzero_sha256(bytes: &[u8]) -> Result<Hash32, CapitalError> {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Hash32::new(digest)
        .map_err(|_| CapitalError::InvalidUpstreamAuthority("zero SHA-256 digest"))
}


pub fn certify_with_d11_sources(
    ledger: &CapitalCensusLedger,
    upstream: &CapitalCertificationContext,
    d11_sources: &D11SourceAuthority,
) -> Result<D11ExpandedCapitalCensusCertificate, CapitalError> {
    if ledger.mode() != CapitalLedgerMode::Evidentiary {
        return Err(CapitalError::NonEvidentiaryLedger);
    }
    if d11_sources.observation_anchor() != upstream.observation_anchor() {
        return Err(CapitalError::AnchorMismatch);
    }

    let d08_receipt = upstream
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "RMC-008 consumption receipt missing",
        ))?;
    let d09_receipt = upstream
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "RMC-009 consumption receipt missing",
        ))?;

    let d08_marker = CapitalEvidenceRef::Artifact(d08_receipt.authority_artifact_sha256());
    let mut d08_source_refs = Vec::new();
    let mut native_source_refs = Vec::new();

    for source in ledger.sources() {
        if source.anchor() != upstream.observation_anchor() {
            return Err(CapitalError::AnchorMismatch);
        }
        if source.evidence().contains(&d08_marker) {
            if source
                .evidence()
                .iter()
                .any(|reference| !upstream.admits_evidence(reference))
            {
                return Err(CapitalError::UnresolvedEvidenceRef);
            }
            d08_source_refs.push(source);
        } else {
            if source
                .evidence()
                .iter()
                .any(|reference| !d11_sources.admits_evidence(reference))
            {
                return Err(CapitalError::UnresolvedEvidenceRef);
            }
            native_source_refs.push(source);
        }
    }

    let rebuilt_d08 = UpstreamConsumptionReceipt::for_sources(
        d08_receipt.authority_artifact_sha256(),
        d08_receipt.coverage_commitment(),
        d08_source_refs.iter().copied(),
    )?;
    if rebuilt_d08 != d08_receipt {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "D08 source subset differs from committed RMC-008 receipt",
        ));
    }

    d11_sources.verify_source_set(native_source_refs.iter().copied())?;

    let requirements = ledger.requirements().collect::<Vec<_>>();
    if requirements.iter().any(|requirement| {
        requirement.anchor() != upstream.observation_anchor()
            || requirement
                .evidence()
                .iter()
                .any(|reference| !upstream.admits_evidence(reference))
    }) {
        return Err(CapitalError::UnresolvedEvidenceRef);
    }
    let rebuilt_d09 = UpstreamConsumptionReceipt::for_requirements(
        d09_receipt.authority_artifact_sha256(),
        d09_receipt.coverage_commitment(),
        requirements.iter().copied(),
    )?;
    if rebuilt_d09 != d09_receipt {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "capital requirement ledger differs from committed RMC-009 receipt",
        ));
    }

    let all_sources = ledger.sources().cloned().collect::<Vec<_>>();
    let requirement_by_id = ledger
        .requirements()
        .map(|requirement| (requirement.id(), requirement))
        .collect::<std::collections::BTreeMap<_, _>>();
    for result in ledger.results() {
        if let CapitalFeasibility::Feasible { requirement_id, .. } = result {
            let requirement = requirement_by_id
                .get(requirement_id)
                .copied()
                .ok_or(CapitalError::InvalidCanonical(
                    "feasible result references missing requirement",
                ))?;
            validate_settlement_requirements(requirement, result, &all_sources)?;
        }
    }

    let summary = ledger.summary()?;
    if summary.source_count == 0 {
        return Err(CapitalError::EmptyCapitalCensus);
    }
    let capital_commitment = ledger.commitment()?;

    Ok(D11ExpandedCapitalCensusCertificate {
        capital_commitment,
        upstream_authority_commitment: upstream.commitment(),
        d11_source_authority_commitment: d11_sources.commitment(),
        d08_source_count: d08_source_refs.len(),
        d11_native_source_count: native_source_refs.len(),
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissionless_atomic::{
        admit_balancer_v2_dual_provider, BalancerV2AuthenticatedObservation,
    };
    use crate::Amount256;
    use nqc_census_core::{Address, ChainDomain};

    fn hash(byte: u8) -> Hash32 {
        Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
    }

    fn address(value: &str) -> Address {
        Address::parse_hex(value).unwrap_or_else(|_| unreachable!())
    }

    fn anchor(block: u64) -> StateAnchor {
        StateAnchor::new(
            ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!()),
            block,
            hash(3),
            hash(4),
            1_700_000_000,
            hash(5),
        )
        .unwrap_or_else(|_| unreachable!())
    }

    fn source(block: u64, asset: &str) -> CapitalSource {
        let observation = BalancerV2AuthenticatedObservation {
            anchor: anchor(block),
            vault: address("0xba12222222228d8ba445958a75a0704d566bf2c8"),
            asset: address(asset),
            available_vault_balance: Amount256::from_u128(1_000_000),
            fee_percentage_1e18: 500_000_000_000_000,
            paused: false,
        };
        admit_balancer_v2_dual_provider(
            &observation,
            &observation,
            &hash(6),
            &hash(7),
        )
        .unwrap_or_else(|_| unreachable!())
    }

    #[test]
    fn authority_binds_artifact_evidence_and_exact_source_set() {
        let first = source(25_437_474, "0x1111111111111111111111111111111111111111");
        let second = source(25_437_474, "0x2222222222222222222222222222222222222222");
        let sources = vec![first, second];
        let artifact = b"exact-reconciled-balancer-artifact";
        let authority = D11SourceAuthority::from_reconciliation_artifact(
            anchor(25_437_474),
            artifact,
            &sources,
        )
        .unwrap_or_else(|_| unreachable!());

        assert_eq!(authority.source_count(), 2);
        assert_eq!(authority.evidence().count(), 2);
        assert!(authority.verify(artifact, &sources).is_ok());
        assert!(authority.verify_source_set(sources.iter()).is_ok());
        assert_ne!(authority.commitment().as_bytes(), &[0; 32]);
    }

    #[test]
    fn authority_rejects_artifact_mutation() {
        let sources = vec![source(
            25_437_474,
            "0x1111111111111111111111111111111111111111",
        )];
        let authority = D11SourceAuthority::from_reconciliation_artifact(
            anchor(25_437_474),
            b"artifact-a",
            &sources,
        )
        .unwrap_or_else(|_| unreachable!());
        assert!(authority.verify(b"artifact-b", &sources).is_err());
    }

    #[test]
    fn authority_rejects_source_set_mutation() {
        let first = source(25_437_474, "0x1111111111111111111111111111111111111111");
        let second = source(25_437_474, "0x2222222222222222222222222222222222222222");
        let sources = vec![first.clone()];
        let authority = D11SourceAuthority::from_reconciliation_artifact(
            anchor(25_437_474),
            b"artifact",
            &sources,
        )
        .unwrap_or_else(|_| unreachable!());
        assert!(authority.verify_source_set([&first, &second]).is_err());
    }

    #[test]
    fn authority_rejects_anchor_mismatch() {
        let sources = vec![source(
            25_437_475,
            "0x1111111111111111111111111111111111111111",
        )];
        assert!(D11SourceAuthority::from_reconciliation_artifact(
            anchor(25_437_474),
            b"artifact",
            &sources,
        )
        .is_err());
    }

    #[test]
    fn authority_rejects_duplicate_source_ids() {
        let first = source(25_437_474, "0x1111111111111111111111111111111111111111");
        let sources = vec![first.clone(), first];
        assert!(D11SourceAuthority::from_reconciliation_artifact(
            anchor(25_437_474),
            b"artifact",
            &sources,
        )
        .is_err());
    }
}
