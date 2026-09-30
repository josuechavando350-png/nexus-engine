use nqc_census_capital::{
    artifacts::{
        export_capital_artifacts, parse_capital_sources_artifact, verify_capital_artifact_bundle,
        ArtifactProvenance, CAPITAL_EVIDENCE_MANIFEST_FILE, CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE, CAPITAL_REQUIREMENTS_FILE, CAPITAL_SOURCES_FILE,
        CAPITAL_SUMMARY_FILE, CAPITAL_UPSTREAM_AUTHORITY_FILE,
    },
    Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger, CapitalCertificationContext,
    CapitalClass, CapitalEvidenceRef, CapitalFailureMode, CapitalOwnership, CapitalProviderKind,
    CapitalRequirement, CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, GitObjectId, RepaymentSemantics, RequiredAtomicity,
    RequirementKind, TemporaryLock, UpstreamCensusStage, UpstreamConsumptionReceipt,
    UpstreamStageAuthority, UpstreamStageAuthoritySpec, UtilizationConstraints,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};

type TestResult = Result<(), Box<dyn std::error::Error>>;

fn hash(byte: u8) -> Hash32 {
    Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
}

fn address(byte: u8) -> Address {
    Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
}

fn anchor() -> StateAnchor {
    StateAnchor::new(
        ChainDomain::new(1, hash(1), hash(2)).unwrap_or_else(|_| unreachable!()),
        25_437_474,
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

fn authority_for(
    ledger: &CapitalCensusLedger,
) -> Result<CapitalCertificationContext, nqc_census_capital::CapitalError> {
    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let value = u64::try_from(index + 1).map_err(|_| {
            nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                "test authority index overflow",
            )
        })?;
        stages.push(UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
            stage,
            code_commit: GitObjectId::parse_hex(&format!("{value:040x}"))?,
            code_tree: GitObjectId::parse_hex(&format!("{:040x}", value + 10))?,
            artifact_sha256: hash(u8::try_from(value + 20).map_err(|_| {
                nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                    "test authority artifact overflow",
                )
            })?),
            observation_anchor: anchor(),
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

fn ledger() -> Result<CapitalCensusLedger, Box<dyn std::error::Error>> {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
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
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(),
        RequiredAtomicity::SameTransaction,
        false,
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
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        evidence(),
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;
    Ok(ledger)
}

#[test]
fn capital_artifacts_are_deterministic_and_complete() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let authority = authority_for(&ledger)?;
    let first = export_capital_artifacts(&ledger, &authority, &provenance)?;
    let second = export_capital_artifacts(&ledger, &authority, &provenance)?;
    assert_eq!(first, second);

    for name in [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
        CAPITAL_UPSTREAM_AUTHORITY_FILE,
        CAPITAL_EVIDENCE_MANIFEST_FILE,
    ] {
        assert!(first.file(name).is_some(), "missing artifact {name}");
    }

    let manifest = first
        .file(CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing manifest")?;
    let text = std::str::from_utf8(&manifest.bytes)?;
    assert!(text.contains(CAPITAL_SOURCES_FILE));
    assert!(text.contains(CAPITAL_SUMMARY_FILE));
    assert!(text.contains("PORTFOLIO_CONCURRENT_CAPACITY_NOT_TESTED"));
    assert!(text.contains("REAL_PNL_NOT_TESTED"));

    let summary = first.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary")?;
    let summary_text = std::str::from_utf8(&summary.bytes)?;
    assert!(summary_text.contains("\"profitability_claimed\":false"));
    Ok(())
}

#[test]
fn jsonl_records_carry_exact_anchor_and_provenance() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let text = std::str::from_utf8(&sources.bytes)?;
    assert!(text.contains("\"block_number\":25437474"));
    assert!(text.contains("\"provider_namespace\":11"));
    assert!(text.contains("\"code_commit\":\"0123456789abcdef0123456789abcdef01234567\""));
    assert!(text.ends_with('\n'));
    Ok(())
}

#[test]
fn source_only_bundle_is_offline_verifiable_without_false_feasibility_claim() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
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
    let mut source_only = CapitalCensusLedger::evidentiary();
    source_only.register_source(source)?;
    source_only.evaluate_all()?;

    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle =
        export_capital_artifacts(&source_only, &authority_for(&source_only)?, &provenance)?;
    assert!(bundle
        .file(CAPITAL_REQUIREMENTS_FILE)
        .ok_or("missing requirements")?
        .bytes
        .is_empty());
    assert!(bundle
        .file(CAPITAL_FEASIBILITY_FILE)
        .ok_or("missing feasibility")?
        .bytes
        .is_empty());
    assert!(bundle
        .file(CAPITAL_REJECTION_LEDGER_FILE)
        .ok_or("missing rejection ledger")?
        .bytes
        .is_empty());

    let verified = verify_capital_artifact_bundle(&bundle)?;
    assert_eq!(verified.source_count, 1);
    assert_eq!(verified.requirement_count, 0);
    assert_eq!(verified.feasibility_count, 0);
    assert_eq!(verified.feasible_count, 0);
    assert_eq!(verified.rejection_count, 0);

    let summary = bundle.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary")?;
    let summary_text = std::str::from_utf8(&summary.bytes)?;
    assert!(summary_text.contains("\"zero_own_capital_proven\":false"));
    Ok(())
}

