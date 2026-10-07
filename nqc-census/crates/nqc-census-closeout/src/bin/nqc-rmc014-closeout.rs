use nqc_census_chain::json::Json;
use nqc_census_closeout::{
    CloseoutCertificate, EconomicBoundary, GitObjectId, PipelineCounts, RmcStage, StageProof,
};
use nqc_census_core::Hash32;
use sha2::{Digest, Sha256};
use std::{
    error::Error,
    fs,
    path::{Path, PathBuf},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let lock = PathBuf::from(args.next().ok_or("missing authority-lock path")?);
    let out = PathBuf::from(args.next().ok_or("missing output directory")?);
    if args.next().is_some() {
        return Err("usage: nqc-rmc014-closeout <authority-lock.json> <output-dir>".into());
    }
    certify(&lock, &out)
}

fn certify(lock_path: &Path, out_dir: &Path) -> Result<()> {
    if out_dir.exists() && fs::read_dir(out_dir)?.next().is_some() {
        return Err(format!("output directory is not empty: {}", out_dir.display()).into());
    }
    fs::create_dir_all(out_dir)?;

    let lock_bytes = fs::read(lock_path)?;
    let lock_sha256 = sha256_hex(&lock_bytes);
    let root = Json::parse(&lock_bytes)?;

    require_u64(&root, "schema_version")?
        .eq(&3)
        .then_some(())
        .ok_or("authority lock schema_version must be 3")?;
    if require_str(&root, "status")? != "PINNED" {
        return Err("terminal authority lock is not PINNED".into());
    }
    if require_bool(&root, "real_market_census_closed")? {
        return Err("source authority lock must never self-certify closure".into());
    }

    let required = require_array(&root, "required_terminal_stages")?;
    let expected = RmcStage::REQUIRED.map(RmcStage::code);
    if required.len() != expected.len()
        || required
            .iter()
            .zip(expected)
            .any(|(value, stage)| value.as_str() != Some(stage))
    {
        return Err("required_terminal_stages is not exactly RMC-006..RMC-013".into());
    }

    let stage_rows = require_array(&root, "pinned_stages")?;
    if stage_rows.len() != RmcStage::REQUIRED.len() {
        return Err("pinned_stages must contain exactly eight rows".into());
    }
    let mut stages = Vec::with_capacity(stage_rows.len());
    let mut stage_json = Vec::with_capacity(stage_rows.len());
    for row in stage_rows {
        let stage = parse_stage(require_str(row, "stage")?)?;
        let artifact_sha256 = parse_hash(require_str(row, "artifact_digest")?)?;
        let authority_commitment = parse_hash(require_str(row, "authority_commitment")?)?;
        let coverage_commitment = parse_hash(require_str(row, "coverage_commitment")?)?;
        let evidence = require_array(row, "evidence")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .ok_or_else(|| "stage evidence entry must be a string".into())
                    .and_then(parse_hash)
            })
            .collect::<Result<Vec<_>>>()?;

        let proof = StageProof::new(
            stage,
            require_u64(row, "workflow_run_id")?,
            require_u64(row, "artifact_id")?,
            require_str(row, "workflow_name")?.to_owned(),
            require_str(row, "artifact_name")?.to_owned(),
            GitObjectId::parse_hex(require_str(row, "code_commit")?)?,
            GitObjectId::parse_hex(require_str(row, "code_tree")?)?,
            artifact_sha256,
            authority_commitment,
            coverage_commitment,
            require_bool(row, "admitted")?,
            require_bool(row, "coverage_complete")?,
            require_u64(row, "unresolved_mismatch_count")?,
            require_u64(row, "unknown_failure_count")?,
            require_u64(row, "blocker_count")?,
            evidence.clone(),
        )?;

        stage_json.push(Json::object([
            ("stage", Json::string(stage.code())),
            ("workflow_run_id", Json::uint(proof.workflow_run_id)),
            ("artifact_id", Json::uint(proof.artifact_id)),
            ("workflow_name", Json::string(&proof.workflow_name)),
            ("artifact_name", Json::string(&proof.artifact_name)),
            ("code_commit", Json::string(proof.code_commit.to_hex())),
            ("code_tree", Json::string(proof.code_tree.to_hex())),
            (
                "artifact_sha256",
                Json::string(proof.artifact_sha256.to_hex()),
            ),
            (
                "authority_commitment",
                Json::string(proof.authority_commitment.to_hex()),
            ),
            (
                "coverage_commitment",
                Json::string(proof.coverage_commitment.to_hex()),
            ),
            ("admitted", Json::Bool(proof.admitted)),
            ("coverage_complete", Json::Bool(proof.coverage_complete)),
            (
                "unresolved_mismatch_count",
                Json::uint(proof.unresolved_mismatch_count),
            ),
            (
                "unknown_failure_count",
                Json::uint(proof.unknown_failure_count),
            ),
            ("blocker_count", Json::uint(proof.blocker_count)),
            (
                "evidence",
                Json::array(evidence.iter().map(|hash| Json::string(hash.to_hex()))),
            ),
        ]));
        stages.push(proof);
    }

    let counts_json = root
        .get("pipeline_counts")
        .ok_or("missing pipeline_counts")?;
    let counts = PipelineCounts {
        markets_discovered: require_u64(counts_json, "markets_discovered")?,
        markets_canonicalized: require_u64(counts_json, "markets_canonicalized")?,
        markets_state_reconstructable: require_u64(counts_json, "markets_state_reconstructable")?,
        markets_economically_active: require_u64(counts_json, "markets_economically_active")?,
        markets_borrowable: require_u64(counts_json, "markets_borrowable")?,
        actionable_candidates: require_u64(counts_json, "actionable_candidates")?,
        capital_feasible_candidates: require_u64(counts_json, "capital_feasible_candidates")?,
        execution_simulatable_candidates: require_u64(
            counts_json,
            "execution_simulatable_candidates",
        )?,
        positive_gross_value_candidates: require_u64(
            counts_json,
            "positive_gross_value_candidates",
        )?,
        positive_success_path_net_candidates: require_u64(
            counts_json,
            "positive_success_path_net_candidates",
        )?,
        capacity_material_candidates: require_u64(counts_json, "capacity_material_candidates")?,
        shadow_eligible_candidates: require_u64(counts_json, "shadow_eligible_candidates")?,
    };

    let economics_json = root
        .get("economic_boundary")
        .ok_or("missing economic_boundary")?;
    let economics = EconomicBoundary {
        real_candidate_count: require_u64(economics_json, "real_candidate_count")?,
        economics_quote_count: require_u64(economics_json, "economics_quote_count")?,
        shadow_prediction_count: require_u64(economics_json, "shadow_prediction_count")?,
        capture_calibrated_count: require_u64(economics_json, "capture_calibrated_count")?,
        zero_own_capital_proven: require_bool(economics_json, "zero_own_capital_proven")?,
        realized_profitability_proven: require_bool(
            economics_json,
            "realized_profitability_proven",
        )?,
        monthly_target_probability_proven: require_bool(
            economics_json,
            "monthly_target_probability_proven",
        )?,
        conservative_realizable_capacity_only: require_bool(
            economics_json,
            "conservative_realizable_capacity_only",
        )?,
        global_capital_source_completeness_claimed: require_bool(
            economics_json,
            "global_capital_source_completeness_claimed",
        )?,
        global_route_venue_completeness_claimed: require_bool(
            economics_json,
            "global_route_venue_completeness_claimed",
        )?,
    };

    let terminal_evidence = require_array(&root, "terminal_evidence")?
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| "terminal evidence entry must be a string".into())
                .and_then(parse_hash)
        })
        .collect::<Result<Vec<_>>>()?;

    let certificate =
        CloseoutCertificate::certify(stages, counts, economics, terminal_evidence.clone())?;

    let certificate_json = Json::object([
        ("schema_version", Json::uint(1)),
        ("status", Json::string(certificate.status())),
        (
            "real_market_census_closed",
            Json::Bool(certificate.real_market_census_closed()),
        ),
        (
            "structural_chain_certified",
            Json::Bool(certificate.structural_chain_certified()),
        ),
        ("final_census_authority_stage", Json::string("RMC-017")),
        (
            "downstream_authorities_required",
            Json::array([
                Json::string("RMC-015"),
                Json::string("RMC-016"),
                Json::string("RMC-017"),
            ]),
        ),
        (
            "authority_lock_sha256",
            Json::string(format!("sha256:{lock_sha256}")),
        ),
        (
            "structural_commitment",
            Json::string(format!("0x{}", certificate.commitment_hex())),
        ),
        ("stages", Json::array(stage_json)),
        ("pipeline_counts", counts_to_json(certificate.counts())),
        (
            "economic_boundary",
            economics_to_json(certificate.economics()),
        ),
        (
            "terminal_evidence",
            Json::array(
                terminal_evidence
                    .iter()
                    .map(|hash| Json::string(hash.to_hex())),
            ),
        ),
        ("realized_profitability_proven", Json::Bool(false)),
        ("monthly_target_probability_proven", Json::Bool(false)),
        (
            "conservative_realizable_capacity_only",
            Json::Bool(
                certificate
                    .economics()
                    .conservative_realizable_capacity_only,
            ),
        ),
        (
            "global_capital_source_completeness_claimed",
            Json::Bool(
                certificate
                    .economics()
                    .global_capital_source_completeness_claimed,
            ),
        ),
        (
            "global_route_venue_completeness_claimed",
            Json::Bool(
                certificate
                    .economics()
                    .global_route_venue_completeness_claimed,
            ),
        ),
    ]);
    let bytes = certificate_json.canonical()?;
    let certificate_path = out_dir.join("rmc014-structural-certificate.json");
    fs::write(&certificate_path, &bytes)?;
    fs::write(
        out_dir.join("rmc014-structural-certificate.sha256"),
        format!(
            "{}  rmc014-structural-certificate.json\n",
            sha256_hex(&bytes)
        ),
    )?;

    println!("RMC_014_STRUCTURAL_CHAIN_CERTIFIED");
    println!(
        "RMC014_STRUCTURAL_COMMITMENT=0x{}",
        certificate.commitment_hex()
    );
    println!(
        "RMC014_STRUCTURAL_CERTIFICATE_SHA256={}",
        sha256_hex(&bytes)
    );
    Ok(())
}

