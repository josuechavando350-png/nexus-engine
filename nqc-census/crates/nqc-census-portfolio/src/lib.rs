//! RMC-012 portfolio-wide capacity and conflict accounting.
//!
//! RMC-011 proves each requirement independently.  This crate removes the
//! dangerous next source of overstatement: treating individually feasible
//! candidates as simultaneously executable when they share capital, borrower,
//! market, DEX liquidity, oracle, builder or other scarce resources.
//!
//! The engine is deliberately value-agnostic.  It proves whether an explicit
//! candidate set can coexist and emits deterministic conflict sets.  Economic
//! ranking belongs downstream once net-EV and capture evidence exist.

pub mod actionability;

use nqc_census_capital::{
    evaluate_capital_feasibility_checked, Amount256, CapitalAsset, CapitalEvidenceRef,
    CapitalFeasibility, CapitalOwnership, CapitalRequirement, CapitalRequirementId, CapitalSource,
    CapitalSourceId, CapitalSourceKeyId, FeasibilityRejection,
};
use nqc_census_core::{ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::{Display, Formatter},
};

const RESOURCE_KEY_DOMAIN: &[u8] = b"NQC-RMC012-SHARED-RESOURCE-KEY-V1";
const RESOURCE_ID_DOMAIN: &[u8] = b"NQC-RMC012-SHARED-RESOURCE-ID-V1";
const PORTFOLIO_COMMITMENT_DOMAIN: &[u8] = b"NQC-RMC012-PORTFOLIO-COMMITMENT-V3";
const PORTFOLIO_CANDIDATE_DOMAIN: &[u8] = b"NQC-RMC012-PORTFOLIO-CANDIDATE-V1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortfolioError {
    ZeroValue(&'static str),
    EmptyEvidence,
    DuplicateEvidence,
    DuplicateResourceKey,
    ConflictingResourceState,
    DuplicateResourceClaim,
    DuplicateCandidate,
    DuplicateRequirement,
    DuplicateFeasibility,
    DuplicateSourceId,
    ConflictingSourceState,
    MissingRequirement,
    CandidateAnchorMismatch,
    MissingFeasibility,
    CapitalFeasibilityEvaluationFailed,
    CapitalFeasibilityMismatch,
    MissingSource,
    MissingResource,
    ResourceAnchorMismatch,
    ExclusiveClaimMustBeOne,
    OperatorOwnedSource,
    AmountOverflow,
}

impl Display for PortfolioError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ZeroValue(name) => write!(f, "{name} must not be zero"),
            Self::EmptyEvidence => f.write_str("shared resource requires evidence"),
            Self::DuplicateEvidence => f.write_str("shared resource repeats evidence"),
            Self::DuplicateResourceKey => f.write_str("duplicate shared resource key"),
            Self::ConflictingResourceState => {
                f.write_str("same shared resource key has conflicting observed state")
            }
            Self::DuplicateResourceClaim => {
                f.write_str("candidate repeats a shared resource claim")
            }
            Self::DuplicateCandidate => f.write_str("portfolio repeats a candidate"),
            Self::DuplicateRequirement => f.write_str("portfolio repeats a capital requirement"),
            Self::DuplicateFeasibility => f.write_str("portfolio repeats a feasibility result"),
            Self::DuplicateSourceId => f.write_str("portfolio repeats a capital source id"),
            Self::ConflictingSourceState => {
                f.write_str("same capital source key has conflicting observed state")
            }
            Self::MissingRequirement => f.write_str("candidate references an unknown requirement"),
            Self::CandidateAnchorMismatch => {
                f.write_str("candidate anchor differs from its capital requirement")
            }
            Self::MissingFeasibility => f.write_str("candidate has no capital feasibility result"),
            Self::CapitalFeasibilityEvaluationFailed => {
                f.write_str("capital feasibility could not be independently recomputed")
            }
            Self::CapitalFeasibilityMismatch => {
                f.write_str("supplied capital feasibility differs from exact RMC-011 recomputation")
            }
            Self::MissingSource => f.write_str("allocation references an unknown capital source"),
            Self::MissingResource => f.write_str("candidate claims an undeclared shared resource"),
            Self::ResourceAnchorMismatch => {
                f.write_str("candidate and shared resource observation anchors differ")
            }
            Self::ExclusiveClaimMustBeOne => {
                f.write_str("exclusive shared resource claims must equal exactly one")
            }
            Self::OperatorOwnedSource => {
                f.write_str("portfolio cannot consume operator-owned capital")
            }
            Self::AmountOverflow => f.write_str("portfolio resource amount overflow"),
        }
    }
}

