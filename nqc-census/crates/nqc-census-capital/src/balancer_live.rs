//! Authenticated live acquisition for the Balancer V2 flash-capital family.
//!
//! This module is deliberately narrow: it consumes the exact D08 admitted
//! market/token bytes, verifies those bytes against the D08 evidence manifest,
//! binds them to the canonical D11 upstream authority lock, and then captures
//! Balancer V2 Vault state from one declared provider into the RMC-004 store.
//! A separate reconciler requires two independent provider captures to agree.

use crate::{
    permissionless_atomic::{admit_balancer_v2_dual_provider, BalancerV2AuthenticatedObservation},
    source_authority::D11SourceAuthority,
    Amount256, CapitalEvidenceRef, CapitalSource,
};
use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{Address, CallOutcome, ChainDomain, Hash32, StateAnchor};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, error::Error, fs, path::Path};

const BALANCER_CAPTURE_NAMESPACE: u16 = 0x0b21;
const BALANCER_V2_VAULT: &str = "0xba12222222228d8ba445958a75a0704d566bf2c8";

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn u64_field(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing integer field {key}")))
}

fn parse_full_anchor(value: &Json) -> Result<StateAnchor, ChainError> {
    let chain = ChainDomain::new(
        u64_field(value, "chain_id")?,
        Hash32::parse_hex(value.str_field("genesis_hash")?)?,
        Hash32::parse_hex(value.str_field("fork_lineage")?)?,
    )?;
    Ok(StateAnchor::new(
        chain,
        u64_field(value, "block_number")?,
        Hash32::parse_hex(value.str_field("block_hash")?)?,
        Hash32::parse_hex(value.str_field("parent_hash")?)?,
        u64_field(value, "timestamp")?,
        Hash32::parse_hex(value.str_field("state_root")?)?,
    )?)
}

fn full_anchor_json(anchor: &StateAnchor) -> Json {
    Json::object([
        ("chain_id", Json::uint(anchor.chain().chain_id())),
        (
            "genesis_hash",
            Json::string(anchor.chain().genesis_hash().to_hex()),
        ),
        (
            "fork_lineage",
            Json::string(anchor.chain().fork_lineage().to_hex()),
        ),
        ("block_number", Json::uint(anchor.block_number())),
        ("block_hash", Json::string(anchor.block_hash().to_hex())),
        ("parent_hash", Json::string(anchor.parent_hash().to_hex())),
        ("timestamp", Json::uint(anchor.timestamp())),
        ("state_root", Json::string(anchor.state_root().to_hex())),
    ])
}

fn returned<'a>(
    observation: &'a nqc_census_core::CensusObservation<nqc_census_core::ContractCallEnvelope>,
    label: &'static str,
) -> Result<&'a [u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(format!(
            "required Balancer call reverted: {label}"
        ))),
    }
}

fn required_address(bytes: &[u8], label: &'static str) -> Result<Address, ChainError> {
    let word = abi::single_word(bytes)?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} returned zero address")))?;
    Ok(Address::new(raw)?)
}

fn amount_decimal(mut bytes: [u8; 32]) -> String {
    if bytes.iter().all(|byte| *byte == 0) {
        return "0".to_owned();
    }
    let mut digits = Vec::new();
    while bytes.iter().any(|byte| *byte != 0) {
        let mut carry = 0_u16;
        for byte in &mut bytes {
            let expanded = (carry << 8) | u16::from(*byte);
            *byte = u8::try_from(expanded / 10).unwrap_or(0);
            carry = expanded % 10;
        }
        digits.push(char::from(b'0' + u8::try_from(carry).unwrap_or(0)));
    }
    digits.iter().rev().collect()
}

fn returned_amount(bytes: &[u8], label: &'static str) -> Result<Amount256, ChainError> {
    let word = abi::single_word(bytes)
        .map_err(|error| ChainError::Evidence(format!("{label} decode failed: {error}")))?;
    Ok(Amount256::from_be_bytes(word))
}

fn verify_d08_artifact(manifest: &Json, name: &str, bytes: &[u8]) -> Result<String, ChainError> {
    let expected = manifest
        .get("artifacts")
        .and_then(Json::as_array)
        .ok_or_else(|| ChainError::Evidence("D08 evidence manifest has no artifacts".into()))?
        .iter()
        .find(|row| row.get("path").and_then(Json::as_str) == Some(name))
        .ok_or_else(|| ChainError::Evidence(format!("D08 manifest does not bind {name}")))?
        .str_field("sha256")?;
    let actual = sha256_plain(bytes);
    if actual != expected {
        return Err(ChainError::Evidence(format!(
            "D08 artifact digest mismatch for {name}: {actual} != {expected}"
        )));
    }
    Ok(actual)
}

