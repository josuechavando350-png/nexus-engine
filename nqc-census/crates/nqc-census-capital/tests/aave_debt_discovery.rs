use nqc_census_capital::{
    aave_debt_discovery::{
        discover_d08_aave_debt_facilities, AaveDebtFacilityBlocker,
    },
    upstream::D08CapitalImportContext,
    CapitalEvidenceRef, CapitalError, GitObjectId, UpstreamCensusStage,
    UpstreamStageAuthority, UpstreamStageAuthoritySpec,
};
use nqc_census_chain::json::Json;
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use sha2::{Digest, Sha256};

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

fn plain_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn canonical(json: Json) -> Vec<u8> {
    json.canonical().unwrap_or_else(|_| unreachable!())
}

fn state_row(
    total_debt: &str,
    available: &str,
    borrow_cap_reached: bool,
    config_borrowing_enabled: bool,
    facts_borrowing_enabled: bool,
) -> Vec<u8> {
    let row = Json::object([
        ("schema_version", Json::uint(1)),
        ("protocol", Json::string("AAVE_V3")),
        ("market_id", Json::string(hash(30).to_hex())),
        ("asset", Json::string(address(31).to_hex())),
        ("reserve_id", Json::uint(7)),
        ("lifecycle", Json::string("CURRENT")),
        ("stage_state_reconstructable", Json::string("ADVANCE")),
        (
            "configuration",
            Json::object([
                ("active", Json::Bool(true)),
                ("paused", Json::Bool(false)),
                ("frozen", Json::Bool(false)),
                ("borrowing_enabled", Json::Bool(config_borrowing_enabled)),
                ("decimals", Json::uint(6)),
                ("borrow_cap_whole_tokens", Json::uint(1_000)),
                ("ltv_bps", Json::uint(7_500)),
                ("liquidation_threshold_bps", Json::uint(8_000)),
                ("liquidation_bonus_bps", Json::uint(10_500)),
                ("reserve_factor_bps", Json::uint(1_000)),
                ("debt_ceiling_centi_units", Json::uint(0)),
                ("borrowable_in_isolation", Json::Bool(false)),
                ("siloed_borrowing", Json::Bool(false)),
            ]),
        ),
        (
            "indexes",
            Json::object([(
                "current_variable_borrow_rate",
                Json::string("32000000000000000000000000"),
            )]),
        ),
        (
            "protocol_facts",
            Json::object([
                ("active", Json::Bool(true)),
                ("paused", Json::Bool(false)),
                ("frozen", Json::Bool(false)),
                ("borrowing_enabled", Json::Bool(facts_borrowing_enabled)),
                ("available_liquidity", Json::string(available)),
                (
                    "total_variable_and_stable_debt",
                    Json::string(total_debt),
                ),
                ("borrow_cap_reached", Json::Bool(borrow_cap_reached)),
            ]),
        ),
    ]);
    let mut bytes = canonical(row);
    bytes.push(b'\n');
    bytes
}


fn token_admission(blockers: &[&str]) -> Vec<u8> {
    let status = if blockers.is_empty() {
        "PROVEN_COMPATIBLE"
    } else {
        "BLOCKED"
    };
    let blocker_rows = blockers
        .iter()
        .map(|blocker| Json::string(*blocker))
        .collect::<Vec<_>>();
    let row = Json::object([
        ("token", Json::string(address(31).to_hex())),
        (
            "execution_compatibility",
            Json::object([
                ("status", Json::string(status)),
                ("blockers", Json::array(blocker_rows)),
            ]),
        ),
    ]);
    let mut bytes = canonical(row);
    bytes.push(b'\n');
    bytes
}


struct Bundle {
    state: Vec<u8>,
    token: Vec<u8>,
    pool: Vec<u8>,
    manifest: Vec<u8>,
    authority: UpstreamStageAuthority,
    context: D08CapitalImportContext,
}

fn build_bundle(state: Vec<u8>) -> Result<Bundle, CapitalError> {
    build_bundle_with_token_blockers(state, &[])
}

