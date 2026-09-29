use crate::{decode_pair_created, factory_interface};
use nqc_census_chain::{
    acquire::{anchor_from_result, raw_log_semantics, Acquisition},
    bootstrap::run_bootstrap,
    ethereum::ChainProfile,
    hex,
    job::LogFilter,
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, CensusObservation, Hash32, ObservationClass, RawLogEnvelope, StateAnchor,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, error::Error, fs, path::Path};

const ANCHOR_NUMBER: u64 = 25_437_474;
const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const HISTORY_PROVIDER: &str = "mevblocker-rpc";
const HISTORY_NAMESPACE: u16 = 0x0703;
const CHECKPOINT_SPAN: u64 = 1_000_000;

fn number(value: &Json, key: &str) -> Result<u64, ChainError> {
    value
        .get(key)
        .and_then(Json::as_i64)
        .and_then(|number| u64::try_from(number).ok())
        .ok_or_else(|| ChainError::Evidence(format!("missing numeric field {key}")))
}

fn selected_provider<'a>(
    providers: &'a ProviderSet,
    label: &str,
) -> Result<&'a ProviderSpec, ChainError> {
    providers
        .iter()
        .find(|provider| provider.label() == label)
        .ok_or_else(|| ChainError::Config(format!("required provider {label} is not declared")))
}

fn event_record(observation: &CensusObservation<RawLogEnvelope>) -> Result<Json, ChainError> {
    let decoded = decode_pair_created(Address::parse_hex(FACTORY)?, observation.payload())
        .map_err(|error| ChainError::Evidence(error.to_string()))?;
    let anchor = observation.envelope().anchor();
    Ok(Json::object([
        ("ordinal", Json::uint(decoded.ordinal)),
        ("block_number", Json::uint(anchor.block_number())),
        ("block_hash", Json::string(anchor.block_hash().to_hex())),
        (
            "transaction_hash",
            Json::string(observation.payload().transaction_hash().to_hex()),
        ),
        (
            "transaction_index",
            Json::uint(u64::from(observation.payload().transaction_index())),
        ),
        (
            "log_index",
            Json::uint(u64::from(observation.payload().log_index())),
        ),
        ("token0", Json::string(decoded.token0.to_hex())),
        ("token1", Json::string(decoded.token1.to_hex())),
        ("pair", Json::string(decoded.pair.to_hex())),
        (
            "observation",
            Json::string(observation.envelope().digest().to_hex()),
        ),
    ]))
}

fn update_history_digest(hasher: &mut Sha256, record: &Json) -> Result<(), ChainError> {
    let bytes = record.canonical()?;
    let length = u64::try_from(bytes.len())
        .map_err(|_| ChainError::Evidence("event record length overflow".into()))?;
    hasher.update(length.to_be_bytes());
    hasher.update(bytes);
    Ok(())
}

fn validate_history(
    outcome: &nqc_census_chain::acquire::ScanOutcome,
    expected_count: u64,
) -> Result<Json, ChainError> {
    let mut count = 0_u64;
    let mut pairs = BTreeSet::new();
    let mut token_pairs = BTreeSet::new();
    let mut digest = Sha256::new();
    digest.update(b"NQC-RMC007-V2-PAIR-CREATED-HISTORY-V1");
    digest.update([0]);
    let mut first = None;
    let mut last = None;

    for window in &outcome.windows {
        for bytes in &window.observations {
            if nqc_census_core::peek_observation_class(bytes)? != ObservationClass::Log {
                continue;
            }
            let observation = CensusObservation::<RawLogEnvelope>::decode_canonical(bytes)?;
            if observation.payload().removed() {
                return Err(ChainError::Evidence(
                    "canonical PairCreated history contains removed log".into(),
                ));
            }
            let record = event_record(&observation)?;
            count = count
                .checked_add(1)
                .ok_or_else(|| ChainError::Evidence("PairCreated count overflow".into()))?;
            let ordinal = number(&record, "ordinal")?;
            if ordinal != count {
                return Err(ChainError::Evidence(format!(
                    "PairCreated ordinal gap or reorder: expected {count}, observed {ordinal}"
                )));
            }
            let pair = Address::parse_hex(record.str_field("pair")?)?;
            let token0 = Address::parse_hex(record.str_field("token0")?)?;
            let token1 = Address::parse_hex(record.str_field("token1")?)?;
            if !pairs.insert(pair) {
                return Err(ChainError::Evidence(
                    "duplicate pair address in PairCreated history".into(),
                ));
            }
            if !token_pairs.insert((token0, token1)) {
                return Err(ChainError::Evidence(
                    "duplicate token pair in PairCreated history".into(),
                ));
            }
            update_history_digest(&mut digest, &record)?;
            if first.is_none() {
                first = Some(record.clone());
            }
            last = Some(record);
        }
    }

    if count != expected_count {
        return Err(ChainError::Evidence(format!(
            "PairCreated history count {count} differs from allPairsLength {expected_count}"
        )));
    }
    if count == 0 {
        return Err(ChainError::Evidence(
            "PairCreated history unexpectedly empty".into(),
        ));
    }

    Ok(Json::object([
        ("event_count", Json::uint(count)),
        ("expected_current_count", Json::uint(expected_count)),
        ("ordinal_first", Json::uint(1)),
        ("ordinal_last", Json::uint(count)),
        ("unique_pair_count", Json::uint(pairs.len() as u64)),
        (
            "unique_token_pair_count",
            Json::uint(token_pairs.len() as u64),
        ),
        (
            "history_sha256",
            Json::string(hex::plain(&digest.finalize())),
        ),
        (
            "first_event",
            first.ok_or_else(|| ChainError::Evidence("missing first event".into()))?,
        ),
        (
            "last_event",
            last.ok_or_else(|| ChainError::Evidence("missing last event".into()))?,
        ),
    ]))
}

