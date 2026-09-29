use crate::factory_interface;
use nqc_census_chain::{
    abi,
    acquire::Acquisition,
    bootstrap::run_bootstrap,
    ethereum::ChainProfile,
    hex,
    job::{chain_read_semantics, JobSpec},
    json::Json,
    provider::{ProviderSet, ProviderSpec},
    transport::{CurlTransport, RetryPolicy},
    ChainError,
};
use nqc_census_core::{Address, CallOutcome, CensusObservation, ContractCallEnvelope};
use nqc_census_store::{Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, error::Error, fs, path::Path};

const ANCHOR_NUMBER: u64 = 25_437_474;
const ANCHOR_HASH: &str = "0x0712ee92e6c2e2359c792e7aadc5bc35b9db392a2a5dc02f4575096437e8bfc8";
const FACTORY: &str = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const ENUMERATION_PROVIDER: &str = "blastapi-public";
const ENUMERATION_NAMESPACE: u16 = 0x0704;
const PARTITION_SIZE: u64 = 10_000;

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

fn returned(observation: &CensusObservation<ContractCallEnvelope>) -> Result<&[u8], ChainError> {
    match observation.payload().outcome() {
        CallOutcome::Returned(bytes) => Ok(bytes),
        CallOutcome::Reverted(_) => Err(ChainError::Evidence(
            "required allPairs call reverted".into(),
        )),
    }
}

fn decode_pair(bytes: &[u8]) -> Result<Address, ChainError> {
    let word = abi::single_word(bytes)?;
    let raw = abi::decode_address(&word)?
        .ok_or_else(|| ChainError::Evidence("allPairs returned zero address".into()))?;
    Ok(Address::new(raw)?)
}

fn current_expectations(report: &Json) -> Result<(u64, Address, Address), ChainError> {
    if report.get("status").and_then(Json::as_str) != Some("CURRENT_SURFACE_PASS") {
        return Err(ChainError::Evidence(
            "current V2 surface is not PASS".into(),
        ));
    }
    let facts = report
        .get("facts")
        .ok_or_else(|| ChainError::Evidence("current V2 facts missing".into()))?;
    if facts.str_field("factory")? != FACTORY {
        return Err(ChainError::Evidence(
            "current report uses another V2 factory".into(),
        ));
    }
    let count = number(facts, "pair_count")?;
    let first = Address::parse_hex(
        facts
            .get("first_pair")
            .ok_or_else(|| ChainError::Evidence("first pair facts missing".into()))?
            .str_field("pair")?,
    )?;
    let last = Address::parse_hex(
        facts
            .get("last_pair")
            .ok_or_else(|| ChainError::Evidence("last pair facts missing".into()))?
            .str_field("pair")?,
    )?;
    Ok((count, first, last))
}

