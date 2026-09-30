//! Terminal RMC-012 actionability bridge.
//!
//! Consumes exact, content-addressed RMC-008 and RMC-009 closeouts, enumerates
//! every below-one Aave borrower supply/debt pair, executes the immutable
//! certified PFT liquidation sizing, and emits one admitted or rejected record
//! per pair. No economic filter is allowed to erase a protocol-actionable pair.

use alloy::primitives::U256;
use nqc_census_capital::{
    artifacts::parse_capital_sources_artifact,
    replay::{UpstreamAuthorityLock, UpstreamAuthorityLockEntry},
    upstream::d08_aave_flash_terms,
    Amount256, CapitalFeasibility, UpstreamCensusStage,
};
use nqc_census_core::{Address, ChainDomain, Hash32, StateAnchor};
use nqc_census_portfolio::{
    actionability::{
        evaluate_protocol_native_flash_promotion, promote_protocol_native_flash_liquidation,
        ActionabilityCoverage, ActionabilityPair, ActionabilityRecord, ActionabilityRejectionReason,
        ActionableLiquidation,
    },
    evaluate_portfolio, ConflictResource,
};
use nqc_rmc012_pft_actionability_bridge::{
    classify_pair, PairDecision, PairInput, PairRejection, PFT_CERTIFIED_COMMIT, PFT_CERTIFIED_TREE,
};
use pft_nqc_core::{checked_add, mul_div_ceil, mul_div_floor, percent_mul_half_up, wad};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    error::Error,
    fs,
    path::{Path, PathBuf},
};

const SCHEMA: &str = "nqc-rmc-012-terminal-actionability-v1";
const MARKET_SNAPSHOT_DOMAIN: &[u8] = b"NQC-RMC012-D08-MARKET-SNAPSHOT-V1";
const ACCOUNT_SNAPSHOT_DOMAIN: &[u8] = b"NQC-RMC012-D09-ACCOUNT-SNAPSHOT-V1";
const MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD_USD: u64 = 2_000;

#[derive(Debug, Clone)]
struct Reserve {
    reserve_id: u16,
    active: bool,
    paused: bool,
    liquidation_bonus_bps: u32,
    liquidation_protocol_fee_bps: u32,
    decimals: u32,
    grace_until: u64,
    price_base_wad: U256,
}

#[derive(Debug, Clone)]
struct EMode {
    liquidation_bonus_bps: u32,
    collateral_bitmap: U256,
}

