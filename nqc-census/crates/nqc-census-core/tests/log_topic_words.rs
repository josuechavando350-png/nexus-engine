//! RMC-003.2: a log topic is a 32-byte ABI word that may be zero, while every
//! hash field keeps its nonzero invariant.

use nqc_census_core::{
    keccak256, peek_observation_class, Address, BlockHeaderEnvelope, CensusObservation,
    ChainDomain, Hash32, HeaderEncoding, IdentityError, LogTopic, ObservationClass,
    ObservationError, ObservationPayload, ObservationProvenance, ObservationSemantics,
    ProvenanceAuthority, RawLogEnvelope, StateAnchor,
};
use sha2::{Digest, Sha256};
use std::error::Error;

type TestResult = Result<(), Box<dyn Error>>;

// Produced independently by ci/nqc-census/log_topic_word_vectors.py and pinned
// in ci/nqc-census/log-topic-word-vectors.json:
// (name, raw payload digest, observation digest, sha256(canonical), length)
const ZERO_TOPIC_VECTORS: [(&str, &str, &str, &str, usize); 2] = [
    (
        "zero_indexed_address_topic",
        "2b345ee7c582795ee4263d5ff37c344f452eaebeec676cebdff22528d342920f",
        "f9ad71fb839176574104d91157c3931aa19350efc9b9b30d8f58044c5458bde4",
        "5da82561bfc0281d8810a28938e15ea2ab9a3bf987a73c38c19a49b3b6de7d97",
        652,
    ),
    (
        "all_zero_topics",
        "9557954e4a3dd132f5bc05ca431460a0bab9a765405cf7406a80551e32cc1831",
        "45a1b022f6a79e8457993eba0790a4b62d84652a275c823cadda918641ad96e2",
        "775fd5a2625ffd8a8ecfe4b11ec2513ef09d2935c60d38de996a48c4b9d5b2b0",
        652,
    ),
];

// The RMC-003.1 shared LOG vector (nonzero topics) is unchanged.
const RMC003_1_LOG: (&str, &str, &str) = (
    "ed832136a26d365f36e5f18285420beb5f92a2cd201d0e01308199b666540b62",
    "222eac573e598bb40cab0533d73a046a94bb21f9057b47d8d192bdc257addd17",
    "13373365a30944e98edcd3ccde01c9b13b5d82b2748fc11ae97c4191fed62cba",
);

// RMC-003 legacy RawLog digest ("two_topics_data"), unchanged.
const LEGACY_TWO_TOPICS: (&str, &str) = (
    "e3c859d9a38f61c9ed278c5d016115294f12ef5157d1e6535e7d23aeb3b9ce20",
    "39584a5dad7db7ec899192ec2396bd07ff37a92a3aea78686dceda5e56ece56a",
);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn hash(byte: u8) -> Result<Hash32, Box<dyn Error>> {
    Ok(Hash32::new([byte; 32])?)
}

fn address(byte: u8) -> Result<Address, Box<dyn Error>> {
    Ok(Address::new([byte; 20])?)
}

fn address_word(byte: u8) -> LogTopic {
    let mut word = [0_u8; 32];
    word[12..].copy_from_slice(&[byte; 20]);
    LogTopic::new(word)
}

fn chain() -> Result<ChainDomain, Box<dyn Error>> {
    Ok(ChainDomain::new(1, hash(0x11)?, hash(0x22)?)?)
}

fn semantics() -> Result<ObservationSemantics, Box<dyn Error>> {
    Ok(ObservationSemantics::new(hash(0xc0)?, hash(0xc1)?))
}

fn provenance(authority: ProvenanceAuthority) -> Result<ObservationProvenance, Box<dyn Error>> {
    Ok(ObservationProvenance::new(
        authority,
        1,
        hash(0x31)?,
        hash(0x32)?,
        hash(0x33)?,
    )?)
}

fn shared_bytes() -> Vec<u8> {
    (0xe0..=0xff).collect()
}

fn rlp_string(value: &[u8]) -> Vec<u8> {
    if value.len() == 1 && value[0] < 0x80 {
        return value.to_vec();
    }
    let mut out = rlp_prefix(0x80, 0xb7, value.len());
    out.extend_from_slice(value);
    out
}

fn rlp_prefix(short: u8, long: u8, length: usize) -> Vec<u8> {
    if length <= 55 {
        return vec![short + length as u8];
    }
    let bytes = length.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(7);
    let mut out = vec![long + (8 - first) as u8];
    out.extend_from_slice(&bytes[first..]);
    out
}

fn uint(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(8);
    bytes[first..].to_vec()
}

