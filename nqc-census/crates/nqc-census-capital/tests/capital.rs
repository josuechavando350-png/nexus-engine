use nqc_census_capital::{
    evaluate_capital_feasibility, evaluate_capital_feasibility_checked, Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger,
    CapitalCertificationContext, CapitalClass, CapitalError, CapitalEvidenceRef,
    CapitalFailureMode, CapitalFeasibility, CapitalOwnership, CapitalProviderKind,
    CapitalRequirement, CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, GitObjectId, PersistentDebtTerms, RepaymentSemantics,
    RequiredAtomicity, RequirementKind, RoundingMode, TemporaryLock, UpstreamCensusStage,
    UpstreamConsumptionReceipt, UpstreamStageAuthority, UpstreamStageAuthoritySpec,
    UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
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

fn evidence() -> Vec<CapitalEvidenceRef> {
    vec![CapitalEvidenceRef::Artifact(hash(99))]
}

fn certification_context_for(
    ledger: &CapitalCensusLedger,
) -> Result<CapitalCertificationContext, nqc_census_capital::CapitalError> {
    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let nibble = u8::try_from(index + 1).map_err(|_| {
            nqc_census_capital::CapitalError::InvalidUpstreamAuthority("test stage index overflow")
        })?;
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{nibble:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", u64::from(nibble) + 10))?,
            artifact_sha256: hash(nibble.saturating_add(20)),
            observation_anchor: anchor(100),
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        })?);
    }
    let mut admitted_evidence = evidence();
    admitted_evidence.extend(
        stages
            .iter()
            .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256)),
    );
    let d08_artifact = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
            "test RMC-008 authority missing",
        ))?
        .artifact_sha256;
    let d09_artifact = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
            "test RMC-009 authority missing",
        ))?
        .artifact_sha256;
    CapitalCertificationContext::new(stages, admitted_evidence)?.with_consumption_receipts(vec![
        UpstreamConsumptionReceipt::for_sources(d08_artifact, hash(80), ledger.sources())?,
        UpstreamConsumptionReceipt::for_requirements(
            d09_artifact,
            hash(81),
            ledger.requirements(),
        )?,
    ])
}

fn source(
    class: CapitalClass,
    asset: CapitalAsset,
    maximum: u128,
    repayment_asset: CapitalAsset,
    repayment: RepaymentSemantics,
) -> Result<CapitalSource, nqc_census_capital::CapitalError> {
    CapitalSource::new(CapitalSourceSpec {
        class,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset,
        maximum_available: Amount256::from_u128(maximum),
        fee_model: FeeModel::basis_points(5)?,
        repayment_asset,
        repayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
        ],
        evidence: evidence(),
    })
}

fn repayment_leg(
    asset: CapitalAsset,
) -> Result<CapitalRequirementLeg, nqc_census_capital::CapitalError> {
    CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        asset,
        Amount256::from_u128(1),
        vec![
            CapitalClass::ProtocolNativeFlashLoan,
            CapitalClass::AtomicFlashLiquidity,
            CapitalClass::FlashSwap,
            CapitalClass::TransientCredit,
            CapitalClass::GasFunding,
            CapitalClass::InventoryRequirement,
        ],
    )
}

fn requirement(
    legs: Vec<CapitalRequirementLeg>,
    atomicity: RequiredAtomicity,
    requires_gas: bool,
) -> Result<CapitalRequirement, nqc_census_capital::CapitalError> {
    CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(100),
        atomicity,
        requires_gas,
        legs,
        evidence(),
    )
}

#[test]
fn source_id_is_deterministic_and_class_separated() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let a = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let b = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let c = source(
        CapitalClass::AtomicFlashLiquidity,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert_eq!(a.id(), b.id());
    assert_ne!(a.id(), c.id());
    Ok(())
}

#[test]
fn source_constructor_rejects_public_semantic_bypasses() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let base = CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    };

    let mut invalid = base.clone();
    invalid.fee_model = FeeModel::BasisPoints {
        bps: 10_001,
        rounding: RoundingMode::Floor,
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::InvalidBasisPoints(10_001))
    ));

    let mut invalid = base.clone();
    invalid.fee_model = FeeModel::ExactRatio {
        numerator: 1,
        denominator: 0,
        rounding: RoundingMode::Floor,
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::InvalidRatio)
    ));

    let mut invalid = base.clone();
    invalid.repayment = RepaymentSemantics::DeadlineBlocks(0);
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::ZeroValue("repayment_deadline_blocks"))
    ));

    let mut invalid = base.clone();
    invalid.collateral = CollateralRequirement::Required {
        asset: token,
        amount: Amount256::ZERO,
        liquidation_conditions_hash: hash(31),
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::ZeroValue("collateral_amount"))
    ));

    let mut invalid = base.clone();
    invalid.utilization = UtilizationConstraints {
        max_utilization_bps: 10_001,
        min_remaining: Amount256::ZERO,
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::InvalidBasisPoints(10_001))
    ));

    let mut invalid = base.clone();
    invalid.temporary_lock = TemporaryLock::Required {
        asset: token,
        amount: Amount256::ZERO,
        release: nqc_census_capital::LockRelease::EndOfTransaction,
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::ZeroValue("temporary_lock_amount"))
    ));

    let mut invalid = base.clone();
    invalid.temporary_lock = TemporaryLock::Required {
        asset: token,
        amount: Amount256::from_u128(1),
        release: nqc_census_capital::LockRelease::DeadlineBlocks(0),
    };
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::ZeroValue("lock_deadline_blocks"))
    ));

    let mut invalid = base;
    invalid.evidence = vec![CapitalEvidenceRef::Observation([0; 32])];
    assert!(matches!(
        CapitalSource::new(invalid),
        Err(CapitalError::InvalidCanonical(
            "zero observation evidence digest"
        ))
    ));
    Ok(())
}

#[test]
fn bond_or_stake_requirement_is_canonical_and_class_separated() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(99)),
        anchor(100),
        RequiredAtomicity::Flexible,
        false,
        vec![CapitalRequirementLeg::new(
            RequirementKind::BondOrStake,
            asset,
            Amount256::from_u128(250),
            vec![CapitalClass::BondOrStake],
        )?],
        evidence(),
    )?;

    let encoded = requirement.canonical_encode();
    let decoded = CapitalRequirement::decode_canonical(&encoded)?;
    assert_eq!(decoded, requirement);
    assert_eq!(decoded.legs().len(), 1);
    assert_eq!(decoded.legs()[0].kind(), RequirementKind::BondOrStake);
    assert_eq!(
        decoded.legs()[0].allowed_classes(),
        &[CapitalClass::BondOrStake]
    );

    let wrong_class_source = source(
        CapitalClass::InventoryRequirement,
        asset,
        1_000,
        asset,
        RepaymentSemantics::NoRepayment,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&requirement, &[wrong_class_source]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::NoCompatibleSource,
            failed_leg: Some(RequirementKind::BondOrStake),
            ..
        }
    ));
    Ok(())
}

#[test]
fn requirement_constructor_rejects_zero_observation_evidence() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(1),
        vec![CapitalClass::FlashSwap],
    )?;
    assert!(matches!(
        CapitalRequirement::new(
            CapitalTargetId::from_hash(hash(50)),
            anchor(100),
            RequiredAtomicity::SameTransaction,
            false,
            vec![principal],
            vec![CapitalEvidenceRef::Observation([0; 32])],
        ),
        Err(CapitalError::InvalidCanonical(
            "zero observation evidence digest"
        ))
    ));
    Ok(())
}

#[test]
fn source_canonical_roundtrip_and_tamper_rejection() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let source = source(
        CapitalClass::FlashSwap,
        asset,
        9_999,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let encoded = source.canonical_encode();
    let decoded = CapitalSource::decode_canonical(&encoded)?;
    assert_eq!(decoded, source);

    let mut tampered = encoded;
    let index = tampered.len() / 2;
    tampered[index] ^= 0x01;
    assert!(CapitalSource::decode_canonical(&tampered).is_err());
    Ok(())
}

#[test]
fn execution_blockers_preserve_observed_capacity_and_stable_source_key() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let observed = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let key = observed.key_id();
    let unblocked_id = observed.id();
    let blocked = observed.with_execution_blockers(vec![
        "TRANSFER_HOOKS_UNPROVEN".to_owned(),
        "FEE_ON_TRANSFER_UNPROVEN".to_owned(),
    ])?;

    assert_eq!(blocked.key_id(), key);
    assert_ne!(blocked.id(), unblocked_id);
    assert_eq!(blocked.maximum_available(), Amount256::from_u128(1_000));
    assert_eq!(blocked.effective_capacity()?, Amount256::from_u128(1_000));
    assert_eq!(blocked.executable_capacity()?, Amount256::ZERO);
    assert!(!blocked.execution_eligible());
    assert_eq!(
        blocked.execution_blockers(),
        &[
            "FEE_ON_TRANSFER_UNPROVEN".to_owned(),
            "TRANSFER_HOOKS_UNPROVEN".to_owned(),
        ]
    );

    let encoded = blocked.canonical_encode();
    let decoded = CapitalSource::decode_canonical(&encoded)?;
    assert_eq!(decoded, blocked);
    assert!(source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?
    .with_execution_blockers(vec!["not-canonical".to_owned()])
    .is_err());
    Ok(())
}

