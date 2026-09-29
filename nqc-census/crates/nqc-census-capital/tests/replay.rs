use nqc_census_capital::{
    artifacts::{export_capital_artifacts, ArtifactProvenance},
    demands::import_d09_borrower_demands,
    replay::{
        verify_capital_bundle_with_upstream_replay_for_code, verify_real_source_closeout_for_code,
        verify_upstream_consumption_by_replay, D08ReplayInputs, D09ReplayInputs,
        UpstreamAuthorityLock, UpstreamAuthorityLockEntry,
    },
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCensusLedger, CapitalCertificationContext, CapitalEvidenceRef, GitObjectId,
    UpstreamCensusStage, UpstreamConsumptionReceipt, UpstreamStageAuthority,
    UpstreamStageAuthoritySpec,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const D08_CODE_COMMIT: &str = "1111111111111111111111111111111111111111";
const D08_CODE_TREE: &str = "2222222222222222222222222222222222222222";
const D09_CODE_COMMIT: &str = "3333333333333333333333333333333333333333";
const D09_CODE_TREE: &str = "4444444444444444444444444444444444444444";

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

fn sha256_hash(bytes: &[u8]) -> Hash32 {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    Hash32::new(digest).unwrap_or_else(|_| unreachable!())
}

fn sha256_plain(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn d08_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>, Vec<u8>) {
    let asset = address(20);
    let pool = address(90);
    let states = format!(
        "{{\"asset\":\"{}\",\"lifecycle\":\"CURRENT\",\"market_id\":\"m-aave\",\"protocol\":\"AAVE_V3\",\"protocol_facts\":{{\"active\":true,\"available_liquidity\":\"10000\",\"flash_loan_enabled\":true,\"paused\":false}},\"schema_version\":1,\"stage_state_reconstructable\":\"ADVANCE\"}}\n",
        asset.to_hex()
    )
    .into_bytes();
    let tokens = format!(
        "{{\"execution_compatibility\":{{\"blockers\":[],\"status\":\"PROVEN_COMPATIBLE\"}},\"token\":\"{}\"}}\n",
        asset.to_hex()
    )
    .into_bytes();
    let facts = format!(
        "{{\"aave_pool\":{{\"pool\":\"{}\",\"scalars\":{{\"FLASHLOAN_PREMIUM_TOTAL()\":{{\"data\":\"0x{}05\",\"status\":\"RETURNED\"}}}}}}}}",
        pool.to_hex(),
        "00".repeat(31),
    )
    .into_bytes();
    let manifest = format!(
        concat!(
            "{{\"artifacts\":[",
            "{{\"bytes\":{},\"path\":\"market-state-manifest.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"token-admission.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"pool-and-factory-facts.json\",\"sha256\":\"{}\"}}",
            "],\"code_commit\":\"{}\",\"code_tree\":\"{}\",\"schema_version\":1}}"
        ),
        states.len(),
        sha256_plain(&states),
        tokens.len(),
        sha256_plain(&tokens),
        facts.len(),
        sha256_plain(&facts),
        D08_CODE_COMMIT,
        D08_CODE_TREE,
    )
    .into_bytes();
    (states, tokens, facts, manifest)
}

fn d09_fixture() -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let accounts = Vec::new();
    let summary = format!(
        concat!(
            "{{\"all_tokens_conserved\":true,\"anchor\":{{\"hash\":\"{}\",\"number\":25437474}},",
            "\"blocking_findings\":[],\"code_commit\":\"{}\",\"code_tree\":\"{}\",",
            "\"non_claims\":[\"LIQUIDATABILITY_NOT_CLAIMED\",\"PROFITABILITY_NOT_CLAIMED\",",
            "\"EXECUTION_NOT_CLAIMED\",\"ORACLE_FRESHNESS_NOT_ASSUMED\",\"POSITIONS_OUTSIDE_D06_NOT_CLAIMED\"],",
            "\"schema_version\":1,\"status\":\"RMC_009_PASS_CANDIDATE\",\"unexplained_mismatches\":0,",
            "\"uniswap_v2\":{{\"reason\":\"not applicable\",\"status\":\"NOT_APPLICABLE\"}}}}"
        ),
        anchor().block_hash().to_hex(),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )
    .into_bytes();
    let manifest = format!(
        concat!(
            "{{\"artifacts\":[",
            "{{\"bytes\":{},\"path\":\"account-manifest.jsonl\",\"sha256\":\"{}\"}},",
            "{{\"bytes\":{},\"path\":\"account-summary.json\",\"sha256\":\"{}\"}}",
            "],\"code_commit\":\"{}\",\"code_tree\":\"{}\",\"schema_version\":1}}"
        ),
        accounts.len(),
        sha256_plain(&accounts),
        summary.len(),
        sha256_plain(&summary),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )
    .into_bytes();
    (accounts, summary, manifest)
}

