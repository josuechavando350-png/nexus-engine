//! RMC-001 Amendment 1: a Uniswap V2 pair may name its own factory as token0
//! or token1. `IDENTITY_CONTRACT.md` records the evidence.

#[path = "support/identity_corpus.rs"]
mod corpus;

use nqc_census_core::{
    Address, CanonicalMarketKey, ChainDomain, DeploymentKey, Hash32, IdentityError, ProtocolFamily,
};

/// Corpus digest from the original RMC-001 code (cea25577). CI reproduces it
/// by compiling `support/identity_corpus.rs` against that commit.
const ORIGINAL_CORPUS_SHA256: &str =
    "79be63c8d9f0d0036abbd53743b26e3e0cbb7593a52a14b89caff1cc80c8feed";

fn address(byte: u8) -> Result<Address, IdentityError> {
    Address::new([byte; 20])
}

fn factory(byte: u8) -> Result<DeploymentKey, IdentityError> {
    Ok(DeploymentKey::new(
        ChainDomain::new(1, Hash32::new([0x11; 32])?, Hash32::new([0x22; 32])?)?,
        ProtocolFamily::UniswapV2,
        address(byte)?,
        Hash32::new([0x44; 32])?,
    ))
}

#[test]
fn every_identity_admitted_before_keeps_its_exact_bytes_and_id() -> Result<(), IdentityError> {
    let entries = corpus::entries()?;
    println!(
        "RMC001_CORPUS_SHA256 entries={} amended_masked={} amended={}",
        entries.len(),
        corpus::digest(&entries, true),
        corpus::digest(&entries, false)
    );
    // With the amended class written as the original rule answered it, the
    // corpus is byte-identical to the original: every other admission,
    // every canonical byte, every id and every refusal reason is unchanged.
    assert_eq!(corpus::digest(&entries, true), ORIGINAL_CORPUS_SHA256);
    Ok(())
}

#[test]
fn the_amendment_admits_exactly_the_factory_as_token_class() -> Result<(), IdentityError> {
    let entries = corpus::entries()?;
    let amended: Vec<&corpus::Entry> = entries.iter().filter(|e| e.amended_class).collect();
    assert!(!amended.is_empty());
    for entry in &amended {
        assert!(
            entry.outcome.starts_with("OK "),
            "{} {}",
            entry.key,
            entry.outcome
        );
    }
    // Both positions occur in the class.
    assert!(amended.iter().any(|e| {
        let f = &e.key[e.key.find("f=").unwrap_or(0) + 2..][..2];
        e.key.contains(&format!("t0={f}"))
    }));
    assert!(amended.iter().any(|e| {
        let f = &e.key[e.key.find("f=").unwrap_or(0) + 2..][..2];
        e.key.contains(&format!("t1={f}"))
    }));
    Ok(())
}

#[test]
fn token0_equal_to_the_factory_is_one_valid_identity() -> Result<(), IdentityError> {
    let market = CanonicalMarketKey::v2_pair(
        factory(0x10)?,
        address(0x80)?,
        address(0x10)?,
        address(0x20)?,
    )?;
    let decoded = CanonicalMarketKey::decode(&market.canonical_bytes()?)?;
    assert_eq!(decoded, market);
    assert_eq!(decoded.id()?, market.id()?);
    Ok(())
}

#[test]
fn token1_equal_to_the_factory_is_one_valid_identity() -> Result<(), IdentityError> {
    let market = CanonicalMarketKey::v2_pair(
        factory(0x30)?,
        address(0x80)?,
        address(0x10)?,
        address(0x30)?,
    )?;
    let decoded = CanonicalMarketKey::decode(&market.canonical_bytes()?)?;
    assert_eq!(decoded, market);
    let other_side = CanonicalMarketKey::v2_pair(
        factory(0x10)?,
        address(0x80)?,
        address(0x10)?,
        address(0x30)?,
    )?;
    assert_ne!(market.id()?, other_side.id()?);
    Ok(())
}

#[test]
fn every_invariant_the_evidence_did_not_falsify_still_refuses() -> Result<(), IdentityError> {
    let refused = |deployment: DeploymentKey, p: u8, t0: u8, t1: u8| -> Result<(), IdentityError> {
        assert_eq!(
            CanonicalMarketKey::v2_pair(deployment, address(p)?, address(t0)?, address(t1)?),
            Err(IdentityError::ContradictoryV2Pair),
            "pair={p:02x} token0={t0:02x} token1={t1:02x}"
        );
        Ok(())
    };
    // pair != factory, even when a token is also the factory.
    refused(factory(0x10)?, 0x10, 0x09, 0x0a)?;
    refused(factory(0x10)?, 0x10, 0x10, 0x20)?;
    // pair != token0, pair != token1.
    refused(factory(0x66)?, 0x09, 0x09, 0x0a)?;
    refused(factory(0x66)?, 0x0a, 0x09, 0x0a)?;
    // token0 != token1, including both equal to the factory.
    refused(factory(0x66)?, 0x80, 0x09, 0x09)?;
    refused(factory(0x10)?, 0x80, 0x10, 0x10)?;
    // token0 < token1, including a factory token in the wrong order.
    refused(factory(0x66)?, 0x80, 0x0a, 0x09)?;
    refused(factory(0x10)?, 0x80, 0x20, 0x10)?;
    // A V2 pair still needs a Uniswap V2 deployment.
    let aave = DeploymentKey::new(
        ChainDomain::new(1, Hash32::new([0x11; 32])?, Hash32::new([0x22; 32])?)?,
        ProtocolFamily::AaveV3,
        address(0x10)?,
        Hash32::new([0x44; 32])?,
    );
    assert_eq!(
        CanonicalMarketKey::v2_pair(aave, address(0x80)?, address(0x10)?, address(0x20)?),
        Err(IdentityError::ProtocolMarketMismatch)
    );
    Ok(())
}

#[test]
fn the_two_mainnet_pairs_that_falsified_the_rule_are_valid_identities() -> Result<(), IdentityError>
{
    // Proven at block 25437474 (0x0712ee92…) by every declared provider:
    // pair.factory() == factory, getPair in both orders == pair,
    // allPairs(index) == pair, CREATE2 == pair (IDENTITY_CONTRACT.md A1).
    let uniswap_v2 = DeploymentKey::new(
        ChainDomain::new(1, Hash32::new([0x11; 32])?, Hash32::new([0x22; 32])?)?,
        ProtocolFamily::UniswapV2,
        Address::parse_hex("0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f")?,
        Hash32::new([0x44; 32])?,
    );
    for (pair, token0, token1) in [
        (
            "0x14c336ebeb7a78668b5cd8b592d1124456c853ce",
            "0x5a1912749d2b7c3cdb832b81601c8c3f437a0de8",
            "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
        ),
        (
            "0x3b66602f04c64a3201eec700a47be72ee86b8446",
            "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
            "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        ),
    ] {
        let market = CanonicalMarketKey::v2_pair(
            uniswap_v2.clone(),
            Address::parse_hex(pair)?,
            Address::parse_hex(token0)?,
            Address::parse_hex(token1)?,
        )?;
        assert_eq!(
            CanonicalMarketKey::decode(&market.canonical_bytes()?)?,
            market
        );
    }
    Ok(())
}