fn main() -> Result<(), Box<dyn Error>> {
    let flags = flags()?;
    let d08 = PathBuf::from(required(&flags, "--d08")?);
    let d09 = PathBuf::from(required(&flags, "--d09")?);
    let authority_lock_path = PathBuf::from(required(&flags, "--authority-lock")?);
    let d11_sources_path = PathBuf::from(required(&flags, "--d11-sources")?);
    let code_commit = git_object(required(&flags, "--code-commit")?, "code commit")?;
    let code_tree = git_object(required(&flags, "--code-tree")?, "code tree")?;
    let out = PathBuf::from(required(&flags, "--out")?);
    fs::create_dir_all(&out)?;

    let authority_lock_bytes = fs::read(&authority_lock_path)?;
    let authority_lock = UpstreamAuthorityLock::parse_json(&authority_lock_bytes)?;
    let authority_lock_sha256 = sha256_hex(&authority_lock_bytes);
    let anchor = authority_lock.observation_anchor().clone();
    let d08_authority = locked_stage(&authority_lock, UpstreamCensusStage::Rmc008StateAdmission)?;
    let d09_authority = locked_stage(&authority_lock, UpstreamCensusStage::Rmc009PositionUniverse)?;
    let d11_sources_bytes = fs::read(&d11_sources_path)?;
    let capital_sources = parse_capital_sources_artifact(&d11_sources_bytes)?;
    if capital_sources
        .iter()
        .any(|source| source.anchor() != &anchor)
    {
        return Err("D11 capital source artifact mixes a foreign observation anchor".into());
    }
    let d11_sources_sha256 = sha256_hex(&d11_sources_bytes);

    let d08_required = [
        "state-summary.json",
        "market-state-manifest.jsonl",
        "oracle-manifest.jsonl",
        "emode-manifest.jsonl",
        "pool-and-factory-facts.json",
    ];
    let d09_required = ["account-summary.json", "account-manifest.jsonl"];
    let d08_digests = verify_closeout_manifest(&d08, &d08_required, d08_authority)?;
    let d09_digests = verify_closeout_manifest(&d09, &d09_required, d09_authority)?;

    let d08_summary = read_json(d08.join("state-summary.json"))?;
    let d09_summary = read_json(d09.join("account-summary.json"))?;
    require_str(&d08_summary, "status", "RMC_008_PASS_CANDIDATE")?;
    require_str(&d09_summary, "status", "RMC_009_PASS_CANDIDATE")?;

    let d08_anchor = parse_anchor(
        d08_summary
            .get("observation_anchor")
            .ok_or("D08 summary has no observation_anchor")?,
    )?;
    if d08_anchor != anchor {
        return Err("D08 summary anchor differs from the external authority lock".into());
    }
    let d09_anchor = d09_summary
        .get("anchor")
        .ok_or("D09 summary has no anchor")?;
    if u64_field(d09_anchor, "number")? != anchor.block_number()
        || str_field(d09_anchor, "hash")? != anchor.block_hash().to_hex()
        || u64_field(&d09_summary, "anchor_timestamp")? != anchor.timestamp()
    {
        return Err("D09 summary anchor differs from the external authority lock".into());
    }

    let market_snapshot = market_snapshot_commitment(&d08, &d08_required)?;
    let (reserves, base_unit) = reserves(&d08)?;
    let emodes = emodes(&d08)?;
    let pool_facts_bytes = fs::read(d08.join("pool-and-factory-facts.json"))?;
    let (aave_pool, flash_premium_bps_u16) = d08_aave_flash_terms(&pool_facts_bytes)?;
    let flash_premium_bps = u32::from(flash_premium_bps_u16);
    let accounts = jsonl(d09.join("account-manifest.jsonl"))?;

    let mut records = Vec::new();
    let mut output_rows = Vec::new();
    let mut capital_rows = Vec::new();
    let mut portfolio_candidates = Vec::new();
    let mut portfolio_requirements = Vec::new();
    let mut portfolio_feasibility = Vec::new();
    let mut principal_capital_feasible = 0_u64;
    let mut principal_capital_rejected = 0_u64;
    let mut below_one_borrowers = 0_u64;
    let mut expected_pairs = 0_u64;

    for account in accounts {
        if account
            .get("health_factor_below_one")
            .and_then(Value::as_bool)
            != Some(true)
        {
            continue;
        }
        below_one_borrowers = below_one_borrowers
            .checked_add(1)
            .ok_or("below-one borrower count overflow")?;

        let borrower = Address::parse_hex(str_field(&account, "account")?)?;
        let configuration = parse_u256(str_field(&account, "configuration")?)?;
        let emode_id = parse_small_u8(account.get("emode").ok_or("account has no emode")?)?;
        let account_data = account
            .get("account_data")
            .and_then(Value::as_array)
            .ok_or("below-one account has no canonical account_data array")?;
        if account_data.len() != 6 {
            return Err("below-one account_data does not have six values".into());
        }
        let total_debt_base_wad =
            normalize_base(parse_u256(value_str(&account_data[1])?)?, base_unit)?;
        let health_factor_wad = parse_u256(value_str(&account_data[5])?)?;
        if health_factor_wad >= wad() {
            return Err("D09 below-one classification contradicts exact health factor".into());
        }

        let supplies = account
            .get("supply_positions")
            .and_then(Value::as_array)
            .ok_or("account has no supply_positions")?;
        let debts = account
            .get("debt_positions")
            .and_then(Value::as_array)
            .ok_or("account has no debt_positions")?;
        if supplies.is_empty() || debts.is_empty() {
            return Err(
                "below-one borrower has no enumerable collateral/debt pair universe".into(),
            );
        }

        let account_snapshot = account_snapshot_commitment(&account)?;
        for supply in supplies {
            let collateral_asset = Address::parse_hex(str_field(supply, "asset")?)?;
            let collateral = reserves
                .get(&collateral_asset)
                .ok_or("D09 collateral asset absent from D08 state")?;
            let collateral_balance = parse_u256(str_field(supply, "balance")?)?;
            let collateral_enabled = config_bit(
                configuration,
                collateral.reserve_id.saturating_mul(2).saturating_add(1),
            );

            for debt in debts {
                expected_pairs = expected_pairs
                    .checked_add(1)
                    .ok_or("actionability pair count overflow")?;
                let debt_asset = Address::parse_hex(str_field(debt, "asset")?)?;
                let debt_reserve = reserves
                    .get(&debt_asset)
                    .ok_or("D09 debt asset absent from D08 state")?;
                let debt_balance = parse_u256(str_field(debt, "balance")?)?;

                let emode = if emode_id == 0 {
                    None
                } else {
                    emodes.get(&emode_id)
                };
                let emode_resolved = emode_id == 0 || emode.is_some();
                let liquidation_bonus_bps = emode
                    .filter(|category| {
                        config_bit(category.collateral_bitmap, collateral.reserve_id)
                    })
                    .map_or(collateral.liquidation_bonus_bps, |category| {
                        category.liquidation_bonus_bps
                    });

                let collateral_unit = token_unit(collateral.decimals)?;
                let debt_unit = token_unit(debt_reserve.decimals)?;
                let reserve_collateral_base_wad = mul_div_floor(
                    collateral_balance,
                    collateral.price_base_wad,
                    collateral_unit,
                )?;
                let reserve_debt_base_wad =
                    mul_div_ceil(debt_balance, debt_reserve.price_base_wad, debt_unit)?;

                let pair = ActionabilityPair::new(
                    anchor.clone(),
                    borrower,
                    collateral_asset,
                    debt_asset,
                    collateral.reserve_id,
                    debt_reserve.reserve_id,
                );
                let input = PairInput {
                    health_factor_wad,
                    total_debt_base_wad,
                    reserve_debt_amount: debt_balance,
                    reserve_debt_base_wad,
                    reserve_collateral_base_wad,
                    borrower_collateral_balance: collateral_balance,
                    collateral_price_base_wad: collateral.price_base_wad,
                    collateral_asset_unit: collateral_unit,
                    debt_price_base_wad: debt_reserve.price_base_wad,
                    debt_asset_unit: debt_unit,
                    min_base_max_close_factor_threshold_wad: U256::from(
                        MIN_BASE_MAX_CLOSE_FACTOR_THRESHOLD_USD,
                    ) * wad(),
                    liquidation_bonus_bps,
                    liquidation_protocol_fee_bps: collateral.liquidation_protocol_fee_bps,
                    collateral_enabled,
                    collateral_reserve_eligible: liquidation_eligible(
                        collateral,
                        anchor.timestamp(),
                    ),
                    debt_reserve_eligible: liquidation_eligible(debt_reserve, anchor.timestamp()),
                    emode_resolved,
                    snapshots_match: true,
                    pft_market_snapshot: *market_snapshot.as_bytes(),
                    pft_account_snapshot: *account_snapshot.as_bytes(),
                };

                let pair_evidence = vec![market_snapshot, account_snapshot];
                match classify_pair(input)? {
                    PairDecision::Admitted(sized) => {
                        let premium =
                            percent_mul_half_up(sized.debt_to_liquidate, flash_premium_bps)?;
                        let repayment = checked_add(sized.debt_to_liquidate, premium)?;
                        let collateral_value = mul_div_floor(
                            sized.collateral_to_liquidator,
                            collateral.price_base_wad,
                            collateral_unit,
                        )?;
                        let repayment_value =
                            mul_div_ceil(repayment, debt_reserve.price_base_wad, debt_unit)?;
                        let result_hash = Hash32::new(sized.result_commitment)?;
                        let candidate = ActionableLiquidation::new(
                            pair.clone(),
                            amount(health_factor_wad),
                            amount(sized.debt_to_liquidate),
                            amount(sized.collateral_to_liquidator),
                            amount(sized.liquidation_protocol_fee_collateral),
                            amount(premium),
                            liquidation_bonus_bps,
                            amount(collateral.price_base_wad),
                            amount(collateral_unit),
                            amount(debt_reserve.price_base_wad),
                            amount(debt_unit),
                            amount(collateral_value),
                            amount(repayment_value),
                            market_snapshot,
                            account_snapshot,
                        )?;
                        records.push(ActionabilityRecord::admitted(
                            candidate.clone(),
                            vec![market_snapshot, account_snapshot, result_hash],
                        )?);

                        let promotion = promote_protocol_native_flash_liquidation(&candidate)?;
                        let feasibility = evaluate_protocol_native_flash_promotion(
                            &promotion,
                            aave_pool,
                            &capital_sources,
                        )?;
                        portfolio_candidates.push(promotion.portfolio_candidate().clone());
                        portfolio_requirements.push(promotion.requirement().clone());
                        portfolio_feasibility.push(feasibility.clone());

                        let (capital_status, capital_reason, allocations) = match &feasibility {
                            CapitalFeasibility::Feasible { allocations, .. } => {
                                principal_capital_feasible = principal_capital_feasible
                                    .checked_add(1)
                                    .ok_or("principal capital feasible count overflow")?;
                                let rows = allocations
                                    .iter()
                                    .map(|allocation| {
                                        json!({
                                            "source_id": allocation.source_id.to_hex(),
                                            "leg_kind": allocation.leg_kind.code(),
                                            "amount": allocation.amount.to_hex()
                                        })
                                    })
                                    .collect::<Vec<_>>();
                                ("FEASIBLE", Value::Null, rows)
                            }
                            CapitalFeasibility::Rejected { reason, .. } => {
                                principal_capital_rejected = principal_capital_rejected
                                    .checked_add(1)
                                    .ok_or("principal capital rejection count overflow")?;
                                (
                                    "REJECTED",
                                    Value::String(reason.code().to_owned()),
                                    Vec::new(),
                                )
                            }
                        };
                        capital_rows.push(json!({
                            "actionable_candidate_id": candidate.id().to_hex(),
                            "requirement_id": promotion.requirement().id().to_hex(),
                            "portfolio_candidate_id": promotion.portfolio_candidate().id().to_hex(),
                            "funding_scope": promotion.scope().code(),
                            "gas_funding_certified": promotion.scope().gas_funding_certified(),
                            "aave_pool": aave_pool.to_hex(),
                            "debt_asset": candidate.pair().debt_asset().to_hex(),
                            "principal": candidate.debt_to_liquidate().to_hex(),
                            "flash_premium": candidate.flash_loan_premium().to_hex(),
                            "repayment_principal": candidate.debt_to_liquidate().to_hex(),
                            "capital_status": capital_status,
                            "rejection_reason": capital_reason,
                            "allocations": allocations
                        }));

                        output_rows.push(json!({
                            "pair_id": pair.id().to_hex(),
                            "pair_key": pair.key().to_hex(),
                            "status": "ADMITTED",
                            "candidate_id": candidate.id().to_hex(),
                            "borrower": borrower.to_hex(),
                            "collateral_asset": collateral_asset.to_hex(),
                            "debt_asset": debt_asset.to_hex(),
                            "collateral_reserve_id": collateral.reserve_id,
                            "debt_reserve_id": debt_reserve.reserve_id,
                            "health_factor_wad": health_factor_wad.to_string(),
                            "debt_to_liquidate": sized.debt_to_liquidate.to_string(),
                            "collateral_to_liquidator": sized.collateral_to_liquidator.to_string(),
                            "liquidation_protocol_fee_collateral": sized.liquidation_protocol_fee_collateral.to_string(),
                            "flash_loan_premium": premium.to_string(),
                            "flash_loan_repayment": repayment.to_string(),
                            "liquidation_bonus_bps": liquidation_bonus_bps,
                            "collateral_price_base_wad": collateral.price_base_wad.to_string(),
                            "collateral_asset_unit": collateral_unit.to_string(),
                            "debt_price_base_wad": debt_reserve.price_base_wad.to_string(),
                            "debt_asset_unit": debt_unit.to_string(),
                            "oracle_collateral_value_base_wad": collateral_value.to_string(),
                            "oracle_repayment_value_base_wad": repayment_value.to_string(),
                            "pft_result_commitment": result_hash.to_hex(),
                            "pft_market_snapshot": market_snapshot.to_hex(),
                            "pft_account_snapshot": account_snapshot.to_hex()
                        }));
                    }
                    PairDecision::Rejected(reason) => {
                        let core_reason = rejection(reason)?;
                        records.push(ActionabilityRecord::rejected(
                            pair.clone(),
                            core_reason,
                            pair_evidence,
                        )?);
                        output_rows.push(json!({
                            "pair_id": pair.id().to_hex(),
                            "pair_key": pair.key().to_hex(),
                            "status": "REJECTED",
                            "reason": core_reason.code(),
                            "borrower": borrower.to_hex(),
                            "collateral_asset": collateral_asset.to_hex(),
                            "debt_asset": debt_asset.to_hex(),
                            "collateral_reserve_id": collateral.reserve_id,
                            "debt_reserve_id": debt_reserve.reserve_id,
                            "pft_market_snapshot": market_snapshot.to_hex(),
                            "pft_account_snapshot": account_snapshot.to_hex()
                        }));
                    }
                }
            }
        }
    }

    let coverage =
        ActionabilityCoverage::new(anchor.clone(), below_one_borrowers, expected_pairs, records)?;
    output_rows.sort_by(|left, right| {
        left.get("pair_id")
            .and_then(Value::as_str)
            .cmp(&right.get("pair_id").and_then(Value::as_str))
    });

    let records_path = out.join("actionability-records.jsonl");
    let mut records_bytes = Vec::new();
    for row in &output_rows {
        records_bytes.extend(serde_json::to_vec(row)?);
        records_bytes.push(b'\n');
    }
    fs::write(&records_path, &records_bytes)?;

    capital_rows.sort_by(|left, right| {
        left.get("actionable_candidate_id")
            .and_then(Value::as_str)
            .cmp(&right.get("actionable_candidate_id").and_then(Value::as_str))
    });
    let capital_path = out.join("capital-promotions.jsonl");
    let mut capital_bytes = Vec::new();
    for row in &capital_rows {
        capital_bytes.extend(serde_json::to_vec(row)?);
        capital_bytes.push(b'\n');
    }
    fs::write(&capital_path, &capital_bytes)?;

    if u64::try_from(capital_rows.len())? != coverage.admitted_count()
        || principal_capital_feasible
            .checked_add(principal_capital_rejected)
            .ok_or("principal capital conservation overflow")?
            != coverage.admitted_count()
    {
        return Err("admitted actionability to capital promotion is not conserved".into());
    }

    let portfolio = evaluate_portfolio(
        &portfolio_candidates,
        &portfolio_requirements,
        &portfolio_feasibility,
        &capital_sources,
        &[],
    )?;
    if u64::try_from(portfolio.candidate_count())? != coverage.admitted_count()
        || u64::try_from(portfolio.capital_feasible_count())? != principal_capital_feasible
        || u64::try_from(portfolio.capital_rejected().len())? != principal_capital_rejected
    {
        return Err("portfolio report does not conserve terminal actionability promotion".into());
    }

    let conflict_rows = portfolio
        .conflicts()
        .iter()
        .map(|conflict| {
            let (kind, key) = match conflict.resource {
                ConflictResource::Requirement(id) => ("REQUIREMENT", id.to_hex()),
                ConflictResource::CapitalSource(id) => ("CAPITAL_SOURCE", id.to_hex()),
                ConflictResource::Shared(id) => ("SHARED_RESOURCE", id.to_hex()),
            };
            json!({
                "resource_kind": kind,
                "resource_key": key,
                "capacity": conflict.capacity.to_hex(),
                "claimed": conflict.claimed.to_hex(),
                "claimants": conflict
                    .claimants
                    .iter()
                    .map(|id| id.to_hex())
                    .collect::<Vec<_>>()
            })
        })
        .collect::<Vec<_>>();
    let component_rows = portfolio
        .components()
        .iter()
        .map(|component| {
            let resources = component
                .resources
                .iter()
                .map(|resource| match resource {
                    ConflictResource::Requirement(id) => {
                        json!({"kind":"REQUIREMENT","key":id.to_hex()})
                    }
                    ConflictResource::CapitalSource(id) => {
                        json!({"kind":"CAPITAL_SOURCE","key":id.to_hex()})
                    }
                    ConflictResource::Shared(id) => {
                        json!({"kind":"SHARED_RESOURCE","key":id.to_hex()})
                    }
                })
                .collect::<Vec<_>>();
            json!({
                "candidates": component
                    .candidates
                    .iter()
                    .map(|id| id.to_hex())
                    .collect::<Vec<_>>(),
                "resources": resources
            })
        })
        .collect::<Vec<_>>();
    let portfolio_json = json!({
        "schema": "nqc-rmc-012-terminal-principal-capacity-v1",
        "code_commit": code_commit,
        "code_tree": code_tree,
        "anchor": {
            "chain_id": anchor.chain().chain_id(),
            "block_number": anchor.block_number(),
            "block_hash": anchor.block_hash().to_hex(),
            "state_root": anchor.state_root().to_hex()
        },
        "candidate_count": portfolio.candidate_count(),
        "capital_feasible_count": portfolio.capital_feasible_count(),
        "capital_rejected_count": portfolio.capital_rejected().len(),
        "conflict_count": portfolio.conflicts().len(),
        "component_count": portfolio.components().len(),
        "simultaneously_feasible": portfolio.simultaneously_feasible(),
        "portfolio_commitment": portfolio.commitment_hex(),
        "conflicts": conflict_rows,
        "components": component_rows
    });
    let portfolio_bytes = serde_json::to_vec_pretty(&portfolio_json)?;
    fs::write(out.join("portfolio-capacity.json"), &portfolio_bytes)?;

    let summary = json!({
        "schema": SCHEMA,
        "status": "RMC_012_ACTIONABILITY_PASS",
        "code_commit": code_commit,
        "code_tree": code_tree,
        "pft_certified_commit": PFT_CERTIFIED_COMMIT,
        "pft_certified_tree": PFT_CERTIFIED_TREE,
        "anchor": {
            "chain_id": anchor.chain().chain_id(),
            "genesis_hash": anchor.chain().genesis_hash().to_hex(),
            "fork_lineage": anchor.chain().fork_lineage().to_hex(),
            "block_number": anchor.block_number(),
            "block_hash": anchor.block_hash().to_hex(),
            "parent_hash": anchor.parent_hash().to_hex(),
            "timestamp": anchor.timestamp(),
            "state_root": anchor.state_root().to_hex()
        },
        "upstream_authority_lock_commitment": authority_lock.commitment().to_hex(),
        "upstream_authority_lock_sha256": authority_lock_sha256,
        "d08_authority_artifact_sha256": d08_authority.artifact_sha256.to_hex(),
        "d09_authority_artifact_sha256": d09_authority.artifact_sha256.to_hex(),
        "d11_capital_sources_sha256": d11_sources_sha256,
        "d11_capital_source_count": capital_sources.len(),
        "aave_pool": aave_pool.to_hex(),
        "aave_flash_premium_bps": flash_premium_bps,
        "funding_scope": "PRINCIPAL_AND_FLASH_SETTLEMENT_ONLY_GAS_UNCERTIFIED",
        "principal_capital_promoted": capital_rows.len(),
        "principal_capital_feasible": principal_capital_feasible,
        "principal_capital_rejected": principal_capital_rejected,
        "principal_capital_conserved": true,
        "gas_funding_certified": false,
        "portfolio_concurrent_principal_capacity_certified": true,
        "portfolio_concurrent_capacity_certified": false,
        "portfolio_conflict_count": portfolio.conflicts().len(),
        "portfolio_component_count": portfolio.components().len(),
        "portfolio_simultaneously_feasible": portfolio.simultaneously_feasible(),
        "portfolio_commitment": portfolio.commitment_hex(),
        "below_one_borrowers": coverage.below_one_borrowers(),
        "expected_pairs": coverage.expected_pairs(),
        "admitted": coverage.admitted_count(),
        "rejected": coverage.rejected_count(),
        "coverage_commitment": coverage.commitment_hex(),
        "d08_inputs": d08_digests,
        "d09_inputs": d09_digests,
        "market_snapshot_commitment": market_snapshot.to_hex(),
        "records_sha256": sha256_hex(&records_bytes),
        "capital_promotions_sha256": sha256_hex(&capital_bytes),
        "economic_filters_applied": false
    });
    let summary_bytes = serde_json::to_vec_pretty(&summary)?;
    fs::write(out.join("actionability-summary.json"), &summary_bytes)?;

    let manifest = json!({
        "schema": "nqc-rmc-012-terminal-actionability-evidence-v1",
        "code_commit": code_commit,
        "code_tree": code_tree,
        "upstream_authority_lock_commitment": authority_lock.commitment().to_hex(),
        "upstream_authority_lock_sha256": authority_lock_sha256,
        "d08_authority_artifact_sha256": d08_authority.artifact_sha256.to_hex(),
        "d09_authority_artifact_sha256": d09_authority.artifact_sha256.to_hex(),
        "d11_capital_sources_sha256": d11_sources_sha256,
        "funding_scope": "PRINCIPAL_AND_FLASH_SETTLEMENT_ONLY_GAS_UNCERTIFIED",
        "gas_funding_certified": false,
        "portfolio_concurrent_capacity_certified": false,
        "artifacts": [
            {
                "path": "actionability-records.jsonl",
                "sha256": sha256_hex(&records_bytes),
                "bytes": records_bytes.len()
            },
            {
                "path": "actionability-summary.json",
                "sha256": sha256_hex(&summary_bytes),
                "bytes": summary_bytes.len()
            },
            {
                "path": "capital-promotions.jsonl",
                "sha256": sha256_hex(&capital_bytes),
                "bytes": capital_bytes.len()
            },
            {
                "path": "portfolio-capacity.json",
                "sha256": sha256_hex(&portfolio_bytes),
                "bytes": portfolio_bytes.len()
            }
        ]
    });
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)?;
    fs::write(out.join("evidence-manifest.json"), &manifest_bytes)?;

    println!(
        "RMC012_TERMINAL_ACTIONABILITY_PASS below_one={} pairs={} admitted={} rejected={} commitment={}",
        coverage.below_one_borrowers(),
        coverage.expected_pairs(),
        coverage.admitted_count(),
        coverage.rejected_count(),
        coverage.commitment_hex()
    );
    Ok(())
}