fn actionable_assets(
    market_state: &[u8],
    token_admission: &[u8],
) -> Result<Vec<Address>, ChainError> {
    let mut compatible = BTreeSet::new();
    let token_text = std::str::from_utf8(token_admission)
        .map_err(|_| ChainError::Evidence("D08 token admission is not UTF-8".into()))?;
    for line in token_text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        let admitted = row
            .get("state_admission")
            .and_then(|value| value.get("status"))
            .and_then(Json::as_str)
            == Some("ADMITTED");
        let executable = row
            .get("execution_compatibility")
            .and_then(|value| value.get("status"))
            .and_then(Json::as_str)
            == Some("PROVEN_COMPATIBLE");
        if admitted && executable {
            compatible.insert(Address::parse_hex(row.str_field("token")?)?);
        }
    }

    let mut assets = BTreeSet::new();
    let state_text = std::str::from_utf8(market_state)
        .map_err(|_| ChainError::Evidence("D08 market state is not UTF-8".into()))?;
    for line in state_text.lines().filter(|line| !line.is_empty()) {
        let row = Json::parse(line.as_bytes())?;
        if row.get("protocol").and_then(Json::as_str) != Some("AAVE_V3")
            || row.get("lifecycle").and_then(Json::as_str) != Some("CURRENT")
        {
            continue;
        }
        let asset = Address::parse_hex(row.str_field("asset")?)?;
        if compatible.contains(&asset) {
            assets.insert(asset);
        }
    }

    if assets.is_empty() {
        return Err(ChainError::Evidence(
            "D08 yields no execution-compatible current Aave assets".into(),
        ));
    }
    Ok(assets.into_iter().collect())
}

fn asset_universe_commitment(assets: &[Address]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"NQC-RMC011-BALANCER-ASSET-UNIVERSE-V1");
    hasher.update([0]);
    for asset in assets {
        hasher.update(asset.as_bytes());
    }
    hex::plain(&hasher.finalize())
}

