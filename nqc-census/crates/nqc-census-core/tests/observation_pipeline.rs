use nqc_census_core::{
    require_same_anchor, AdapterCapability, AdapterDeclaration, Address, AnchorMismatchField,
    BlockerId, CanonicalMarketKey, CapabilityError, CapabilityMatrix, CapabilityScope,
    CensusObservation, CensusStage, CensusUnitId, CensusUnitKind, ChainDomain, DeploymentKey,
    EvidenceBasis, EvidenceRef, Hash32, IdentityError, ObservationError, ObservationProvenance,
    ObservationSemantics, PipelineError, ProtocolFamily, ProvenanceAuthority, RawLogEnvelope,
    RejectionReason, StageDecision, StageDomain, StageEvidence, StageLedger, StageRecord,
    StateAnchor,
};
use std::error::Error;

type TestResult = Result<(), Box<dyn Error>>;

fn hash(byte: u8) -> Result<Hash32, IdentityError> {
    Hash32::new([byte; 32])
}

fn address(byte: u8) -> Result<Address, IdentityError> {
    Address::new([byte; 20])
}

fn chain(lineage: u8) -> Result<ChainDomain, IdentityError> {
    ChainDomain::new(1, hash(0x11)?, hash(lineage)?)
}

fn anchor(
    block_number: u64,
    block_hash: u8,
    parent_hash: u8,
    timestamp: u64,
    state_root: u8,
) -> Result<StateAnchor, Box<dyn Error>> {
    Ok(StateAnchor::new(
        chain(0x22)?,
        block_number,
        hash(block_hash)?,
        hash(parent_hash)?,
        timestamp,
        hash(state_root)?,
    )?)
}

fn provenance(response: u8) -> Result<ObservationProvenance, Box<dyn Error>> {
    Ok(ObservationProvenance::new(
        ProvenanceAuthority::ReceiptLog,
        1,
        hash(0x31)?,
        hash(0x32)?,
        hash(response)?,
    )?)
}

fn semantics(code: u8, config: u8) -> Result<ObservationSemantics, IdentityError> {
    Ok(ObservationSemantics::new(hash(code)?, hash(config)?))
}

fn raw_log(data: Vec<u8>) -> Result<RawLogEnvelope, Box<dyn Error>> {
    Ok(RawLogEnvelope::new(
        address(0x41)?,
        hash(0x42)?,
        7,
        9,
        vec![hash(0x43)?, hash(0x44)?],
        data,
        false,
    )?)
}

fn observation(
    state_anchor: StateAnchor,
    code: u8,
    config: u8,
    response: u8,
    data: Vec<u8>,
) -> Result<CensusObservation<RawLogEnvelope>, Box<dyn Error>> {
    Ok(CensusObservation::from_raw_log(
        state_anchor,
        semantics(code, config)?,
        provenance(response)?,
        raw_log(data)?,
    )?)
}

fn market_unit() -> Result<CensusUnitId, Box<dyn Error>> {
    let deployment = DeploymentKey::new(
        chain(0x22)?,
        ProtocolFamily::AaveV3,
        address(0x51)?,
        hash(0x52)?,
    );
    let market = CanonicalMarketKey::aave_pool(deployment)?;
    Ok(CensusUnitId::from_market(market.id()?))
}

fn stage_domain() -> Result<StageDomain, IdentityError> {
    Ok(StageDomain::new(
        chain(0x22)?,
        ProtocolFamily::AaveV3,
        CensusUnitKind::Market,
    ))
}