fn build_bundle_with_token_blockers(
    state: Vec<u8>,
    token_blockers: &[&str],
) -> Result<Bundle, CapitalError> {
    let observation_anchor = anchor();
    let token = token_admission(token_blockers);
    let pool = canonical(Json::object([(
        "aave_pool",
        Json::object([
            ("pool", Json::string(address(40).to_hex())),
            (
                "scalars",
                Json::object([(
                    "FLASHLOAN_PREMIUM_TOTAL()",
                    Json::object([
                        ("status", Json::string("RETURNED")),
                        (
                            "data",
                            Json::string(format!(
                                "0x{}0005",
                                "00".repeat(30)
                            )),
                        ),
                    ]),
                )]),
            ),
        ]),
    )]));

    let code_commit = GitObjectId::parse_hex(&"11".repeat(20))?;
    let code_tree = GitObjectId::parse_hex(&"22".repeat(20))?;

    let artifact_row = |path: &'static str, bytes: &[u8]| {
        Json::object([
            ("path", Json::string(path)),
            ("sha256", Json::string(plain_hex(&sha256(bytes)))),
            ("bytes", Json::uint(bytes.len() as u64)),
        ])
    };

    let manifest = canonical(Json::object([
        ("schema_version", Json::uint(1)),
        ("code_commit", Json::string(code_commit.to_hex())),
        ("code_tree", Json::string(code_tree.to_hex())),
        (
            "observation_anchor",
            Json::object([
                (
                    "chain_id",
                    Json::uint(observation_anchor.chain().chain_id()),
                ),
                (
                    "genesis_hash",
                    Json::string(observation_anchor.chain().genesis_hash().to_hex()),
                ),
                (
                    "fork_lineage",
                    Json::string(observation_anchor.chain().fork_lineage().to_hex()),
                ),
                (
                    "block_number",
                    Json::uint(observation_anchor.block_number()),
                ),
                (
                    "block_hash",
                    Json::string(observation_anchor.block_hash().to_hex()),
                ),
                (
                    "parent_hash",
                    Json::string(observation_anchor.parent_hash().to_hex()),
                ),
                ("timestamp", Json::uint(observation_anchor.timestamp())),
                (
                    "state_root",
                    Json::string(observation_anchor.state_root().to_hex()),
                ),
            ]),
        ),
        ("generated_at", Json::string("2023-11-14T22:13:20Z")),
        (
            "artifacts",
            Json::array(vec![
                artifact_row("market-state-manifest.jsonl", &state),
                artifact_row("token-admission.jsonl", &token),
                artifact_row("pool-and-factory-facts.json", &pool),
            ]),
        ),
    ]));
    let artifact_sha = Hash32::new(sha256(&manifest))
        .map_err(|_| CapitalError::InvalidCanonical("test artifact hash is zero"))?;
    let authority = UpstreamStageAuthority::new(UpstreamStageAuthoritySpec {
        stage: UpstreamCensusStage::Rmc008StateAdmission,
        code_commit,
        code_tree,
        artifact_sha256: artifact_sha,
        observation_anchor: observation_anchor.clone(),
        unresolved_mismatch_count: 0,
        unknown_failure_count: 0,
        coverage_complete: true,
        admitted: true,
    })?;
    let context = D08CapitalImportContext {
        anchor: observation_anchor,
        evidence: vec![CapitalEvidenceRef::Artifact(artifact_sha)],
    };
    Ok(Bundle {
        state,
        token,
        pool,
        manifest,
        authority,
        context,
    })
}

#[test]
fn discovers_exact_borrow_cap_upper_bound_from_authenticated_d08() -> TestResult {
    let bundle = build_bundle(state_row(
        "400000000",
        "800000000",
        false,
        true,
        true,
    ))?;
    let discovery = discover_d08_aave_debt_facilities(
        &bundle.state,
        &bundle.token,
        &bundle.pool,
        &bundle.manifest,
        &bundle.authority,
        &bundle.context,
    )?;

    assert!(discovery.is_conserved());
    assert_eq!(discovery.candidate_count, 1);
    assert_eq!(discovery.facility_count, 1);
    assert_eq!(discovery.rejected_count, 0);

    let facility = &discovery.facilities[0];
    assert_eq!(facility.market_id, hash(30));
    assert_eq!(facility.asset, address(31));
    assert_eq!(facility.pool, address(40));
    assert_eq!(facility.reserve_id, 7);
    assert_eq!(facility.borrow_cap.unwrap().to_hex(), format!("{:064x}", 1_000_000_000_u64));
    assert_eq!(
        facility.borrow_cap_remaining.unwrap().to_hex(),
        format!("{:064x}", 600_000_000_u64)
    );
    assert_eq!(
        facility.observed_borrowable_upper_bound.to_hex(),
        format!("{:064x}", 600_000_000_u64)
    );
    assert_eq!(
        facility.protocol_borrowable_upper_bound.to_hex(),
        format!("{:064x}", 600_000_000_u64)
    );
    assert_eq!(
        facility.token_compatible_borrowable_upper_bound.to_hex(),
        format!("{:064x}", 600_000_000_u64)
    );
    assert!(facility.token_execution_blockers.is_empty());
    assert!(facility.blockers.is_empty());
    assert!(facility.portfolio_collateral_resolution_required);
    assert_eq!(facility.ltv_bps, 7_500);
    assert_eq!(facility.liquidation_threshold_bps, 8_000);
    assert_eq!(facility.liquidation_bonus_bps, 10_500);
    assert_eq!(facility.evidence.len(), 1);
    Ok(())
}