#[allow(clippy::too_many_arguments)]
fn provider_capture(
    acquisition: &Acquisition<'_>,
    provider: &ProviderSpec,
    expected_anchor: &StateAnchor,
    assets: &[Address],
    authority_lock_sha256: &str,
    d08_market_state_sha256: &str,
    d08_token_admission_sha256: &str,
    d08_evidence_manifest_sha256: &str,
) -> Result<Json, ChainError> {
    let profile = ChainProfile::mainnet()?;
    let (chain_facts, bootstrap) = acquisition.bootstrap(provider, &profile)?;
    if &chain_facts.chain != expected_anchor.chain() {
        return Err(ChainError::Evidence(
            "Balancer provider chain domain differs from D08 authority".into(),
        ));
    }
    let (anchor, anchor_output) =
        acquisition.resolve_anchor(provider, &chain_facts.chain, expected_anchor.block_number())?;
    if &anchor != expected_anchor {
        return Err(ChainError::Evidence(
            "Balancer provider anchor differs from D08 authority".into(),
        ));
    }

    let vault = Address::parse_hex(BALANCER_V2_VAULT)?;
    let assets_commitment = asset_universe_commitment(assets);
    let spec = JobSpec::new(
        "rmc011-balancer-v2-capital-capture",
        1,
        BALANCER_CAPTURE_NAMESPACE,
        Json::object([
            ("vault", Json::string(vault.to_hex())),
            ("anchor", full_anchor_json(&anchor)),
            (
                "authority_lock_sha256",
                Json::string(authority_lock_sha256.to_owned()),
            ),
            (
                "d08_market_state_sha256",
                Json::string(d08_market_state_sha256.to_owned()),
            ),
            (
                "d08_token_admission_sha256",
                Json::string(d08_token_admission_sha256.to_owned()),
            ),
            (
                "d08_evidence_manifest_sha256",
                Json::string(d08_evidence_manifest_sha256.to_owned()),
            ),
            (
                "asset_universe_sha256",
                Json::string(assets_commitment.clone()),
            ),
        ]),
    )?;

    let output = acquisition.point(provider, &chain_facts.chain, None, &spec, &anchor, |ctx| {
        let semantics = chain_read_semantics()?;
        let vault_code = ctx.code(vault, &anchor, semantics)?;
        if vault_code.payload().is_absent() {
            return Err(ChainError::Evidence(
                "canonical Balancer V2 Vault has no runtime code".into(),
            ));
        }
        let vault_code_sha256 = sha256_plain(vault_code.payload().code());

        let core = ctx.calls(
            &[
                (
                    vault,
                    abi::encode_call(abi::selector("getProtocolFeesCollector()"), &[]),
                ),
                (
                    vault,
                    abi::encode_call(abi::selector("getPausedState()"), &[]),
                ),
            ],
            &anchor,
            semantics,
        )?;
        if core.len() != 2 {
            return Err(ChainError::Evidence(
                "Balancer core call count differs".into(),
            ));
        }
        let fee_collector = required_address(
            returned(&core[0], "getProtocolFeesCollector")?,
            "fee collector",
        )?;
        let paused_words = abi::words(returned(&core[1], "getPausedState")?)?;
        if paused_words.len() != 3 {
            return Err(ChainError::Evidence(
                "Balancer getPausedState must return three words".into(),
            ));
        }
        let paused = abi::decode_bool(&paused_words[0])?;
        let pause_window_end_time = abi::decode_u64(&paused_words[1])?;
        let buffer_period_end_time = abi::decode_u64(&paused_words[2])?;

        let collector_code = ctx.code(fee_collector, &anchor, semantics)?;
        if collector_code.payload().is_absent() {
            return Err(ChainError::Evidence(
                "Balancer protocol fee collector has no runtime code".into(),
            ));
        }
        let fee_collector_code_sha256 = sha256_plain(collector_code.payload().code());
        let fee_call = ctx.call(
            fee_collector,
            abi::encode_call(abi::selector("getFlashLoanFeePercentage()"), &[]),
            &anchor,
            semantics,
        )?;
        let fee_word = abi::single_word(returned(&fee_call, "getFlashLoanFeePercentage")?)?;
        let fee_percentage_1e18 = abi::decode_u64(&fee_word)?;
        if fee_percentage_1e18 > 1_000_000_000_000_000_000 {
            return Err(ChainError::Evidence(
                "Balancer flash fee exceeds 1e18".into(),
            ));
        }

        let balance_selector = abi::selector("balanceOf(address)");
        let requests = assets
            .iter()
            .map(|asset| {
                (
                    *asset,
                    abi::encode_call(balance_selector, &[abi::address_word(vault.as_bytes())]),
                )
            })
            .collect::<Vec<_>>();
        let balances = ctx.calls(&requests, &anchor, semantics)?;
        if balances.len() != assets.len() {
            return Err(ChainError::Evidence(
                "Balancer asset balance call count differs".into(),
            ));
        }

        let mut asset_rows = Vec::with_capacity(assets.len());
        for (asset, balance) in assets.iter().zip(&balances) {
            let token_code = ctx.code(*asset, &anchor, semantics)?;
            if token_code.payload().is_absent() {
                return Err(ChainError::Evidence(format!(
                    "D08 admitted asset {} has no code at Balancer anchor",
                    asset.to_hex()
                )));
            }
            let amount = returned_amount(returned(balance, "balanceOf")?, "balanceOf")?;
            asset_rows.push(Json::object([
                ("asset", Json::string(asset.to_hex())),
                (
                    "vault_balance",
                    Json::string(amount_decimal(*amount.as_be_bytes())),
                ),
                (
                    "code_sha256",
                    Json::string(sha256_plain(token_code.payload().code())),
                ),
            ]));
        }

        Ok(Json::object([
            ("anchor", full_anchor_json(&anchor)),
            (
                "authority_lock_sha256",
                Json::string(authority_lock_sha256.to_owned()),
            ),
            (
                "d08_market_state_sha256",
                Json::string(d08_market_state_sha256.to_owned()),
            ),
            (
                "d08_token_admission_sha256",
                Json::string(d08_token_admission_sha256.to_owned()),
            ),
            (
                "d08_evidence_manifest_sha256",
                Json::string(d08_evidence_manifest_sha256.to_owned()),
            ),
            (
                "asset_universe_sha256",
                Json::string(assets_commitment.clone()),
            ),
            (
                "vault",
                Json::object([
                    ("address", Json::string(vault.to_hex())),
                    ("code_sha256", Json::string(vault_code_sha256)),
                    ("fee_collector", Json::string(fee_collector.to_hex())),
                    (
                        "fee_collector_code_sha256",
                        Json::string(fee_collector_code_sha256),
                    ),
                    ("paused", Json::Bool(paused)),
                    (
                        "pause_window_end_time",
                        Json::string(pause_window_end_time.to_string()),
                    ),
                    (
                        "buffer_period_end_time",
                        Json::string(buffer_period_end_time.to_string()),
                    ),
                    (
                        "flash_loan_fee_percentage_1e18",
                        Json::string(fee_percentage_1e18.to_string()),
                    ),
                ]),
            ),
            ("assets", Json::Array(asset_rows)),
        ]))
    })?;

    let semantic = output.result_json()?;
    let mut members = vec![
        ("schema_version", Json::uint(1)),
        ("stage", Json::string("RMC-011")),
        ("family", Json::string("BALANCER_V2_FLASH_LOAN")),
        ("provider_id", Json::string(provider.label().to_owned())),
        (
            "provider_operator",
            Json::string(provider.operator().to_owned()),
        ),
        (
            "rpc_endpoint_hash",
            Json::string(sha256_plain(provider.url().as_bytes())),
        ),
        (
            "provider_manifest",
            Json::string(output.manifest_id().to_hex()),
        ),
        (
            "bootstrap_manifest",
            Json::string(bootstrap.manifest_id().to_hex()),
        ),
        (
            "anchor_manifest",
            Json::string(anchor_output.manifest_id().to_hex()),
        ),
    ];
    for (key, value) in semantic
        .as_object()
        .ok_or_else(|| ChainError::Evidence("Balancer semantic result is not an object".into()))?
    {
        members.push((key.as_str(), value.clone()));
    }
    Ok(Json::object(members))
}