#[test]
fn observation_preserves_full_anchor_raw_log_and_provenance() -> TestResult {
    let state_anchor = anchor(100, 0x61, 0x60, 1_700_000_000, 0x62)?;
    let observed = observation(
        state_anchor.clone(),
        0x63,
        0x64,
        0x65,
        vec![1, 2, 3, 4],
    )?;

    assert_eq!(observed.envelope().anchor(), &state_anchor);
    assert_eq!(observed.envelope().anchor().chain().chain_id(), 1);
    assert_eq!(observed.envelope().anchor().block_number(), 100);
    assert_eq!(observed.envelope().anchor().timestamp(), 1_700_000_000);
    assert_eq!(observed.envelope().semantics().code_hash(), hash(0x63)?);
    assert_eq!(
        observed.envelope().semantics().configuration_hash(),
        hash(0x64)?
    );
    assert_eq!(
        observed.envelope().provenance().authority(),
        ProvenanceAuthority::ReceiptLog
    );
    assert_eq!(observed.payload().emitter(), address(0x41)?);
    assert_eq!(observed.payload().transaction_hash(), hash(0x42)?);
    assert_eq!(observed.payload().transaction_index(), 7);
    assert_eq!(observed.payload().log_index(), 9);
    assert_eq!(observed.payload().topics(), &[hash(0x43)?, hash(0x44)?]);
    assert_eq!(observed.payload().data(), &[1, 2, 3, 4]);
    assert!(!observed.payload().removed());
    assert_eq!(
        observed.envelope().raw_payload_digest(),
        observed.payload().digest()?
    );
    Ok(())
}

#[test]
fn decoding_preserves_original_observation_envelope_and_digest() -> TestResult {
    let observed = observation(
        anchor(101, 0x71, 0x70, 1_700_000_001, 0x72)?,
        0x73,
        0x74,
        0x75,
        vec![5, 6, 7],
    )?;
    let original = observed.envelope().clone();
    let decoded = observed.map_payload(|raw| {
        Ok::<usize, ObservationError>(raw.data().len())
    })?;

    assert_eq!(decoded.envelope(), &original);
    assert_eq!(*decoded.payload(), 3);
    Ok(())
}

#[test]
fn observation_digest_changes_when_authoritative_inputs_change() -> TestResult {
    let base_anchor = anchor(102, 0x81, 0x80, 1_700_000_002, 0x82)?;
    let base = observation(base_anchor.clone(), 0x83, 0x84, 0x85, vec![8])?;
    let changed_payload =
        observation(base_anchor.clone(), 0x83, 0x84, 0x85, vec![9])?;
    let changed_code =
        observation(base_anchor.clone(), 0x86, 0x84, 0x85, vec![8])?;
    let changed_config =
        observation(base_anchor.clone(), 0x83, 0x87, 0x85, vec![8])?;
    let changed_provenance =
        observation(base_anchor, 0x83, 0x84, 0x88, vec![8])?;

    let base_digest = base.envelope().digest();
    assert_ne!(base_digest, changed_payload.envelope().digest());
    assert_ne!(base_digest, changed_code.envelope().digest());
    assert_ne!(base_digest, changed_config.envelope().digest());
    assert_ne!(base_digest, changed_provenance.envelope().digest());
    Ok(())
}

#[test]
fn joins_reject_different_block_hash_timestamp_and_state_root() -> TestResult {
    let base = observation(
        anchor(103, 0x91, 0x90, 1_700_000_003, 0x92)?,
        0x93,
        0x94,
        0x95,
        vec![1],
    )?;
    let different_block = observation(
        anchor(103, 0x96, 0x90, 1_700_000_003, 0x92)?,
        0x93,
        0x94,
        0x95,
        vec![2],
    )?;
    let different_timestamp = observation(
        anchor(103, 0x91, 0x90, 1_700_000_004, 0x92)?,
        0x93,
        0x94,
        0x95,
        vec![3],
    )?;
    let different_state_root = observation(
        anchor(103, 0x91, 0x90, 1_700_000_003, 0x97)?,
        0x93,
        0x94,
        0x95,
        vec![4],
    )?;

    assert_eq!(
        require_same_anchor(&base, &different_block),
        Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::BlockHash
        ))
    );
    assert_eq!(
        require_same_anchor(&base, &different_timestamp),
        Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::Timestamp
        ))
    );
    assert_eq!(
        require_same_anchor(&base, &different_state_root),
        Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::StateRoot
        ))
    );
    Ok(())
}