#[test]
fn execution_blocked_liquidity_is_not_misclassified_as_insufficient_capacity() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let blocked = source(
        CapitalClass::ProtocolNativeFlashLoan,
        asset,
        1_000,
        asset,
        RepaymentSemantics::AtomicSameTransaction,
    )?
    .with_execution_blockers(vec!["FEE_ON_TRANSFER_UNPROVEN".to_owned()])?;
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        asset,
        Amount256::from_u128(500),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let required = requirement(vec![principal], RequiredAtomicity::SameTransaction, false)?;

    assert_eq!(
        evaluate_capital_feasibility(&required, &[blocked]),
        CapitalFeasibility::Rejected {
            requirement_id: required.id(),
            reason: nqc_census_capital::FeasibilityRejection::ExecutionBlocked,
            failed_leg: Some(RequirementKind::ActionPrincipal),
        }
    );
    Ok(())
}

#[test]
fn execution_blocked_gas_is_not_misclassified_as_missing() -> TestResult {
    let gas = CapitalAsset::NativeGas;
    let blocked = source(
        CapitalClass::GasFunding,
        gas,
        100,
        gas,
        RepaymentSemantics::NoRepayment,
    )?
    .with_execution_blockers(vec!["SPONSOR_POLICY_UNPROVEN".to_owned()])?;
    let gas_leg = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        gas,
        Amount256::from_u128(50),
        vec![CapitalClass::GasFunding],
    )?;
    let required = requirement(vec![gas_leg], RequiredAtomicity::SameTransaction, true)?;

    assert_eq!(
        evaluate_capital_feasibility(&required, &[blocked]),
        CapitalFeasibility::Rejected {
            requirement_id: required.id(),
            reason: nqc_census_capital::FeasibilityRejection::ExecutionBlocked,
            failed_leg: Some(RequirementKind::Gas),
        }
    );
    Ok(())
}

#[test]
fn persistent_debt_cannot_hide_missing_risk_terms() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let result = source(
        CapitalClass::PersistentDebt,
        asset,
        1_000,
        asset,
        RepaymentSemantics::SameBlock,
    );
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::PersistentDebtTermsRequired)
    ));
    Ok(())
}

#[test]
fn persistent_debt_requires_collateral_semantics() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(21),
        liquidation_model_hash: hash(22),
        solvency_model_hash: hash(23),
        oracle_risk_hash: hash(24),
        liquidity_withdrawal_risk_hash: hash(25),
        facility_disappearance_risk_hash: hash(26),
    };
    let result = source(
        CapitalClass::PersistentDebt,
        asset,
        1_000,
        asset,
        RepaymentSemantics::Persistent(terms),
    );
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::CollateralSemanticsRequired)
    ));
    Ok(())
}

#[test]
fn unknown_source_failure_mode_is_never_admitted() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let result = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset,
        maximum_available: Amount256::from_u128(100),
        fee_model: FeeModel::None,
        repayment_asset: asset,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::Unknown],
        evidence: evidence(),
    });
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::UnknownFailureMode)
    ));
    Ok(())
}

#[test]
fn native_gas_flag_and_gas_leg_must_match_exactly() -> TestResult {
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(5),
        vec![CapitalClass::GasFunding],
    )?;

    assert!(matches!(
        requirement(vec![gas.clone()], RequiredAtomicity::SameTransaction, false,),
        Err(CapitalError::NativeGasLegWithoutRequirementFlag)
    ));

    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        CapitalAsset::Token(address(20)),
        Amount256::from_u128(1),
        vec![CapitalClass::FlashSwap],
    )?;
    assert!(matches!(
        requirement(vec![principal], RequiredAtomicity::SameTransaction, true,),
        Err(CapitalError::NativeGasRequiredButMissing)
    ));
    assert!(matches!(
        CapitalRequirementLeg::new(
            RequirementKind::Gas,
            CapitalAsset::NativeGas,
            Amount256::from_u128(5),
            vec![CapitalClass::GasFunding, CapitalClass::FlashSwap],
        ),
        Err(CapitalError::GasLegMustUseGasFundingOnly)
    ));
    Ok(())
}

#[test]
fn same_transaction_action_can_use_deadline_bound_external_gas_credit() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let gas = CapitalAsset::NativeGas;

    let principal_source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 101,
        provider_locator_hash: hash(31),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(32)),
        asset: token,
        maximum_available: Amount256::from_u128(100),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::RepaymentFailure,
        ],
        evidence: evidence(),
    })?;
    let gas_credit = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::GasFunding,
        anchor: anchor(100),
        provider_namespace: 102,
        provider_locator_hash: hash(33),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(34)),
        asset: gas,
        maximum_available: Amount256::from_u128(10),
        fee_model: FeeModel::None,
        repayment_asset: gas,
        repayment: RepaymentSemantics::DeadlineBlocks(64),
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::RepaymentFailure,
        ],
        evidence: evidence(),
    })?;

    let required = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Gas,
                gas,
                Amount256::from_u128(10),
                vec![CapitalClass::GasFunding],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                gas,
                Amount256::from_u128(10),
                vec![CapitalClass::GasFunding],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &required,
            &[principal_source, gas_credit],
        )?,
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn deadline_bound_gas_credit_cannot_fund_same_transaction_action_principal() -> TestResult {
    let gas = CapitalAsset::NativeGas;
    let gas_credit = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::GasFunding,
        anchor: anchor(100),
        provider_namespace: 103,
        provider_locator_hash: hash(35),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(36)),
        asset: gas,
        maximum_available: Amount256::from_u128(10),
        fee_model: FeeModel::None,
        repayment_asset: gas,
        repayment: RepaymentSemantics::DeadlineBlocks(64),
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::RepaymentFailure,
        ],
        evidence: evidence(),
    })?;

    let required = requirement(
        vec![CapitalRequirementLeg::new(
            RequirementKind::ActionPrincipal,
            gas,
            Amount256::from_u128(10),
            vec![CapitalClass::GasFunding],
        )?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&required, &[gas_credit])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AtomicityMismatch,
            failed_leg: Some(RequirementKind::ActionPrincipal),
            ..
        }
    ));
    Ok(())
}

#[test]
fn gas_is_independent_and_required() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(500),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(5),
        vec![CapitalClass::GasFunding],
    )?;
    let req = requirement(
        vec![
            principal,
            gas,
            repayment_leg(token)?,
            repayment_leg(CapitalAsset::NativeGas)?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;
    let flash = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let result = evaluate_capital_feasibility(&req, &[flash]);
    assert!(matches!(
        result,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::MissingGasFunding,
            ..
        }
    ));
    Ok(())
}

#[test]
fn exact_gas_and_flash_sources_can_be_feasible() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(500),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(5),
        vec![CapitalClass::GasFunding],
    )?;
    let req = requirement(
        vec![
            principal,
            gas,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(500),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                CapitalAsset::NativeGas,
                Amount256::from_u128(5),
                vec![CapitalClass::GasFunding],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;
    let flash = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let gas_source = source(
        CapitalClass::GasFunding,
        CapitalAsset::NativeGas,
        100,
        CapitalAsset::NativeGas,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let result = evaluate_capital_feasibility(&req, &[gas_source.clone(), flash.clone()]);
    assert!(matches!(result, CapitalFeasibility::Feasible { .. }));

    let mut ledger = CapitalCensusLedger::default();
    ledger.register_source(gas_source)?;
    ledger.register_source(flash)?;
    ledger.register_requirement(req)?;
    ledger.evaluate_all()?;
    let summary = ledger.summary()?;
    assert_eq!(summary.feasible_count, 1);
    assert_eq!(summary.feasible_external_gas_count, 1);
    assert!(summary.proves_zero_own_capital());
    Ok(())
}

#[test]
fn protocol_cap_limits_effective_capacity() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let mut spec = CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps {
            protocol_cap: Some(Amount256::from_u128(400)),
            market_cap: Some(Amount256::from_u128(800)),
        },
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::ProtocolCapReached],
        evidence: evidence(),
    };
    let capped = CapitalSource::new(spec.clone())?;
    assert_eq!(capped.effective_capacity()?, Amount256::from_u128(400));
    spec.caps.market_cap = Some(Amount256::from_u128(300));
    let lower = CapitalSource::new(spec)?;
    assert_eq!(lower.effective_capacity()?, Amount256::from_u128(300));
    Ok(())
}