impl std::error::Error for PortfolioError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SharedResourceKind {
    BorrowerPosition,
    Market,
    DebtAsset,
    CollateralAsset,
    FlashPool,
    DexLiquidity,
    RouteLiquidity,
    OracleMovement,
    ProtocolCap,
    BlockSlot,
    BuilderSlot,
    NonceLane,
    PrivateRelaySlot,
    RpcQuota,
    BridgeLiquidity,
    Opportunity,
    Custom,
}

impl SharedResourceKind {
    const fn tag(self) -> u16 {
        match self {
            Self::BorrowerPosition => 1,
            Self::Market => 2,
            Self::DebtAsset => 3,
            Self::CollateralAsset => 4,
            Self::FlashPool => 5,
            Self::DexLiquidity => 6,
            Self::RouteLiquidity => 7,
            Self::OracleMovement => 8,
            Self::ProtocolCap => 9,
            Self::BlockSlot => 10,
            Self::BuilderSlot => 11,
            Self::NonceLane => 12,
            Self::PrivateRelaySlot => 13,
            Self::RpcQuota => 14,
            Self::BridgeLiquidity => 15,
            Self::Opportunity => 16,
            Self::Custom => 0xffff,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ResourceUnit {
    Count,
    GasUnits,
    AssetUnits(CapitalAsset),
    Custom(Hash32),
}

impl ResourceUnit {
    fn encode(self, out: &mut Vec<u8>) {
        match self {
            Self::Count => out.push(1),
            Self::GasUnits => out.push(2),
            Self::AssetUnits(asset) => {
                out.push(3);
                match asset {
                    CapitalAsset::NativeGas => out.push(1),
                    CapitalAsset::Token(address) => {
                        out.push(2);
                        out.extend_from_slice(address.as_bytes());
                    }
                }
            }
            Self::Custom(hash) => {
                out.push(4);
                out.extend_from_slice(hash.as_bytes());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceLimit {
    Exclusive,
    Capacity(Amount256),
}

impl ResourceLimit {
    pub fn capacity(self) -> Amount256 {
        match self {
            Self::Exclusive => Amount256::from_u128(1),
            Self::Capacity(amount) => amount,
        }
    }

    fn encode(self, out: &mut Vec<u8>) {
        match self {
            Self::Exclusive => out.push(1),
            Self::Capacity(amount) => {
                out.push(2);
                out.extend_from_slice(amount.as_be_bytes());
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SharedResourceKeyId([u8; 32]);

impl SharedResourceKeyId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SharedResourceId([u8; 32]);

impl SharedResourceId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharedResource {
    id: SharedResourceId,
    key_id: SharedResourceKeyId,
    anchor: StateAnchor,
    kind: SharedResourceKind,
    locator_hash: Hash32,
    unit: ResourceUnit,
    limit: ResourceLimit,
    evidence: Vec<CapitalEvidenceRef>,
}

impl SharedResource {
    pub fn new(
        anchor: StateAnchor,
        kind: SharedResourceKind,
        locator_hash: Hash32,
        unit: ResourceUnit,
        limit: ResourceLimit,
        mut evidence: Vec<CapitalEvidenceRef>,
    ) -> Result<Self, PortfolioError> {
        // Zero-capacity is a valid observed state: exhausted liquidity/cap is
        // materially different from an unobserved or undeclared resource.
        // Positive claims against it are preserved and become deterministic
        // over-subscription conflicts during portfolio evaluation.
        if evidence.is_empty() {
            return Err(PortfolioError::EmptyEvidence);
        }
        evidence.sort_unstable();
        if evidence.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(PortfolioError::DuplicateEvidence);
        }

        let key_bytes = resource_key_bytes(anchor.chain(), kind, locator_hash, unit);
        let key_id = SharedResourceKeyId(domain_hash(RESOURCE_KEY_DOMAIN, &key_bytes));
        let mut observed = key_bytes;
        encode_anchor(&anchor, &mut observed);
        limit.encode(&mut observed);
        encode_evidence(&evidence, &mut observed);
        let id = SharedResourceId(domain_hash(RESOURCE_ID_DOMAIN, &observed));
        Ok(Self {
            id,
            key_id,
            anchor,
            kind,
            locator_hash,
            unit,
            limit,
            evidence,
        })
    }

    pub const fn id(&self) -> SharedResourceId {
        self.id
    }

    pub const fn key_id(&self) -> SharedResourceKeyId {
        self.key_id
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub const fn kind(&self) -> SharedResourceKind {
        self.kind
    }

    pub const fn locator_hash(&self) -> Hash32 {
        self.locator_hash
    }

    pub const fn unit(&self) -> ResourceUnit {
        self.unit
    }

    pub const fn limit(&self) -> ResourceLimit {
        self.limit
    }

    pub fn evidence(&self) -> &[CapitalEvidenceRef] {
        &self.evidence
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct ResourceClaim {
    pub resource_key: SharedResourceKeyId,
    pub amount: Amount256,
}

impl ResourceClaim {
    pub fn new(
        resource_key: SharedResourceKeyId,
        amount: Amount256,
    ) -> Result<Self, PortfolioError> {
        if amount.is_zero() {
            return Err(PortfolioError::ZeroValue("resource_claim"));
        }
        Ok(Self {
            resource_key,
            amount,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PortfolioCandidateId([u8; 32]);

impl PortfolioCandidateId {
    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex_encode(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortfolioCandidate {
    id: PortfolioCandidateId,
    requirement_id: CapitalRequirementId,
    variant_hash: Option<Hash32>,
    anchor: StateAnchor,
    claims: Vec<ResourceClaim>,
}

impl PortfolioCandidate {
    /// Construct the canonical single execution variant for a capital
    /// requirement. Downstream route/venue alternatives must use
    /// `new_variant` so they retain distinct candidate identity while sharing
    /// the same independently certified capital requirement.
    pub fn new(
        requirement_id: CapitalRequirementId,
        anchor: StateAnchor,
        claims: Vec<ResourceClaim>,
    ) -> Result<Self, PortfolioError> {
        Self::build(requirement_id, None, anchor, claims)
    }

    /// Construct an explicitly distinct execution variant for one capital
    /// requirement. Variant identity is evidence-bound by the caller (for
    /// example route, venue, calldata or execution-plan commitment).
    pub fn new_variant(
        requirement_id: CapitalRequirementId,
        variant_hash: Hash32,
        anchor: StateAnchor,
        claims: Vec<ResourceClaim>,
    ) -> Result<Self, PortfolioError> {
        Self::build(requirement_id, Some(variant_hash), anchor, claims)
    }

    fn build(
        requirement_id: CapitalRequirementId,
        variant_hash: Option<Hash32>,
        anchor: StateAnchor,
        mut claims: Vec<ResourceClaim>,
    ) -> Result<Self, PortfolioError> {
        claims.sort_unstable();
        if claims
            .windows(2)
            .any(|pair| pair[0].resource_key == pair[1].resource_key)
        {
            return Err(PortfolioError::DuplicateResourceClaim);
        }
        let mut bytes = Vec::with_capacity(65);
        bytes.extend_from_slice(requirement_id.as_bytes());
        match variant_hash {
            Some(hash) => {
                bytes.push(1);
                bytes.extend_from_slice(hash.as_bytes());
            }
            None => bytes.push(0),
        }
        let id = PortfolioCandidateId(domain_hash(PORTFOLIO_CANDIDATE_DOMAIN, &bytes));
        Ok(Self {
            id,
            requirement_id,
            variant_hash,
            anchor,
            claims,
        })
    }

    pub const fn id(&self) -> PortfolioCandidateId {
        self.id
    }

    pub const fn requirement_id(&self) -> CapitalRequirementId {
        self.requirement_id
    }

    pub const fn variant_hash(&self) -> Option<Hash32> {
        self.variant_hash
    }

    pub const fn anchor(&self) -> &StateAnchor {
        &self.anchor
    }

    pub fn claims(&self) -> &[ResourceClaim] {
        &self.claims
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ConflictResource {
    /// Multiple execution variants of one certified capital requirement are
    /// alternatives, never additive capacity. This implicit unit-capacity
    /// resource makes that exclusivity fail-closed even when a caller forgets
    /// to declare an explicit Opportunity shared resource.
    Requirement(CapitalRequirementId),
    CapitalSource(CapitalSourceKeyId),
    Shared(SharedResourceKeyId),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortfolioConflict {
    pub resource: ConflictResource,
    pub capacity: Amount256,
    pub claimed: Amount256,
    pub claimants: Vec<PortfolioCandidateId>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapitalBlockedCandidate {
    pub candidate_id: PortfolioCandidateId,
    pub requirement_id: CapitalRequirementId,
    pub reason: FeasibilityRejection,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortfolioComponent {
    pub candidates: Vec<PortfolioCandidateId>,
    pub resources: Vec<ConflictResource>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortfolioReport {
    candidate_count: usize,
    capital_feasible_count: usize,
    capital_rejected: Vec<CapitalBlockedCandidate>,
    conflicts: Vec<PortfolioConflict>,
    components: Vec<PortfolioComponent>,
    commitment: [u8; 32],
}

impl PortfolioReport {
    pub const fn candidate_count(&self) -> usize {
        self.candidate_count
    }

    pub const fn capital_feasible_count(&self) -> usize {
        self.capital_feasible_count
    }

    pub fn capital_rejected(&self) -> &[CapitalBlockedCandidate] {
        &self.capital_rejected
    }

    pub fn conflicts(&self) -> &[PortfolioConflict] {
        &self.conflicts
    }

    /// Independent contention components. Candidates in different components
    /// share no declared capital source or shared resource, so a downstream
    /// optimizer may solve the components independently without losing an
    /// exact cross-component constraint.
    pub fn components(&self) -> &[PortfolioComponent] {
        &self.components
    }

    pub const fn commitment(&self) -> &[u8; 32] {
        &self.commitment
    }

    pub fn commitment_hex(&self) -> String {
        hex_encode(&self.commitment)
    }

    pub fn simultaneously_feasible(&self) -> bool {
        self.capital_rejected.is_empty() && self.conflicts.is_empty()
    }
}

#[derive(Default)]
struct Aggregate {
    claimed: Amount256,
    claimants: BTreeSet<PortfolioCandidateId>,
}

impl Aggregate {
    fn add(
        &mut self,
        candidate_id: PortfolioCandidateId,
        amount: Amount256,
    ) -> Result<(), PortfolioError> {
        self.claimed = self
            .claimed
            .checked_add(amount)
            .map_err(|_| PortfolioError::AmountOverflow)?;
        self.claimants.insert(candidate_id);
        Ok(())
    }
}

pub fn evaluate_portfolio(
    candidates: &[PortfolioCandidate],
    requirements: &[CapitalRequirement],
    feasibility: &[CapitalFeasibility],
    sources: &[CapitalSource],
    shared_resources: &[SharedResource],
) -> Result<PortfolioReport, PortfolioError> {
    let mut requirement_map = BTreeMap::new();
    for requirement in requirements {
        if requirement_map
            .insert(requirement.id(), requirement)
            .is_some()
        {
            return Err(PortfolioError::DuplicateRequirement);
        }
    }

    let mut feasibility_map = BTreeMap::new();
    for result in feasibility {
        let id = feasibility_id(result);
        if feasibility_map.insert(id, result).is_some() {
            return Err(PortfolioError::DuplicateFeasibility);
        }
    }

    let mut source_by_id = BTreeMap::<CapitalSourceId, &CapitalSource>::new();
    let mut source_by_key = BTreeMap::<CapitalSourceKeyId, &CapitalSource>::new();
    for source in sources {
        if source_by_id.insert(source.id(), source).is_some() {
            return Err(PortfolioError::DuplicateSourceId);
        }
        if let Some(existing) = source_by_key.insert(source.key_id(), source) {
            if existing.id() != source.id() {
                return Err(PortfolioError::ConflictingSourceState);
            }
        }
    }

    for (requirement_id, supplied) in &feasibility_map {
        let requirement = requirement_map
            .get(requirement_id)
            .copied()
            .ok_or(PortfolioError::MissingRequirement)?;

        // A feasible RMC-011 proof may have been produced from a larger
        // capital census than the other candidates in this portfolio slice.
        // Recomputing it against the union of every source visible here can
        // legitimately choose a different equivalent source and would turn
        // source-set expansion into a false mismatch. Recompute feasible
        // proofs against exactly the source ids they bind. Rejections still
        // use the complete source set, because adding any compatible source
        // could invalidate the rejection.
        let recomputed = match supplied {
            CapitalFeasibility::Feasible { allocations, .. } => {
                let mut selected_ids = BTreeSet::new();
                let mut selected_sources = Vec::new();
                for allocation in allocations {
                    let source = source_by_id
                        .get(&allocation.source_id)
                        .copied()
                        .ok_or(PortfolioError::MissingSource)?;
                    if source.ownership() == CapitalOwnership::OperatorOwned {
                        return Err(PortfolioError::OperatorOwnedSource);
                    }
                    if selected_ids.insert(source.id()) {
                        selected_sources.push(source.clone());
                    }
                }
                evaluate_capital_feasibility_checked(requirement, &selected_sources)
            }
            CapitalFeasibility::Rejected { .. } => {
                evaluate_capital_feasibility_checked(requirement, sources)
            }
        }
        .map_err(|_| PortfolioError::CapitalFeasibilityEvaluationFailed)?;
        if &recomputed != *supplied {
            return Err(PortfolioError::CapitalFeasibilityMismatch);
        }
    }

    let mut resources = BTreeMap::<SharedResourceKeyId, &SharedResource>::new();
    for resource in shared_resources {
        if let Some(existing) = resources.insert(resource.key_id(), resource) {
            if existing.id() == resource.id() {
                return Err(PortfolioError::DuplicateResourceKey);
            }
            return Err(PortfolioError::ConflictingResourceState);
        }
    }

    let mut seen_candidates = BTreeSet::new();
    let mut requirement_claims = BTreeMap::<CapitalRequirementId, Aggregate>::new();
    let mut source_claims = BTreeMap::<CapitalSourceKeyId, Aggregate>::new();
    let mut shared_claims = BTreeMap::<SharedResourceKeyId, Aggregate>::new();
    let mut capital_rejected = Vec::new();
    let mut capital_feasible_count = 0_usize;

    for candidate in candidates {
        if !seen_candidates.insert(candidate.id()) {
            return Err(PortfolioError::DuplicateCandidate);
        }
        let requirement = requirement_map
            .get(&candidate.requirement_id())
            .copied()
            .ok_or(PortfolioError::MissingRequirement)?;
        if requirement.anchor() != candidate.anchor() {
            return Err(PortfolioError::CandidateAnchorMismatch);
        }
        let result = feasibility_map
            .get(&candidate.requirement_id())
            .copied()
            .ok_or(PortfolioError::MissingFeasibility)?;

        // Resource declarations are authority even for capital-rejected
        // candidates. Reject malformed, undeclared or foreign-anchor claims
        // before capital feasibility decides whether they consume capacity.
        for claim in candidate.claims() {
            let resource = resources
                .get(&claim.resource_key)
                .copied()
                .ok_or(PortfolioError::MissingResource)?;
            if resource.anchor() != requirement.anchor() {
                return Err(PortfolioError::ResourceAnchorMismatch);
            }
            if matches!(resource.limit(), ResourceLimit::Exclusive)
                && claim.amount != Amount256::from_u128(1)
            {
                return Err(PortfolioError::ExclusiveClaimMustBeOne);
            }
        }

        match result {
            CapitalFeasibility::Rejected { reason, .. } => {
                capital_rejected.push(CapitalBlockedCandidate {
                    candidate_id: candidate.id(),
                    requirement_id: candidate.requirement_id(),
                    reason: *reason,
                });
                continue;
            }
            CapitalFeasibility::Feasible { allocations, .. } => {
                requirement_claims
                    .entry(candidate.requirement_id())
                    .or_default()
                    .add(candidate.id(), Amount256::from_u128(1))?;
                capital_feasible_count += 1;
                let mut per_source = BTreeMap::<CapitalSourceKeyId, Amount256>::new();
                for allocation in allocations {
                    let source = source_by_id
                        .get(&allocation.source_id)
                        .copied()
                        .ok_or(PortfolioError::MissingSource)?;
                    if source.ownership() == CapitalOwnership::OperatorOwned {
                        return Err(PortfolioError::OperatorOwnedSource);
                    }
                    if source.anchor() != requirement.anchor() {
                        return Err(PortfolioError::CandidateAnchorMismatch);
                    }
                    let current = per_source
                        .get(&source.key_id())
                        .copied()
                        .unwrap_or(Amount256::ZERO);
                    per_source.insert(
                        source.key_id(),
                        current
                            .checked_add(allocation.amount)
                            .map_err(|_| PortfolioError::AmountOverflow)?,
                    );
                }
                for (key, amount) in per_source {
                    source_claims
                        .entry(key)
                        .or_default()
                        .add(candidate.id(), amount)?;
                }
            }
        }

        for claim in candidate.claims() {
            shared_claims
                .entry(claim.resource_key)
                .or_default()
                .add(candidate.id(), claim.amount)?;
        }
    }

    let components = contention_components(
        &requirement_claims,
        &source_claims,
        &shared_claims,
        &capital_rejected,
        candidates,
    );

    let mut conflicts = Vec::new();
    for (requirement_id, aggregate) in &requirement_claims {
        let capacity = Amount256::from_u128(1);
        if aggregate.claimed > capacity {
            conflicts.push(PortfolioConflict {
                resource: ConflictResource::Requirement(*requirement_id),
                capacity,
                claimed: aggregate.claimed,
                claimants: aggregate.claimants.iter().copied().collect(),
            });
        }
    }
    for (key, aggregate) in &source_claims {
        let source = source_by_key
            .get(key)
            .copied()
            .ok_or(PortfolioError::MissingSource)?;
        let capacity = source
            .effective_capacity()
            .map_err(|_| PortfolioError::AmountOverflow)?;
        if aggregate.claimed > capacity {
            conflicts.push(PortfolioConflict {
                resource: ConflictResource::CapitalSource(*key),
                capacity,
                claimed: aggregate.claimed,
                claimants: aggregate.claimants.iter().copied().collect(),
            });
        }
    }
    for (key, aggregate) in &shared_claims {
        let resource = resources
            .get(key)
            .copied()
            .ok_or(PortfolioError::MissingResource)?;
        let capacity = resource.limit().capacity();
        if aggregate.claimed > capacity {
            conflicts.push(PortfolioConflict {
                resource: ConflictResource::Shared(*key),
                capacity,
                claimed: aggregate.claimed,
                claimants: aggregate.claimants.iter().copied().collect(),
            });
        }
    }

    capital_rejected.sort_by_key(|entry| entry.candidate_id);
    conflicts.sort_by_key(|conflict| conflict.resource);
    let commitment = report_commitment(
        candidates,
        &feasibility_map,
        &source_by_id,
        &resources,
        capital_feasible_count,
        &capital_rejected,
        &conflicts,
    )?;
    Ok(PortfolioReport {
        candidate_count: candidates.len(),
        capital_feasible_count,
        capital_rejected,
        conflicts,
        components,
        commitment,
    })
}

fn contention_components(
    requirement_claims: &BTreeMap<CapitalRequirementId, Aggregate>,
    source_claims: &BTreeMap<CapitalSourceKeyId, Aggregate>,
    shared_claims: &BTreeMap<SharedResourceKeyId, Aggregate>,
    rejected: &[CapitalBlockedCandidate],
    candidates: &[PortfolioCandidate],
) -> Vec<PortfolioComponent> {
    let rejected_ids = rejected
        .iter()
        .map(|entry| entry.candidate_id)
        .collect::<BTreeSet<_>>();
    let mut ids = candidates
        .iter()
        .map(PortfolioCandidate::id)
        .filter(|id| !rejected_ids.contains(id))
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    if ids.is_empty() {
        return Vec::new();
    }

    let index = ids
        .iter()
        .copied()
        .enumerate()
        .map(|(position, id)| (id, position))
        .collect::<BTreeMap<_, _>>();
    let mut parent = (0..ids.len()).collect::<Vec<_>>();
    let mut rank = vec![0_u8; ids.len()];

    for aggregate in requirement_claims.values() {
        union_claimants(&index, &aggregate.claimants, &mut parent, &mut rank);
    }
    for aggregate in source_claims.values() {
        union_claimants(&index, &aggregate.claimants, &mut parent, &mut rank);
    }
    for aggregate in shared_claims.values() {
        union_claimants(&index, &aggregate.claimants, &mut parent, &mut rank);
    }

    let mut grouped = BTreeMap::<usize, PortfolioComponent>::new();
    for (position, id) in ids.iter().copied().enumerate() {
        let root = find_root(&mut parent, position);
        grouped
            .entry(root)
            .or_insert_with(|| PortfolioComponent {
                candidates: Vec::new(),
                resources: Vec::new(),
            })
            .candidates
            .push(id);
    }

    for (requirement_id, aggregate) in requirement_claims {
        if let Some(first) = aggregate.claimants.iter().next() {
            if let Some(position) = index.get(first).copied() {
                let root = find_root(&mut parent, position);
                if let Some(component) = grouped.get_mut(&root) {
                    component
                        .resources
                        .push(ConflictResource::Requirement(*requirement_id));
                }
            }
        }
    }
    for (key, aggregate) in source_claims {
        if let Some(first) = aggregate.claimants.iter().next() {
            if let Some(position) = index.get(first).copied() {
                let root = find_root(&mut parent, position);
                if let Some(component) = grouped.get_mut(&root) {
                    component
                        .resources
                        .push(ConflictResource::CapitalSource(*key));
                }
            }
        }
    }
    for (key, aggregate) in shared_claims {
        if let Some(first) = aggregate.claimants.iter().next() {
            if let Some(position) = index.get(first).copied() {
                let root = find_root(&mut parent, position);
                if let Some(component) = grouped.get_mut(&root) {
                    component.resources.push(ConflictResource::Shared(*key));
                }
            }
        }
    }

    let mut components = grouped.into_values().collect::<Vec<_>>();
    for component in &mut components {
        component.candidates.sort_unstable();
        component.resources.sort_unstable();
        component.resources.dedup();
    }
    components.sort_by_key(|component| component.candidates[0]);
    components
}

fn union_claimants(
    index: &BTreeMap<PortfolioCandidateId, usize>,
    claimants: &BTreeSet<PortfolioCandidateId>,
    parent: &mut [usize],
    rank: &mut [u8],
) {
    let mut positions = claimants.iter().filter_map(|id| index.get(id).copied());
    let Some(first) = positions.next() else {
        return;
    };
    for position in positions {
        union(parent, rank, first, position);
    }
}

fn find_root(parent: &mut [usize], node: usize) -> usize {
    let mut root = node;
    while parent[root] != root {
        root = parent[root];
    }
    let mut current = node;
    while parent[current] != current {
        let next = parent[current];
        parent[current] = root;
        current = next;
    }
    root
}

fn union(parent: &mut [usize], rank: &mut [u8], left: usize, right: usize) {
    let left_root = find_root(parent, left);
    let right_root = find_root(parent, right);
    if left_root == right_root {
        return;
    }
    if rank[left_root] < rank[right_root] {
        parent[left_root] = right_root;
    } else if rank[left_root] > rank[right_root] {
        parent[right_root] = left_root;
    } else {
        parent[right_root] = left_root;
        rank[left_root] = rank[left_root].saturating_add(1);
    }
}

fn feasibility_id(result: &CapitalFeasibility) -> CapitalRequirementId {
    match result {
        CapitalFeasibility::Feasible { requirement_id, .. }
        | CapitalFeasibility::Rejected { requirement_id, .. } => *requirement_id,
    }
}

fn resource_key_bytes(
    chain: &ChainDomain,
    kind: SharedResourceKind,
    locator_hash: Hash32,
    unit: ResourceUnit,
) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&chain.chain_id().to_be_bytes());
    out.extend_from_slice(chain.genesis_hash().as_bytes());
    out.extend_from_slice(chain.fork_lineage().as_bytes());
    out.extend_from_slice(&kind.tag().to_be_bytes());
    out.extend_from_slice(locator_hash.as_bytes());
    unit.encode(&mut out);
    out
}

fn encode_anchor(anchor: &StateAnchor, out: &mut Vec<u8>) {
    out.extend_from_slice(&anchor.block_number().to_be_bytes());
    out.extend_from_slice(anchor.block_hash().as_bytes());
    out.extend_from_slice(anchor.parent_hash().as_bytes());
    out.extend_from_slice(&anchor.timestamp().to_be_bytes());
    out.extend_from_slice(anchor.state_root().as_bytes());
}

fn encode_evidence(evidence: &[CapitalEvidenceRef], out: &mut Vec<u8>) {
    out.extend_from_slice(
        &u32::try_from(evidence.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    for item in evidence {
        match item {
            CapitalEvidenceRef::Observation(digest) => {
                out.push(1);
                out.extend_from_slice(digest);
            }
            CapitalEvidenceRef::Artifact(hash) => {
                out.push(2);
                out.extend_from_slice(hash.as_bytes());
            }
        }
    }
}

fn report_commitment(
    candidates: &[PortfolioCandidate],
    feasibility: &BTreeMap<CapitalRequirementId, &CapitalFeasibility>,
    sources: &BTreeMap<CapitalSourceId, &CapitalSource>,
    resources: &BTreeMap<SharedResourceKeyId, &SharedResource>,
    capital_feasible_count: usize,
    rejected: &[CapitalBlockedCandidate],
    conflicts: &[PortfolioConflict],
) -> Result<[u8; 32], PortfolioError> {
    let mut hasher = Sha256::new();
    hasher.update(PORTFOLIO_COMMITMENT_DOMAIN);

    // Bind every observed source state, not only sources that happened to
    // conflict. A capacity or fee-state change therefore changes the proof
    // even when the candidate set remains feasible.
    hasher.update(
        u64::try_from(sources.len()).map_err(|_| PortfolioError::AmountOverflow)?
            .to_be_bytes(),
    );
    for (id, source) in sources {
        hasher.update(id.as_bytes());
        hasher.update(source.key_id().as_bytes());
    }

    // Bind every shared-resource observation by stable key and observed id.
    hasher.update(
        u64::try_from(resources.len()).map_err(|_| PortfolioError::AmountOverflow)?
            .to_be_bytes(),
    );
    for (key, resource) in resources {
        hasher.update(key.as_bytes());
        hasher.update(resource.id().as_bytes());
    }

    let mut ordered_candidates = candidates.iter().collect::<Vec<_>>();
    ordered_candidates.sort_by_key(|candidate| candidate.id());
    hasher.update(
        u64::try_from(ordered_candidates.len()).map_err(|_| PortfolioError::AmountOverflow)?
            .to_be_bytes(),
    );
    for candidate in ordered_candidates {
        hasher.update(candidate.id().as_bytes());
        hasher.update(candidate.requirement_id().as_bytes());
        match candidate.variant_hash() {
            Some(hash) => {
                hasher.update([1]);
                hasher.update(hash.as_bytes());
            }
            None => hasher.update([0]),
        }
        encode_anchor_hash(candidate.anchor(), &mut hasher);
        hasher.update(
            u64::try_from(candidate.claims().len()).map_err(|_| PortfolioError::AmountOverflow)?
                .to_be_bytes(),
        );
        for claim in candidate.claims() {
            hasher.update(claim.resource_key.as_bytes());
            hasher.update(claim.amount.as_be_bytes());
        }

        if let Some(result) = feasibility.get(&candidate.requirement_id()) {
            match result {
                CapitalFeasibility::Feasible { allocations, .. } => {
                    hasher.update([1]);
                    let mut ordered = allocations.iter().collect::<Vec<_>>();
                    ordered.sort_by_key(|allocation| {
                        (
                            allocation.source_id,
                            allocation.leg_kind.code(),
                            allocation.amount,
                        )
                    });
                    hasher.update(
                        u64::try_from(ordered.len()).map_err(|_| PortfolioError::AmountOverflow)?
                            .to_be_bytes(),
                    );
                    for allocation in ordered {
                        hasher.update(allocation.source_id.as_bytes());
                        hasher.update(allocation.leg_kind.code().as_bytes());
                        hasher.update([0]);
                        hasher.update(allocation.amount.as_be_bytes());
                    }
                }
                CapitalFeasibility::Rejected {
                    reason, failed_leg, ..
                } => {
                    hasher.update([2]);
                    hasher.update(reason.code().as_bytes());
                    hasher.update([0]);
                    match failed_leg {
                        Some(kind) => {
                            hasher.update([1]);
                            hasher.update(kind.code().as_bytes());
                            hasher.update([0]);
                        }
                        None => hasher.update([0]),
                    }
                }
            }
        } else {
            // evaluate_portfolio rejects this condition before commitment,
            // but keep the commitment format explicitly total.
            hasher.update([0]);
        }
    }

    hasher.update(
        u64::try_from(capital_feasible_count).map_err(|_| PortfolioError::AmountOverflow)?
            .to_be_bytes(),
    );
    for item in rejected {
        hasher.update(item.candidate_id.as_bytes());
        hasher.update(item.requirement_id.as_bytes());
        hasher.update(item.reason.code().as_bytes());
        hasher.update([0]);
    }
    for conflict in conflicts {
        match conflict.resource {
            ConflictResource::Requirement(id) => {
                hasher.update([1]);
                hasher.update(id.as_bytes());
            }
            ConflictResource::CapitalSource(id) => {
                hasher.update([2]);
                hasher.update(id.as_bytes());
            }
            ConflictResource::Shared(id) => {
                hasher.update([3]);
                hasher.update(id.as_bytes());
            }
        }
        hasher.update(conflict.capacity.as_be_bytes());
        hasher.update(conflict.claimed.as_be_bytes());
        hasher.update(
            u64::try_from(conflict.claimants.len()).map_err(|_| PortfolioError::AmountOverflow)?
                .to_be_bytes(),
        );
        for claimant in &conflict.claimants {
            hasher.update(claimant.as_bytes());
        }
    }
    Ok(hasher.finalize().into())
}

fn encode_anchor_hash(anchor: &StateAnchor, hasher: &mut Sha256) {
    hasher.update(anchor.chain().chain_id().to_be_bytes());
    hasher.update(anchor.chain().genesis_hash().as_bytes());
    hasher.update(anchor.chain().fork_lineage().as_bytes());
    hasher.update(anchor.block_number().to_be_bytes());
    hasher.update(anchor.block_hash().as_bytes());
    hasher.update(anchor.parent_hash().as_bytes());
    hasher.update(anchor.timestamp().to_be_bytes());
    hasher.update(anchor.state_root().as_bytes());
}

fn domain_hash(domain: &[u8], bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update([0]);
    hasher.update(bytes);
    hasher.finalize().into()
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}
