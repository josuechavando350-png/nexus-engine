//! RMC-011 Uniswap V3 permissionless flash-capital discovery primitives.
//!
//! Deployment documentation is only a discovery root. Runtime code, full
//! PoolCreated history, direct factory membership and pool balances remain
//! block-pinned chain evidence obligations.

use crate::{
    permissionless_atomic::{
        admit_uniswap_v3_dual_provider, UniswapV3AuthenticatedObservation,
    },
    source_authority::D11SourceAuthority,
    Amount256, CapitalEvidenceRef, CapitalSource,
};
use nqc_census_chain::{abi, evm::CodeScan, hex, json::Json, ChainError};
use nqc_census_core::{Address, ChainDomain, Hash32, LogTopic, RawLogEnvelope, StateAnchor};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, error::Error};

pub const UNISWAP_V3_FACTORY: &str = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
pub const UNISWAP_V3_DEPLOYMENT_REPOSITORY: &str = "Uniswap/v3-periphery";
pub const UNISWAP_V3_DEPLOYMENT_COMMIT: &str =
    "0682387198a24c7cd63566a2c58398533860a5d1";
pub const UNISWAP_V3_DEPLOYMENT_BLOB: &str = "c0af53cb35bdef902965262c23b34f5d39baf343";
pub const UNISWAP_V3_DEPLOYMENT_PATH: &str = "deploys.md";

const GET_POOL: &str = "getPool(address,address,uint24)";
const POOL_CREATED: &str = "PoolCreated(address,address,uint24,int24,address)";
const POOL_TOKEN0: &str = "token0()";
const POOL_TOKEN1: &str = "token1()";
const POOL_FEE: &str = "fee()";
const POOL_LIQUIDITY: &str = "liquidity()";
const POOL_FLASH: &str = "flash(address,uint256,uint256,bytes)";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct UniswapV3FactoryInterface {
    pub get_pool: [u8; 4],
    pub pool_created_topic: [u8; 32],
}

pub fn uniswap_v3_factory_interface() -> UniswapV3FactoryInterface {
    UniswapV3FactoryInterface {
        get_pool: abi::selector(GET_POOL),
        pool_created_topic: abi::event_topic(POOL_CREATED),
    }
}

pub fn verify_uniswap_v3_factory_runtime(code: &[u8]) -> Result<(), ChainError> {
    if code.is_empty() {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory has no runtime code".into(),
        ));
    }
    let interface = uniswap_v3_factory_interface();
    let scan = CodeScan::new(code);
    if scan.truncated_push() {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime has truncated PUSH data".into(),
        ));
    }
    if !scan.has_selector(interface.get_pool) {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime does not evidence getPool selector".into(),
        ));
    }
    if !scan.has_word(&interface.pool_created_topic) {
        return Err(ChainError::Evidence(
            "Uniswap V3 factory runtime does not evidence PoolCreated topic".into(),
        ));
    }
    Ok(())
}

pub fn verify_uniswap_v3_pool_runtime(code: &[u8]) -> Result<(), ChainError> {
    if code.is_empty() {
        return Err(ChainError::Evidence(
            "Uniswap V3 pool has no runtime code".into(),
        ));
    }
    let scan = CodeScan::new(code);
    if scan.truncated_push() {
        return Err(ChainError::Evidence(
            "Uniswap V3 pool runtime has truncated PUSH data".into(),
        ));
    }
    for signature in [
        POOL_TOKEN0,
        POOL_TOKEN1,
        POOL_FEE,
        POOL_LIQUIDITY,
        POOL_FLASH,
    ] {
        if !scan.has_selector(abi::selector(signature)) {
            return Err(ChainError::Evidence(format!(
                "Uniswap V3 pool runtime does not evidence {signature}"
            )));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UniswapV3PoolIdentity {
    pub token0: Address,
    pub token1: Address,
    pub fee_pips: u32,
    pub tick_spacing: i32,
    pub pool: Address,
}

fn topic_address(topic: &LogTopic, label: &'static str) -> Result<Address, ChainError> {
    let bytes = topic.as_bytes();
    if bytes[..12].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "Uniswap V3 {label} topic has non-canonical address padding"
        )));
    }
    let mut address = [0_u8; 20];
    address.copy_from_slice(&bytes[12..]);
    Address::new(address).map_err(ChainError::from)
}