fn counts_to_json(counts: PipelineCounts) -> Json {
    Json::object([
        ("markets_discovered", Json::uint(counts.markets_discovered)),
        (
            "markets_canonicalized",
            Json::uint(counts.markets_canonicalized),
        ),
        (
            "markets_state_reconstructable",
            Json::uint(counts.markets_state_reconstructable),
        ),
        (
            "markets_economically_active",
            Json::uint(counts.markets_economically_active),
        ),
        ("markets_borrowable", Json::uint(counts.markets_borrowable)),
        (
            "actionable_candidates",
            Json::uint(counts.actionable_candidates),
        ),
        (
            "capital_feasible_candidates",
            Json::uint(counts.capital_feasible_candidates),
        ),
        (
            "execution_simulatable_candidates",
            Json::uint(counts.execution_simulatable_candidates),
        ),
        (
            "positive_gross_value_candidates",
            Json::uint(counts.positive_gross_value_candidates),
        ),
        (
            "positive_success_path_net_candidates",
            Json::uint(counts.positive_success_path_net_candidates),
        ),
        (
            "capacity_material_candidates",
            Json::uint(counts.capacity_material_candidates),
        ),
        (
            "shadow_eligible_candidates",
            Json::uint(counts.shadow_eligible_candidates),
        ),
    ])
}