#[test]
fn utilization_reserve_and_absolute_caps_are_independent_upper_bounds() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let make = |protocol_cap, utilization_bps, min_remaining| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::AtomicFlashLiquidity,
            anchor: anchor(100),
            provider_namespace: 11,
            provider_locator_hash: hash(12),
            provider_kind: CapitalProviderKind::ProtocolContract,
            ownership: CapitalOwnership::External,
            source_contract: Some(address(13)),
            asset: token,
            maximum_available: Amount256::from_u128(1_000),
            fee_model: FeeModel::None,
            repayment_asset: token,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(
                utilization_bps,
                Amount256::from_u128(min_remaining),
            )?,
            caps: CapitalCaps {
                protocol_cap: Some(Amount256::from_u128(protocol_cap)),
                market_cap: None,
            },
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![CapitalFailureMode::CapacityChanged],
            evidence: evidence(),
        })
    };

    // Independent bounds are: observed=1000, utilization=800,
    // reserve-floor=900, protocol-cap=900. The result is 800, not 620.
    let utilization_limited = make(900, 8_000, 100)?;
    assert_eq!(
        utilization_limited.effective_capacity()?,
        Amount256::from_u128(800)
    );

    // An absolute cap of 400 remains 400 even though utilization is 50% of
    // the observed 1000 and a reserve floor of 100 must remain.
    let cap_limited = make(400, 5_000, 100)?;
    assert_eq!(cap_limited.effective_capacity()?, Amount256::from_u128(400));

    // A reserve floor at or above observed liquidity closes the source.
    let reserve_limited = make(1_000, 10_000, 1_000)?;
    assert_eq!(reserve_limited.effective_capacity()?, Amount256::ZERO);
    Ok(())
}

#[test]
fn mismatched_anchor_fails_closed() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![
            principal,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let mut spec = CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(101),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    };
    let foreign = CapitalSource::new(spec.clone())?;
    spec.anchor = anchor(100);
    let matching = CapitalSource::new(spec)?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[foreign]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AnchorMismatch,
            ..
        }
    ));
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[matching]),
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn same_block_credit_cannot_satisfy_same_transaction_requirement() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::TransientCredit],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let credit = source(
        CapitalClass::TransientCredit,
        token,
        1_000,
        token,
        RepaymentSemantics::SameBlock,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[credit]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AtomicityMismatch,
            ..
        }
    ));
    Ok(())
}

#[test]
fn requirement_roundtrip_and_cross_type_rejection() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let bytes = requirement.canonical_encode();
    assert_eq!(CapitalRequirement::decode_canonical(&bytes)?, requirement);

    let source = source(
        CapitalClass::FlashSwap,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert!(CapitalRequirement::decode_canonical(&source.canonical_encode()).is_err());
    assert!(CapitalSource::decode_canonical(&bytes).is_err());
    Ok(())
}

#[test]
fn zero_capacity_source_is_preserved_but_zero_requirement_amount_is_invalid() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let zero_source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::ZERO,
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
        ],
        evidence: evidence(),
    })?;
    assert_eq!(zero_source.effective_capacity()?, Amount256::ZERO);

    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(1),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&requirement, &[zero_source]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::InsufficientCapacity,
            ..
        }
    ));

    assert!(CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::ZERO,
        vec![CapitalClass::FlashSwap],
    )
    .is_err());
    Ok(())
}

#[test]
fn zero_own_capital_policy_rejects_operator_treasury_source() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::InventoryRequirement],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let operator = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::OperatorTreasury,
        ownership: CapitalOwnership::OperatorOwned,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[operator]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::OperatorOwnedCapitalRequired,
            ..
        }
    ));
    Ok(())
}

#[test]
fn utilization_math_handles_full_256_bit_capacity_exactly() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let mut bytes = [0_u8; 32];
    bytes[0] = 0x80;
    let maximum = Amount256::from_be_bytes(bytes);
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: maximum,
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(5_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let mut expected = [0_u8; 32];
    expected[0] = 0x40;
    assert_eq!(
        source.effective_capacity()?,
        Amount256::from_be_bytes(expected)
    );
    Ok(())
}

#[test]
fn ledger_proves_no_operator_owned_capital_was_used() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let exact_repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, exact_repayment],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let operator = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 77,
        provider_locator_hash: hash(78),
        provider_kind: CapitalProviderKind::OperatorTreasury,
        ownership: CapitalOwnership::OperatorOwned,
        source_contract: Some(address(79)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;

    let mut ledger = CapitalCensusLedger::default();
    ledger.register_source(external)?;
    ledger.register_source(operator)?;
    ledger.register_requirement(req)?;
    ledger.evaluate_all()?;
    let summary = ledger.summary()?;
    assert!(summary.is_conserved());
    assert!(summary.uses_zero_operator_capital());
    assert!(!summary.proves_zero_own_capital());
    assert_eq!(summary.operator_owned_sources_observed, 1);
    assert_eq!(summary.operator_owned_sources_used, 0);
    assert_eq!(summary.feasible_count, 1);
    assert_eq!(summary.feasible_external_gas_count, 0);
    Ok(())
}

#[test]
fn source_key_is_stable_across_state_refreshes() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let second = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(101),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(2_000),
        fee_model: FeeModel::basis_points(30)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(9_000, Amount256::from_u128(10))?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::FeeChanged,
        ],
        evidence: evidence(),
    })?;
    assert_eq!(first.key_id(), second.key_id());
    assert_ne!(first.id(), second.id());
    Ok(())
}

#[test]
fn source_key_is_stable_across_ownership_changes() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let make = |ownership| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::TransientCredit,
            anchor: anchor(100),
            provider_namespace: 77,
            provider_locator_hash: hash(78),
            provider_kind: CapitalProviderKind::BuilderOrSolver,
            ownership,
            source_contract: Some(address(79)),
            asset: token,
            maximum_available: Amount256::from_u128(1_000),
            fee_model: FeeModel::basis_points(5)?,
            repayment_asset: token,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![CapitalFailureMode::SourceUnavailable],
            evidence: evidence(),
        })
    };
    let external = make(CapitalOwnership::External)?;
    let operator_owned = make(CapitalOwnership::OperatorOwned)?;
    assert_eq!(external.key_id(), operator_owned.key_id());
    assert_ne!(external.id(), operator_owned.id());
    Ok(())
}

#[test]
fn repayment_obligation_does_not_double_count_initial_capital() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let only_exact_principal = source(
        CapitalClass::FlashSwap,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert!(matches!(
        evaluate_capital_feasibility(&req, &[only_exact_principal]),
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn ledger_commitment_is_registration_order_independent() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let primary = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let spare = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::AtomicFlashLiquidity,
        anchor: anchor(100),
        provider_namespace: 21,
        provider_locator_hash: hash(22),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(23)),
        asset: token,
        maximum_available: Amount256::from_u128(50),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;

    let mut first = CapitalCensusLedger::default();
    first.register_source(primary.clone())?;
    first.register_source(spare.clone())?;
    first.register_requirement(req.clone())?;
    first.evaluate_all()?;

    let mut second = CapitalCensusLedger::default();
    second.register_source(spare)?;
    second.register_source(primary)?;
    second.register_requirement(req)?;
    second.evaluate_all()?;

    assert_eq!(first.commitment()?, second.commitment()?);
    Ok(())
}

#[test]
fn ledger_commitment_changes_with_observed_capacity() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(10),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    let make_source = |maximum| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::FlashSwap,
            anchor: anchor(100),
            provider_namespace: 11,
            provider_locator_hash: hash(12),
            provider_kind: CapitalProviderKind::DexLiquidityPool,
            ownership: CapitalOwnership::External,
            source_contract: Some(address(13)),
            asset: token,
            maximum_available: Amount256::from_u128(maximum),
            fee_model: FeeModel::None,
            repayment_asset: token,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![CapitalFailureMode::CapacityChanged],
            evidence: evidence(),
        })
    };

    let mut first = CapitalCensusLedger::default();
    first.register_source(make_source(100)?)?;
    first.register_requirement(req.clone())?;
    first.evaluate_all()?;

    let mut second = CapitalCensusLedger::default();
    second.register_source(make_source(200)?)?;
    second.register_requirement(req)?;
    second.evaluate_all()?;

    assert_ne!(first.commitment()?, second.commitment()?);
    Ok(())
}

#[test]
fn fee_quotes_are_integer_exact_across_full_uint256_domain() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let bps = FeeModel::basis_points(5)?
        .quote(Amount256::from_u128(10_000), token)?
        .ok_or("missing bps fee quote")?;
    assert_eq!(bps.asset, token);
    assert_eq!(bps.amount, Amount256::from_u128(5));

    let ratio = FeeModel::exact_ratio(3, 1_000)?
        .quote(Amount256::from_u128(10_000), token)?
        .ok_or("missing ratio fee quote")?;
    assert_eq!(ratio.amount, Amount256::from_u128(30));

    let mut maximum = [0xff_u8; 32];
    maximum[0] = 0x80;
    let half = FeeModel::exact_ratio(1, 2)?
        .quote(Amount256::from_be_bytes(maximum), token)?
        .ok_or("missing full-width fee quote")?;
    let mut expected = [0xff_u8; 32];
    expected[0] = 0x40;
    expected[1] = 0x7f;
    assert_eq!(half.amount, Amount256::from_be_bytes(expected));
    Ok(())
}