fn topic_u24(topic: &LogTopic, label: &'static str) -> Result<u32, ChainError> {
    let bytes = topic.as_bytes();
    if bytes[..29].iter().any(|byte| *byte != 0) {
        return Err(ChainError::Evidence(format!(
            "Uniswap V3 {label} topic has non-canonical uint24 padding"
        )));
    }
    Ok((u32::from(bytes[29]) << 16) | (u32::from(bytes[30]) << 8) | u32::from(bytes[31]))
}

fn decode_i24_word(word: &[u8; 32]) -> Result<i32, ChainError> {
    let raw =
        (u32::from(word[29]) << 16) | (u32::from(word[30]) << 8) | u32::from(word[31]);
    let negative = raw & 0x0080_0000 != 0;
    let expected_padding = if negative { 0xff } else { 0x00 };
    if word[..29]
        .iter()
        .any(|byte| *byte != expected_padding)
    {
        return Err(ChainError::Evidence(
            "Uniswap V3 tickSpacing has non-canonical int24 sign extension".into(),
        ));
    }
    Ok(if negative {
        (raw | 0xff00_0000) as i32
    } else {
        raw as i32
    })
}

pub fn decode_uniswap_v3_pool_created(
    factory: Address,
    log: &RawLogEnvelope,
) -> Result<UniswapV3PoolIdentity, ChainError> {
    if log.removed() {
        return Err(ChainError::Evidence(
            "removed Uniswap V3 PoolCreated log".into(),
        ));
    }
    if log.emitter() != factory {
        return Err(ChainError::Evidence(
            "wrong Uniswap V3 PoolCreated emitter".into(),
        ));
    }
    let topics = log.topics();
    if topics.len() != 4 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated must have exactly four topics".into(),
        ));
    }
    let interface = uniswap_v3_factory_interface();
    if topics[0].as_bytes() != &interface.pool_created_topic {
        return Err(ChainError::Evidence(
            "wrong Uniswap V3 PoolCreated topic0".into(),
        ));
    }

    let token0 = topic_address(&topics[1], "token0")?;
    let token1 = topic_address(&topics[2], "token1")?;
    if token0 >= token1 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated token order is not canonical".into(),
        ));
    }
    let fee_pips = topic_u24(&topics[3], "fee")?;
    if fee_pips == 0 || fee_pips >= 1_000_000 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated fee is outside flash-fee domain".into(),
        ));
    }

    let words = abi::words(log.data())?;
    if words.len() != 2 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated data must contain tickSpacing and pool".into(),
        ));
    }
    let tick_spacing = decode_i24_word(&words[0])?;
    if tick_spacing <= 0 {
        return Err(ChainError::Evidence(
            "Uniswap V3 PoolCreated tickSpacing must be positive".into(),
        ));
    }
    let pool_raw = abi::decode_address(&words[1])?
        .ok_or_else(|| ChainError::Evidence("Uniswap V3 PoolCreated emitted zero pool".into()))?;
    let pool = Address::new(pool_raw)?;
    if pool == factory || pool == token0 || pool == token1 {
        return Err(ChainError::Evidence(
            "Uniswap V3 pool collides with factory/token address".into(),
        ));
    }

    Ok(UniswapV3PoolIdentity {
        token0,
        token1,
        fee_pips,
        tick_spacing,
        pool,
    })
}


fn reconciliation_sha256(bytes: &[u8]) -> String {
    hex::plain(&Sha256::digest(bytes))
}

fn reconciliation_u64(value: &Json, key: &str) -> Result<u64, Box<dyn Error>> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| format!("missing unsigned integer field {key}").into())
}

