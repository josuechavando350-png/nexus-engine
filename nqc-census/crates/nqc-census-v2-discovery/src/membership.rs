use crate::{decode_pair_created, factory_interface};
use nqc_census_chain::{
    abi,
    acquire::{anchor_from_result, raw_log_semantics, Acquisition},
    bootstrap::run_bootstrap,
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec, LogFilter},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{
    Address, CallOutcome, CensusObservation, ContractCallEnvelope, ObservationClass,
    RawLogEnvelope, StateAnchor,
};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{error::Error, fs, path::Path};

const ANCHOR_NUMBER: u64 = 25_437_474;
const ANCHOR_HASH: &str =
    "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const HISTORY_PROVIDER: &str = "mevblocker-rpc";
const MEMBERSHIP_PROVIDER: &str = "blastapi-public";
const HISTORY_NAMESPACE: u16 = 0x0703;
const MEMBERSHIP_NAMESPACE: u16 = 0x0705;
const HISTORY_CHECKPOINT_SPAN: u64 = 1_000_000;
const MEMBERSHIP_PARTITION_SIZE: usize = 5_000;

#[derive(Debug, Clone, Copy)]
struct Identity {
    ordinal: u64,
    pair: Address,
    token0: Address,
    token1: Address,
}

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

fn returned(
    observation: &CensusObservation<ContractCallEnvelope>,
) -> Result<&[u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(
            "required V2 membership call reverted".into(),
        )),
    }
}

fn required_address(bytes: &[u8], label: &'static str) -> Result<Address, ChainError> {
    let word = abi::single_word(bytes)?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence(format!("{label} returned zero address")))?;
    Ok(Address::new(raw)?)
}

fn expected_count(
    current: &Json,
    history: &Json,
    enumeration: &Json,
) -> Result<u64, ChainError> {
    if current.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS")
        || history.get("status").and_then(Json::as_str) != Some("PAIR_CREATED_HISTORY_PASS")
        || enumeration.get("status").and_then(Json::as_str)
            != Some("FULL_ALLPAIRS_ENUMERATION_PASS")
    {
        return Err(ChainError::Evidence(
            "D07 prerequisite report is not PASS".into(),
        ));
    }
    let current_count = number(
        current
            .get("facts")
            .ok_or_else(|| ChainError::Evidence("current facts missing".into()))?,
        "pair_count",
    )?;
    let history_count = number(
        history
            .get("summary")
            .ok_or_else(|| ChainError::Evidence("history summary missing".into()))?,
        "event_count",
    )?;
    let enumeration_count = number(enumeration, "pair_count")?;
    if current_count != history_count || current_count != enumeration_count {
        return Err(ChainError::Evidence(
            "D07 prerequisite pair counts disagree".into(),
        ));
    }
    Ok(current_count)
}

fn history_origin(
    boundary: &Json,
    chain: &nqc_census_core::ChainDomain,
) -> Result<StateAnchor, ChainError> {
    if boundary.get("status").and_then(Json::as_str) != Some("FACTORY_BOUNDARY_PASS") {
        return Err(ChainError::Evidence(
            "factory boundary report is not PASS".into(),
        ));
    }
    let proof = boundary
        .get("proof")
        .ok_or_else(|| ChainError::Evidence("boundary proof missing".into()))?;
    let boundary_record = proof
        .get("boundary")
        .ok_or_else(|| ChainError::Evidence("boundary record missing".into()))?;
    anchor_from_result(chain, boundary_record, "anchor")
}