fn flags() -> Result<BTreeMap<String, String>, Box<dyn Error>> {
    let mut out = BTreeMap::new();
    let mut args = env::args().skip(1);
    while let Some(flag) = args.next() {
        let value = args
            .next()
            .ok_or_else(|| format!("missing value for {flag}"))?;
        if out.insert(flag.clone(), value).is_some() {
            return Err(format!("{flag} given twice").into());
        }
    }
    Ok(out)
}

fn required<'a>(
    flags: &'a BTreeMap<String, String>,
    name: &str,
) -> Result<&'a str, Box<dyn Error>> {
    flags
        .get(name)
        .map(String::as_str)
        .ok_or_else(|| format!("{name} is required").into())
}

fn git_object<'a>(value: &'a str, name: &str) -> Result<&'a str, Box<dyn Error>> {
    if value.len() != 40 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("{name} is not a 40-hex Git object id").into());
    }
    Ok(value)
}

fn read_json(path: impl AsRef<Path>) -> Result<Value, Box<dyn Error>> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn jsonl(path: impl AsRef<Path>) -> Result<Vec<Value>, Box<dyn Error>> {
    let bytes = fs::read(path)?;
    let text = std::str::from_utf8(&bytes)?;
    text.lines()
        .filter(|line| !line.is_empty())
        .map(|line| Ok(serde_json::from_str::<Value>(line)?))
        .collect()
}