#[test]
fn blocked_source_bundle_roundtrips_offline_and_preserves_execution_rejection() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
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
    })?
    .with_execution_blockers(vec!["TOKEN_SEMANTICS_UNPROVEN".to_owned()])?;
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(),
        RequiredAtomicity::SameTransaction,
        false,
        vec![CapitalRequirementLeg::new(
            RequirementKind::ActionPrincipal,
            token,
            Amount256::from_u128(100),
            vec![CapitalClass::FlashSwap],
        )?],
        evidence(),
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;

    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let verified = verify_capital_artifact_bundle(&bundle)?;
    assert_eq!(verified.source_count, 1);
    assert_eq!(verified.requirement_count, 1);
    assert_eq!(verified.feasibility_count, 1);
    assert_eq!(verified.feasible_count, 0);
    assert_eq!(verified.rejection_count, 1);

    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let source_text = std::str::from_utf8(&sources.bytes)?;
    assert!(source_text.contains("\"execution_eligible\":false"));
    assert!(source_text.contains("\"TOKEN_SEMANTICS_UNPROVEN\""));
    assert!(source_text.contains(&format!(
        "\"executable_capacity\":\"{}\"",
        Amount256::ZERO.to_hex()
    )));

    let rejections = bundle
        .file(CAPITAL_REJECTION_LEDGER_FILE)
        .ok_or("missing rejection ledger")?;
    let rejection_text = std::str::from_utf8(&rejections.bytes)?;
    assert!(rejection_text.contains("\"reason\":\"EXECUTION_BLOCKED\""));
    Ok(())
}

#[test]
fn artifact_export_rejects_wall_clock_or_arbitrary_generation_time() -> TestResult {
    let ledger = ledger()?;
    let authority = authority_for(&ledger)?;
    let arbitrary = ArtifactProvenance::new(
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    assert!(export_capital_artifacts(&ledger, &authority, &arbitrary).is_err());

    let anchored = ArtifactProvenance::for_anchor(
        authority.observation_anchor(),
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let first = export_capital_artifacts(&ledger, &authority, &anchored)?;
    let second = export_capital_artifacts(&ledger, &authority, &anchored)?;
    assert_eq!(first, second);
    Ok(())
}

#[test]
fn synthetic_ledger_cannot_export_evidentiary_artifacts() -> TestResult {
    let ledger = CapitalCensusLedger::synthetic_fixture();
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    assert!(export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance).is_err());
    Ok(())
}

#[test]
fn offline_artifact_verifier_accepts_exact_export() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let verified = verify_capital_artifact_bundle(&bundle)?;
    assert_eq!(verified.source_count, 1);
    assert_eq!(verified.requirement_count, 1);
    assert_eq!(verified.feasibility_count, 1);
    assert_eq!(verified.feasible_count, 1);
    assert_eq!(verified.rejection_count, 0);
    assert!(!verified.capital_commitment.is_empty());
    assert!(!verified.upstream_authority_commitment.is_empty());
    Ok(())
}

#[test]
fn offline_artifact_verifier_rejects_tampered_bytes() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let mut bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let sources = bundle
        .files
        .iter_mut()
        .find(|file| file.name == CAPITAL_SOURCES_FILE)
        .ok_or("missing sources")?;
    let index = sources
        .bytes
        .iter()
        .position(|byte| *byte == b'a')
        .ok_or("source artifact has no mutable byte")?;
    sources.bytes[index] = b'b';
    assert!(verify_capital_artifact_bundle(&bundle).is_err());
    Ok(())
}

#[test]
fn offline_artifact_verifier_rejects_manifest_digest_substitution() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let mut bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let manifest = bundle
        .files
        .iter_mut()
        .find(|file| file.name == CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing manifest")?;
    let text = String::from_utf8(manifest.bytes.clone())?;
    let tampered = text.replacen("\"sha256\":\"", "\"sha256\":\"00", 1);
    manifest.bytes = tampered.into_bytes();
    manifest.sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&manifest.bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };
    assert!(verify_capital_artifact_bundle(&bundle).is_err());
    Ok(())
}