fn capture_semantics(capture: &Json) -> Result<Json, ChainError> {
    let mut members = Vec::new();
    for key in [
        "schema_version",
        "stage",
        "family",
        "anchor",
        "authority_lock_sha256",
        "d08_market_state_sha256",
        "d08_token_admission_sha256",
        "d08_evidence_manifest_sha256",
        "asset_universe_sha256",
        "vault",
        "assets",
    ] {
        let value = capture
            .get(key)
            .ok_or_else(|| ChainError::Evidence(format!("Balancer capture missing {key}")))?;
        members.push((key, value.clone()));
    }
    Ok(Json::object(members))
}

fn capture_digest(capture: &Json) -> Result<Hash32, ChainError> {
    let bytes = capture.canonical()?;
    let digest: [u8; 32] = Sha256::digest(&bytes).into();
    Hash32::new(digest).map_err(|_| ChainError::Evidence("Balancer capture digest is zero".into()))
}

fn bool_json(value: &Json, key: &str) -> Result<bool, ChainError> {
    value
        .get(key)
        .and_then(Json::as_bool)
        .ok_or_else(|| ChainError::Evidence(format!("Balancer capture missing boolean {key}")))
}

fn decimal_u64(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .str_field(key)?
        .parse::<u64>()
        .map_err(|_| ChainError::Evidence(format!("Balancer capture {key} is not uint64 decimal")))
}

/// Reconcile two independent Balancer captures and convert their exact common
/// state into canonical CapitalSource records.
///
/// Provider-specific provenance is intentionally excluded from the semantic
/// equality comparison, but provider label, operator and endpoint hash must all
/// be distinct. Every economic/state field, anchor, D08 digest and asset row
/// must otherwise agree byte-canonically.
pub fn reconcile_balancer_captures(
    first: &Json,
    second: &Json,
) -> Result<Vec<CapitalSource>, Box<dyn Error>> {
    if first.str_field("stage")? != "RMC-011"
        || second.str_field("stage")? != "RMC-011"
        || first.str_field("family")? != "BALANCER_V2_FLASH_LOAN"
        || second.str_field("family")? != "BALANCER_V2_FLASH_LOAN"
    {
        return Err("Balancer capture stage/family mismatch".into());
    }

    for key in ["provider_id", "provider_operator", "rpc_endpoint_hash"] {
        if first.str_field(key)? == second.str_field(key)? {
            return Err(format!("Balancer captures are not independent: {key} matches").into());
        }
    }

    let first_semantic = capture_semantics(first)?;
    let second_semantic = capture_semantics(second)?;
    if first_semantic.canonical()? != second_semantic.canonical()? {
        return Err("Balancer dual-provider semantic observations disagree".into());
    }

    let first_digest = capture_digest(first)?;
    let second_digest = capture_digest(second)?;
    if first_digest == second_digest {
        return Err("Balancer provider transcript digests are not independent".into());
    }

    let anchor = parse_full_anchor(
        first
            .get("anchor")
            .ok_or("Balancer capture has no anchor")?,
    )?;
    let vault_row = first
        .get("vault")
        .ok_or("Balancer capture has no vault object")?;
    let vault = Address::parse_hex(vault_row.str_field("address")?)?;
    if vault.to_hex() != BALANCER_V2_VAULT {
        return Err("Balancer capture vault differs from canonical Vault".into());
    }
    let paused = bool_json(vault_row, "paused")?;
    let fee_percentage_1e18 = decimal_u64(vault_row, "flash_loan_fee_percentage_1e18")?;

    let assets = first
        .get("assets")
        .and_then(Json::as_array)
        .ok_or("Balancer capture has no assets")?;
    if assets.is_empty() {
        return Err("Balancer capture asset universe is empty".into());
    }

    let mut seen = BTreeSet::new();
    let mut sources = Vec::with_capacity(assets.len());
    for row in assets {
        let asset = Address::parse_hex(row.str_field("asset")?)?;
        if !seen.insert(asset) {
            return Err(format!("Balancer capture repeats asset {}", asset.to_hex()).into());
        }
        let available_vault_balance = Amount256::parse_decimal(row.str_field("vault_balance")?)?;
        let observation = BalancerV2AuthenticatedObservation {
            anchor: anchor.clone(),
            vault,
            asset,
            available_vault_balance,
            fee_percentage_1e18,
            paused,
        };
        let source = admit_balancer_v2_dual_provider(
            &observation,
            &observation,
            &first_digest,
            &second_digest,
        )?;
        sources.push(source);
    }

    sources.sort_by_key(|source| source.id());
    Ok(sources)
}