fn load_identities(
    acquisition: &Acquisition<'_>,
    providers: &ProviderSet,
    chain: &nqc_census_core::ChainDomain,
    origin: &StateAnchor,
    expected: u64,
) -> Result<Vec<Identity>, ChainError> {
    let factory = Address::parse_hex(FACTORY)?;
    let interface = factory_interface();
    let filter = LogFilter::new(vec![factory], vec![interface.pair_created_topic])?;
    let provider = selected_provider(providers, HISTORY_PROVIDER)?;
    let scan = acquisition.scan(
        provider,
        chain,
        None,
        "rmc007-v2-pair-created-history",
        1,
        HISTORY_NAMESPACE,
        &filter,
        origin,
        ANCHOR_NUMBER,
        HISTORY_CHECKPOINT_SPAN,
        |_| raw_log_semantics(&factory, "rmc007-v2-pair-created-history"),
    )?;
    let mut identities = Vec::with_capacity(
        usize::try_from(expected)
            .map_err(|_| ChainError::Evidence("pair count exceeds usize".into()))?,
    );
    for window in &scan.windows {
        for bytes in &window.observations {
            if nqc_census_core::peek_observation_class(bytes)? != ObservationClass::Log {
                continue;
            }
            let observation = CensusObservation::<RawLogEnvelope>::decode_canonical(bytes)?;
            let decoded = decode_pair_created(factory, observation.payload())
                .map_err(|error| ChainError::Evidence(error.to_string()))?;
            let ordinal = u64::try_from(identities.len())
                .map_err(|_| ChainError::Evidence("identity count exceeds u64".into()))?
                .checked_add(1)
                .ok_or_else(|| ChainError::Evidence("identity ordinal overflow".into()))?;
            if decoded.ordinal != ordinal {
                return Err(ChainError::Evidence(format!(
                    "history replay ordinal differs: expected {ordinal}, got {}",
                    decoded.ordinal
                )));
            }
            identities.push(Identity {
                ordinal,
                pair: decoded.pair,
                token0: decoded.token0,
                token1: decoded.token1,
            });
        }
    }
    if u64::try_from(identities.len())
        .map_err(|_| ChainError::Evidence("identity count exceeds u64".into()))?
        != expected
    {
        return Err(ChainError::Evidence(
            "history replay identity count differs from prerequisites".into(),
        ));
    }
    Ok(identities)
}

