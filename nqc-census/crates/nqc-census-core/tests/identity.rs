use nqc_census_core::{
    count_identities, reconcile_aliases, ActionSurfaceKey, Address, AliasEvidence,
    CanonicalMarketKey, ChainDomain, DeploymentKey, DeploymentSemanticsVersion, Hash32,
    IdentityError, MarketStateId, MigrationEvidence, ObservationAnchor, ProtocolFamily,
    SourceLocator, StrategySemanticsKey,
};

fn address(byte: u8) -> Result<Address, IdentityError> {
    Address::new([byte; 20])
}

fn hash(byte: u8) -> Result<Hash32, IdentityError> {
    Hash32::new([byte; 32])
}

fn chain(lineage: u8) -> Result<ChainDomain, IdentityError> {
    ChainDomain::new(1, hash(0x11)?, hash(lineage)?)
}

fn deployment(
    protocol: ProtocolFamily,
    address_byte: u8,
    instance_byte: u8,
    lineage: u8,
) -> Result<DeploymentKey, IdentityError> {
    Ok(DeploymentKey::new(
        chain(lineage)?,
        protocol,
        address(address_byte)?,
        hash(instance_byte)?,
    ))
}

fn aave_reserve() -> Result<CanonicalMarketKey, IdentityError> {
    CanonicalMarketKey::aave_reserve(
        deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x22)?,
        address(0x55)?,
    )
}

fn v2_pair() -> Result<CanonicalMarketKey, IdentityError> {
    CanonicalMarketKey::v2_pair(
        deployment(ProtocolFamily::UniswapV2, 0x66, 0x77, 0x22)?,
        address(0x88)?,
        address(0x09)?,
        address(0x0a)?,
    )
}

fn strategy(byte: u8) -> Result<StrategySemanticsKey, IdentityError> {
    StrategySemanticsKey::new(1, 1, hash(byte)?)
}

fn anchor(block: u64, block_hash: u8, parent_hash: u8) -> Result<ObservationAnchor, IdentityError> {
    ObservationAnchor::new(block, hash(block_hash)?, hash(parent_hash)?)
}

fn semantics(
    version: u32,
    implementation: u8,
    configuration: u8,
    oracle: u8,
) -> Result<DeploymentSemanticsVersion, IdentityError> {
    DeploymentSemanticsVersion::new(
        version,
        hash(implementation)?,
        hash(configuration)?,
        hash(oracle)?,
    )
}

#[test]
fn golden_aave_reserve_bytes_and_id() -> Result<(), IdentityError> {
    let market = aave_reserve()?;
    assert_eq!(
        hex(&market.canonical_bytes()?),
        "4e51432d43454e5355532d494400011001000000010202000000c14e51432d43454e5355532d494400010201000000674e51432d43454e5355532d494400010101000000080000000000000001020000002011111111111111111111111111111111111111111111111111111111111111110300000020222222222222222222222222222222222222222222222222222222222222222202000000020103030000001433333333333333333333333333333333333333330400000020444444444444444444444444444444444444444444444444444444444444444403000000145555555555555555555555555555555555555555"
    );
    assert_eq!(
        market.id()?.to_hex(),
        "e7f0767da93d0383cd38c740c1770f2a476ffa5e83544e8acbc3aad84531cfc1"
    );
    Ok(())
}

#[test]
fn golden_v2_pair_bytes_and_id() -> Result<(), IdentityError> {
    let market = v2_pair()?;
    assert_eq!(
        hex(&market.canonical_bytes()?),
        "4e51432d43454e5355532d494400011001000000010302000000c14e51432d43454e5355532d494400010201000000674e51432d43454e5355532d4944000101010000000800000000000000010200000020111111111111111111111111111111111111111111111111111111111111111103000000202222222222222222222222222222222222222222222222222222222222222222020000000202020300000014666666666666666666666666666666666666666604000000207777777777777777777777777777777777777777777777777777777777777777030000001488888888888888888888888888888888888888880400000014090909090909090909090909090909090909090905000000140a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a"
    );
    assert_eq!(
        market.id()?.to_hex(),
        "29e445762ef80465d6308f00402d81409b94e650017e7d7a622ef748f47be783"
    );
    Ok(())
}

#[test]
fn golden_state_and_action_ids() -> Result<(), IdentityError> {
    let market_id = aave_reserve()?.id()?;
    let state = MarketStateId::derive(
        market_id,
        &anchor(25_939_131, 0xdd, 0xee)?,
        &semantics(7, 0xff, 0x01, 0x02)?,
    )?;
    assert_eq!(
        state.to_hex(),
        "4ec4e78450f2937538f90078b765fd492a7fa87f0bff8a049ab7b36cd9447eb4"
    );

    let action = ActionSurfaceKey::new(market_id, address(0xaa)?, address(0xbb)?, strategy(0xcc)?)?;
    assert_eq!(
        action.id()?.to_hex(),
        "5939d808b0a1c4545ae0f69264b25c2d98794a8ddbc59e76343c358021074489"
    );
    Ok(())
}