#[test]
fn same_state_join_allows_distinct_contract_semantics() -> TestResult {
    let state_anchor = anchor(104, 0xa1, 0xa0, 1_700_000_005, 0xa2)?;
    let left = observation(
        state_anchor.clone(),
        0xa3,
        0xa4,
        0xa5,
        vec![1],
    )?;
    let right = observation(state_anchor, 0xa6, 0xa7, 0xa8, vec![2])?;
    require_same_anchor(&left, &right)?;
    Ok(())
}

#[test]
fn raw_log_rejects_more_than_four_topics() -> TestResult {
    let result = RawLogEnvelope::new(
        address(0xb1)?,
        hash(0xb2)?,
        0,
        0,
        vec![
            hash(0xb3)?,
            hash(0xb4)?,
            hash(0xb5)?,
            hash(0xb6)?,
            hash(0xb7)?,
        ],
        Vec::new(),
        false,
    );
    assert_eq!(result, Err(ObservationError::TooManyLogTopics(5)));
    Ok(())
}

#[test]
fn pipeline_stage_contract_has_exact_thirteen_ordered_stages() {
    assert_eq!(CensusStage::ALL.len(), 13);
    assert_eq!(CensusStage::ALL[0].code(), "MARKETS_DISCOVERED");
    assert_eq!(
        CensusStage::ALL[5].code(),
        "MARKETS_LIQUIDATABLE_OR_ACTIONABLE"
    );
    assert_eq!(
        CensusStage::ALL[12].code(),
        "MARKETS_SHADOW_ELIGIBLE"
    );
}

#[test]
fn not_tested_can_never_silently_advance_or_become_rejection() -> TestResult {
    let advance = StageEvidence::new(
        CensusStage::MarketsStateReconstructable,
        EvidenceBasis::NotTested,
        StageDecision::Advance,
        Vec::new(),
    );
    assert_eq!(advance, Err(PipelineError::NotTestedCannotAdvance));

    let reject = StageEvidence::new(
        CensusStage::MarketsStateReconstructable,
        EvidenceBasis::NotTested,
        StageDecision::Reject(RejectionReason::StateUnreconstructable),
        Vec::new(),
    );
    assert_eq!(reject, Err(PipelineError::NotTestedMustBeUnknown));
    Ok(())
}

#[test]
fn unknown_is_machine_readable_not_tested_and_blocker_bound() -> TestResult {
    let blocker = BlockerId::parse("RMC-GAP-021")?;
    let evidence = StageEvidence::new(
        CensusStage::MarketsExecutionSimulatable,
        EvidenceBasis::NotTested,
        StageDecision::Unknown {
            reason: RejectionReason::Unknown,
            blocker: blocker.clone(),
        },
        Vec::new(),
    )?;
    assert_eq!(evidence.basis(), EvidenceBasis::NotTested);

    assert_eq!(
        StageEvidence::new(
            CensusStage::MarketsExecutionSimulatable,
            EvidenceBasis::Derived,
            StageDecision::Unknown {
                reason: RejectionReason::Unknown,
                blocker,
            },
            vec![EvidenceRef::Artifact(hash(0xc1)?)]
        ),
        Err(PipelineError::UnknownMustBeNotTested)
    );
    assert_eq!(
        BlockerId::parse("UNKNOWN-21"),
        Err(PipelineError::InvalidBlockerId)
    );
    Ok(())
}

#[test]
fn unknown_reason_cannot_hide_inside_normal_rejection() -> TestResult {
    assert_eq!(
        StageEvidence::new(
            CensusStage::MarketsPositiveNetEv,
            EvidenceBasis::Derived,
            StageDecision::Reject(RejectionReason::Unknown),
            vec![EvidenceRef::Artifact(hash(0xd1)?)]
        ),
        Err(PipelineError::UnknownMustCarryBlocker)
    );
    Ok(())
}