#[test]
fn fee_quote_rejects_uint256_overflow() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let maximum = Amount256::from_be_bytes([0xff; 32]);
    assert!(FeeModel::exact_ratio(2, 1)?.quote(maximum, token).is_err());
    Ok(())
}

#[test]
fn fixed_fee_preserves_explicit_fee_asset() -> TestResult {
    let borrowed = CapitalAsset::Token(address(20));
    let fee_asset = CapitalAsset::Token(address(21));
    let quote = FeeModel::Fixed {
        asset: fee_asset,
        amount: Amount256::from_u128(77),
    }
    .quote(Amount256::from_u128(1_000), borrowed)?
    .ok_or("missing fixed fee quote")?;
    assert_eq!(quote.asset, fee_asset);
    assert_eq!(quote.amount, Amount256::from_u128(77));
    Ok(())
}

#[test]
fn fee_rounding_matches_protocol_integer_semantics() -> TestResult {
    let token = CapitalAsset::Token(address(20));

    // Aave-style percentage math uses half-up rounding.
    let aave_like = FeeModel::basis_points_with_rounding(5, RoundingMode::HalfUp)?
        .quote(Amount256::from_u128(1_000), token)?
        .ok_or("missing half-up quote")?;
    assert_eq!(aave_like.amount, Amount256::from_u128(1));

    let floor = FeeModel::basis_points(5)?
        .quote(Amount256::from_u128(1_000), token)?
        .ok_or("missing floor quote")?;
    assert_eq!(floor.amount, Amount256::ZERO);

    // Balancer-style fixed-point fee math rounds a non-zero remainder upward.
    let balancer_like = FeeModel::exact_ratio_with_rounding(1, 1_000, RoundingMode::Ceil)?
        .quote(Amount256::from_u128(1_001), token)?
        .ok_or("missing ceil quote")?;
    assert_eq!(balancer_like.amount, Amount256::from_u128(2));
    Ok(())
}

#[test]
fn synthetic_ledger_cannot_be_misreported_as_real_certification() -> TestResult {
    let ledger = CapitalCensusLedger::synthetic_fixture();
    assert!(matches!(
        ledger.certify(&certification_context_for(&ledger)?),
        Err(nqc_census_capital::CapitalError::NonEvidentiaryLedger)
    ));
    Ok(())
}

#[test]
fn evidentiary_certification_requires_consumed_d08_and_d09_receipts() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(external)?;
    ledger.evaluate_all()?;

    let context = certification_context_for(&ledger)?;
    let bare = CapitalCertificationContext::new(
        context.stages().to_vec(),
        context.admitted_evidence().copied().collect(),
    )?;
    assert!(matches!(
        ledger.certify(&bare),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}

#[test]
fn consumption_receipts_fail_closed_on_wrong_authority_or_duplicate_stage() -> TestResult {
    let ledger = CapitalCensusLedger::evidentiary();
    let context = certification_context_for(&ledger)?;
    let stages = context.stages().to_vec();
    let admitted_evidence = context.admitted_evidence().copied().collect::<Vec<_>>();
    let d08_artifact = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing RMC-008 authority")?
        .artifact_sha256;
    let d09_artifact = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or("missing RMC-009 authority")?
        .artifact_sha256;

    let wrong_authority =
        CapitalCertificationContext::new(stages.clone(), admitted_evidence.clone())?
            .with_consumption_receipts(vec![
                UpstreamConsumptionReceipt::for_sources(hash(90), hash(80), ledger.sources())?,
                UpstreamConsumptionReceipt::for_requirements(
                    d09_artifact,
                    hash(81),
                    ledger.requirements(),
                )?,
            ]);
    assert!(matches!(
        wrong_authority,
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));

    let duplicate = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![
            UpstreamConsumptionReceipt::for_sources(d08_artifact, hash(80), ledger.sources())?,
            UpstreamConsumptionReceipt::for_sources(d08_artifact, hash(82), ledger.sources())?,
        ]);
    assert!(matches!(
        duplicate,
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}

#[test]
fn certification_rejects_source_or_requirement_sets_not_consumed_upstream() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    let mut admitted = CapitalCensusLedger::evidentiary();
    admitted.register_source(first.clone())?;
    admitted.evaluate_all()?;
    let authority = certification_context_for(&admitted)?;

    let second = source(
        CapitalClass::AtomicFlashLiquidity,
        token,
        2_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let mut extra_source = CapitalCensusLedger::evidentiary();
    extra_source.register_source(first.clone())?;
    extra_source.register_source(second)?;
    extra_source.evaluate_all()?;
    assert!(matches!(
        extra_source.certify(&authority),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));

    let req = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let mut extra_requirement = CapitalCensusLedger::evidentiary();
    extra_requirement.register_source(first)?;
    extra_requirement.register_requirement(req)?;
    extra_requirement.evaluate_all()?;
    assert!(matches!(
        extra_requirement.certify(&authority),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}

#[test]
fn consumed_output_set_commitment_is_order_independent() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let second = source(
        CapitalClass::AtomicFlashLiquidity,
        token,
        2_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let left = UpstreamConsumptionReceipt::for_sources(hash(23), hash(80), [&first, &second])?;
    let right = UpstreamConsumptionReceipt::for_sources(hash(23), hash(80), [&second, &first])?;
    assert_eq!(left.output_count(), 2);
    assert_eq!(left.output_set_commitment(), right.output_set_commitment());
    Ok(())
}

#[test]
fn evidentiary_ledger_requires_nonempty_source_census() -> TestResult {
    let ledger = CapitalCensusLedger::evidentiary();
    assert!(matches!(
        ledger.certify(&certification_context_for(&ledger)?),
        Err(nqc_census_capital::CapitalError::EmptyCapitalCensus)
    ));
    Ok(())
}

#[test]
fn evidentiary_source_census_can_certify_without_actionable_requirements() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(external)?;
    ledger.evaluate_all()?;
    let certificate = ledger.certify(&certification_context_for(&ledger)?)?;

    assert_eq!(certificate.summary.source_count, 1);
    assert_eq!(certificate.summary.requirement_count, 0);
    assert_eq!(certificate.summary.feasible_count, 0);
    assert_eq!(certificate.summary.rejected_count, 0);
    assert!(!certificate.summary.proves_zero_own_capital());
    Ok(())
}

#[test]
fn evidentiary_ledger_certifies_only_after_evaluation() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let exact_repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, exact_repayment],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(external)?;
    ledger.register_requirement(req)?;
    assert!(matches!(
        ledger.certify(&certification_context_for(&ledger)?),
        Err(nqc_census_capital::CapitalError::UnevaluatedRequirement)
    ));
    ledger.evaluate_all()?;
    let certificate = ledger.certify(&certification_context_for(&ledger)?)?;
    assert!(certificate.summary.is_conserved());
    assert!(certificate.summary.uses_zero_operator_capital());
    assert!(!certificate.summary.proves_zero_own_capital());
    assert_eq!(certificate.summary.feasible_count, 1);
    assert_eq!(certificate.summary.feasible_external_gas_count, 0);
    Ok(())
}

#[test]
fn settlement_obligations_separate_principal_repayment_from_funding_fee() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(1_000),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(1_000),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let fee = CapitalRequirementLeg::new(
        RequirementKind::FundingFee,
        token,
        Amount256::from_u128(1),
        vec![CapitalClass::ProtocolNativeFlashLoan],
    )?;
    let req = requirement(
        vec![principal, repayment, fee],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::ProtocolNativeFlashLoan,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(10_000),
        fee_model: FeeModel::basis_points_with_rounding(5, RoundingMode::HalfUp)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let sources = vec![source];
    let result = evaluate_capital_feasibility(&req, &sources);
    let obligations = nqc_census_capital::derive_settlement_obligations(&result, &sources)?;
    assert_eq!(obligations.len(), 2);
    assert!(obligations.iter().any(|obligation| {
        obligation.kind == RequirementKind::Repayment
            && obligation.amount == Amount256::from_u128(1_000)
    }));
    assert!(obligations.iter().any(|obligation| {
        obligation.kind == RequirementKind::FundingFee
            && obligation.amount == Amount256::from_u128(1)
    }));
    nqc_census_capital::validate_settlement_requirements(&req, &result, &sources)?;
    Ok(())
}

#[test]
fn wrong_settlement_amount_is_rejected_during_feasibility_not_certification() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let wrong_repayment = CapitalRequirementLeg::new(
        RequirementKind::Repayment,
        token,
        Amount256::from_u128(99),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, wrong_repayment],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let external = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(external)?;
    ledger.register_requirement(req)?;
    ledger.evaluate_all()?;
    assert!(matches!(
        ledger.results().next(),
        Some(CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::SettlementRequirementMismatch,
            failed_leg: None,
            ..
        })
    ));
    let certificate = ledger.certify(&certification_context_for(&ledger)?)?;
    assert_eq!(certificate.summary.feasible_count, 0);
    assert_eq!(certificate.summary.rejected_count, 1);
    Ok(())
}

