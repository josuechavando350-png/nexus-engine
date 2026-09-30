//! Authenticated live acquisition for the Balancer V2 flash-capital family.
//!
//! This module is deliberately narrow: it consumes the exact D08 admitted
//! market/token bytes, verifies those bytes against the D08 evidence manifest,
//! binds them to the canonical D11 upstream authority lock, and then captures
//! Balancer V2 Vault state from one declared provider into the RMC-004 store.
//! A separate reconciler requires two independent provider captures to agree.

use crate::Amount256;
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
use std::{
    collections::BTreeSet,
    error::Error,
    fs,
    path::Path,
};

const BALANCER_CAPTURE_NAMESPACE: u16 = 0x0b21;
const BALANCER_V2_VAULT: &str = "0xba12222222228d8ba445958a75a0704d566bf2c8";

fn sha256_plain(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn file_sha256(path: &Path) -> Result<String, Box<dyn Error>> {
    Ok(sha256_plain(&fs::read(path)?))
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
    observation: &'a nqc_census_core::CensusObservation<
        nqc_census_core::ContractCallEnvelope,
    >,
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

fn verify_d08_artifact(
    manifest: &Json,
    name: &str,
    bytes: &[u8],
) -> Result<String, ChainError> {
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
    if chain_facts.chain != *expected_anchor.chain() {
        return Err(ChainError::Evidence(
            "Balancer provider chain domain differs from D08 authority".into(),
        ));
    }
    let (anchor, anchor_output) = acquisition.resolve_anchor(
        provider,
        &chain_facts.chain,
        expected_anchor.block_number(),
    )?;
    if anchor != *expected_anchor {
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

    let output = acquisition.point(
        provider,
        &chain_facts.chain,
        None,
        &spec,
        &anchor,
        |ctx| {
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
                    (vault, abi::encode_call(abi::selector("getProtocolFeesCollector()"), &[])),
                    (vault, abi::encode_call(abi::selector("getPausedState()"), &[])),
                ],
                &anchor,
                semantics,
            )?;
            if core.len() != 2 {
                return Err(ChainError::Evidence(
                    "Balancer core call count differs".into(),
                ));
            }
            let fee_collector =
                required_address(returned(&core[0], "getProtocolFeesCollector")?, "fee collector")?;
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
            let fee_word = abi::single_word(returned(
                &fee_call,
                "getFlashLoanFeePercentage",
            )?)?;
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
                        abi::encode_call(
                            balance_selector,
                            &[abi::address_word(vault.as_bytes())],
                        ),
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
                        (
                            "fee_collector",
                            Json::string(fee_collector.to_hex()),
                        ),
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
        },
    )?;

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
        ("bootstrap_manifest", Json::string(bootstrap.manifest_id().to_hex())),
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
        assert_eq!(abi::selector("balanceOf(address)"), [0x70, 0xa0, 0x82, 0x31]);
        assert_ne!(abi::selector("getProtocolFeesCollector()"), [0; 4]);
        assert_ne!(abi::selector("getPausedState()"), [0; 4]);
        assert_ne!(abi::selector("getFlashLoanFeePercentage()"), [0; 4]);
    }
}