#[test]
fn positive_and_negative_stage_decisions_require_evidence_refs() {
    assert_eq!(
        StageEvidence::new(
            CensusStage::MarketsBorrowable,
            EvidenceBasis::Proven,
            StageDecision::Advance,
            Vec::new()
        ),
        Err(PipelineError::MissingEvidenceReference)
    );
    assert_eq!(
        StageEvidence::new(
            CensusStage::MarketsBorrowable,
            EvidenceBasis::Derived,
            StageDecision::Reject(RejectionReason::MarketPaused),
            Vec::new()
        ),
        Err(PipelineError::MissingEvidenceReference)
    );
}

#[test]
fn rejection_records_preserve_negatives_and_are_order_deterministic() -> TestResult {
    let unit = market_unit()?;
    let domain = stage_domain()?;
    let first_ref = EvidenceRef::Artifact(hash(0xe1)?);
    let second_ref = EvidenceRef::Artifact(hash(0xe2)?);

    let left = StageEvidence::new(
        CensusStage::MarketsPositiveNetEv,
        EvidenceBasis::Derived,
        StageDecision::Reject(RejectionReason::UnprofitableAfterGas),
        vec![second_ref, first_ref],
    )?;
    let right = StageEvidence::new(
        CensusStage::MarketsPositiveNetEv,
        EvidenceBasis::Derived,
        StageDecision::Reject(RejectionReason::UnprofitableAfterGas),
        vec![first_ref, second_ref],
    )?;

    let mut left_ledger = StageLedger::default();
    left_ledger.record(StageRecord::new(domain.clone(), unit, left))?;
    let mut right_ledger = StageLedger::default();
    right_ledger.record(StageRecord::new(domain, unit, right))?;

    let left_rejections = left_ledger.rejection_records();
    let right_rejections = right_ledger.rejection_records();
    assert_eq!(left_rejections.len(), 1);
    assert_eq!(right_rejections.len(), 1);
    assert_eq!(left_rejections[0].id(), right_rejections[0].id());
    assert_eq!(
        left_rejections[0].reason().code(),
        "UNPROFITABLE_AFTER_GAS"
    );
    assert_eq!(left_rejections[0].evidence_refs().len(), 2);
    Ok(())
}

#[test]
fn stage_ledger_has_explicit_conserved_denominators() -> TestResult {
    let domain = stage_domain()?;
    let first = market_unit()?;
    let second = CensusUnitId::from_scoped_hash(7, hash(0xf1)?)?;
    let third = CensusUnitId::from_scoped_hash(7, hash(0xf2)?)?;
    let evidence_ref = EvidenceRef::Artifact(hash(0xf3)?);

    let advance = StageEvidence::new(
        CensusStage::MarketsEconomicallyActive,
        EvidenceBasis::Proven,
        StageDecision::Advance,
        vec![evidence_ref],
    )?;
    let reject = StageEvidence::new(
        CensusStage::MarketsEconomicallyActive,
        EvidenceBasis::Derived,
        StageDecision::Reject(RejectionReason::NoActiveState),
        vec![evidence_ref],
    )?;
    let unknown = StageEvidence::new(
        CensusStage::MarketsEconomicallyActive,
        EvidenceBasis::NotTested,
        StageDecision::Unknown {
            reason: RejectionReason::Unknown,
            blocker: BlockerId::parse("RMC-GAP-005")?,
        },
        Vec::new(),
    )?;

    let mut ledger = StageLedger::default();
    ledger.record(StageRecord::new(domain.clone(), first, advance))?;
    ledger.record(StageRecord::new(domain.clone(), second, reject))?;
    ledger.record(StageRecord::new(domain.clone(), third, unknown))?;

    let metrics = ledger.metrics(&domain, CensusStage::MarketsEconomicallyActive);
    assert_eq!(metrics.input_count, 3);
    assert_eq!(metrics.advanced_count, 1);
    assert_eq!(metrics.rejected_count, 1);
    assert_eq!(metrics.unknown_count, 1);
    assert_eq!(metrics.proven_count, 1);
    assert_eq!(metrics.derived_count, 1);
    assert_eq!(metrics.not_tested_count, 1);
    assert!(metrics.is_conserved());
    assert_eq!(ledger.rejection_records().len(), 2);
    Ok(())
}