#[test]
fn missing_funding_fee_is_rejected_during_feasibility() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(1_000),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(1_000),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::ProtocolNativeFlashLoan,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(10_000),
        fee_model: FeeModel::basis_points_with_rounding(5, RoundingMode::HalfUp)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::SettlementRequirementMismatch,
            failed_leg: None,
            ..
        }
    ));
    Ok(())
}

#[test]
fn repayment_leg_must_allow_the_actual_allocated_source_class() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::GasFunding],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let source = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::SettlementRequirementMismatch,
            failed_leg: None,
            ..
        }
    ));
    Ok(())
}

#[test]
fn funding_fee_leg_must_allow_the_actual_fee_source_class() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(1_000),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(1_000),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::FundingFee,
                token,
                Amount256::from_u128(1),
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::ProtocolNativeFlashLoan,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ProtocolContract,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(10_000),
        fee_model: FeeModel::basis_points_with_rounding(5, RoundingMode::HalfUp)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::SettlementRequirementMismatch,
            failed_leg: None,
            ..
        }
    ));
    Ok(())
}

#[test]
fn settlement_class_amounts_cannot_be_swapped_between_source_classes() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(200),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(200),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let flash_swap = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let flash_loan = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &requirement,
            &[flash_swap, flash_loan],
        )?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::SettlementRequirementMismatch,
            failed_leg: None,
            ..
        }
    ));
    Ok(())
}

#[test]
fn settlement_leg_can_split_exact_amount_across_authorized_source_classes() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(200),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(300),
                vec![
                    CapitalClass::FlashSwap,
                    CapitalClass::ProtocolNativeFlashLoan,
                ],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let flash_swap = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let flash_loan = source(
        CapitalClass::ProtocolNativeFlashLoan,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &requirement,
            &[flash_swap, flash_loan],
        )?,
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn no_repayment_gas_source_needs_no_principal_repayment_leg() -> TestResult {
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(10),
        vec![CapitalClass::GasFunding],
    )?;
    let requirement = requirement(vec![gas], RequiredAtomicity::SameTransaction, true)?;
    let sponsor = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::GasFunding,
        anchor: anchor(100),
        provider_namespace: 88,
        provider_locator_hash: hash(89),
        provider_kind: CapitalProviderKind::ExternalSponsor,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(90)),
        asset: CapitalAsset::NativeGas,
        maximum_available: Amount256::from_u128(100),
        fee_model: FeeModel::None,
        repayment_asset: CapitalAsset::NativeGas,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;
    let sources = vec![sponsor];
    let result = evaluate_capital_feasibility(&requirement, &sources);
    assert!(matches!(result, CapitalFeasibility::Feasible { .. }));
    assert!(nqc_census_capital::derive_settlement_obligations(&result, &sources)?.is_empty());
    nqc_census_capital::validate_settlement_requirements(&requirement, &result, &sources)?;
    Ok(())
}

#[test]
fn no_repayment_gas_sponsor_fee_must_still_be_declared() -> TestResult {
    let fee_asset = CapitalAsset::Token(address(91));
    let gas = CapitalRequirementLeg::new(
        RequirementKind::Gas,
        CapitalAsset::NativeGas,
        Amount256::from_u128(10),
        vec![CapitalClass::GasFunding],
    )?;
    let funding_fee = CapitalRequirementLeg::new(
        RequirementKind::FundingFee,
        fee_asset,
        Amount256::from_u128(3),
        vec![CapitalClass::GasFunding],
    )?;
    let requirement = requirement(
        vec![gas, funding_fee],
        RequiredAtomicity::SameTransaction,
        true,
    )?;
    let sponsor = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::GasFunding,
        anchor: anchor(100),
        provider_namespace: 88,
        provider_locator_hash: hash(89),
        provider_kind: CapitalProviderKind::ExternalSponsor,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(90)),
        asset: CapitalAsset::NativeGas,
        maximum_available: Amount256::from_u128(100),
        fee_model: FeeModel::Fixed {
            asset: fee_asset,
            amount: Amount256::from_u128(3),
        },
        repayment_asset: fee_asset,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::FeeChanged],
        evidence: evidence(),
    })?;
    let sources = vec![sponsor];
    let result = evaluate_capital_feasibility(&requirement, &sources);
    assert!(matches!(result, CapitalFeasibility::Feasible { .. }));
    nqc_census_capital::validate_settlement_requirements(&requirement, &result, &sources)?;
    Ok(())
}

#[test]
fn final_certification_requires_every_upstream_stage_exactly_once() -> TestResult {
    let ledger = CapitalCensusLedger::evidentiary();
    let context = certification_context_for(&ledger)?;
    assert_eq!(context.stages().len(), 5);

    let incomplete = CapitalCertificationContext::new(context.stages()[..4].to_vec(), evidence());
    assert!(matches!(
        incomplete,
        Err(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
            _
        ))
    ));

    let mut duplicate = context.stages().to_vec();
    duplicate[4] = duplicate[3].clone();
    assert!(matches!(
        CapitalCertificationContext::new(duplicate, evidence()),
        Err(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
            _
        ))
    ));
    Ok(())
}

#[test]
fn certification_context_requires_every_stage_artifact_in_evidence_catalog() -> TestResult {
    let ledger = CapitalCensusLedger::evidentiary();
    let context = certification_context_for(&ledger)?;
    let stages = context.stages().to_vec();
    let mut admitted_evidence = evidence();
    admitted_evidence.extend(
        stages
            .iter()
            .skip(1)
            .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256)),
    );
    assert!(matches!(
        CapitalCertificationContext::new(stages, admitted_evidence),
        Err(CapitalError::InvalidUpstreamAuthority(_))
    ));
    Ok(())
}

#[test]
fn upstream_authority_rejects_mismatch_unknown_or_unadmitted_stage() -> TestResult {
    let commit = GitObjectId::parse_hex("1111111111111111111111111111111111111111")?;
    let tree = GitObjectId::parse_hex("2222222222222222222222222222222222222222")?;
    for (mismatch, unknown, coverage_complete, admitted) in [
        (1, 0, true, true),
        (0, 1, true, true),
        (0, 0, false, true),
        (0, 0, true, false),
    ] {
        assert!(matches!(
            UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
                stage: UpstreamCensusStage::Rmc008StateAdmission,
                code_commit: commit,
                code_tree: tree,
                artifact_sha256: hash(33),
                observation_anchor: anchor(100),
                unresolved_mismatch_count: mismatch,
                unknown_failure_count: unknown,
                coverage_complete,
                admitted,
            }),
            Err(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                _
            ))
        ));
    }
    Ok(())
}

#[test]
fn git_object_ids_are_exact_lowercase_sha1_hex_width() -> TestResult {
    let valid = GitObjectId::parse_hex("0123456789abcdef0123456789abcdef01234567")?;
    assert_eq!(valid.to_hex(), "0123456789abcdef0123456789abcdef01234567");
    assert!(GitObjectId::parse_hex("abc").is_err());
    assert!(GitObjectId::parse_hex("0000000000000000000000000000000000000000").is_err());
    assert!(GitObjectId::parse_hex("0123456789ABCDEF0123456789ABCDEF01234567").is_err());
    Ok(())
}

#[test]
fn compatible_source_at_foreign_anchor_is_classified_as_anchor_mismatch() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(100),
        vec![CapitalClass::FlashSwap],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    let foreign = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(101),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;

    let unrelated_same_anchor = source(
        CapitalClass::ProtocolNativeFlashLoan,
        CapitalAsset::Token(address(21)),
        1_000,
        CapitalAsset::Token(address(21)),
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    assert!(matches!(
        evaluate_capital_feasibility(&req, &[unrelated_same_anchor, foreign]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::AnchorMismatch,
            ..
        }
    ));
    Ok(())
}

#[test]
fn multiple_operator_sources_are_aggregated_before_zero_own_capital_rejection() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let principal = CapitalRequirementLeg::new(
        RequirementKind::ActionPrincipal,
        token,
        Amount256::from_u128(150),
        vec![CapitalClass::InventoryRequirement],
    )?;
    let req = requirement(
        vec![principal, repayment_leg(token)?],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    let operator = |namespace, locator, contract| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::InventoryRequirement,
            anchor: anchor(100),
            provider_namespace: namespace,
            provider_locator_hash: hash(locator),
            provider_kind: CapitalProviderKind::OperatorTreasury,
            ownership: CapitalOwnership::OperatorOwned,
            source_contract: Some(address(contract)),
            asset: token,
            maximum_available: Amount256::from_u128(100),
            fee_model: FeeModel::None,
            repayment_asset: token,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![CapitalFailureMode::SourceUnavailable],
            evidence: evidence(),
        })
    };

    assert!(matches!(
        evaluate_capital_feasibility(&req, &[operator(31, 32, 33)?, operator(41, 42, 43)?]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::OperatorOwnedCapitalRequired,
            ..
        }
    ));
    Ok(())
}