/// Build the canonical Balancer dual-provider reconciliation artifact.
///
/// Both input captures must themselves be canonical JSON. The returned bytes
/// are immediately re-parsed through the independent authority decoder before
/// being released, so producer and verifier cannot silently drift.
pub fn build_balancer_reconciliation_artifact(
    first_bytes: &[u8],
    second_bytes: &[u8],
) -> Result<Vec<u8>, Box<dyn Error>> {
    let first = Json::parse(first_bytes)?;
    let second = Json::parse(second_bytes)?;
    if first.canonical()? != first_bytes || second.canonical()? != second_bytes {
        return Err("Balancer provider capture is not canonical JSON".into());
    }

    let sources = reconcile_balancer_captures(&first, &second)?;
    let mut rows = Vec::with_capacity(sources.len());
    for source in &sources {
        rows.push(Json::object([
            ("source_id", Json::string(source.id().to_hex())),
            ("source_key_id", Json::string(source.key_id().to_hex())),
            ("capital_class", Json::string(source.class().code())),
            ("asset", Json::string(source.asset().code())),
            (
                "maximum_available",
                Json::string(source.maximum_available().to_hex()),
            ),
            (
                "executable_capacity",
                Json::string(source.executable_capacity()?.to_hex()),
            ),
            (
                "execution_eligible",
                Json::Bool(source.execution_eligible()),
            ),
            (
                "execution_blockers",
                Json::array(
                    source
                        .execution_blockers()
                        .iter()
                        .cloned()
                        .map(Json::string),
                ),
            ),
            (
                "canonical_record",
                Json::string(hex::plain(&source.canonical_encode())),
            ),
        ]));
    }

    let report = Json::object([
        ("schema_version", Json::uint(1)),
        ("stage", Json::string("RMC-011")),
        ("family", Json::string("BALANCER_V2_FLASH_LOAN")),
        (
            "status",
            Json::string("RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED"),
        ),
        ("provider_count", Json::uint(2)),
        (
            "first_capture_sha256",
            Json::string(sha256_plain(first_bytes)),
        ),
        (
            "second_capture_sha256",
            Json::string(sha256_plain(second_bytes)),
        ),
        ("source_count", Json::uint(u64::try_from(sources.len())?)),
        ("sources", Json::Array(rows)),
    ]);
    let bytes = report.canonical()?;

    let (authority, decoded) = source_authority_from_balancer_reconcile_artifact(&bytes)?;
    if authority.family().code() != "BALANCER_V2_FLASH_LOAN"
        || decoded.len() != sources.len()
        || decoded
            .iter()
            .zip(&sources)
            .any(|(left, right)| left != right)
    {
        return Err("Balancer reconciliation self-verification failed".into());
    }
    Ok(bytes)
}