pub fn run_pair_history(
    providers_path: &Path,
    current_path: &Path,
    boundary_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let current = Json::parse(&fs::read(current_path)?)?;
    let boundary = Json::parse(&fs::read(boundary_path)?)?;
    let expected_count = number(
        current.get("facts").ok_or("current facts missing")?,
        "pair_count",
    )?;
    let first_code_block = number(&boundary, "first_code_block")?;
    if first_code_block == 0 || first_code_block > ANCHOR_NUMBER {
        return Err(ChainError::Evidence("invalid V2 factory boundary".into()).into());
    }

    let store = Store::open(store_path, &StoreConfig::standard())?;
    let transport = CurlTransport::new(90, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(&acquisition, &providers, &profile, ANCHOR_NUMBER)?;
    if anchor.block_number() != ANCHOR_NUMBER {
        return Err(ChainError::Evidence("D07 history anchor differs".into()).into());
    }

    let proof = boundary
        .get("proof")
        .ok_or_else(|| ChainError::Evidence("boundary proof missing".into()))?;
    let boundary_record = proof
        .get("boundary")
        .ok_or_else(|| ChainError::Evidence("boundary record missing".into()))?;
    let origin: StateAnchor = anchor_from_result(&chain, boundary_record, "anchor")?;
    if origin.block_number() != first_code_block {
        return Err(ChainError::Evidence("boundary anchor number differs".into()).into());
    }

    let factory = Address::parse_hex(FACTORY)?;
    let interface = factory_interface();
    let filter = LogFilter::new(vec![factory], vec![interface.pair_created_topic])?;
    let provider = selected_provider(&providers, HISTORY_PROVIDER)?;
    let scan = acquisition.scan(
        provider,
        &chain,
        None,
        "rmc007-v2-pair-created-history",
        1,
        HISTORY_NAMESPACE,
        &filter,
        &origin,
        ANCHOR_NUMBER,
        CHECKPOINT_SPAN,
        |_| raw_log_semantics(&factory, "rmc007-v2-pair-created-history"),
    )?;
    let summary = validate_history(&scan, expected_count)?;

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-007-v2-pair-created-history-v1"),
        ),
        ("status", Json::string("PAIR_CREATED_HISTORY_PASS")),
        ("bootstrap", bootstrap),
        ("factory", Json::string(factory.to_hex())),
        ("provider", Json::string(provider.label().to_owned())),
        ("first_block", Json::uint(scan.certified_first)),
        ("last_block", Json::uint(scan.certified_last)),
        ("checkpoint_span", Json::uint(CHECKPOINT_SPAN)),
        ("range_commitment", Json::string(scan.commitment)),
        ("summary", summary),
        (
            "non_claims",
            Json::array([
                Json::string("FULL_ALLPAIRS_ENUMERATION_NOT_YET_CERTIFIED"),
                Json::string("FULL_GETPAIR_MEMBERSHIP_NOT_YET_CERTIFIED"),
                Json::string("FULL_PAIR_RUNTIME_NOT_YET_CERTIFIED"),
                Json::string("RMC007_NOT_YET_PASS"),
            ]),
        ),
    ]))
}