#[test]
fn zero_own_capital_claim_requires_at_least_one_feasible_requirement() -> TestResult {
    let summary = nqc_census_capital::CapitalCensusSummary {
        source_count: 1,
        requirement_count: 1,
        feasible_count: 0,
        feasible_external_gas_count: 0,
        rejected_count: 1,
        operator_owned_sources_observed: 0,
        operator_owned_sources_used: 0,
        sources_by_class: std::collections::BTreeMap::new(),
    };
    assert!(summary.uses_zero_operator_capital());
    assert!(!summary.proves_zero_own_capital());
    Ok(())
}

#[test]
fn collateralized_borrowing_can_bind_full_persistent_risk_semantics() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let collateral = CapitalAsset::Token(address(21));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(31),
        liquidation_model_hash: hash(32),
        solvency_model_hash: hash(33),
        oracle_risk_hash: hash(34),
        liquidity_withdrawal_risk_hash: hash(35),
        facility_disappearance_risk_hash: hash(36),
    };
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::CollateralizedBorrowing,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::Persistent(terms),
        collateral: CollateralRequirement::Required {
            asset: collateral,
            amount: Amount256::from_u128(250),
            liquidation_conditions_hash: hash(37),
        },
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CollateralLiquidation,
            CapitalFailureMode::OracleRisk,
            CapitalFailureMode::LiquidityWithdrawal,
            CapitalFailureMode::FacilityDisappearance,
        ],
        evidence: evidence(),
    })?;

    assert_eq!(source.class(), CapitalClass::CollateralizedBorrowing);
    assert!(matches!(
        source.repayment(),
        RepaymentSemantics::Persistent(_)
    ));
    Ok(())
}

#[test]
fn allocation_engine_reroutes_scarce_source_instead_of_greedy_false_negative() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let flash_swap = source(
        CapitalClass::FlashSwap,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let atomic = source(
        CapitalClass::AtomicFlashLiquidity,
        token,
        100,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    let (scarce_class, other_class) = if flash_swap.id() < atomic.id() {
        (CapitalClass::FlashSwap, CapitalClass::AtomicFlashLiquidity)
    } else {
        (CapitalClass::AtomicFlashLiquidity, CapitalClass::FlashSwap)
    };

    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(70)),
        anchor(100),
        RequiredAtomicity::SameTransaction,
        false,
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![scarce_class, other_class],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::ProtocolFee,
                token,
                Amount256::from_u128(100),
                vec![scarce_class],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(200),
                vec![scarce_class, other_class],
            )?,
        ],
        evidence(),
    )?;

    let result = nqc_census_capital::evaluate_capital_feasibility_checked(
        &requirement,
        &[flash_swap, atomic],
    )?;
    assert!(matches!(result, CapitalFeasibility::Feasible { .. }));
    Ok(())
}

#[test]
fn collateral_requirement_cannot_be_funded_circularly_by_collateralized_source() -> TestResult {
    let borrowed = CapitalAsset::Token(address(20));
    let collateral_asset = CapitalAsset::Token(address(21));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(41),
        liquidation_model_hash: hash(42),
        solvency_model_hash: hash(43),
        oracle_risk_hash: hash(44),
        liquidity_withdrawal_risk_hash: hash(45),
        facility_disappearance_risk_hash: hash(46),
    };
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::CollateralizedBorrowing,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: collateral_asset,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: borrowed,
        repayment: RepaymentSemantics::Persistent(terms),
        collateral: CollateralRequirement::Required {
            asset: collateral_asset,
            amount: Amount256::from_u128(100),
            liquidation_conditions_hash: hash(47),
        },
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CollateralLiquidation,
            CapitalFailureMode::OracleRisk,
        ],
        evidence: evidence(),
    })?;
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(71)),
        anchor(100),
        RequiredAtomicity::Flexible,
        false,
        vec![CapitalRequirementLeg::new(
            RequirementKind::Collateral,
            collateral_asset,
            Amount256::from_u128(100),
            vec![CapitalClass::CollateralizedBorrowing],
        )?],
        evidence(),
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::NoCompatibleSource,
            failed_leg: Some(RequirementKind::Collateral),
            ..
        }
    ));
    Ok(())
}

#[test]
fn checked_feasibility_rejects_duplicate_source_capacity() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let second_state = source(
        CapitalClass::FlashSwap,
        token,
        2_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    assert_eq!(first.key_id(), second_state.key_id());
    assert_ne!(first.id(), second_state.id());

    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(1_500),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    let duplicate_id = nqc_census_capital::evaluate_capital_feasibility_checked(
        &requirement,
        &[first.clone(), first.clone()],
    );
    assert!(matches!(duplicate_id, Err(CapitalError::DuplicateSource)));

    let duplicate_key = nqc_census_capital::evaluate_capital_feasibility_checked(
        &requirement,
        &[first, second_state],
    );
    assert!(matches!(
        duplicate_key,
        Err(CapitalError::ConflictingSourceState)
    ));
    Ok(())
}

#[test]
fn ledger_rejects_multiple_states_for_same_stable_source_key() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let first = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: evidence(),
    })?;
    let second = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(2_000),
        fee_model: FeeModel::basis_points(30)?,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::FeeChanged,
        ],
        evidence: evidence(),
    })?;

    assert_eq!(first.key_id(), second.key_id());
    assert_ne!(first.id(), second.id());

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(first)?;
    assert!(matches!(
        ledger.register_source(second),
        Err(nqc_census_capital::CapitalError::ConflictingSourceState)
    ));
    Ok(())
}

#[test]
fn stable_source_key_does_not_alias_different_asset_or_class() -> TestResult {
    let token_a = CapitalAsset::Token(address(20));
    let token_b = CapitalAsset::Token(address(21));
    let base = source(
        CapitalClass::FlashSwap,
        token_a,
        1_000,
        token_a,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let different_asset = source(
        CapitalClass::FlashSwap,
        token_b,
        1_000,
        token_b,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let different_class = source(
        CapitalClass::AtomicFlashLiquidity,
        token_a,
        1_000,
        token_a,
        RepaymentSemantics::AtomicSameTransaction,
    )?;

    assert_ne!(base.key_id(), different_asset.key_id());
    assert_ne!(base.key_id(), different_class.key_id());
    Ok(())
}

#[test]
fn collateral_dependencies_are_aggregated_across_all_used_sources() -> TestResult {
    let principal_asset = CapitalAsset::Token(address(20));
    let collateral_asset = CapitalAsset::Token(address(21));
    let make_credit = |namespace: u16, locator: u8| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::TransientCredit,
            anchor: anchor(100),
            provider_namespace: namespace,
            provider_locator_hash: hash(locator),
            provider_kind: CapitalProviderKind::ExternalCreditFacility,
            ownership: CapitalOwnership::External,
            source_contract: Some(address(locator)),
            asset: principal_asset,
            maximum_available: Amount256::from_u128(50),
            fee_model: FeeModel::None,
            repayment_asset: principal_asset,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::Required {
                asset: collateral_asset,
                amount: Amount256::from_u128(75),
                liquidation_conditions_hash: hash(locator.saturating_add(20)),
            },
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::None,
            failure_modes: vec![
                CapitalFailureMode::CollateralLiquidation,
                CapitalFailureMode::RepaymentFailure,
            ],
            evidence: evidence(),
        })
    };
    let first = make_credit(101, 31)?;
    let second = make_credit(102, 32)?;
    let collateral_funder = source(
        CapitalClass::FlashSwap,
        collateral_asset,
        150,
        collateral_asset,
        RepaymentSemantics::NoRepayment,
    )?;

    let make_requirement = |collateral_amount| {
        CapitalRequirement::new(
            CapitalTargetId::from_hash(hash(91)),
            anchor(100),
            RequiredAtomicity::SameTransaction,
            false,
            vec![
                CapitalRequirementLeg::new(
                    RequirementKind::ActionPrincipal,
                    principal_asset,
                    Amount256::from_u128(100),
                    vec![CapitalClass::TransientCredit],
                )?,
                CapitalRequirementLeg::new(
                    RequirementKind::Collateral,
                    collateral_asset,
                    Amount256::from_u128(collateral_amount),
                    vec![CapitalClass::FlashSwap],
                )?,
                CapitalRequirementLeg::new(
                    RequirementKind::Repayment,
                    principal_asset,
                    Amount256::from_u128(100),
                    vec![CapitalClass::TransientCredit],
                )?,
            ],
            evidence(),
        )
    };

    let underfunded = make_requirement(100)?;
    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &underfunded,
            &[first.clone(), second.clone(), collateral_funder.clone()],
        )?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::CollateralRequirementUnfunded,
            failed_leg: Some(RequirementKind::Collateral),
            ..
        }
    ));

    let sufficient = make_requirement(150)?;
    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &sufficient,
            &[first, second, collateral_funder],
        )?,
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn temporary_lock_dependencies_are_aggregated_across_all_used_sources() -> TestResult {
    let principal_asset = CapitalAsset::Token(address(20));
    let lock_asset = CapitalAsset::Token(address(22));
    let make_credit = |namespace: u16, locator: u8| {
        CapitalSource::new(CapitalSourceSpec {
            class: CapitalClass::TransientCredit,
            anchor: anchor(100),
            provider_namespace: namespace,
            provider_locator_hash: hash(locator),
            provider_kind: CapitalProviderKind::ExternalCreditFacility,
            ownership: CapitalOwnership::External,
            source_contract: Some(address(locator)),
            asset: principal_asset,
            maximum_available: Amount256::from_u128(50),
            fee_model: FeeModel::None,
            repayment_asset: principal_asset,
            repayment: RepaymentSemantics::AtomicSameTransaction,
            collateral: CollateralRequirement::None,
            utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
            caps: CapitalCaps::none(),
            temporary_lock: TemporaryLock::Required {
                asset: lock_asset,
                amount: Amount256::from_u128(75),
                release: nqc_census_capital::LockRelease::EndOfTransaction,
            },
            failure_modes: vec![
                CapitalFailureMode::SourceUnavailable,
                CapitalFailureMode::RepaymentFailure,
            ],
            evidence: evidence(),
        })
    };
    let first = make_credit(111, 41)?;
    let second = make_credit(112, 42)?;
    let lock_funder = source(
        CapitalClass::FlashSwap,
        lock_asset,
        150,
        lock_asset,
        RepaymentSemantics::NoRepayment,
    )?;

    let make_requirement = |lock_amount| {
        CapitalRequirement::new(
            CapitalTargetId::from_hash(hash(92)),
            anchor(100),
            RequiredAtomicity::SameTransaction,
            false,
            vec![
                CapitalRequirementLeg::new(
                    RequirementKind::ActionPrincipal,
                    principal_asset,
                    Amount256::from_u128(100),
                    vec![CapitalClass::TransientCredit],
                )?,
                CapitalRequirementLeg::new(
                    RequirementKind::TemporaryLock,
                    lock_asset,
                    Amount256::from_u128(lock_amount),
                    vec![CapitalClass::FlashSwap],
                )?,
                CapitalRequirementLeg::new(
                    RequirementKind::Repayment,
                    principal_asset,
                    Amount256::from_u128(100),
                    vec![CapitalClass::TransientCredit],
                )?,
            ],
            evidence(),
        )
    };

    let underfunded = make_requirement(100)?;
    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &underfunded,
            &[first.clone(), second.clone(), lock_funder.clone()],
        )?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::TemporaryLockUnfunded,
            failed_leg: Some(RequirementKind::TemporaryLock),
            ..
        }
    ));

    let sufficient = make_requirement(150)?;
    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(
            &sufficient,
            &[first, second, lock_funder],
        )?,
        CapitalFeasibility::Feasible { .. }
    ));
    Ok(())
}

