use nqc_census_core::{
    keccak256, peek_observation_class, Address, AnchorMismatchField, BlockHeaderEnvelope,
    CallContext, CallOutcome, CensusObservation, ChainDomain, ContractCallEnvelope, Hash32,
    HeaderEncoding, ObservationClass, ObservationError, ObservationPayload, ObservationProvenance,
    ObservationSemantics, ProvenanceAuthority, RawLogEnvelope, RuntimeCodeEnvelope, StateAnchor,
    TYPED_OBSERVATION_SCHEMA_VERSION,
};
use sha2::{Digest, Sha256};
use std::error::Error;

type TestResult = Result<(), Box<dyn Error>>;

// Golden values are produced independently by ci/nqc-census/typed_observation_vectors.py
// and pinned in ci/nqc-census/typed-observation-vectors.json.
const SYNTHETIC_HEADER_HASH: &str =
    "f68fcbd84f4b376728b1b72a90bbb27eae26d99fddfa8290940ccd8d41f5db5c";

const LEGACY_RAW_LOGS: [(&str, &str, &str); 3] = [
    (
        "two_topics_data",
        "e3c859d9a38f61c9ed278c5d016115294f12ef5157d1e6535e7d23aeb3b9ce20",
        "39584a5dad7db7ec899192ec2396bd07ff37a92a3aea78686dceda5e56ece56a",
    ),
    (
        "no_topics_empty_removed",
        "bcbba7a2e35023c8da5d1002f426be489f9ca55b196834dc361468e37410ef1c",
        "90ebf6cf00583bb331fd92cff1b4b559a436f1a35b5a1f01d4bdae24283c5f34",
    ),
    (
        "four_topics",
        "ba3c2476fcc21a650734a1e3ff2884eb36cf795716e7bf426381606526766314",
        "baac4fde3452b39a7946c9a2ecbeac0e959ab28e063f784f6f4d4f814db1292c",
    ),
];

// (class, raw payload digest, observation digest, sha256(canonical), canonical length)
const SHARED_VECTORS: [(&str, &str, &str, &str, usize); 4] = [
    (
        "LOG",
        "ed832136a26d365f36e5f18285420beb5f92a2cd201d0e01308199b666540b62",
        "222eac573e598bb40cab0533d73a046a94bb21f9057b47d8d192bdc257addd17",
        "13373365a30944e98edcd3ccde01c9b13b5d82b2748fc11ae97c4191fed62cba",
        588,
    ),
    (
        "CONTRACT_CALL",
        "9778002d6462c60da4b69736638b41dc883f2fb6bb2ef6a6c9b88f0deadef08f",
        "5eaca3441ef0e80e3736f74e5aae5d16d5f28a86fe2607d2556afa5caebb8b19",
        "b6ae0172f2e2224d5b3cc61581ed33fe50e09a2b6525dcd64ecd535518689143",
        557,
    ),
    (
        "RUNTIME_CODE",
        "9abbc8ba77f38fba89785af36360d74648f9f94c04861ea8ed49be0ccddf2579",
        "06db9df40ddf948cfece2471cbd48e071dc0671e3a734e702a4fcecc65068c5e",
        "b66ffd312906e3dd98437ef053d77dd36301f1a248ea56ec0fe80a6244302546",
        514,
    ),
    (
        "BLOCK_HEADER",
        "94f309f188e42c89919c5e77b3e5864c8707a9a9d46d87cad10d607138e02d96",
        "7fa2500edd54665658ad2223d7f6681176f349b340cdd9b74019007bd5249c6f",
        "74c14206a191c99c0211b3f3f11b0792cbc2c953764a96fdfdb03603da5d132d",
        1143,
    ),
];

const REVERTED_CALL: (&str, &str, &str) = (
    "b798117945a43dfc0d375edc234a472d15a911581fdfac422c93f510aea78387",
    "7a248a758bc0fc28a3981f26dbe8b803e1fd7d03ee861212825799e4ddc3d4fc",
    "147f302ce4aafa6441e1f2187cfe3d36117c545541216c85360cf3fa34bf7242",
);