fn locked_stage(
    lock: &UpstreamAuthorityLock,
    stage: UpstreamCensusStage,
) -> Result<&UpstreamAuthorityLockEntry, Box<dyn Error>> {
    lock.entries()
        .iter()
        .find(|entry| entry.stage == stage)
        .ok_or_else(|| format!("external authority lock has no {}", stage.code()).into())
}

fn verify_closeout_manifest(
    dir: &Path,
    required_files: &[&str],
    authority: &UpstreamAuthorityLockEntry,
) -> Result<BTreeMap<String, String>, Box<dyn Error>> {
    let manifest_bytes = fs::read(dir.join("evidence-manifest.json"))?;
    let manifest_digest = Hash32::new(Sha256::digest(&manifest_bytes).into())?;
    if manifest_digest != authority.artifact_sha256 {
        return Err(
            "closeout evidence manifest digest differs from external authority lock".into(),
        );
    }
    let manifest: Value = serde_json::from_slice(&manifest_bytes)?;
    if str_field(&manifest, "code_commit")? != authority.code_commit.to_hex()
        || str_field(&manifest, "code_tree")? != authority.code_tree.to_hex()
    {
        return Err("closeout code identity differs from external authority lock".into());
    }
    let artifacts = manifest
        .get("artifacts")
        .and_then(Value::as_array)
        .ok_or("closeout evidence manifest has no artifacts")?;
    let mut declared = BTreeMap::new();
    for row in artifacts {
        let path = str_field(row, "path")?.to_owned();
        let digest = str_field(row, "sha256")?.to_owned();
        if declared.insert(path, digest).is_some() {
            return Err("closeout evidence manifest repeats an artifact path".into());
        }
    }
    let mut observed = BTreeMap::new();
    for name in required_files {
        let expected = declared
            .get(*name)
            .ok_or_else(|| format!("evidence manifest does not bind required file {name}"))?;
        let bytes = fs::read(dir.join(name))?;
        let digest = sha256_hex(&bytes);
        if &digest != expected {
            return Err(format!("{name}: sha256 {digest} != manifest {expected}").into());
        }
        observed.insert((*name).to_owned(), digest);
    }
    observed.insert(
        "evidence-manifest.json".to_owned(),
        sha256_hex(&manifest_bytes),
    );
    Ok(observed)
}