pub fn run_membership(
    providers_path: &Path,
    current_path: &Path,
    boundary_path: &Path,
    history_path: &Path,
    enumeration_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let current = Json::parse(&fs::read(current_path)?)?;
    let boundary = Json::parse(&fs::read(boundary_path)?)?;
    let history = Json::parse(&fs::read(history_path)?)?;
    let enumeration = Json::parse(&fs::read(enumeration_path)?)?;
    let expected = expected_count(&current, &history, &enumeration)?;

    let store = Store::open(store_path, &StoreConfig::standard())?;
    let transport = CurlTransport::new(90, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(&acquisition, &providers, &profile, ANCHOR_NUMBER)?;
    if anchor.block_hash().to_hex() != ANCHOR_HASH {
        return Err(ChainError::Evidence("D07 membership anchor hash differs".into()).into());
    }
    let origin = history_origin(&boundary, &chain)?;
    let identities = load_identities(&acquisition, &providers, &chain, &origin, expected)?;
    let provider = selected_provider(&providers, MEMBERSHIP_PROVIDER)?;
    let factory = Address::parse_hex(FACTORY)?;
    let interface = factory_interface();
    let semantics = chain_read_semantics()?;

    let mut manifests = Vec::new();
    let mut checked = 0_u64;
    let mut runtime_commitment = Sha256::new();
    runtime_commitment.update(b"NQC-RMC007-V2-RUNTIME-SEQUENCE-V1");
    runtime_commitment.update([0]);

    for partition in identities.chunks(MEMBERSHIP_PARTITION_SIZE) {
        let first_ordinal = partition
            .first()
            .ok_or_else(|| ChainError::Evidence("empty membership partition".into()))?
            .ordinal;
        let last_ordinal = partition
            .last()
            .ok_or_else(|| ChainError::Evidence("empty membership partition".into()))?
            .ordinal;
        let spec = JobSpec::new(
            "rmc007-v2-direct-membership-runtime",
            1,
            MEMBERSHIP_NAMESPACE,
            Json::object([
                ("factory", Json::string(factory.to_hex())),
                ("first_ordinal", Json::uint(first_ordinal)),
                ("last_ordinal", Json::uint(last_ordinal)),
                ("anchor", Json::uint(ANCHOR_NUMBER)),
            ]),
        )?;
        let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
            let lookup_requests = partition
                .iter()
                .map(|identity| {
                    (
                        factory,
                        abi::encode_call(
                            interface.get_pair,
                            &[
                                abi::address_word(identity.token0.as_bytes()),
                                abi::address_word(identity.token1.as_bytes()),
                            ],
                        ),
                    )
                })
                .collect::<Vec<_>>();
            let lookups = ctx.calls(&lookup_requests, &anchor, semantics)?;
            if lookups.len() != partition.len() {
                return Err(ChainError::Evidence(
                    "getPair response count differs from partition".into(),
                ));
            }
            for (identity, lookup) in partition.iter().zip(&lookups) {
                let returned_pair = required_address(returned(lookup)?, "getPair")?;
                if returned_pair != identity.pair {
                    return Err(ChainError::Evidence(format!(
                        "getPair mismatch at ordinal {}",
                        identity.ordinal
                    )));
                }
            }

            let pairs = partition
                .iter()
                .map(|identity| identity.pair)
                .collect::<Vec<_>>();
            let codes = ctx.codes(&pairs, &anchor, semantics)?;
            if codes.len() != partition.len() {
                return Err(ChainError::Evidence(
                    "runtime code response count differs from partition".into(),
                ));
            }
            let mut digest = Sha256::new();
            digest.update(b"NQC-RMC007-V2-RUNTIME-PARTITION-V1");
            digest.update([0]);
            for (identity, code) in partition.iter().zip(&codes) {
                if code.payload().is_absent() {
                    return Err(ChainError::Evidence(format!(
                        "pair runtime absent at ordinal {}",
                        identity.ordinal
                    )));
                }
                let code_hash = Sha256::digest(code.payload().code());
                digest.update(identity.ordinal.to_be_bytes());
                digest.update(identity.pair.as_bytes());
                digest.update(code_hash);
            }
            Ok(Json::object([
                ("first_ordinal", Json::uint(first_ordinal)),
                ("last_ordinal", Json::uint(last_ordinal)),
                (
                    "checked_count",
                    Json::uint(
                        u64::try_from(partition.len())
                            .map_err(|_| ChainError::Evidence("partition count overflow".into()))?,
                    ),
                ),
                (
                    "runtime_partition_sha256",
                    Json::string(hex::plain(&digest.finalize())),
                ),
            ]))
        })?;
        let result = output.result_json()?;
        let partition_count = number(&result, "checked_count")?;
        checked = checked
            .checked_add(partition_count)
            .ok_or_else(|| ChainError::Evidence("membership count overflow".into()))?;
        runtime_commitment.update(first_ordinal.to_be_bytes());
        runtime_commitment.update(last_ordinal.to_be_bytes());
        runtime_commitment.update(hex::decode_fixed::<32>(
            result.str_field("runtime_partition_sha256")?,
        )?);
        manifests.push(Json::object([
            ("first_ordinal", Json::uint(first_ordinal)),
            ("last_ordinal", Json::uint(last_ordinal)),
            ("checked_count", Json::uint(partition_count)),
            ("manifest", Json::string(output.manifest_id().to_hex())),
        ]));
    }

    if checked != expected {
        return Err(ChainError::Evidence(format!(
            "membership checked {checked} pairs, expected {expected}"
        ))
        .into());
    }

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-007-v2-membership-runtime-v1"),
        ),
        ("status", Json::string("DIRECT_MEMBERSHIP_RUNTIME_PASS")),
        ("bootstrap", bootstrap),
        ("provider", Json::string(provider.label().to_owned())),
        ("factory", Json::string(factory.to_hex())),
        ("pair_count", Json::uint(expected)),
        ("get_pair_verified_count", Json::uint(checked)),
        ("runtime_code_verified_count", Json::uint(checked)),
        (
            "partition_count",
            Json::uint(manifests.len() as u64),
        ),
        (
            "runtime_sequence_commitment",
            Json::string(hex::plain(&runtime_commitment.finalize())),
        ),
        ("partition_manifests", Json::Array(manifests)),
        ("unexplained_delta_count", Json::uint(0)),
        (
            "reconciliation",
            Json::object([
                ("source_A_current_enumeration", Json::uint(expected)),
                ("source_B_paircreated_history", Json::uint(expected)),
                ("source_C_direct_getpair", Json::uint(expected)),
                ("runtime_code_present", Json::uint(expected)),
                ("intersection_count", Json::uint(expected)),
            ]),
        ),
        (
            "non_claims",
            Json::array([
                Json::string("D05_ADMISSION_NOT_YET_MATERIALIZED"),
                Json::string("RMC007_NOT_YET_PASS"),
                Json::string("ECONOMICS_NOT_TESTED"),
            ]),
        ),
    ]))
}