const ABSENT_CODE: (&str, &str, &str) = (
    "f6b36d9a3fdb74b5b5a614f87f32642d0d7f2e59b00e8da9e372da351815e7a2",
    "0c3493db43eb87b62e0c19e78137bd93fc3845a8224475105e0bfd474fb64cd3",
    "12e73786e26c64b3de8be0ebafef3f972d3149cba6d0ea4fcf1a5468b36c9ee8",
);

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hash(byte: u8) -> Result<Hash32, Box<dyn Error>> {
    Ok(Hash32::new([byte; 32])?)
}

fn address(byte: u8) -> Result<Address, Box<dyn Error>> {
    Ok(Address::new([byte; 20])?)
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

// Minimal RLP encoder, test-side only, used to build synthetic headers.
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

fn rlp_list(fields: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = fields.iter().flat_map(|field| rlp_string(field)).collect();
    let mut out = rlp_prefix(0xc0, 0xf7, payload.len());
    out.extend_from_slice(&payload);
    out
}

fn uint(value: u64) -> Vec<u8> {
    let bytes = value.to_be_bytes();
    let first = bytes.iter().position(|byte| *byte != 0).unwrap_or(8);
    bytes[first..].to_vec()
}

fn synthetic_header_fields() -> Vec<Vec<u8>> {
    let mut bloom = vec![0_u8; 256];
    bloom[255] = 1;
    vec![
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
    ]
}

fn header_from_fields(fields: &[Vec<u8>]) -> Result<BlockHeaderEnvelope, ObservationError> {
    let encoded = rlp_list(fields);
    let claimed =
        Hash32::new(keccak256(&encoded)).map_err(|_| ObservationError::ZeroValue("hash"))?;
    BlockHeaderEnvelope::new(HeaderEncoding::EthereumRlp, claimed, encoded)
}

fn header() -> Result<BlockHeaderEnvelope, Box<dyn Error>> {
    Ok(header_from_fields(&synthetic_header_fields())?)
}

fn anchor() -> Result<StateAnchor, Box<dyn Error>> {
    Ok(header()?.anchor(chain()?)?)
}

fn log_payload(data: Vec<u8>) -> Result<RawLogEnvelope, Box<dyn Error>> {
    Ok(RawLogEnvelope::new(
        address(0x41)?,
        hash(0x42)?,
        7,
        9,
        vec![hash(0x43)?],
        data,
        false,
    )?)
}

fn call_payload(outcome: CallOutcome) -> Result<ContractCallEnvelope, Box<dyn Error>> {
    Ok(ContractCallEnvelope::new(
        address(0x61)?,
        CallContext::static_read(),
        vec![0x72, 0x21, 0x8d, 0x04],
        outcome,
    )?)
}

fn code_payload(code: Vec<u8>) -> Result<RuntimeCodeEnvelope, Box<dyn Error>> {
    Ok(RuntimeCodeEnvelope::new(address(0x71)?, code)?)
}

fn observe<T: ObservationPayload>(payload: T) -> Result<CensusObservation<T>, Box<dyn Error>> {
    Ok(CensusObservation::observe(
        anchor()?,
        semantics()?,
        provenance(T::CLASS.required_authority())?,
        payload,
    )?)
}

struct Summary {
    class: ObservationClass,
    raw: String,
    observation: String,
    canonical: Vec<u8>,
}

fn summarize<T: ObservationPayload>(
    observation: &CensusObservation<T>,
) -> Result<Summary, Box<dyn Error>> {
    Ok(Summary {
        class: observation.class(),
        raw: observation.envelope().raw_payload_digest().to_hex(),
        observation: observation.envelope().digest().to_hex(),
        canonical: observation.canonical_bytes()?,
    })
}

fn shared_summaries() -> Result<Vec<Summary>, Box<dyn Error>> {
    Ok(vec![
        summarize(&observe(log_payload(shared_bytes())?)?)?,
        summarize(&observe(call_payload(CallOutcome::Returned(
            shared_bytes(),
        ))?)?)?,
        summarize(&observe(code_payload(shared_bytes())?)?)?,
        summarize(&observe(header()?)?)?,
    ])
}

#[test]
fn keccak256_matches_reference_vectors() {
    let cases: [(&[u8], &str); 5] = [
        (
            b"",
            "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
        ),
        (
            b"abc",
            "4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
        ),
        (
            b"Transfer(address,address,uint256)",
            "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
        ),
        (
            &[0_u8; 135],
            "29e3704feeca7fb9ba229f0fa04d9b36449cf3ad6e1d85d9cfff3a10df9abc3e",
        ),
        (
            &[0_u8; 136],
            "3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9",
        ),
    ];
    for (input, expected) in cases {
        assert_eq!(hex(&keccak256(input)), expected);
    }
    assert_eq!(
        hex(&keccak256(&[0_u8; 137])),
        "bee7fbb405cb0d91a8775e338c4a5e4b5d6b2d051f687fa942043cffdc73bd28"
    );
}

#[test]
fn legacy_raw_log_vectors_are_byte_identical() -> TestResult {
    let legacy_anchor = StateAnchor::new(
        chain()?,
        19_000_000,
        hash(0xa1)?,
        hash(0xa0)?,
        1_700_000_000,
        hash(0x5a)?,
    )?;
    let logs = [
        RawLogEnvelope::new(
            address(0x41)?,
            hash(0x42)?,
            7,
            9,
            vec![hash(0x43)?, hash(0x44)?],
            vec![0xde, 0xad, 0xbe, 0xef],
            false,
        )?,
        RawLogEnvelope::new(address(0x51)?, hash(0x52)?, 0, 0, vec![], vec![], true)?,
        RawLogEnvelope::new(
            address(0x61)?,
            hash(0x62)?,
            u32::MAX,
            1,
            vec![hash(1)?, hash(2)?, hash(3)?, hash(4)?],
            (0_u8..=64).collect(),
            false,
        )?,
    ];
    for (log, (name, raw, observation)) in logs.into_iter().zip(LEGACY_RAW_LOGS) {
        assert_eq!(log.digest()?.to_hex(), raw, "{name} raw digest");
        assert_eq!(log.payload_digest()?.to_hex(), raw, "{name} typed digest");
        let mut hasher = Sha256::new();
        hasher.update(b"NQC-CENSUS-RAW-LOG-V1");
        hasher.update([0]);
        hasher.update(log.canonical_payload_bytes()?);
        assert_eq!(hex(&hasher.finalize()), raw, "{name} canonical payload");

        let legacy = CensusObservation::from_raw_log(
            legacy_anchor.clone(),
            semantics()?,
            provenance(ProvenanceAuthority::ReceiptLog)?,
            log.clone(),
        )?;
        let typed = CensusObservation::observe(
            legacy_anchor.clone(),
            semantics()?,
            provenance(ProvenanceAuthority::ReceiptLog)?,
            log,
        )?;
        assert_eq!(legacy.envelope().digest().to_hex(), observation, "{name}");
        assert_eq!(legacy.envelope(), typed.envelope(), "{name}");
    }
    Ok(())
}

#[test]
fn same_bytes_in_every_class_never_collide() -> TestResult {
    let summaries = shared_summaries()?;
    for (summary, (class, raw, observation, canonical_sha, length)) in
        summaries.iter().zip(SHARED_VECTORS)
    {
        assert_eq!(summary.class.code(), class);
        assert_eq!(summary.raw, raw, "{class} raw digest");
        assert_eq!(
            summary.observation, observation,
            "{class} observation digest"
        );
        assert_eq!(
            sha256_hex(&summary.canonical),
            canonical_sha,
            "{class} bytes"
        );
        assert_eq!(summary.canonical.len(), length, "{class} length");
    }
    let mut digests: Vec<&str> = summaries
        .iter()
        .flat_map(|summary| [summary.raw.as_str(), summary.observation.as_str()])
        .collect();
    digests.sort_unstable();
    digests.dedup();
    assert_eq!(digests.len(), 8);
    Ok(())
}

#[test]
fn canonical_encoding_round_trips_and_is_replay_stable() -> TestResult {
    fn round_trip<T: ObservationPayload + Clone + PartialEq + std::fmt::Debug>(
        observation: &CensusObservation<T>,
    ) -> TestResult {
        let bytes = observation.canonical_bytes()?;
        assert_eq!(peek_observation_class(&bytes)?, T::CLASS);
        let decoded = CensusObservation::<T>::decode_canonical(&bytes)?;
        assert_eq!(decoded.envelope(), observation.envelope());
        assert_eq!(decoded.payload(), observation.payload());
        assert_eq!(decoded.canonical_bytes()?, bytes);
        Ok(())
    }
    round_trip(&observe(log_payload(shared_bytes())?)?)?;
    round_trip(&observe(call_payload(CallOutcome::Reverted(vec![
        1, 2, 3,
    ]))?)?)?;
    round_trip(&observe(code_payload(Vec::new())?)?)?;
    round_trip(&observe(header()?)?)?;

    let first = shared_summaries()?;
    let second = shared_summaries()?;
    for (left, right) in first.iter().zip(&second) {
        assert_eq!(left.observation, right.observation);
        assert_eq!(left.canonical, right.canonical);
    }
    assert_eq!(TYPED_OBSERVATION_SCHEMA_VERSION, 1);
    Ok(())
}

#[test]
fn header_hash_is_recomputed_not_trusted() -> TestResult {
    let verified = header()?;
    assert_eq!(
        verified.hash().to_hex(),
        format!("0x{SYNTHETIC_HEADER_HASH}")
    );
    assert_eq!(verified.number(), 19_000_000);
    assert_eq!(verified.timestamp(), 1_700_000_000);
    assert_eq!(verified.parent_hash(), &[0xa0; 32]);
    assert_eq!(verified.state_root(), &[0x5a; 32]);
    assert_eq!(verified.transactions_root(), &[0x7a; 32]);
    assert_eq!(verified.receipts_root(), &[0x8a; 32]);
    assert_eq!(verified.logs_bloom()[255], 1);
    assert_eq!(verified.field_count(), 21);
    assert_eq!(verified.field(12), Some(shared_bytes()));

    let wrong = BlockHeaderEnvelope::new(
        HeaderEncoding::EthereumRlp,
        hash(0x99)?,
        verified.encoded().to_vec(),
    );
    assert_eq!(wrong, Err(ObservationError::HeaderHashMismatch));

    let mut tampered = verified.encoded().to_vec();
    let last = tampered.len() - 1;
    tampered[last] ^= 1;
    let changed = BlockHeaderEnvelope::new(HeaderEncoding::EthereumRlp, verified.hash(), tampered);
    assert_eq!(changed, Err(ObservationError::HeaderHashMismatch));
    Ok(())
}

#[test]
fn header_observation_must_match_its_anchor() -> TestResult {
    let verified = header()?;
    let good = anchor()?;
    let cases = [
        (
            StateAnchor::new(
                chain()?,
                good.block_number(),
                hash(0x77)?,
                good.parent_hash(),
                good.timestamp(),
                good.state_root(),
            )?,
            AnchorMismatchField::BlockHash,
        ),
        (
            StateAnchor::new(
                chain()?,
                good.block_number() + 1,
                good.block_hash(),
                good.parent_hash(),
                good.timestamp(),
                good.state_root(),
            )?,
            AnchorMismatchField::BlockNumber,
        ),
        (
            StateAnchor::new(
                chain()?,
                good.block_number(),
                good.block_hash(),
                hash(0x78)?,
                good.timestamp(),
                good.state_root(),
            )?,
            AnchorMismatchField::ParentHash,
        ),
        (
            StateAnchor::new(
                chain()?,
                good.block_number(),
                good.block_hash(),
                good.parent_hash(),
                good.timestamp() + 12,
                good.state_root(),
            )?,
            AnchorMismatchField::Timestamp,
        ),
        (
            StateAnchor::new(
                chain()?,
                good.block_number(),
                good.block_hash(),
                good.parent_hash(),
                good.timestamp(),
                hash(0x79)?,
            )?,
            AnchorMismatchField::StateRoot,
        ),
    ];
    for (wrong_anchor, field) in cases {
        let result = CensusObservation::observe(
            wrong_anchor,
            semantics()?,
            provenance(ProvenanceAuthority::BlockHeader)?,
            verified.clone(),
        );
        assert_eq!(
            result.err(),
            Some(ObservationError::HeaderAnchorMismatch(field))
        );
    }
    Ok(())
}

#[test]
fn wrong_chain_is_detected_and_changes_identity() -> TestResult {
    let observation = observe(call_payload(CallOutcome::Returned(shared_bytes()))?)?;
    observation.require_anchor(&anchor()?)?;

    let other_chain = ChainDomain::new(1, hash(0x11)?, hash(0x23)?)?;
    let other_anchor = header()?.anchor(other_chain)?;
    assert_eq!(
        observation.require_anchor(&other_anchor),
        Err(ObservationError::AnchorMismatch(
            AnchorMismatchField::ChainDomain
        ))
    );
    let moved = CensusObservation::observe(
        other_anchor,
        semantics()?,
        provenance(ProvenanceAuthority::ContractCall)?,
        call_payload(CallOutcome::Returned(shared_bytes()))?,
    )?;
    assert_ne!(moved.envelope().digest(), observation.envelope().digest());
    assert_eq!(
        moved.envelope().raw_payload_digest(),
        observation.envelope().raw_payload_digest()
    );
    Ok(())
}

#[test]
fn provenance_authority_must_match_class() -> TestResult {
    let authorities = [
        ProvenanceAuthority::BlockHeader,
        ProvenanceAuthority::ContractCall,
        ProvenanceAuthority::ReceiptLog,
        ProvenanceAuthority::StorageProof,
        ProvenanceAuthority::CodeRead,
        ProvenanceAuthority::ConfigurationRead,
        ProvenanceAuthority::LocalDerivation,
    ];
    for authority in authorities {
        let expect = |class: ObservationClass, result: Result<(), ObservationError>| {
            if authority == class.required_authority() {
                assert_eq!(result, Ok(()));
            } else {
                assert_eq!(
                    result,
                    Err(ObservationError::ProvenanceClassMismatch { class, authority })
                );
            }
        };
        expect(
            ObservationClass::Log,
            CensusObservation::observe(
                anchor()?,
                semantics()?,
                provenance(authority)?,
                log_payload(vec![1])?,
            )
            .map(|_| ()),
        );
        expect(
            ObservationClass::ContractCall,
            CensusObservation::observe(
                anchor()?,
                semantics()?,
                provenance(authority)?,
                call_payload(CallOutcome::Returned(vec![1]))?,
            )
            .map(|_| ()),
        );
        expect(
            ObservationClass::RuntimeCode,
            CensusObservation::observe(
                anchor()?,
                semantics()?,
                provenance(authority)?,
                code_payload(vec![1])?,
            )
            .map(|_| ()),
        );
        expect(
            ObservationClass::BlockHeader,
            CensusObservation::observe(anchor()?, semantics()?, provenance(authority)?, header()?)
                .map(|_| ()),
        );
    }

    // A legacy log observation with a non-log authority cannot gain canonical typed bytes.
    let legacy = CensusObservation::from_raw_log(
        anchor()?,
        semantics()?,
        provenance(ProvenanceAuthority::ContractCall)?,
        log_payload(vec![1])?,
    )?;
    assert!(matches!(
        legacy.canonical_bytes(),
        Err(ObservationError::ProvenanceClassMismatch { .. })
    ));
    Ok(())
}

#[test]
fn every_single_byte_tamper_is_rejected() -> TestResult {
    fn exhaustive<T: ObservationPayload>(observation: &CensusObservation<T>) -> TestResult {
        let bytes = observation.canonical_bytes()?;
        for index in 0..bytes.len() {
            for mask in [0x01_u8, 0x80] {
                let mut tampered = bytes.clone();
                tampered[index] ^= mask;
                assert!(
                    CensusObservation::<T>::decode_canonical(&tampered).is_err(),
                    "{} byte {index} mask {mask:#x} accepted",
                    T::CLASS.code()
                );
            }
        }
        Ok(())
    }
    exhaustive(&observe(log_payload(shared_bytes())?)?)?;
    exhaustive(&observe(call_payload(CallOutcome::Returned(
        shared_bytes(),
    ))?)?)?;
    exhaustive(&observe(code_payload(shared_bytes())?)?)?;
    exhaustive(&observe(header()?)?)?;
    Ok(())
}

#[test]
fn stale_digest_is_rejected_after_content_change() -> TestResult {
    let observation = observe(call_payload(CallOutcome::Returned(shared_bytes()))?)?;
    let mut bytes = observation.canonical_bytes()?;
    // Change the last output byte (inside TLV 4) but keep TLV 5/6 digests.
    let output_end = bytes.len() - 2 * (1 + 4 + 32);
    bytes[output_end - 1] ^= 0xff;
    assert_eq!(
        CensusObservation::<ContractCallEnvelope>::decode_canonical(&bytes).err(),
        Some(ObservationError::DigestMismatch("raw payload"))
    );
    Ok(())
}

#[test]
fn malformed_canonical_bytes_are_rejected() -> TestResult {
    let observation = observe(code_payload(shared_bytes())?)?;
    let bytes = observation.canonical_bytes()?;

    for length in 0..bytes.len() {
        assert!(
            CensusObservation::<RuntimeCodeEnvelope>::decode_canonical(&bytes[..length]).is_err(),
            "prefix {length} accepted"
        );
    }

    let mut trailing = bytes.clone();
    trailing.push(0);
    assert_eq!(
        CensusObservation::<RuntimeCodeEnvelope>::decode_canonical(&trailing).err(),
        Some(ObservationError::MalformedCanonical("trailing bytes"))
    );

    let mut magic = bytes.clone();
    magic[0] = b'X';
    assert_eq!(
        peek_observation_class(&magic),
        Err(ObservationError::MalformedCanonical("bad magic"))
    );

    let mut version = bytes.clone();
    version[15] = 2;
    assert_eq!(
        peek_observation_class(&version),
        Err(ObservationError::MalformedCanonical(
            "unsupported schema version"
        ))
    );

    let mut unknown_class = bytes.clone();
    unknown_class[16] = 9;
    assert_eq!(
        peek_observation_class(&unknown_class),
        Err(ObservationError::MalformedCanonical(
            "unknown observation class"
        ))
    );

    assert_eq!(
        CensusObservation::<ContractCallEnvelope>::decode_canonical(&bytes).err(),
        Some(ObservationError::ClassMismatch {
            expected: ObservationClass::ContractCall,
            found: ObservationClass::RuntimeCode,
        })
    );

    // Swap the first two TLV tags.
    let mut reordered = bytes.clone();
    reordered[17] = 2;
    assert_eq!(
        CensusObservation::<RuntimeCodeEnvelope>::decode_canonical(&reordered).err(),
        Some(ObservationError::MalformedCanonical(
            "missing, unknown, or reordered field"
        ))
    );
    Ok(())
}

#[test]
fn changed_output_selector_target_or_header_changes_digest() -> TestResult {
    let base = observe(call_payload(CallOutcome::Returned(shared_bytes()))?)?;
    let base_digest = base.envelope().digest();

    let mut output = shared_bytes();
    output[31] ^= 1;
    let changed_output = observe(call_payload(CallOutcome::Returned(output))?)?;
    assert_ne!(changed_output.envelope().digest(), base_digest);

    let changed_selector = observe(ContractCallEnvelope::new(
        address(0x61)?,
        CallContext::static_read(),
        vec![0x52, 0x75, 0x17, 0x97],
        CallOutcome::Returned(shared_bytes()),
    )?)?;
    assert_eq!(
        changed_selector.payload().selector(),
        Some([0x52, 0x75, 0x17, 0x97])
    );
    assert_ne!(changed_selector.envelope().digest(), base_digest);

    let changed_target = observe(ContractCallEnvelope::new(
        address(0x62)?,
        CallContext::static_read(),
        vec![0x72, 0x21, 0x8d, 0x04],
        CallOutcome::Returned(shared_bytes()),
    )?)?;
    assert_ne!(changed_target.envelope().digest(), base_digest);

    let changed_context = observe(ContractCallEnvelope::new(
        address(0x61)?,
        CallContext::new(Some(address(0x01)?), [0; 32], Some(30_000_000)),
        vec![0x72, 0x21, 0x8d, 0x04],
        CallOutcome::Returned(shared_bytes()),
    )?)?;
    assert_ne!(changed_context.envelope().digest(), base_digest);

    let mut fields = synthetic_header_fields();
    fields[12] = vec![0x42];
    let other_header = header_from_fields(&fields)?;
    let other_anchor = other_header.anchor(chain()?)?;
    let changed_header = CensusObservation::observe(
        other_anchor,
        semantics()?,
        provenance(ProvenanceAuthority::BlockHeader)?,
        other_header,
    )?;
    let base_header = observe(header()?)?;
    assert_ne!(
        changed_header.envelope().digest(),
        base_header.envelope().digest()
    );
    Ok(())
}

#[test]
fn reverted_calls_and_absent_code_are_preserved() -> TestResult {
    let reverted = observe(call_payload(CallOutcome::Reverted(shared_bytes()))?)?;
    assert!(!reverted.payload().outcome().is_success());
    assert_eq!(reverted.payload().outcome().output(), shared_bytes());
    assert_eq!(
        reverted.envelope().raw_payload_digest().to_hex(),
        REVERTED_CALL.0
    );
    assert_eq!(reverted.envelope().digest().to_hex(), REVERTED_CALL.1);
    assert_eq!(sha256_hex(&reverted.canonical_bytes()?), REVERTED_CALL.2);

    let returned = observe(call_payload(CallOutcome::Returned(shared_bytes()))?)?;
    assert_ne!(returned.envelope().digest(), reverted.envelope().digest());

    let absent = observe(code_payload(Vec::new())?)?;
    assert!(absent.payload().is_absent());
    assert_eq!(
        absent.envelope().raw_payload_digest().to_hex(),
        ABSENT_CODE.0
    );
    assert_eq!(absent.envelope().digest().to_hex(), ABSENT_CODE.1);
    assert_eq!(sha256_hex(&absent.canonical_bytes()?), ABSENT_CODE.2);

    let short = ContractCallEnvelope::new(
        address(0x61)?,
        CallContext::static_read(),
        vec![0x01, 0x02],
        CallOutcome::Returned(Vec::new()),
    )?;
    assert_eq!(short.selector(), None);
    Ok(())
}

#[test]
fn non_canonical_or_incomplete_headers_are_rejected() -> TestResult {
    let reject = |encoded: Vec<u8>| -> Result<ObservationError, Box<dyn Error>> {
        let claimed = Hash32::new(keccak256(&encoded))?;
        match BlockHeaderEnvelope::new(HeaderEncoding::EthereumRlp, claimed, encoded) {
            Ok(_) => Err("header accepted".into()),
            Err(error) => Ok(error),
        }
    };

    let fields = synthetic_header_fields();
    assert_eq!(
        reject(rlp_list(&fields[..14]))?,
        ObservationError::MalformedHeader("fewer than fifteen header fields")
    );

    let mut wide = fields.clone();
    wide[0] = vec![0xa0; 31];
    assert_eq!(
        reject(rlp_list(&wide))?,
        ObservationError::MalformedHeader("parent hash")
    );

    let mut padded_number = fields.clone();
    padded_number[8] = vec![0x00, 0x01];
    assert_eq!(
        reject(rlp_list(&padded_number))?,
        ObservationError::MalformedHeader("non-canonical RLP encoding")
    );

    // Single byte below 0x80 wrapped in a string prefix.
    let mut encoded = rlp_list(&fields);
    let mut non_minimal = vec![0xf9];
    let payload_start = 3;
    let mut payload = encoded.split_off(payload_start);
    let position = payload
        .iter()
        .position(|byte| *byte == 0x07)
        .ok_or("base fee")?;
    payload.splice(position..=position, [0x81, 0x07]);
    non_minimal.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    non_minimal.extend_from_slice(&payload);
    assert_eq!(
        reject(non_minimal)?,
        ObservationError::MalformedHeader("non-canonical RLP encoding")
    );

    let mut trailing = rlp_list(&fields);
    trailing.push(0x00);
    assert_eq!(
        reject(trailing)?,
        ObservationError::MalformedHeader("trailing bytes after RLP list")
    );

    let mut nested = rlp_list(&fields[..15]);
    nested.extend_from_slice(&[0xc0]);
    let mut outer = vec![0xf9];
    let inner = nested.split_off(3);
    outer.extend_from_slice(&(inner.len() as u16).to_be_bytes());
    outer.extend_from_slice(&inner);
    assert_eq!(
        reject(outer)?,
        ObservationError::MalformedHeader("RLP header field must be a byte string")
    );
    Ok(())
}