/// Decode and independently verify the Rust reconciliation artifact, then bind
/// its exact bytes to a D11-native source authority.
///
/// Readable report fields are never trusted over `canonical_record`. Every
/// source is decoded from its canonical binary form, readable projections must
/// match that decoded source, and its evidence set must be exactly the two raw
/// provider-capture SHA-256 digests named by the report.
pub fn source_authority_from_balancer_reconcile_artifact(
    bytes: &[u8],
) -> Result<(D11SourceAuthority, Vec<CapitalSource>), Box<dyn Error>> {
    let report = Json::parse(bytes)?;
    if report.canonical()? != bytes {
        return Err("Balancer reconciliation artifact is not canonical JSON".into());
    }
    if u64_field(&report, "schema_version")? != 1
        || report.str_field("stage")? != "RMC-011"
        || report.str_field("family")? != "BALANCER_V2_FLASH_LOAN"
        || report.str_field("status")? != "RMC011_BALANCER_V2_DUAL_PROVIDER_RECONCILED"
        || u64_field(&report, "provider_count")? != 2
    {
        return Err("Balancer reconciliation artifact identity mismatch".into());
    }

    let first_digest =
        Hash32::parse_hex(&format!("0x{}", report.str_field("first_capture_sha256")?))?;
    let second_digest =
        Hash32::parse_hex(&format!("0x{}", report.str_field("second_capture_sha256")?))?;
    if first_digest == second_digest {
        return Err("Balancer reconciliation names duplicate capture digests".into());
    }
    let expected_evidence = BTreeSet::from([
        CapitalEvidenceRef::Artifact(first_digest),
        CapitalEvidenceRef::Artifact(second_digest),
    ]);

    let rows = report
        .get("sources")
        .and_then(Json::as_array)
        .ok_or("Balancer reconciliation has no sources array")?;
    let declared_count = usize::try_from(u64_field(&report, "source_count")?)?;
    if rows.is_empty() || rows.len() != declared_count {
        return Err("Balancer reconciliation source count mismatch".into());
    }

    let mut source_ids = BTreeSet::new();
    let mut source_key_ids = BTreeSet::new();
    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let canonical_hex = row.str_field("canonical_record")?;
        let encoded = hex::decode_data(&format!("0x{canonical_hex}"))?;
        let source = CapitalSource::decode_canonical(&encoded)?;

        if row.str_field("source_id")? != source.id().to_hex()
            || row.str_field("source_key_id")? != source.key_id().to_hex()
            || row.str_field("capital_class")? != source.class().code()
            || row.str_field("asset")? != source.asset().code()
            || row.str_field("maximum_available")? != source.maximum_available().to_hex()
            || row.str_field("executable_capacity")? != source.executable_capacity()?.to_hex()
            || bool_json(row, "execution_eligible")? != source.execution_eligible()
        {
            return Err("Balancer readable source projection differs from canonical record".into());
        }

        let blocker_rows = row
            .get("execution_blockers")
            .and_then(Json::as_array)
            .ok_or("Balancer source projection has no execution_blockers")?;
        let blockers = blocker_rows
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or("Balancer execution blocker is not text")
            })
            .collect::<Result<Vec<_>, _>>()?;
        if blockers != source.execution_blockers() {
            return Err("Balancer execution blockers differ from canonical record".into());
        }

        let observed_evidence = source.evidence().iter().copied().collect::<BTreeSet<_>>();
        if observed_evidence != expected_evidence || source.evidence().len() != 2 {
            return Err(
                "Balancer source evidence does not equal the two provider capture digests".into(),
            );
        }
        if !source_ids.insert(source.id()) {
            return Err("Balancer reconciliation repeats source id".into());
        }
        if !source_key_ids.insert(source.key_id()) {
            return Err("Balancer reconciliation repeats source key".into());
        }
        sources.push(source);
    }

    let anchor = sources
        .first()
        .ok_or("Balancer reconciliation decoded no sources")?
        .anchor()
        .clone();
    if sources.iter().any(|source| source.anchor() != &anchor) {
        return Err("Balancer reconciliation mixes observation anchors".into());
    }

    let authority = D11SourceAuthority::from_reconciliation_artifact(anchor, bytes, &sources)?;
    authority.verify(bytes, &sources)?;
    Ok((authority, sources))
}

