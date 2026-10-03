//! Content-addressed storage: identity, deduplication, integrity layers,
//! compression, canonical encoding and persisted policy.

mod support;

use nqc_census_store::codec::{compress, decompress, CodecError};
use nqc_census_store::verify::{verify_store, VerifyRequest};
use nqc_census_store::{ArtifactId, CompressionPolicy, Store, StoreConfig, StoreError};
use std::fs;
use support::{
    abi_like, chunk_paths, digest, files_under, flip_last_byte, manifest_path, noise, put,
    small_config, tamper, tree_listing, TempDir, TestResult,
};

#[test]
fn artifact_identity_is_plain_sha256_of_logical_bytes() -> TestResult {
    let dir = TempDir::new("cas-identity")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let bytes = abi_like(5000, 1);
    let id = put(&store, &bytes)?;
    // Independent of the store: a stock SHA-256 of the logical bytes.
    assert_eq!(id.as_bytes(), &digest(&[&bytes]));
    assert_eq!(id, ArtifactId::of(&bytes));
    assert_eq!(store.get_artifact(&id)?, bytes);
    Ok(())
}

#[test]
fn same_payload_twice_deduplicates_without_rewriting() -> TestResult {
    let dir = TempDir::new("cas-dedup")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let bytes = noise(12_000, 2);
    let first = store.put_artifact(&bytes)?;
    let files_after_first = files_under(dir.path())?;
    let manifest_before = fs::read(manifest_path(&store, &first.id))?;

    let second = store.put_artifact(&bytes)?;
    assert_eq!(first.id, second.id);
    assert!(first.manifest_created && first.chunks_created > 1);
    assert!(!second.manifest_created);
    assert_eq!(second.chunks_created, 0);
    assert_eq!(
        second.chunks_reused,
        first.chunks_created + first.chunks_reused
    );
    assert_eq!(files_under(dir.path())?, files_after_first);
    assert_eq!(fs::read(manifest_path(&store, &first.id))?, manifest_before);
    Ok(())
}

#[test]
fn different_payloads_never_alias() -> TestResult {
    let dir = TempDir::new("cas-alias")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let a = noise(3000, 3);
    let mut b = a.clone();
    if let Some(byte) = b.get_mut(1500) {
        *byte ^= 0x80;
    }
    let (id_a, id_b) = (put(&store, &a)?, put(&store, &b)?);
    assert_ne!(id_a, id_b);
    assert_eq!(store.get_artifact(&id_a)?, a);
    assert_eq!(store.get_artifact(&id_b)?, b);
    Ok(())
}

#[test]
fn empty_and_oversized_artifacts_are_rejected() -> TestResult {
    let dir = TempDir::new("cas-bounds")?;
    let config = StoreConfig::new(256, 8, 2048, CompressionPolicy::RawOnly, 4096)?;
    let store = Store::create(dir.path(), config)?;
    assert_eq!(store.put_artifact(&[]), Err(StoreError::ArtifactEmpty));
    assert_eq!(
        store.put_artifact(&noise(4097, 4)),
        Err(StoreError::ArtifactTooLarge {
            length: 4097,
            limit: 4096
        })
    );
    assert!(files_under(&dir.join("objects"))?.is_empty());
    Ok(())
}

#[test]
fn stored_frame_mutation_is_detected_before_decoding() -> TestResult {
    let dir = TempDir::new("cas-frame-flip")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &abi_like(6000, 5))?;
    let chunk = chunk_paths(&store)?.into_iter().next().ok_or("no chunk")?;
    flip_last_byte(&chunk)?;
    assert_eq!(
        store.get_artifact(&id),
        Err(StoreError::DigestMismatch {
            object: "chunk frame"
        })
    );
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    Ok(())
}

#[test]
fn manifest_mutation_is_detected() -> TestResult {
    let dir = TempDir::new("cas-manifest-flip")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &noise(7000, 6))?;
    let path = manifest_path(&store, &id);
    // Flip a bit inside the first frame digest of the chunk table.
    tamper(&path, |bytes| {
        let len = bytes.len();
        if let Some(byte) = bytes.get_mut(len - 1) {
            *byte ^= 0x40;
        }
    })?;
    assert!(matches!(
        store.get_artifact(&id),
        Err(StoreError::DigestMismatch { .. })
    ));
    let failure = verify_store(dir.path(), &VerifyRequest::default())
        .err()
        .ok_or("tampered manifest verified")?;
    assert!(failure.path.starts_with("objects/artifacts"));
    Ok(())
}