fn parse_capture_anchor(value: &Json) -> Result<StateAnchor, Box<dyn Error>> {
    let chain = ChainDomain::new(
        reconciliation_u64(value, "chain_id")?,
        Hash32::parse_hex(value.str_field("genesis_hash")?)?,
        Hash32::parse_hex(value.str_field("fork_lineage")?)?,
    )?;
    Ok(StateAnchor::new(
        chain,
        reconciliation_u64(value, "block_number")?,
        Hash32::parse_hex(value.str_field("block_hash")?)?,
        Hash32::parse_hex(value.str_field("parent_hash")?)?,
        reconciliation_u64(value, "timestamp")?,
        Hash32::parse_hex(value.str_field("state_root")?)?,
    )?)
}

fn capture_digest(capture: &Json) -> Result<Hash32, Box<dyn Error>> {
    let digest: [u8; 32] = Sha256::digest(capture.canonical()?).into();
    Ok(Hash32::new(digest)?)
}

fn validate_sha256_text(value: &str, label: &str) -> Result<(), Box<dyn Error>> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(format!("{label} must be 64 lowercase hex").into());
    }
    Ok(())
}

fn capture_semantics(capture: &Json) -> Result<Json, Box<dyn Error>> {
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
        "deployment_sha256",
        "factory",
        "pool_event_history_sha256",
        "pool_universe_sha256",
        "pools",
    ] {
        members.push((
            key,
            capture
                .get(key)
                .ok_or_else(|| format!("Uniswap V3 capture missing {key}"))?
                .clone(),
        ));
    }
    Ok(Json::object(members))
}

fn validate_capture_identity(capture: &Json) -> Result<(), Box<dyn Error>> {
    if reconciliation_u64(capture, "schema_version")? != 1
        || capture.str_field("stage")? != "RMC-011"
        || capture.str_field("family")? != "UNISWAP_V3_FLASH"
    {
        return Err("Uniswap V3 capture identity mismatch".into());
    }
    for key in [
        "authority_lock_sha256",
        "d08_market_state_sha256",
        "d08_token_admission_sha256",
        "d08_evidence_manifest_sha256",
        "deployment_sha256",
        "pool_event_history_sha256",
        "pool_universe_sha256",
    ] {
        validate_sha256_text(capture.str_field(key)?, key)?;
    }
    let factory = capture
        .get("factory")
        .ok_or("Uniswap V3 capture has no factory object")?;
    if factory.str_field("address")? != UNISWAP_V3_FACTORY {
        return Err("Uniswap V3 capture factory address differs".into());
    }
    validate_sha256_text(factory.str_field("runtime_sha256")?, "factory runtime_sha256")?;
    Ok(())
}