#[test]
fn collateral_leg_rejects_source_that_requires_temporary_lock() -> TestResult {
    let collateral_asset = CapitalAsset::Token(address(21));
    let lock_asset = CapitalAsset::Token(address(22));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 61,
        provider_locator_hash: hash(62),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(63)),
        asset: collateral_asset,
        maximum_available: Amount256::from_u128(500),
        fee_model: FeeModel::None,
        repayment_asset: collateral_asset,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::Required {
            asset: lock_asset,
            amount: Amount256::from_u128(50),
            release: nqc_census_capital::LockRelease::EndOfTransaction,
        },
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;

    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(81)),
        anchor(100),
        RequiredAtomicity::SameTransaction,
        false,
        vec![CapitalRequirementLeg::new(
            RequirementKind::Collateral,
            collateral_asset,
            Amount256::from_u128(100),
            vec![CapitalClass::InventoryRequirement],
        )?],
        evidence(),
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::NoCompatibleSource,
            failed_leg: Some(RequirementKind::Collateral),
            ..
        }
    ));
    Ok(())
}

#[test]
fn temporary_lock_leg_rejects_source_that_requires_collateral() -> TestResult {
    let lock_asset = CapitalAsset::Token(address(22));
    let collateral_asset = CapitalAsset::Token(address(21));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 71,
        provider_locator_hash: hash(72),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(73)),
        asset: lock_asset,
        maximum_available: Amount256::from_u128(500),
        fee_model: FeeModel::None,
        repayment_asset: lock_asset,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::Required {
            asset: collateral_asset,
            amount: Amount256::from_u128(50),
            liquidation_conditions_hash: hash(74),
        },
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::CollateralLiquidation,
            CapitalFailureMode::OracleRisk,
        ],
        evidence: evidence(),
    })?;

    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(82)),
        anchor(100),
        RequiredAtomicity::SameTransaction,
        false,
        vec![CapitalRequirementLeg::new(
            RequirementKind::TemporaryLock,
            lock_asset,
            Amount256::from_u128(100),
            vec![CapitalClass::InventoryRequirement],
        )?],
        evidence(),
    )?;

    assert!(matches!(
        nqc_census_capital::evaluate_capital_feasibility_checked(&requirement, &[source])?,
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::NoCompatibleSource,
            failed_leg: Some(RequirementKind::TemporaryLock),
            ..
        }
    ));
    Ok(())
}

#[test]
fn certification_context_rejects_mixed_upstream_anchors() -> TestResult {
    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let value = u8::try_from(index + 1)?;
        let stage_anchor = if stage == UpstreamCensusStage::Rmc010IncrementalParity {
            anchor(101)
        } else {
            anchor(100)
        };
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{value:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", u64::from(value) + 10))?,
            artifact_sha256: hash(value.saturating_add(20)),
            observation_anchor: stage_anchor,
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        })?);
    }
    assert!(matches!(
        CapitalCertificationContext::new(stages, evidence()),
        Err(nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
            _
        ))
    ));
    Ok(())
}

#[test]
fn evidentiary_ledger_cannot_certify_against_a_different_anchor() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let source = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;

    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let value = u8::try_from(index + 1)?;
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{value:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", u64::from(value) + 10))?,
            artifact_sha256: hash(value.saturating_add(20)),
            observation_anchor: anchor(101),
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        })?);
    }
    let mut admitted_evidence = evidence();
    admitted_evidence.extend(
        stages
            .iter()
            .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256)),
    );
    let authority = CapitalCertificationContext::new(stages, admitted_evidence)?;
    assert!(matches!(
        ledger.certify(&authority),
        Err(nqc_census_capital::CapitalError::AnchorMismatch)
    ));
    Ok(())
}

#[test]
fn certification_rejects_evidence_not_admitted_by_upstream_authority() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let source = source(
        CapitalClass::FlashSwap,
        token,
        1_000,
        token,
        RepaymentSemantics::AtomicSameTransaction,
    )?;
    let requirement = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(100),
                vec![CapitalClass::FlashSwap],
            )?,
            repayment_leg(token)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;

    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let value = u8::try_from(index + 1)?;
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{value:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", u64::from(value) + 10))?,
            artifact_sha256: hash(value.saturating_add(20)),
            observation_anchor: anchor(100),
            unresolved_mismatch_count: 0,
            unknown_failure_count: 0,
            coverage_complete: true,
            admitted: true,
        })?);
    }
    let mut admitted_evidence = vec![CapitalEvidenceRef::Artifact(hash(98))];
    admitted_evidence.extend(
        stages
            .iter()
            .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256)),
    );
    let authority = CapitalCertificationContext::new(stages, admitted_evidence)?;
    assert!(matches!(
        ledger.certify(&authority),
        Err(nqc_census_capital::CapitalError::UnresolvedEvidenceRef)
    ));
    Ok(())
}

#[test]
fn zero_own_capital_rejects_operator_owned_builder_source() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::TransientCredit,
        anchor: anchor(100),
        provider_namespace: 77,
        provider_locator_hash: hash(78),
        provider_kind: CapitalProviderKind::BuilderOrSolver,
        ownership: CapitalOwnership::OperatorOwned,
        source_contract: Some(address(79)),
        asset,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::basis_points(5)?,
        repayment_asset: asset,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    })?;
    let req = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                asset,
                Amount256::from_u128(100),
                vec![CapitalClass::TransientCredit],
            )?,
            repayment_leg(asset)?,
        ],
        RequiredAtomicity::SameTransaction,
        false,
    )?;

    assert!(matches!(
        evaluate_capital_feasibility(&req, &[source]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::OperatorOwnedCapitalRequired,
            ..
        }
    ));
    Ok(())
}

#[test]
fn operator_treasury_cannot_claim_external_ownership() -> TestResult {
    let asset = CapitalAsset::Token(address(20));
    let result = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 88,
        provider_locator_hash: hash(89),
        provider_kind: CapitalProviderKind::OperatorTreasury,
        ownership: CapitalOwnership::External,
        source_contract: None,
        asset,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: asset,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::SourceUnavailable],
        evidence: evidence(),
    });
    assert!(matches!(
        result,
        Err(nqc_census_capital::CapitalError::OwnershipProviderMismatch)
    ));
    Ok(())
}