pub fn run_balancer_capture(
    providers_path: &Path,
    provider_label: &str,
    store_path: &Path,
    d08_market_state_path: &Path,
    d08_token_admission_path: &Path,
    d08_evidence_manifest_path: &Path,
    authority_lock_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let provider = providers
        .iter()
        .find(|provider| provider.label() == provider_label)
        .cloned()
        .ok_or_else(|| format!("unknown provider label {provider_label}"))?;

    let market_state = fs::read(d08_market_state_path)?;
    let token_admission = fs::read(d08_token_admission_path)?;
    let manifest_bytes = fs::read(d08_evidence_manifest_path)?;
    let authority_bytes = fs::read(authority_lock_path)?;

    let manifest = Json::parse(&manifest_bytes)?;
    let market_state_sha256 =
        verify_d08_artifact(&manifest, "market-state-manifest.jsonl", &market_state)?;
    let token_admission_sha256 =
        verify_d08_artifact(&manifest, "token-admission.jsonl", &token_admission)?;
    let d08_evidence_manifest_sha256 = sha256_plain(&manifest_bytes);
    let authority_lock_sha256 = sha256_plain(&authority_bytes);

    let expected_anchor = parse_full_anchor(
        manifest
            .get("observation_anchor")
            .ok_or("D08 evidence manifest has no observation_anchor")?,
    )?;
    let authority = Json::parse(&authority_bytes)?;
    let authority_anchor = parse_full_anchor(
        authority
            .get("observation_anchor")
            .ok_or("D11 authority lock has no observation_anchor")?,
    )?;
    if authority_anchor != expected_anchor {
        return Err("D11 authority lock anchor differs from D08 evidence anchor".into());
    }
    let assets = actionable_assets(&market_state, &token_admission)?;

    let store = Store::create(store_path, StoreConfig::standard())?;
    let transport = CurlTransport::new(60, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());

    Ok(provider_capture(
        &acquisition,
        &provider,
        &expected_anchor,
        &assets,
        &authority_lock_sha256,
        &market_state_sha256,
        &token_admission_sha256,
        &d08_evidence_manifest_sha256,
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_anchor_json() -> Json {
        Json::object([
            ("chain_id", Json::uint(1)),
            (
                "genesis_hash",
                Json::string(format!("0x{}", "11".repeat(32))),
            ),
            (
                "fork_lineage",
                Json::string(format!("0x{}", "22".repeat(32))),
            ),
            ("block_number", Json::uint(25_437_474)),
            ("block_hash", Json::string(format!("0x{}", "33".repeat(32)))),
            (
                "parent_hash",
                Json::string(format!("0x{}", "44".repeat(32))),
            ),
            ("timestamp", Json::uint(1_700_000_000)),
            ("state_root", Json::string(format!("0x{}", "55".repeat(32)))),
        ])
    }

    fn test_capture(
        provider_id: &str,
        provider_operator: &str,
        endpoint_hash: &str,
        balance: &str,
    ) -> Json {
        Json::object([
            ("schema_version", Json::uint(1)),
            ("stage", Json::string("RMC-011")),
            ("family", Json::string("BALANCER_V2_FLASH_LOAN")),
            ("provider_id", Json::string(provider_id.to_owned())),
            (
                "provider_operator",
                Json::string(provider_operator.to_owned()),
            ),
            ("rpc_endpoint_hash", Json::string(endpoint_hash.to_owned())),
            ("anchor", test_anchor_json()),
            ("authority_lock_sha256", Json::string("aa".repeat(32))),
            ("d08_market_state_sha256", Json::string("bb".repeat(32))),
            ("d08_token_admission_sha256", Json::string("cc".repeat(32))),
            (
                "d08_evidence_manifest_sha256",
                Json::string("dd".repeat(32)),
            ),
            ("asset_universe_sha256", Json::string("ee".repeat(32))),
            (
                "vault",
                Json::object([
                    ("address", Json::string(BALANCER_V2_VAULT)),
                    ("code_sha256", Json::string("12".repeat(32))),
                    (
                        "fee_collector",
                        Json::string("0x6666666666666666666666666666666666666666"),
                    ),
                    ("fee_collector_code_sha256", Json::string("34".repeat(32))),
                    ("paused", Json::Bool(false)),
                    ("pause_window_end_time", Json::string("1")),
                    ("buffer_period_end_time", Json::string("2")),
                    (
                        "flash_loan_fee_percentage_1e18",
                        Json::string("500000000000000"),
                    ),
                ]),
            ),
            (
                "assets",
                Json::array([Json::object([
                    (
                        "asset",
                        Json::string("0x7777777777777777777777777777777777777777"),
                    ),
                    ("vault_balance", Json::string(balance.to_owned())),
                    ("code_sha256", Json::string("56".repeat(32))),
                ])]),
            ),
        ])
    }

    #[test]
    fn dual_provider_reconcile_emits_exact_balancer_source() {
        let first = test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456");
        let second = test_capture("provider-b", "operator-b", &"cd".repeat(32), "123456");
        let sources =
            reconcile_balancer_captures(&first, &second).unwrap_or_else(|_| unreachable!());
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].maximum_available(),
            Amount256::from_u128(123_456)
        );
        assert!(sources[0].execution_eligible());
    }

    #[test]
    fn dual_provider_reconcile_rejects_economic_mismatch() {
        let first = test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456");
        let second = test_capture("provider-b", "operator-b", &"cd".repeat(32), "123455");
        assert!(reconcile_balancer_captures(&first, &second).is_err());
    }

    #[test]
    fn dual_provider_reconcile_rejects_same_operator() {
        let first = test_capture("provider-a", "same-operator", &"ab".repeat(32), "123456");
        let second = test_capture("provider-b", "same-operator", &"cd".repeat(32), "123456");
        assert!(reconcile_balancer_captures(&first, &second).is_err());
    }

    #[test]
    fn reconcile_artifact_roundtrips_into_source_authority() -> Result<(), Box<dyn Error>> {
        let first =
            test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456").canonical()?;
        let second =
            test_capture("provider-b", "operator-b", &"cd".repeat(32), "123456").canonical()?;
        let report = build_balancer_reconciliation_artifact(&first, &second)?;
        let (authority, sources) = source_authority_from_balancer_reconcile_artifact(&report)?;
        assert_eq!(authority.family().code(), "BALANCER_V2_FLASH_LOAN");
        assert_eq!(authority.source_count(), 1);
        assert_eq!(sources.len(), 1);
        assert_eq!(
            sources[0].maximum_available(),
            Amount256::from_u128(123_456)
        );
        Ok(())
    }

    #[test]
    fn reconcile_artifact_rejects_readable_projection_tamper() -> Result<(), Box<dyn Error>> {
        let first =
            test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456").canonical()?;
        let second =
            test_capture("provider-b", "operator-b", &"cd".repeat(32), "123456").canonical()?;
        let report = build_balancer_reconciliation_artifact(&first, &second)?;
        let parsed = Json::parse(&report)?;
        let source_id = parsed
            .get("sources")
            .and_then(Json::as_array)
            .and_then(|rows| rows.first())
            .ok_or("missing source row")?
            .str_field("source_id")?
            .to_owned();
        let text = String::from_utf8(report)?;
        let tampered = text.replacen(&source_id, &"00".repeat(32), 1);
        assert!(source_authority_from_balancer_reconcile_artifact(tampered.as_bytes()).is_err());
        Ok(())
    }

    #[test]
    fn reconcile_artifact_rejects_capture_digest_tamper() -> Result<(), Box<dyn Error>> {
        let first =
            test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456").canonical()?;
        let second =
            test_capture("provider-b", "operator-b", &"cd".repeat(32), "123456").canonical()?;
        let report = build_balancer_reconciliation_artifact(&first, &second)?;
        let parsed = Json::parse(&report)?;
        let digest = parsed.str_field("first_capture_sha256")?.to_owned();
        let text = String::from_utf8(report)?;
        let tampered = text.replacen(&digest, &"ff".repeat(32), 1);
        assert!(source_authority_from_balancer_reconcile_artifact(tampered.as_bytes()).is_err());
        Ok(())
    }

    #[test]
    fn reconcile_builder_rejects_noncanonical_provider_capture() -> Result<(), Box<dyn Error>> {
        let mut first =
            test_capture("provider-a", "operator-a", &"ab".repeat(32), "123456").canonical()?;
        first.push(b'\n');
        let second =
            test_capture("provider-b", "operator-b", &"cd".repeat(32), "123456").canonical()?;
        assert!(build_balancer_reconciliation_artifact(&first, &second).is_err());
        Ok(())
    }

    #[test]
    fn uint256_decimal_is_exact_at_boundaries() {
        assert_eq!(amount_decimal([0; 32]), "0");
        let mut one = [0_u8; 32];
        one[31] = 1;
        assert_eq!(amount_decimal(one), "1");
        let max = [0xff_u8; 32];
        assert_eq!(
            amount_decimal(max),
            "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        );
    }

    #[test]
    fn balancer_selectors_are_derived_from_signatures() {
        assert_eq!(
            abi::selector("balanceOf(address)"),
            [0x70, 0xa0, 0x82, 0x31]
        );
        assert_ne!(abi::selector("getProtocolFeesCollector()"), [0; 4]);
        assert_ne!(abi::selector("getPausedState()"), [0; 4]);
        assert_ne!(abi::selector("getFlashLoanFeePercentage()"), [0; 4]);
    }
}