fn require_str(value: &Value, key: &str, expected: &str) -> Result<(), Box<dyn Error>> {
    let actual = str_field(value, key)?;
    if actual != expected {
        return Err(format!("{key}={actual}, expected {expected}").into());
    }
    Ok(())
}

fn str_field<'a>(value: &'a Value, key: &str) -> Result<&'a str, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("missing text field {key}").into())
}

fn value_str(value: &Value) -> Result<&str, Box<dyn Error>> {
    value
        .as_str()
        .ok_or_else(|| "expected decimal string".into())
}

fn u64_field(value: &Value, key: &str) -> Result<u64, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("missing integer field {key}").into())
}

fn parse_u256(value: &str) -> Result<U256, Box<dyn Error>> {
    Ok(U256::from_str_radix(value, 10)?)
}

fn parse_small_u8(value: &Value) -> Result<u8, Box<dyn Error>> {
    let raw = parse_u256(value_str(value)?)?;
    if raw > U256::from(u8::MAX) {
        return Err("emode id exceeds uint8".into());
    }
    Ok(raw.to::<u8>())
}

fn amount(value: U256) -> Amount256 {
    Amount256::from_be_bytes(value.to_be_bytes::<32>())
}

fn parse_anchor(value: &Value) -> Result<StateAnchor, Box<dyn Error>> {
    let chain = ChainDomain::new(
        u64_field(value, "chain_id")?,
        Hash32::parse_hex(str_field(value, "genesis_hash")?)?,
        Hash32::parse_hex(str_field(value, "fork_lineage")?)?,
    )?;
    Ok(StateAnchor::new(
        chain,
        u64_field(value, "block_number")?,
        Hash32::parse_hex(str_field(value, "block_hash")?)?,
        Hash32::parse_hex(str_field(value, "parent_hash")?)?,
        u64_field(value, "timestamp")?,
        Hash32::parse_hex(str_field(value, "state_root")?)?,
    )?)
}