#[test]
fn hexadecimal_case_is_representation_only() -> Result<(), IdentityError> {
    let lower = Address::parse_hex("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")?;
    let upper = Address::parse_hex("0XABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")?;
    assert_eq!(lower, upper);

    let lower_hash =
        Hash32::parse_hex("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")?;
    let upper_hash =
        Hash32::parse_hex("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")?;
    assert_eq!(lower_hash, upper_hash);
    Ok(())
}

#[test]
fn chain_deployment_and_protocol_domains_prevent_false_aliases() -> Result<(), IdentityError> {
    let base =
        CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x22)?)?;
    let forked =
        CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x23)?)?;
    let redeployed =
        CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::AaveV3, 0x33, 0x45, 0x22)?)?;
    let v4 = CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::AaveV4, 0x33, 0x44, 0x22)?)?;

    let mut ids = std::collections::BTreeSet::new();
    for market in [base, forked, redeployed, v4] {
        ids.insert(market.id()?);
    }
    assert_eq!(ids.len(), 4);
    Ok(())
}

#[test]
fn reorg_keeps_market_id_but_changes_state_id() -> Result<(), IdentityError> {
    let market_id = aave_reserve()?.id()?;
    let version = semantics(7, 0xff, 0x01, 0x02)?;
    let before = MarketStateId::derive(market_id, &anchor(100, 0x31, 0x30)?, &version)?;
    let after = MarketStateId::derive(market_id, &anchor(100, 0x41, 0x40)?, &version)?;

    assert_ne!(before, after);
    assert_eq!(market_id, aave_reserve()?.id()?);
    Ok(())
}

#[test]
fn implementation_config_and_oracle_changes_are_state_not_market() -> Result<(), IdentityError> {
    let market = aave_reserve()?;
    let market_id = market.id()?;
    let observation = anchor(200, 0x51, 0x50)?;
    let versions = [
        semantics(7, 0x61, 0x71, 0x81)?,
        semantics(8, 0x62, 0x71, 0x81)?,
        semantics(8, 0x62, 0x72, 0x81)?,
        semantics(8, 0x62, 0x72, 0x82)?,
    ];

    let mut states = std::collections::BTreeSet::new();
    for version in versions {
        states.insert(MarketStateId::derive(market_id, &observation, &version)?);
    }
    assert_eq!(states.len(), 4);
    assert_eq!(market_id, market.id()?);
    Ok(())
}

#[test]
fn migration_links_distinct_ids_without_collapsing_them() -> Result<(), IdentityError> {
    let old_market = aave_reserve()?.id()?;
    let new_market = CanonicalMarketKey::aave_reserve(
        deployment(ProtocolFamily::AaveV3, 0x34, 0x45, 0x22)?,
        address(0x55)?,
    )?
    .id()?;

    assert_ne!(old_market, new_market);
    let migration = MigrationEvidence::new(old_market, new_market, hash(0x91)?)?;
    assert_eq!(migration.from(), old_market);
    assert_eq!(migration.to(), new_market);
    assert_eq!(
        MigrationEvidence::new(old_market, old_market, hash(0x92)?),
        Err(IdentityError::MigrationSelfReference)
    );
    Ok(())
}

#[test]
fn wrappers_and_underlyings_remain_distinct_contract_identities() -> Result<(), IdentityError> {
    let wrapped = CanonicalMarketKey::aave_reserve(
        deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x22)?,
        address(0xa1)?,
    )?;
    let underlying = CanonicalMarketKey::aave_reserve(
        deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x22)?,
        address(0xa2)?,
    )?;
    assert_ne!(wrapped.id()?, underlying.id()?);
    Ok(())
}

#[test]
fn action_orientation_is_semantic() -> Result<(), IdentityError> {
    let market = aave_reserve()?.id()?;
    let forward = ActionSurfaceKey::new(market, address(0xaa)?, address(0xbb)?, strategy(0xcc)?)?;
    let reverse = ActionSurfaceKey::new(market, address(0xbb)?, address(0xaa)?, strategy(0xcc)?)?;
    assert_ne!(forward.id()?, reverse.id()?);
    Ok(())
}

#[test]
fn alias_reconciliation_is_idempotent_and_conflicts_fail_closed() -> Result<(), IdentityError> {
    let target = aave_reserve()?.id()?;
    let other = v2_pair()?.id()?;
    let locator = SourceLocator::new(1, hash(0xa1)?)?;

    let same = [
        AliasEvidence::new(locator, target, hash(0xb1)?),
        AliasEvidence::new(locator, target, hash(0xb2)?),
    ];
    let reconciled = reconcile_aliases(&same)?;
    assert_eq!(reconciled.len(), 1);
    assert_eq!(reconciled.get(&locator), Some(&target));

    let conflict = [
        AliasEvidence::new(locator, target, hash(0xb1)?),
        AliasEvidence::new(locator, other, hash(0xb2)?),
    ];
    assert_eq!(
        reconcile_aliases(&conflict),
        Err(IdentityError::AliasConflict)
    );
    Ok(())
}