#[test]
fn duplicate_unit_stage_decision_is_rejected() -> TestResult {
    let evidence = StageEvidence::new(
        CensusStage::MarketsDiscovered,
        EvidenceBasis::Proven,
        StageDecision::Advance,
        vec![EvidenceRef::Artifact(hash(0x21)?)],
    )?;
    let record = StageRecord::new(stage_domain()?, market_unit()?, evidence);
    let mut ledger = StageLedger::default();
    ledger.record(record.clone())?;
    assert_eq!(
        ledger.record(record),
        Err(PipelineError::DuplicateStageRecord)
    );
    Ok(())
}

#[test]
fn capability_matrix_is_explicit_per_chain_protocol_version() -> TestResult {
    let scope = CapabilityScope::new(chain(0x22)?, ProtocolFamily::AaveV3, 1)?;
    let declaration = AdapterDeclaration::new(
        hash(0x31)?,
        scope.clone(),
        vec![
            AdapterCapability::MarketDiscovery,
            AdapterCapability::StateReconstruction,
        ],
    )?;
    let mut matrix = CapabilityMatrix::default();
    matrix.declare(declaration.clone())?;
    matrix.declare(declaration)?;

    assert_eq!(matrix.len(), 1);
    assert!(matrix
        .require(&scope, AdapterCapability::MarketDiscovery)
        .is_ok());

    let unsupported = matrix
        .require(&scope, AdapterCapability::CapitalCensus)
        .err()
        .ok_or("expected explicit unsupported capability")?;
    assert!(unsupported.scope_declared());
    assert_eq!(unsupported.reason_code(), "UNSUPPORTED_CAPABILITY");

    let other_scope = CapabilityScope::new(chain(0x22)?, ProtocolFamily::AaveV4, 1)?;
    let absent = matrix
        .require(&other_scope, AdapterCapability::MarketDiscovery)
        .err()
        .ok_or("expected absent scope to be unsupported")?;
    assert!(!absent.scope_declared());
    Ok(())
}

#[test]
fn capability_matrix_rejects_implicit_or_conflicting_support() -> TestResult {
    assert_eq!(
        CapabilityScope::new(chain(0x22)?, ProtocolFamily::AaveV3, 0),
        Err(CapabilityError::ZeroProtocolSemanticsVersion)
    );

    let scope = CapabilityScope::new(chain(0x22)?, ProtocolFamily::AaveV3, 2)?;
    assert_eq!(
        AdapterDeclaration::new(hash(0x41)?, scope.clone(), Vec::new()),
        Err(CapabilityError::EmptyCapabilitySet)
    );

    let first = AdapterDeclaration::new(
        hash(0x42)?,
        scope.clone(),
        vec![AdapterCapability::MarketDiscovery],
    )?;
    let second = AdapterDeclaration::new(
        hash(0x43)?,
        scope,
        vec![AdapterCapability::MarketDiscovery],
    )?;
    let mut matrix = CapabilityMatrix::default();
    matrix.declare(first)?;
    assert_eq!(
        matrix.declare(second),
        Err(CapabilityError::ConflictingDeclaration)
    );
    Ok(())
}

#[test]
fn unsupported_capability_has_stable_rejection_reason() {
    assert_eq!(
        RejectionReason::UnsupportedCapability.code(),
        "UNSUPPORTED_CAPABILITY"
    );
    assert_eq!(
        RejectionReason::UnsupportedProtocolVersion.code(),
        "UNSUPPORTED_PROTOCOL_VERSION"
    );
    assert_eq!(RejectionReason::Unknown.code(), "UNKNOWN");
}