/// The RMC-003.1 synthetic Prague header, so the anchor is the one the
/// independent Python encoder uses.
fn header() -> Result<BlockHeaderEnvelope, Box<dyn Error>> {
    let mut bloom = vec![0_u8; 256];
    bloom[255] = 1;
    let fields = [
        vec![0xa0; 32],
        vec![0x1d; 32],
        vec![0xbe; 20],
        vec![0x5a; 32],
        vec![0x7a; 32],
        vec![0x8a; 32],
        bloom,
        uint(0),
        uint(19_000_000),
        uint(30_000_000),
        uint(12_345_678),
        uint(1_700_000_000),
        shared_bytes(),
        vec![0x3c; 32],
        vec![0; 8],
        uint(7),
        vec![0x9a; 32],
        uint(131_072),
        uint(0),
        vec![0x4b; 32],
        vec![0x6c; 32],
    ];
    let payload: Vec<u8> = fields.iter().flat_map(|field| rlp_string(field)).collect();
    let mut encoded = rlp_prefix(0xc0, 0xf7, payload.len());
    encoded.extend_from_slice(&payload);
    let claimed = Hash32::new(keccak256(&encoded))?;
    Ok(BlockHeaderEnvelope::new(
        HeaderEncoding::EthereumRlp,
        claimed,
        encoded,
    )?)
}

fn anchor() -> Result<StateAnchor, Box<dyn Error>> {
    Ok(header()?.anchor(chain()?)?)
}

fn log(topics: Vec<LogTopic>, data: Vec<u8>) -> Result<RawLogEnvelope, Box<dyn Error>> {
    Ok(RawLogEnvelope::with_topics(
        address(0x41)?,
        hash(0x42)?,
        7,
        9,
        topics,
        data,
        false,
    )?)
}

fn observe(payload: RawLogEnvelope) -> Result<CensusObservation<RawLogEnvelope>, Box<dyn Error>> {
    Ok(CensusObservation::observe(
        anchor()?,
        semantics()?,
        provenance(ProvenanceAuthority::ReceiptLog)?,
        payload,
    )?)
}

fn zero_topic_log() -> Result<RawLogEnvelope, Box<dyn Error>> {
    log(
        vec![
            LogTopic::new([0x43; 32]),
            LogTopic::ZERO,
            address_word(0x44),
        ],
        shared_bytes(),
    )
}

#[test]
fn zero_indexed_address_topic_is_accepted_and_matches_independent_vectors() -> TestResult {
    let cases = [zero_topic_log()?, log(vec![LogTopic::ZERO; 4], Vec::new())?];
    for (payload, (name, raw, observation, canonical_sha, length)) in
        cases.into_iter().zip(ZERO_TOPIC_VECTORS)
    {
        let observed = observe(payload)?;
        let canonical = observed.canonical_bytes()?;
        assert_eq!(
            observed.envelope().raw_payload_digest().to_hex(),
            raw,
            "{name}"
        );
        assert_eq!(observed.envelope().digest().to_hex(), observation, "{name}");
        assert_eq!(hex(&Sha256::digest(&canonical)), canonical_sha, "{name}");
        assert_eq!(canonical.len(), length, "{name}");
    }
    let topics = zero_topic_log()?;
    assert!(topics.topics()[1].is_zero());
    assert_eq!(topics.topics()[1].to_hex(), format!("0x{}", "0".repeat(64)));
    Ok(())
}

#[test]
fn canonical_zero_topic_observation_round_trips_deterministically() -> TestResult {
    let observed = observe(zero_topic_log()?)?;
    let first = observed.canonical_bytes()?;
    let second = observe(zero_topic_log()?)?.canonical_bytes()?;
    assert_eq!(first, second);
    assert_eq!(peek_observation_class(&first)?, ObservationClass::Log);
    let decoded = CensusObservation::<RawLogEnvelope>::decode_canonical(&first)?;
    assert_eq!(decoded, observed);
    assert_eq!(decoded.canonical_bytes()?, first);
    assert_eq!(decoded.payload().topics()[1], LogTopic::ZERO);
    Ok(())
}

#[test]
fn nonzero_topic_encoding_and_legacy_digests_are_unchanged() -> TestResult {
    // RMC-003.1 shared LOG vector through both constructors.
    let strict = RawLogEnvelope::new(
        address(0x41)?,
        hash(0x42)?,
        7,
        9,
        vec![hash(0x43)?],
        shared_bytes(),
        false,
    )?;
    let words = log(vec![LogTopic::from(hash(0x43)?)], shared_bytes())?;
    assert_eq!(strict, words);
    let observed = observe(strict)?;
    assert_eq!(
        observed.envelope().raw_payload_digest().to_hex(),
        RMC003_1_LOG.0
    );
    assert_eq!(observed.envelope().digest().to_hex(), RMC003_1_LOG.1);
    assert_eq!(
        hex(&Sha256::digest(observed.canonical_bytes()?)),
        RMC003_1_LOG.2
    );

    // RMC-003 legacy RawLog digest.
    let legacy_anchor = StateAnchor::new(
        chain()?,
        19_000_000,
        hash(0xa1)?,
        hash(0xa0)?,
        1_700_000_000,
        hash(0x5a)?,
    )?;
    let legacy = CensusObservation::from_raw_log(
        legacy_anchor,
        semantics()?,
        provenance(ProvenanceAuthority::ReceiptLog)?,
        RawLogEnvelope::new(
            address(0x41)?,
            hash(0x42)?,
            7,
            9,
            vec![hash(0x43)?, hash(0x44)?],
            vec![0xde, 0xad, 0xbe, 0xef],
            false,
        )?,
    )?;
    assert_eq!(
        legacy.envelope().raw_payload_digest().to_hex(),
        LEGACY_TWO_TOPICS.0
    );
    assert_eq!(legacy.envelope().digest().to_hex(), LEGACY_TWO_TOPICS.1);
    Ok(())
}

