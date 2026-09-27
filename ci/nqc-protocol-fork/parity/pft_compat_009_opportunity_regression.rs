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

fn config(decimals: u8, bonus_bps: u32, flash: bool) -> ReserveConfigurationBits {
    let mut raw = U256::from(bonus_bps) << 32;
    raw |= U256::from(decimals) << 48;
    raw |= U256::from(1u8) << 56;
    if flash {
        raw |= U256::from(1u8) << 63;
    }
    ReserveConfigurationBits(raw)
}

fn reserve(
    asset: Address,
    reserve_id: u16,
    decimals: u8,
    price_usd_wad: U256,
    flash: bool,
) -> MarketReserve {
    MarketReserve {
        asset,
        reserve_id,
        configuration: config(decimals, 10_500, flash),
        a_token: Address::repeat_byte((reserve_id as u8).saturating_add(10)),
        variable_debt_token: Address::repeat_byte((reserve_id as u8).saturating_add(20)),
        price_oracle_units: price_usd_wad,
        price_usd_wad,
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

fn measured_premium(principal_usdc_units: u64) -> U256 {
    let weth = Address::repeat_byte(1);
    let usdc = Address::repeat_byte(2);
    let anchor = CanonicalBlock {
        number: 25_252_136,
        hash: B256::repeat_byte(0x39),
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
            reserve(weth, 0, 18, U256::from(2_000u64) * wad(), false),
            reserve(usdc, 1, 6, wad(), true),
        ],
        emode_categories: Vec::new(),
    };

    let principal = U256::from(principal_usdc_units);
    let debt_value_usd_wad =
        principal * U256::from(1_000_000_000_000u64);
    let collateral_balance = U256::from(100u64) * wad();

    let account = AccountSnapshot {
        user: Address::repeat_byte(9),
        valuation_timestamp: anchor.timestamp,
        e_mode_category: 0,
        risk: AccountRisk {
            collateral_usd_wad: U256::from(200_000u64) * wad(),
            weighted_collateral_usd_wad: U256::from(160_000u64) * wad(),
            debt_usd_wad: debt_value_usd_wad,
            health_factor_wad: Some(U256::from(800_000_000_000_000_000u64)),
        },
        reserves: vec![
            AccountReserveExposure {
                asset: weth,
                reserve_id: 0,
                token_unit: wad(),
                price_usd_wad: U256::from(2_000u64) * wad(),
                atoken_balance: collateral_balance,
                variable_debt: U256::ZERO,
                collateral_enabled: true,
            },
            AccountReserveExposure {
                asset: usdc,
                reserve_id: 1,
                token_unit: U256::from(1_000_000u64),
                price_usd_wad: wad(),
                atoken_balance: U256::ZERO,
                variable_debt: principal,
                collateral_enabled: false,
            },
        ],
    };

    let opportunities = generate_liquidation_opportunities(
        &market,
        &account,
        LiquidationOpportunityPolicy::aave_v3(U256::ZERO),
    )
    .expect("patched opportunity generation must succeed");

    assert_eq!(opportunities.len(), 1);
    assert_eq!(opportunities[0].debt_to_liquidate, principal);
    opportunities[0].flash_loan_premium
}

#[test]
fn pft_compat_009_uses_deployed_ceiling_semantics_in_real_opportunity_path() {
    assert_eq!(
        measured_premium(83_727_306_811),
        U256::from(41_863_654u64)
    );
    assert_eq!(
        measured_premium(186_298_226),
        U256::from(93_150u64)
    );

    // Both witnesses distinguish deployed ceil semantics from the old half-up model.
    assert_eq!((83_727_306_811u128 * 5 + 5_000) / 10_000, 41_863_653);
    assert_eq!((186_298_226u128 * 5 + 5_000) / 10_000, 93_149);
}