#[test]
fn truncated_and_trailing_encodings_reject() -> TestResult {
    for (label, edit) in [("truncate", 0_u8), ("trailing", 1_u8)] {
        for target in ["manifest", "chunk"] {
            let dir = TempDir::new(&format!("cas-{label}-{target}"))?;
            let store = Store::create(dir.path(), small_config()?)?;
            let id = put(&store, &abi_like(3000, 7))?;
            let path = if target == "manifest" {
                manifest_path(&store, &id)
            } else {
                chunk_paths(&store)?.into_iter().next().ok_or("no chunk")?
            };
            tamper(&path, |bytes| {
                if edit == 0 {
                    bytes.pop();
                } else {
                    bytes.push(0);
                }
            })?;
            assert!(
                store.get_artifact(&id).is_err(),
                "{label} {target} accepted"
            );
            assert!(
                verify_store(dir.path(), &VerifyRequest::default()).is_err(),
                "{label} {target} verified"
            );
        }
    }
    Ok(())
}

#[test]
fn existing_object_is_never_overwritten_by_different_bytes() -> TestResult {
    let dir = TempDir::new("cas-no-overwrite")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let bytes = abi_like(2500, 8);
    let id = put(&store, &bytes)?;
    let path = manifest_path(&store, &id);
    tamper(&path, |bytes| bytes.push(0xff))?;
    let corrupted = fs::read(&path)?;
    assert_eq!(
        store.put_artifact(&bytes),
        Err(StoreError::ObjectConflict(path.clone()))
    );
    assert_eq!(
        fs::read(&path)?,
        corrupted,
        "conflicting object was rewritten"
    );
    Ok(())
}

#[test]
fn missing_chunk_fails_closed() -> TestResult {
    let dir = TempDir::new("cas-missing-chunk")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &noise(9000, 9))?;
    let chunk = chunk_paths(&store)?.into_iter().last().ok_or("no chunk")?;
    fs::remove_file(&chunk)?;
    assert!(matches!(
        store.get_artifact(&id),
        Err(StoreError::ChunkMissing(_))
    ));
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    Ok(())
}

#[test]
fn compressible_and_incompressible_data_round_trip() -> TestResult {
    let dir = TempDir::new("cas-codec")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let compressible = abi_like(20_000, 10);
    let incompressible = noise(20_000, 11);
    let (a, b) = (put(&store, &compressible)?, put(&store, &incompressible)?);
    assert_eq!(store.get_artifact(&a)?, compressible);
    assert_eq!(store.get_artifact(&b)?, incompressible);
    let stored: u64 = chunk_paths(&store)?
        .iter()
        .map(|path| fs::metadata(path).map(|m| m.len()))
        .sum::<Result<u64, _>>()?;
    // Incompressible data is stored raw (+ frame header) and compressible data
    // shrinks, so the total is well under the 40 KB of logical input.
    assert!(stored < 30_000, "stored {stored} bytes");
    for bytes in [&compressible, &incompressible] {
        assert_eq!(&decompress(&compress(bytes), bytes.len())?, bytes);
    }
    Ok(())
}

#[test]
fn malformed_compressed_streams_reject() {
    // literal run of 3 declared, only 2 present
    assert_eq!(
        decompress(&[0x02, 1, 2], 3),
        Err(CodecError::TruncatedLiteral)
    );
    // match token missing its distance
    assert_eq!(
        decompress(&[0x00, 7, 0x80, 0], 5),
        Err(CodecError::TruncatedMatch)
    );
    // zero distance
    assert_eq!(
        decompress(&[0x00, 7, 0x80, 0, 0], 5),
        Err(CodecError::ZeroDistance)
    );
    // distance reaching before the start of output
    assert_eq!(
        decompress(&[0x00, 7, 0x80, 0, 2], 5),
        Err(CodecError::DistanceBeyondOutput)
    );
    // trailing token after the declared length is reached
    assert_eq!(
        decompress(&[0x00, 7, 0x00, 8], 1),
        Err(CodecError::OutputOverflow)
    );
    // stream ends before the declared length
    assert_eq!(decompress(&[0x00, 7], 2), Err(CodecError::OutputShort));
}

#[test]
fn claimed_raw_length_cannot_expand_output() {
    // A 3-byte stream claiming 131 copies of one byte: the decoder refuses to
    // produce more than the declared length, however long the match says.
    let bomb = [0x00, 0xAA, 0xFF, 0x00, 0x01];
    assert_eq!(decompress(&bomb, 64), Err(CodecError::OutputOverflow));
    // Repeated match tokens cannot exceed the declared length either.
    let mut many = vec![0x00, 0xAA];
    for _ in 0..10_000 {
        many.extend_from_slice(&[0xFF, 0x00, 0x01]);
    }
    assert_eq!(decompress(&many, 4096), Err(CodecError::OutputOverflow));
    // An honest declaration decodes exactly.
    assert_eq!(decompress(&bomb, 132), Ok(vec![0xAA; 132]));
}