/// Reconcile two independent exact-state provider captures into canonical
/// Uniswap V3 flash-capital sources.
pub fn reconcile_uniswap_v3_captures(
    first: &Json,
    second: &Json,
) -> Result<Vec<CapitalSource>, Box<dyn Error>> {
    validate_capture_identity(first)?;
    validate_capture_identity(second)?;

    for key in ["provider_id", "provider_operator", "rpc_endpoint_hash"] {
        if first.str_field(key)? == second.str_field(key)? {
            return Err(format!("Uniswap V3 captures are not independent: {key} matches").into());
        }
    }

    if capture_semantics(first)?.canonical()? != capture_semantics(second)?.canonical()? {
        return Err("Uniswap V3 dual-provider semantic observations disagree".into());
    }

    let anchor = parse_capture_anchor(
        first
            .get("anchor")
            .ok_or("Uniswap V3 capture has no anchor")?,
    )?;
    let first_digest = capture_digest(first)?;
    let second_digest = capture_digest(second)?;
    if first_digest == second_digest {
        return Err("Uniswap V3 captures have identical full capture digests".into());
    }

    let pools = first
        .get("pools")
        .and_then(Json::as_array)
        .ok_or("Uniswap V3 capture has no pools array")?;
    if pools.is_empty() {
        return Err("Uniswap V3 capture contains no D08-intersecting pools".into());
    }

    let mut seen_pools = BTreeSet::new();
    let mut seen_pool_assets = BTreeSet::new();
    let mut sources = Vec::new();

    for row in pools {
        let pool = Address::parse_hex(row.str_field("pool")?)?;
        let token0 = Address::parse_hex(row.str_field("token0")?)?;
        let token1 = Address::parse_hex(row.str_field("token1")?)?;
        if token0 >= token1 {
            return Err("Uniswap V3 pool token order is not canonical".into());
        }
        if !seen_pools.insert(pool) {
            return Err("Uniswap V3 capture repeats pool".into());
        }
        let fee_pips = u32::try_from(reconciliation_u64(row, "fee_pips")?)?;
        if fee_pips == 0 || fee_pips >= 1_000_000 {
            return Err("Uniswap V3 pool fee is outside flash-fee domain".into());
        }
        validate_sha256_text(row.str_field("pool_runtime_sha256")?, "pool runtime_sha256")?;

        let balances = row
            .get("asset_balances")
            .and_then(Json::as_array)
            .ok_or("Uniswap V3 pool has no asset_balances array")?;
        if balances.is_empty() {
            return Err("Uniswap V3 intersecting pool has no admitted asset balances".into());
        }

        let mut seen_assets = BTreeSet::new();
        for balance in balances {
            let asset = Address::parse_hex(balance.str_field("asset")?)?;
            if asset != token0 && asset != token1 {
                return Err("Uniswap V3 balance asset is not one of pool tokens".into());
            }
            if !seen_assets.insert(asset) || !seen_pool_assets.insert((pool, asset)) {
                return Err("Uniswap V3 capture repeats pool/asset balance".into());
            }
            let observation = UniswapV3AuthenticatedObservation {
                anchor: anchor.clone(),
                pool,
                asset,
                available_pool_balance: Amount256::parse_decimal(balance.str_field("balance")?)?,
                active_liquidity: Amount256::parse_decimal(row.str_field("active_liquidity")?)?,
                fee_pips,
            };
            sources.push(admit_uniswap_v3_dual_provider(
                &observation,
                &observation,
                &first_digest,
                &second_digest,
            )?);
        }
    }

    sources.sort_by_key(|source| source.key_id());
    Ok(sources)
}

pub fn build_uniswap_v3_reconciliation_artifact(
    first_bytes: &[u8],
    second_bytes: &[u8],
) -> Result<Vec<u8>, Box<dyn Error>> {
    let first = Json::parse(first_bytes)?;
    let second = Json::parse(second_bytes)?;
    if first.canonical()? != first_bytes || second.canonical()? != second_bytes {
        return Err("Uniswap V3 provider capture is not canonical JSON".into());
    }

    let sources = reconcile_uniswap_v3_captures(&first, &second)?;
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
            ("execution_eligible", Json::Bool(source.execution_eligible())),
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
        ("family", Json::string("UNISWAP_V3_FLASH")),
        (
            "status",
            Json::string("RMC011_UNISWAP_V3_DUAL_PROVIDER_RECONCILED"),
        ),
        ("provider_count", Json::uint(2)),
        (
            "first_capture_sha256",
            Json::string(reconciliation_sha256(first_bytes)),
        ),
        (
            "second_capture_sha256",
            Json::string(reconciliation_sha256(second_bytes)),
        ),
        ("source_count", Json::uint(u64::try_from(sources.len())?)),
        ("sources", Json::Array(rows)),
    ]);
    let bytes = report.canonical()?;

    let (authority, decoded) = source_authority_from_uniswap_v3_reconcile_artifact(&bytes)?;
    if authority.family().code() != "UNISWAP_V3_FLASH"
        || decoded.len() != sources.len()
        || decoded
            .iter()
            .zip(&sources)
            .any(|(left, right)| left != right)
    {
        return Err("Uniswap V3 reconciliation self-verification failed".into());
    }
    Ok(bytes)
}

