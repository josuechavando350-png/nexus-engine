use alloy::primitives::{Address, B256, U256};
use nqc_aave_market::{AaveMarketSnapshot, MarketReserve};
use nqc_aave_math::AccountRisk;
use nqc_aave_opportunity::{
    generate_liquidation_opportunities, LiquidationOpportunityPolicy,
};
use nqc_aave_sync::ReserveConfigurationBits;
use nqc_core::wad;
use nqc_hot_state::{AccountReserveExposure, AccountSnapshot};
use nqc_state::CanonicalBlock;

fn config(flash: bool) -> ReserveConfigurationBits {
    let mut raw = U256::from(10_500u32) << 32;
    raw |= U256::from(18u8) << 48;
    raw |= U256::from(1u8) << 56;
    if flash {
        raw |= U256::from(1u8) << 63;
    }
    ReserveConfigurationBits(raw)
}

fn reserve(asset: Address, reserve_id: u16, flash: bool) -> MarketReserve {
    MarketReserve {
        asset,
        reserve_id,
        configuration: config(flash),
        a_token: Address::repeat_byte((reserve_id as u8).saturating_add(10)),
        variable_debt_token: Address::repeat_byte((reserve_id as u8).saturating_add(20)),
        price_oracle_units: wad(),
        price_usd_wad: wad(),
        liquidity_index_ray: U256::ZERO,
        variable_borrow_index_ray: U256::ZERO,
        liquidity_rate_ray: U256::ZERO,
        variable_borrow_rate_ray: U256::ZERO,
        last_update_timestamp: 0,
        liquidation_bonus_bps: 10_500,
        liquidation_protocol_fee_bps: 0,
        flash_loan_enabled: flash,
        liquidation_grace_period_until: 0,
    }
}

#[test]
fn pft_aave_dust_boundary_rejects_sub_1000_leftover() {
    let collateral = Address::repeat_byte(1);
    let debt = Address::repeat_byte(2);
    let anchor = CanonicalBlock {
        number: 25_252_136,
        hash: B256::repeat_byte(0x55),
        timestamp: 1_700_000_000,
        base_fee_per_gas: Some(20_000_000_000),
    };
    let market = AaveMarketSnapshot {
        chain_id: 1,
        pool: Address::repeat_byte(3),
        addresses_provider: Address::repeat_byte(4),
        price_oracle: Address::repeat_byte(5),
        anchor,
        oracle_base_currency: Address::ZERO,
        oracle_base_unit: wad(),
        flash_loan_premium_bps: 5,
        reserves: vec![
            reserve(collateral, 0, false),
            reserve(debt, 1, true),
        ],
        emode_categories: Vec::new(),
    };
    let account = AccountSnapshot {
        user: Address::repeat_byte(9),
        valuation_timestamp: anchor.timestamp,
        e_mode_category: 0,
        risk: AccountRisk {
            collateral_usd_wad: U256::from(2_000u64) * wad(),
            weighted_collateral_usd_wad: U256::from(1_455u64) * wad(),
            debt_usd_wad: U256::from(1_500u64) * wad(),
            health_factor_wad: Some(U256::from(970_000_000_000_000_000u64)),
        },
        reserves: vec![
            AccountReserveExposure {
                asset: collateral,
                reserve_id: 0,
                token_unit: wad(),
                price_usd_wad: wad(),
                atoken_balance: U256::from(2_000u64) * wad(),
                variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
            AccountReserveExposure {
                asset: debt,
                reserve_id: 1,
                token_unit: wad(),
                price_usd_wad: wad(),
                atoken_balance: U256::ZERO,
                variable_debt: U256::from(1_500u64) * wad(),
                collateral_enabled: false,
            },
        ],
    };

    let strict = generate_liquidation_opportunities(
        &market,
        &account,
        LiquidationOpportunityPolicy::aave_v3(U256::ZERO),
    )
    .expect("strict Aave policy must evaluate");
    assert!(
        strict.is_empty(),
        "remaining $750 debt must be rejected by the $1,000 dust boundary"
    );

    let relaxed = LiquidationOpportunityPolicy {
        min_oracle_edge_usd_wad: U256::ZERO,
        min_base_max_close_factor_threshold_usd_wad: U256::from(2_000u64) * wad(),
        min_leftover_base_usd_wad: wad(),
    };
    let control = generate_liquidation_opportunities(&market, &account, relaxed)
        .expect("$1 control policy must evaluate");
    assert_eq!(control.len(), 1);
    assert_eq!(control[0].debt_to_liquidate, U256::from(750u64) * wad());
}