#[test]
fn frame_claiming_raw_length_beyond_policy_is_rejected_before_allocation() -> TestResult {
    let dir = TempDir::new("cas-frame-bomb")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &abi_like(1000, 12))?;
    let chunk = chunk_paths(&store)?.into_iter().next().ok_or("no chunk")?;
    // Frame layout: 19-byte header, codec field (tag, len u32, value), then the
    // raw_len field (tag, len u32, value u32). Claim a 4 GiB logical chunk.
    tamper(&chunk, |bytes| {
        if let Some(raw_len) = bytes.get_mut(19 + 6 + 5..19 + 6 + 9) {
            raw_len.copy_from_slice(&u32::MAX.to_be_bytes());
        }
    })?;
    assert!(store.get_artifact(&id).is_err());
    let failure = verify_store(dir.path(), &VerifyRequest::default())
        .err()
        .ok_or("frame bomb verified")?;
    assert!(matches!(failure.error, StoreError::Malformed { .. }));
    Ok(())
}

#[test]
fn non_canonical_stored_form_is_rejected_by_verification() -> TestResult {
    // Store the same logical bytes under a raw-only policy, then transplant the
    // raw frame into a compressing store with a manifest whose digests match the
    // transplanted frame. Integrity holds; canonicality does not.
    let raw_dir = TempDir::new("cas-noncanon-raw")?;
    let raw_config = StoreConfig::new(256, 8, 2048, CompressionPolicy::RawOnly, 1 << 20)?;
    let raw_store = Store::create(raw_dir.path(), raw_config)?;
    let bytes = abi_like(200, 13); // single chunk, highly compressible
    let raw_id = put(&raw_store, &bytes)?;
    let raw_frame = chunk_paths(&raw_store)?
        .into_iter()
        .next()
        .ok_or("no chunk")?;

    let dir = TempDir::new("cas-noncanon")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &bytes)?;
    assert_eq!(id, raw_id);
    let canonical_frame = chunk_paths(&store)?.into_iter().next().ok_or("no chunk")?;
    assert!(fs::read(&raw_frame)?.len() > fs::read(&canonical_frame)?.len());

    // Replace the canonical (compressed) frame with the raw frame and patch the
    // manifest row so both integrity layers still match.
    let raw_bytes = fs::read(&raw_frame)?;
    tamper(&canonical_frame, |frame| *frame = raw_bytes.clone())?;
    let manifest = manifest_path(&store, &id);
    let frame_digest = digest(&[b"NQC-CENSUS-STORE-FRAME-V1", &[0], &raw_bytes]);
    tamper(&manifest, |bytes| {
        let len = bytes.len();
        if let Some(stored_len) = bytes.get_mut(len - 36..len - 32) {
            stored_len.copy_from_slice(&(raw_bytes.len() as u32).to_be_bytes());
        }
        if let Some(digest_field) = bytes.get_mut(len - 32..) {
            digest_field.copy_from_slice(&frame_digest);
        }
    })?;
    // Both integrity layers verify: get returns the authentic bytes...
    assert_eq!(store.get_artifact(&id)?, bytes);
    // ...but the stored form is not the unique canonical one.
    assert!(matches!(
        store.verify_artifact(&id),
        Err(StoreError::NonCanonical { .. })
    ));
    let failure = verify_store(dir.path(), &VerifyRequest::default())
        .err()
        .ok_or("non-canonical frame verified")?;
    assert!(matches!(failure.error, StoreError::NonCanonical { .. }));
    Ok(())
}

#[test]
fn encoding_is_deterministic_across_independent_stores() -> TestResult {
    let (a, b) = (TempDir::new("cas-det-a")?, TempDir::new("cas-det-b")?);
    let inputs = [abi_like(15_000, 14), noise(15_000, 15), b"tiny".to_vec()];
    for dir in [&a, &b] {
        let store = Store::create(dir.path(), small_config()?)?;
        for input in &inputs {
            put(&store, input)?;
        }
    }
    let (left, right) = (
        tree_listing(&a.join("objects"))?,
        tree_listing(&b.join("objects"))?,
    );
    assert!(!left.is_empty());
    assert_eq!(
        left, right,
        "object trees differ between independent stores"
    );
    assert_eq!(fs::read(a.join("STORE"))?, fs::read(b.join("STORE"))?);
    Ok(())
}