fn market_snapshot_commitment(d08: &Path, required: &[&str]) -> Result<Hash32, Box<dyn Error>> {
    let mut hasher = Sha256::new();
    hasher.update(MARKET_SNAPSHOT_DOMAIN);
    hasher.update([0]);
    for name in required {
        hasher.update(name.as_bytes());
        hasher.update([0]);
        hasher.update(fs::read(d08.join(name))?);
    }
    Ok(Hash32::new(hasher.finalize().into())?)
}

fn account_snapshot_commitment(account: &Value) -> Result<Hash32, Box<dyn Error>> {
    let mut hasher = Sha256::new();
    hasher.update(ACCOUNT_SNAPSHOT_DOMAIN);
    hasher.update([0]);
    hasher.update(serde_json::to_vec(account)?);
    Ok(Hash32::new(hasher.finalize().into())?)
}

fn reserves(d08: &Path) -> Result<(BTreeMap<Address, Reserve>, U256), Box<dyn Error>> {
    let state = jsonl(d08.join("market-state-manifest.jsonl"))?;
    let oracle = jsonl(d08.join("oracle-manifest.jsonl"))?;
    let mut prices = BTreeMap::new();
    let mut base_unit = None;

    for row in oracle {
        let asset = Address::parse_hex(str_field(&row, "asset")?)?;
        let price = parse_u256(str_field(&row, "price")?)?;
        let unit = parse_u256(str_field(&row, "base_currency_unit")?)?;
        if price == U256::ZERO || unit == U256::ZERO {
            return Err("D08 oracle row contains zero price/base unit".into());
        }
        if let Some(existing) = base_unit {
            if existing != unit {
                return Err("D08 oracle rows disagree on base currency unit".into());
            }
        } else {
            base_unit = Some(unit);
        }
        if prices.insert(asset, (price, unit)).is_some() {
            return Err("D08 oracle manifest repeats asset".into());
        }
    }
    let base_unit = base_unit.ok_or("D08 oracle manifest is empty")?;

    let mut out = BTreeMap::new();
    for row in state {
        if row.get("protocol").and_then(Value::as_str) != Some("AAVE_V3")
            || row.get("lifecycle").and_then(Value::as_str) != Some("CURRENT")
        {
            continue;
        }
        let asset = Address::parse_hex(str_field(&row, "asset")?)?;
        let reserve_id_u64 = u64_field(&row, "reserve_id")?;
        let reserve_id = u16::try_from(reserve_id_u64)?;
        let config = row
            .get("configuration")
            .ok_or("Aave state row has no configuration")?;
        let grace = parse_u256(str_field(&row, "liquidation_grace_period_until")?)?;
        if grace > U256::from(u64::MAX) {
            return Err("liquidation grace period exceeds uint64".into());
        }
        let grace_until = grace.to::<u64>();
        let (raw_price, unit) = prices
            .get(&asset)
            .copied()
            .ok_or("Aave state asset has no oracle row")?;
        let price_base_wad = normalize_base(raw_price, unit)?;
        let reserve = Reserve {
            reserve_id,
            active: bool_field(config, "active")?,
            paused: bool_field(config, "paused")?,
            liquidation_bonus_bps: u32::try_from(u64_field(config, "liquidation_bonus_bps")?)?,
            liquidation_protocol_fee_bps: u32::try_from(u64_field(
                config,
                "liquidation_protocol_fee_bps",
            )?)?,
            decimals: u32::try_from(u64_field(config, "decimals")?)?,
            grace_until,
            price_base_wad,
        };
        // Equality is intentionally ineligible: the recovered PFT predicate
        // requires grace_until < anchor timestamp.
        if out.insert(asset, reserve).is_some() {
            return Err("D08 market-state manifest repeats Aave asset".into());
        }
    }
    if out.is_empty() {
        return Err("D08 closeout contains no current Aave reserves".into());
    }
    Ok((out, base_unit))
}