pub fn run_enumeration(
    providers_path: &Path,
    current_path: &Path,
    store_path: &Path,
) -> Result<Json, Box<dyn Error>> {
    let providers = ProviderSet::parse(&fs::read(providers_path)?)?;
    let current = Json::parse(&fs::read(current_path)?)?;
    let (expected_count, expected_first, expected_last) = current_expectations(&current)?;
    if expected_count == 0 {
        return Err(ChainError::Evidence("allPairsLength is zero".into()).into());
    }

    let store = Store::open(store_path, &StoreConfig::standard())?;
    let transport = CurlTransport::new(90, 10);
    let acquisition = Acquisition::new(&store, &transport, RetryPolicy::standard());
    let profile = ChainProfile::mainnet()?;
    let (bootstrap, chain, anchor) =
        run_bootstrap(&acquisition, &providers, &profile, ANCHOR_NUMBER)?;
    if anchor.block_hash().to_hex() != ANCHOR_HASH {
        return Err(ChainError::Evidence("D07 enumeration anchor hash differs".into()).into());
    }

    let provider = selected_provider(&providers, ENUMERATION_PROVIDER)?;
    let factory = Address::parse_hex(FACTORY)?;
    let interface = factory_interface();
    let semantics = chain_read_semantics()?;
    let mut sequence = Sha256::new();
    sequence.update(b"NQC-RMC007-V2-ALLPAIRS-SEQUENCE-V1");
    sequence.update([0]);
    let mut unique = BTreeSet::new();
    let mut first_pair = None;
    let mut last_pair = None;
    let mut manifests = Vec::new();

    let mut first_index = 0_u64;
    while first_index < expected_count {
        let last_index = first_index
            .saturating_add(PARTITION_SIZE - 1)
            .min(expected_count - 1);
        let spec = JobSpec::new(
            "rmc007-v2-full-allpairs-enumeration",
            1,
            ENUMERATION_NAMESPACE,
            Json::object([
                ("factory", Json::string(factory.to_hex())),
                ("first_index", Json::uint(first_index)),
                ("last_index", Json::uint(last_index)),
                ("anchor", Json::uint(ANCHOR_NUMBER)),
            ]),
        )?;
        let output = acquisition.point(provider, &chain, None, &spec, &anchor, |ctx| {
            let requests = (first_index..=last_index)
                .map(|index| {
                    (
                        factory,
                        abi::encode_call(interface.all_pairs, &[abi::uint_word(index)]),
                    )
                })
                .collect::<Vec<_>>();
            let observations = ctx.calls(&requests, &anchor, semantics)?;
            if observations.len() != requests.len() {
                return Err(ChainError::Evidence(
                    "allPairs partition response count differs".into(),
                ));
            }
            let pairs = observations
                .iter()
                .map(|observation| {
                    decode_pair(returned(observation)?).map(|pair| Json::string(pair.to_hex()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Json::object([
                ("first_index", Json::uint(first_index)),
                ("last_index", Json::uint(last_index)),
                ("pairs", Json::Array(pairs)),
            ]))
        })?;
        let manifest = output.manifest_id().to_hex();
        let result = output.result_json()?;
        let pairs = result
            .get("pairs")
            .and_then(Json::as_array)
            .ok_or_else(|| ChainError::Evidence("enumeration partition lacks pairs".into()))?;
        let expected_partition = usize::try_from(last_index - first_index + 1)
            .map_err(|_| ChainError::Evidence("enumeration partition length overflow".into()))?;
        if pairs.len() != expected_partition {
            return Err(
                ChainError::Evidence("enumeration partition has wrong pair count".into()).into(),
            );
        }
        for (offset, pair_value) in pairs.iter().enumerate() {
            let offset = u64::try_from(offset)
                .map_err(|_| ChainError::Evidence("enumeration offset overflow".into()))?;
            let index = first_index
                .checked_add(offset)
                .ok_or_else(|| ChainError::Evidence("enumeration index overflow".into()))?;
            let pair = Address::parse_hex(
                pair_value
                    .as_str()
                    .ok_or_else(|| ChainError::Evidence("enumerated pair is not hex".into()))?,
            )?;
            if !unique.insert(pair) {
                return Err(ChainError::Evidence(format!(
                    "duplicate allPairs address {}",
                    pair.to_hex()
                ))
                .into());
            }
            if first_pair.is_none() {
                first_pair = Some(pair);
            }
            last_pair = Some(pair);
            sequence.update(index.to_be_bytes());
            sequence.update(pair.as_bytes());
        }
        manifests.push(Json::object([
            ("first_index", Json::uint(first_index)),
            ("last_index", Json::uint(last_index)),
            ("manifest", Json::string(manifest)),
        ]));
        first_index = last_index + 1;
    }

    let observed_count = u64::try_from(unique.len())
        .map_err(|_| ChainError::Evidence("enumerated pair count exceeds u64".into()))?;
    if observed_count != expected_count {
        return Err(ChainError::Evidence(format!(
            "full allPairs enumeration count {observed_count} differs from {expected_count}"
        ))
        .into());
    }
    if first_pair != Some(expected_first) || last_pair != Some(expected_last) {
        return Err(ChainError::Evidence(
            "full allPairs endpoints differ from exact-anchor current surface".into(),
        )
        .into());
    }

    Ok(Json::object([
        (
            "schema",
            Json::string("nqc-rmc-007-v2-full-allpairs-enumeration-v1"),
        ),
        ("status", Json::string("FULL_ALLPAIRS_ENUMERATION_PASS")),
        ("bootstrap", bootstrap),
        ("provider", Json::string(provider.label().to_owned())),
        ("factory", Json::string(factory.to_hex())),
        ("pair_count", Json::uint(observed_count)),
        ("partition_size", Json::uint(PARTITION_SIZE)),
        ("partition_count", Json::uint(manifests.len() as u64)),
        ("first_pair", Json::string(expected_first.to_hex())),
        ("last_pair", Json::string(expected_last.to_hex())),
        (
            "pair_sequence_sha256",
            Json::string(hex::plain(&sequence.finalize())),
        ),
        ("partition_manifests", Json::Array(manifests)),
        ("unexplained_delta_count", Json::uint(0)),
        (
            "non_claims",
            Json::array([
                Json::string("DIRECT_GETPAIR_ALL_MARKETS_NOT_YET_CERTIFIED"),
                Json::string("ALL_PAIR_RUNTIME_CODE_NOT_YET_CERTIFIED"),
                Json::string("RMC007_NOT_YET_PASS"),
            ]),
        ),
    ]))
}
