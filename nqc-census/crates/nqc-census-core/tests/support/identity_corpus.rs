//! Exhaustive market-identity corpus for RMC-001 Amendment 1.
//!
//! Every V2 pair, Aave pool and Aave reserve over a small address alphabet,
//! for every protocol family and two chain lineages. Each entry records
//! exactly what the constructors return: the canonical bytes and id, or the
//! refusal. Each admitted identity must also decode back to itself.
//!
//! This file uses only the public API that already existed at the original
//! RMC-001 authority (cea25577). CI compiles it against that commit to
//! reproduce `ORIGINAL_CORPUS_SHA256` independently.

use nqc_census_core::{
    Address, CanonicalMarketKey, ChainDomain, DeploymentKey, Hash32, IdentityError, ProtocolFamily,
};
use sha2::{Digest, Sha256};

pub const PROTOCOLS: [ProtocolFamily; 4] = [
    ProtocolFamily::AaveV2,
    ProtocolFamily::AaveV3,
    ProtocolFamily::AaveV4,
    ProtocolFamily::UniswapV2,
];
/// Address bytes of the alphabet: `[b; 20]` for each `b`.
pub const ALPHABET: std::ops::RangeInclusive<u8> = 1..=6;

pub struct Entry {
    pub key: String,
    /// `OK bytes=… id=…` or `REFUSED <reason>`.
    pub outcome: String,
    /// A V2 pair that Amendment 1 affects: a token is the factory, and every
    /// other clause of the rule holds.
    pub amended_class: bool,
}

fn address(byte: u8) -> Result<Address, IdentityError> {
    Address::new([byte; 20])
}

fn deployment(
    protocol: ProtocolFamily,
    factory: u8,
    lineage: u8,
) -> Result<DeploymentKey, IdentityError> {
    Ok(DeploymentKey::new(
        ChainDomain::new(1, Hash32::new([0x11; 32])?, Hash32::new([lineage; 32])?)?,
        protocol,
        address(factory)?,
        Hash32::new([0x44; 32])?,
    ))
}

fn outcome(market: Result<CanonicalMarketKey, IdentityError>) -> Result<String, IdentityError> {
    Ok(match market {
        Ok(market) => {
            let bytes = market.canonical_bytes()?;
            let decoded = CanonicalMarketKey::decode(&bytes)?;
            assert!(
                decoded == market && decoded.canonical_bytes()? == bytes,
                "an admitted identity does not decode back to itself"
            );
            format!("OK bytes={} id={}", hex(&bytes), market.id()?.to_hex())
        }
        Err(error) => format!("REFUSED {error}"),
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn entries() -> Result<Vec<Entry>, IdentityError> {
    let mut out = Vec::new();
    for lineage in [0x22_u8, 0x33] {
        for protocol in PROTOCOLS {
            for f in ALPHABET {
                let pool = CanonicalMarketKey::aave_pool(deployment(protocol, f, lineage)?);
                out.push(Entry {
                    key: format!("pool {lineage:02x} {:04x} f={f:02x}", protocol.tag()),
                    outcome: outcome(pool)?,
                    amended_class: false,
                });
                for asset in ALPHABET {
                    let reserve = CanonicalMarketKey::aave_reserve(
                        deployment(protocol, f, lineage)?,
                        address(asset)?,
                    );
                    out.push(Entry {
                        key: format!(
                            "reserve {lineage:02x} {:04x} f={f:02x} a={asset:02x}",
                            protocol.tag()
                        ),
                        outcome: outcome(reserve)?,
                        amended_class: false,
                    });
                }
                for p in ALPHABET {
                    for t0 in ALPHABET {
                        for t1 in ALPHABET {
                            let pair = CanonicalMarketKey::v2_pair(
                                deployment(protocol, f, lineage)?,
                                address(p)?,
                                address(t0)?,
                                address(t1)?,
                            );
                            let amended_class = protocol == ProtocolFamily::UniswapV2
                                && (t0 == f || t1 == f)
                                && t0 < t1
                                && p != t0
                                && p != t1
                                && p != f;
                            out.push(Entry {
                                key: format!(
                                    "v2 {lineage:02x} {:04x} f={f:02x} p={p:02x} t0={t0:02x} t1={t1:02x}",
                                    protocol.tag()
                                ),
                                outcome: outcome(pair)?,
                                amended_class,
                            });
                        }
                    }
                }
            }
        }
    }
    Ok(out)
}

/// What the original rule answered for every amended-class entry.
pub const ORIGINAL_REFUSAL: &str = "REFUSED contradictory V2 pair identity";

/// SHA-256 of the corpus, one `key outcome` line per entry. With
/// `mask_amended`, each amended-class entry is written as the original rule
/// answered it, so the amended code can be compared with the original byte
/// for byte. On the original code masking changes nothing.
pub fn digest(entries: &[Entry], mask_amended: bool) -> String {
    let mut hasher = Sha256::new();
    for entry in entries {
        let outcome = if mask_amended && entry.amended_class {
            ORIGINAL_REFUSAL
        } else {
            entry.outcome.as_str()
        };
        hasher.update(format!("{} {outcome}\n", entry.key));
    }
    hex(&hasher.finalize())
}