#[test]
fn counting_separates_units_actions_dedup_and_input_order() -> Result<(), IdentityError> {
    let pool =
        CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::AaveV3, 0x33, 0x44, 0x22)?)?;
    let reserve = aave_reserve()?;
    let pair = v2_pair()?;
    let reserve_id = reserve.id()?;
    let action_a =
        ActionSurfaceKey::new(reserve_id, address(0xaa)?, address(0xbb)?, strategy(0xcc)?)?;
    let action_b =
        ActionSurfaceKey::new(reserve_id, address(0xbb)?, address(0xaa)?, strategy(0xcc)?)?;

    let first = count_identities(
        &[pool.clone(), reserve.clone(), pair.clone(), reserve.clone()],
        &[action_a.clone(), action_b.clone(), action_a.clone()],
    )?;
    let second = count_identities(&[pair, reserve, pool], &[action_b, action_a])?;

    assert_eq!(first, second);
    assert_eq!(first.markets, 3);
    assert_eq!(first.aave_pools, 1);
    assert_eq!(first.aave_reserves, 1);
    assert_eq!(first.v2_pairs, 1);
    assert_eq!(first.action_surfaces, 2);
    Ok(())
}

#[test]
fn action_for_absent_market_is_rejected() -> Result<(), IdentityError> {
    let action = ActionSurfaceKey::new(
        aave_reserve()?.id()?,
        address(0xaa)?,
        address(0xbb)?,
        strategy(0xcc)?,
    )?;
    assert_eq!(
        count_identities(&[v2_pair()?], &[action]),
        Err(IdentityError::UnknownMarketReference)
    );
    Ok(())
}

#[test]
fn invalid_zero_overflow_protocol_and_v2_inputs_fail_closed() -> Result<(), IdentityError> {
    assert_eq!(
        Address::new([0; 20]),
        Err(IdentityError::ZeroValue("address"))
    );
    assert_eq!(
        Hash32::new([0; 32]),
        Err(IdentityError::ZeroValue("hash32"))
    );
    assert_eq!(
        ChainDomain::parse(
            "18446744073709551616",
            &format!("0x{}", "11".repeat(32)),
            &format!("0x{}", "22".repeat(32))
        ),
        Err(IdentityError::InvalidInteger)
    );

    assert_eq!(
        CanonicalMarketKey::aave_pool(deployment(ProtocolFamily::UniswapV2, 0x33, 0x44, 0x22)?),
        Err(IdentityError::ProtocolMarketMismatch)
    );

    assert_eq!(
        CanonicalMarketKey::v2_pair(
            deployment(ProtocolFamily::UniswapV2, 0x66, 0x77, 0x22)?,
            address(0x88)?,
            address(0x0a)?,
            address(0x09)?
        ),
        Err(IdentityError::ContradictoryV2Pair)
    );
    Ok(())
}

#[test]
fn decoder_rejects_version_duplicate_and_unknown_fields() -> Result<(), IdentityError> {
    let bytes = aave_reserve()?.canonical_bytes()?;
    let version_offset = b"NQC-CENSUS-ID".len();

    let mut unknown_version = bytes.clone();
    unknown_version[version_offset] = 0;
    unknown_version[version_offset + 1] = 2;
    assert_eq!(
        CanonicalMarketKey::decode(&unknown_version),
        Err(IdentityError::UnknownSchemaVersion(2))
    );

    let mut duplicate = bytes.clone();
    let first_field = b"NQC-CENSUS-ID".len() + 3;
    let second_field = first_field + 1 + 4 + 1;
    duplicate[second_field] = 1;
    assert_eq!(
        CanonicalMarketKey::decode(&duplicate),
        Err(IdentityError::MalformedEncoding(
            "field tags must be strictly increasing"
        ))
    );

    let mut unknown = bytes;
    unknown.extend_from_slice(&[0x7f, 0, 0, 0, 1, 1]);
    assert_eq!(
        CanonicalMarketKey::decode(&unknown),
        Err(IdentityError::MalformedEncoding(
            "unexpected canonical field set"
        ))
    );
    Ok(())
}

#[test]
fn decoder_roundtrip_preserves_identity() -> Result<(), IdentityError> {
    for market in [aave_reserve()?, v2_pair()?] {
        let bytes = market.canonical_bytes()?;
        let decoded = CanonicalMarketKey::decode(&bytes)?;
        assert_eq!(decoded, market);
        assert_eq!(decoded.canonical_bytes()?, bytes);
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(HEX[usize::from(byte >> 4)]));
        out.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    out
}