pub fn source_authority_from_uniswap_v3_reconcile_artifact(
    bytes: &[u8],
) -> Result<(D11SourceAuthority, Vec<CapitalSource>), Box<dyn Error>> {
    let report = Json::parse(bytes)?;
    if report.canonical()? != bytes {
        return Err("Uniswap V3 reconciliation artifact is not canonical JSON".into());
    }
    if reconciliation_u64(&report, "schema_version")? != 1
        || report.str_field("stage")? != "RMC-011"
        || report.str_field("family")? != "UNISWAP_V3_FLASH"
        || report.str_field("status")? != "RMC011_UNISWAP_V3_DUAL_PROVIDER_RECONCILED"
        || reconciliation_u64(&report, "provider_count")? != 2
    {
        return Err("Uniswap V3 reconciliation artifact identity mismatch".into());
    }

    let first_digest =
        Hash32::parse_hex(&format!("0x{}", report.str_field("first_capture_sha256")?))?;
    let second_digest =
        Hash32::parse_hex(&format!("0x{}", report.str_field("second_capture_sha256")?))?;
    if first_digest == second_digest {
        return Err("Uniswap V3 reconciliation names duplicate capture digests".into());
    }
    let expected_evidence = BTreeSet::from([
        CapitalEvidenceRef::Artifact(first_digest),
        CapitalEvidenceRef::Artifact(second_digest),
    ]);

    let rows = report
        .get("sources")
        .and_then(Json::as_array)
        .ok_or("Uniswap V3 reconciliation has no sources array")?;
    let declared_count = usize::try_from(reconciliation_u64(&report, "source_count")?)?;
    if rows.is_empty() || rows.len() != declared_count {
        return Err("Uniswap V3 reconciliation source count mismatch".into());
    }

    let mut source_ids = BTreeSet::new();
    let mut source_key_ids = BTreeSet::new();
    let mut sources = Vec::with_capacity(rows.len());
    for row in rows {
        let encoded = hex::decode_data(&format!(
            "0x{}",
            row.str_field("canonical_record")?
        ))?;
        let source = CapitalSource::decode_canonical(&encoded)?;

        if row.str_field("source_id")? != source.id().to_hex()
            || row.str_field("source_key_id")? != source.key_id().to_hex()
            || row.str_field("capital_class")? != source.class().code()
            || row.str_field("asset")? != source.asset().code()
            || row.str_field("maximum_available")? != source.maximum_available().to_hex()
            || row.str_field("executable_capacity")? != source.executable_capacity()?.to_hex()
            || row
                .get("execution_eligible")
                .and_then(Json::as_bool)
                .ok_or("Uniswap V3 source projection lacks execution_eligible")?
                != source.execution_eligible()
        {
            return Err(
                "Uniswap V3 readable source projection differs from canonical record".into(),
            );
        }

        let blockers = row
            .get("execution_blockers")
            .and_then(Json::as_array)
            .ok_or("Uniswap V3 source projection has no execution_blockers")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(ToOwned::to_owned)
                    .ok_or("Uniswap V3 execution blocker is not text")
            })
            .collect::<Result<Vec<_>, _>>()?;
        if blockers != source.execution_blockers() {
            return Err("Uniswap V3 execution blockers differ from canonical record".into());
        }

        let observed_evidence = source
            .evidence()
            .iter()
            .copied()
            .collect::<BTreeSet<_>>();
        if observed_evidence != expected_evidence || source.evidence().len() != 2 {
            return Err(
                "Uniswap V3 source evidence does not equal the two provider capture digests".into(),
            );
        }
        if !source_ids.insert(source.id()) {
            return Err("Uniswap V3 reconciliation repeats source id".into());
        }
        if !source_key_ids.insert(source.key_id()) {
            return Err("Uniswap V3 reconciliation repeats source key".into());
        }
        sources.push(source);
    }

    let anchor = sources
        .first()
        .ok_or("Uniswap V3 reconciliation decoded no sources")?
        .anchor()
        .clone();
    if sources.iter().any(|source| source.anchor() != &anchor) {
        return Err("Uniswap V3 reconciliation mixes observation anchors".into());
    }

    let authority =
        D11SourceAuthority::from_reconciliation_artifact(anchor, bytes, &sources)?;
    authority.verify(bytes, &sources)?;
    Ok((authority, sources))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn address(byte: u8) -> Address {
        Address::new([byte; 20]).unwrap_or_else(|_| unreachable!())
    }

    fn hash(byte: u8) -> Hash32 {
        Hash32::new([byte; 32]).unwrap_or_else(|_| unreachable!())
    }

    fn address_topic(address: Address) -> LogTopic {
        let mut word = [0_u8; 32];
        word[12..].copy_from_slice(address.as_bytes());
        LogTopic::new(word)
    }

    fn fee_topic(fee: u32) -> LogTopic {
        let mut word = [0_u8; 32];
        let encoded = fee.to_be_bytes();
        word[29..].copy_from_slice(&encoded[1..]);
        LogTopic::new(word)
    }

    fn i24_word(value: i32) -> [u8; 32] {
        let mut word = if value < 0 { [0xff; 32] } else { [0_u8; 32] };
        let encoded = value.to_be_bytes();
        word[29..].copy_from_slice(&encoded[1..]);
        word
    }

    fn pool_log(token0: Address, token1: Address, fee: u32, tick: i32, pool: Address) -> RawLogEnvelope {
        let interface = uniswap_v3_factory_interface();
        let mut pool_word = [0_u8; 32];
        pool_word[12..].copy_from_slice(pool.as_bytes());
        let mut data = Vec::with_capacity(64);
        data.extend_from_slice(&i24_word(tick));
        data.extend_from_slice(&pool_word);
        RawLogEnvelope::with_topics(
            address(9),
            hash(8),
            0,
            0,
            vec![
                LogTopic::new(interface.pool_created_topic),
                address_topic(token0),
                address_topic(token1),
                fee_topic(fee),
            ],
            data,
            false,
        )
        .unwrap_or_else(|_| unreachable!())
    }

    #[test]
    fn interface_is_derived_from_exact_signatures() {
        let interface = uniswap_v3_factory_interface();
        assert_eq!(interface.get_pool, abi::selector(GET_POOL));
        assert_eq!(interface.pool_created_topic, abi::event_topic(POOL_CREATED));
    }

    #[test]
    fn decodes_canonical_pool_created() -> Result<(), ChainError> {
        let factory = address(9);
        let decoded = decode_uniswap_v3_pool_created(
            factory,
            &pool_log(address(1), address(2), 3_000, 60, address(3)),
        )?;
        assert_eq!(decoded.token0, address(1));
        assert_eq!(decoded.token1, address(2));
        assert_eq!(decoded.fee_pips, 3_000);
        assert_eq!(decoded.tick_spacing, 60);
        assert_eq!(decoded.pool, address(3));
        Ok(())
    }

    #[test]
    fn rejects_noncanonical_fee_topic_padding() {
        let factory = address(9);
        let mut log = pool_log(address(1), address(2), 3_000, 60, address(3));
        let mut bad_fee = *log.topics()[3].as_bytes();
        bad_fee[0] = 1;
        log = RawLogEnvelope::with_topics(
            factory,
            hash(8),
            0,
            0,
            vec![
                LogTopic::new(uniswap_v3_factory_interface().pool_created_topic),
                address_topic(address(1)),
                address_topic(address(2)),
                LogTopic::new(bad_fee),
            ],
            log.data().to_vec(),
            false,
        )
        .unwrap_or_else(|_| unreachable!());
        assert!(decode_uniswap_v3_pool_created(factory, &log).is_err());
    }

    #[test]
    fn rejects_noncanonical_token_order() {
        let factory = address(9);
        let log = pool_log(address(2), address(1), 3_000, 60, address(3));
        assert!(decode_uniswap_v3_pool_created(factory, &log).is_err());
    }

    #[test]
    fn pool_runtime_requires_flash_and_state_selectors() {
        let mut code = Vec::new();
        for signature in [
            POOL_TOKEN0,
            POOL_TOKEN1,
            POOL_FEE,
            POOL_LIQUIDITY,
            POOL_FLASH,
        ] {
            code.push(0x63);
            code.extend_from_slice(&abi::selector(signature));
        }
        code.push(0x00);
        assert!(verify_uniswap_v3_pool_runtime(&code).is_ok());

        let mut missing_flash = Vec::new();
        for signature in [POOL_TOKEN0, POOL_TOKEN1, POOL_FEE, POOL_LIQUIDITY] {
            missing_flash.push(0x63);
            missing_flash.extend_from_slice(&abi::selector(signature));
        }
        missing_flash.push(0x00);
        assert!(verify_uniswap_v3_pool_runtime(&missing_flash).is_err());
    }

    #[test]
    fn runtime_requires_get_pool_and_pool_created_topic() {
        let interface = uniswap_v3_factory_interface();
        let mut code = Vec::new();
        code.push(0x63);
        code.extend_from_slice(&interface.get_pool);
        code.push(0x7f);
        code.extend_from_slice(&interface.pool_created_topic);
        code.push(0x00);
        assert!(verify_uniswap_v3_factory_runtime(&code).is_ok());
        assert!(verify_uniswap_v3_factory_runtime(&[]).is_err());
    }

    fn digest_hex(byte: u8) -> String {
        format!("{byte:02x}").repeat(32)
    }

    fn reconciliation_anchor_json() -> Json {
        Json::object([
            ("chain_id", Json::uint(1)),
            ("genesis_hash", Json::string(hash(1).to_hex())),
            ("fork_lineage", Json::string(hash(2).to_hex())),
            ("block_number", Json::uint(25_437_474)),
            ("block_hash", Json::string(hash(3).to_hex())),
            ("parent_hash", Json::string(hash(4).to_hex())),
            ("timestamp", Json::uint(1_700_000_000)),
            ("state_root", Json::string(hash(5).to_hex())),
        ])
    }

    fn reconciliation_capture(
        provider: &str,
        operator: &str,
        endpoint_hash: &str,
        balance: &str,
    ) -> Json {
        Json::object([
            ("schema_version", Json::uint(1)),
            ("stage", Json::string("RMC-011")),
            ("family", Json::string("UNISWAP_V3_FLASH")),
            ("provider_id", Json::string(provider.to_owned())),
            ("provider_operator", Json::string(operator.to_owned())),
            ("rpc_endpoint_hash", Json::string(endpoint_hash.to_owned())),
            ("anchor", reconciliation_anchor_json()),
            ("authority_lock_sha256", Json::string(digest_hex(0xa1))),
            ("d08_market_state_sha256", Json::string(digest_hex(0xb1))),
            ("d08_token_admission_sha256", Json::string(digest_hex(0xc1))),
            (
                "d08_evidence_manifest_sha256",
                Json::string(digest_hex(0xd1)),
            ),
            ("deployment_sha256", Json::string(digest_hex(0xe1))),
            (
                "factory",
                Json::object([
                    ("address", Json::string(UNISWAP_V3_FACTORY)),
                    ("runtime_sha256", Json::string(digest_hex(0xf1))),
                ]),
            ),
            (
                "pool_event_history_sha256",
                Json::string(digest_hex(0x61)),
            ),
            ("pool_universe_sha256", Json::string(digest_hex(0x71))),
            (
                "pools",
                Json::array([Json::object([
                    (
                        "pool",
                        Json::string("0x3333333333333333333333333333333333333333"),
                    ),
                    (
                        "token0",
                        Json::string("0x1111111111111111111111111111111111111111"),
                    ),
                    (
                        "token1",
                        Json::string("0x2222222222222222222222222222222222222222"),
                    ),
                    ("fee_pips", Json::uint(3_000)),
                    ("active_liquidity", Json::string("1000000")),
                    ("pool_runtime_sha256", Json::string(digest_hex(0x81))),
                    (
                        "asset_balances",
                        Json::array([Json::object([
                            (
                                "asset",
                                Json::string(
                                    "0x1111111111111111111111111111111111111111",
                                ),
                            ),
                            ("balance", Json::string(balance.to_owned())),
                        ])]),
                    ),
                ])]),
            ),
        ])
    }

    #[test]
    fn dual_provider_reconciliation_emits_exact_flash_source() -> Result<(), Box<dyn Error>> {
        let first =
            reconciliation_capture("provider-a", "operator-a", &digest_hex(0x91), "123456");
        let second =
            reconciliation_capture("provider-b", "operator-b", &digest_hex(0x92), "123456");
        let sources = reconcile_uniswap_v3_captures(&first, &second)?;
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].maximum_available(), Amount256::from_u128(123_456));
        assert!(sources[0].execution_eligible());
        Ok(())
    }

    #[test]
    fn dual_provider_reconciliation_rejects_active_liquidity_mismatch() {
        let first =
            reconciliation_capture("provider-a", "operator-a", &digest_hex(0x91), "123456");
        let mut second =
            reconciliation_capture("provider-b", "operator-b", &digest_hex(0x92), "123456");
        let pools = second
            .get("pools")
            .and_then(Json::as_array)
            .unwrap_or_else(|| unreachable!());
        let pool = pools[0].clone();
        let replacement = Json::object([
            ("pool", pool.get("pool").cloned().unwrap_or(Json::Null)),
            ("token0", pool.get("token0").cloned().unwrap_or(Json::Null)),
            ("token1", pool.get("token1").cloned().unwrap_or(Json::Null)),
            ("fee_pips", pool.get("fee_pips").cloned().unwrap_or(Json::Null)),
            ("active_liquidity", Json::string("999999")),
            (
                "pool_runtime_sha256",
                pool.get("pool_runtime_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "asset_balances",
                pool.get("asset_balances").cloned().unwrap_or(Json::Null),
            ),
        ]);
        second = Json::object([
            ("schema_version", second.get("schema_version").cloned().unwrap_or(Json::Null)),
            ("stage", second.get("stage").cloned().unwrap_or(Json::Null)),
            ("family", second.get("family").cloned().unwrap_or(Json::Null)),
            ("provider_id", second.get("provider_id").cloned().unwrap_or(Json::Null)),
            (
                "provider_operator",
                second.get("provider_operator").cloned().unwrap_or(Json::Null),
            ),
            (
                "rpc_endpoint_hash",
                second.get("rpc_endpoint_hash").cloned().unwrap_or(Json::Null),
            ),
            ("anchor", second.get("anchor").cloned().unwrap_or(Json::Null)),
            (
                "authority_lock_sha256",
                second.get("authority_lock_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "d08_market_state_sha256",
                second.get("d08_market_state_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "d08_token_admission_sha256",
                second.get("d08_token_admission_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "d08_evidence_manifest_sha256",
                second.get("d08_evidence_manifest_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "deployment_sha256",
                second.get("deployment_sha256").cloned().unwrap_or(Json::Null),
            ),
            ("factory", second.get("factory").cloned().unwrap_or(Json::Null)),
            (
                "pool_event_history_sha256",
                second.get("pool_event_history_sha256").cloned().unwrap_or(Json::Null),
            ),
            (
                "pool_universe_sha256",
                second.get("pool_universe_sha256").cloned().unwrap_or(Json::Null),
            ),
            ("pools", Json::array([replacement])),
        ]);
        assert!(reconcile_uniswap_v3_captures(&first, &second).is_err());
    }

    #[test]
    fn dual_provider_reconciliation_rejects_balance_mismatch() {
        let first =
            reconciliation_capture("provider-a", "operator-a", &digest_hex(0x91), "123456");
        let second =
            reconciliation_capture("provider-b", "operator-b", &digest_hex(0x92), "123455");
        assert!(reconcile_uniswap_v3_captures(&first, &second).is_err());
    }

    #[test]
    fn uniswap_v3_reconciliation_artifact_roundtrips_authority(
    ) -> Result<(), Box<dyn Error>> {
        let first =
            reconciliation_capture("provider-a", "operator-a", &digest_hex(0x91), "123456")
                .canonical()?;
        let second =
            reconciliation_capture("provider-b", "operator-b", &digest_hex(0x92), "123456")
                .canonical()?;
        let artifact = build_uniswap_v3_reconciliation_artifact(&first, &second)?;
        let (authority, sources) =
            source_authority_from_uniswap_v3_reconcile_artifact(&artifact)?;
        assert_eq!(authority.family().code(), "UNISWAP_V3_FLASH");
        assert_eq!(authority.source_count(), 1);
        assert_eq!(sources.len(), 1);
        Ok(())
    }

    #[test]
    fn uniswap_v3_reconciliation_rejects_same_operator() {
        let first =
            reconciliation_capture("provider-a", "same-operator", &digest_hex(0x91), "123456");
        let second =
            reconciliation_capture("provider-b", "same-operator", &digest_hex(0x92), "123456");
        assert!(reconcile_uniswap_v3_captures(&first, &second).is_err());
    }

}