fn authority(
    stage: UpstreamCensusStage,
    artifact_sha256: Hash32,
    code_commit: &str,
    code_tree: &str,
) -> Result<UpstreamStageAuthority, nqc_census_capital::CapitalError> {
    UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
        stage,
        code_commit: GitObjectId::parse_hex(code_commit)?,
        code_tree: GitObjectId::parse_hex(code_tree)?,
        artifact_sha256,
        observation_anchor: anchor(),
        unresolved_mismatch_count: 0,
        unknown_failure_count: 0,
        coverage_complete: true,
        admitted: true,
    })
}

struct ReplayFixture {
    context: CapitalCertificationContext,
    d08_states: Vec<u8>,
    d08_tokens: Vec<u8>,
    d08_facts: Vec<u8>,
    d08_manifest: Vec<u8>,
    d09_accounts: Vec<u8>,
    d09_summary: Vec<u8>,
    d09_manifest: Vec<u8>,
}

fn authority_lock(
    context: &CapitalCertificationContext,
) -> Result<UpstreamAuthorityLock, nqc_census_capital::CapitalError> {
    UpstreamAuthorityLock::new(
        context
            .stages()
            .iter()
            .map(UpstreamAuthorityLockEntry::from)
            .collect(),
    )
}

fn replay_context() -> Result<ReplayFixture, Box<dyn std::error::Error>> {
    let (d08_states, d08_tokens, d08_facts, d08_manifest) = d08_fixture();
    let (d09_accounts, d09_summary, d09_manifest) = d09_fixture();
    let d08 = authority(
        UpstreamCensusStage::Rmc008StateAdmission,
        sha256_hash(&d08_manifest),
        D08_CODE_COMMIT,
        D08_CODE_TREE,
    )?;
    let d09 = authority(
        UpstreamCensusStage::Rmc009PositionUniverse,
        sha256_hash(&d09_manifest),
        D09_CODE_COMMIT,
        D09_CODE_TREE,
    )?;

    let d08_context = D08CapitalImportContext {
        anchor: anchor(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08.artifact_sha256)],
    };
    let d08_import = import_d08_capital_sources(
        &d08_states,
        &d08_tokens,
        &d08_facts,
        &d08_manifest,
        &d08,
        &d08_context,
    )?;
    let d09_import =
        import_d09_borrower_demands(&d09_accounts, &d09_summary, &d09_manifest, &d09, &anchor())?;

    let mut stages = Vec::new();
    for stage in UpstreamCensusStage::ALL {
        let stage_authority = match stage {
            UpstreamCensusStage::Rmc008StateAdmission => d08.clone(),
            UpstreamCensusStage::Rmc009PositionUniverse => d09.clone(),
            _ => authority(
                stage,
                hash(100_u8.saturating_add(stage as u8)),
                "5555555555555555555555555555555555555555",
                "6666666666666666666666666666666666666666",
            )?,
        };
        stages.push(stage_authority);
    }
    let admitted_evidence = stages
        .iter()
        .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256))
        .collect::<Vec<_>>();
    let context = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![
            d08_import.consumption_receipt()?,
            d09_import.consumption_receipt()?,
        ])?;

    Ok(ReplayFixture {
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    })
}

#[test]
fn exact_upstream_bytes_replay_to_committed_receipts() -> TestResult {
    let fixture = replay_context()?;
    let ReplayFixture {
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    } = fixture;
    let verified = verify_upstream_consumption_by_replay(
        &context,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )?;
    assert_eq!(verified.d08_source_count, 1);
    assert_eq!(verified.d09_requirement_count, 0);
    Ok(())
}

#[test]
fn upstream_replay_rejects_consumed_byte_substitution() -> TestResult {
    let fixture = replay_context()?;
    let ReplayFixture {
        context,
        mut d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    } = fixture;
    let index = d08_states
        .windows(b"10000".len())
        .position(|window| window == b"10000")
        .ok_or("missing fixture amount")?;
    d08_states[index] = b'9';

    assert!(verify_upstream_consumption_by_replay(
        &context,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )
    .is_err());
    Ok(())
}

