use nqc_census_capital::{
    artifacts::{
        export_capital_artifacts, verify_capital_artifact_bundle, ArtifactProvenance,
        CAPITAL_EVIDENCE_MANIFEST_FILE,
        CAPITAL_FEASIBILITY_FILE, CAPITAL_REJECTION_LEDGER_FILE, CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_SOURCES_FILE, CAPITAL_SUMMARY_FILE,
    },
    Amount256, CapitalAsset, CapitalCaps, CapitalCensusLedger, CapitalCertificationContext,
    CapitalClass, CapitalEvidenceRef, CapitalFailureMode, CapitalProviderKind, CapitalRequirement,
    CapitalRequirementLeg, CapitalSource, CapitalSourceSpec, CapitalTargetId,
    CollateralRequirement, FeeModel, GitObjectId, RepaymentSemantics, RequiredAtomicity,
    RequirementKind, TemporaryLock, UpstreamCensusStage, UpstreamStageAuthority,
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

fn authority() -> Result<CapitalCertificationContext, nqc_census_capital::CapitalError> {
    let mut stages = Vec::new();
    for (index, stage) in UpstreamCensusStage::ALL.into_iter().enumerate() {
        let value = u64::try_from(index + 1).map_err(|_| {
            nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                "test authority index overflow",
            )
        })?;
        stages.push(UpstreamStageAuthority::new(
            stage,
            GitObjectId::parse_hex(&format!("{value:040x}"))?,
            GitObjectId::parse_hex(&format!("{:040x}", value + 10))?,
            hash(u8::try_from(value + 20).map_err(|_| {
                nqc_census_capital::CapitalError::InvalidUpstreamAuthority(
                    "test authority artifact overflow",
                )
            })?),
            0,
            0,
            true,
        )?);
    }
    CapitalCertificationContext::new(stages)
}

fn ledger() -> Result<CapitalCensusLedger, Box<dyn std::error::Error>> {
    let token = CapitalAsset::Token(address(20));
    let source = CapitalSource::new(CapitalSourceSpec {
        class: CapitalClass::FlashSwap,
        anchor: anchor(),
        provider_namespace: 11,
        provider_locator_hash: hash(12),
        provider_kind: CapitalProviderKind::DexLiquidityPool,
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
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let authority = authority()?;
    let first = export_capital_artifacts(&ledger, &authority, &provenance)?;
    let second = export_capital_artifacts(&ledger, &authority, &provenance)?;
    assert_eq!(first, second);

    for name in [
        CAPITAL_SOURCES_FILE,
        CAPITAL_REQUIREMENTS_FILE,
        CAPITAL_FEASIBILITY_FILE,
        CAPITAL_REJECTION_LEDGER_FILE,
        CAPITAL_SUMMARY_FILE,
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
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let text = std::str::from_utf8(&sources.bytes)?;
    assert!(text.contains("\"block_number\":25437474"));
    assert!(text.contains("\"provider_namespace\":11"));
    assert!(text.contains("\"code_commit\":\"0123456789abcdef0123456789abcdef01234567\""));
    assert!(text.ends_with('\n'));
    Ok(())
}

#[test]
fn artifact_hashes_change_when_provenance_changes() -> TestResult {
    let ledger = ledger()?;
    let a = export_capital_artifacts(
        &ledger,
        &authority()?,
        &ArtifactProvenance::new("A", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?,
    )?;
    let b = export_capital_artifacts(
        &ledger,
        &authority()?,
        &ArtifactProvenance::new("B", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?,
    )?;
    assert_ne!(
        a.file(CAPITAL_SUMMARY_FILE)
            .ok_or("missing summary A")?
            .sha256,
        b.file(CAPITAL_SUMMARY_FILE)
            .ok_or("missing summary B")?
            .sha256
    );
    Ok(())
}

#[test]
fn synthetic_ledger_cannot_export_evidentiary_artifacts() -> TestResult {
    let ledger = CapitalCensusLedger::synthetic_fixture();
    let provenance = ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?;
    assert!(export_capital_artifacts(&ledger, &authority()?, &provenance).is_err());
    Ok(())
}


#[test]
fn offline_artifact_verifier_accepts_exact_export() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
    let verified = verify_capital_artifact_bundle(&bundle)?;
    assert_eq!(verified.source_count, 1);
    assert_eq!(verified.requirement_count, 1);
    assert_eq!(verified.feasibility_count, 1);
    assert_eq!(verified.rejection_count, 0);
    assert!(!verified.capital_commitment.is_empty());
    assert!(!verified.upstream_authority_commitment.is_empty());
    Ok(())
}

#[test]
fn offline_artifact_verifier_rejects_tampered_bytes() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?;
    let mut bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
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
    let provenance = ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?;
    let mut bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
    let manifest = bundle
        .files
        .iter_mut()
        .find(|file| file.name == CAPITAL_EVIDENCE_MANIFEST_FILE)
        .ok_or("missing manifest")?;
    let text = String::from_utf8(manifest.bytes.clone())?;
    let tampered = text.replacen(
        "\"sha256\":\"",
        "\"sha256\":\"00",
        1,
    );
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
    let provenance = ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?;
    let mut bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
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
        &authority()?,
        &ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef")?,
    )?;
    let summary = bundle.file(CAPITAL_SUMMARY_FILE).ok_or("missing summary")?;
    let text = std::str::from_utf8(&summary.bytes)?;
    assert!(text.contains("\"feasible_count\":0"));
    assert!(text.contains("\"rejected_count\":1"));
    assert!(text.contains("\"zero_own_capital_proven\":false"));
    Ok(())
}


#[test]
fn artifact_provenance_requires_exact_git_object_ids() -> TestResult {
    assert!(ArtifactProvenance::new("t", "not-a-commit", "89abcdef0123456789abcdef0123456789abcdef").is_err());
    assert!(ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "not-a-tree").is_err());
    assert!(ArtifactProvenance::new("t", "0123456789abcdef0123456789abcdef01234567", "89abcdef0123456789abcdef0123456789abcdef").is_ok());
    Ok(())
}


#[test]
fn source_artifact_exposes_full_capital_semantics() -> TestResult {
    let ledger = ledger()?;
    let provenance = ArtifactProvenance::new(
        "2026-09-29T00:00:00Z",
        "0123456789abcdef0123456789abcdef01234567",
        "89abcdef0123456789abcdef0123456789abcdef",
    )?;
    let bundle = export_capital_artifacts(&ledger, &authority()?, &provenance)?;
    let sources = bundle.file(CAPITAL_SOURCES_FILE).ok_or("missing sources")?;
    let text = std::str::from_utf8(&sources.bytes)?;
    for field in [
        "\"source_contract\"",
        "\"effective_capacity\"",
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
        assert!(text.contains(field), "missing source artifact field {field}");
    }
    Ok(())
}