fn emodes(d08: &Path) -> Result<BTreeMap<u8, EMode>, Box<dyn Error>> {
    let mut out = BTreeMap::new();
    for row in jsonl(d08.join("emode-manifest.jsonl"))? {
        let id_i64 = row
            .get("category_id")
            .and_then(Value::as_i64)
            .ok_or("emode row has no category id")?;
        let id = u8::try_from(id_i64)?;
        let bonus_raw = parse_u256(str_field(&row, "liquidation_bonus_bps")?)?;
        if bonus_raw > U256::from(u32::MAX) {
            return Err("eMode liquidation bonus exceeds uint32".into());
        }
        let bonus = bonus_raw.to::<u32>();
        let bitmap = parse_u256(str_field(&row, "collateral_bitmap")?)?;
        if out
            .insert(
                id,
                EMode {
                    liquidation_bonus_bps: bonus,
                    collateral_bitmap: bitmap,
                },
            )
            .is_some()
        {
            return Err("D08 eMode manifest repeats category".into());
        }
    }
    Ok(out)
}

fn bool_field(value: &Value, key: &str) -> Result<bool, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("missing boolean field {key}").into())
}

fn normalize_base(value: U256, base_unit: U256) -> Result<U256, Box<dyn Error>> {
    Ok(mul_div_floor(value, wad(), base_unit)?)
}