#[test]
fn offline_artifact_verifier_rejects_noncanonical_jsonl() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let mut bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let sources = bundle
        .files
        .iter_mut()
        .find(|file| file.name == CAPITAL_SOURCES_FILE)
        .ok_or("missing sources")?;
    sources.bytes.insert(0, b' ');
    sources.sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&sources.bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };
    assert!(verify_capital_artifact_bundle(&bundle).is_err());
    Ok(())
}

#[test]
fn all_rejected_census_does_not_claim_zero_own_capital_proof() -> TestResult {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
        ownership: CapitalOwnership::External,
        source_contract: Some(address(13)),
        asset: token,
        maximum_available: Amount256::from_u128(10),
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
    let requirement = CapitalRequirement::new(
        CapitalTargetId::from_hash(hash(50)),
        anchor(),
        RequiredAtomicity::SameTransaction,
        false,
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
                vec![CapitalClass::FlashSwap],
            )?,
        ],
        evidence(),
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    ledger.register_source(source)?;
    ledger.register_requirement(requirement)?;
    ledger.evaluate_all()?;

    let bundle = export_capital_artifacts(
        &ledger,
        &authority_for(&ledger)?,
        &ArtifactProvenance::new(
            "2023-11-14T22:13:20Z",
            "0123456789abcdef0123456789abcdef01234567",
            "89abcdef0123456789abcdef0123456789abcdef",
        )?,
    )?;
    let summary = bundle.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary")?;
    let text = std::str::from_utf8(&summary.bytes)?;
    assert!(text.contains("\"schema_version\":5"));
    assert!(text.contains("\"feasible_count\":0"));
    assert!(text.contains("\"rejected_count\":1"));
    assert!(text.contains("\"zero_own_capital_proven\":false"));
    assert!(text.contains("\"real_source_certification\":false"));

    let manifest = bundle
        .file(CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing evidence manifest")?;
    let manifest_text = std::str::from_utf8(&manifest.bytes)?;
    assert!(manifest_text.contains("\"schema_version\":3"));
    assert!(manifest_text.contains("REAL_SOURCE_CERTIFICATION_NOT_TESTED"));
    Ok(())
}

#[test]
fn artifact_provenance_requires_exact_git_object_ids() -> TestResult {
    assert!(ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "not-a-commit",
        "89abcdef0123456789abcdef0123456789abcdef"
    )
    .is_err());
    assert!(ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "not-a-tree"
    )
    .is_err());
    assert!(ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef"
    )
    .is_ok());
    Ok(())
}

#[test]
fn source_artifact_exposes_full_capital_semantics() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let text = std::str::from_utf8(&sources.bytes)?;
    for field in [
        "\"source_contract\"",
        "\"capital_ownership\"",
        "\"effective_capacity\"",
        "\"executable_capacity\"",
        "\"execution_eligible\"",
        "\"execution_blockers\"",
        "\"fee_model\"",
        "\"repayment_asset\"",
        "\"repayment_semantics\"",
        "\"collateral_required\"",
        "\"utilization_constraints\"",
        "\"protocol_cap\"",
        "\"market_cap\"",
        "\"same_block_atomicity\"",
        "\"temporary_lock\"",
        "\"failure_modes\"",
        "\"evidence_refs\"",
    ] {
        assert!(
            text.contains(field),
            "missing source artifact field {field}"
        );
    }
    Ok(())
}

#[test]
fn upstream_authority_artifact_is_exact_and_offline_bound() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let upstream = bundle
        .file(CAPITAL_UPSTREAM_AUTHORITY_FILE)
        .ok_or("missing upstream authority artifact")?;
    let text = std::str::from_utf8(&upstream.bytes)?;
    for stage in ["RMC-006", "RMC-007", "RMC-008", "RMC-009", "RMC-010"] {
        assert!(
            text.contains(stage),
            "missing upstream authority stage {stage}"
        );
    }
    assert!(text.contains("\"schema_version\":7"));
    assert!(text.contains("\"consumption_receipts\""));
    assert!(text.contains("\"coverage_commitment\""));
    assert!(text.contains("\"output_count\""));
    assert!(text.contains("\"output_set_commitment\""));
    assert!(text.contains("\"generated_at\":\"2023-11-14T22:13:20Z\""));
    assert!(text.contains("\"code_commit\":\"0123456789abcdef0123456789abcdef01234567\""));
    assert!(text.contains("\"code_tree\":\"89abcdef0123456789abcdef0123456789abcdef\""));
    assert!(text.contains("\"observation_anchor\""));
    assert!(text.contains("\"admitted_evidence_refs\""));
    assert!(text.contains("\"unresolved_mismatch_count\":0"));
    assert!(text.contains("\"unknown_failure_count\":0"));
    assert!(text.contains("\"admitted\":true"));
    verify_capital_artifact_bundle(&bundle)?;
    Ok(())
}

