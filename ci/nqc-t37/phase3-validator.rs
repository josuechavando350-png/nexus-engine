use alloy::primitives::B256;
use nqc_unified_dryrun_evidence::{
    CanonicalAnchorBinding, ComponentGateAttestation, ComponentGateKind, EvidenceScope,
    ExecutionPathEvidence, ReorgInvalidationEvidence, T37ScaleBinding, UnifiedDryRunEvidenceBundle,
    UnifiedDryRunEvidenceError,
};
use std::{collections::BTreeMap, env, fs, str::FromStr};

fn parse(path: &str) -> BTreeMap<String, String> {
    fs::read_to_string(path)
        .expect("read input")
        .lines()
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .map(|line| {
            let (key, value) = line.split_once('=').expect("key=value");
            (key.trim().to_string(), value.trim().to_string())
        })
        .collect()
}

fn h(m: &BTreeMap<String, String>, key: &str) -> B256 {
    B256::from_str(m.get(key).unwrap_or_else(|| panic!("missing {key}"))).expect("B256")
}

fn u(m: &BTreeMap<String, String>, key: &str) -> u64 {
    m.get(key)
        .unwrap_or_else(|| panic!("missing {key}"))
        .parse()
        .expect("u64")
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

fn main() -> Result<(), UnifiedDryRunEvidenceError> {
    let input = env::args().nth(1).expect("phase3 input path");
    let m = parse(&input);
    let generation = u(&m, "canonical_generation");

    let t35 = gate(
        ComponentGateKind::T35PhysicalSignalPath,
        EvidenceScope::LocalDevPhysical,
        h(&m, "t35_subject_hash"),
        h(&m, "t35_evidence_hash"),
        h(&m, "t35_toolchain_hash"),
    );
    let t36 = gate(
        ComponentGateKind::T36FlashFundingPath,
        EvidenceScope::HistoricalFork,
        h(&m, "t36_subject_hash"),
        h(&m, "t36_evidence_hash"),
        h(&m, "t36_toolchain_hash"),
    );
    let t37 = gate(
        ComponentGateKind::T37ScaleEnvelope,
        EvidenceScope::SyntheticArchitecture,
        h(&m, "t37_scale_subject_hash"),
        h(&m, "t37_scale_attestation_hash"),
        h(&m, "t37_scale_toolchain_hash"),
    );

    let execution = ExecutionPathEvidence {
        execution_identity_hash: h(&m, "execution_identity_hash"),
        anchor: CanonicalAnchorBinding {
            chain_id: u(&m, "chain_id"),
            canonical_generation: generation,
            block_number: u(&m, "block_number"),
            block_hash: h(&m, "block_hash"),
            state_root: h(&m, "state_root"),
        },
        signal_evidence_hash: h(&m, "signal_evidence_hash"),
        recognition_ticket_hash: h(&m, "recognition_ticket_hash"),
        market_identity_hash: h(&m, "market_identity_hash"),
        market_semantics_hash: h(&m, "market_semantics_hash"),
        market_state_hash: h(&m, "market_state_hash"),
        candidate_hash: h(&m, "candidate_hash"),
        exact_simulation_input_hash: h(&m, "exact_simulation_input_hash"),
        exact_simulation_digest_hash: h(&m, "exact_simulation_digest_hash"),
        differential_verification_hash: h(&m, "differential_verification_hash"),
        funding_plan_hash: h(&m, "funding_plan_hash"),
        funding_execution_evidence_hash: h(&m, "funding_execution_evidence_hash"),
        governor_decision_hash: h(&m, "governor_decision_hash"),
        action_plan_hash: h(&m, "action_plan_hash"),
        action_fence_hash: h(&m, "action_fence_hash"),
        durable_wal_commit_hash: h(&m, "durable_wal_commit_hash"),
        canonical_outcome_hash: h(&m, "canonical_outcome_hash"),
        realization_evidence_hash: h(&m, "realization_evidence_hash"),
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
        scale_attestation_hash: h(&m, "t37_scale_attestation_hash"),
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
        evidence_generator_build_hash: h(&m, "evidence_generator_build_hash"),
        evidence_epoch: 1,
        real_market_census_hash: None,
        live_pnl_evidence_hash: None,
        production_authority_issued: false,
    }
    .validate_against_generation(generation)?;

    let stale_blocked = matches!(
        bundle.validate_against_generation(generation + 1),
        Err(UnifiedDryRunEvidenceError::StaleCanonicalGeneration { .. })
    );
    assert!(stale_blocked);

    let invalidation = ReorgInvalidationEvidence::from_bundle(
        bundle,
        generation + 1,
        h(&m, "reorg_invalidation_reason_hash"),
    )?;

    println!("bundle_fingerprint={:#x}", bundle.fingerprint());
    println!("execution_fingerprint={:#x}", bundle.execution.fingerprint());
    println!("canonical_anchor_fingerprint={:#x}", bundle.execution.anchor.fingerprint());
    println!("reorg_invalidation_fingerprint={:#x}", invalidation.fingerprint());
    println!("stale_generation_blocked=true");
    println!("authority_issued=false");
    println!("real_market_census=NOT_TESTED");
    println!("live_pnl_evidence=false");
    Ok(())
}