#[test]
fn content_defined_chunking_survives_insertions() -> TestResult {
    let dir = TempDir::new("cas-cdc")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let original = noise(64 * 1024, 16);
    let first = store.put_artifact(&original)?;
    let mut shifted = b"INSERTED-PREFIX".to_vec();
    shifted.extend_from_slice(&original);
    let second = store.put_artifact(&shifted)?;
    // Fixed-size chunking would share nothing after a 15-byte shift; CDC
    // re-synchronises and reuses almost every chunk.
    assert!(first.chunks_created > 20);
    assert!(
        second.chunks_reused * 10 >= first.chunks_created * 8,
        "reused {} of {}",
        second.chunks_reused,
        first.chunks_created
    );
    assert!(second.chunks_created <= 3);
    assert_eq!(store.get_artifact(&second.id)?, shifted);
    Ok(())
}

#[test]
fn persisted_policy_is_enforced_on_reopen() -> TestResult {
    let dir = TempDir::new("cas-config")?;
    let config = small_config()?;
    Store::create(dir.path(), config)?;
    let other = StoreConfig::new(256, 8, 4096, CompressionPolicy::NqcLzV1WhenSmaller, 1 << 20)?;
    assert_eq!(
        Store::create(dir.path(), other).err(),
        Some(StoreError::ConfigMismatch)
    );
    assert_eq!(
        Store::open(dir.path(), &other).err(),
        Some(StoreError::ConfigMismatch)
    );
    assert_eq!(Store::open(dir.path(), &config)?.config(), &config);
    assert_eq!(Store::open_existing(dir.path())?.config(), &config);
    Ok(())
}

#[test]
fn tampered_or_replaced_store_policy_fails_closed() -> TestResult {
    let dir = TempDir::new("cas-config-tamper")?;
    let store = Store::create(dir.path(), small_config()?)?;
    let id = put(&store, &abi_like(4000, 17))?;
    let store_file = dir.join("STORE");

    // Byte corruption of the seal: the store refuses to open.
    let original = fs::read(&store_file)?;
    flip_last_byte(&store_file)?;
    assert!(Store::open_existing(dir.path()).is_err());
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());
    // Corruption of a policy field that still yields a *valid* policy
    // (max_artifact_bytes 1 MiB -> 1 MiB + 1): the seal refuses it instead of
    // silently reinterpreting the store.
    tamper(&store_file, |bytes| *bytes = original.clone())?;
    tamper(&store_file, |bytes| {
        let at = bytes.len() - 38;
        if let Some(byte) = bytes.get_mut(at) {
            *byte ^= 0x01;
        }
    })?;
    assert!(matches!(
        Store::open_existing(dir.path()),
        Err(StoreError::DigestMismatch { .. })
    ));
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());

    // Wholesale replacement by another valid policy: every manifest is bound to
    // the original policy digest, so nothing can be reinterpreted.
    let other = StoreConfig::new(256, 8, 2048, CompressionPolicy::RawOnly, 1 << 20)?;
    tamper(&store_file, |bytes| {
        *bytes = other.sealed_bytes().unwrap_or_default();
    })?;
    let reopened = Store::open_existing(dir.path())?;
    assert_eq!(reopened.get_artifact(&id), Err(StoreError::ForeignConfig));
    assert!(verify_store(dir.path(), &VerifyRequest::default()).is_err());

    tamper(&store_file, |bytes| *bytes = original.clone())?;
    assert_eq!(
        Store::open_existing(dir.path())?.get_artifact(&id)?,
        abi_like(4000, 17)
    );
    Ok(())
}

#[test]
fn golden_policy_identity_is_byte_stable() -> TestResult {
    // Pinned so that any change to the canonical config encoding or its domain
    // separation is caught. CI recomputes it with an independent implementation.
    assert_eq!(
        hex(&StoreConfig::standard().canonical_bytes()?),
        GOLDEN_STANDARD_CONFIG_HEX
    );
    assert_eq!(
        StoreConfig::standard().id()?.to_hex(),
        GOLDEN_STANDARD_CONFIG_ID
    );
    Ok(())
}

const GOLDEN_STANDARD_CONFIG_HEX: &str = "4e51432d43454e5355532d53544f524500010101000000010102000000040000200003000000010e04000000040002000005000000010206000000080000000010000000";
const GOLDEN_STANDARD_CONFIG_ID: &str =
    "07b2c89806b3b8044aa2ba89f1c01844c2b1d6fe5136f1edcfb055c40aa5dfff";

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