#[test]
fn upstream_replay_rejects_forged_committed_output_set() -> TestResult {
    let fixture = replay_context()?;
    let ReplayFixture {
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    } = fixture;
    let stages = context.stages().to_vec();
    let admitted_evidence = context.admitted_evidence().copied().collect::<Vec<_>>();
    let d08_artifact = stages
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing D08 authority")?
        .artifact_sha256;
    let d09_receipt = context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or("missing D09 receipt")?;
    let forged = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![
            UpstreamConsumptionReceipt::for_sources(
                d08_artifact,
                hash(250),
                std::iter::empty::<&nqc_census_capital::CapitalSource>(),
            )?,
            d09_receipt,
        ])?;

    assert!(verify_upstream_consumption_by_replay(
        &forged,
        D08ReplayInputs {
            state_manifest_jsonl: &d08_states,
            token_admission_jsonl: &d08_tokens,
            pool_and_factory_facts_json: &d08_facts,
            evidence_manifest_json: &d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &d09_accounts,
            account_summary_json: &d09_summary,
            evidence_manifest_json: &d09_manifest,
        },
    )
    .is_err());
    Ok(())
}

#[test]
fn capital_bundle_plus_upstream_bytes_forms_one_offline_replay_proof() -> TestResult {
    let fixture = replay_context()?;
    let ReplayFixture {
        context,
        d08_states,
        d08_tokens,
        d08_facts,
        d08_manifest,
        d09_accounts,
        d09_summary,
        d09_manifest,
    } = fixture;
    let d08_authority = context
        .stages()
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing D08 authority")?;
    let d08_context = D08CapitalImportContext {
        anchor: anchor(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08_authority.artifact_sha256)],
    };
    let imported = import_d08_capital_sources(
        &d08_states,
        &d08_tokens,
        &d08_facts,
        &d08_manifest,
        d08_authority,
        &d08_context,
    )?;

    let mut ledger = CapitalCensusLedger::evidentiary();
    for source in imported.sources {
        ledger.register_source(source)?;
    }
    ledger.evaluate_all()?;

    const CODE_COMMIT: &str = "7777777777777777777777777777777777777777";
    const CODE_TREE: &str = "8888888888888888888888888888888888888888";
    let provenance = ArtifactProvenance::new("2023-11-14T22:13:20Z", CODE_COMMIT, CODE_TREE)?;
    let bundle = export_capital_artifacts(&ledger, &context, &provenance)?;
    let lock = authority_lock(&context)?;
    let d08_replay = D08ReplayInputs {
        state_manifest_jsonl: &d08_states,
        token_admission_jsonl: &d08_tokens,
        pool_and_factory_facts_json: &d08_facts,
        evidence_manifest_json: &d08_manifest,
    };
    let d09_replay = D09ReplayInputs {
        account_manifest_jsonl: &d09_accounts,
        account_summary_json: &d09_summary,
        evidence_manifest_json: &d09_manifest,
    };
    let verified = verify_capital_bundle_with_upstream_replay_for_code(
        &bundle,
        CODE_COMMIT,
        CODE_TREE,
        &lock,
        d08_replay,
        d09_replay,
    )?;
    assert_eq!(verified.capital.source_count, 1);
    assert_eq!(verified.capital.requirement_count, 0);
    assert_eq!(verified.upstream.d08_source_count, 1);
    assert_eq!(verified.upstream.d09_requirement_count, 0);
    assert_eq!(
        verified.upstream_authority_lock_commitment,
        lock.commitment()
    );

    let closeout = verify_real_source_closeout_for_code(
        &bundle,
        CODE_COMMIT,
        CODE_TREE,
        &lock,
        d08_replay,
        d09_replay,
    )?;
    let first = closeout.canonical_json()?;
    let second = verify_real_source_closeout_for_code(
        &bundle,
        CODE_COMMIT,
        CODE_TREE,
        &lock,
        d08_replay,
        d09_replay,
    )?
    .canonical_json()?;
    assert_eq!(first, second);
    let closeout_text = std::str::from_utf8(&first)?;
    assert!(closeout_text.contains("\"status\":\"RMC_011_REAL_SOURCE_CLOSEOUT_PASS\""));
    assert!(closeout_text.contains("\"real_source_certification\":true"));
    assert!(closeout_text.contains("\"zero_own_capital_proven\":false"));
    assert!(closeout_text.contains(
        "\"opportunity_level_capital_feasibility_claimed\":false"
    ));
    assert!(closeout_text.contains("\"profitability_claimed\":false"));
    Ok(())
}