#[test]
fn offline_verifier_rejects_rehashed_upstream_authority_substitution() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let mut bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;

    let authority_index = bundle
        .files
        .iter()
        .position(|file| file.name == CAPITAL_UPSTREAM_AUTHORITY_FILE)
        .ok_or("missing upstream authority artifact")?;
    let old_sha = bundle.files[authority_index].sha256_hex();
    let authority_text = String::from_utf8(bundle.files[authority_index].bytes.clone())?;
    let needle = "\"artifact_sha256\":\"0x";
    let offset = authority_text
        .find(needle)
        .ok_or("upstream authority lacks artifact digest")?
        + needle.len();
    let mut authority_bytes = authority_text.into_bytes();
    authority_bytes[offset] = if authority_bytes[offset] == b'1' {
        b'2'
    } else {
        b'1'
    };
    bundle.files[authority_index].bytes = authority_bytes;
    bundle.files[authority_index].sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bundle.files[authority_index].bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };
    let new_sha = bundle.files[authority_index].sha256_hex();
    assert_ne!(old_sha, new_sha);

    let manifest_index = bundle
        .files
        .iter()
        .position(|file| file.name == CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing evidence manifest")?;
    let manifest_text = String::from_utf8(bundle.files[manifest_index].bytes.clone())?;
    let rewritten = manifest_text.replacen(&old_sha, &new_sha, 1);
    if rewritten == manifest_text {
        return Err("authority digest was not present in manifest".into());
    }
    bundle.files[manifest_index].bytes = rewritten.into_bytes();
    bundle.files[manifest_index].sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bundle.files[manifest_index].bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };

    assert!(verify_capital_artifact_bundle(&bundle).is_err());
    Ok(())
}

#[test]
fn offline_verifier_rejects_rehashed_feasibility_allocation_substitution() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let mut bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;

    let feasibility_index = bundle
        .files
        .iter()
        .position(|file| file.name == CAPITAL_FEASIBILITY_FILE)
        .ok_or("missing feasibility artifact")?;
    let old_sha = bundle.files[feasibility_index].sha256_hex();
    let feasibility_text = String::from_utf8(bundle.files[feasibility_index].bytes.clone())?;
    let needle = "\"amount\":\"";
    let offset = feasibility_text
        .find(needle)
        .ok_or("feasibility artifact lacks allocation amount")?
        + needle.len();
    let mut feasibility_bytes = feasibility_text.into_bytes();
    feasibility_bytes[offset] = if feasibility_bytes[offset] == b'0' {
        b'1'
    } else {
        b'0'
    };
    bundle.files[feasibility_index].bytes = feasibility_bytes;
    bundle.files[feasibility_index].sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bundle.files[feasibility_index].bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };
    let new_sha = bundle.files[feasibility_index].sha256_hex();
    assert_ne!(old_sha, new_sha);

    let manifest_index = bundle
        .files
        .iter()
        .position(|file| file.name == CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing evidence manifest")?;
    let manifest_text = String::from_utf8(bundle.files[manifest_index].bytes.clone())?;
    let rewritten = manifest_text.replacen(&old_sha, &new_sha, 1);
    if rewritten == manifest_text {
        return Err("feasibility digest was not present in manifest".into());
    }
    bundle.files[manifest_index].bytes = rewritten.into_bytes();
    bundle.files[manifest_index].sha256 = {
        use sha2::{Digest, Sha256};
        let digest = Sha256::digest(&bundle.files[manifest_index].bytes);
        let mut out = [0_u8; 32];
        out.copy_from_slice(&digest);
        out
    };

    assert!(verify_capital_artifact_bundle(&bundle).is_err());
    Ok(())
}

#[test]
fn downstream_source_reader_reconstructs_exact_canonical_source_set() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2023-11-14T22:13:20Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority_for(&ledger)?, &provenance)?;
    let source_file = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let parsed = parse_capital_sources_artifact(&source_file.bytes)?;
    assert_eq!(parsed.len(), 1);
    assert_eq!(
        parsed[0].id().to_hex(),
        ledger
            .sources()
            .next()
            .ok_or("missing ledger source")?
            .id()
            .to_hex()
    );
    Ok(())
}