#[test]
fn d08_token_blocker_preserves_protocol_capacity_but_blocks_execution_compatibility() -> TestResult {
    let state = state_row(
        "400000000",
        "800000000",
        false,
        true,
        true,
    );
    let compatible_bundle = build_bundle(state.clone())?;
    let blocked_bundle = build_bundle_with_token_blockers(
        state,
        &["UNSUPPORTED_TOKEN_BEHAVIOR"],
    )?;

    let compatible = discover_d08_aave_debt_facilities(
        &compatible_bundle.state,
        &compatible_bundle.token,
        &compatible_bundle.pool,
        &compatible_bundle.manifest,
        &compatible_bundle.authority,
        &compatible_bundle.context,
    )?;
    let blocked = discover_d08_aave_debt_facilities(
        &blocked_bundle.state,
        &blocked_bundle.token,
        &blocked_bundle.pool,
        &blocked_bundle.manifest,
        &blocked_bundle.authority,
        &blocked_bundle.context,
    )?;

    let compatible_facility = &compatible.facilities[0];
    let blocked_facility = &blocked.facilities[0];

    assert_eq!(
        blocked_facility.protocol_borrowable_upper_bound.to_hex(),
        format!("{:064x}", 600_000_000_u64)
    );
    assert_eq!(
        blocked_facility.token_compatible_borrowable_upper_bound,
        nqc_census_capital::Amount256::ZERO
    );
    assert_eq!(
        blocked_facility.token_execution_blockers,
        vec!["UNSUPPORTED_TOKEN_BEHAVIOR".to_owned()]
    );
    assert!(blocked_facility.blockers.is_empty());
    assert_ne!(
        compatible_facility.facility_commitment,
        blocked_facility.facility_commitment
    );
    Ok(())
}


#[test]
fn borrow_cap_reached_is_preserved_as_protocol_blocker() -> TestResult {
    let bundle = build_bundle(state_row(
        "1000000000",
        "800000000",
        true,
        true,
        true,
    ))?;
    let discovery = discover_d08_aave_debt_facilities(
        &bundle.state,
        &bundle.token,
        &bundle.pool,
        &bundle.manifest,
        &bundle.authority,
        &bundle.context,
    )?;
    let facility = &discovery.facilities[0];
    assert_eq!(facility.observed_borrowable_upper_bound.to_hex(), "0".repeat(64));
    assert_eq!(facility.protocol_borrowable_upper_bound.to_hex(), "0".repeat(64));
    assert_eq!(
        facility.blockers,
        vec![AaveDebtFacilityBlocker::BorrowCapReached]
    );
    Ok(())
}

#[test]
fn protocol_facts_cannot_contradict_decoded_configuration() -> TestResult {
    let bundle = build_bundle(state_row(
        "400000000",
        "800000000",
        false,
        false,
        true,
    ))?;
    assert!(matches!(
        discover_d08_aave_debt_facilities(
            &bundle.state,
            &bundle.token,
            &bundle.pool,
            &bundle.manifest,
            &bundle.authority,
            &bundle.context,
        ),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}

#[test]
fn substituted_anchor_is_rejected_before_discovery() -> TestResult {
    let mut bundle = build_bundle(state_row(
        "400000000",
        "800000000",
        false,
        true,
        true,
    ))?;
    bundle.context.anchor = StateAnchor::new(
        bundle.context.anchor.chain().clone(),
        bundle.context.anchor.block_number() + 1,
        hash(50),
        bundle.context.anchor.block_hash(),
        bundle.context.anchor.timestamp() + 12,
        hash(51),
    )?;
    assert!(matches!(
        discover_d08_aave_debt_facilities(
            &bundle.state,
            &bundle.token,
            &bundle.pool,
            &bundle.manifest,
            &bundle.authority,
            &bundle.context,
        ),
        Err(CapitalError::AnchorMismatch)
    ));
    Ok(())
}


#[test]
fn duplicate_aave_debt_candidate_is_rejected() -> TestResult {
    let row = state_row(
        "400000000",
        "800000000",
        false,
        true,
        true,
    );
    let mut duplicated = row.clone();
    duplicated.extend_from_slice(&row);
    let bundle = build_bundle(duplicated)?;

    assert!(matches!(
        discover_d08_aave_debt_facilities(
            &bundle.state,
            &bundle.token,
            &bundle.pool,
            &bundle.manifest,
            &bundle.authority,
            &bundle.context,
        ),
        Err(CapitalError::InvalidCanonical(_))
    ));
    Ok(())
}


#[test]
fn tampered_state_bytes_fail_manifest_binding() -> TestResult {
    let mut bundle = build_bundle(state_row(
        "400000000",
        "800000000",
        false,
        true,
        true,
    ))?;
    bundle.state.extend_from_slice(b"\n");
    assert!(matches!(
        discover_d08_aave_debt_facilities(
            &bundle.state,
            &bundle.token,
            &bundle.pool,
            &bundle.manifest,
            &bundle.authority,
            &bundle.context,
        ),
        Err(CapitalError::CanonicalDigestMismatch)
    ));
    Ok(())
}