#[test]
fn canonical_objects_reject_evidence_counts_above_u16() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let oversized_evidence = (1_u32..=u32::from(u16::MAX) + 1)
        .map(|index| {
            let mut digest = [0_u8; 32];
            digest[28..].copy_from_slice(&index.to_be_bytes());
            CapitalEvidenceRef::Observation(digest)
        })
        .collect::<Vec<_>>();
    assert_eq!(oversized_evidence.len(), usize::from(u16::MAX) + 1);

    let source_result = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(100),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: token,
        repayment: RepaymentSemantics::AtomicSameTransaction,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![CapitalFailureMode::CapacityChanged],
        evidence: oversized_evidence.clone(),
    });
    assert!(matches!(
        source_result,
        Err(nqc_census_capital::CapitalError::InvalidCanonical(
            "too many capital source evidence references"
        ))
    ));

    let requirement_result = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(100),
        RequiredAtomicity::SameTransaction,
        false,
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(1),
                vec![CapitalClass::FlashSwap],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(1),
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        oversized_evidence,
    );
    assert!(matches!(
        requirement_result,
        Err(nqc_census_capital::CapitalError::InvalidCanonical(
            "too many capital requirement evidence references"
        ))
    ));
    Ok(())
}

#[test]
fn proportional_collateral_tracks_allocated_draw_exactly() -> TestResult {
    let debt = CapitalAsset::Token(address(60));
    let collateral = CapitalAsset::Token(address(61));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(70),
        liquidation_model_hash: hash(71),
        solvency_model_hash: hash(72),
        oracle_risk_hash: hash(73),
        liquidity_withdrawal_risk_hash: hash(74),
        facility_disappearance_risk_hash: hash(75),
    };

    let borrowing = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::CollateralizedBorrowing,
        anchor: anchor(100),
        provider_namespace: 201,
        provider_locator_hash: hash(62),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(63)),
        asset: debt,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: debt,
        repayment: RepaymentSemantics::Persistent(terms),
        collateral: CollateralRequirement::Proportional {
            asset: collateral,
            numerator: 3,
            denominator: 2,
            rounding: RoundingMode::Ceil,
            liquidation_conditions_hash: hash(64),
        },
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
            CapitalFailureMode::CollateralLiquidation,
            CapitalFailureMode::OracleRisk,
            CapitalFailureMode::LiquidityWithdrawal,
            CapitalFailureMode::FacilityDisappearance,
        ],
        evidence: evidence(),
    })?;

    let collateral_funder = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::InventoryRequirement,
        anchor: anchor(100),
        provider_namespace: 202,
        provider_locator_hash: hash(65),
        provider_kind: CapitalProviderKind::OtherExternal,
        ownership: CapitalOwnership::External,
        source_contract: None,
        asset: collateral,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: collateral,
        repayment: RepaymentSemantics::NoRepayment,
        collateral: CollateralRequirement::None,
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CapacityChanged,
        ],
        evidence: evidence(),
    })?;

    let exact = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(80)),
        anchor(100),
        RequiredAtomicity::Flexible,
        false,
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                debt,
                Amount256::from_u128(100),
                vec![CapitalClass::CollateralizedBorrowing],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Collateral,
                collateral,
                Amount256::from_u128(150),
                vec![CapitalClass::InventoryRequirement],
            )?,
        ],
        evidence(),
    )?;

    assert!(matches!(
        evaluate_capital_feasibility(&exact, &[borrowing.clone(), collateral_funder.clone()]),
        CapitalFeasibility::Feasible { .. }
    ));

    let underfunded = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(81)),
        anchor(100),
        RequiredAtomicity::Flexible,
        false,
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                debt,
                Amount256::from_u128(100),
                vec![CapitalClass::CollateralizedBorrowing],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Collateral,
                collateral,
                Amount256::from_u128(149),
                vec![CapitalClass::InventoryRequirement],
            )?,
        ],
        evidence(),
    )?;

    assert!(matches!(
        evaluate_capital_feasibility(&underfunded, &[borrowing, collateral_funder]),
        CapitalFeasibility::Rejected {
            reason: nqc_census_capital::FeasibilityRejection::CollateralRequirementUnfunded,
            ..
        }
    ));
    Ok(())
}

#[test]
fn proportional_collateral_must_round_up_and_have_a_positive_ratio() -> TestResult {
    let debt = CapitalAsset::Token(address(60));
    let collateral = CapitalAsset::Token(address(61));
    let terms = PersistentDebtTerms {
        interest_model_hash: hash(70),
        liquidation_model_hash: hash(71),
        solvency_model_hash: hash(72),
        oracle_risk_hash: hash(73),
        liquidity_withdrawal_risk_hash: hash(74),
        facility_disappearance_risk_hash: hash(75),
    };
    let base = CapitalSourceSpec {
        class: CapitalClass::CollateralizedBorrowing,
        anchor: anchor(100),
        provider_namespace: 203,
        provider_locator_hash: hash(66),
        provider_kind: CapitalProviderKind::ExternalCreditFacility,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(67)),
        asset: debt,
        maximum_available: Amount256::from_u128(1_000),
        fee_model: FeeModel::None,
        repayment_asset: debt,
        repayment: RepaymentSemantics::Persistent(terms),
        collateral: CollateralRequirement::Proportional {
            asset: collateral,
            numerator: 3,
            denominator: 2,
            rounding: RoundingMode::Ceil,
            liquidation_conditions_hash: hash(68),
        },
        utilization: UtilizationConstraints::new(10_000, Amount256::ZERO)?,
        caps: CapitalCaps::none(),
        temporary_lock: TemporaryLock::None,
        failure_modes: vec![
            CapitalFailureMode::SourceUnavailable,
            CapitalFailureMode::CollateralLiquidation,
        ],
        evidence: evidence(),
    };

    let mut floor = base.clone();
    floor.collateral = CollateralRequirement::Proportional {
        asset: collateral,
        numerator: 3,
        denominator: 2,
        rounding: RoundingMode::Floor,
        liquidation_conditions_hash: hash(68),
    };
    assert!(matches!(
        CapitalSource::new(floor),
        Err(CapitalError::InvalidCanonical(
            "proportional collateral must round up"
        ))
    ));

    let mut zero_ratio = base;
    zero_ratio.collateral = CollateralRequirement::Proportional {
        asset: collateral,
        numerator: 0,
        denominator: 2,
        rounding: RoundingMode::Ceil,
        liquidation_conditions_hash: hash(68),
    };
    assert!(matches!(
        CapitalSource::new(zero_ratio),
        Err(CapitalError::InvalidRatio)
    ));
    Ok(())
}

#[test]
fn indexed_ledger_preserves_full_checked_evaluator_with_irrelevant_sources() -> TestResult {
    // Differential oracle: this invokes the original public checked evaluator
    // on the entire source universe, then checks the indexed ledger result.
    // It exercises both the fully-funded and missing-external-gas paths.
    let token = CapitalAsset::Token(address(20));
    let req = requirement(
        vec![
            CapitalRequirementLeg::new(
                RequirementKind::ActionPrincipal,
                token,
                Amount256::from_u128(500),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Gas,
                CapitalAsset::NativeGas,
                Amount256::from_u128(5),
                vec![CapitalClass::GasFunding],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                token,
                Amount256::from_u128(500),
                vec![CapitalClass::ProtocolNativeFlashLoan],
            )?,
            CapitalRequirementLeg::new(
                RequirementKind::Repayment,
                CapitalAsset::NativeGas,
                Amount256::from_u128(5),
                vec![CapitalClass::GasFunding],
            )?,
        ],
        RequiredAtomicity::SameTransaction,
        true,
    )?;

    let mut universe = vec![
        source(
            CapitalClass::ProtocolNativeFlashLoan,
            token,
            1_000,
            token,
            RepaymentSemantics::AtomicSameTransaction,
        )?,
        source(
            CapitalClass::GasFunding,
            CapitalAsset::NativeGas,
            100,
            CapitalAsset::NativeGas,
            RepaymentSemantics::AtomicSameTransaction,
        )?,
    ];
    for byte in 50_u8..110_u8 {
        let unrelated = CapitalAsset::Token(address(byte));
        universe.push(source(
            CapitalClass::FlashSwap,
            unrelated,
            100_000,
            unrelated,
            RepaymentSemantics::AtomicSameTransaction,
        )?);
    }

    for missing_gas in [false, true] {
        let sources = universe
            .iter()
            .filter(|source| !missing_gas || source.class() != CapitalClass::GasFunding)
            .cloned()
            .collect::<Vec<_>>();
        let expected = evaluate_capital_feasibility_checked(&req, &sources)?;

        let mut ledger = CapitalCensusLedger::evidentiary();
        for source in sources {
            ledger.register_source(source)?;
        }
        let requirement_id = req.id();
        ledger.register_requirement(req.clone())?;
        ledger.evaluate_all()?;
        assert_eq!(ledger.result(requirement_id), Some(&expected));
    }
    Ok(())
}