#[test]
fn hash_fields_still_reject_zero() -> TestResult {
    assert_eq!(
        Hash32::new([0; 32]),
        Err(IdentityError::ZeroValue("hash32"))
    );
    let zero_text = format!("0x{}", "0".repeat(64));
    assert!(Hash32::parse_hex(&zero_text).is_err());
    assert_eq!(LogTopic::parse_hex(&zero_text)?, LogTopic::ZERO);
    assert!(Hash32::try_from(LogTopic::ZERO).is_err());
    let nonzero = LogTopic::new([0x43; 32]);
    assert_eq!(Hash32::try_from(nonzero)?, hash(0x43)?);
    // The transaction hash of a log stays a nonzero Hash32 by construction:
    // the only way to supply one is through Hash32::new or parse_hex.
    assert_eq!(zero_topic_log()?.transaction_hash(), hash(0x42)?);
    Ok(())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[test]
fn zero_transaction_hash_is_rejected_in_canonical_bytes() -> TestResult {
    let canonical = observe(zero_topic_log()?)?.canonical_bytes()?;
    let offset = find(&canonical, &[0x42; 32]).ok_or("transaction hash not found")?;
    let mut tampered = canonical.clone();
    tampered[offset..offset + 32].copy_from_slice(&[0; 32]);
    assert!(matches!(
        CensusObservation::<RawLogEnvelope>::decode_canonical(&tampered),
        Err(ObservationError::MalformedCanonical(_))
    ));
    Ok(())
}

#[test]
fn zero_block_hash_in_the_anchor_is_rejected() -> TestResult {
    let observed = observe(zero_topic_log()?)?;
    let canonical = observed.canonical_bytes()?;
    let block_hash = *observed.envelope().anchor().block_hash().as_bytes();
    let offset = find(&canonical, &block_hash).ok_or("anchor hash not found")?;
    let mut tampered = canonical.clone();
    tampered[offset..offset + 32].copy_from_slice(&[0; 32]);
    assert!(CensusObservation::<RawLogEnvelope>::decode_canonical(&tampered).is_err());
    Ok(())
}

#[test]
fn topic_tamper_is_rejected_including_zeroing_and_unzeroing() -> TestResult {
    let canonical = observe(zero_topic_log()?)?.canonical_bytes()?;
    let offset = find(&canonical, &[0x43; 32]).ok_or("topic0 not found")?;
    for (start, value) in [
        (offset, 0x00_u8),
        (offset + 32, 0x01),
        (offset + 64 + 31, 0x00),
    ] {
        let mut tampered = canonical.clone();
        tampered[start] = value;
        assert_ne!(tampered, canonical);
        assert!(
            CensusObservation::<RawLogEnvelope>::decode_canonical(&tampered).is_err(),
            "tamper at {start} accepted"
        );
    }
    Ok(())
}

#[test]
fn log_bytes_never_decode_as_another_class() -> TestResult {
    let canonical = observe(zero_topic_log()?)?.canonical_bytes()?;
    assert!(CensusObservation::<BlockHeaderEnvelope>::decode_canonical(&canonical).is_err());
    let header_observation = CensusObservation::observe(
        anchor()?,
        semantics()?,
        provenance(BlockHeaderEnvelope::CLASS.required_authority())?,
        header()?,
    )?;
    let header_bytes = header_observation.canonical_bytes()?;
    assert!(CensusObservation::<RawLogEnvelope>::decode_canonical(&header_bytes).is_err());
    Ok(())
}

#[test]
fn topic_hex_is_strict_and_topic_count_is_bounded() -> TestResult {
    assert!(LogTopic::parse_hex("0x00").is_err());
    assert!(LogTopic::parse_hex(&format!("0x{}", "0".repeat(65))).is_err());
    assert!(LogTopic::parse_hex(&format!("0x{}g", "0".repeat(63))).is_err());
    assert_eq!(
        LogTopic::parse_hex(&format!("0x{}", "Ab".repeat(32)))?,
        LogTopic::new([0xab; 32])
    );
    assert_eq!(
        LogTopic::parse_hex(&LogTopic::new([0x5c; 32]).to_hex())?,
        LogTopic::new([0x5c; 32])
    );
    assert!(matches!(
        log(vec![LogTopic::ZERO; 5], Vec::new()),
        Err(error) if error.to_string().contains("topics")
    ));
    Ok(())
}