fn token_unit(decimals: u32) -> Result<U256, Box<dyn Error>> {
    let mut value = U256::from(1u8);
    for _ in 0..decimals {
        value = value
            .checked_mul(U256::from(10u8))
            .ok_or("token decimals overflow uint256")?;
    }
    Ok(value)
}

fn config_bit(value: U256, bit: u16) -> bool {
    if bit >= 256 {
        return false;
    }
    let bytes = value.to_be_bytes::<32>();
    let byte_index = 31usize - usize::from(bit / 8);
    let mask = 1u8 << (bit % 8);
    bytes[byte_index] & mask != 0
}

fn liquidation_eligible(reserve: &Reserve, timestamp: u64) -> bool {
    reserve.active && !reserve.paused && reserve.grace_until < timestamp
}

fn rejection(reason: PairRejection) -> Result<ActionabilityRejectionReason, Box<dyn Error>> {
    Ok(match reason {
        PairRejection::CollateralNotEnabled => ActionabilityRejectionReason::CollateralNotEnabled,
        PairRejection::CollateralReserveIneligible => {
            ActionabilityRejectionReason::CollateralReserveIneligible
        }
        PairRejection::DebtReserveIneligible => ActionabilityRejectionReason::DebtReserveIneligible,
        PairRejection::UnknownEmodeCategory => ActionabilityRejectionReason::UnknownEmodeCategory,
        PairRejection::SnapshotMismatch => ActionabilityRejectionReason::SnapshotMismatch,
        PairRejection::UnsupportedPosition => ActionabilityRejectionReason::UnsupportedPosition,
        PairRejection::PftMathRejected => ActionabilityRejectionReason::PftMathRejected,
        PairRejection::HealthFactorNotBelowOne => {
            return Err("PFT bridge rejected a D09 below-one borrower as health-factor >= 1".into())
        }
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest: [u8; 32] = Sha256::digest(bytes).into();
    let mut out = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}