#[test]
fn authority_lock_roundtrips_canonically_and_rejects_unconsumed_stage_substitution() -> TestResult {
    let fixture = replay_context()?;
    let lock = authority_lock(&fixture.context)?;
    let bytes = lock.canonical_json()?;
    let decoded = UpstreamAuthorityLock::parse_json(&bytes)?;
    assert_eq!(decoded, lock);

    let text = String::from_utf8(bytes.clone())?;
    let with_unknown_field = text.replacen("{", "{\"ignored\":1,", 1).into_bytes();
    assert!(UpstreamAuthorityLock::parse_json(&with_unknown_field).is_err());

    let mut forged_entries = fixture
        .context
        .stages()
        .iter()
        .map(UpstreamAuthorityLockEntry::from)
        .collect::<Vec<_>>();
    let d06 = forged_entries
        .iter_mut()
        .find(|entry| entry.stage == UpstreamCensusStage::Rmc006DiscoveryAave)
        .ok_or("missing D06 lock entry")?;
    d06.artifact_sha256 = hash(240);
    let forged_lock = UpstreamAuthorityLock::new(forged_entries)?;
    assert!(forged_lock.verify(&fixture.context).is_err());
    Ok(())
}

#[test]
fn authority_lock_rejects_anchor_substitution_and_mixed_stage_anchors() -> TestResult {
    let fixture = replay_context()?;
    let mut entries = fixture
        .context
        .stages()
        .iter()
        .map(UpstreamAuthorityLockEntry::from)
        .collect::<Vec<_>>();
    let shifted_anchor = StateAnchor::new(
        ChainDomain::new(1, hash(1), hash(2))?,
        25_437_474,
        hash(3),
        hash(4),
        1_700_000_001,
        hash(5),
    )?;

    entries[0].observation_anchor = shifted_anchor.clone();
    assert!(UpstreamAuthorityLock::new(entries.clone()).is_err());

    for entry in &mut entries {
        entry.observation_anchor = shifted_anchor.clone();
    }
    let shifted_lock = UpstreamAuthorityLock::new(entries)?;
    assert!(shifted_lock.verify(&fixture.context).is_err());
    Ok(())
}

#[test]
fn bundle_replay_rejects_self_consistent_but_externally_unlocked_d06_authority() -> TestResult {
    let fixture = replay_context()?;
    let lock = authority_lock(&fixture.context)?;
    let mut stages = fixture.context.stages().to_vec();
    let d06 = stages
        .iter_mut()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc006DiscoveryAave)
        .ok_or("missing D06 authority")?;
    d06.artifact_sha256 = hash(241);

    let admitted_evidence = stages
        .iter()
        .map(|stage| CapitalEvidenceRef::Artifact(stage.artifact_sha256))
        .collect::<Vec<_>>();
    let d08_receipt = fixture
        .context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing D08 receipt")?;
    let d09_receipt = fixture
        .context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == UpstreamCensusStage::Rmc009PositionUniverse)
        .ok_or("missing D09 receipt")?;
    let forged_context = CapitalCertificationContext::new(stages, admitted_evidence)?
        .with_consumption_receipts(vec![d08_receipt, d09_receipt])?;

    let d08_authority = forged_context
        .stages()
        .iter()
        .find(|stage| stage.stage == UpstreamCensusStage::Rmc008StateAdmission)
        .ok_or("missing D08 authority")?;
    let d08_context = D08CapitalImportContext {
        anchor: anchor(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08_authority.artifact_sha256)],
    };
    let imported = import_d08_capital_sources(
        &fixture.d08_states,
        &fixture.d08_tokens,
        &fixture.d08_facts,
        &fixture.d08_manifest,
        d08_authority,
        &d08_context,
    )?;
    let mut ledger = CapitalCensusLedger::evidentiary();
    for source in imported.sources {
        ledger.register_source(source)?;
    }
    ledger.evaluate_all()?;

    const CODE_COMMIT: &str = "7777777777777777777777777777777777777777";
    const CODE_TREE: &str = "8888888888888888888888888888888888888888";
    let exact_anchor = anchor();
    let provenance = ArtifactProvenance::for_anchor(&exact_anchor, CODE_COMMIT, CODE_TREE)?;
    let bundle = export_capital_artifacts(&ledger, &forged_context, &provenance)?;

    assert!(verify_capital_bundle_with_upstream_replay_for_code(
        &bundle,
        CODE_COMMIT,
        CODE_TREE,
        &lock,
        D08ReplayInputs {
            state_manifest_jsonl: &fixture.d08_states,
            token_admission_jsonl: &fixture.d08_tokens,
            pool_and_factory_facts_json: &fixture.d08_facts,
            evidence_manifest_json: &fixture.d08_manifest,
        },
        D09ReplayInputs {
            account_manifest_jsonl: &fixture.d09_accounts,
            account_summary_json: &fixture.d09_summary,
            evidence_manifest_json: &fixture.d09_manifest,
        },
    )
    .is_err());
    Ok(())
}
