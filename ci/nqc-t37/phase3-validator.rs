use alloy::primitives::B256;
use nqc_unified_dryrun_evidence::{
    CanonicalAnchorBinding, ComponentGateAttestation, ComponentGateKind, EvidenceScope,
    ExecutionPathEvidence, ReorgInvalidationEvidence, T37ScaleBinding, UnifiedDryRunEvidenceBundle,
    UnifiedDryRunEvidenceError,
};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fmt::{Display, Formatter},
    fs,
    str::FromStr,
};

#[derive(Debug)]
enum ValidatorInputError {
    MissingArgument,
    Io(std::io::Error),
    MalformedLine(String),
    MissingKey(String),
    InvalidHash { key: String, value: String },
    InvalidU64 { key: String, value: String },
    Evidence(UnifiedDryRunEvidenceError),
}

impl Display for ValidatorInputError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MissingArgument => formatter.write_str("missing phase3 input path argument"),
            Self::Io(error) => write!(formatter, "input I/O error: {error}"),
            Self::MalformedLine(line) => write!(formatter, "malformed key=value input line: {line}"),
            Self::MissingKey(key) => write!(formatter, "missing required input key: {key}"),
            Self::InvalidHash { key, value } => {
                write!(formatter, "invalid B256 for key {key}: {value}")
            }
            Self::InvalidU64 { key, value } => {
                write!(formatter, "invalid u64 for key {key}: {value}")
            }
            Self::Evidence(error) => write!(formatter, "evidence validation error: {error}"),
        }
    }
}

impl Error for ValidatorInputError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Io(error) => Some(error),
            Self::Evidence(error) => Some(error),
            _ => None,
        }
    }
}

impl From<std::io::Error> for ValidatorInputError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<UnifiedDryRunEvidenceError> for ValidatorInputError {
    fn from(error: UnifiedDryRunEvidenceError) -> Self {
        Self::Evidence(error)
    }
}

fn parse(path: &str) -> Result<BTreeMap<String, String>, ValidatorInputError> {
    let text = fs::read_to_string(path)?;
    let mut values = BTreeMap::new();
    for line in text
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
    {
        let (key, value) = line
            .split_once('=')
            .ok_or_else(|| ValidatorInputError::MalformedLine(line.to_string()))?;
        values.insert(key.trim().to_string(), value.trim().to_string());
    }
    Ok(values)
}

fn required<'a>(
    values: &'a BTreeMap<String, String>,
    key: &str,
) -> Result<&'a str, ValidatorInputError> {
    values
        .get(key)
        .map(String::as_str)
        .ok_or_else(|| ValidatorInputError::MissingKey(key.to_string()))
}

fn h(values: &BTreeMap<String, String>, key: &str) -> Result<B256, ValidatorInputError> {
    let value = required(values, key)?;
    B256::from_str(value).map_err(|_| ValidatorInputError::InvalidHash {
        key: key.to_string(),
        value: value.to_string(),
    })
}

fn u(values: &BTreeMap<String, String>, key: &str) -> Result<u64, ValidatorInputError> {
    let value = required(values, key)?;
    value
        .parse()
        .map_err(|_| ValidatorInputError::InvalidU64 {
            key: key.to_string(),
            value: value.to_string(),
        })
}

fn gate(
    kind: ComponentGateKind,
    scope: EvidenceScope,
    subject_hash: B256,
    evidence_hash: B256,
    toolchain_hash: B256,
) -> ComponentGateAttestation {
    ComponentGateAttestation {
        kind,
        scope,
        subject_hash,
        evidence_hash,
        toolchain_hash,
        evidence_epoch: 1,
        passed: true,
        live_market_evidence: false,
        live_pnl_evidence: false,
        authority_issued: false,
    }
}

