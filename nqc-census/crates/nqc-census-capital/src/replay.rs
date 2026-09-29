use crate::{
    demands::import_d09_borrower_demands,
    upstream::{import_d08_capital_sources, D08CapitalImportContext},
    CapitalCertificationContext, CapitalError, CapitalEvidenceRef, UpstreamCensusStage,
    UpstreamConsumptionReceipt, UpstreamStageAuthority,
};

#[derive(Debug, Clone, Copy)]
pub struct D08ReplayInputs<'a> {
    pub state_manifest_jsonl: &'a [u8],
    pub token_admission_jsonl: &'a [u8],
    pub pool_and_factory_facts_json: &'a [u8],
    pub evidence_manifest_json: &'a [u8],
}

#[derive(Debug, Clone, Copy)]
pub struct D09ReplayInputs<'a> {
    pub account_manifest_jsonl: &'a [u8],
    pub account_summary_json: &'a [u8],
    pub evidence_manifest_json: &'a [u8],
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UpstreamReplayVerification {
    pub d08_source_count: usize,
    pub d09_requirement_count: usize,
    pub d08_receipt: UpstreamConsumptionReceipt,
    pub d09_receipt: UpstreamConsumptionReceipt,
}

fn stage_authority(
    context: &CapitalCertificationContext,
    stage: UpstreamCensusStage,
) -> Result<&UpstreamStageAuthority, CapitalError> {
    context
        .stages()
        .iter()
        .find(|authority| authority.stage == stage)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "replay stage authority missing",
        ))
}

fn expected_receipt(
    context: &CapitalCertificationContext,
    stage: UpstreamCensusStage,
) -> Result<UpstreamConsumptionReceipt, CapitalError> {
    context
        .consumption_receipts()
        .copied()
        .find(|receipt| receipt.stage() == stage)
        .ok_or(CapitalError::InvalidUpstreamAuthority(
            "replay consumption receipt missing",
        ))
}

/// Re-runs the exact D08 and D09 importers over the consumed upstream bytes
/// and requires their deterministic receipts to equal the receipts committed
/// by the D11 certification context.
///
/// This is deliberately separate from ordinary artifact verification. A D11
/// artifact bundle alone cannot prove the relationship between upstream bytes
/// and downstream source/requirement IDs unless those upstream bytes are
/// supplied for replay.
pub fn verify_upstream_consumption_by_replay(
    context: &CapitalCertificationContext,
    d08: D08ReplayInputs<'_>,
    d09: D09ReplayInputs<'_>,
) -> Result<UpstreamReplayVerification, CapitalError> {
    let d08_authority = stage_authority(context, UpstreamCensusStage::Rmc008StateAdmission)?;
    let d09_authority = stage_authority(context, UpstreamCensusStage::Rmc009PositionUniverse)?;

    let d08_context = D08CapitalImportContext {
        anchor: context.observation_anchor().clone(),
        evidence: vec![CapitalEvidenceRef::Artifact(d08_authority.artifact_sha256)],
    };
    let d08_import = import_d08_capital_sources(
        d08.state_manifest_jsonl,
        d08.token_admission_jsonl,
        d08.pool_and_factory_facts_json,
        d08.evidence_manifest_json,
        d08_authority,
        &d08_context,
    )?;
    if !d08_import.is_conserved() {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-008 capital import is not conserved",
        ));
    }
    let d08_receipt = d08_import.consumption_receipt()?;
    if d08_receipt
        != expected_receipt(context, UpstreamCensusStage::Rmc008StateAdmission)?
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-008 receipt differs from committed receipt",
        ));
    }

    let d09_import = import_d09_borrower_demands(
        d09.account_manifest_jsonl,
        d09.account_summary_json,
        d09.evidence_manifest_json,
        d09_authority,
        context.observation_anchor(),
    )?;
    if !d09_import.is_conserved() {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-009 demand import is not conserved",
        ));
    }
    let d09_receipt = d09_import.consumption_receipt()?;
    if d09_receipt
        != expected_receipt(context, UpstreamCensusStage::Rmc009PositionUniverse)?
    {
        return Err(CapitalError::InvalidUpstreamAuthority(
            "replayed RMC-009 receipt differs from committed receipt",
        ));
    }

    Ok(UpstreamReplayVerification {
        d08_source_count: d08_import.sources.len(),
        d09_requirement_count: d09_import.requirements_certified,
        d08_receipt,
        d09_receipt,
    })
}