fn economics_to_json(economics: EconomicBoundary) -> Json {
    Json::object([
        (
            "real_candidate_count",
            Json::uint(economics.real_candidate_count),
        ),
        (
            "economics_quote_count",
            Json::uint(economics.economics_quote_count),
        ),
        (
            "shadow_prediction_count",
            Json::uint(economics.shadow_prediction_count),
        ),
        (
            "capture_calibrated_count",
            Json::uint(economics.capture_calibrated_count),
        ),
        (
            "zero_own_capital_proven",
            Json::Bool(economics.zero_own_capital_proven),
        ),
        (
            "realized_profitability_proven",
            Json::Bool(economics.realized_profitability_proven),
        ),
        (
            "monthly_target_probability_proven",
            Json::Bool(economics.monthly_target_probability_proven),
        ),
        (
            "conservative_realizable_capacity_only",
            Json::Bool(economics.conservative_realizable_capacity_only),
        ),
        (
            "global_capital_source_completeness_claimed",
            Json::Bool(economics.global_capital_source_completeness_claimed),
        ),
        (
            "global_route_venue_completeness_claimed",
            Json::Bool(economics.global_route_venue_completeness_claimed),
        ),
    ])
}

fn parse_stage(value: &str) -> Result<RmcStage> {
    match value {
        "RMC-006" => Ok(RmcStage::Rmc006),
        "RMC-007" => Ok(RmcStage::Rmc007),
        "RMC-008" => Ok(RmcStage::Rmc008),
        "RMC-009" => Ok(RmcStage::Rmc009),
        "RMC-010" => Ok(RmcStage::Rmc010),
        "RMC-011" => Ok(RmcStage::Rmc011),
        "RMC-012" => Ok(RmcStage::Rmc012),
        "RMC-013" => Ok(RmcStage::Rmc013),
        _ => Err(format!("unknown stage: {value}").into()),
    }
}

fn parse_hash(value: &str) -> Result<Hash32> {
    let hex = value
        .strip_prefix("sha256:")
        .or_else(|| value.strip_prefix("0x"))
        .unwrap_or(value);
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("hash must contain exactly 64 hex characters".into());
    }
    Ok(Hash32::parse_hex(&format!(
        "0x{}",
        hex.to_ascii_lowercase()
    ))?)
}

fn require_str<'a>(value: &'a Json, key: &str) -> Result<&'a str> {
    value
        .get(key)
        .and_then(Json::as_str)
        .ok_or_else(|| format!("missing string field {key}").into())
}

fn require_bool(value: &Json, key: &str) -> Result<bool> {
    value
        .get(key)
        .and_then(Json::as_bool)
        .ok_or_else(|| format!("missing bool field {key}").into())
}

fn require_u64(value: &Json, key: &str) -> Result<u64> {
    let raw = value
        .get(key)
        .and_then(Json::as_i64)
        .ok_or_else(|| format!("missing integer field {key}"))?;
    u64::try_from(raw).map_err(|_| format!("negative integer field {key}").into())
}

fn require_array<'a>(value: &'a Json, key: &str) -> Result<&'a [Json]> {
    value
        .get(key)
        .and_then(Json::as_array)
        .ok_or_else(|| format!("missing array field {key}").into())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}