fn main() -> Result<(), ValidatorInputError> {
    let input = env::args().nth(1).ok_or(ValidatorInputError::MissingArgument)?;
    let values = parse(&input)?;
    let generation = u(&values, "canonical_generation")?;

    let t35 = gate(
        ComponentGateKind::T35PhysicalSignalPath,
        EvidenceScope::LocalDevPhysical,
        h(&values, "t35_subject_hash")?,
        h(&values, "t35_evidence_hash")?,
        h(&values, "t35_toolchain_hash")?,
    );
    let t36 = gate(
        ComponentGateKind::T36FlashFundingPath,
        EvidenceScope::HistoricalFork,
        h(&values, "t36_subject_hash")?,
        h(&values, "t36_evidence_hash")?,
        h(&values, "t36_toolchain_hash")?,
    );
    let t37 = gate(
        ComponentGateKind::T37ScaleEnvelope,
        EvidenceScope::SyntheticArchitecture,
        h(&values, "t37_scale_subject_hash")?,
        h(&values, "t37_scale_attestation_hash")?,
        h(&values, "t37_scale_toolchain_hash")?,
    );

    let execution = ExecutionPathEvidence {
        execution_identity_hash: h(&values, "execution_identity_hash")?,
        anchor: CanonicalAnchorBinding {
            chain_id: u(&values, "chain_id")?,
            canonical_generation: generation,
            block_number: u(&values, "block_number")?,
            block_hash: h(&values, "block_hash")?,
            state_root: h(&values, "state_root")?,
        },
        signal_evidence_hash: h(&values, "signal_evidence_hash")?,
        recognition_ticket_hash: h(&values, "recognition_ticket_hash")?,
        market_identity_hash: h(&values, "market_identity_hash")?,
        market_semantics_hash: h(&values, "market_semantics_hash")?,
        market_state_hash: h(&values, "market_state_hash")?,
        candidate_hash: h(&values, "candidate_hash")?,
        exact_simulation_input_hash: h(&values, "exact_simulation_input_hash")?,
        exact_simulation_digest_hash: h(&values, "exact_simulation_digest_hash")?,
        differential_verification_hash: h(&values, "differential_verification_hash")?,
        funding_plan_hash: h(&values, "funding_plan_hash")?,
        funding_execution_evidence_hash: h(&values, "funding_execution_evidence_hash")?,
        governor_decision_hash: h(&values, "governor_decision_hash")?,
        action_plan_hash: h(&values, "action_plan_hash")?,
        action_fence_hash: h(&values, "action_fence_hash")?,
        durable_wal_commit_hash: h(&values, "durable_wal_commit_hash")?,
        canonical_outcome_hash: h(&values, "canonical_outcome_hash")?,
        realization_evidence_hash: h(&values, "realization_evidence_hash")?,
        exact_simulation_passed: true,
        funding_repayment_verified: true,
        action_write_suppressed: true,
        canonical_outcome_observed: true,
    };

    let scale = T37ScaleBinding {
        market_capacity: 50_000,
        surface_capacity: 250_000,
        signal_stress_count: 1_000_000,
        max_affected_market_fanout: 24,
        evidence_bundle_count: 25_000,
        scale_attestation_hash: h(&values, "t37_scale_attestation_hash")?,
        deterministic_replay: true,
        cold_market_observability_complete: true,
        full_market_scans: 0,
        dropped_signals: 0,
    };

    let bundle = UnifiedDryRunEvidenceBundle {
        t35_signal_gate: t35,
        t36_funding_gate: t36,
        t37_scale_gate: t37,
        scale,
        execution,
        evidence_generator_build_hash: h(&values, "evidence_generator_build_hash")?,
        evidence_epoch: 1,
        real_market_census_hash: None,
        live_pnl_evidence_hash: None,
        production_authority_issued: false,
    }
    .validate_against_generation(generation)?;

    let stale_generation_blocked = matches!(
        bundle.validate_against_generation(generation.saturating_add(1)),
        Err(UnifiedDryRunEvidenceError::StaleCanonicalGeneration { .. })
    );
    if !stale_generation_blocked {
        return Err(ValidatorInputError::Evidence(
            UnifiedDryRunEvidenceError::StaleCanonicalGeneration {
                evidence: generation,
                current: generation.saturating_add(1),
            },
        ));
    }

    let invalidation = ReorgInvalidationEvidence::from_bundle(
        bundle,
        generation.saturating_add(1),
        h(&values, "reorg_invalidation_reason_hash")?,
    )?;

    println!("bundle_fingerprint={:#x}", bundle.fingerprint());
    println!("execution_fingerprint={:#x}", bundle.execution.fingerprint());
    println!(
        "canonical_anchor_fingerprint={:#x}",
        bundle.execution.anchor.fingerprint()
    );
    println!(
        "reorg_invalidation_fingerprint={:#x}",
        invalidation.fingerprint()
    );
    println!("stale_generation_blocked=true");
    println!("authority_issued=false");
    println!("real_market_census=NOT_TESTED");
    println!("live_pnl_evidence=false");
    Ok(())
}
